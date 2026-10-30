#!/usr/bin/env node
import fs from 'node:fs';
import { runJob, readJob, status, result, retryJob, reviewJob, cancelJob, unlockJob, stats, briefText, sendMessage, answerRequest, eventsPage, waitJob } from '../lib/bridge.mjs';

const usage = `dsb — dpsk-bridge: host-neutral, bidirectional DeepSeek delegation
  dsb run --cwd <project> --brief <file> [--patch <file> ...] [--image <file> ...] [--timeout <seconds>]
    [--provider <route>] [--model <name>] [--notify-cmd <command>]
    [--max-concurrent <1..256>] [--scope <path> ...] [--read-only] [--resource <name> ...]
  dsb status <id> | result <id> | cancel <id>
  dsb wait <id> [--timeout <seconds>]
  dsb send <id> --message-file <file>
  dsb answer <id> --request <requestId> --answer <json-file>
  dsb events <id> [--after <byte-cursor>] [--limit <1..200>]
  dsb retry <id> --feedback <file> [--notify-cmd <command>]
  dsb review <id> --verdict accepted|rework|blocked --note <verification evidence> [--accounting <json>]
    accounting JSON: {"currency":"CNY","source":"<source>","<host>Cost":<number>,"deepseekCost":<number>} (any key ending in Cost is recorded)
  dsb unlock <id> --confirmed-stopped
  dsb stats
Run/retry stay attached until the job ends: keep the process/session handle your host provides and wait for them with "dsb wait" and read events and requests after each return (see the deepseek-delegate skill).
SDK defaults: deepseek-official / deepseek-flash (override with DPSK_PROVIDER/DPSK_MODEL).
Global concurrency defaults to 8 (DPSK_CONCURRENCY); scopes/resources are cooperative declarations.
send/answer queue input; events confirms delivery. Followups enter the next turn.
wait returns once when the job ends (finished), the launcher died (unknown), a request needs an answer (request), or --timeout (default 600s, 1-3600) elapses (timeout).
A request with an answer already queued or delivered does not wake wait again until it is rejected.
A finished wait does not mean success; handle request results with events/answer. wait makes no model call.
--notify-cmd runs a local command after the job ends and once per new request (max 30s; failures do not affect the job).
It reads DSB_JOB_ID / DSB_EVENT / DSB_STATE / DSB_RESULT / DSB_REQUEST_ID from the environment.
No model call is made by status/result/events/wait/cancel/review/unlock/stats.
--dsh-entry <path/to/dsh/lib/bin.js> overrides local CLI discovery for run.`;
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
function parse(args, allowed) {
  const out = { patch: [], scope: [], resource: [], image: [] };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!allowed.includes(key)) throw new Error(`Unknown option: ${key}`);
    if (key === '--confirmed-stopped') { out.confirmedStopped = true; continue; }
    if (key === '--read-only') { out.readOnly = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    const name = key.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    if (['patch', 'scope', 'resource', 'image'].includes(name)) out[name].push(value);
    else { if (name in out) throw new Error(`Duplicate option: ${key}`); out[name] = value; }
  }
  return out;
}
try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command)) console.log(usage);
  else if (command === 'run') {
    const options = parse(args, ['--cwd', '--brief', '--patch', '--image', '--timeout', '--dsh-entry', '--provider', '--model', '--max-concurrent', '--scope', '--read-only', '--resource', '--notify-cmd']);
    if (!options.brief) throw new Error('--brief is required');
    const job = await runJob(options, emit); emit({ event: 'finished', ...result(job) });
    process.exitCode = job.processState === 'completed' && job.reportedResult === 'OK' ? 0 : 1;
  } else if (command === 'stats') {
    parse(args, []); emit(stats());
  } else {
    if (!['status', 'result', 'retry', 'review', 'cancel', 'unlock', 'send', 'answer', 'events', 'wait'].includes(command)) throw new Error(`Unknown command: ${command}`);
    const [id, ...rest] = args;
    const options = parse(rest, { status: [], result: [], cancel: [], retry: ['--feedback', '--notify-cmd'], review: ['--verdict', '--note', '--accounting'], unlock: ['--confirmed-stopped'], send: ['--message-file'], answer: ['--request', '--answer'], events: ['--after', '--limit'], wait: ['--timeout'] }[command]);
    const job = readJob(id || '');
    if (command === 'status') emit(status(job));
    else if (command === 'wait') emit(await waitJob(job, options.timeout));
    else if (command === 'result') emit(result(job));
    else if (command === 'cancel') emit(cancelJob(job));
    else if (command === 'unlock') emit(await unlockJob(job, options.confirmedStopped));
    else if (command === 'send') { if (!options.messageFile) throw new Error('--message-file is required'); emit(sendMessage(job, briefText(options.messageFile, 'Message'))); }
    else if (command === 'answer') { if (!options.answer) throw new Error('--answer is required'); emit(answerRequest(job, options.request, JSON.parse(briefText(options.answer, 'Answer')))); }
    else if (command === 'events') emit(eventsPage(job, options.after, options.limit));
    else if (command === 'review') emit(reviewJob(job, options.verdict, options.note, undefined,
      options.accounting ? JSON.parse(fs.readFileSync(options.accounting, 'utf8').replace(/^\uFEFF/, '')) : null));
    else {
      if (!options.feedback) throw new Error('--feedback is required');
      const next = await retryJob(job, briefText(options.feedback, 'Feedback'), emit, undefined, options.notifyCmd);
      emit({ event: 'finished', ...result(next) });
      process.exitCode = next.processState === 'completed' && next.reportedResult === 'OK' ? 0 : 1;
    }
  }
} catch (error) { emit({ error: error.message }); process.exitCode = 1; }
