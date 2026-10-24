import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireSlot, releaseReservation } from '../lib/scheduler.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const thisFile = fileURLToPath(import.meta.url);

// The same file is an actual independent launcher in multiprocess tests.
if (process.argv[2] === '--scheduler-worker') {
  const options = JSON.parse(process.argv[3]);
  try {
    const slot = await acquireSlot({ ...options, onQueued: info => process.send?.({ type: 'queued', ...info }) });
    if (options.marker) fs.writeFileSync(options.marker, String(process.pid), { flag: 'wx' });
    const start = process.hrtime.bigint().toString();
    process.send?.({ type: 'acquired', pid: process.pid, start });
    if (options.hold === 'manual') await once(process, 'message');
    else await delay(options.hold ?? 50);
    if (options.marker) fs.unlinkSync(options.marker);
    const end = process.hrtime.bigint().toString();
    await slot.release();
    process.send?.({ type: 'released', start, end });
    process.disconnect?.();
  } catch (error) {
    process.send?.({ type: 'failure', message: error.stack });
    process.exitCode = 1;
    process.disconnect?.();
  }
} else {
  function fixture(t) {
    // Keep fixtures in the writable checkout parent; Windows app-container
    // TEMP paths can prohibit rename even when they allow create/unlink.
    const root = fs.mkdtempSync(path.resolve(path.dirname(thisFile), '..', '..', 'scheduler-fixture-'));
    const home = path.join(root, 'home'), workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, home, workspace };
  }
  function options(f, id, extra = {}) { return { home: f.home, workspace: f.workspace, id, ...extra }; }
  function state(f) {
    try { return JSON.parse(fs.readFileSync(path.join(f.home, 'scheduler', 'state.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { reservations: [] }; throw error; }
  }
  async function until(check, message = 'condition', timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (!check()) { if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${message}`); await delay(10); }
  }
  function worker(t, args) {
    const child = spawn(process.execPath, [thisFile, '--scheduler-worker', JSON.stringify(args)], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    const messages = [];
    child.on('message', message => messages.push(message));
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`Worker exit ${code}: ${stderr}\n${JSON.stringify(messages)}`)));
    });
    // Deliberately killed workers are handled by tests, but never cause an
    // unhandled rejection before their owner can await the result.
    closed.catch(() => {});
    t.after(async () => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL'); await closed.catch(() => {}); });
    return { child, messages, closed, wait: async type => {
      await until(() => messages.some(message => message.type === type) || child.exitCode != null || child.signalCode != null, `${type} from ${child.pid}`);
      const message = messages.find(message => message.type === type);
      assert.ok(message, `Worker exited before ${type}: ${JSON.stringify(messages)} ${stderr}`);
      return message;
    } };
  }
  async function deadPid() {
    const child = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
    await once(child, 'close');
    return child.pid;
  }

  test('validates limits, normalizes future scopes, and rejects scope traversal and symlink escapes', async t => {
    const f = fixture(t);
    for (const maxConcurrent of [0, 257, 1.5, NaN])
      await assert.rejects(acquireSlot(options(f, 'bad-limit', { maxConcurrent })), /maxConcurrent/);
    for (const exclusive of [0, 1, null, 'true'])
      await assert.rejects(acquireSlot(options(f, 'bad-exclusive', { exclusive })), /exclusive must be boolean/);
    for (const scopes of [['../outside'], [path.join(f.root, 'outside')], ['']])
      await assert.rejects(acquireSlot(options(f, 'bad-scope', { scopes })), /scope/i);
    await assert.rejects(acquireSlot(options(f, '../bad-id')), /id/);
    fs.mkdirSync(path.join(f.workspace, 'actual'));
    const slot = await acquireSlot(options(f, 'normal', { scopes: ['./actual/../actual/not-created', 'actual/not-created'] }));
    assert.equal(state(f).reservations[0].scopes.length, 1);
    assert.match(state(f).reservations[0].scopes[0], /actual[\\/]not-created$/);
    await slot.release(); await slot.release();
    assert.deepEqual(state(f).reservations, []);
    await t.test('resolves existing symlinks before comparing scopes', async subtest => {
      const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
      try { fs.symlinkSync(outside, path.join(f.workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (error) { if (error.code === 'EPERM' || error.code === 'EACCES') { subtest.skip('OS sandbox does not permit symlinks'); return; } throw error; }
      await assert.rejects(acquireSlot(options(f, 'escape', { scopes: ['escape/new/file'] })), /outside workspace/);
      fs.symlinkSync(path.join(f.workspace, 'actual'), path.join(f.workspace, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
      const linked = await acquireSlot(options(f, 'linked', { scopes: ['alias/not-created', 'actual/not-created'] }));
      assert.equal(state(f).reservations[0].scopes.length, 1);
      await linked.release();
    });
  });

  test('disjoint scopes and readers run concurrently; default writes and parents conflict', async t => {
    const f = fixture(t);
    const left = await acquireSlot(options(f, 'left', { scopes: ['left'] }));
    const right = await acquireSlot(options(f, 'right', { scopes: ['right/new'] }));
    const reader = await acquireSlot(options(f, 'reader', { scopes: ['reading'], readOnly: true }));
    const reader2 = await acquireSlot(options(f, 'reader2', { scopes: ['reading/deep'], readOnly: true }));
    const controller = new AbortController(); let queued = false;
    const parent = acquireSlot(options(f, 'parent', { signal: controller.signal, onQueued: () => { queued = true; } }));
    const checked = assert.rejects(parent, { name: 'AbortError' });
    await until(() => queued);
    assert.equal(state(f).reservations.find(item => item.id === 'parent').state, 'queued');
    controller.abort(); await checked;
    await Promise.all([left.release(), right.release(), reader.release(), reader2.release()]);
    const writer = await acquireSlot(options(f, 'writer', { scopes: ['reading'] }));
    await writer.release();
  });

  test('queued cancellation, timeout, and callback errors remove only their own reservations', async t => {
    const f = fixture(t), first = await acquireSlot(options(f, 'first'));
    const controller = new AbortController();
    const pending = acquireSlot(options(f, 'cancel', { signal: controller.signal }));
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await until(() => state(f).reservations.length === 2);
    controller.abort(); await rejected;
    await assert.rejects(acquireSlot(options(f, 'timeout', { queueTimeoutMs: 70 })), { code: 'QUEUE_TIMEOUT' });
    await assert.rejects(acquireSlot(options(f, 'callback', { onQueued: () => { throw new Error('callback failed'); } })), /callback failed/);
    await assert.rejects(acquireSlot(options(f, 'preabort', { signal: AbortSignal.abort() })), { name: 'AbortError' });
    assert.deepEqual(state(f).reservations.map(item => item.id), ['first']);
    await first.release();
  });

  test('writers do not starve behind later readers, and blocked disjoint scopes can be passed', async t => {
    const f = fixture(t), order = [];
    const reader = await acquireSlot(options(f, 'initial-reader', { scopes: ['a'], readOnly: true }));
    const waitingWriter = acquireSlot(options(f, 'writer', { scopes: ['a'] })).then(slot => { order.push('writer'); return slot; });
    await until(() => state(f).reservations.some(item => item.id === 'writer'));
    const laterReader = acquireSlot(options(f, 'later-reader', { scopes: ['a'], readOnly: true })).then(slot => { order.push('reader'); return slot; });
    const unrelated = await acquireSlot(options(f, 'unrelated', { scopes: ['b'] }));
    await delay(80); assert.deepEqual(order, []);
    await reader.release();
    const writer = await waitingWriter;
    await delay(70); assert.deepEqual(order, ['writer']);
    await writer.release(); const last = await laterReader;
    assert.deepEqual(order, ['writer', 'reader']);
    await Promise.all([last.release(), unrelated.release()]);
  });

  test('capacity is shared across workspaces and oldest runnable requests get free slots', async t => {
    const f = fixture(t), order = [];
    const other = path.join(f.root, 'other'); fs.mkdirSync(other);
    const initial = await acquireSlot(options(f, 'first', { maxConcurrent: 1 }));
    const secondPending = acquireSlot(options(f, 'second', { workspace: other, maxConcurrent: 1 })).then(slot => { order.push(2); return slot; });
    await until(() => state(f).reservations.some(item => item.id === 'second'));
    const thirdPending = acquireSlot(options(f, 'third', { scopes: ['a'], maxConcurrent: 1 })).then(slot => { order.push(3); return slot; });
    await delay(50); assert.deepEqual(order, []);
    await initial.release();
    const second = await secondPending; await delay(60); assert.deepEqual(order, [2]);
    await second.release(); const third = await thirdPending; await third.release();
    assert.deepEqual(order, [2, 3]);
  });

  test('recorded children and live/unknown supervisors cannot be manually unlocked', async t => {
    const f = fixture(t), slot = await acquireSlot(options(f, 'live'));
    await slot.setChildPid(process.pid);
    await assert.rejects(slot.release(), /Child process is still present/);
    await assert.rejects(releaseReservation(f.home, 'live'), /confirmed-stopped/);
    await assert.rejects(releaseReservation(f.home, 'live', { confirmedStopped: true }), /still present or unknown/);
    await assert.rejects(slot.setChildPid(await deadPid()), /already recorded/);
    assert.equal(state(f).reservations.length, 1);
  });

  test('crashed active jobs retain reservations until confirmed recovery, then queued work proceeds', async t => {
    const f = fixture(t), active = worker(t, options(f, 'crashed', { hold: 'manual' }));
    await active.wait('acquired'); active.child.kill('SIGKILL'); await active.closed.catch(() => {});
    let ran = false;
    const waiting = acquireSlot(options(f, 'next')).then(slot => { ran = true; return slot; });
    await until(() => state(f).reservations.some(item => item.id === 'next'));
    await delay(100); assert.equal(ran, false);
    assert.equal(state(f).reservations.find(item => item.id === 'crashed').state, 'active');
    await assert.rejects(releaseReservation(f.home, 'crashed'), /confirmed-stopped/);
    await releaseReservation(f.home, 'crashed', { confirmedStopped: true });
    const slot = await waiting; await slot.release();
    assert.deepEqual(state(f).reservations, []);
  });

  test('dead queued owners and dead unique mutex contenders are cleaned safely', async t => {
    const f = fixture(t), initial = await acquireSlot(options(f, 'initial'));
    const waiting = worker(t, options(f, 'dead-queued', { hold: 'manual' }));
    await waiting.wait('queued'); waiting.child.kill('SIGKILL'); await waiting.closed.catch(() => {});
    const gate = path.join(f.home, 'scheduler', 'turnstile', `${waiting.child.pid}-${crypto.randomUUID()}`);
    fs.mkdirSync(gate); fs.writeFileSync(path.join(gate, 'ticket.json'), '{"ticket":1}');
    await initial.release();
    const next = await acquireSlot(options(f, 'next')); await next.release();
    assert.deepEqual(state(f).reservations, []); assert.equal(fs.existsSync(gate), false);
  });

  test('exclusive reservations drain all workspaces and block later readers without a capacity limit of one', async t => {
    const f = fixture(t), other = path.join(f.root, 'other'); fs.mkdirSync(other);
    const current = await acquireSlot(options(f, 'current', { readOnly: true }));
    let updateAcquired = false, laterAcquired = false;
    const updating = acquireSlot(options(f, 'updating', { workspace: other, exclusive: true, readOnly: true }))
      .then(slot => { updateAcquired = true; return slot; });
    await until(() => state(f).reservations.some(item => item.id === 'updating'));
    assert.equal(state(f).reservations.find(item => item.id === 'updating').exclusive, true);
    const later = acquireSlot(options(f, 'later', { workspace: other, scopes: ['disjoint'], readOnly: true }))
      .then(slot => { laterAcquired = true; return slot; });
    await until(() => state(f).reservations.some(item => item.id === 'later'));
    await delay(70); assert.equal(updateAcquired, false); assert.equal(laterAcquired, false);
    await current.release(); const update = await updating;
    await delay(70); assert.equal(laterAcquired, false);
    assert.deepEqual(state(f).reservations.filter(item => item.state === 'active').map(item => item.id), ['updating']);
    await update.release(); const last = await later; await last.release();
    assert.deepEqual(state(f).reservations, []);
  });

  test('a real updater waits for every active process, then later jobs wait for its release', { timeout: 30000 }, async t => {
    const f = fixture(t);
    const current = worker(t, options(f, 'current', { scopes: ['a'], readOnly: true, hold: 'manual' }));
    const current2 = worker(t, options(f, 'current2', { scopes: ['b'], readOnly: true, hold: 'manual' }));
    await Promise.all([current.wait('acquired'), current2.wait('acquired')]);
    const updater = worker(t, options(f, 'updater', { exclusive: true, maxConcurrent: 1, hold: 'manual' }));
    await updater.wait('queued');
    const other = path.join(f.root, 'other'); fs.mkdirSync(other);
    const later = worker(t, options(f, 'later', { workspace: other, readOnly: true, hold: 'manual' }));
    await later.wait('queued');
    current.child.send('release'); await current.closed;
    await delay(70); assert.equal(updater.messages.some(message => message.type === 'acquired'), false);
    current2.child.send('release'); await current2.closed;
    await updater.wait('acquired');
    await delay(70); assert.equal(later.messages.some(message => message.type === 'acquired'), false);
    updater.child.send('release'); await updater.closed;
    await later.wait('acquired'); later.child.send('release'); await later.closed;
    assert.deepEqual(state(f).reservations, []);
  });

  test('real multiprocess contention serializes default writers without lost reservations', { timeout: 30000 }, async t => {
    const f = fixture(t), marker = path.join(f.root, 'critical');
    const workers = Array.from({ length: 12 }, (_, index) => worker(t, options(f, `writer-${index}`, { marker, hold: 35 })));
    await Promise.all(workers.map(item => item.closed));
    assert.equal(workers.flatMap(item => item.messages).filter(message => message.type === 'released').length, 12);
    assert.deepEqual(state(f).reservations, []);
    assert.deepEqual(fs.readdirSync(path.join(f.home, 'scheduler', 'turnstile')), []);
  });

  test('real multiprocess jobs use available slots without exceeding global capacity', { timeout: 30000 }, async t => {
    const f = fixture(t);
    const workers = Array.from({ length: 15 }, (_, index) => worker(t, options(f, `parallel-${index}`, { scopes: [`scope-${index}`], maxConcurrent: 3, hold: 90 })));
    await Promise.all(workers.map(item => item.closed));
    const events = workers.map(item => item.messages.find(message => message.type === 'released'))
      .flatMap(({ start, end }) => [{ at: BigInt(start), change: 1 }, { at: BigInt(end), change: -1 }])
      .sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.change - b.change);
    let running = 0, peak = 0;
    for (const event of events) { running += event.change; peak = Math.max(peak, running); assert.ok(running <= 3); }
    assert.equal(peak, 3); assert.equal(running, 0); assert.deepEqual(state(f).reservations, []);
  });

  test('same named resources serialize real processes even in different workspaces', { timeout: 30000 }, async t => {
    const f = fixture(t), marker = path.join(f.root, 'shared-resource');
    const workers = Array.from({ length: 7 }, (_, index) => {
      const workspace = path.join(f.root, `workspace-${index}`); fs.mkdirSync(workspace);
      return worker(t, options(f, `resource-${index}`, { workspace, resources: ['shared-mcp'], marker, readOnly: true, hold: 30 }));
    });
    await Promise.all(workers.map(item => item.closed));
    assert.deepEqual(state(f).reservations, []);
  });
}
