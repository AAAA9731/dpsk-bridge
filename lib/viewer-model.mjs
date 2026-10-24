/** Pure chronological reading projection of current v4 session events. */

/** Group by last update, using local calendar days rather than 24-hour windows. */
export function groupSessionsByTime(sessions, now = Date.now()) {
  const day = time => { const date = new Date(time); return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000; };
  const today = day(now);
  const groups = [
    { key: 'today', label: '今天', sessions: [] }, { key: 'yesterday', label: '昨天', sessions: [] },
    { key: 'week', label: '近 7 天', sessions: [] }, { key: 'older', label: '更早', sessions: [] },
  ];
  for (const session of [...sessions].sort((a, b) => b.mtime - a.mtime)) {
    const age = today - day(session.mtime);
    groups[age <= 0 ? 0 : age === 1 ? 1 : age < 7 ? 2 : 3].sessions.push(session);
  }
  return groups.filter(group => group.sessions.length);
}

const string = value => typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2);
const pretty = value => {
  if (typeof value !== 'string') return string(value);
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
};
const contents = blocks => (Array.isArray(blocks) ? blocks : []).map(block =>
  block.type === 'text' || block.type === 'reasoning' ? string(block.text) : string(block)).join('\n');
const assistantText = event => (event.data?.message?.content || []).filter(block => block.type === 'text').map(block => string(block.text)).join('\n');

function identity(event) {
  if (event.seq !== undefined) return String(event.seq);
  if (event.data?.message?.id) return event.data.message.id;
  // Valid v4 events have seq; deterministic content identity also permits sparse
  // imported event objects without relying on a changing array position.
  let hash = 2166136261;
  for (const ch of JSON.stringify(event)) hash = Math.imul(hash ^ ch.codePointAt(0), 16777619);
  return `content-${(hash >>> 0).toString(16)}`;
}

function preview(value, columns = 100, sentences = 0) {
  let text = string(value).replace(/\s+/gu, ' ').trim();
  if (sentences) text = text.split(/(?<=[。！？!?])\s*|(?<=\.)\s+/u).slice(0, sentences).join(' ');
  let out = '', width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0), next = cp >= 0x1100 && (cp <= 0x115f || cp >= 0x2e80) ? 2 : 1;
    if (width + next > columns - 1) return out.trimEnd() + '…';
    width += next; out += ch;
  }
  return out;
}

/** Remove only the trailing bridge report instruction, retaining the user's brief. */
function briefText(text) {
  const matches = [...text.matchAll(/(?:^|\n)[\t ]*【桥接报告约定】/gu)];
  return matches.length ? text.slice(0, matches.at(-1).index).trimEnd() : text;
}

function feedbackText(text) {
  const contract = text.lastIndexOf('【桥接报告约定】'), feedback = text.lastIndexOf('【返工信息】');
  if (contract < 0 || feedback < contract) return '';
  return text.slice(feedback + '【返工信息】'.length).replace(/\n+\[bridge-task:[^\]\n]+\]\s*$/u, '').trim();
}

function relativePath(value, cwd) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\\/g, '/'), root = string(cwd).replace(/\\/g, '/').replace(/\/$/, '');
  const insensitive = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//');
  const compare = text => insensitive ? text.toLowerCase() : text;
  return root && compare(normalized).startsWith(compare(root) + '/') ? normalized.slice(root.length + 1) : normalized;
}

function argumentsOf(call) {
  try { return typeof call?.data?.arguments === 'string' ? JSON.parse(call.data.arguments) : call?.data?.arguments; }
  catch { return null; }
}

function toolSummary(call, cwd) {
  const args = argumentsOf(call);
  if (args && typeof args === 'object') {
    if (typeof args.description === 'string' && args.description.trim()) return preview(args.description);
    for (const key of ['file_path', 'path', 'filePath', 'target_file', 'targetPath']) {
      if (typeof args[key] === 'string' && args[key]) return preview(relativePath(args[key], cwd));
    }
    for (const key of ['command', 'cmd', 'script']) {
      if (typeof args[key] === 'string' && args[key].trim()) return preview(args[key].split(/\r?\n/).find(line => line.trim()) || '');
    }
  }
  return '执行工具';
}

function toolDetails(call, results) {
  const parts = [];
  if (call) parts.push(`工具：${call.data.name || '未知工具'}\n参数：\n${pretty(call.data.arguments)}`);
  for (const result of results) {
    const data = result.data || {}, message = data.message || {};
    parts.push(`结果：\n${contents(message.content)}`);
    if (data.error) parts.push(`错误信息：\n${string(data.error)}`);
    if (data.meta !== undefined) parts.push(`结果详情：\n${string(data.meta)}`);
  }
  return parts.join('\n\n');
}

function questionsOf(call) {
  const args = argumentsOf(call);
  if (!Array.isArray(args?.questions)) return '';
  return args.questions.map(question => {
    const prompt = string(question.question || question.title || question.header || question.id);
    const options = (Array.isArray(question.options) ? question.options : []).map(option => {
      if (typeof option === 'string') return `- ${option}`;
      return `- ${string(option.label || option.title)}${option.description ? `：${string(option.description)}` : ''}`;
    });
    return [prompt, ...options].join('\n');
  }).join('\n\n');
}

const toolName = name => string(name).split('__').at(-1);
const isPlan = call => ['todo_write', 'write_todos', 'update_plan', 'plan_update'].includes(toolName(call?.data?.name));
const isQuestion = call => ['ask_user_question', 'ask_user_questions'].includes(toolName(call?.data?.name));

/**
 * Project v4 events into stable reading nodes. Full detail remains in text;
 * successful outputs, intermediate prose and repetitive plans stay collapsed.
 * This shows event history, including messages subsequently replaced on the
 * model surface. It does not reconstruct the model's current request history.
 * @param {Array<object>} events Durable v4 events, optionally with a session header.
 * @param {{reasoning?: boolean, system?: boolean}} options Explicit detail visibility.
 * @returns {Array<object>} Chronological nodes with stable key, kind, title, summary,
 * text, tone, expandable, turn and state; final nodes retain their complete body.
 */
export function projectTranscript(events, { reasoning = false, system = false } = {}) {
  const finals = new Map(); let candidate = null;
  for (const event of events) {
    if (event.type === 'turn/start') candidate = null;
    else if (event.type === 'assistant/message' && assistantText(event).trim()) candidate = event;
    else if (event.type === 'turn/end') {
      if (candidate) finals.set(identity(candidate), event.data?.reason?.kind || 'completed');
      candidate = null;
    }
  }
  const nodes = [], tools = new Map(), plans = new Map(), suppressed = new Set();
  let cwd = '', turn = 0, turnKey = 'initial';
  const add = (event, kind, title, text, extra = {}) => {
    const node = { key: `${kind}:${identity(event)}`, kind, title, summary: preview(text), text,
      tone: 'neutral', expandable: text !== preview(text), turn: event.data?.turn ?? turn, state: 'complete',
      ...(event.time !== undefined ? { timestamp: event.time } : {}), ...extra };
    nodes.push(node); return node;
  };
  const toolFor = (event, callId) => {
    const key = callId ? `tool:${callId}:${event.data?.turn ?? turn}:${event.data?.step ?? 0}` : `tool:unmatched:${identity(event)}`;
    if (!tools.has(key)) {
      const node = add(event, 'tool', '工具', '', { key, state: 'pending', expandable: true });
      tools.set(key, { node, call: null, results: [], cwd });
    }
    return tools.get(key);
  };
  for (const event of events) {
    const data = event.data || {};
    switch (event.type) {
      case 'session': cwd = event.cwd || ''; break;
      case 'session/title':
        if (data.title) add(event, 'title', data.title, data.title, { expandable: false });
        break;
      case 'turn/start':
        turn = data.turn ?? turn; turnKey = `${turn}:${identity(event)}`;
        break;
      case 'user/message': {
        const text = contents(data.content);
        if (data.source?.kind === 'user') {
          const brief = briefText(text);
          if (brief.trim()) add(event, 'task', '任务', brief, { tone: 'info', summary: preview(brief, 120, 2), expandable: true });
          const feedback = feedbackText(text);
          if (feedback) add(event, 'task', '返工补充', feedback, { key: `task:${identity(event)}:feedback`, tone: 'info', summary: preview(feedback, 120, 2), expandable: true });
        } else if (system && text.trim()) add(event, 'note', `上下文 · ${data.source?.kind || 'runtime'}`, text);
        break;
      }
      case 'system/message':
      case 'developer/message':
        if (system) add(event, 'note', event.type === 'system/message' ? '系统上下文' : '开发者更新', contents(data.message?.content));
        break;
      case 'assistant/message': {
        const text = assistantText(event);
        if (text.trim()) {
          const final = finals.get(identity(event));
          add(event, final ? 'final' : 'assistant', final ? '最终回答' : '进度', text,
            { key: `assistant:${identity(event)}`, tone: final === 'completed' ? 'success' : final === 'error' ? 'error' : final ? 'warning' : 'neutral', state: final || 'complete',
              ...(final ? { reason: final, expandable: false } : {}) });
        }
        if (reasoning) {
          const thought = (data.message?.content || []).filter(block => block.type === 'reasoning').map(block => string(block.text)).join('\n');
          if (thought.trim()) add(event, 'note', '思考', thought, { key: `reasoning:${identity(event)}`, tone: 'neutral', expandable: true });
        }
        const other = (data.message?.content || []).filter(block => !['text', 'reasoning', 'tool-call'].includes(block.type));
        if (other.length) add(event, 'note', '助手附件', contents(other), { key: `attachment:${identity(event)}`, expandable: true });
        break;
      }
      case 'tool/call': {
        const record = toolFor(event, data.callId); record.call = event; record.cwd = cwd;
        record.node.turn = data.turn ?? turn;
        if (isPlan(event)) {
          const groupKey = `plan:${turnKey}`;
          if (!plans.has(groupKey)) {
            const group = { node: record.node, records: [] };
            record.node.key = groupKey; plans.set(groupKey, group);
          }
          const group = plans.get(groupKey);
          if (group.node !== record.node) suppressed.add(record.node);
          group.records.push(record);
        }
        break;
      }
      case 'tool/result': {
        const record = toolFor(event, data.message?.toolCallId);
        record.results.push(event);
        break;
      }
      case 'turn/end': {
        const reason = data.reason;
        if (reason?.kind === 'error') add(event, 'error', '执行失败', string(reason), { summary: preview(reason.error?.message || string(reason)), tone: 'error', state: 'error', reason: reason.kind, expandable: true });
        else if (reason?.kind && reason.kind !== 'completed') add(event, 'note', '本轮结束', string(reason), { tone: 'warning', state: reason.kind, reason: reason.kind });
        break;
      }
      case 'assistant/attempt':
        if (system) add(event, 'note', '模型尝试', string(data), { expandable: true });
        break;
      default:
        if (system) add(event, 'note', event.type, string(data), { expandable: true });
    }
  }
  for (const record of tools.values()) {
    const { node, call, results } = record;
    const failed = results.find(result => result.data?.message?.isError || result.data?.error);
    const question = call && isQuestion(call);
    node.kind = question ? 'question' : failed ? 'error' : 'tool';
    node.title = question ? failed ? '问题未解决' : results.length ? '问题与回复' : '需要回复' : failed ? '工具失败' : '工具';
    node.toolLabel = call?.data?.name || '';
    node.state = failed ? 'error' : results.length ? 'success' : 'pending';
    node.tone = failed ? 'error' : question && !results.length ? 'warning' : 'neutral';
    node.summary = failed ? preview(failed.data?.error?.reason || failed.data?.error?.message || contents(failed.data?.message?.content).split(/\r?\n/).find(line => line.trim()) || '工具执行失败')
      : question ? preview(questionsOf(call) || '等待回复') : call ? toolSummary(call, record.cwd) : '未找到调用记录';
    node.text = [question ? questionsOf(call) : '', toolDetails(call, results)].filter(Boolean).join('\n\n');
    node.expandable = true;
    if (question) node.questions = questionsOf(call);
  }
  for (const { node, records } of plans.values()) {
    const failure = records.find(record => record.node.state === 'error')?.node.summary;
    node.kind = records.some(record => record.node.state === 'error') ? 'error' : 'note';
    node.title = '计划更新'; node.summary = `计划更新 ${records.length} 次`;
    node.text = records.map(record => toolDetails(record.call, record.results)).join('\n\n');
    node.state = records.some(record => record.node.state === 'error') ? 'error' : records.some(record => record.node.state === 'pending') ? 'pending' : 'success';
    node.tone = node.state === 'error' ? 'error' : 'neutral'; node.expandable = true;
    if (node.state === 'error') node.summary += ` · 含失败：${failure}`;
    node.count = records.length;
  }
  return nodes.filter(node => !suppressed.has(node));
}
