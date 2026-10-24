import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import semver from 'semver';
import { acquireSlot, releaseReservation } from './scheduler.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const defaultHome = () => path.join(os.homedir(), '.dpsk-bridge');
const officialRepo = 'AAAA9731/dpsk-bridge';
const cacheMs = 6 * 60 * 60 * 1000;
const schedulerHomeOf = bridgeHome => path.resolve(bridgeHome || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'bridge'));
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function versionOf(root) {
  const value = readJson(path.join(root, 'package.json')).version;
  if (typeof value !== 'string' || !semver.valid(value)) throw new Error('Installed bridge has an invalid package version');
  return semver.valid(value);
}
function tagVersion(tag) {
  if (typeof tag !== 'string' || tag.length > 200 || !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(tag))
    throw new Error('Release has an invalid version tag');
  const version = semver.valid(tag);
  if (!version || semver.prerelease(version)) throw new Error('Only stable semantic-version releases can be installed');
  return version;
}
export function readUpdateSettings(home = defaultHome()) {
  try { const settings = readJson(path.join(home, 'settings.json')); return { ...settings, autoUpdate: settings.autoUpdate === true }; }
  catch { return { autoUpdate: false }; }
}
export function setAutoUpdate(enabled, home = defaultHome()) {
  if (typeof enabled !== 'boolean') throw new Error('autoUpdate must be boolean');
  const settings = { ...readUpdateSettings(home), autoUpdate: enabled };
  writeJson(path.join(home, 'settings.json'), settings); return settings;
}
function resultFor(current, entry, error) {
  const valid = typeof entry?.latest === 'string' && semver.valid(entry.latest);
  return { available: !!(valid && current && semver.gt(entry.latest, current)), current,
    latest: valid ? entry.latest : null, tag: valid ? entry.tag : null, url: valid ? entry.url : null,
    checkedAt: entry?.checkedAt ?? null, ...(error ? { error } : {}) };
}
async function boundedJson(response) {
  const limit = 1024 * 1024;
  if (Number(response.headers?.get('content-length')) > limit) throw new Error('GitHub release response exceeds 1 MiB');
  let bytes = 0; const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw new Error('GitHub release response exceeds 1 MiB');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
/** Read a cached stable GitHub release; network errors never break the viewer. */
export async function checkForUpdate({ force = false, root = repoRoot, home = defaultHome(), fetchImpl = globalThis.fetch,
  now = Date.now(), repo = officialRepo } = {}) {
  let current = null, cached;
  try {
    current = versionOf(root);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Invalid GitHub repository');
    try {
      const stored = readJson(path.join(home, 'release-cache.json'));
      if (stored.repo === repo && Number.isFinite(stored.checkedAt) &&
          (stored.latest === null || tagVersion(stored.tag) === stored.latest)) cached = stored;
    } catch {}
    if (!force && cached && now >= cached.checkedAt && now - cached.checkedAt < cacheMs) return resultFor(current, cached);
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(new Error('GitHub release check timed out')), 5000);
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
        signal: abort.signal, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dpsk-bridge-updater' },
      });
      let next = { repo, checkedAt: now, latest: null, tag: null, url: null };
      if (response.status !== 404) {
        if (!response.ok) throw new Error(`GitHub release check returned HTTP ${response.status}`);
        const release = await boundedJson(response);
        if (release.draft !== false || release.prerelease !== false) throw new Error('GitHub did not return a stable published release');
        const latest = tagVersion(release.tag_name);
        next = { ...next, latest, tag: release.tag_name, url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(release.tag_name)}` };
      }
      writeJson(path.join(home, 'release-cache.json'), next); return resultFor(current, next);
    } finally { clearTimeout(timer); }
  } catch (error) { return resultFor(current, cached, error.message); }
}

/** Locate npm's JavaScript CLI so Windows updates never execute a command shell. */
export function resolveNpmCli() {
  const directories = [...new Set([path.dirname(process.execPath), ...(process.env.PATH || '').split(path.delimiter).filter(Boolean)])];
  const candidates = [process.env.npm_execpath, ...directories.flatMap(directory => [
    path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(directory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(directory, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ])];
  for (const candidate of candidates) {
    if (!candidate || path.basename(candidate) !== 'npm-cli.js') continue;
    try { if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate); } catch {}
  }
  throw new Error('Cannot locate npm/bin/npm-cli.js; install npm alongside Node.js before updating');
}
function runCommand(command, args, { cwd, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0, stopping;
    let confirmClose;
    const closed = new Promise(resolve => { confirmClose = resolve; });
    const stop = error => {
      if (stopping) return;
      stopping = (async () => {
        let deadline;
        try {
          const killTree = process.platform === 'win32' ? new Promise((resolve, reject) => {
            const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
            killer.once('error', reject);
            killer.once('close', code => code === 0 ? resolve() : reject(new Error(`taskkill exited ${code}`)));
          }) : Promise.resolve().then(() => {
            try { process.kill(-child.pid, 'SIGKILL'); } catch (failure) { if (failure.code !== 'ESRCH') throw failure; }
          });
          await Promise.race([Promise.all([killTree, closed]), new Promise((resolve, reject) => {
            deadline = setTimeout(() => reject(new Error('Process-tree cleanup did not complete within 10 seconds')), 10000);
          })]);
        } catch (cleanup) {
          error.cleanupFailed = true; error.pid = child.pid;
          error.message += `; cleanup unconfirmed: ${cleanup.message}`;
          child.stdin?.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
        } finally { clearTimeout(deadline); reject(error); }
      })();
    };
    const timer = setTimeout(() => stop(new Error(`Command timed out: ${command}`)), timeoutMs);
    const capture = target => chunk => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) { stop(new Error('Update command output exceeds 4 MiB')); return; }
      if (target === 'stdout') stdout += chunk; else stderr += chunk;
    };
    child.stdout.on('data', capture('stdout')); child.stderr.on('data', capture('stderr'));
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); confirmClose(); if (!stopping) resolve({ code, stdout, stderr }); });
  });
}
function officialOrigin(origin) {
  if (/^git@github\.com:AAAA9731\/dpsk-bridge(?:\.git)?$/i.test(origin)) return true;
  try {
    const url = new URL(origin);
    return ['https:', 'ssh:'].includes(url.protocol) && url.hostname.toLowerCase() === 'github.com' && !url.port &&
      !url.password && !url.search && !url.hash && (url.protocol === 'ssh:' ? url.username === 'git' : !url.username) &&
      /^\/AAAA9731\/dpsk-bridge(?:\.git)?$/i.test(url.pathname);
  } catch { return false; }
}
/** Apply a reviewed release as a fast-forward, with a scheduler-wide exclusive reservation. */
export async function applyUpdate(info, { root = repoRoot, home = defaultHome(), bridgeHome,
  onProgress = () => {}, run = runCommand, signal, queueTimeoutMs = 60000 } = {}) {
  const target = tagVersion(info?.tag);
  if (target !== info?.latest) throw new Error('Release version does not match its tag');
  root = fs.realpathSync.native(root);
  let current = versionOf(root);
  if (!semver.gt(target, current)) throw new Error('Release is not newer than the installed bridge');
  const schedulerHome = schedulerHomeOf(bridgeHome);
  const reservationId = `update-${crypto.randomUUID()}`;
  onProgress('Waiting for active bridge jobs before updating');
  const reservation = await acquireSlot({ home: schedulerHome, id: reservationId, workspace: root,
    exclusive: true, maxConcurrent: 1, signal, queueTimeoutMs });
  const ownership = { reservationId, schedulerHome, supervisorPid: process.pid };
  let merged = false, retainReservation = false;
  const stateFile = path.join(home, 'update-state.json');
  const invoke = async (command, args, label, allowFailure = false) => {
    onProgress(label);
    const result = await run(command, args, { cwd: root, timeoutMs: 120000 });
    const code = result.code ?? result.status;
    if (code !== 0 && !allowFailure) throw new Error(`${label} failed (${code}): ${String(result.stderr || result.stdout || '').trim()}`);
    return { ...result, code, stdout: String(result.stdout || '') };
  };
  const git = (args, label, allowFailure) => invoke('git', ['-c', `safe.directory=${root}`, ...args], label, allowFailure);
  const clean = async () => {
    if ((await git(['status', '--porcelain=v1', '--untracked-files=all'], 'Checking for local changes')).stdout.trim())
      throw new Error('Bridge checkout has local changes or untracked files; commit or move them before updating');
  };
  try {
    current = versionOf(root);
    if (!semver.gt(target, current)) throw new Error('Release is no longer newer; another updater may already have installed it');
    const actualRoot = path.resolve(fs.realpathSync.native((await git(['rev-parse', '--show-toplevel'], 'Checking Git root')).stdout.trim()));
    const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (canonical(actualRoot) !== canonical(root)) throw new Error(`Update root must be the exact Git checkout root: ${root}; Git reported ${actualRoot}`);
    const origins = (await git(['remote', 'get-url', '--all', 'origin'], 'Checking official origin')).stdout.trim().split(/\r?\n/);
    if (origins.length !== 1 || !officialOrigin(origins[0])) throw new Error(`Origin must be the official ${officialRepo} repository`);
    await clean();
    await git(['fetch', '--no-tags', '--no-recurse-submodules', 'origin', `refs/tags/${info.tag}:refs/tags/${info.tag}`], 'Fetching release tag');
    const ancestor = await git(['merge-base', '--is-ancestor', 'HEAD', `refs/tags/${info.tag}`], 'Checking fast-forward ancestry', true);
    if (ancestor.code !== 0) throw new Error('Current HEAD is not an ancestor of the release tag; divergent history requires manual review');
    const tagged = JSON.parse((await git(['show', `refs/tags/${info.tag}:package.json`], 'Checking release package')).stdout);
    if (tagged.name !== 'dpsk-bridge' || tagged.version !== target) throw new Error('Release package name or version does not match the requested bridge release');
    await clean();
    const npm = resolveNpmCli();
    writeJson(stateFile, { state: 'updating', ...ownership, root, from: current, to: target, tag: info.tag, startedAt: Date.now() });
    await git(['merge', '--ff-only', `refs/tags/${info.tag}`], 'Fast-forwarding bridge checkout'); merged = true;
    await invoke(process.execPath, [npm, 'ci', '--ignore-scripts', '--omit=dev'], 'Installing release dependencies');
    await invoke(process.execPath, [npm, 'run', 'check'], 'Checking updated bridge');
    await invoke(process.execPath, [npm, 'run', 'sync-skills'], 'Synchronizing installed bridge skills');
    writeJson(stateFile, { state: 'completed', ...ownership, root, from: current, to: target, tag: info.tag, completedAt: Date.now() });
    return { updated: true, version: target, restartRequired: true };
  } catch (error) {
    if (error.cleanupFailed) {
      retainReservation = true;
      if (Number.isSafeInteger(error.pid) && error.pid > 0) await reservation.setChildPid(error.pid);
    }
    writeJson(stateFile, { state: error.cleanupFailed ? 'cleanup_failed' : 'failed', ...ownership, root, from: current, to: target, tag: info.tag,
      merged, retainedReservation: retainReservation, pid: error.pid ?? null, error: error.message, failedAt: Date.now() });
    if (merged) throw new Error(`Bridge advanced to ${target}, but setup failed. No reset was performed; inspect ${stateFile} and repair dependencies/checks before restarting. ${error.message}`, { cause: error });
    throw error;
  } finally { if (!retainReservation) await reservation.release(); }
}

/** Release a retained updater reservation only after explicit confirmation and conservative PID checks. */
export async function recoverUpdate({ home = defaultHome(), bridgeHome, confirmedStopped = false } = {}) {
  const stateFile = path.join(home, 'update-state.json');
  const state = readJson(stateFile);
  if (state.state !== 'cleanup_failed' || state.retainedReservation !== true)
    throw new Error('No retained update reservation needs recovery; repair dependencies or checks for an ordinary failed update');
  if (typeof state.reservationId !== 'string' || !/^update-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(state.reservationId))
    throw new Error('Update recovery state has an invalid reservationId; inspect the saved scheduler state');
  if (typeof state.schedulerHome !== 'string' || !path.isAbsolute(state.schedulerHome))
    throw new Error('Update recovery state has an invalid schedulerHome; inspect the saved scheduler state');
  const canonicalHome = value => {
    let resolved = path.resolve(value);
    try { resolved = fs.realpathSync.native(resolved); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  if (bridgeHome !== undefined && canonicalHome(bridgeHome) !== canonicalHome(state.schedulerHome))
    throw new Error('Requested bridge home does not match the retained update schedulerHome');
  let result;
  try { result = await releaseReservation(state.schedulerHome, state.reservationId, { confirmedStopped }); }
  catch (error) {
    throw new Error(`Close the old dsv supervisor and confirm its update child processes have stopped before using dsv update --recover --confirmed-stopped. ${error.message}`, { cause: error });
  }
  writeJson(stateFile, { ...state, state: 'recovered', retainedReservation: false, recoveredAt: Date.now() });
  return { recovered: true, reservationId: state.reservationId, unlocked: result.unlocked,
    note: 'Reservation released. Inspect the checkout and repair dependencies or checks before using the updated bridge.' };
}
