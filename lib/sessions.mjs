import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const tokenKeys = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_EVENTS = 200_000;

function parseLines(buf) {
  const events = []; let invalidLines = 0;
  let at = 0, next;
  while ((next = buf.indexOf(10, at)) !== -1) {
    const line = buf.subarray(at, next).toString('utf8');
    at = next + 1;
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') invalidLines++;
      else events.push(event);
    } catch { invalidLines++; }
    if (events.length > MAX_EVENTS) throw new Error('Session exceeds the 200000 event reader limit');
  }
  return { events, invalidLines, end: at, complete: at === buf.length && invalidLines === 0 };
}

// RFC 8878, sections 3.1.1 and 3.1.2. Parse lengths, not magic-byte matches
// inside payloads. Node's decompressor can return partial output for a tail.
function frameEnd(buf, start) {
  if (start + 4 > buf.length) return null;
  const magic = buf.readUInt32LE(start);
  if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
    if (start + 8 > buf.length) return null;
    const end = start + 8 + buf.readUInt32LE(start + 4);
    return end <= buf.length ? end : null;
  }
  if (magic !== 0xfd2fb528) throw new Error('Unsupported zstd frame');
  if (start + 5 > buf.length) return null;
  const descriptor = buf[start + 4], single = (descriptor & 0x20) !== 0;
  if (descriptor & 8) throw new Error('Reserved zstd frame bit');
  const contentSizeBytes = [single ? 1 : 0, 2, 4, 8][descriptor >>> 6];
  let at = start + 5 + (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3] + contentSizeBytes;
  for (;;) {
    if (at + 3 > buf.length) return null;
    const block = buf.readUIntLE(at, 3), type = (block >>> 1) & 3;
    if (type === 3) throw new Error('Reserved zstd block type');
    at += 3 + (type === 1 ? 1 : block >>> 3);
    if (at > buf.length) return null;
    if (block & 1) { at += descriptor & 4 ? 4 : 0; return at <= buf.length ? at : null; }
  }
}

// dsh's concatenated zstd log is versioned, private storage. Incomplete tails
// remain unread until a complete frame arrives; callers surface partial data.
export function decodeFrom(buf, start = 0) {
  const events = [];
  let end = start, at = start, invalidLines = 0, carry = Buffer.alloc(0), pending = [], decodedBytes = 0, committedBytes = 0, committedInvalid = 0;
  while (at < buf.length) {
    let next, decoded;
    try {
      next = frameEnd(buf, at);
      if (next === null) break;
      decoded = zlib.zstdDecompressSync(buf.subarray(at, next), { maxOutputLength: 64 * 1024 * 1024 });
    } catch (error) { return { events, end, invalidLines: committedInvalid, decodedBytes: committedBytes, complete: false, error: error.message }; }
    decodedBytes += decoded.length;
    if (decodedBytes > MAX_BYTES) throw new Error('Session exceeds the 128 MiB decoded reader limit');
    carry = Buffer.concat([carry, decoded]);
    let newline;
    while ((newline = carry.indexOf(10)) !== -1) {
      const line = carry.subarray(0, newline).toString('utf8');
      carry = carry.subarray(newline + 1);
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') invalidLines++;
        else pending.push(event);
      } catch { invalidLines++; }
      if (pending.length + events.length > MAX_EVENTS) throw new Error('Session exceeds the 200000 event reader limit');
    }
    at = next;
    // Only advance an incremental reader past complete JSONL records. If a
    // frame splits a record (or a UTF-8 character), re-read it on the next tick.
    if (!carry.length) { for (const event of pending) events.push(event); pending = []; end = next; committedBytes = decodedBytes; committedInvalid = invalidLines; }
  }
  return { events, end, invalidLines: committedInvalid, complete: end === buf.length && invalidLines === 0, decodedBytes: committedBytes };
}

/** Read complete JSONL records only; an unfinished live tail is retried later. */
export function readEvents(file) {
  return createEventReader(file).read();
}

/**
 * Own one bounded incremental log reader. Appends read only new physical bytes;
 * truncation or file replacement resets the retained transcript. No global cache.
 */
export function createEventReader(file, { maxBytes = MAX_BYTES, maxEvents = MAX_EVENTS } = {}) {
  let identity, offset = 0, size = -1, mtime = -1, events = [], invalidLines = 0, decodedBytes = 0, snapshot;
  return {
    read() {
      const stat = fs.statSync(file);
      if (stat.size > maxBytes) throw new Error(`Session exceeds the ${maxBytes} byte reader limit`);
      const currentIdentity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      const reset = identity !== currentIdentity || stat.size < size || (stat.size === size && stat.mtimeMs !== mtime);
      if (!reset && stat.size === size) return { ...snapshot, added: [], reset: false, bytesRead: 0 };
      if (reset) { offset = 0; events = []; invalidLines = 0; decodedBytes = 0; }
      const remaining = stat.size - offset;
      const buf = Buffer.alloc(remaining);
      const fd = fs.openSync(file, 'r');
      let bytesRead = 0;
      try {
        while (bytesRead < remaining) {
          const count = fs.readSync(fd, buf, bytesRead, remaining - bytesRead, offset + bytesRead);
          if (!count) break;
          bytesRead += count;
        }
      } finally { fs.closeSync(fd); }
      const decoded = file.endsWith('.zstd') ? decodeFrom(buf.subarray(0, bytesRead)) : parseLines(buf.subarray(0, bytesRead));
      const nextBytes = decodedBytes + (decoded.decodedBytes ?? decoded.end);
      if (nextBytes > maxBytes || events.length + decoded.events.length > maxEvents) throw new Error('Session exceeds retained reader limits');
      events = events.concat(decoded.events);
      decodedBytes = nextBytes;
      offset += decoded.end;
      invalidLines += decoded.invalidLines;
      identity = currentIdentity; size = stat.size; mtime = stat.mtimeMs;
      snapshot = { events, end: offset, invalidLines, complete: offset === size && invalidLines === 0 && !decoded.error,
        ...(decoded.error ? { error: decoded.error } : {}), retainedBytes: decodedBytes };
      return { ...snapshot, added: decoded.events, reset, bytesRead };
    },
  };
}

/** Discover canonical generations in project/session directories or a direct session root. */
export function listSessionFiles(root) {
  const found = [];
  function visit(folder, depth) {
    let entries; try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
    const generations = entries.filter(e => e.isFile()).flatMap(e => {
      const match = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/.exec(e.name);
      if (!match || !Number.isSafeInteger(Number(match[1] ?? 0)) || Number(match[1] ?? 0) < 4) return [];
      const file = path.join(folder, e.name);
      try { const stat = fs.statSync(file); return [{ file, version: Number(match[1] ?? 0), compressed: !!match[2], mtime: stat.mtimeMs }]; }
      catch { return []; }
    }).sort((a, b) => b.version - a.version || b.mtime - a.mtime || Number(b.compressed) - Number(a.compressed));
    if (generations.length) {
      const id = path.basename(folder).replace(/^session-/, '').replace(/~([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
      found.push({ id, ...generations[0] });
      return;
    }
    if (depth < 2) for (const entry of entries) if (entry.isDirectory()) visit(path.join(folder, entry.name), depth + 1);
  }
  visit(root, 0);
  return found.sort((a, b) => b.mtime - a.mtime);
}

export function sessionState(openTurns, lastEnd, mtime, now = Date.now()) {
  if (openTurns > 0) return now - mtime < 5 * 60e3 ? 'active' : 'quiet';
  return lastEnd === 'completed' ? 'done' : (lastEnd || 'empty');
}

function usageSample(event) {
  if (event.type === 'assistant/message' && event.data?.usage) return event.data.usage;
  for (const record of [...(event.data?.stream || [])].reverse()) {
    if (record.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage;
  }
  return null;
}

// Match dsh usage semantics: final settlement replaces the
// same turn/step's attempt sample; a retry boundary starts a new billed attempt.
// Reasoning is already included in outputTokens and must not be added again.
export function collectUsage(events) {
  const attempts = [];
  let previous = null, missing = 0;
  for (const event of events) {
    const data = event.data || {};
    if (event.type === 'llm/retry-started') {
      if (previous?.turn === data.turn && previous?.step === data.step) previous = null;
      continue;
    }
    if (!['assistant/message', 'assistant/attempt'].includes(event.type)) continue;
    const sample = usageSample(event);
    if (!sample) { missing++; continue; }
    const values = [sample.inputTokens, sample.outputTokens, sample.cacheReadTokens, sample.cacheWriteTokens];
    if (!values.every((v, i) => (i >= 2 && v === undefined) || (Number.isSafeInteger(v) && v >= 0)) ||
      !Number.isInteger(data.turn) || !Number.isInteger(data.step)) { missing++; continue; }
    const replacing = previous && previous.turn === data.turn && previous.step === data.step;
    const total = sample.totalTokens ?? (values.every(v => v !== undefined) ? values.reduce((a, b) => a + b, 0) : undefined);
    const knownTotal = values.reduce((sum, value) => sum + (value ?? 0), 0);
    if (total !== undefined && (!Number.isSafeInteger(total) || total < knownTotal || (values.every(v => v !== undefined) && total !== knownTotal))) { missing++; continue; }
    if (sample.reasoningTokens !== undefined && (!Number.isSafeInteger(sample.reasoningTokens) || sample.reasoningTokens < 0 || sample.reasoningTokens > sample.outputTokens)) { missing++; continue; }
    const attempt = { turn: data.turn, step: data.step, values, total, reasoning: sample.reasoningTokens };
    if (replacing) attempts[attempts.length - 1] = attempt;
    else attempts.push(attempt);
    previous = attempt;
  }
  const sum = values => {
    if (values.some(v => !Number.isSafeInteger(v) || v < 0)) return null;
    const total = values.reduce((a, b) => a + b, 0);
    return Number.isSafeInteger(total) ? total : null;
  };
  const samples = attempts.length;
  const totals = Object.fromEntries(tokenKeys.map((key, index) => [key, sum(attempts.map(attempt => attempt.values[index]))]));
  return { available: samples > 0, scope: 'matched_session_only', samples, missingSamples: missing,
    tokens: samples ? totals : null, totalTokens: samples ? sum(attempts.map(attempt => attempt.total)) : null,
    reasoningTokens: samples ? sum(attempts.map(attempt => attempt.reasoning)) : null };
}

export function matchSession(root, marker, startedAt) {
  const matches = []; let unreadable = 0;
  for (const session of listSessionFiles(root)) {
    if (session.mtime < startedAt - 2000) continue;
    try {
      const decoded = readEvents(session.file);
      if (!decoded.events.some(e => e.type === 'user/message' && e.data?.source?.kind === 'user' &&
        e.data.content?.some(p => p.type === 'text' && p.text?.endsWith('\n' + marker + '\n')))) continue;
      matches.push({ ...session, logComplete: decoded.complete, usage: collectUsage(decoded.events) });
    } catch { unreadable++; }
  }
  if (matches.length !== 1) return { matched: false, reason: matches.length ? 'ambiguous_session' : 'session_not_found', unreadable };
  return { matched: true, ...matches[0] };
}
