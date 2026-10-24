import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectUsage, createEventReader, decodeFrom, listSessionFiles, matchSession, readEvents } from '../lib/sessions.mjs';

// Fixtures follow dsh 0.2.1-rc.3's core/session/types.ts, llm/message.ts,
// llm/assistant-stream.ts and session-persistence-jsonl/format.ts.
const header = (version = 4, id = 'fixture') => ({ type: 'session', version, id, createdAt: 1000, cwd: '/project', isSeeded: false, delegationDepth: 0 });
const event = (type, data, seq = 1) => ({ type, data, seq, time: 1000 + seq });
const text = value => [{ type: 'text', text: value }];
const usage = (inputTokens = 10, outputTokens = 4) => ({ inputTokens, outputTokens, cacheReadTokens: 3, cacheWriteTokens: 0, reasoningTokens: 2 });
const jsonl = events => Buffer.from(events.map(e => JSON.stringify(e)).join('\n') + '\n');
const cli = fileURLToPath(new URL('../bin/dsv.mjs', import.meta.url));
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-sessions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(root, relative, bytes) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  return file;
}

test('discovery selects numeric newest generation and ignores staging/noncanonical files', t => {
  const root = temporary(t);
  write(root, 'project/id/session.v3.jsonl.zstd', zlib.zstdCompressSync(jsonl([header(3)])));
  const newest = write(root, 'project/id/session.v4.jsonl', jsonl([header()]));
  for (const name of ['session.v04.jsonl', 'session.v0.jsonl', 'session.v99.jsonl.tmp', 'session.v9007199254740992.jsonl']) write(root, `project/id/${name}`, 'bad');
  write(root, 'project/session-old/session.v3.jsonl', jsonl([header(3, 'old')]));
  write(root, 'direct/session.v4.jsonl.zstd', zlib.zstdCompressSync(jsonl([header(4, 'direct')])));
  const found = listSessionFiles(root);
  assert.equal(found.length, 2);
  assert.equal(found.find(s => s.id === 'id').file, newest);
  assert.ok(!found.some(s => s.id === 'old'));
  const v10 = write(root, 'project/id/session.v10.jsonl', jsonl([header(10)]));
  assert.equal(listSessionFiles(root).find(s => s.id === 'id').file, v10);
});

test('plaintext live tails retain the last complete offset and append without rereading the prefix', t => {
  const root = temporary(t), first = jsonl([header()]);
  const second = jsonl([event('user/message', { role: 'user', source: { kind: 'user' }, content: text('你好') })]);
  const file = write(root, 'session.v4.jsonl', Buffer.concat([first, second.subarray(0, second.length - 3)]));
  const reader = createEventReader(file);
  const initial = reader.read();
  assert.equal(initial.events.length, 1); assert.equal(initial.end, first.length); assert.equal(initial.complete, false);
  assert.equal(reader.read().bytesRead, 0);
  fs.appendFileSync(file, second.subarray(second.length - 3));
  const next = reader.read();
  assert.equal(next.events.length, 2); assert.equal(next.added.length, 1); assert.equal(next.complete, true);
  assert.equal(next.bytesRead, second.length);
  const third = jsonl([event('turn/start', { turn: 1 }, 2)]);
  fs.appendFileSync(file, third);
  assert.equal(reader.read().bytesRead, third.length);
  assert.equal(reader.read().added.length, 0);
});

test('reader resets after truncation and file replacement, including replacement with the same size', t => {
  const root = temporary(t), file = write(root, 'session.v4.jsonl', jsonl([header(), event('turn/start', { turn: 1 })]));
  const reader = createEventReader(file); reader.read();
  fs.writeFileSync(file, jsonl([header()]));
  assert.equal(reader.read().reset, true);
  const replacement = write(root, 'replacement', jsonl([header(4, 'changed')]));
  fs.unlinkSync(file);
  fs.copyFileSync(replacement, file);
  const result = reader.read();
  assert.equal(result.reset, true); assert.equal(result.events[0].id, 'changed');
});

test('concatenated zstd frames defer torn frames and records split across UTF-8 bytes', t => {
  const root = temporary(t), a = zlib.zstdCompressSync(jsonl([header()]));
  const line = jsonl([event('user/message', { source: { kind: 'user' }, content: text('桥') })]);
  const split = line.indexOf(Buffer.from('桥')) + 1;
  const b = zlib.zstdCompressSync(line.subarray(0, split)), c = zlib.zstdCompressSync(line.subarray(split));
  const file = write(root, 'session.v4.jsonl.zstd', Buffer.concat([a, b, c.subarray(0, c.length - 1)]));
  const reader = createEventReader(file);
  const initial = reader.read();
  assert.equal(initial.events.length, 1); assert.equal(initial.end, a.length); assert.equal(initial.complete, false);
  fs.appendFileSync(file, c.subarray(c.length - 1));
  const done = reader.read();
  assert.equal(done.events.length, 2); assert.equal(done.events[1].data.content[0].text, '桥');
  assert.equal(done.complete, true); assert.equal(done.bytesRead, b.length + c.length);
});

test('malformed committed records and invalid zstd are surfaced without trusting a partial JSON tail', t => {
  const root = temporary(t);
  const file = write(root, 'session.v4.jsonl', Buffer.concat([jsonl([header()]), Buffer.from('null\n{"noType":1}\nnot json\n{"type":"partial"}')]));
  const decoded = readEvents(file);
  assert.equal(decoded.events.length, 1); assert.equal(decoded.invalidLines, 3); assert.equal(decoded.complete, false);
  const invalid = decodeFrom(Buffer.from('not a zstd frame'));
  assert.equal(invalid.complete, false); assert.match(invalid.error, /zstd/);
});

test('reader enforces physical, decoded, and retained event limits', t => {
  const root = temporary(t), data = jsonl([header(), event('turn/start', { turn: 1 })]);
  const plain = write(root, 'session.v4.jsonl', data);
  assert.throws(() => createEventReader(plain, { maxBytes: data.length - 1 }).read(), /limit/);
  assert.throws(() => createEventReader(plain, { maxEvents: 1 }).read(), /limit/);
  const compressed = write(root, 'compressed/session.v4.jsonl.zstd', zlib.zstdCompressSync(jsonl([header(), event('user/message', { content: text('x'.repeat(5000)) })])));
  assert.throws(() => createEventReader(compressed, { maxBytes: 1000 }).read(), /limit/);
});

test('many independent readers retain session-local offsets and read only each appended frame', t => {
  const root = temporary(t);
  const readers = Array.from({ length: 64 }, (_, index) => {
    const file = write(root, `project/id-${index}/session.v4.jsonl.zstd`, zlib.zstdCompressSync(jsonl([header(4, `id-${index}`)])));
    const reader = createEventReader(file);
    assert.equal(reader.read().events[0].id, `id-${index}`);
    return { file, reader };
  });
  for (let index = 0; index < readers.length; index++) {
    const { file, reader } = readers[index];
    const frame = zlib.zstdCompressSync(jsonl([event('session/title', { title: `title-${index}` })]));
    fs.appendFileSync(file, frame);
    const result = reader.read();
    assert.equal(result.bytesRead, frame.length); assert.equal(result.events.length, 2);
    assert.equal(result.added[0].data.title, `title-${index}`); assert.equal(reader.read().bytesRead, 0);
  }
});

test('usage counts retried attempts, latest compact stream usage, and final settlement replacement', () => {
  const attempt = event('assistant/attempt', { turn: 1, step: 1, stream: [
    { type: 'text-chunks', time0: 10, index: 0, dt: [1], texts: ['a', 'b'] },
    { type: 'chunk', time: 12, chunk: { type: 'usage', usage: usage(5, 2) } },
  ] });
  const events = [attempt, event('llm/retry-started', { turn: 1, step: 1 }),
    event('assistant/message', { turn: 1, step: 1, usage: usage(10, 4), stream: [], message: { content: text('done') } }),
    event('assistant/message', { turn: 2, step: 1, usage: usage(1, 2), stream: [] })];
  const result = collectUsage(events);
  assert.equal(result.samples, 3); assert.equal(result.tokens.uncachedInputTokens, 16); assert.equal(result.tokens.outputTokens, 8);
  assert.equal(result.reasoningTokens, 6);
  assert.equal(result.totalTokens, 33);
  const replaced = collectUsage([attempt, event('assistant/message', { turn: 1, step: 1, usage: usage(7, 3) })]);
  assert.equal(replaced.samples, 1); assert.equal(replaced.tokens.uncachedInputTokens, 7);
});

test('usage never reports absent buckets as zero, rejects contradictory totals, and bounds sums', () => {
  const message = value => event('assistant/message', { turn: 1, step: 1, usage: value });
  const partial = collectUsage([message({ inputTokens: 8, outputTokens: 4, totalTokens: 15 })]);
  assert.equal(partial.tokens.cacheReadTokens, null); assert.equal(partial.tokens.cacheWriteTokens, null); assert.equal(partial.totalTokens, 15);
  assert.equal(collectUsage([message({ ...usage(), totalTokens: 1 })]).available, false);
  assert.equal(collectUsage([message({ ...usage(), outputTokens: -1 })]).missingSamples, 1);
  const overflow = collectUsage([message({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }), event('assistant/message', { turn: 2, step: 1, usage: { inputTokens: 1, outputTokens: 1 } })]);
  assert.equal(overflow.tokens.uncachedInputTokens, null);
  assert.equal(collectUsage([]).available, false);
});

test('matching recognizes latest v4 plaintext and does not count stale generations twice', t => {
  const root = temporary(t), marker = 'bridge-run';
  const content = jsonl([header(), event('user/message', { role: 'user', source: { kind: 'user' }, content: text(`task\n${marker}\n`) })]);
  write(root, 'project/id/session.v3.jsonl.zstd', zlib.zstdCompressSync(content));
  write(root, 'project/id/session.v4.jsonl', content);
  const match = matchSession(root, marker, Date.now() - 1000);
  assert.equal(match.matched, true); assert.equal(match.version, 4); assert.equal(match.logComplete, true);
  write(root, 'project/other/session.v4.jsonl', content);
  assert.equal(matchSession(root, marker, Date.now() - 1000).reason, 'ambiguous_session');
});

test('CLI renders current v4 tool results, system/developer events, structured errors, and usage', t => {
  const root = temporary(t);
  const rows = [header(), event('turn/start', { turn: 1 }),
    event('user/message', { id: 'u', role: 'user', source: { kind: 'user' }, content: text('current prompt') }, 2),
    event('system/message', { turn: 1, step: 1, message: { role: 'system', content: text('system context') } }, 3),
    event('developer/message', { turn: 1, step: 1, message: { role: 'developer', content: text('developer update') } }, 4),
    event('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'tool', arguments: '{}' }, 5),
    event('tool/result', { turn: 1, step: 1, message: { id: 't', role: 'tool', source: { kind: 'tool' }, toolCallId: 'call-1', isError: true, content: text('native tool output') } }, 6),
    event('assistant/message', { turn: 1, step: 1, message: { id: 'a', role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'fixture' }, content: text('final response') }, stream: [], usage: usage() }, 7),
    event('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'structured failure' } } }, 8)];
  write(root, 'sessions/project/id/session.v4.jsonl', jsonl(rows));
  const result = spawnSync(process.execPath, [cli, 'show', 'latest', '--all', '--full'], { encoding: 'utf8', env: { ...process.env, DSH_HOME: root, DSH_SESSIONS_ROOT: '' } });
  assert.equal(result.status, 0, result.stderr);
  for (const value of ['current prompt', 'system context', 'developer update', 'native tool output', 'final response', 'structured failure', '输入 10', '1 个错误']) assert.ok(result.stdout.includes(value), value);
});

test('CLI reads current compressed sessions from a configured root', t => {
  const root = temporary(t);
  const rows = [header(), event('user/message', { source: { kind: 'user' }, content: text('current prompt') }),
    event('tool/result', { message: { role: 'tool', toolCallId: 'call', content: text('current tool output') } }, 2)];
  write(root, 'project/session-current/session.v4.jsonl.zstd', zlib.zstdCompressSync(jsonl(rows)));
  const result = spawnSync(process.execPath, [cli, 'show', 'current', '--full'], { encoding: 'utf8', env: { ...process.env, DSH_SESSIONS_ROOT: root } });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /current prompt/); assert.match(result.stdout, /current tool output/);
});
