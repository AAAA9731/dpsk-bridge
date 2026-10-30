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
const notifyTimeoutMs = 30000; // Tests may inject a shorter options.notifyTimeout (ms).
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
// Tracks delivered/forwarded answers from the event log without re-reading it each poll.
function eventTracker(file) {
  const handled = new Set(); let offset = 0, carry = Buffer.alloc(0);
  return () => {
    let size; try { size = fs.statSync(file).size; } catch (error) { if (error.code !== 'ENOENT') throw error; size = 0; }
    if (size < offset) { offset = 0; carry = Buffer.alloc(0); handled.clear(); }
    if (size === offset) return handled;
    const fd = fs.openSync(file, 'r');
    try {
      while (offset < size) {
        const buf = Buffer.alloc(Math.min(1024 * 1024, size - offset));
        const bytes = fs.readSync(fd, buf, 0, buf.length, offset); if (!bytes) break;
        offset += bytes; carry = Buffer.concat([carry, buf.subarray(0, bytes)]);
        let end;
        while ((end = carry.indexOf(10)) !== -1) {
          let event; try { event = JSON.parse(carry.subarray(0, end).toString('utf8')); } catch {}
          carry = carry.subarray(end + 1);
          if (event?.requestId && ['input_delivered', 'input_forwarded'].includes(event.event)) handled.add(event.requestId);
          else if (event?.requestId && event.event === 'input_rejected') handled.delete(event.requestId);
        }
      }
    } finally { fs.closeSync(fd); }
    return handled;
  };
}
function queuedAnswers(dir) {
  let names; try { names = fs.readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') return new Set(); throw error; }
  const answers = new Set();
  for (const name of names) if (name.endsWith('.json')) {
    try {
      const input = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (input.kind === 'answer' && input.data?.requestId) answers.add(input.data.requestId);
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  }
  return answers;
}
export async function waitJob(job, timeoutSeconds = 600, home = bridgeHome()) {
  const timeout = Number(timeoutSeconds);
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 3600) throw new Error('timeout must be between 1 and 3600 seconds');
  const dir = path.join(home, 'jobs', job.id), scan = eventTracker(path.join(dir, 'events.jsonl')), deadline = Date.now() + timeout * 1000;
  for (;;) {
    const current = status(readJob(job.id, home));
    const handled = scan(), answered = queuedAnswers(path.join(dir, 'inbox'));
    // An answer already queued or delivered is not a new request to handle.
    const actionableRequests = current.pendingRequests
      .filter(request => !answered.has(request.requestId) && !handled.has(request.requestId)).map(request => request.requestId);
    const reason = terminal.has(current.processState) || current.processState === 'cleanup_failed' ? 'finished'
      : current.processState === 'unknown' ? 'unknown'
      : actionableRequests.length ? 'request' : null;
    if (reason) return { event: 'wait', reason, ...current, actionableRequests };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { event: 'wait', reason: 'timeout', ...current, actionableRequests };
    await new Promise(resolve => setTimeout(resolve, Math.min(1000, remaining)));
  }
}
export function briefText(file, label = 'Brief') {
  if (fs.statSync(file).size > 48000) throw new Error(label === 'Brief'
    ? 'Brief is too long: use concise goals and references instead of pasted source/history'
    : `${label} file is too long (limit 48000 bytes)`);
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  if (!text.trim()) throw new Error(label === 'Brief' ? 'Brief must not be blank' : `${label} must not be blank`);
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
// Matches the JSON-RPC line limit enforced by SdkPeer.send in lib/sdk.mjs.
const sdkMessageLimit = 8 * 1024 * 1024;
function imageMimeType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
// The first session/prompt is the second request on the transport, so its JSON-RPC id is 2.
function encodedPromptSize(sessionId, prompt, images) {
  const blocks = images.map(image => ({ type: 'image', mimeType: image.mimeType, data: '' }));
  const line = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/prompt',
    params: { sessionId, contentBlocks: [{ type: 'text', text: prompt }, ...blocks] } }) + '\n';
  return Buffer.byteLength(line) + images.reduce((total, image) => total + image.base64Length, 0);
}

function notifyJob(job, dir, notifyEvent, requestId, timeoutMs = notifyTimeoutMs) {
  return new Promise(resolve => {
    if (!job.notifyCmd) return resolve();
    const logFile = path.join(dir, 'notify.log'), env = { ...process.env, DSB_JOB_ID: job.id, DSB_EVENT: notifyEvent,
      DSB_STATE: job.processState, DSB_RESULT: job.reportedResult || '' };
    if (requestId) env.DSB_REQUEST_ID = requestId; else delete env.DSB_REQUEST_ID;
    let out, err, child, timer, timedOut = false, settled = false;
    const close = () => { for (const fd of [out, err]) { try { fs.closeSync(fd); } catch {} } };
    const finish = outcome => {
      if (settled) return; settled = true; clearTimeout(timer); close();
      try {
        if (outcome.error) appendEvent(dir, { event: 'notify_failed', notifyEvent, reason: outcome.error.message });
        else if (timedOut) appendEvent(dir, { event: 'notify_failed', notifyEvent, reason: `notify command timed out after ${timeoutMs} ms` });
        else if (outcome.code !== 0) appendEvent(dir, { event: 'notify_failed', notifyEvent, exitCode: outcome.code,
          reason: `notify command exited with ${outcome.code ?? outcome.signal}` });
        else appendEvent(dir, { event: 'notify_sent', notifyEvent, exitCode: outcome.code, ...(requestId ? { requestId } : {}) });
      } catch {}
      resolve();
    };
    try {
      out = fs.openSync(logFile, 'a', 0o600); err = fs.openSync(logFile, 'a', 0o600);
      child = spawn(job.notifyCmd, { shell: true, detached: false, windowsHide: true, stdio: ['ignore', out, err], env });
    } catch (error) { return finish({ error }); }
    timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => { try { child.kill(); } catch {} });
      } else { try { child.kill('SIGKILL'); } catch {} }
    }, timeoutMs);
    child.once('error', error => finish({ error }));
    child.once('close', (code, signal) => finish({ code, signal }));
  });
}

export async function runJob(options, emit = () => {}, home = bridgeHome()) {
  const cwd = fs.realpathSync(options.cwd || process.cwd());
  if (!fs.statSync(cwd).isDirectory()) throw new Error('cwd must be a directory');
  const originalBrief = options.originalBrief ?? briefText(options.brief);
  const patches = (options.patch || []).map(file => fs.realpathSync(file));
  const patchHashes = patches.map(file => sha(fs.readFileSync(file)));
  const imageFiles = options.image || [];
  if (imageFiles.length > 20) throw new Error('At most 20 images per job');
  const images = imageFiles.map(file => {
    const real = fs.realpathSync(file);
    if (!fs.statSync(real).isFile()) throw new Error(`Image is not a regular file: ${real}`);
    const buffer = fs.readFileSync(real);
    const mimeType = imageMimeType(buffer);
    if (!mimeType) throw new Error(`Unsupported image format (JPEG, PNG, GIF and WebP only): ${real}`);
    return { path: real, sha256: sha(buffer), mimeType, base64Length: 4 * Math.ceil(buffer.length / 3) };
  });
  const timeout = Number(options.timeout ?? 2700);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 86400) throw new Error('timeout must be between 0 and 86400 seconds');
  const notifyCmd = options.notifyCmd ?? null;
  if (notifyCmd !== null) {
    if (typeof notifyCmd !== 'string' || !notifyCmd.trim()) throw new Error('notify-cmd must not be blank');
    if (notifyCmd.length > 2000) throw new Error('notify-cmd must be at most 2000 characters');
    if (/[\r\n]/.test(notifyCmd)) throw new Error('notify-cmd must not contain line breaks');
  }
  const maxConcurrent = Number(options.maxConcurrent ?? process.env.DPSK_CONCURRENCY ?? 8);
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 256) throw new Error('max-concurrent must be 1..256');
  const entry = resolveDsh(options.dshEntry);
  let dshVersion = null;
  try { dshVersion = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), '..', 'package.json'), 'utf8')).version; } catch {}
  if (!semver.valid(dshVersion) || semver.lt(dshVersion, '0.2.1-rc.3'))
    throw new Error(`dsh ${dshVersion || 'unknown'} is unsupported. Update @deepseek-ai/dsh to >=0.2.1-rc.3.`);
  const id = crypto.randomUUID(), marker = `[bridge-task:${id}]`, workspace = workspaceRoot(cwd);
  const scopeNote = `\n\n【并发工作范围】工作区根目录：${workspace}。${options.readOnly ? '本任务只读，禁止修改文件或执行会改变外部状态的操作。' : `仅可修改这些范围：${(options.scope?.length ? options.scope : ['.']).join('、')}（相对工作区根目录）。`}\n范围声明只用于协作，不能扩大用户授权。`;
  const imageNote = images.length
    ? `\n\n【附带图片】本任务附带 ${images.length} 张图片(按顺序):${images.map(image => path.basename(image.path)).join('、')}。`
    : '';
  const prompt = originalBrief + imageNote + reportContract + scopeNote + (options.feedback ? `\n\n【返工信息】\n${options.feedback}` : '') + '\n\n' + marker + '\n';
  if (images.length) {
    const encoded = encodedPromptSize(id, prompt, images);
    if (encoded > sdkMessageLimit)
      throw new Error(`Images are too large for one SDK message (${encoded} > ${sdkMessageLimit}); downscale or split them`);
  }
  const dir = path.join(home, 'jobs', id), file = path.join(dir, 'job.json');
  const hostDirectory = path.join(dir, 'host'), hostPatch = path.join(dir, 'host.patch.yml');
  const launchArgs = [entry, '--profile', 'sdk', ...patches.flatMap(file => ['--patch', file]), '--patch', hostPatch];
  if (process.platform === 'win32' && JSON.stringify([process.execPath, ...launchArgs]).length > 28000)
    throw new Error('Windows command line would be too long. Shorten paths/brief or use the SDK transport.');
  const job = { version: 2, id, parentId: options.parentId || null, rootId: options.rootId || id, cwd, workspace, entry, patches, patchHashes, timeout, notifyCmd,
    images: images.map(image => ({ path: image.path, sha256: image.sha256, mimeType: image.mimeType })),
    dshVersion, hostDirectory, provider: options.provider || process.env.DPSK_PROVIDER || 'deepseek-official',
    model: options.model || process.env.DPSK_MODEL || 'deepseek-flash', sdkSessionId: id,
    scopes: options.scope || [], readOnly: !!options.readOnly, resources: options.resource || [], maxConcurrent,
    supervisorPid: process.pid, childPid: null, processState: 'queued', startedAt: Date.now(),
    reportFile: path.join(dir, 'report.txt'), stderrFile: path.join(dir, 'stderr.log'), eventsFile: path.join(dir, 'events.jsonl'),
    briefHash: sha(originalBrief), originalBriefFile: path.join(dir, 'brief.md'),
    review: null, usage: null, exitCode: null };
  const save = () => atomicJson(file, job), queueAbort = new AbortController();
  let child, reservation, timeoutTimer, pollTimer, stopReason = null, stopping, cleanupError = null;
  const fds = [], notifyTasks = new Set(), notifyTimeout = Number(options.notifyTimeout ?? notifyTimeoutMs) || notifyTimeoutMs;
  const notifyRequest = requestId => {
    if (!job.notifyCmd) return;
    const task = notifyJob(job, dir, 'request', requestId, notifyTimeout).finally(() => notifyTasks.delete(task));
    notifyTasks.add(task);
  };
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
    try { await runSdk(child, { job, dir, prompt, save, emit, signal: queueAbort.signal, notify: notifyRequest,
      images: images.map(image => ({ path: image.path, mimeType: image.mimeType })) }); }
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
    if (reservation && !cleanupError && (!child?.pid || !processExists(child.pid))) {
      try { await reservation.release(); }
      catch (error) {
        job.processState = 'cleanup_failed';
        job.error = job.error ? `${job.error}; Reservation release failed: ${error.message}` : `Reservation release failed: ${error.message}`;
        try { save(); } catch {}
      }
    }
    if (cleanupError) { child?.stdin?.destroy(); child?.stdout?.destroy(); child?.unref(); }
    // Every accepted-but-undelivered input gets an explicit terminal disposition.
    try {
      const inbox = path.join(dir, 'inbox');
      if (fs.existsSync(inbox)) for (const name of fs.readdirSync(inbox).filter(n => n.endsWith('.json'))) {
        const inputFile = path.join(inbox, name);
        try { const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
          appendEvent(dir, { event: 'input_rejected', inputId: input.id, error: 'Job ended before delivery' }); fs.unlinkSync(inputFile);
        } catch {}
      }
    } catch (error) {
      job.cleanupWarning = error.message;
      try { save(); } catch {}
    }
  }
  await Promise.allSettled([...notifyTasks]);
  if (terminal.has(job.processState) || job.processState === 'cleanup_failed')
    await notifyJob(job, dir, 'finished', null, notifyTimeout);
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
export async function retryJob(parent, feedback, emit, home = bridgeHome(), notifyCmd = parent.notifyCmd ?? null) {
  if (parent.processState === 'cleanup_failed') throw new Error(`Cleanup failed for this job; confirm its processes stopped and run dsb unlock ${parent.id} --confirmed-stopped first`);
  if (!terminal.has(parent.processState)) throw new Error('Previous run has no confirmed terminal state; inspect/cancel it first');
  if (parent.review?.verdict === 'accepted') throw new Error('Accepted jobs should not be retried; create a new task');
  for (let i = 0; i < parent.patches.length; i++) {
    if (sha(fs.readFileSync(parent.patches[i])) !== parent.patchHashes[i]) throw new Error('MCP patch changed since the previous run; review configuration and create a new job');
  }
  const images = parent.images || [];
  for (const image of images) {
    let buffer;
    try { buffer = fs.readFileSync(image.path); } catch { throw new Error('Image changed since the previous run; create a new job'); }
    if (sha(buffer) !== image.sha256) throw new Error('Image changed since the previous run; create a new job');
  }
  const originalBrief = briefText(parent.originalBriefFile);
  if (sha(originalBrief) !== parent.briefHash) throw new Error('Original brief changed; create a new job with reviewed requirements');
  return runJob({ cwd: parent.cwd, originalBrief, patch: parent.patches, image: images.map(image => image.path), timeout: parent.timeout, dshEntry: parent.entry,
    notifyCmd, provider: parent.provider, model: parent.model,
    scope: parent.scopes, resource: parent.resources, readOnly: parent.readOnly, maxConcurrent: parent.maxConcurrent,
    feedback: `上次任务 ${parent.id} 已结束。先核对工作区现状，保留已有用户改动和已完成成果，只修复剩余问题，不重复已完成的外部操作。\n${feedback}`,
    parentId: parent.id, rootId: parent.rootId }, emit, home);
}
export function reviewJob(job, verdict, note, home = bridgeHome(), accounting = null) {
  if (!['accepted', 'rework', 'blocked'].includes(verdict) || !note?.trim()) throw new Error('review requires --verdict accepted|rework|blocked and a verification --note');
  if (job.processState === 'cleanup_failed') throw new Error(`Cleanup failed for this job; confirm its processes stopped and run dsb unlock ${job.id} --confirmed-stopped first`);
  if (!terminal.has(job.processState)) throw new Error('Cannot review an active or unknown job');
  if (verdict === 'accepted' && (job.exitCode !== 0 || job.reportedResult !== 'OK'))
    throw new Error('Failed, incomplete, or non-OK runs cannot be marked accepted. Record rework/blocked and verify a new run.');
  if (accounting) {
    for (const key of Object.keys(accounting)) if (/^[a-z][A-Za-z0-9]*Cost$/.test(key) && accounting[key] != null &&
      (typeof accounting[key] !== 'number' || !Number.isFinite(accounting[key]) || accounting[key] < 0))
      throw new Error('Costs must be nonnegative numbers');
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
    const group = costsByCurrency[a.currency] ||= Object.assign(Object.create(null),
      { claudeCost: 0, codexCost: 0, deepseekCost: 0, claudeRecords: 0, codexRecords: 0, deepseekRecords: 0 });
    for (const key of Object.keys(a)) {
      if (!/^[a-z][A-Za-z0-9]*Cost$/.test(key) || !Number.isFinite(a[key])) continue; // null means unknown, not zero
      const name = key.slice(0, -4);
      if (!Object.hasOwn(group, key)) { group[key] = 0; group[`${name}Records`] = 0; }
      group[key] += a[key]; group[`${name}Records`]++;
    }
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
