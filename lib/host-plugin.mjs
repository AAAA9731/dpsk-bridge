import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const name = 'dpsk-bridge-host';
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function invalid(message, code) {
  const error = new TypeError(message); error.code = code; return error;
}
function aborted(signal) {
  const error = new Error('Host interaction was cancelled', { cause: signal.reason });
  error.name = 'AbortError'; error.code = 'ASK_ABORTED'; return error;
}
function throwIfAborted(signal) { if (signal.aborted) throw aborted(signal); }
function wait(signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer); signal.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve();
    };
    const cancel = () => finish(aborted(signal));
    const timer = setTimeout(() => finish(), 100);
    signal.addEventListener('abort', cancel, { once: true });
  });
}
async function atomicJson(file, value, signal) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      if (signal) throwIfAborted(signal);
      try { fs.renameSync(tmp, file); return; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 20) throw error;
        await sleep(Math.min(10 * (attempt + 1), 100));
      }
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
async function remove(file) {
  for (let attempt = 0; ; attempt++) {
    try { fs.unlinkSync(file); return; }
    catch (error) {
      if (error.code === 'ENOENT') return;
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 10) throw error;
      await sleep(20);
    }
  }
}
function parseAnswer(value, questionIds) {
  const bad = () => invalid('Host must answer each question id exactly once with selected labels and optional custom text', 'BAD_ANSWER');
  if (!isRecord(value) || !Array.isArray(value.answers)) throw bad();
  const answers = value.answers.map(answer => {
    if (!isRecord(answer) || typeof answer.id !== 'string' || !Array.isArray(answer.selected) ||
        !answer.selected.every(label => typeof label === 'string') || ('custom' in answer && typeof answer.custom !== 'string')) throw bad();
    return { id: answer.id, selected: [...answer.selected], ...('custom' in answer ? { custom: answer.custom } : {}) };
  });
  const ids = new Set(answers.map(answer => answer.id));
  if (ids.size !== answers.length || answers.length !== questionIds.length || !questionIds.every(id => ids.has(id))) throw bad();
  return { answers };
}
function parseApproval(value) {
  if (!isRecord(value) || !['allowed-once', 'rejected', 'cancelled'].includes(value.outcome))
    throw invalid('Host approval requires an allowed-once, rejected, or cancelled outcome', 'BAD_APPROVAL');
  return value.outcome;
}
function sessionIdFor(agent) {
  const id = agent?.session?.id;
  if (typeof id !== 'string' || !id) throw invalid('Host interaction requires the requesting agent session id', 'BAD_SESSION');
  return id;
}

/** Official dsh user-questions/request and approval/request waterfall answerer.
 * Register at the runtime root: requests from child agents retain their own
 * session identities. No services or SDK interactive capabilities are required.
 */
export function apply(ctx, config) {
  if (!isRecord(config) || typeof config.directory !== 'string' || !path.isAbsolute(config.directory) || config.directory.includes('\0') ||
      (process.platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(config.directory)))
    throw new TypeError('Host plugin directory must be an absolute filesystem path');
  const directory = path.resolve(config.directory);
  const lifetime = new AbortController(), pending = new Set();
  ctx.effect(() => {
    for (const part of ['', 'requests', 'responses', 'cancelled', 'receipts'])
      fs.mkdirSync(path.join(directory, part), { recursive: true, mode: 0o700 });
    return async () => {
      lifetime.abort(new Error('Host plugin disposed'));
      await Promise.allSettled([...pending]);
    };
  }, 'dpsk-bridge host mailbox');

  function track(task) {
    pending.add(task);
    task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  }
  async function forward(method, request, params, parse) {
    const requestId = randomUUID(), sessionId = sessionIdFor(request.agent);
    const requestFile = path.join(directory, 'requests', `${requestId}.json`);
    const responseFile = path.join(directory, 'responses', `${requestId}.json`);
    const signal = request.signal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, request.signal]);
    try {
      throwIfAborted(signal);
      await atomicJson(requestFile, { requestId, method, params: { requestId, sessionId, ...params } }, signal);
      for (;;) {
        throwIfAborted(signal);
        let text;
        try { text = fs.readFileSync(responseFile, 'utf8'); }
        catch (error) {
          if (!['ENOENT', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
          await wait(signal); continue;
        }
        let result;
        try { result = JSON.parse(text); }
        catch (error) { throw invalid(`Host response is not valid JSON: ${error.message}`, 'BAD_RESPONSE'); }
        throwIfAborted(signal);
        const accepted = parse(result);
        // This is the receipt boundary: the plugin validated and accepted the
        // answer. It does not promise the agent subsequently completed a tool.
        // Once committed, a later abort cannot retract this acknowledgement.
        await atomicJson(path.join(directory, 'receipts', `${requestId}.json`), {
          requestId, sessionId, outcome: 'consumed',
        }, signal);
        return accepted;
      }
    } catch (error) {
      if (signal.aborted) {
        await atomicJson(path.join(directory, 'cancelled', `${requestId}.json`), {
          requestId, sessionId, reason: String(signal.reason ?? 'cancelled'),
        });
        throw aborted(signal);
      }
      throw error;
    } finally {
      await Promise.all([remove(requestFile), remove(responseFile)]);
    }
  }
  ctx.on('user-questions/request', (request, next) => {
    if (!request.agent) return next();
    if (!Array.isArray(request.questions) || !request.questions.length ||
        request.questions.some(question => !isRecord(question) || typeof question.id !== 'string' || !question.id) ||
        new Set(request.questions.map(question => question.id)).size !== request.questions.length)
      return Promise.reject(invalid('Question requests require distinct nonempty question ids', 'BAD_QUESTIONS'));
    // Snapshot both the wire payload and the expected ids before awaiting host IO.
    const questions = JSON.parse(JSON.stringify(request.questions));
    return track(forward('user-question/ask', request, { questions }, value => parseAnswer(value, questions.map(question => question.id))));
  });
  ctx.on('approval/request', (request, next) => {
    if (!request.agent) return next();
    if (typeof request.toolName !== 'string' || !request.toolName ||
        (request.callId !== undefined && typeof request.callId !== 'string') ||
        (request.reason !== undefined && typeof request.reason !== 'string'))
      return Promise.reject(invalid('Approval requests require a toolName and optional string callId/reason', 'BAD_APPROVAL'));
    const params = { toolName: request.toolName, ...(request.callId === undefined ? {} : { callId: request.callId }),
      ...(request.reason === undefined ? {} : { reason: request.reason }) };
    return track(forward('approval/request', request, params, parseApproval).catch(error => {
      if (error.name === 'AbortError' && error.code === 'ASK_ABORTED') return 'cancelled';
      throw error;
    }));
  });
}
