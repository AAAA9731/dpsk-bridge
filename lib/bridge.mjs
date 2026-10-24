import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { matchSession, tokenKeys, collectUsage, readEvents } from './sessions.mjs';
import { runSdk, appendEvent, queueInput, eventsPage } from './live.mjs';
import { acquireSlot, releaseReservation } from './scheduler.mjs';
import semver from 'semver';
import { fileURLToPath } from 'node:url';

export const bridgeHome = () => path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'bridge');
const terminal = new Set(['completed', 'failed', 'timed_out', 'cancelled', 'launch_failed']);
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
export function atomicJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export function readJob(id, home = bridgeHome()) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Use the complete job ID returned by dsb run');
  const job = JSON.parse(fs.readFileSync(path.join(home, 'jobs', id, 'job.json'), 'utf8'));
  if (job.version !== 2) throw new Error('Unsupported job format; start a new job with the current bridge');
  return job;
}
export function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
export function status(job) {
  const knownEnd = terminal.has(job.processState) || job.processState === 'cleanup_failed';
  return { id: job.id, parentId: job.parentId, processState: knownEnd ? job.processState :
    (processExists(job.supervisorPid) ? job.processState : 'unknown'),
    acceptance: job.review?.verdict || 'unreviewed', exitCode: job.exitCode ?? null,
    reportedResult: job.reportedResult ?? null, cwd: job.cwd,
    startedAt: job.startedAt, finishedAt: job.finishedAt ?? null,
    reportFile: job.reportFile, stderrFile: job.stderrFile,
    sessionId: job.sdkSessionId, provider: job.provider, model: job.model,
    pendingRequests: job.pendingRequests || [], eventsFile: job.eventsFile };
}
export function briefText(file) {
  if (fs.statSync(file).size > 48000) throw new Error('Brief is too long: use concise goals and references instead of pasted source/history');
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  if (!text.trim()) throw new Error('Brief must not be blank');
  return text;
}
export function reportState(report) {
  return /^RESULT:\s*(OK|FAIL|BLOCKED)(?=\s|$)/.exec(report.trimStart())?.[1] || 'UNKNOWN';
}
function git(cwd, args) {
  return spawnSync('git', ['-c', `safe.directory=${cwd}`, ...args], {
    cwd, windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024,
  });
}
function workspaceRoot(cwd) {
  const result = git(cwd, ['rev-parse', '--show-toplevel']);
  return result.status === 0 ? fs.realpathSync(result.stdout.trim()) : cwd;
}
function baseline(cwd) {
  const result = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  return { capturedAt: Date.now(), available: result.status === 0, status: result.status === 0 ? result.stdout : null,
    note: 'Inventory only, not a backup or attribution of pre-existing changes.' };
}
export function resolveDsh(entry) {
  const candidates = entry ? [path.resolve(entry)] : (process.env.PATH || '').split(path.delimiter).filter(Boolean)
    .flatMap(dir => [path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      path.join(dir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')]);
  for (const file of candidates) {
    try { if (fs.statSync(file).isFile()) return fs.realpathSync(file); } catch {}
  }
  throw new Error('Cannot locate dsh. Install @deepseek-ai/dsh or pass --dsh-entry /path/to/dsh/lib/bin.js');
}
const reportContract = `\n\n【桥接报告约定】保留上述用户目标、范围与验收条件。自行调查实现，不需要主代理预先写好代码。\n最终报告第一行写 RESULT: OK|FAIL|BLOCKED；未验证的条件必须注明，不能当作通过。\n随后用约 15 行给出结论、改动/证据位置、验证命令与退出码、未验证项或阻塞原因；详细日志给路径。\n不要把整个执行过程或源码粘回报告。不要扩大用户授权；需要澄清时使用可用的提问工具向宿主询问并等待回复。目标冲突或必须扩大范围时停止并说明。`;

export async function runJob(options, emit = () => {}, home = bridgeHome()) {
  const cwd = fs.realpathSync(options.cwd || process.cwd());
  if (!fs.statSync(cwd).isDirectory()) throw new Error('cwd must be a directory');
  const originalBrief = options.originalBrief ?? briefText(options.brief);
  const patches = (options.patch || []).map(file => fs.realpathSync(file));
  const patchHashes = patches.map(file => sha(fs.readFileSync(file)));
  const timeout = Number(options.timeout ?? 2700);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 86400) throw new Error('timeout must be between 0 and 86400 seconds');
  const maxConcurrent = Number(options.maxConcurrent ?? process.env.DPSK_CONCURRENCY ?? 8);
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 256) throw new Error('max-concurrent must be 1..256');
  const entry = resolveDsh(options.dshEntry);
  let dshVersion = null;
  try { dshVersion = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), '..', 'package.json'), 'utf8')).version; } catch {}
  if (!semver.valid(dshVersion) || semver.lt(dshVersion, '0.2.1-rc.2'))
    throw new Error(`dsh ${dshVersion || 'unknown'} is unsupported. Update @deepseek-ai/dsh to >=0.2.1-rc.2.`);
  const id = crypto.randomUUID(), marker = `[bridge-task:${id}]`, workspace = workspaceRoot(cwd);
  const scopeNote = `\n\n【并发工作范围】工作区根目录：${workspace}。${options.readOnly ? '本任务只读，禁止修改文件或执行会改变外部状态的操作。' : `仅可修改这些范围：${(options.scope?.length ? options.scope : ['.']).join('、')}（相对工作区根目录）。`}\n范围声明只用于协作，不能扩大用户授权。`;
  const prompt = originalBrief + reportContract + scopeNote + (options.feedback ? `\n\n【返工信息】\n${options.feedback}` : '') + '\n\n' + marker + '\n';
  const dir = path.join(home, 'jobs', id), file = path.join(dir, 'job.json');
  const hostDirectory = path.join(dir, 'host'), hostPatch = path.join(dir, 'host.patch.yml');
  const launchArgs = [entry, '--profile', 'sdk', ...patches.flatMap(file => ['--patch', file]), '--patch', hostPatch];
  if (process.platform === 'win32' && JSON.stringify([process.execPath, ...launchArgs]).length > 28000)
    throw new Error('Windows command line would be too long. Shorten paths/brief or use the SDK transport.');
  const job = { version: 2, id, parentId: options.parentId || null, rootId: options.rootId || id, cwd, workspace, entry, patches, patchHashes, timeout,
    dshVersion, hostDirectory, provider: options.provider || process.env.DPSK_PROVIDER || 'deepseek-official',
    model: options.model || process.env.DPSK_MODEL || 'deepseek-v4-flash', sdkSessionId: id,
    scopes: options.scope || [], readOnly: !!options.readOnly, resources: options.resource || [], maxConcurrent,
    supervisorPid: process.pid, childPid: null, processState: 'queued', startedAt: Date.now(),
    reportFile: path.join(dir, 'report.txt'), stderrFile: path.join(dir, 'stderr.log'), eventsFile: path.join(dir, 'events.jsonl'),
    briefHash: sha(originalBrief), originalBriefFile: path.join(dir, 'brief.md'),
    review: null, usage: null, exitCode: null };
  const save = () => atomicJson(file, job), queueAbort = new AbortController();
  let child, reservation, timeoutTimer, pollTimer, stopReason = null, stopping, cleanupError = null;
  const fds = [];
  const stop = reason => {
    stopReason ||= reason; queueAbort.abort(new Error(reason));
    if (stopping || !child?.pid) return stopping;
    stopping = new Promise(resolve => {
      const failed = message => { cleanupError = message; resolve(); };
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        const deadline = setTimeout(() => { killer.kill(); failed('Process-tree cleanup timed out; reservation retained.'); }, 10000);
        killer.once('error', error => { clearTimeout(deadline); failed(`Process-tree cleanup failed: ${error.message}`); });
        killer.once('close', code => { clearTimeout(deadline);
          if (code !== 0 && processExists(child.pid)) failed('Process-tree cleanup failed; reservation retained.'); else resolve();
        });
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL'); } catch {}
          if (processExists(child.pid)) failed('Process-tree cleanup failed; reservation retained.'); else resolve();
        }, 1500);
      }
    });
    return stopping;
  };
  const onSignal = () => { void stop('cancelled'); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  try {
    fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
    fs.mkdirSync(path.join(hostDirectory, 'requests'), { recursive: true });
    fs.mkdirSync(path.join(hostDirectory, 'responses'), { recursive: true });
    fs.mkdirSync(path.join(hostDirectory, 'cancelled'), { recursive: true });
    fs.writeFileSync(hostPatch, `- insert:\n    - id: dpsk-bridge-host\n      name: ${JSON.stringify(fileURLToPath(new URL('./host-plugin.mjs', import.meta.url)))}\n      config:\n        directory: ${JSON.stringify(hostDirectory)}\n    - id: dpsk-tool-ask-user\n      name: '@deepseek-ai/dsh-tool-ask-user'\n      config:\n        mode: legacy\n`, { mode: 0o600 });
    fs.writeFileSync(job.originalBriefFile, originalBrief, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'prompt.txt'), prompt, { mode: 0o600 });
    fs.writeFileSync(job.reportFile, '', { mode: 0o600 });
    fs.writeFileSync(job.eventsFile, '', { mode: 0o600 });
    if (options.feedback) fs.writeFileSync(path.join(dir, 'feedback.md'), options.feedback, { mode: 0o600 });
    save(); emit({ event: 'queued', ...status(job) });
    timeoutTimer = setTimeout(() => { void stop('timed_out'); }, timeout * 1000);
    pollTimer = setInterval(() => { if (fs.existsSync(path.join(dir, 'cancel.request'))) void stop('cancelled'); }, 100);
    reservation = await acquireSlot({ home, id, workspace, scopes: job.scopes,
      readOnly: job.readOnly, resources: job.resources, maxConcurrent, signal: queueAbort.signal });
    job.lockFile = reservation.lockFile; job.processState = 'starting'; save();
    if (stopReason) throw new Error(stopReason);
    atomicJson(path.join(dir, 'baseline.json'), baseline(cwd));
    const stderr = fs.openSync(job.stderrFile, 'w', 0o600);
    fds.push(stderr);
    child = spawn(process.execPath, launchArgs, { cwd, stdio: ['pipe', 'pipe', stderr],
      windowsHide: true, detached: process.platform !== 'win32', env: process.env });
    const outcomePromise = new Promise(resolve => {
      child.once('error', error => resolve({ code: null, error: error.message }));
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    job.childPid = child.pid ?? null; job.processState = 'running'; save();
    if (child.pid) await reservation.setChildPid(child.pid);
    emit({ event: 'started', ...status(job) });
    let sdkError = null;
    try { await runSdk(child, { job, dir, prompt, save, emit, signal: queueAbort.signal }); }
    catch (error) { sdkError = error; await stop(stopReason || 'failed'); }
    // Bound a runtime that acknowledges shutdown but keeps handles alive.
    let shutdownDeadline;
    if (!stopping) shutdownDeadline = setTimeout(() => { void stop('failed'); }, 10000);
    const outcome = await Promise.race([outcomePromise, new Promise(resolve => {
      const check = setInterval(() => { if (cleanupError) { clearInterval(check); resolve({ code: null, error: cleanupError }); } }, 100);
      outcomePromise.finally(() => clearInterval(check));
    })]);
    clearTimeout(shutdownDeadline);
    if (stopping) await stopping;
    job.exitCode = outcome.code; job.signal = outcome.signal || null;
    job.processState = cleanupError ? 'cleanup_failed' : stopReason || (outcome.error ? 'launch_failed' : outcome.code === 0 ? 'completed' : 'failed');
    if (sdkError || outcome.error) job.error = sdkError?.message || outcome.error;
    job.finishedAt = Date.now();
    job.reportedResult = reportState(readPrefix(job.reportFile, 8192));
    job.pendingRequests = [];
    job.session = matchSession(path.join(path.dirname(home), 'sessions'), marker, job.startedAt);
    try { job.usage = collectUsage(readEvents(path.join(dir, 'root.session.jsonl')).events); }
    catch (error) { job.usage = { available: false, reason: error.message }; }
    atomicJson(path.join(dir, 'after.json'), baseline(cwd)); save();
  } catch (error) {
    if (child?.pid && processExists(child.pid)) await stop(stopReason || 'failed');
    job.processState = cleanupError ? 'cleanup_failed' : stopReason || 'failed';
    job.error = error.message; job.finishedAt = Date.now();
    job.reportedResult = 'UNKNOWN'; save();
  } finally {
    clearTimeout(timeoutTimer); clearInterval(pollTimer);
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    fds.forEach(fd => { try { fs.closeSync(fd); } catch {} });
    if (reservation && !cleanupError && (!child?.pid || !processExists(child.pid))) await reservation.release();
    if (cleanupError) { child?.stdin?.destroy(); child?.stdout?.destroy(); child?.unref(); }
    // Every accepted-but-undelivered input gets an explicit terminal disposition.
    const inbox = path.join(dir, 'inbox');
    if (fs.existsSync(inbox)) for (const name of fs.readdirSync(inbox).filter(n => n.endsWith('.json'))) {
      const inputFile = path.join(inbox, name);
      try { const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
        appendEvent(dir, { event: 'input_rejected', inputId: input.id, error: 'Job ended before delivery' }); fs.unlinkSync(inputFile);
      } catch {}
    }
  }
  return job;
}

export function readPrefix(file, bytes = 6000) {
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(bytes); return buf.subarray(0, fs.readSync(fd, buf, 0, bytes, 0)).toString('utf8'); }
  finally { fs.closeSync(fd); }
}
export function result(job) {
  return { ...status(job), error: job.error || null, report: readPrefix(job.reportFile),
    reportTruncated: fs.statSync(job.reportFile).size > 6000, usage: job.usage,
    verificationRequired: job.review?.verdict !== 'accepted' };
}
export async function retryJob(parent, feedback, emit, home = bridgeHome()) {
  if (!terminal.has(parent.processState)) throw new Error('Previous run has no confirmed terminal state; inspect/cancel it first');
  if (parent.review?.verdict === 'accepted') throw new Error('Accepted jobs should not be retried; create a new task');
  for (let i = 0; i < parent.patches.length; i++) {
    if (sha(fs.readFileSync(parent.patches[i])) !== parent.patchHashes[i]) throw new Error('MCP patch changed since the previous run; review configuration and create a new job');
  }
  const originalBrief = briefText(parent.originalBriefFile);
  if (sha(originalBrief) !== parent.briefHash) throw new Error('Original brief changed; create a new job with reviewed requirements');
  return runJob({ cwd: parent.cwd, originalBrief, patch: parent.patches, timeout: parent.timeout, dshEntry: parent.entry,
    provider: parent.provider, model: parent.model,
    scope: parent.scopes, resource: parent.resources, readOnly: parent.readOnly, maxConcurrent: parent.maxConcurrent,
    feedback: `上次任务 ${parent.id} 已结束。先核对工作区现状，保留已有用户改动和已完成成果，只修复剩余问题，不重复已完成的外部操作。\n${feedback}`,
    parentId: parent.id, rootId: parent.rootId }, emit, home);
}
export function reviewJob(job, verdict, note, home = bridgeHome(), accounting = null) {
  if (!['accepted', 'rework', 'blocked'].includes(verdict) || !note?.trim()) throw new Error('review requires --verdict accepted|rework|blocked and a verification --note');
  if (!terminal.has(job.processState)) throw new Error('Cannot review an active or unknown job');
  if (verdict === 'accepted' && (job.exitCode !== 0 || job.reportedResult !== 'OK'))
    throw new Error('Failed, incomplete, or non-OK runs cannot be marked accepted. Record rework/blocked and verify a new run.');
  if (accounting) {
    for (const key of ['claudeCost', 'codexCost', 'deepseekCost']) if (accounting[key] != null && (!Number.isFinite(accounting[key]) || accounting[key] < 0)) throw new Error('Costs must be nonnegative numbers');
    if (typeof accounting.currency !== 'string' || !accounting.currency || typeof accounting.source !== 'string' || !accounting.source)
      throw new Error('Accounting requires currency and source; omit unknown costs rather than using zero');
  }
  job.review = { verdict, note, at: Date.now() };
  if (accounting) job.accounting = accounting;
  atomicJson(path.join(home, 'jobs', job.id, 'job.json'), job);
  return status(job);
}
export function cancelJob(job, home = bridgeHome()) {
  if (terminal.has(job.processState)) return { ...status(job), cancelRequested: false };
  if (job.processState === 'cleanup_failed') throw new Error('Cleanup already failed; inspect recorded processes before recovery');
  if (!processExists(job.supervisorPid)) throw new Error('Supervisor is gone; inspect the recorded child process and workspace before recovery');
  fs.writeFileSync(path.join(home, 'jobs', job.id, 'cancel.request'), 'cancel\n', { mode: 0o600 });
  return { ...status(job), cancelRequested: true, note: 'Request queued; wait for a terminal state before retrying.' };
}
export async function unlockJob(job, confirmedStopped, home = bridgeHome()) {
  if (!confirmedStopped) throw new Error('Confirm the old task and its child processes stopped, then use --confirmed-stopped');
  if (processExists(job.supervisorPid) || processExists(job.childPid)) throw new Error('A recorded process is still present; do not unlock');
  await releaseReservation(home, job.id, { confirmedStopped: true });
  return { id: job.id, unlocked: true, note: 'Inspect partial changes before creating a new run; unknown runs are not automatically retried.' };
}
export function sendMessage(job, text, home = bridgeHome()) {
  if (!text?.trim()) throw new Error('Message must not be blank');
  if (!processExists(job.supervisorPid)) throw new Error('Supervisor is no longer present; inspect this job before recovery');
  return queueInput(job, 'message', { text }, home);
}
export function answerRequest(job, requestId, answer, home = bridgeHome()) {
  if (!requestId || !job.pendingRequests?.some(r => r.requestId === requestId)) throw new Error('Use a pending requestId from status/events');
  if (!processExists(job.supervisorPid)) throw new Error('Supervisor is no longer present');
  return queueInput(job, 'answer', { requestId, answer }, home);
}
export { eventsPage };
export function stats(home = bridgeHome()) {
  let ids; try { ids = fs.readdirSync(path.join(home, 'jobs')); } catch { ids = []; }
  const jobs = []; let unreadableJobs = 0;
  for (const id of ids) { try { jobs.push(readJob(id, home)); } catch { unreadableJobs++; } }
  const tokens = Object.fromEntries(tokenKeys.map(key => [key, 0]));
  const tokenRecords = Object.fromEntries(tokenKeys.map(key => [key, 0]));
  const costsByCurrency = Object.create(null);
  for (const job of jobs) {
    for (const key of tokenKeys) {
      const value = job.usage?.tokens?.[key];
      if (Number.isSafeInteger(value) && value >= 0) { tokens[key] += value; tokenRecords[key]++; }
    }
    const a = job.accounting;
    if (!a) continue;
    const group = costsByCurrency[a.currency] ||= { claudeCost: 0, codexCost: 0, deepseekCost: 0, claudeRecords: 0, codexRecords: 0, deepseekRecords: 0 };
    for (const model of ['claude', 'codex', 'deepseek']) if (a[model + 'Cost'] != null) { group[model + 'Cost'] += a[model + 'Cost']; group[model + 'Records']++; }
  }
  return { jobs: jobs.length, unreadableJobs, tasks: new Set(jobs.map(j => j.rootId)).size,
    retries: jobs.filter(j => j.parentId).length,
    acceptedTasks: new Set(jobs.filter(j => j.review?.verdict === 'accepted').map(j => j.rootId)).size,
    acceptedFirstAttempts: jobs.filter(j => !j.parentId && j.review?.verdict === 'accepted').length,
    usageRecords: jobs.filter(j => j.usage?.available).length, missingUsageRecords: jobs.filter(j => !j.usage?.available).length,
    observedSessionTokens: Object.fromEntries(tokenKeys.map(key => [key, tokenRecords[key] && Number.isSafeInteger(tokens[key]) ? tokens[key] : null])),
    tokenRecords, missingTokenRecords: Object.fromEntries(tokenKeys.map(key => [key, jobs.length - tokenRecords[key]])), costsByCurrency,
    note: 'Usage covers matched parent sessions only; missing samples/child sessions may be billed. Costs are supplied records, not inferred from tokens. Savings need a comparable baseline using the same host without delegation.' };
}
