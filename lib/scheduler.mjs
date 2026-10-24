import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// This coordinates cooperating launchers on a local filesystem. Scope/resource
// declarations describe intended access; they do not sandbox the child process.
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const canonicalCase = value => process.platform === 'win32' ? value.toLowerCase() : value;
const exists = pid => {
  if (!Number.isSafeInteger(pid) || pid < 1) return true; // Unknown is never proof of death.
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};
async function atomicJson(file, value) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(tmp, file); break; }
      catch (error) {
        // Windows virus scanners/readers may briefly deny replacement. Retain
        // the bakery ticket while retrying; never unlink the committed state.
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 20) throw error;
        await pause(Math.min(10 * (attempt + 1), 100));
      }
    }
  } finally { try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function validateId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id))
    throw new Error('id must be 1 to 200 letters, digits, dots, underscores or hyphens, starting with a letter or digit');
}
function names(dir) {
  try { return fs.readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

// A filesystem Lamport bakery mutex avoids stale-lock stealing/ABA races. Each
// contender has an immutable, unique directory; an absent ticket means it is
// choosing. Dead contenders can be ignored, but EPERM/unknown owners cannot.
// A crash during a state update leaves either the previous or the next JSON.
async function transaction(home, action) {
  const dir = path.join(home, 'scheduler'), gate = path.join(dir, 'turnstile');
  fs.mkdirSync(gate, { recursive: true });
  const name = `${process.pid}-${crypto.randomUUID()}`, own = path.join(gate, name);
  fs.mkdirSync(own, { mode: 0o700 });
  function peers(selected) {
    return names(gate).filter(other => other !== name && (!selected || selected.has(other))).flatMap(other => {
      if (!/^\d+-[a-f0-9-]{36}$/.test(other)) throw new Error(`Unrecognized scheduler mutex entry: ${other}`);
      const peer = path.join(gate, other), pid = Number(other.split('-')[0]);
      if (!exists(pid)) {
        // Only our unique dead peer is removed, never a shared lock pathname.
        fs.rmSync(peer, { recursive: true, force: true });
        return [];
      }
      try {
        const ticket = readJson(path.join(peer, 'ticket.json')).ticket;
        if (!Number.isSafeInteger(ticket) || ticket < 1) throw new Error(`Invalid scheduler mutex ticket: ${peer}`);
        return [{ name: other, ticket }];
      }
      catch (error) {
        // A Windows delete-pending ticket may report EPERM rather than ENOENT.
        // Treat unreadable ownership as choosing and inspect again, never as an
        // absent owner. A removed directory disappears from the next inventory.
        if (['ENOENT', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) return [{ name: other, ticket: null }];
        throw error;
      }
    });
  }
  try {
    const ticket = Math.max(0, ...peers().map(peer => peer.ticket || 0)) + 1;
    await atomicJson(path.join(own, 'ticket.json'), { ticket });
    // Contenders created after this snapshot see our committed ticket and must
    // choose a larger number. Ignoring their choosing phase prevents a stream
    // of new arrivals from starving an older contender.
    const doorway = new Set(peers().map(peer => peer.name));
    while (peers(doorway).some(peer => peer.ticket == null || peer.ticket < ticket || (peer.ticket === ticket && peer.name < name)))
      await pause(12 + Math.floor(Math.random() * 10));
    const file = path.join(dir, 'state.json');
    let state;
    try { state = readJson(file); } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Cannot read scheduler state; inspect ${file}: ${error.message}`);
      state = { version: 1, nextSequence: 1, reservations: [] };
    }
    if (state.version !== 1 || !Array.isArray(state.reservations) || !Number.isSafeInteger(state.nextSequence) || state.nextSequence < 1)
      throw new Error(`Invalid scheduler state; inspect ${file}`);
    const ids = new Set();
    for (const item of state.reservations) {
      if (!item || typeof item.id !== 'string' || ids.has(item.id) || typeof item.token !== 'string' ||
          !['queued', 'active'].includes(item.state) || !Number.isSafeInteger(item.sequence) || item.sequence < 1 || item.sequence >= state.nextSequence ||
          !Number.isInteger(item.maxConcurrent) || item.maxConcurrent < 1 || item.maxConcurrent > 256 ||
          typeof item.readOnly !== 'boolean' || typeof item.exclusive !== 'boolean' || !Array.isArray(item.scopes) || !item.scopes.length ||
          item.scopes.some(scope => typeof scope !== 'string' || !path.isAbsolute(scope)) ||
          !Array.isArray(item.resources) || item.resources.some(resource => typeof resource !== 'string'))
        throw new Error(`Invalid scheduler reservation; inspect ${file}`);
      ids.add(item.id);
    }
    // Queued jobs have not launched. Active jobs are deliberately retained even
    // when their supervisor disappears: a child may still be modifying files.
    state.reservations = state.reservations.filter(item => item.state !== 'queued' || exists(item.supervisorPid));
    const result = action(state, file);
    await atomicJson(file, state);
    return result;
  } finally { fs.rmSync(own, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
}

function realFuturePath(input) {
  let ancestor = path.resolve(input);
  const suffix = [];
  for (;;) {
    try { return canonicalCase(path.resolve(fs.realpathSync(ancestor), ...suffix)); }
    catch (error) {
      // Broken links must not silently become unprotected lexical paths.
      if (error.code !== 'ENOENT') throw error;
      try { if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error(`Scope contains a broken symbolic link: ${ancestor}`); }
      catch (linkError) { if (linkError.code !== 'ENOENT') throw linkError; }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(path.basename(ancestor)); ancestor = parent;
    }
  }
}
function within(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function normalizeScopes(workspace, scopes) {
  if (!Array.isArray(scopes)) throw new Error('scopes must be an array');
  return [...new Set((scopes.length ? scopes : ['.']).map(scope => {
    if (typeof scope !== 'string' || !scope.trim() || scope.includes('\0')) throw new Error('Each scope must be a nonempty path');
    const lexical = canonicalCase(path.resolve(workspace, scope));
    if (!within(workspace, lexical)) throw new Error(`Scope escapes workspace: ${scope}`);
    const real = realFuturePath(lexical);
    if (!within(workspace, real)) throw new Error(`Scope resolves outside workspace: ${scope}`);
    return real;
  }))];
}
function conflicts(left, right) {
  if (left.exclusive || right.exclusive) return true;
  if (left.resources.some(resource => right.resources.includes(resource))) return true;
  if (left.readOnly && right.readOnly) return false;
  return left.scopes.some(a => right.scopes.some(b => within(a, b) || within(b, a)));
}
function abortError(signal) {
  const error = new Error('Scheduler queue cancelled', { cause: signal?.reason });
  error.name = 'AbortError'; error.code = 'ABORT_ERR'; return error;
}
function timeoutError() {
  const error = new Error('Scheduler queue wait timed out'); error.name = 'TimeoutError'; error.code = 'QUEUE_TIMEOUT'; return error;
}
function cancellablePause(signal, remaining) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const finish = error => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); error ? reject(error) : resolve(); };
    const onAbort = () => finish(abortError(signal));
    const timer = setTimeout(() => finish(), Math.max(1, Math.min(remaining, 35 + Math.random() * 20)));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Reserve a persistent slot. release() and setChildPid(pid) are asynchronous.
 * onQueued receives {id, position, reason}. queueTimeoutMs excludes child runtime.
 * A crashed active owner requires releaseReservation(..., {confirmedStopped:true}).
 * exclusive reserves the entire scheduler, including all workspaces/readers.
 */
export async function acquireSlot({ home, id, workspace, scopes = [], readOnly = false, resources = [],
  maxConcurrent = 8, exclusive = false, signal, onQueued, queueTimeoutMs = Infinity }) {
  if (typeof home !== 'string' || !home) throw new Error('home must be a directory path');
  validateId(id);
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 256) throw new Error('maxConcurrent must be an integer from 1 to 256');
  if (typeof readOnly !== 'boolean') throw new Error('readOnly must be boolean');
  if (typeof exclusive !== 'boolean') throw new Error('exclusive must be boolean');
  if (!(queueTimeoutMs > 0) || (queueTimeoutMs !== Infinity && !Number.isFinite(queueTimeoutMs))) throw new Error('queueTimeoutMs must be positive');
  if (!Array.isArray(resources) || resources.some(value => typeof value !== 'string' || !value.trim() || value.length > 500))
    throw new Error('resources must contain nonempty strings of at most 500 characters');
  home = path.resolve(home);
  workspace = canonicalCase(fs.realpathSync(workspace));
  if (!fs.statSync(workspace).isDirectory()) throw new Error('workspace must be a directory');
  const entry = { id, token: crypto.randomUUID(), supervisorPid: process.pid, childPid: null, workspace,
    scopes: normalizeScopes(workspace, scopes), readOnly, resources: [...new Set(resources.map(value => value.trim()))],
    maxConcurrent, exclusive, state: 'queued', queuedAt: Date.now() };
  const deadline = entry.queuedAt + queueTimeoutMs;
  let registered = false, acquired = false, notified = false;
  try {
    for (;;) {
      if (signal?.aborted) throw abortError(signal);
      if (Date.now() >= deadline) throw timeoutError();
      const outcome = await transaction(home, (state, file) => {
        if (!registered) {
          if (state.reservations.some(item => item.id === id))
            throw new Error(`Reservation already exists: ${id}`);
          entry.sequence = state.nextSequence++; state.reservations.push(entry);
        }
        const current = state.reservations.find(item => item.id === id && item.token === entry.token);
        if (!current) throw new Error(`Reservation disappeared: ${id}`);
        if (signal?.aborted) throw abortError(signal);
        if (Date.now() >= deadline) throw timeoutError();
        const active = state.reservations.filter(item => item.state === 'active');
        const earlier = state.reservations.filter(item => item.state === 'queued' && item.sequence < current.sequence);
        // The most restrictive participating launcher sets the shared ceiling.
        const limit = Math.min(...state.reservations.map(item => item.maxConcurrent));
        const reason = active.length >= limit ? 'capacity' :
          active.some(item => conflicts(current, item)) ? 'conflict' :
          earlier.some(item => conflicts(current, item)) ? 'earlier-conflict' :
          // A runnable older request gets the next free slot regardless of which
          // process wins this poll. Only blocked, disjoint requests can be passed.
          earlier.some(item => !active.some(owner => conflicts(item, owner)) &&
            !earlier.some(prior => prior.sequence < item.sequence && conflicts(item, prior))) ? 'earlier-capacity' : null;
        if (!reason) { current.state = 'active'; current.startedAt = Date.now(); }
        return { file, reason, acquired: !reason, position: earlier.length + 1 };
      });
      // Only publish ownership after the atomic state replacement succeeds.
      registered = true; acquired = outcome.acquired;
      if (acquired) {
        let released = false;
        const release = async () => {
          if (released) return;
          await transaction(home, state => {
            const item = state.reservations.find(item => item.id === id && item.token === entry.token);
            if (!item) throw new Error('Scheduler reservation ownership changed');
            if (item.childPid != null && exists(item.childPid)) throw new Error('Child process is still present; reservation retained');
            state.reservations = state.reservations.filter(candidate => candidate !== item);
          });
          released = true;
        };
        return { lockFile: outcome.file, release, setChildPid: async pid => {
          if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('childPid must be a positive integer');
          await transaction(home, state => {
            const item = state.reservations.find(item => item.id === id && item.token === entry.token);
            if (!item || released) throw new Error('Scheduler reservation ownership changed');
            if (item.childPid != null && item.childPid !== pid) throw new Error('Child process already recorded');
            item.childPid = pid;
          });
        } };
      }
      if (!notified) { notified = true; await onQueued?.({ id, position: outcome.position, reason: outcome.reason }); }
      await cancellablePause(signal, deadline - Date.now());
    }
  } finally {
    if (registered && !acquired) await transaction(home, state => {
      state.reservations = state.reservations.filter(item => item.id !== id || item.token !== entry.token);
    });
  }
}

/** Manual recovery never treats a missing supervisor as proof its child stopped. */
export async function releaseReservation(home, id, { confirmedStopped = false } = {}) {
  validateId(id);
  if (!confirmedStopped) throw new Error('Confirm the old task and its child processes stopped, then use --confirmed-stopped');
  return transaction(path.resolve(home), state => {
    const item = state.reservations.find(item => item.id === id);
    if (!item) throw new Error(`No scheduler reservation for ${id}`);
    if (exists(item.supervisorPid) || (item.childPid != null && exists(item.childPid)))
      throw new Error('A recorded process is still present or unknown; reservation retained');
    try {
      const job = readJson(path.join(home, 'jobs', id, 'job.json'));
      if (job.id !== id || (job.childPid != null && exists(job.childPid)) ||
          (job.supervisorPid != null && exists(job.supervisorPid)))
        throw new Error('A recorded job process is still present or unknown; reservation retained');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    state.reservations = state.reservations.filter(owner => owner.id !== id);
    return { id, unlocked: true };
  });
}
