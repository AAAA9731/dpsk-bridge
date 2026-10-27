import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { runSdk, queueInput, eventsPage } from '../lib/live.mjs';
import { apply } from '../lib/host-plugin.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Timed out waiting for fake SDK'); await delay(10); }
}
class FakeChild extends EventEmitter {
  constructor() {
    super(); this.stdout = new PassThrough();
    this.stdin = new Writable({ write: (chunk, encoding, done) => {
      const message = JSON.parse(chunk.toString().trim());
      queueMicrotask(() => this.receive(message)); done();
    } });
  }
  send(message) { this.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); }
  receive(message) {
    if (message.method === 'initialize') this.send({ id: message.id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime' } } });
    else if (message.method === 'session/prompt') {
      this.sessionId = message.params.sessionId;
      this.send({ method: 'session.event', params: { sessionId: this.sessionId, event: { type: 'turn/start', data: { turn: 1 } } } });
      this.send({ id: message.id, result: { messageId: randomUUID() } });
    } else if (message.method === 'session/wait') this.waiting = message.id;
    else if (message.method === 'shutdown') this.send({ id: message.id, result: {} });
    else throw new Error(`Unexpected fake SDK method ${message.method}`);
  }
  finish() {
    assert.ok(this.waiting);
    this.send({ method: 'session.event', params: { sessionId: this.sessionId, event: { type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'RESULT: OK\nFinished.' }] } } } } });
    this.send({ method: 'session.event', params: { sessionId: this.sessionId, event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } } });
    this.send({ id: this.waiting, result: {} });
  }
}
function fixture(t, emit = () => {}, signal = null) {
  const root = fs.mkdtempSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'live-fixture-'));
  const home = path.join(root, 'home'), id = randomUUID(), dir = path.join(home, 'jobs', id), host = path.join(dir, 'host');
  for (const part of ['requests', 'responses', 'cancelled', 'receipts']) fs.mkdirSync(path.join(host, part), { recursive: true });
  fs.mkdirSync(path.join(dir, 'inbox'));
  const job = { id, cwd: root, sdkSessionId: 'root-session', provider: 'fake', model: 'fake', hostDirectory: host,
    processState: 'running', reportFile: path.join(dir, 'report.txt') };
  const history = [], save = () => { history.push(structuredClone(job)); fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job)); };
  save(); const child = new FakeChild(), controller = new AbortController();
  const task = runSdk(child, { job, dir, prompt: 'test only', save, emit, signal: signal || controller.signal }); task.catch(() => {});
  t.after(async () => {
    controller.abort(new Error('Test cleanup')); await task.catch(() => {});
    child.stdin.destroy(); child.stdout.destroy(); fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, home, dir, host, job, history, child, task };
}
function mailbox(f, part, requestId) { return path.join(f.host, part, `${requestId}.json`); }
function publish(f, requestId) {
  fs.writeFileSync(mailbox(f, 'requests', requestId), JSON.stringify({ requestId, method: 'user-question/ask',
    params: { requestId, sessionId: 'child-session', questions: [{ id: 'q', question: 'Continue?' }] } }));
}
function cancel(f, requestId) { fs.writeFileSync(mailbox(f, 'cancelled', requestId), JSON.stringify({ requestId, sessionId: 'child-session' })); }
function events(f) {
  const file = path.join(f.dir, 'events.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}

test('a cancelled marker consumed before delayed request cleanup cannot resurrect pending state', async t => {
  const f = fixture(t), requestId = randomUUID(), requestsDir = path.join(f.host, 'requests');
  const original = fs.readdirSync; let injected = false;
  t.mock.method(fs, 'readdirSync', function(directory, ...args) {
    const snapshot = original.call(this, directory, ...args);
    if (!injected && directory === requestsDir) {
      injected = true;
      // The plugin published and cancelled after this request inventory was
      // taken; its request cleanup is paused until the supervisor next polls.
      publish(f, requestId); cancel(f, requestId);
    }
    return snapshot;
  });
  await until(() => events(f).some(event => event.event === 'request_cancelled'));
  // Simulate a stale directory entry surviving the marker's consumption.
  publish(f, requestId);
  await delay(250);
  assert.deepEqual(f.job.pendingRequests, []);
  assert.deepEqual(fs.readdirSync(path.join(f.host, 'requests')), []);
  assert.equal(events(f).filter(event => event.event === 'request' && event.requestId === requestId).length, 0);
  await until(() => f.child.waiting); f.child.finish(); await f.task;
  assert.deepEqual(f.job.pendingRequests, []);
});

test('cancellation during response publication rejects the input and removes the orphan response', async t => {
  let f, inputId;
  f = fixture(t, event => {
    if (event.event === 'request') inputId = queueInput(f.job, 'answer', { requestId: event.requestId,
      answer: { answers: [{ id: 'q', selected: [], custom: 'Continue' }] } }, f.home).inputId;
  });
  const requestId = randomUUID(), responseFile = mailbox(f, 'responses', requestId);
  publish(f, requestId);
  const original = fs.renameSync; let injected = false;
  t.mock.method(fs, 'renameSync', function(source, destination) {
    if (!injected && destination === responseFile) {
      injected = true; cancel(f, requestId);
      fs.unlinkSync(mailbox(f, 'requests', requestId));
      // The plugin has finished cancellation cleanup before this response
      // rename; it will never return to consume a subsequently written file.
    }
    return original.call(this, source, destination);
  });
  await until(() => events(f).some(event => event.event === 'input_rejected' && event.inputId === inputId));
  assert.equal(injected, true); assert.equal(fs.existsSync(responseFile), false);
  assert.deepEqual(f.job.pendingRequests, []);
  assert.equal(events(f).some(event => event.event === 'input_delivered' && event.inputId === inputId), false);
  await until(() => f.child.waiting); f.child.finish(); await f.task;
  assert.equal(fs.existsSync(responseFile), false); assert.deepEqual(f.job.pendingRequests, []);
});

test('file replies are forwarded first and reported delivered only after the real plugin consumption receipt', async t => {
  let f, inputId;
  f = fixture(t, event => {
    if (event.event === 'request') inputId = queueInput(f.job, 'answer', { requestId: event.requestId,
      answer: { answers: [{ id: 'q', selected: [], custom: 'Continue' }] } }, f.home).inputId;
  });
  const listeners = new Map(), disposers = [];
  apply({ effect: execute => { const dispose = execute(); disposers.push(dispose); return dispose; },
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); } }, { directory: f.host });
  t.after(async () => { for (const dispose of disposers) await dispose(); });
  // Delay invoking the real plugin until a response exists, proving that
  // durable writing alone cannot produce a delivery receipt.
  const requestId = randomUUID(); publish(f, requestId);
  await until(() => events(f).some(event => event.event === 'input_forwarded'));
  assert.equal(events(f).some(event => event.event === 'input_delivered'), false);
  assert.equal(f.job.pendingRequests.length, 1);
  fs.unlinkSync(mailbox(f, 'requests', requestId)); fs.unlinkSync(mailbox(f, 'responses', requestId));
  // The synthetic request was intentionally never consumed. Cancel it before
  // exercising the real plugin so its input gets an explicit rejection.
  cancel(f, requestId);
  await until(() => events(f).some(event => event.event === 'input_rejected' && event.inputId === inputId));
  const question = listeners.get('user-questions/request')({ agent: { session: { id: 'child-session' } },
    questions: [{ id: 'q', question: 'Continue?' }] }, () => { throw new Error('Unexpected fallback'); });
  assert.deepEqual(await question, { answers: [{ id: 'q', selected: [], custom: 'Continue' }] });
  await until(() => events(f).some(event => event.event === 'input_delivered' && event.inputId === inputId));
  const delivered = events(f).find(event => event.event === 'input_delivered' && event.inputId === inputId);
  assert.equal(delivered.receipt, 'plugin-consumed');
  assert.deepEqual(f.job.pendingRequests, []);
  assert.deepEqual(fs.readdirSync(path.join(f.host, 'responses')), []);
  assert.deepEqual(fs.readdirSync(path.join(f.host, 'receipts')), []);
  await until(() => f.child.waiting); f.child.finish(); await f.task;
});

test('ending before a plugin receipt rejects the forwarded answer instead of claiming delivery', async t => {
  let f, inputId;
  f = fixture(t, event => {
    if (event.event === 'request') inputId = queueInput(f.job, 'answer', { requestId: event.requestId,
      answer: { answers: [{ id: 'q', selected: [], custom: 'Continue' }] } }, f.home).inputId;
  });
  const requestId = randomUUID(); publish(f, requestId);
  await until(() => events(f).some(event => event.event === 'input_forwarded'));
  await until(() => f.child.waiting); f.child.finish(); await f.task;
  assert.ok(events(f).some(event => event.event === 'input_rejected' && event.inputId === inputId));
  assert.equal(events(f).some(event => event.event === 'input_delivered' && event.inputId === inputId), false);
  assert.deepEqual(f.job.pendingRequests, []); assert.equal(fs.existsSync(mailbox(f, 'responses', requestId)), false);
});

test('an already aborted signal rejects the session instead of running it', async t => {
  const controller = new AbortController();
  controller.abort(new Error('Already cancelled'));
  const f = fixture(t, () => {}, controller.signal);
  await assert.rejects(f.task, /Already cancelled/);
  assert.equal(fs.existsSync(f.job.reportFile), false);
  assert.equal(f.child.waiting, undefined);
});

test('eventsPage ignores an unterminated tail and reports no more pages', async t => {
  const root = fs.mkdtempSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'events-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'events.jsonl'), job = { id: 'events-job', eventsFile: file };
  const line = event => JSON.stringify({ event }) + '\n';
  fs.writeFileSync(file, line('first') + '{"event":"partial"');
  const page = eventsPage(job);
  assert.deepEqual(page.events, [{ event: 'first' }]);
  assert.equal(page.more, false);
  assert.equal(page.cursor, Buffer.byteLength(line('first')));
  assert.deepEqual(eventsPage(job, page.cursor).events, []);
});

test('eventsPage keeps more true while complete records remain past the limit', async t => {
  const root = fs.mkdtempSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'events-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'events.jsonl'), job = { id: 'events-job', eventsFile: file };
  fs.writeFileSync(file, ['first', 'second', 'third'].map(event => JSON.stringify({ event }) + '\n').join(''));
  const page = eventsPage(job, 0, 2);
  assert.deepEqual(page.events, [{ event: 'first' }, { event: 'second' }]);
  assert.equal(page.more, true);
  const rest = eventsPage(job, page.cursor, 2);
  assert.deepEqual(rest.events, [{ event: 'third' }]);
  assert.equal(rest.more, false);
});
