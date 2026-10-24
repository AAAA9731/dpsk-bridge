import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { apply, name } from '../lib/host-plugin.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const agent = id => ({ session: { id } });
const questions = [{ id: 'choice', question: 'Which route?', options: [{ label: 'A' }, { label: 'B' }] },
  { id: 'detail', question: 'Any details?' }];
const answer = { answers: [{ id: 'choice', selected: ['B'] }, { id: 'detail', selected: [], custom: 'Use the fast route.' }] };
function context() {
  const listeners = new Map(), disposers = [];
  const ctx = {
    effect(execute) {
      const dispose = execute(); assert.equal(typeof dispose, 'function');
      let disposed = false;
      const stop = async () => { if (!disposed) { disposed = true; await dispose(); } };
      disposers.push(stop); return stop;
    },
    on(event, listener) {
      assert.equal(typeof listener, 'function');
      assert.ok(!listeners.has(event), `Duplicate listener for ${event}`);
      listeners.set(event, listener);
      const stop = () => { listeners.delete(event); };
      disposers.push(stop); return stop;
    },
  };
  return { ctx, listeners, emit: (event, request, next = () => { throw new Error('Unexpected next()'); }) => {
    const listener = listeners.get(event); assert.ok(listener, `No ${event} listener`);
    return Promise.resolve().then(() => listener(request, next));
  }, dispose: async () => { for (const dispose of [...disposers].reverse()) await dispose(); } };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(base, 'host-plugin-fixture-'));
  const directory = path.join(root, 'mailbox'), mock = context();
  apply(mock.ctx, { directory });
  t.after(async () => { await mock.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, directory, ...mock };
}
function entries(f, part) {
  return fs.readdirSync(path.join(f.directory, part)).filter(file => file.endsWith('.json')).map(file => ({
    file, value: JSON.parse(fs.readFileSync(path.join(f.directory, part, file), 'utf8')),
  }));
}
async function until(check, message = 'condition') {
  const deadline = Date.now() + 5000;
  for (;;) {
    const result = check(); if (result) return result;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await delay(10);
  }
}
async function request(f, count = 1) {
  return until(() => { const items = entries(f, 'requests'); return items.length === count ? items : false; }, `${count} requests`);
}
function respond(f, id, value, raw = false) {
  const final = path.join(f.directory, 'responses', `${id}.json`), tmp = `${final}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, raw ? value : JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, final);
}
function assertEmpty(f) {
  assert.deepEqual(entries(f, 'requests'), []); assert.deepEqual(entries(f, 'responses'), []);
}

test('exports a dependency-free plugin and validates absolute mailbox configuration', async () => {
  assert.equal(name, 'dpsk-bridge-host');
  for (const config of [undefined, null, {}, { directory: 'relative' }, { directory: 12 }])
    assert.throws(() => apply(context().ctx, config), /absolute filesystem path/);
  if (process.platform === 'win32') assert.throws(() => apply(context().ctx, { directory: '\\drive-relative' }), /absolute filesystem path/);
});

test('registers only official event answerers and delegates requests without an agent', async t => {
  const f = fixture(t); let calls = 0;
  assert.deepEqual([...f.listeners.keys()], ['user-questions/request', 'approval/request']);
  assert.deepEqual(await f.emit('user-questions/request', { questions }, () => { calls++; return answer; }), answer);
  assert.equal(await f.emit('approval/request', { toolName: 'shell' }, () => { calls++; return 'rejected'; }), 'rejected');
  assert.equal(calls, 2); assertEmpty(f);
  await f.dispose(); assert.equal(f.listeners.size, 0);
});

test('forwards full question presentation and returns sanitized answers covering exact ids', async t => {
  const f = fixture(t), payload = structuredClone(questions);
  payload[0].detail = 'Detailed explanation'; payload[0].header = 'Route';
  payload[0].intent = { kind: 'plan-review', approve: 'A', callId: 'call-review' };
  payload[0].multiSelect = true;
  const task = f.emit('user-questions/request', { agent: agent('main'), questions: payload });
  const [{ value, file }] = await request(f);
  assert.match(file, /^[a-f0-9-]{36}\.json$/); assert.equal(file, `${value.requestId}.json`);
  assert.deepEqual(value, { requestId: value.requestId, method: 'user-question/ask', params: {
    requestId: value.requestId, sessionId: 'main', questions: payload,
  } });
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(f.directory, 'requests', file)).mode & 0o777, 0o600);
  payload[0].id = 'mutated-after-publish';
  respond(f, value.requestId, { extra: 'discard', answers: [...answer.answers].reverse().map(item => ({ ...item, extra: 'discard' })) });
  assert.deepEqual(await task, { answers: [...answer.answers].reverse() }); assertEmpty(f);
  assert.deepEqual(entries(f, 'receipts').map(item => item.value), [{ requestId: value.requestId, sessionId: 'main', outcome: 'consumed' }]);
  await f.dispose(); assert.deepEqual(entries(f, 'cancelled'), []);
});

test('isolates concurrent parent, child, grandchild and repeated-session requests', async t => {
  const f = fixture(t), sessions = ['parent', 'child', 'grandchild', 'parent', 'child', 'grandchild', 'other-root', 'parent'];
  const tasks = sessions.map((sessionId, index) => f.emit('user-questions/request', {
    agent: agent(sessionId), questions: [{ id: `q-${index}`, question: `Question ${index}` }],
  }));
  const files = await request(f, sessions.length);
  assert.equal(new Set(files.map(item => item.value.requestId)).size, sessions.length);
  for (const { value } of [...files].reverse()) {
    const index = Number(value.params.questions[0].id.slice(2));
    assert.equal(value.params.sessionId, sessions[index]);
    respond(f, value.requestId, { answers: [{ id: `q-${index}`, selected: [], custom: `response-${index}` }] });
  }
  const results = await Promise.all(tasks);
  results.forEach((result, index) => assert.equal(result.answers[0].custom, `response-${index}`));
  assertEmpty(f);
});

test('approvals preserve child identity and metadata and return only explicit allowed/rejected/cancelled outcomes', async t => {
  const f = fixture(t);
  for (const outcome of ['allowed-once', 'rejected', 'cancelled']) {
    const task = f.emit('approval/request', { agent: agent('child'), toolName: 'shell', callId: 'call-9', reason: 'write file',
      displayReason: { en: 'Presentation only' } });
    const [{ value }] = await request(f);
    assert.deepEqual(value, { requestId: value.requestId, method: 'approval/request', params: {
      requestId: value.requestId, sessionId: 'child', toolName: 'shell', callId: 'call-9', reason: 'write file',
    } });
    respond(f, value.requestId, { outcome }); assert.equal(await task, outcome); assertEmpty(f);
  }
});

test('rejects malformed answer types and missing, duplicated, or foreign question ids', async t => {
  const f = fixture(t);
  const invalid = [null, [], {}, { answers: 'no' }, { answers: [] },
    { answers: [answer.answers[0], answer.answers[0]] },
    { answers: [{ id: 'choice', selected: [] }, { id: 'foreign', selected: [] }] },
    { answers: [{ id: 'choice', selected: [1] }, answer.answers[1]] },
    { answers: [answer.answers[0], { id: 'detail', selected: [], custom: false }] },
    { answers: [...answer.answers, { id: 'extra', selected: [] }] }];
  for (const value of invalid) {
    const task = f.emit('user-questions/request', { agent: agent('main'), questions });
    const rejected = assert.rejects(task, { code: 'BAD_ANSWER' });
    const [{ value: pending }] = await request(f); respond(f, pending.requestId, value);
    await rejected; assertEmpty(f);
  }
});

test('invalid JSON and approval responses fail closed and clean their mailbox entries', async t => {
  const f = fixture(t);
  const task = f.emit('user-questions/request', { agent: agent('main'), questions });
  const rejected = assert.rejects(task, { code: 'BAD_RESPONSE' });
  const [{ value }] = await request(f); respond(f, value.requestId, '{', true); await rejected; assertEmpty(f);
  for (const result of [null, [], {}, { outcome: true }, { outcome: 'allow-always' }, { outcome: 'unavailable' }]) {
    const task = f.emit('approval/request', { agent: agent('child'), toolName: 'shell' });
    const rejected = assert.rejects(task, { code: 'BAD_APPROVAL' });
    const [{ value }] = await request(f); respond(f, value.requestId, result); await rejected; assertEmpty(f);
  }
  assert.deepEqual(entries(f, 'cancelled'), []);
});

test('request abort cancels just its own question while another session continues', async t => {
  const f = fixture(t), controller = new AbortController();
  const cancelled = f.emit('user-questions/request', { agent: agent('child'), questions, signal: controller.signal });
  const rejected = assert.rejects(cancelled, { name: 'AbortError', code: 'ASK_ABORTED' });
  const other = f.emit('user-questions/request', { agent: agent('main'), questions });
  const files = await request(f, 2), child = files.find(item => item.value.params.sessionId === 'child').value;
  controller.abort(new Error('No longer needed')); await rejected;
  assert.equal(entries(f, 'requests').length, 1);
  const [marker] = entries(f, 'cancelled');
  assert.equal(marker.file, `${child.requestId}.json`); assert.equal(marker.value.sessionId, 'child');
  assert.match(marker.value.reason, /No longer needed/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(f.directory, 'cancelled', marker.file)).mode & 0o777, 0o600);
  const main = files.find(item => item.value.params.sessionId === 'main').value;
  respond(f, main.requestId, answer); assert.deepEqual(await other, answer); assertEmpty(f);
});

test('withdrawing a live approval returns cancelled and publishes its cancellation identity', async t => {
  const f = fixture(t), controller = new AbortController();
  const task = f.emit('approval/request', { agent: agent('child'), toolName: 'shell', signal: controller.signal });
  const [{ value }] = await request(f);
  controller.abort(new Error('Withdraw this operation'));
  assert.equal(await task, 'cancelled'); assertEmpty(f);
  const [marker] = entries(f, 'cancelled');
  assert.equal(marker.value.requestId, value.requestId); assert.equal(marker.value.sessionId, 'child');
});

test('already aborted requests leave cancellation markers without publishing host prompts', async t => {
  const f = fixture(t), signal = AbortSignal.abort(new Error('Already cancelled'));
  await assert.rejects(f.emit('user-questions/request', { agent: agent('main'), questions, signal }), { code: 'ASK_ABORTED' });
  assert.equal(await f.emit('approval/request', { agent: agent('child'), toolName: 'shell', signal }), 'cancelled');
  assertEmpty(f); assert.equal(entries(f, 'cancelled').length, 2);
  assert.deepEqual(entries(f, 'receipts'), []);
});

test('plugin disposal cancels and settles all pending sessions and unregisters handlers', async t => {
  const f = fixture(t);
  const question = f.emit('user-questions/request', { agent: agent('grandchild'), questions });
  const rejection = assert.rejects(question, { name: 'AbortError', code: 'ASK_ABORTED' });
  const approval = f.emit('approval/request', { agent: agent('child'), toolName: 'shell' });
  await request(f, 2); const before = Date.now();
  await f.dispose(); await rejection; assert.equal(await approval, 'cancelled');
  assert.ok(Date.now() - before < 2000, 'dispose must interrupt polling');
  assert.equal(f.listeners.size, 0); assertEmpty(f);
  assert.deepEqual(entries(f, 'cancelled').map(item => item.value.sessionId).sort(), ['child', 'grandchild']);
});

test('separate plugin instances cannot consume each other host responses', async t => {
  const first = fixture(t), second = fixture(t);
  const a = first.emit('approval/request', { agent: agent('same-session'), toolName: 'shell' });
  const b = second.emit('approval/request', { agent: agent('same-session'), toolName: 'shell' });
  const [[{ value: av }], [{ value: bv }]] = await Promise.all([request(first), request(second)]);
  respond(second, bv.requestId, { outcome: 'rejected' }); assert.equal(await b, 'rejected');
  assert.equal(entries(first, 'requests').length, 1);
  respond(first, av.requestId, { outcome: 'allowed-once' }); assert.equal(await a, 'allowed-once');
  assertEmpty(first); assertEmpty(second);
});
