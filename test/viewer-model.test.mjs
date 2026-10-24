import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTranscript } from '../lib/viewer-model.mjs';

const text = value => [{ type: 'text', text: value }];
const event = (seq, type, data = {}) => ({ seq, type, time: 1000 + seq, data });
const start = (seq, turn = 1) => event(seq, 'turn/start', { turn });
const end = (seq, turn = 1, reason = { kind: 'completed' }) => event(seq, 'turn/end', { turn, reason });
const user = (seq, value, source = { kind: 'user' }) => event(seq, 'user/message', { id: `user-${seq}`, role: 'user', source, content: text(value) });
const assistant = (seq, value, turn = 1) => event(seq, 'assistant/message', { turn, step: seq, message: { id: `assistant-${seq}`, role: 'assistant', content: text(value) }, stream: [] });
const call = (seq, callId, name, args = {}, turn = 1) => event(seq, 'tool/call', { turn, step: 1, callId, name, arguments: JSON.stringify(args) });
const result = (seq, callId, value, isError = false, turn = 1) => event(seq, 'tool/result', { turn, step: 1, message: { role: 'tool', toolCallId: callId, content: text(value), ...(isError ? { isError: true } : {}) } });

test('parallel tools merge by call id despite out-of-order results and keep pending keys stable', () => {
  const prefix = [start(1), call(2, 'read-a', 'read_file', { file_path: '/repo/src/a.mjs' }), call(3, 'run-b', 'shell', { command: 'npm test\necho secret' })];
  const pending = projectTranscript(prefix);
  assert.deepEqual(pending.map(node => node.key), ['tool:read-a:1:1', 'tool:run-b:1:1']);
  assert.ok(pending.every(node => node.state === 'pending'));
  const nodes = projectTranscript([...prefix, result(4, 'run-b', 'b output'), result(5, 'read-a', 'a output')]);
  assert.equal(nodes.length, 2); assert.equal(nodes[0].key, pending[0].key);
  assert.match(nodes[0].text, /a output/); assert.doesNotMatch(nodes[0].text, /b output/);
  assert.match(nodes[1].text, /b output/); assert.equal(nodes[1].summary, 'npm test');
  assert.doesNotMatch(nodes[1].summary, /secret|output/);
  assert.ok(nodes.every(node => node.state === 'success' && node.expandable));
});

test('tool summaries prefer descriptions then project-relative paths then command first lines', () => {
  const nodes = projectTranscript([{ type: 'session', cwd: 'C:\\repo' }, start(1),
    call(2, 'describe', 'shell', { description: '验证构建', command: 'long command --private' }),
    call(3, 'path', 'read_file', { path: 'c:\\repo\\src\\main.ts' }),
    call(4, 'fallback', 'custom', { nested: { giant: 'not a useful summary' } })]);
  assert.equal(nodes[0].summary, '验证构建'); assert.equal(nodes[1].summary, 'src/main.ts');
  assert.equal(nodes[2].summary, '执行工具'); assert.equal(nodes[2].toolLabel, 'custom');
  assert.match(nodes[2].text, /not a useful summary/);
});

test('orphan results retain content and later calls merge into the same stable node', () => {
  const first = projectTranscript([result(1, 'late', 'preserve output')]);
  assert.equal(first[0].summary, '未找到调用记录');
  const next = projectTranscript([result(1, 'late', 'preserve output'), call(2, 'late', 'shell', { command: 'pwd' })]);
  assert.equal(next.length, 1); assert.equal(next[0].key, first[0].key);
  assert.equal(next[0].summary, 'pwd'); assert.match(next[0].text, /preserve output/);
});

test('failed tools surface brief errors while retaining full arguments, output, metadata and failure detail', () => {
  const failed = result(3, 'bad', 'Permission denied\ncomplete error log\nmore detail', true);
  failed.data.error = { name: 'PermissionError', code: 'DENIED', reason: '缺少目录权限' };
  failed.data.meta = { path: '/repo/protected' };
  const [node] = projectTranscript([start(1), call(2, 'bad', 'write_file', { path: '/repo/protected', content: 'original value' }), failed]);
  assert.equal(node.kind, 'error'); assert.equal(node.tone, 'error'); assert.equal(node.state, 'error');
  assert.equal(node.summary, '缺少目录权限');
  for (const value of ['original value', 'complete error log', 'PermissionError', '/repo/protected']) assert.ok(node.text.includes(value));
});

test('only the last nonempty assistant text before each turn end becomes a full final answer', () => {
  const progress = assistant(2, 'I am investigating.\n' + 'detail '.repeat(80));
  const answer = assistant(3, 'RESULT: OK\n完整结论\n' + '已验证。'.repeat(80));
  const [middle, final] = projectTranscript([start(1), progress, answer, assistant(4, ''), end(5)]);
  assert.equal(middle.kind, 'assistant'); assert.ok(middle.summary.length < middle.text.length); assert.equal(middle.expandable, true);
  assert.equal(final.kind, 'final'); assert.equal(final.text, answer.data.message.content[0].text); assert.equal(final.expandable, false);
  assert.equal(final.reason, 'completed'); assert.equal(final.state, 'completed');
  const live = projectTranscript([start(1), progress, answer]);
  assert.equal(live[1].kind, 'assistant'); assert.equal(live[1].key, final.key);
});

test('multiple turns and identical followup tasks stay separate and retain turn identity', () => {
  const nodes = projectTranscript([start(1, 1), user(2, '继续调查'), assistant(3, 'first answer', 1), end(4, 1),
    start(5, 2), user(6, '继续调查'), assistant(7, 'second answer', 2), end(8, 2)]);
  const tasks = nodes.filter(node => node.kind === 'task'), finals = nodes.filter(node => node.kind === 'final');
  assert.equal(tasks.length, 2); assert.notEqual(tasks[0].key, tasks[1].key);
  assert.deepEqual(tasks.map(node => node.turn), [1, 2]); assert.deepEqual(finals.map(node => node.turn), [1, 2]);
});

test('provider call ids reused in later turns or steps do not overwrite earlier calls', () => {
  const secondCall = call(5, 'reused', 'shell', { command: 'second command' }); secondCall.data.step = 2;
  const secondResult = result(6, 'reused', 'second output'); secondResult.data.step = 2;
  const nodes = projectTranscript([start(1), call(2, 'reused', 'shell', { command: 'first command' }), result(3, 'reused', 'first output'),
    secondCall, secondResult, end(7), start(8, 2), call(9, 'reused', 'shell', { command: 'third command' }, 2), result(10, 'reused', 'third output', false, 2)]);
  assert.equal(nodes.length, 3); assert.equal(new Set(nodes.map(node => node.key)).size, 3);
  for (let index = 0; index < nodes.length; index++) assert.match(nodes[index].text, new RegExp(['first output', 'second output', 'third output'][index]));
});

test('runtime context is hidden by default and explicitly available without hiding actual user content', () => {
  const rows = [start(1), user(2, 'visible user input'), user(3, 'runtime update', { kind: 'workspace-context' }),
    event(4, 'system/message', { message: { role: 'system', content: text('system body') } }),
    event(5, 'developer/message', { message: { role: 'developer', content: text('developer body') } }),
    event(6, 'request/header', { header: { config: { model: 'model-name' } } })];
  assert.deepEqual(projectTranscript(rows).map(node => node.text), ['visible user input']);
  const expanded = projectTranscript(rows, { system: true });
  for (const value of ['visible user input', 'runtime update', 'system body', 'developer body', 'model-name']) assert.ok(expanded.some(node => node.text.includes(value)));
});

test('reasoning is opt-in and does not change answer keys or final detection', () => {
  const answer = assistant(2, 'visible answer');
  answer.data.message.content.unshift({ type: 'reasoning', text: 'private thought\nfull detail' });
  const rows = [start(1), answer, end(3)];
  const plain = projectTranscript(rows), expanded = projectTranscript(rows, { reasoning: true });
  assert.equal(plain.length, 1); assert.ok(!plain[0].text.includes('private thought'));
  assert.equal(expanded.find(node => node.kind === 'final').key, plain[0].key);
  assert.match(expanded.find(node => node.title === '思考').text, /private thought\nfull detail/);
});

test('bridge report trailers are stripped while the complete original brief and retry feedback remain available', () => {
  const brief = '请实现需求。\n保留这个原始段落。\n字面提及【桥接报告约定】不是尾注。';
  const value = `${brief}\n\n【桥接报告约定】\n桥接内部约定\n\n【返工信息】\n修复测试失败，保留已有成果。\n\n[bridge-task:fixture]\n`;
  const nodes = projectTranscript([user(1, value)]);
  assert.equal(nodes[0].text, brief); assert.equal(nodes[0].kind, 'task');
  assert.equal(nodes[1].title, '返工补充'); assert.equal(nodes[1].text, '修复测试失败，保留已有成果。');
  assert.ok(nodes.every(node => !node.text.includes('桥接内部约定') && !node.text.includes('bridge-task:')));
});

test('long CJK tasks have readable short previews and complete original text without surrogate splitting', () => {
  const body = '请检查界面。请保留全部有效信息。' + '这是很长的原始任务正文😀'.repeat(1000);
  const [node] = projectTranscript([user(1, body)]);
  assert.equal(node.text, body); assert.equal(node.expandable, true);
  assert.equal(node.summary, '请检查界面。 请保留全部有效信息。');
  const [unbroken] = projectTranscript([user(2, '中文😀'.repeat(1000))]);
  assert.ok(unbroken.summary.length < 100); assert.ok(unbroken.summary.endsWith('…'));
  assert.equal(unbroken.text, '中文😀'.repeat(1000));
});

test('repetitive plan tools collapse into one stable node per turn with all updates retained', () => {
  const rows = [start(1), call(2, 'p1', 'todo_write', { todos: [{ content: 'first task', status: 'pending' }] }), result(3, 'p1', 'first saved'),
    call(4, 'p2', 'todo_write', { todos: [{ content: 'second task', status: 'completed' }] }), result(5, 'p2', 'second saved')];
  const pending = projectTranscript(rows.slice(0, 2)), [node] = projectTranscript(rows);
  assert.equal(node.key, pending[0].key); assert.equal(node.kind, 'note'); assert.equal(node.summary, '计划更新 2 次');
  for (const value of ['first task', 'second task', 'first saved', 'second saved']) assert.ok(node.text.includes(value));
  const extended = projectTranscript([...rows, end(6), start(7, 2), call(8, 'p3', 'todo_write', { todos: [] }, 2)]);
  assert.equal(extended.length, 2); assert.notEqual(extended[0].key, extended[1].key); assert.equal(extended[1].turn, 2);
});

test('plan errors stay visible instead of being hidden among successful updates', () => {
  const [node] = projectTranscript([start(1), call(2, 'p1', 'todo_write', { todos: [] }), result(3, 'p1', 'could not save', true),
    call(4, 'p2', 'todo_write', { todos: [] }), result(5, 'p2', 'saved')]);
  assert.equal(node.kind, 'error'); assert.equal(node.state, 'error'); assert.match(node.summary, /含失败/); assert.match(node.text, /could not save/);
});

test('questions are prominent pending nodes with complete options and merged answers', () => {
  const ask = call(2, 'question', 'ask_user_question', { questions: [{ id: 'mode', question: '选择哪种模式？', options: [{ label: '保留', description: '保持现状' }, { label: '调整', description: '修改行为' }] }] });
  const [pending] = projectTranscript([start(1), ask]);
  assert.equal(pending.kind, 'question'); assert.equal(pending.state, 'pending'); assert.equal(pending.tone, 'warning'); assert.match(pending.summary, /选择哪种模式/);
  assert.match(pending.questions, /保持现状/);
  const [answered] = projectTranscript([start(1), ask, result(3, 'question', JSON.stringify({ answers: [{ id: 'mode', selected: ['保留'], custom: 'host reply' }] }))]);
  assert.equal(answered.key, pending.key); assert.equal(answered.kind, 'question'); assert.equal(answered.state, 'success'); assert.match(answered.text, /host reply/);
});

test('structured turn failures and non-text attachments keep their actual information', () => {
  const answer = assistant(2, 'partial answer'); answer.data.message.content.push({ type: 'image', source: { type: 'url', url: 'https://example.test/image.png' } });
  const nodes = projectTranscript([start(1), answer, end(3, 1, { kind: 'error', error: { code: 'UNKNOWN', message: 'provider failure' } })]);
  assert.equal(nodes.find(node => node.kind === 'final').tone, 'error');
  assert.ok(nodes.some(node => node.text.includes('https://example.test/image.png')));
  const failure = nodes.find(node => node.title === '执行失败');
  assert.equal(failure.summary, 'provider failure'); assert.match(failure.text, /UNKNOWN/); assert.match(failure.text, /provider failure/);
});

test('projection does not mutate events and node identity survives visibility changes and earlier insertions', () => {
  const rows = [start(1), call(2, 'stable', 'shell', { command: 'pwd' }), result(3, 'stable', '/repo'), assistant(4, 'answer'), end(5)];
  const before = JSON.stringify(rows), original = projectTranscript(rows);
  const next = projectTranscript([event(0, 'session/title', { title: 'title' }), ...rows], { system: true, reasoning: true });
  assert.equal(JSON.stringify(rows), before);
  for (const node of original) assert.ok(next.some(item => item.key === node.key));
  for (const node of next) {
    for (const field of ['key', 'kind', 'title', 'summary', 'text', 'tone', 'state']) assert.equal(typeof node[field], 'string', field);
    assert.equal(typeof node.expandable, 'boolean');
  }
});
