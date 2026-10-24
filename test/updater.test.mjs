import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkForUpdate, readUpdateSettings, setAutoUpdate, applyUpdate, recoverUpdate } from '../lib/updater.mjs';
import { acquireSlot } from '../lib/scheduler.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-updater-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = path.join(directory, 'repo'), home = path.join(directory, 'settings'), bridgeHome = path.join(directory, 'bridge');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'dpsk-bridge', version: '0.4.0' }));
  return { directory, root, home, bridgeHome };
}
const release = (tag = 'v0.5.0', extra = {}) => new Response(JSON.stringify({ tag_name: tag, draft: false, prerelease: false, ...extra }), { status: 200 });
const update = { available: true, current: '0.4.0', latest: '0.5.0', tag: 'v0.5.0' };
const offline = async () => { throw new Error('offline'); };

test('update settings default to opt-in and persist explicit changes', t => {
  const f = fixture(t);
  assert.equal(readUpdateSettings(f.home).autoUpdate, false);
  assert.equal(setAutoUpdate(true, f.home).autoUpdate, true);
  assert.equal(readUpdateSettings(f.home).autoUpdate, true);
  assert.equal(setAutoUpdate(false, f.home).autoUpdate, false);
  assert.throws(() => setAutoUpdate('true', f.home), /boolean/);
});

test('stable semantic versions, six-hour cache, force, and offline cached availability', async t => {
  const f = fixture(t); let calls = 0;
  const fetchImpl = async (url, options) => { calls++; assert.match(url, /AAAA9731\/dpsk-bridge\/releases\/latest$/); assert.ok(options.signal); return release(); };
  const first = await checkForUpdate({ ...f, now: 1000, fetchImpl });
  assert.equal(first.available, true); assert.equal(first.current, '0.4.0'); assert.equal(first.latest, '0.5.0');
  assert.equal(first.url, 'https://github.com/AAAA9731/dpsk-bridge/releases/tag/v0.5.0');
  await checkForUpdate({ ...f, now: 2000, fetchImpl }); assert.equal(calls, 1);
  await checkForUpdate({ ...f, now: 3000, force: true, fetchImpl }); assert.equal(calls, 2);
  const failed = await checkForUpdate({ ...f, now: 3000 + 7 * 3600000, fetchImpl: offline });
  assert.equal(failed.available, true); assert.match(failed.error, /offline/); assert.equal(failed.checkedAt, 3000);
  fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ version: '0.6.0' }));
  assert.equal((await checkForUpdate({ ...f, now: 4000, fetchImpl })).available, false);
});

test('no releases, invalid tags, drafts, prereleases, and oversized responses never fail the viewer', async t => {
  const f = fixture(t);
  const missing = await checkForUpdate({ ...f, force: true, fetchImpl: async () => new Response('', { status: 404 }) });
  assert.equal(missing.available, false); assert.equal(missing.error, undefined); assert.equal(missing.latest, null);
  for (const [tag, extra] of [['--upload-pack=evil', {}], ['v0.5.0;evil', {}], ['v0.5.0-rc.1', {}], ['v0.5.0', { draft: true }], ['v0.5.0', { prerelease: true }]]) {
    const result = await checkForUpdate({ ...f, force: true, fetchImpl: async () => release(tag, extra) });
    assert.equal(result.available, false); assert.ok(result.error, JSON.stringify([tag, extra]));
  }
  const huge = await checkForUpdate({ ...f, force: true, fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1)) });
  assert.match(huge.error, /1 MiB/);
  const short = await checkForUpdate({ ...f, force: true, fetchImpl: async () => release('v0.3.0') });
  assert.equal(short.available, false);
  assert.equal((await checkForUpdate({ ...f, force: true, fetchImpl: offline })).available, false);
});

function git(root, args) {
  const result = spawnSync('git', ['-c', `safe.directory=${root}`, '-c', 'user.name=Updater test', '-c', 'user.email=updater@example.invalid', ...args],
    { cwd: root, windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
function repository(t) {
  const f = fixture(t);
  git(f.root, ['init']); git(f.root, ['add', 'package.json']); git(f.root, ['commit', '-m', 'installed version']);
  const installed = git(f.root, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ name: 'dpsk-bridge', version: '0.5.0' }));
  git(f.root, ['add', 'package.json']); git(f.root, ['commit', '-m', 'release version']); git(f.root, ['tag', 'v0.5.0']);
  git(f.root, ['checkout', '-b', 'installed', installed]);
  git(f.root, ['remote', 'add', 'origin', 'https://github.com/AAAA9731/dpsk-bridge.git']);
  const commands = [];
  const run = async (command, args, options) => {
    commands.push([command, args]);
    if (command === process.execPath) return { code: 0, stdout: '', stderr: '' };
    if (args.includes('fetch')) return { code: 0, stdout: '', stderr: '' }; // No network: release tag exists in this temporary repository.
    const result = spawnSync(command, args, { cwd: options.cwd, encoding: 'utf8', windowsHide: true });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  return { ...f, run, commands, installed };
}
function reservations(f) {
  return JSON.parse(fs.readFileSync(path.join(f.bridgeHome, 'scheduler', 'state.json'), 'utf8')).reservations;
}

test('updates a real clean checkout by fast-forward and invokes npm through Node, releasing the exclusive reservation', async t => {
  const f = repository(t), progress = [];
  const result = await applyUpdate(update, { ...f, onProgress: text => progress.push(text) });
  assert.equal(result.version, '0.5.0'); assert.equal(result.restartRequired, true);
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), git(f.root, ['rev-parse', 'v0.5.0']));
  const npm = f.commands.filter(([command]) => command === process.execPath);
  assert.equal(npm.length, 3); assert.match(npm[0][1][0], /npm-cli\.js$/);
  assert.deepEqual(npm[0][1].slice(1), ['ci', '--ignore-scripts', '--omit=dev']);
  assert.deepEqual(npm[1][1].slice(1), ['run', 'check']); assert.ok(progress.length >= 8);
  assert.deepEqual(npm[2][1].slice(1), ['run', 'sync-skills']);
  assert.deepEqual(reservations(f), []);
});

test('refuses dirty or wrong-origin checkouts before fetch and releases the mutex', async t => {
  for (const kind of ['dirty', 'origin', 'old-name']) {
    await t.test(kind, async t => {
      const f = repository(t);
      if (kind === 'dirty') fs.writeFileSync(path.join(f.root, 'untracked'), 'local data');
      else git(f.root, ['remote', 'set-url', 'origin', kind === 'origin' ? 'https://example.com/AAAA9731/dpsk-bridge.git' : 'https://github.com/AAAA9731/claude-deepseek-bridge.git']);
      await assert.rejects(applyUpdate(update, f), kind === 'dirty' ? /local changes|untracked/ : /official/);
      assert.equal(f.commands.some(([, args]) => args.includes('fetch')), false); assert.deepEqual(reservations(f), []);
      assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.installed);
    });
  }
});

test('rejects malicious tags before execution and divergent history before merging', async t => {
  const f = repository(t);
  await assert.rejects(applyUpdate({ ...update, tag: '--config=evil' }, f), /invalid/); assert.equal(f.commands.length, 0);
  fs.writeFileSync(path.join(f.root, 'local'), 'divergent commit'); git(f.root, ['add', 'local']); git(f.root, ['commit', '-m', 'local divergence']);
  await assert.rejects(applyUpdate(update, f), /not an ancestor/);
  assert.equal(f.commands.some(([, args]) => args.includes('merge')), false); assert.deepEqual(reservations(f), []);
});

test('rejects a release whose package identity disagrees with its tag', async t => {
  const f = repository(t), base = f.run;
  const run = async (command, args, options) => args.includes('show') ? { code: 0, stdout: JSON.stringify({ name: 'other-package', version: '0.5.0' }) } : base(command, args, options);
  await assert.rejects(applyUpdate(update, { ...f, run }), /package name or version/); assert.deepEqual(reservations(f), []);
});

test('dependency failure preserves the advanced checkout and recovery record while releasing the mutex', async t => {
  const f = repository(t), base = f.run;
  const run = async (command, args, options) => command === process.execPath ? { code: 1, stderr: 'install failed' } : base(command, args, options);
  await assert.rejects(applyUpdate(update, { ...f, run }), /No reset was performed/);
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), git(f.root, ['rev-parse', 'v0.5.0']));
  const recovery = JSON.parse(fs.readFileSync(path.join(f.home, 'update-state.json'), 'utf8'));
  assert.equal(recovery.state, 'failed'); assert.equal(recovery.merged, true); assert.deepEqual(reservations(f), []);
});

test('queued updates time out or cancel without disturbing the active reservation', async t => {
  const f = repository(t);
  const active = await acquireSlot({ home: f.bridgeHome, id: 'active-job', workspace: f.root });
  try {
    await assert.rejects(applyUpdate(update, { ...f, queueTimeoutMs: 30 }), /queue wait timed out/);
    const abort = new AbortController();
    const waiting = applyUpdate(update, { ...f, signal: abort.signal });
    setTimeout(() => abort.abort(), 20);
    await assert.rejects(waiting, /queue cancelled/);
    assert.equal(reservations(f).length, 1); assert.equal(f.commands.length, 0);
  } finally { await active.release(); }
});

test('rechecks installed version after acquiring the exclusive reservation', async t => {
  const f = repository(t);
  const active = await acquireSlot({ home: f.bridgeHome, id: 'earlier-updater', workspace: f.root, exclusive: true, maxConcurrent: 1 });
  const updating = applyUpdate(update, f);
  const rejected = assert.rejects(updating, /no longer newer/);
  try {
    const deadline = Date.now() + 3000;
    while (reservations(f).length < 2) {
      if (Date.now() > deadline) throw new Error('Updater did not queue');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ name: 'dpsk-bridge', version: '0.5.0' }));
  } finally { await active.release(); }
  await rejected; assert.equal(f.commands.length, 0); assert.deepEqual(reservations(f), []);
});

test('unconfirmed process cleanup retains the exclusive reservation and records recovery details', async t => {
  const f = repository(t), base = f.run;
  const run = async (command, args, options) => {
    if (command === process.execPath) {
      const failure = new Error('Cannot confirm update child stopped');
      failure.cleanupFailed = true; failure.pid = process.pid; throw failure;
    }
    return base(command, args, options);
  };
  await assert.rejects(applyUpdate(update, { ...f, run }), /No reset was performed/);
  const recovery = JSON.parse(fs.readFileSync(path.join(f.home, 'update-state.json'), 'utf8'));
  assert.equal(recovery.state, 'cleanup_failed'); assert.equal(recovery.retainedReservation, true);
  assert.equal(recovery.reservationId, reservations(f)[0].id);
  assert.equal(recovery.schedulerHome, path.resolve(f.bridgeHome)); assert.equal(recovery.supervisorPid, process.pid);
  assert.equal(reservations(f).length, 1); assert.equal(reservations(f)[0].childPid, process.pid);
});

async function retainedUpdate(f, pid) {
  const reservationId = 'update-12345678-1234-1234-1234-123456789abc';
  await acquireSlot({ home: f.bridgeHome, id: reservationId, workspace: f.root, exclusive: true, maxConcurrent: 1 });
  const file = path.join(f.bridgeHome, 'scheduler', 'state.json');
  const scheduler = JSON.parse(fs.readFileSync(file, 'utf8'));
  scheduler.reservations[0].supervisorPid = pid; scheduler.reservations[0].childPid = pid;
  fs.writeFileSync(file, JSON.stringify(scheduler));
  fs.mkdirSync(f.home, { recursive: true });
  fs.writeFileSync(path.join(f.home, 'update-state.json'), JSON.stringify({ state: 'cleanup_failed', retainedReservation: true,
    reservationId, schedulerHome: path.resolve(f.bridgeHome), supervisorPid: pid, pid, root: f.root }));
  return reservationId;
}

test('update recovery requires confirmation and refuses recorded live processes', async t => {
  const f = fixture(t);
  await retainedUpdate(f, process.pid);
  await assert.rejects(recoverUpdate(f), /confirmed-stopped/);
  await assert.rejects(recoverUpdate({ ...f, confirmedStopped: true }), /still present or unknown/);
  await assert.rejects(recoverUpdate({ ...f, bridgeHome: path.join(f.directory, 'wrong-home'), confirmedStopped: true }), /does not match/);
  assert.equal(reservations(f).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, 'update-state.json'))).state, 'cleanup_failed');
});

test('update recovery releases the matching reservation only after its recorded processes have exited', async t => {
  const f = fixture(t);
  const exited = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8', windowsHide: true });
  assert.equal(exited.status, 0); const pid = Number(exited.stdout.trim());
  const reservationId = await retainedUpdate(f, pid);
  const result = await recoverUpdate({ home: f.home, confirmedStopped: true });
  assert.equal(result.unlocked, true); assert.equal(result.reservationId, reservationId); assert.deepEqual(reservations(f), []);
  const state = JSON.parse(fs.readFileSync(path.join(f.home, 'update-state.json')));
  assert.equal(state.state, 'recovered'); assert.equal(state.reservationId, reservationId); assert.equal(state.retainedReservation, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'))).version, '0.4.0');
});

test('update recovery rejects ordinary failures and malformed reservation identities', async t => {
  const f = fixture(t); fs.mkdirSync(f.home);
  const file = path.join(f.home, 'update-state.json');
  fs.writeFileSync(file, JSON.stringify({ state: 'failed', retainedReservation: false }));
  await assert.rejects(recoverUpdate({ ...f, confirmedStopped: true }), /repair dependencies/);
  fs.writeFileSync(file, JSON.stringify({ state: 'cleanup_failed', retainedReservation: true, reservationId: '../other' }));
  await assert.rejects(recoverUpdate({ ...f, confirmedStopped: true }), /invalid reservationId/);
});
