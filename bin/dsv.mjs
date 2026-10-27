#!/usr/bin/env node
// dsv — DeepSeek Harness session viewer.
//   dsv [ls] [N]            list the N most recent sessions (default 15)
//   dsv show [id|latest]    print one session's transcript
//   dsv watch [id]          live-follow a session (default: newest, auto-switches to newer ones)
// Flags: --full (no truncation)  --no-reasoning  --all (show injected system/runtime messages)
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { readEvents, createEventReader, listSessionFiles, sessionState, collectUsage } from '../lib/sessions.mjs';
import { checkForUpdate, applyUpdate, readUpdateSettings, setAutoUpdate, recoverUpdate } from '../lib/updater.mjs';
import { projectTranscript, groupSessionsByTime, relativePath } from '../lib/viewer-model.mjs';

const ROOT = process.env.DSH_SESSIONS_ROOT || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions');
const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const args = argv.filter(a => !a.startsWith('--'));
const PACKAGE = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
let updateInfo = null, updateTask = null, updateMessage = '', updateApplied = false;
async function installUpdate(changed = () => {}) {
  if (updateTask || updateApplied) return;
  updateTask = (async () => {
    try {
      const info = await checkForUpdate({ force: true }); updateInfo = info;
      if (!info.available) { updateMessage = info.error ? `检查更新失败：${info.error}` : '当前已是最新正式版本'; changed(); return; }
      const applied = await applyUpdate(info, { onProgress: message => { updateMessage = message; changed(); } });
      updateApplied = true; updateMessage = `已更新至 ${applied.version}，重开 dsv 生效`; changed();
    } catch (error) { updateMessage = `更新暂停：${error.message}`; changed(); }
    finally { updateTask = null; changed(); }
  })();
  return updateTask;
}
async function refreshUpdate(changed = () => {}) {
  if (process.env.CI || process.env.NO_UPDATE_NOTIFIER || flags.has('--no-update-check') || updateApplied) return;
  updateInfo = await checkForUpdate(); changed();
  if (updateInfo.available && !updateInfo.error && readUpdateSettings().autoUpdate) void installUpdate(changed);
}
let FULL = flags.has('--full');
let REASONING = flags.has('--reasoning') && !flags.has('--no-reasoning');
let ALL = flags.has('--all');
let DETAILS = flags.has('--details') || flags.has('--all');
let W = Math.max(60, Math.min(process.stdout.columns || 100, 140));

// ── styling ────────────────────────────────────────────────────────────────
let TTY = process.stdout.isTTY;
const sgr = code => s => (TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = sgr('1'), ital = sgr('2;3'), red = sgr('91'), green = sgr('92'),
  yellow = sgr('93'), blue = sgr('94'), magenta = sgr('95'), cyan = sgr('96'), gray = sgr('90');

const stripAnsi = s => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const safeText = s => String(s ?? '').replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\t/g, '    ');
const safeLog = value => typeof value === 'string' ? safeText(value) : Array.isArray(value) ? value.map(safeLog)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeLog(item)])) : value;
const cw = cp => (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) || cp >= 0x1f300)) ? 2 : 1;
const width = s => { let n = 0; for (const ch of stripAnsi(s)) n += cw(ch.codePointAt(0)); return n; };
// Cut plain text to `max` display columns.
const cut = (s, max) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (width(s) <= max) return s;
  let out = '', n = 0;
  for (const ch of s) { const w = cw(ch.codePointAt(0)); if (n + w > max - 1) break; out += ch; n += w; }
  return out + '…';
};
const pad = (s, w) => s + ' '.repeat(Math.max(0, w - width(s)));
// Wrap plain text to `w` columns, keeping existing line breaks.
function wrap(text, w) {
  const out = [];
  for (const para of String(text ?? '').replace(/\r/g, '').split('\n')) {
    let line = '', n = 0;
    for (const tok of para.split(/(\s+)/)) {
      if (!tok) continue;
      const tw = width(tok);
      if (n + tw <= w) { line += tok; n += tw; continue; }
      if (/^\s+$/.test(tok)) { out.push(line); line = ''; n = 0; continue; }
      if (tw <= w && n > 0) { out.push(line); line = tok; n = tw; continue; }
      for (const ch of tok) { const cwv = cw(ch.codePointAt(0)); if (n + cwv > w) { out.push(line); line = ''; n = 0; } line += ch; n += cwv; }
    }
    out.push(line.trimEnd());
  }
  while (out.length > 1 && !out[out.length - 1]) out.pop();
  return out;
}
const squeeze = lines => lines.filter((l, i) => l.trim() || (i > 0 && lines[i - 1].trim() && i < lines.length - 1));

const clock = t => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
const when = t => new Date(t).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const ago = t => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return when(t);
};
const dur = ms => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 小时 ${Math.floor(s / 60) % 60} 分`;
};

// ── session files ──────────────────────────────────────────────────────────
function listSessions() {
  return listSessionFiles(ROOT);
}

const textOf = content => (Array.isArray(content) ? content : [])
  .map(p => p.type === 'text' ? p.text : '').join('');

const toolResult = message => message?.role === 'tool' ? message : undefined;

function summarize(s, events = readEvents(s.file).events) {
  let cwd = '', title = '', prompt = '', open = 0, lastEnd = null, tools = 0, errors = 0, created = s.mtime, last = s.mtime;
  for (const e of events) {
    if (e.time) last = e.time;
    if (e.type === 'session') { cwd = e.cwd; created = e.createdAt; }
    else if (e.type === 'session/title') title = e.data.title;
    else if (e.type === 'user/message' && !prompt && e.data?.source?.kind === 'user') prompt = textOf(e.data.content);
    else if (e.type === 'turn/start') open++;
    else if (e.type === 'turn/end') { open = Math.max(0, open - 1); lastEnd = e.data.reason?.kind; }
    else if (e.type === 'tool/call') tools++;
    else if (e.type === 'tool/result' && (toolResult(e.data?.message)?.isError || e.data?.error)) errors++;
  }
  const state = sessionState(open, lastEnd, s.mtime);
  return { ...s, cwd, title: title || prompt, prompt, created, last, state, openTurns: open, lastEnd, tools, errors, usage: collectUsage(events) };
}

const BADGE = {
  active: () => yellow('● 有更新'),
  quiet: () => yellow('◌ 无更新'),
  done: () => green('✓ 已结束'),
  empty: () => gray('· 空'),
};
const badge = st => (BADGE[st] || (() => red('✗ ' + st)))();

// ── transcript rendering ───────────────────────────────────────────────────
const G = 10;                    // gutter: "HH:MM:SS  "
const gutter = t => gray(pad(t ? clock(t) : '', G));
const blank = ' '.repeat(G);
let body = W - G - 4;
const setWidth = w => { W = w; body = W - G - 4; };

function shortPath(p, cwd) {
  if (!p) return '';
  p = String(p);
  const rel = relativePath(p, cwd);
  return rel === p.replace(/\\/g, '/') ? p : rel;
}

function argSummary(name, raw, cwd) {
  let a; try { a = safeLog(JSON.parse(raw)); } catch { return safeText(raw); }
  if (!a || typeof a !== 'object') return String(raw);
  if (a.command) return String(a.command).split('\n')[0];
  const p = a.file_path || a.path || a.filePath || a.target_file || a.targetPath;
  if (a.pattern) return `${cyan(`"${a.pattern}"`)}${p ? gray(' in ') + shortPath(p, cwd) : ''}${a.glob ? gray(' ' + a.glob) : ''}`;
  if (p) {
    let s = shortPath(p, cwd);
    if (a.offset || a.limit) s += gray(` :${a.offset || 1}${a.limit ? '+' + a.limit : ''}`);
    if (a.old_str || a.old_string) s += gray(' (替换)');
    return s;
  }
  if (a.action) {
    const target = a.name || a.target || a.query || a.path || a.search_term || a.instance || '';
    return [yellow(a.action), typeof target === 'string' ? target : JSON.stringify(target)].filter(Boolean).join(' ');
  }
  const keys = Object.keys(a);
  return keys.length ? keys.map(k => `${gray(k + '=')}${typeof a[k] === 'string' ? a[k] : JSON.stringify(a[k])}`).join(' ') : gray('(无参数)');
}

function toolLabel(name) {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name || '');
  return m ? magenta(`${m[1]}·${m[2]}`) : blue(name);
}

function resultPreview(text) {
  const t = String(text ?? '');
  const mm = /^<path>[\s\S]*?<content>([\s\S]*)/.exec(t);
  if (mm) return `${mm[1].split('\n').filter(l => /^\s*\d+:/.test(l)).length} 行`;
  const first = t.split('\n').map(l => l.trim()).find(Boolean) || '(空)';
  const more = t.split('\n').filter(l => l.trim()).length - 1;
  return first + (more > 0 ? gray(`  +${more} 行`) : '');
}

// Every event renders to blocks: { key, lines, full }. `full` (if any) is the expanded form of a
// truncated block; the CLI prints `lines` (or `full` with --full), the TUI lets you toggle per block.
let INTERACTIVE = false;
const moreHint = n => gray(`… 还有 ${n} 行${INTERACTIVE ? ' · 点击展开' : '（--full 查看全部）'}`);
const lessHint = () => gray('▴ 点击收起');
const blocksToText = bs => bs.flatMap(b => (FULL && b.full) ? b.full.filter(l => !stripAnsi(l).trimEnd().endsWith('▴ 点击收起')) : b.lines).join('\n');

function prettyArgs(raw) {
  try { const v = JSON.parse(raw); return typeof v === 'object' && v ? JSON.stringify(v, null, 2) : String(raw); } catch { return String(raw ?? ''); }
}

function makeRenderer(finals = new Set()) {
  const names = new Map();
  let lastCall = null, cwd = '', header = null, tools = 0, errors = 0;

  return function render(e) {
    e = safeLog(e);
    const blocks = [];
    let n = 0;
    const add = (lines, full = null) => blocks.push({ key: `${e.seq}:${n++}`, lines, full });
    // Show the first `max` lines; the rest behind a toggle.
    const fold = (all, max, indent = blank + '  ') => all.length > max
      ? add([...all.slice(0, max), indent + moreHint(all.length - max)], [...all, indent + lessHint()])
      : add(all);
    const d = e.data || {};
    switch (e.type) {
      case 'session':
        cwd = e.cwd;
        header = e;
        break;
      case 'session/title':
        if (d.source?.kind === 'provider') add(['', `${blank}${magenta('▍')}${bold(d.title)}`]);
        break;
      case 'turn/start':
        add(['', gray(`${'─'.repeat(3)} 第 ${d.turn} 轮 ${'─'.repeat(Math.max(3, W - 14 - G))}`) + ' ' + gray(clock(e.time))]);
        break;
      case 'user/message': {
        const kind = d.source?.kind;
        if (kind === 'user') {
          add(['']);
          const body_ = squeeze(wrap(textOf(d.content), body - 2)).map(l => blank + cyan('┃ ') + l);
          fold([gutter(e.time) + cyan(bold('▶ 任务')), ...body_], 9, blank + cyan('┃ '));
          add(['']);
        } else if (ALL) {
          const t = textOf(d.content);
          add([gutter(e.time) + gray(`[${d.source?.plugin || kind}] `) + gray(cut(t, body - 20))],
            [gutter(e.time) + gray(`[${d.source?.plugin || kind}]`), ...wrap(t, body - 4).map(l => blank + '  ' + gray(l)), blank + '  ' + lessHint()]);
        }
        break;
      }
      case 'system/message':
      case 'developer/message':
        if (ALL) add([gutter(e.time) + gray(`[${e.type.split('/')[0]}] ` + cut(textOf(d.message?.content || d.content), body - 10))]);
        break;
      case 'assistant/message':
        for (const p of d.message?.content || []) {
          if (p.type === 'reasoning' && REASONING && p.text?.trim()) {
            const ls = wrap(p.text, body - 2).filter(l => l.trim());
            fold([gutter(e.time) + gray('◇ ') + ital(ls[0]), ...ls.slice(1).map(l => blank + '  ' + ital(l))], 3);
          } else if (p.type === 'text' && p.text?.trim()) {
            const ls = wrap(p.text, body - 2);
            if (finals.has(e.seq)) { add(['', gutter(e.time) + green(bold('◆ 最终回答')), ...ls.map(l => blank + green('┃ ') + l)]); continue; }
            fold([gutter(e.time) + green('◆ ') + ls[0], ...ls.slice(1).map(l => blank + '  ' + l)], 30);
          }
        }
        break;
      case 'tool/call': {
        tools++;
        names.set(d.callId, d.name);
        lastCall = d.callId;
        const label = toolLabel(d.name);
        const room = body - width(label) - 3;
        const summary = argSummary(d.name, d.arguments, cwd);
        const fits = width(summary) <= room;
        const head = gutter(e.time) + `${yellow('▸')} ${label} ${fits ? summary : gray(cut(stripAnsi(summary), room))}`;
        const pretty = prettyArgs(d.arguments);
        if (!pretty || pretty === '{}') add([head]);
        else add([head], [gutter(e.time) + `${yellow('▾')} ${label}`,
          ...pretty.split('\n').flatMap(l => wrap(l, body - 4)).map(l => blank + '    ' + gray(l)), blank + '    ' + lessHint()]);
        break;
      }
      case 'tool/result': {
        const r = toolResult(d.message);
        const id = r?.toolCallId;
        const err = r?.isError || d.error;
        if (err) errors++;
        const who = id && id !== lastCall && names.get(id) ? gray(stripAnsi(toolLabel(names.get(id))) + ' ') : '';
        const text = textOf(r?.content);
        const mark = err ? red('✗ ') : green('✓ ');
        const prev = stripAnsi(resultPreview(text));
        const room = body - 6 - width(who);
        const head = blank + '  ' + mark + who + (err ? red(cut(prev, room)) : gray(cut(prev, room)));
        const all = wrap(text, body - 6);
        const MAXL = FULL ? Infinity : 2000;
        if (!text.trim() || (all.length <= 1 && width(prev) <= room)) add([head]);
        else add([head], [blank + '  ' + mark + who + gray(`${all.length} 行`),
          ...all.slice(0, MAXL).map(l => blank + '    ' + (err ? red(l) : gray(l))),
          ...(all.length > MAXL ? [blank + '    ' + gray(`… 还有 ${all.length - MAXL} 行未显示`)] : []),
          blank + '    ' + lessHint()]);
        lastCall = null;
        break;
      }
      case 'turn/end': {
        const k = d.reason?.kind;
        const took = header ? dur(e.time - header.createdAt) : '';
        const stats = gray(`  ${took} · ${tools} 次工具调用${errors ? ' · ' : ''}`) + (errors ? red(`${errors} 个错误`) : '');
        const error = d.reason?.error?.message || d.reason?.message;
        add(['', (k === 'completed' ? green('■ 会话结束（待任务验收）') : red(`■ ${k}`)) + stats, ...(error ? [red('  ' + error)] : [])]);
        break;
      }
      case 'assistant/attempt':
        add([gutter(e.time) + yellow('◇ 模型尝试结束，未提交消息')]);
        break;
      default:
        if (ALL && e.type !== 'session') add([gutter(e.time) + gray(`[${e.type}] ` + cut(JSON.stringify(d), body - 10))]);
    }
    return blocks;
  };
}

function headerLines(s) {
  s = safeLog(s);
  if (INTERACTIVE || (!FULL && !ALL)) {
    const title = safeText((s.title || s.prompt || '未命名任务').split('【桥接报告约定】')[0]);
    return [bold(cut(title, W - 4)),
      gray(safeText(path.basename(s.cwd || '?'))) + '  ' + badge(s.state) + (s.errors ? red(`  ${s.errors} 个错误`) : ''),
      ...(s.readError ? [red('读取失败：' + cut(s.readError, W - 14))] : []),
      ...(s.version > 4 ? [yellow('会话格式尚未验证，请更新 dsv。')] : []),
      ...(s.logComplete === false ? [gray('等待日志尾部写入完成')] : [])];
  }
  const title = s.title || '(无标题)';
  const bar = '─'.repeat(Math.max(4, W - 2));
  const status = s.state === 'empty' ? badge(s.state) : `${badge(s.state)}${gray(` · ${dur((['active', 'quiet'].includes(s.state) ? Date.now() : s.last) - s.created)} · ${s.tools} 次工具调用`)}${s.errors ? gray(' · ') + red(`${s.errors} 个错误`) : ''}`;
  return [
    gray('╭' + bar),
    gray('│ ') + bold(cut(title, W - 4)),
    gray('│ ') + gray('项目 ') + pad(path.basename(s.cwd || '?'), 20) + gray(cut(s.cwd, Math.max(10, W - 30))),
    gray('│ ') + gray('会话 ') + cyan(s.id.slice(0, 8)) + gray(`  格式 v${s.version ?? '?'}  开始 ${when(s.created)}  `) + status,
    ...(s.version > 4 ? [yellow('│ 此格式尚未验证，当前仅展示能识别的日志记录。')] : []),
    gray('│ ') + gray(cut(s.usage?.available ? `会话用量：输入 ${s.usage.tokens.uncachedInputTokens ?? '?'} · 输出 ${s.usage.tokens.outputTokens ?? '?'} · 缓存读 ${s.usage.tokens.cacheReadTokens ?? '?'} · 缓存写 ${s.usage.tokens.cacheWriteTokens ?? '?'}${s.usage.missingSamples ? ' · 样本不完整' : ''}` : '会话用量：不可用（不视为零）', W - 4)),
    ...(s.logComplete === false ? [yellow('│ 日志含未完成尾部或无法解析的记录，当前显示完整前缀。')] : []),
    ...(s.readError ? [red('│ 日志读取失败：' + cut(s.readError, W - 20))] : []),
    ...(['active', 'quiet'].includes(s.state) ? [gray('│ ') + gray(cut('日志状态不能证明进程存活；桥接任务请用 dsb status 核对。', W - 4))] : []),
    gray('╰' + bar),
  ];
}
const printHeader = s => console.log(headerLines(s).join('\n'));

// Reading mode gives the latest answer a stable home; the full event order is
// available through the process view, with one expandable row per tool.
function readingBlocks(events, columns, showProcess = DETAILS) {
  const nodes = projectTranscript(events, { reasoning: REASONING, system: ALL });
  const final = nodes.findLast(n => n.kind === 'final');
  const currentTurn = events.findLast(e => e.type === 'turn/start')?.data?.turn;
  const pending = nodes.filter(n => n.kind === 'question' && n.state === 'pending');
  const task = nodes.findLast(n => n.kind === 'task');
  const progress = nodes.slice(final ? nodes.lastIndexOf(final) + 1 : 0).findLast(n => n.kind === 'assistant');
  let visible = nodes.filter(n => n.kind !== 'title');
  if (!showProcess) {
    visible = [...pending, ...(final ? [final] : []), ...(progress ? [progress] : []), ...(task ? [task] : []),
      ...nodes.filter(n => n.kind === 'error' || n.kind === 'question' && n.state === 'error').slice(-2),
      ...nodes.filter(n => n.title === '助手附件').slice(-3), ...(REASONING ? nodes.filter(n => n.key.startsWith('reasoning:')).slice(-1) : [])];
    visible = [...new Map(visible.map(n => [n.key, n])).values()];
  }
  const max = Math.max(14, Math.min(76, columns - 4));
  const blocks = [];
  const label = node => node.kind === 'final' ? green(bold('结果')) : node.kind === 'question' ? yellow(bold(node.state === 'pending' ? '需要回复' : '问答'))
    : node.kind === 'task' ? cyan('要求') : node.kind === 'error' ? red('错误') : node.kind === 'assistant' ? bold('进展') : gray(safeText(node.title || '过程'));
  for (const node of visible) {
    const text = safeText(node.text), summary = safeText(node.kind === 'question' && node.state === 'pending' ? node.questions || node.summary : node.summary || node.title || text);
    if (node.kind === 'final') {
      const state = /^RESULT:\s*(OK|FAIL|BLOCKED)\s*(?:\r?\n|$)/.exec(text);
      const body = state ? text.slice(state[0].length).trimStart() : text;
      const heading = state?.[1] === 'BLOCKED' ? yellow(bold('等待补充')) : state?.[1] === 'FAIL' || node.tone === 'error' ? red(bold('未完成'))
        : currentTurn > node.turn ? gray(bold('上一轮结果')) : label(node);
      const lines = wrap(body, max).map(line => '  ' + line);
      blocks.push({ key: node.key, lines: ['', heading, '', ...lines, ''] });
      continue;
    }
    const prominent = node.kind === 'question' && node.state === 'pending';
    const lead = node.kind === 'tool' ? (node.state === 'pending' ? yellow('… ') : gray('✓ ')) : label(node) + '  ';
    const preview = wrap(summary, max - 4).slice(0, prominent ? 6 : node.kind === 'error' ? 2 : 1);
    const lines = prominent ? [label(node), ...preview.map(l => '  ' + l), '']
      : [lead + (node.kind === 'error' ? red(preview[0] || '') : preview[0] || ''), ...preview.slice(1).map(l => '  ' + l)];
    const expanded = [label(node), ...wrap(text || summary, max).map(l => '  ' + l)];
    blocks.push({ key: node.key, lines, full: expanded });
  }
  if (!showProcess) {
    const tools = nodes.filter(n => ['tool', 'error', 'question'].includes(n.kind)).length;
    const hidden = nodes.filter(n => !visible.includes(n));
    if (hidden.length) blocks.push({ key: 'process-overview', lines: ['', gray(`过程  ${tools} 次工具操作 · ${INTERACTIVE ? 'd' : '--details'} 查看`)],
      full: ['', bold('过程摘要'), ...hidden.map(n => '  ' + cut(safeText(n.summary || n.title || n.text), max)), gray('d 打开完整过程，Enter 收起')] });
  }
  return blocks;
}

// ── commands ───────────────────────────────────────────────────────────────
function resolve(sel) {
  const all = listSessions();
  if (!all.length) { console.error(red('没有找到任何 dsh 会话：') + ROOT); process.exit(1); }
  if (!sel || sel === 'latest') return all[0];
  const hit = all.filter(s => s.id.startsWith(sel.replace(/^session-/, '')));
  if (hit.length !== 1) { console.error(red(hit.length ? `前缀 ${sel} 匹配多个会话，请写长一点` : `找不到会话 ${sel}`)); process.exit(1); }
  return hit[0];
}

// seq of the last text-bearing assistant message before each turn/end
function finalSeqs(events) {
  const set = new Set(); let cand = null;
  for (const e of events) {
    if (e.type === 'assistant/message' && e.data?.message?.content?.some(p => p.type === 'text' && p.text?.trim())) cand = e.seq;
    else if (e.type === 'turn/start') cand = null;
    else if (e.type === 'turn/end' && cand != null) set.add(cand);
  }
  return set;
}

function show(sel) {
  const s = resolve(sel);
  const { events, complete, error } = readEvents(s.file);
  printHeader(summarize({ ...s, logComplete: complete, readError: error }, events));
  if (!FULL && !ALL) console.log(blocksToText(readingBlocks(events, W)));
  else {
    const render = makeRenderer(finalSeqs(events));
    for (const e of events) { const r = blocksToText(render(e)); if (r) console.log(r); }
  }
  console.log();
}

function ls(n = 15) {
  const all = listSessions();
  const rows = all.slice(0, n).map(s => {
    try { return summarize(s); }
    catch (error) { return { ...summarize(s, []), title: `读取失败：${error.message}`, state: 'unreadable' }; }
  });
  if (!rows.length) return console.log(gray('还没有任何 DeepSeek 会话。'));
  const running = rows.filter(r => r.state === 'active').length;
  console.log();
  console.log('  ' + bold('DeepSeek 会话') + gray(`  ·  显示 ${rows.length} / 共 ${all.length} 个`) + (running ? gray('  ·  ') + yellow(`${running} 个最近有更新`) : ''));
  console.log();
  const cols = [['状态', 10], ['ID', 10], ['项目', 18], ['工具', 6], ['更新', 13]];
  const fixed = cols.reduce((a, [, w]) => a + w, 0) + 2;
  const taskW = Math.max(16, W - fixed - 2);
  console.log('  ' + gray(cols.map(([h, w]) => pad(h, w)).join('') + '任务'));
  console.log('  ' + gray('─'.repeat(fixed + taskW - 2)));
  for (const r of rows) {
    const proj = safeText(path.basename(r.cwd || '')) || '?';
    const toolsCell = pad(String(r.tools), 4) + (r.errors ? red('!') : ' ') + ' ';
    console.log('  ' + pad(badge(r.state), 10) + pad(cyan(safeText(r.id.slice(0, 8))), 10) + pad(bold(cut(proj, 16)), 18) +
      pad(gray(toolsCell), 6) + pad(gray(ago(r.mtime)), 13) + cut(safeText(r.title), taskW));
  }
  console.log();
  console.log(gray('  dsv show <ID>  查看过程    dsv watch  实时跟踪    --full 不截断  --no-reasoning 隐藏思考'));
  console.log(gray('  状态来自日志；已结束不等于验收通过，无更新不等于中断。桥接任务用 dsb status 查看。'));
  console.log();
}

function watch(sel) {
  const pinned = !!sel && sel !== 'latest';
  let cur = resolve(sel), reader = createEventReader(cur.file), render = makeRenderer(), started = false;
  const printed = new Map();
  const printProjected = events => {
    for (const block of readingBlocks(events, W, true)) {
      const text = blocksToText([block]);
      if (text && printed.get(block.key) !== text) { console.log(text); printed.set(block.key, text); }
    }
  };
  const begin = () => {
    reader = createEventReader(cur.file);
    const { events, complete, error } = reader.read();
    printHeader(summarize({ ...cur, logComplete: complete, readError: error }, events));
    render = makeRenderer(finalSeqs(events));
    printed.clear();
    if (!FULL && !ALL) printProjected(events);
    else for (const e of events) { const r = blocksToText(render(e)); if (r) console.log(r); }
  };
  const tick = () => {
    {
      const all = listSessions();
      const newest = pinned ? all.find(s => s.id === cur.id) : all[0];
      if (newest && newest.file !== cur.file) {
        cur = newest;
        console.log('\n' + magenta(bold(`  ⇢ 新会话开始了，切换过去 `)) + gray(cur.id.slice(0, 8)) + '\n');
        begin();
        return;
      }
    }
    if (!started) { started = true; begin(); return; }
    let result; try { result = reader.read(); } catch (error) { console.error(red(error.message)); return; }
    if (result.reset) { printed.clear(); render = makeRenderer(finalSeqs(result.events)); console.log(yellow('日志已替换或截短，重新显示。')); }
    if (!FULL && !ALL) { if (result.reset || result.added.length) printProjected(result.events); }
    else for (const e of result.added) { const r = blocksToText(render(e)); if (r) console.log(r); }
  };
  console.log(gray(`  实时跟踪中 · Ctrl+C 退出${pinned ? '' : ' · 有新会话会自动切换'}\n`));
  tick();
  setInterval(tick, 1000);
}

// ── TUI ────────────────────────────────────────────────────────────────────
// Full-screen, long-lived: session list + live transcript, refreshed every second.
function tui() {
  TTY = true;
  INTERACTIVE = true;
  const out = process.stdout, inp = process.stdin;
  const ESC = '\x1b[';
  const SEL_BG = '\x1b[48;5;236m', BAR_BG = '\x1b[0m';
  const MAX_SESSIONS = 60;

  const cache = new Map();
  const CACHE_BYTES = 64 * 1024 * 1024;
  let sessions = [];          // summaries, newest first
  let selId = null, autoPick = false;
  let focus = 'detail', view = 'detail';
  let listTop = 0, scroll = 0, cursor = 0, follow = false;
  const collapsedGroups = new Set(['yesterday', 'week', 'older']);
  let listCursor = null, listHits = [];
  let flash = null, frame = 0, lastFrame = '', bell = false, help = false, info = false;
  let footButtons = [];       // [{ x0, x1, run }] 1-based columns of the bottom menu bar
  let shown = { lines: [], keys: [], h: 1, c: null }; // what the detail pane last drew
  const prevState = new Map();

  function load(s) {
    let c = cache.get(s.file);
    if (!c) {
      c = { reader: createEventReader(s.file, { maxBytes: 16 * 1024 * 1024, maxEvents: 30_000 }), events: [], blocks: null, open: new Set(), retainedBytes: 0 };
      cache.set(s.file, c);
    }
    let result;
    try { result = c.reader.read(); }
    catch (error) { c.sum = { ...summarize(s, c.events), state: 'unreadable', readError: error.message }; return c.sum; }
    const { events, added, reset } = result;
    c.events = events; c.retainedBytes = result.retainedBytes;
    if (reset) { c.blocks = null; c.open.clear(); }
    if (added.length) {
      c.blocks = null;
      c.sum = null;
    }
    if (!c.sum || c.sum.mtime !== s.mtime || c.sum.logComplete !== result.complete) {
      c.sum = summarize({ ...s, logComplete: result.complete, readError: result.error }, c.events);
    } else c.sum.state = sessionState(c.sum.openTurns, c.sum.lastEnd, s.mtime);
    return c.sum;
  }

  // Flatten a session's blocks into display lines, honoring which blocks are expanded.
  function linesFor(c, w) {
    if (!c.blocks || c.width !== w) {
      setWidth(Math.min(w, 84));
      c.width = w;
      c.blocks = readingBlocks(c.events, w);
    }
    setWidth(Math.min(w, 84));
    const meta = info ? [gray(cut(safeText(c.sum.cwd), w)), gray(`ID ${safeText(c.sum.id)}  v${c.sum.version}`),
      gray(`输入 ${c.sum.usage?.tokens?.uncachedInputTokens ?? '?'}  输出 ${c.sum.usage?.tokens?.outputTokens ?? '?'}  工具 ${c.sum.tools}`)] : [];
    const lines = [...headerLines(c.sum), ...meta, ''], keys = lines.map(() => null);
    for (const b of c.blocks) {
      const ls = b.full && FULL ? b.full.filter(l => !stripAnsi(l).trimEnd().endsWith('▴ 点击收起'))
        : b.full && c.open.has(b.key) ? b.full : b.lines;
      for (const l of ls) { lines.push(l); keys.push(b.full && !FULL ? b.key : null); }
    }
    return { lines, keys };
  }

  function refresh() {
    const list = listSessions().slice(0, MAX_SESSIONS);
    const keep = new Set(list.map(s => s.file));
    for (const file of cache.keys()) if (!keep.has(file)) cache.delete(file);
    const keepIds = new Set(list.map(s => s.id));
    for (const id of prevState.keys()) if (!keepIds.has(id)) prevState.delete(id);
    sessions = list.map(s => {
      const summary = load(s);
      let retained = [...cache.values()].reduce((n, c) => n + c.retainedBytes, 0);
      for (const [file, entry] of cache) {
        if (retained <= CACHE_BYTES) break;
        if (file === s.file || entry.sum?.id === selId) continue;
        retained -= entry.retainedBytes; cache.delete(file);
      }
      return summary;
    }).filter(s => s && s.state !== 'empty');
    for (const s of sessions) {
      const before = prevState.get(s.id);
      if (['active', 'quiet'].includes(before) && !['active', 'quiet', 'empty'].includes(s.state)) {
        const proj = safeText(path.basename(s.cwd || '')), id = safeText(s.id.slice(0, 8));
        flash = { until: Date.now() + 8000, text: s.state === 'done' ? green(`✓ ${id} ${proj} 会话已结束`) : red(`✗ ${id} ${proj} ${stripAnsi(badge(s.state))}`) };
        if (bell) out.write('\x07');
      }
      prevState.set(s.id, s.state);
    }
    if (autoPick && sessions.length) {
      const pick = sessions.find(s => s.state === 'active') || sessions[0];
      if (pick.id !== selId) select(pick.id);
    }
    if (!sessions.find(s => s.id === selId)) {
      select((sessions.find(s => s.state === 'active') || sessions[0])?.id ?? null);
      const group = groupSessionsByTime(sessions).find(group => group.sessions.some(s => s.id === selId));
      if (group) collapsedGroups.delete(group.key);
      listCursor = selId ? `session:${selId}` : null;
    }
  }

  // Remember scroll position per session so switching back and forth doesn't lose your place.
  function select(id) {
    const old = sessions.find(s => s.id === selId);
    if (old && cache.get(old.file)) cache.get(old.file).view = { scroll, cursor, follow };
    selId = id;
    listCursor = id ? `session:${id}` : null;
    const s = sessions.find(x => x.id === id);
    const v = s && cache.get(s.file)?.view;
    if (v) ({ scroll, cursor, follow } = v); else { scroll = 0; cursor = 0; follow = false; }
  }

  // Truncate/pad a string containing ANSI codes to exactly w columns.
  function fit(s, w, bg = '') {
    let o = bg, n = 0;
    for (let i = 0; i < s.length;) {
      if (s[i] === '\x1b') {
        const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i, i + 20));
        if (m) { o += m[0] === '\x1b[0m' ? m[0] + bg : m[0]; i += m[0].length; continue; }
      }
      const cp = s.codePointAt(i), ch = String.fromCodePoint(cp), cwv = cw(cp);
      if (n + cwv > w) break;
      o += ch; n += cwv; i += ch.length;
    }
    return o + ' '.repeat(Math.max(0, w - n)) + '\x1b[0m';
  }

  const icon = s => s.state === 'active' ? cyan('●') : s.state === 'done' ? gray('✓')
    : s.state === 'quiet' ? yellow('◌') : s.state === 'empty' ? gray('·') : red('✗');

  function sidebarItems() {
    const groups = groupSessionsByTime(sessions), items = [];
    for (const group of groups) {
      items.push({ key: `group:${group.key}`, group });
      if (!collapsedGroups.has(group.key)) for (const session of group.sessions) items.push({ key: `session:${session.id}`, group, session });
    }
    if (!items.some(item => item.key === listCursor)) listCursor = items.find(item => item.session?.id === selId)?.key
      || items.find(item => !item.session && item.group.sessions.some(s => s.id === selId))?.key || items[0]?.key || null;
    return items;
  }

  function toggleGroup(item, collapsed = !collapsedGroups.has(item.group.key)) {
    if (collapsed) collapsedGroups.add(item.group.key); else collapsedGroups.delete(item.group.key);
    listCursor = `group:${item.group.key}`;
    autoPick = false;
  }

  function listRows(w, h) {
    const items = sidebarItems(), content = [], hits = [];
    for (const item of items) {
      const focused = focus === 'list' && item.key === listCursor;
      if (!item.session) {
        const closed = collapsedGroups.has(item.group.key), containsSelected = item.group.sessions.some(s => s.id === selId);
        const mark = focused ? cyan('▌') : ' ';
        const label = `${closed ? '▸' : '▾'} ${item.group.label}  ${item.group.sessions.length}`;
        content.push(fit(`${mark} ${focused || containsSelected ? bold(label) : gray(label)}`, w, focused ? SEL_BG : ''));
        hits.push(item);
      } else {
        const s = item.session, selected = s.id === selId;
        const bg = focused || selected ? SEL_BG : '';
        const mark = focused ? cyan('▌') : selected ? gray('▌') : ' ';
        const title = safeText((s.title || s.prompt || '未命名任务').split('【桥接报告约定】')[0]);
        content.push(fit(`${mark} ${icon(s)} ${selected ? bold(cut(title, w - 5)) : cut(title, w - 5)}`, w, bg),
          fit(`${mark}   ${gray(cut(safeText(path.basename(s.cwd || '?')), w - 18))}  ${gray(ago(s.mtime))}${s.errors ? red(' !') : ''}`, w, bg), ' '.repeat(w));
        hits.push(item, item, null);
      }
    }
    const available = Math.max(1, h - 2), position = hits.findIndex(item => item?.key === listCursor);
    const itemHeight = items.find(item => item.key === listCursor)?.session ? 2 : 1;
    if (position < listTop) listTop = Math.max(0, position);
    if (position + itemHeight > listTop + available) listTop = position + itemHeight - available;
    listTop = Math.max(0, Math.min(listTop, content.length - available));
    const rows = [fit(gray('  最近任务'), w), ' '.repeat(w), ...content.slice(listTop, listTop + available)];
    listHits = [null, null, ...hits.slice(listTop, listTop + available)];
    if (!sessions.length) rows.push(fit(gray('  还没有会话'), w), fit(gray('  完成一次 dsb 任务后会显示在这里'), w));
    while (rows.length < h) rows.push(' '.repeat(w));
    return rows.slice(0, h);
  }

  const inDetail = () => (out.columns || 100) >= 100 ? focus === 'detail' : view === 'detail';

  function detailRows(w, h) {
    const s = sessions.find(x => x.id === selId);
    if (!s) return [fit(bold('任务与结果会显示在这里'), w), '', fit(gray('先运行 dsb run，再回来查看。'), w), ...Array.from({ length: Math.max(0, h - 3) }, () => ' '.repeat(w))];
    if (!cache.has(s.file)) load(s);
    const c = cache.get(s.file);
    const { lines, keys } = linesFor(c, w - 3);
    shown = { lines, keys, h, c };
    const maxTop = Math.max(0, lines.length - h);
    if (follow) { scroll = maxTop; cursor = lines.length - 1; }
    scroll = Math.max(0, Math.min(scroll, maxTop));
    cursor = Math.max(0, Math.min(cursor, lines.length - 1));
    const barH = Math.max(1, Math.round(h * h / Math.max(h, lines.length)));
    const barTop = Math.round((h - barH) * (maxTop ? scroll / maxTop : 0));
    const curKey = keys[cursor];
    const rows = [];
    if (help) {
      const notes = ['阅读方式', '', 'Tab  切换任务列表与正文', 'Enter / 空格  折叠时间组或展开内容', '← / →  收起 / 展开时间组', 'd  阅读结果 / 查看过程', 'r  显示思考', 'i  查看路径、ID和用量', 'f  展开全部内容', 'G  到底部并跟随', 'a  自动切换有更新的会话', 'u  检查并安装更新', 'b  完成提示音', '', '?  关闭帮助    q  退出'];
      return Array.from({ length: h }, (_, i) => fit(i === 0 ? bold(notes[i] || '') : gray(notes[i] || ''), w));
    }
    for (let i = 0; i < h; i++) {
      const idx = scroll + i, l = lines[idx];
      const bar = lines.length <= h ? ' ' : (i >= barTop && i < barTop + barH ? cyan('┃') : gray('│'));
      const onCursor = inDetail() && idx === cursor && !!keys[idx];
      const inBlock = inDetail() && curKey && keys[idx] === curKey;   // highlight the whole foldable block
      const lead = onCursor ? cyan('▌') : inBlock ? gray('▏') : ' ';
      rows.push(fit(l === undefined ? '' : lead + l, w - 1, onCursor ? SEL_BG : '') + bar);
    }
    return rows;
  }

  function draw() {
    frame++;
    const cols = out.columns || 100, rowsN = out.rows || 30;
    const split = cols >= 100;
    const bodyH = rowsN - 2;
    const running = sessions.filter(s => s.state === 'active').length;
    const title = ` ${bold('dsv')}  ${gray(DETAILS ? '过程' : '阅读')}  ${running ? cyan(`${running} 个会话有更新`) : ''}`;
    let status = '';
    if (DETAILS && !follow && inDetail()) status = gray('G 跟随最新内容') + '   ';
    if (flash && Date.now() < flash.until) status = bold(flash.text) + '   ';
    if (updateMessage) status = yellow(cut(updateMessage, Math.max(20, cols - width(title) - 14))) + ' ';
    else if (updateInfo?.available) status = yellow(`新版本 ${updateInfo.latest} · u 更新`) + ' ';
    const clockStr = status || gray(`v${PACKAGE.version}  `);
    const top = fit(title + ' '.repeat(Math.max(1, cols - width(title) - width(clockStr))) + clockStr, cols, BAR_BG);

    let bodyRows;
    if (split) {
      const L = Math.min(34, Math.max(28, Math.floor(cols * 0.25)));
      const left = listRows(L, bodyH), right = detailRows(cols - L - 1, bodyH);
      const sep = focus === 'detail' ? cyan('│') : gray('│');
      bodyRows = left.map((l, i) => l + sep + right[i]);
    } else {
      bodyRows = view === 'list' ? listRows(cols, bodyH) : detailRows(cols, bodyH);
    }

    const bottom = footer(cols);

    const f = ESC + 'H' + [top, ...bodyRows, bottom].join('\r\n');
    if (f !== lastFrame) { out.write(f); lastFrame = f; }
  }

  // Bottom menu bar: numbered on/off switches (click, or press the number / letter), context hint, quit button.
  const TOGGLES = [
    { key: '1', alt: 'a', label: '自动跟随', get: () => autoPick, run: () => { autoPick = !autoPick; if (autoPick) refresh(); } },
    { key: '2', alt: 'r', label: '思考', get: () => REASONING, run: () => { REASONING = !REASONING; invalidate(); } },
    { key: '3', alt: 'f', label: '全部展开', get: () => FULL, run: () => { FULL = !FULL; invalidate(); } },
    { key: '4', alt: 's', label: '系统消息', get: () => ALL, run: () => { ALL = !ALL; if (ALL) DETAILS = true; invalidate(); } },
    { key: '5', alt: 'b', label: '提示音', get: () => bell, run: () => { bell = !bell; } },
  ];
  function footer(cols) {
    footButtons = [];
    let s = '', x = 1;
    const button = (keyLabel, text, run) => {
      const w = width(` ${keyLabel} ${text} `);
      footButtons.push({ x0: x, x1: x + w - 1, run });
      s += ` ${bold(keyLabel)} ${gray(text)} `;
      x += w;
    };
    const actions = [['Tab', '切换', () => onKey('\t')], ['Enter', '展开', () => onKey('\r')], ['d', DETAILS ? '阅读' : '过程', () => onKey('d')], ['?', '帮助', () => onKey('?')]];
    if (updateInfo?.available || updateTask) actions.push(['u', updateTask ? '更新中' : '更新', () => { void installUpdate(draw); }]);
    for (const [key, text, run] of actions) if (x + width(` ${key} ${text} `) + 10 < cols) button(key, text, run);
    const gap = Math.max(1, cols - x - width(' q 退出 ')); s += ' '.repeat(gap); x += gap;
    button('q', '退出', quit);
    return fit(s, cols);
  }

  const invalidate = () => { for (const c of cache.values()) c.blocks = null; lastFrame = ''; };
  const move = d => {
    const items = sidebarItems(), i = items.findIndex(item => item.key === listCursor);
    const item = items[Math.max(0, Math.min(items.length - 1, i + d))];
    if (item?.session && item.session.id !== selId) select(item.session.id);
    if (item) listCursor = item.key;
    autoPick = false;
  };
  const page = () => Math.max(1, (out.rows || 30) - 4);
  const last = () => Math.max(0, shown.lines.length - 1);
  const keepVisible = () => {
    if (cursor < scroll) scroll = cursor;
    if (cursor >= scroll + shown.h) scroll = cursor - shown.h + 1;
  };
  const moveCursor = d => { cursor = Math.max(0, Math.min(last(), cursor + d)); follow = cursor >= last(); keepVisible(); };
  const scrollBy = d => {
    scroll = Math.max(0, Math.min(Math.max(0, shown.lines.length - shown.h), scroll + d));
    follow = false;
    cursor = Math.max(scroll, Math.min(scroll + shown.h - 1, cursor));
  };

  // Expand/collapse the block under line `idx`, keeping its first line at the same screen row.
  function toggle(idx) {
    const key = shown.keys[idx], c = shown.c;
    if (!key || !c) return false;
    const start = shown.keys.indexOf(key), row = start - scroll;
    if (c.open.has(key)) c.open.delete(key); else c.open.add(key);
    const { lines, keys } = linesFor(c, c.width);
    shown = { ...shown, lines, keys };
    const ns = keys.indexOf(key);
    cursor = ns; scroll = Math.max(0, ns - row); follow = false;
    // an expanded block that runs off the bottom: scroll just enough to show it (but never past its head)
    if (c.open.has(key)) {
      let end = ns; while (end + 1 < keys.length && keys[end + 1] === key) end++;
      if (end >= scroll + shown.h) scroll = Math.min(ns, end - shown.h + 1);
    }
    return true;
  }

  function onKey(k) {
    if (k === 'q' || k === '\x03') return quit();
    if (k === 'u') { void installUpdate(draw); return; }
    if (k === '?') { help = !help; draw(); return; }
    if (k === 'i') { info = !info; lastFrame = ''; draw(); return; }
    if (k === 'd') { DETAILS = !DETAILS; scroll = 0; cursor = 0; follow = false; invalidate(); draw(); return; }
    const t = TOGGLES.find(t => k === t.key || k === t.alt);
    if (t) t.run();
    else if (k === '\t') { focus = focus === 'list' ? 'detail' : 'list'; view = view === 'list' ? 'detail' : 'list'; }
    else if (k === '\x1b' || k === `${ESC}D` && inDetail()) { focus = 'list'; view = 'list'; }
    else if (inDetail()) {
      if (k === `${ESC}A` || k === 'k') moveCursor(-1);
      else if (k === `${ESC}B` || k === 'j') moveCursor(1);
      else if (k === `${ESC}5~`) { scrollBy(-page()); moveCursor(-page()); }
      else if (k === `${ESC}6~`) { scrollBy(page()); moveCursor(page()); }
      else if (k === 'g' || k === `${ESC}H` || k === `${ESC}1~`) { scroll = 0; cursor = 0; follow = false; }
      else if (k === 'G' || k === `${ESC}F` || k === `${ESC}4~`) follow = true;
      else if (k === '\r' || k === ' ' || k === `${ESC}C`) toggle(cursor);
      else if (k === 'e') { for (const key of shown.keys) if (key) shown.c?.open.add(key); }  // expand all in this session
      else if (k === 'E') shown.c?.open.clear();
    } else {
      const item = sidebarItems().find(item => item.key === listCursor);
      if (k === '\r' || k === ' ' || k === `${ESC}C`) {
        if (item && !item.session) toggleGroup(item, k === `${ESC}C` ? false : undefined);
        else { focus = 'detail'; view = 'detail'; }
      }
      else if (k === `${ESC}D` && item) toggleGroup(item, true);
      else if (k === `${ESC}A` || k === 'k') move(-1);
      else if (k === `${ESC}B` || k === 'j') move(1);
      else if (k === `${ESC}5~`) move(-5);
      else if (k === `${ESC}6~`) move(5);
      else if (k === 'g') move(-1e9);
      else if (k === 'G') move(1e9);
    }
    draw();
  }

  function onMouse(btn, x, y, press) {
    const cols = out.columns || 100, split = cols >= 100;
    const L = Math.min(34, Math.max(28, Math.floor(cols * 0.25)));
    const overList = split ? x <= L : view === 'list';
    if (btn === 0 && press && y === (out.rows || 30)) {
      const b = footButtons.find(b => x >= b.x0 && x <= b.x1);
      if (b) b.run();
    } else if (btn === 64 || btn === 65) {
      const d = btn === 64 ? -3 : 3;
      if (overList) move(Math.sign(d)); else scrollBy(d);
    } else if (btn === 0 && press && y >= 2 && y <= (out.rows || 30) - 1) {
      if (overList) {
        const item = listHits[y - 2];
        if (item) {
          listCursor = item.key;
          if (!item.session) { toggleGroup(item); focus = 'list'; draw(); return; }
          const openDetail = selId === item.session.id && !split;
          if (openDetail) view = 'detail';
          if (selId !== item.session.id) select(item.session.id);
          autoPick = false; focus = openDetail ? 'detail' : 'list';
        }
      } else {
        focus = 'detail';
        const idx = scroll + (y - 2);
        if (idx < shown.lines.length) { cursor = idx; if (!toggle(idx)) follow = cursor >= last(); }
      }
    }
    draw();
  }

  function onData(buf) {
    const s = buf.toString('utf8');
    const re = /\x1b\[<(\d+);(\d+);(\d+)([mM])|\x1b\[[0-9;]*[~A-Za-z]|\x1b|[\s\S]/g;
    let m;
    while ((m = re.exec(s))) {
      if (m[1] !== undefined) onMouse(+m[1], +m[2], +m[3], m[4] === 'M');
      else onKey(m[0]);
    }
  }

  let timers = [];
  function quit() {
    if (updateTask) { flash = { until: Date.now() + 5000, text: yellow('正在完成更新，请稍候') }; draw(); return; }
    timers.forEach(clearInterval);
    out.write(`${ESC}?1006l${ESC}?1000l${ESC}?25h${ESC}0m${ESC}?1049l`);
    try { inp.setRawMode(false); } catch {}
    process.exit(0);
  }
  process.on('SIGINT', quit);
  process.on('uncaughtException', e => { try { out.write(`${ESC}?1006l${ESC}?1000l${ESC}?25h${ESC}?1049l`); inp.setRawMode(false); } catch {} console.error(e); process.exit(1); });

  out.write(`${ESC}?1049h${ESC}?25l${ESC}2J${ESC}?1000h${ESC}?1006h`);
  inp.setRawMode(true); inp.resume(); inp.on('data', onData);
  out.on('resize', () => { out.write(`${ESC}2J`); invalidate(); draw(); });
  refresh(); draw();
  timers = [setInterval(() => { refresh(); draw(); }, 1000), setInterval(draw, 200)];
  void refreshUpdate(draw);
  timers.push(setInterval(() => { void refreshUpdate(draw); }, 60 * 60 * 1000));
}

const [cmd, a1] = flags.has('--help') ? ['help'] : args;
if (flags.has('--version')) console.log(PACKAGE.version);
else if (cmd === 'update') {
  try {
    if (flags.has('--recover')) console.log(JSON.stringify(await recoverUpdate({ confirmedStopped: flags.has('--confirmed-stopped') })));
    else if (flags.has('--auto')) {
      const value = argv[argv.indexOf('--auto') + 1];
      if (!['on', 'off'].includes(value)) throw new Error('用法：dsv update --auto on|off');
      console.log(JSON.stringify(setAutoUpdate(value === 'on')));
    } else {
      const info = await checkForUpdate({ force: true });
      if (flags.has('--check') || !info.available) { console.log(JSON.stringify(info)); if (info.error) process.exitCode = 1; }
      else console.log(JSON.stringify(await applyUpdate(info, { onProgress: message => console.error(message) })));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
else if ((!cmd || cmd === 'tui') && process.stdout.isTTY && process.stdin.isTTY) tui();
else if (!cmd || cmd === 'ls' || /^\d+$/.test(cmd)) ls(Number(/^\d+$/.test(cmd) ? cmd : a1) || 15);
else if (cmd === 'show' || cmd === 's') show(a1);
else if (cmd === 'watch' || cmd === 'w') watch(a1);
else console.log(`用法:\n  dsv [N]              最近 N 个会话\n  dsv show [ID|latest] 查看会话过程\n  dsv watch [ID]       实时跟踪\n  dsv update          检查并安装正式更新\n  dsv update --check  仅检查更新\n  dsv update --auto on|off  开关自动更新（默认关）\n  dsv update --recover --confirmed-stopped  确认旧进程退出后恢复更新预约\n选项: --details  --full  --reasoning  --all  --no-update-check  --version`);
