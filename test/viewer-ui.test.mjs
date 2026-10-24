import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../bin/dsv.mjs', import.meta.url));
const plain = text => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsv-reading-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let seq = 0;
  const event = (type, data) => ({ type, seq: ++seq, time: 1700000000000 + seq, data });
  const events = [{ type: 'session', version: 4, id: 'reading', cwd: '/work/bridge', createdAt: 1700000000000 },
    event('session/title', { title: '优化会话查看器' }), event('turn/start', { turn: 1 }),
    event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '减少阅读负担，保留完整过程。\n\n【桥接报告约定】INTERNAL_BRIDGE_CONTRACT' }] })];
  for (let i = 0; i < 80; i++) {
    events.push(event('tool/call', { turn: 1, step: i, callId: `call-${i}`, name: 'read_file', arguments: JSON.stringify({ path: `/work/bridge/src/file-${i}.mjs` }) }),
      event('tool/result', { turn: 1, step: i, message: { role: 'tool', toolCallId: `call-${i}`, content: [{ type: 'text', text: `SUCCESS_TOOL_DUMP_${i}\n` + 'long output '.repeat(100) }] } }));
  }
  events.push(event('assistant/message', { turn: 1, step: 81, message: { content: [{ type: 'reasoning', text: 'HIDDEN_REASONING' },
    { type: 'text', text: 'RESULT: OK\n已完成阅读界面调整。\n\n- 结果优先显示\n- 完整过程按需展开\n- 任务之间不再自动跳转' }] } }), event('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  const dir = path.join(root, 'project', 'reading'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), events.map(JSON.stringify).join('\n') + '\n');
  return root;
}

test('default CLI shows the answer before a single process summary and hides technical clutter', t => {
  const root = fixture(t);
  const run = flags => spawnSync(process.execPath, [cli, 'show', 'reading', ...flags], { encoding: 'utf8', env: { ...process.env, DSH_SESSIONS_ROOT: root } });
  const compact = run([]); assert.equal(compact.status, 0, compact.stderr);
  assert.match(compact.stdout, /已完成阅读界面调整/); assert.match(compact.stdout, /80 次工具操作/);
  for (const hidden of ['HIDDEN_REASONING', 'SUCCESS_TOOL_DUMP', 'INTERNAL_BRIDGE_CONTRACT', 'cacheReadTokens', '格式 v4']) assert.ok(!compact.stdout.includes(hidden), hidden);
  assert.ok(compact.stdout.indexOf('已完成阅读界面调整') < compact.stdout.indexOf('减少阅读负担'));
  assert.ok(compact.stdout.split('\n').length < 25);
  const processView = run(['--details']); assert.equal(processView.status, 0, processView.stderr); assert.match(processView.stdout, /src\/file-0.mjs/);
  const full = run(['--full', '--reasoning']); assert.equal(full.status, 0, full.stderr); assert.match(full.stdout, /SUCCESS_TOOL_DUMP/); assert.match(full.stdout, /HIDDEN_REASONING/);
});

test('long answers and full tool output remain complete and terminal controls are removed', t => {
  const root = fixture(t), file = path.join(root, 'project', 'reading', 'session.v4.jsonl');
  const events = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  const control = '\x1b]0;HOSTILE_TITLE\x07\x1b[2J';
  events[0].cwd = '/work/' + control + 'bridge';
  events[1].data.title = control + '任务';
  const long = Array.from({ length: 2105 }, (_, i) => `line-${i}`).join('\n');
  events.find(e => e.type === 'assistant/message').data.message.content = [{ type: 'text', text: control + long }];
  events.find(e => e.type === 'tool/result').data.message.content = [{ type: 'text', text: control + long }];
  events.find(e => e.type === 'tool/call').data.arguments = JSON.stringify({ command: control + 'safe-command' });
  fs.writeFileSync(file, events.map(JSON.stringify).join('\n') + '\n');
  for (const flags of [[], ['--full'], ['--all']]) {
    const result = spawnSync(process.execPath, [cli, 'show', 'reading', ...flags], { encoding: 'utf8', env: { ...process.env, DSH_SESSIONS_ROOT: root }, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /line-2104/);
    assert.ok(!result.stdout.includes('\x1b[2J')); assert.ok(!result.stdout.includes('\x1b]0;'));
    if (flags.includes('--full')) assert.equal(result.stdout.match(/line-2104/g).length, 2);
  }
});

test('actual TUI frame stays readable at wide and narrow sizes and exposes process/help via keys', t => {
  const root = fixture(t);
  for (const columns of [128, 80]) {
    const script = `
const frames=[];const stdout=process.stdout.write.bind(process.stdout);
Object.defineProperty(process.stdout,'isTTY',{value:true});Object.defineProperty(process.stdin,'isTTY',{value:true});
Object.defineProperty(process.stdout,'columns',{value:${columns}});Object.defineProperty(process.stdout,'rows',{value:30});
process.stdin.setRawMode=()=>{};process.stdout.write=s=>{if(String(s).startsWith('\\x1b[H'))frames.push(String(s));return true;};
process.argv=['node',${JSON.stringify(cli)},'--no-update-check'];await import(${JSON.stringify(pathToFileURL(cli).href)});
process.stdin.emit('data',Buffer.from('d'));process.stdin.emit('data',Buffer.from('?'));process.stdin.emit('data',Buffer.from('?'));
stdout(JSON.stringify(frames));process.exit(0);`;
    const output = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, DSH_SESSIONS_ROOT: root }, timeout: 15000 });
    assert.equal(output.status, 0, output.stderr);
    const frames = JSON.parse(output.stdout).map(plain);
    assert.ok(frames.length >= 3); assert.match(frames[0], /结果/); assert.match(frames[0], /已完成阅读界面调整/);
    assert.ok(!frames[0].includes('SUCCESS_TOOL_DUMP')); assert.ok(!frames[0].includes('HIDDEN_REASONING'));
    assert.match(frames[1], /src\/file-0.mjs/); assert.ok(frames.some(frame => frame.includes('阅读方式')));
    for (const frame of frames) assert.ok(frame.split('\r\n').length <= 30);
  }
});

test('new sessions do not steal the current reading position and explicit navigation still switches', t => {
  const root = fixture(t);
  const script = `
import fs from 'node:fs';import path from 'node:path';
const frames=[],timers=[];const stdout=process.stdout.write.bind(process.stdout);
globalThis.setInterval=(callback,ms)=>{timers.push({callback,ms});return 1;};
Object.defineProperty(process.stdout,'isTTY',{value:true});Object.defineProperty(process.stdin,'isTTY',{value:true});
Object.defineProperty(process.stdout,'columns',{value:128});Object.defineProperty(process.stdout,'rows',{value:30});
process.stdin.setRawMode=()=>{};process.stdout.write=s=>{if(String(s).startsWith('\\x1b[H'))frames.push(String(s));return true;};
process.argv=['node',${JSON.stringify(cli)},'--no-update-check'];await import(${JSON.stringify(pathToFileURL(cli).href)});
const dir=path.join(process.env.DSH_SESSIONS_ROOT,'project','new');fs.mkdirSync(dir,{recursive:true});
const rows=[{type:'session',version:4,id:'new',cwd:'/work/new',createdAt:Date.now()},
{type:'session/title',seq:1,data:{title:'新到达的会话'}},{type:'turn/start',seq:2,data:{turn:1}},
{type:'assistant/message',seq:3,data:{turn:1,message:{content:[{type:'text',text:'NEW_SESSION_RESULT'}]}}},
{type:'turn/end',seq:4,data:{turn:1,reason:{kind:'completed'}}}];
fs.writeFileSync(path.join(dir,'session.v4.jsonl'),rows.map(JSON.stringify).join('\\n')+'\\n');
fs.utimesSync(path.join(dir,'session.v4.jsonl'),new Date(),new Date(Date.now()+2000));
timers.find(t=>t.ms===1000).callback();
process.stdin.emit('data',Buffer.from('\\tk'));stdout(JSON.stringify(frames));process.exit(0);`;
  const output = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, DSH_SESSIONS_ROOT: root }, timeout: 15000 });
  assert.equal(output.status, 0, output.stderr);
  const frames = JSON.parse(output.stdout).map(plain);
  assert.match(frames[1], /新到达的会话/); assert.match(frames[1], /已完成阅读界面调整/); assert.ok(!frames[1].includes('NEW_SESSION_RESULT'));
  assert.match(frames.at(-1), /NEW_SESSION_RESULT/);
});
