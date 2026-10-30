import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runJob, readJob, waitJob, sendMessage, answerRequest, cancelJob, retryJob, eventsPage } from '../lib/bridge.mjs';

const fake = `
import readline from 'node:readline';
const write = m => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
let sessionId, prompt='', extra='', answer=false, mode='', seq=0, finished=false;
const waiting=[];
const event=(type,data)=>write({method:'session.event',params:{sessionId,event:{type,seq:++seq,time:Date.now(),data}}});
const finish=()=>{
 if(finished || mode==='hold' || (mode==='chat' && (!extra || !answer)))return;
 finished=true;
 event('assistant/message',{turn:1,step:1,message:{role:'assistant',content:[{type:'text',text:'RESULT: OK\\n'+extra}]},usage:{inputTokens:10,outputTokens:4,cacheReadTokens:0,cacheWriteTokens:0}});
 event('assistant/message',{turn:1,step:2,message:{role:'assistant',content:[{type:'reasoning',text:'no additional answer'}]}});
 event('turn/end',{turn:1,reason:{kind:'completed'}});
 for(const id of waiting.splice(0))write({id,result:{}});
};
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize'){write({id:m.id,result:{serverInfo:{name:'deepseek-harness-sdk-runtime',version:'0.0.1'}}});}
 else if(m.method==='session/prompt'){
  sessionId=m.params.sessionId;
  const text=m.params.contentBlocks[0].text;
  if(!prompt){prompt=text;mode=text.includes('[chat]')?'chat':text.includes('[hold]')?'hold':'simple';
   event('user/message',{source:{kind:'user'},content:[{type:'text',text}]});
   if(mode==='chat')write({id:'ask-rpc-1',method:'user-question/ask',params:{requestId:'question-1',sessionId,questions:[{id:'choice',question:'Proceed?',options:[]}]}});
  }else extra=text;
  write({id:m.id,result:{messageId:'message-'+seq}});setTimeout(finish,30);
 }else if(m.method==='session/wait'){if(finished)write({id:m.id,result:{}});else waiting.push(m.id);}
 else if(m.method==='shutdown'){write({id:m.id,result:{}});setTimeout(()=>process.exit(0),10);}
 else if(m.id==='ask-rpc-1'){answer=!!m.result.answers;finish();}
});
`;

// Sends the same requestId twice; only one notification should be sent.
const duplicateRequestFake = `
import readline from 'node:readline';
const write = m => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
let sessionId, answered=false, waitId, seq=0, finished=false;
const event=(type,data)=>write({method:'session.event',params:{sessionId,event:{type,seq:++seq,time:Date.now(),data}}});
const question=()=>write({id:'same-rpc',method:'user-question/ask',params:{requestId:'same-request',sessionId,questions:[{id:'choice',question:'Proceed?',options:[]}]}});
const finish=()=>{
 if(finished||!answered)return;finished=true;
 event('assistant/message',{turn:1,step:1,message:{role:'assistant',content:[{type:'text',text:'RESULT: OK'}]}});
 event('turn/end',{turn:1,reason:{kind:'completed'}});
 if(waitId)write({id:waitId,result:{}});
};
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')write({id:m.id,result:{serverInfo:{name:'deepseek-harness-sdk-runtime'}}});
 else if(m.method==='session/prompt'){sessionId=m.params.sessionId;question();question();write({id:m.id,result:{messageId:'m'}});}
 else if(m.method==='session/wait'){if(finished)write({id:m.id,result:{}});else waitId=m.id;}
 else if(m.method==='shutdown'){write({id:m.id,result:{}});setTimeout(()=>process.exit(0),10);}
 else if(m.id==='same-rpc'){answered=true;finish();}
});
`;

function setup(t, brief) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'runtime', 'lib'), { recursive: true });
  const entry = path.join(root, 'runtime', 'lib', 'bin.mjs'); fs.writeFileSync(entry, fake);
  fs.writeFileSync(path.join(root, 'runtime', 'package.json'), JSON.stringify({ version: '0.2.1-rc.3' }));
  const briefFile = path.join(root, 'brief.md'); fs.writeFileSync(briefFile, brief);
  return { root, home: path.join(root, 'bridge'), options: { cwd: root, brief: briefFile, dshEntry: entry, timeout: 10 } };
}

function nodeCommand(root, name, source) {
  const file = path.join(root, name + '.mjs');
  fs.writeFileSync(file, source);
  return { file, command: `node "${file}"` };
}

function envNotifier(root, name, out) {
  return nodeCommand(root, name, `
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(out)}, JSON.stringify({
  event: process.env.DSB_EVENT, job: process.env.DSB_JOB_ID, state: process.env.DSB_STATE,
  result: process.env.DSB_RESULT, request: process.env.DSB_REQUEST_ID ?? null, argv: process.argv.slice(2),
}) + '\\n');
`).command;
}

function background(t, options, home, onEvent = () => {}) {
  let id;
  const started = Promise.withResolvers();
  const running = runJob(options, event => {
    if (event.event === 'started') { id = event.id; started.resolve(id); }
    onEvent(event);
  }, home);
  running.catch(error => started.reject(error));
  t.after(async () => {
    try {
      const latest = readJob(id, home);
      if (!['completed', 'failed', 'timed_out', 'cancelled', 'launch_failed', 'cleanup_failed'].includes(latest.processState))
        cancelJob(latest, home);
    } catch {}
    await running.catch(() => {});
  });
  return { started: started.promise, running };
}

function outputRecords(out) {
  return fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function waitForEvent(id, home, name, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = eventsPage(readJob(id, home), 0, 200).events.find(event => event.event === name);
    if (found) return found;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for event ${name}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('wait returns finished immediately for a terminal job', async t => {
  const { options, home } = setup(t, 'wait finished');
  const job = await runJob(options, () => {}, home);
  const began = Date.now();
  const waited = await waitJob(job, 5, home);
  assert.equal(waited.event, 'wait');
  assert.equal(waited.reason, 'finished');
  assert.equal(waited.id, job.id);
  assert.equal(waited.processState, 'completed');
  assert.equal(waited.reportedResult, 'OK');
  assert.ok(Date.now() - began < 1000);
});

test('wait returns request for a pending question and finished after the answer', async t => {
  const { options, home } = setup(t, '[chat] answer me');
  const { started, running } = background(t, options, home);
  const id = await started;
  const request = await waitJob({ id }, 10, home);
  assert.equal(request.reason, 'request');
  assert.equal(request.processState, 'running');
  assert.equal(request.pendingRequests.length, 1);
  assert.deepEqual(request.actionableRequests, [request.pendingRequests[0].requestId]);
  sendMessage(readJob(id, home), 'host follow up', home);
  answerRequest(readJob(id, home), request.pendingRequests[0].requestId,
    { answers: [{ id: 'choice', selected: [], custom: 'Continue' }] }, home);
  const finished = await waitJob({ id }, 10, home);
  assert.equal(finished.reason, 'finished');
  assert.equal(finished.reportedResult, 'OK');
  assert.deepEqual(finished.actionableRequests, []);
  const job = await running;
  assert.equal(job.processState, 'completed', job.error);
});

test('wait returns timeout for a running job and errors for bad timeouts or missing jobs', async t => {
  const { options, home } = setup(t, '[hold] wait forever');
  const { started, running } = background(t, options, home);
  const id = await started;
  const began = Date.now();
  const waited = await waitJob({ id }, 1, home);
  assert.equal(waited.reason, 'timeout');
  assert.equal(waited.processState, 'running');
  assert.ok(Date.now() - began >= 900);
  cancelJob(readJob(id, home), home);
  const job = await running;
  assert.equal(job.processState, 'cancelled', job.error);

  await assert.rejects(waitJob(job, 0, home), /timeout must be between 1 and 3600 seconds/);
  await assert.rejects(waitJob(job, 3601, home), /timeout must be between 1 and 3600 seconds/);
  await assert.rejects(waitJob({ id: '00000000-0000-4000-8000-000000000000' }, 1, home), /ENOENT/);
});

test('wait keeps pending requests out of actionableRequests while the job is finishing', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'bridge'), id = '00000000-0000-4000-8000-000000000001';
  const dir = path.join(home, 'jobs', id), requestId = '00000000-0000-4000-8000-000000000002';
  fs.mkdirSync(dir, { recursive: true });
  const job = { version: 2, id, parentId: null, rootId: id, processState: 'finishing',
    supervisorPid: process.pid, pendingRequests: [{ requestId, method: 'user-question/ask', params: {} }],
    startedAt: Date.now(), review: null, exitCode: null, reportedResult: null, cwd: root,
    reportFile: path.join(dir, 'report.txt'), stderrFile: path.join(dir, 'stderr.log'), eventsFile: path.join(dir, 'events.jsonl') };
  const file = path.join(dir, 'job.json');
  fs.writeFileSync(file, JSON.stringify(job));

  const began = Date.now();
  const waited = await waitJob({ id }, 1, home);
  assert.equal(waited.reason, 'timeout');
  assert.ok(Date.now() - began >= 900, `wait returned after ${Date.now() - began}ms`);
  assert.deepEqual(waited.actionableRequests, []);
  assert.deepEqual(waited.pendingRequests.map(request => request.requestId), [requestId]);

  // A real run clears pendingRequests when the job ends.
  job.processState = 'completed'; job.pendingRequests = [];
  fs.writeFileSync(file, JSON.stringify(job));
  const done = await waitJob({ id }, 1, home);
  assert.equal(done.reason, 'finished');
  assert.equal(done.processState, 'completed');
  assert.deepEqual(done.actionableRequests, []);
});

test('notify runs once on finish and receives job data only through the environment', async t => {
  const { root, options, home } = setup(t, 'notify finished');
  const out = path.join(root, 'finished.out'), command = envNotifier(root, 'notify-finished', out);
  const job = await runJob({ ...options, notifyCmd: command }, () => {}, home);
  assert.equal(job.processState, 'completed', job.error);
  assert.equal(job.notifyCmd, command);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'jobs', job.id, 'job.json'), 'utf8')).notifyCmd, command);
  const records = outputRecords(out);
  assert.equal(records.length, 1);
  assert.equal(records[0].event, 'finished');
  assert.equal(records[0].job, job.id);
  assert.equal(records[0].state, 'completed');
  assert.equal(records[0].result, 'OK');
  assert.equal(records[0].request, null);
  assert.equal(JSON.stringify(records[0].argv).includes(job.id), false);
  const sent = eventsPage(job, 0, 200).events.filter(event => event.event === 'notify_sent');
  assert.deepEqual(sent.map(event => [event.notifyEvent, event.exitCode]), [['finished', 0]]);
  assert.ok(fs.existsSync(path.join(path.dirname(job.reportFile), 'notify.log')));
});

test('notify runs once for a new request and once on finish', async t => {
  const { root, options, home } = setup(t, '[chat] notify request');
  const out = path.join(root, 'request.out'), command = envNotifier(root, 'notify-request', out);
  const { started, running } = background(t, { ...options, notifyCmd: command }, home);
  const id = await started;
  const request = await waitJob({ id }, 10, home);
  assert.equal(request.reason, 'request');
  sendMessage(readJob(id, home), 'host follow up', home);
  answerRequest(readJob(id, home), request.pendingRequests[0].requestId,
    { answers: [{ id: 'choice', selected: [], custom: 'Continue' }] }, home);
  const finished = await waitJob({ id }, 10, home);
  assert.equal(finished.reason, 'finished');
  const job = await running;
  assert.equal(job.processState, 'completed', job.error);
  const records = outputRecords(out);
  assert.equal(records.filter(record => record.event === 'request').length, 1);
  assert.equal(records.filter(record => record.event === 'finished').length, 1);
  const noted = records.find(record => record.event === 'request');
  assert.equal(noted.job, id);
  assert.equal(noted.request, request.pendingRequests[0].requestId);
  assert.equal(noted.state, 'running');
  assert.equal(noted.result, '');
  assert.equal(records.find(record => record.event === 'finished').result, 'OK');
});

test('the same requestId triggers notify only once', async t => {
  const { root, options, home } = setup(t, 'notify duplicate');
  fs.writeFileSync(options.dshEntry, duplicateRequestFake);
  const out = path.join(root, 'duplicate.out'), command = envNotifier(root, 'notify-duplicate', out);
  const { started, running } = background(t, { ...options, notifyCmd: command }, home);
  const id = await started;
  const request = await waitJob({ id }, 10, home);
  assert.equal(request.reason, 'request');
  answerRequest(readJob(id, home), request.pendingRequests[0].requestId,
    { answers: [{ id: 'choice', selected: [], custom: 'Continue' }] }, home);
  const finished = await waitJob({ id }, 10, home);
  assert.equal(finished.reason, 'finished');
  const job = await running;
  assert.equal(job.processState, 'completed', job.error);
  assert.equal(outputRecords(out).filter(record => record.event === 'request').length, 1);
});

test('a failing notify command is recorded without changing the job result', async t => {
  const { root, options, home } = setup(t, 'notify failure');
  const { command } = nodeCommand(root, 'notify-fail', 'process.exit(1);');
  const job = await runJob({ ...options, notifyCmd: command }, () => {}, home);
  assert.equal(job.processState, 'completed', job.error);
  assert.equal(job.reportedResult, 'OK');
  const failures = eventsPage(job, 0, 200).events.filter(event => event.event === 'notify_failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].notifyEvent, 'finished');
  assert.equal(failures[0].exitCode, 1);
  assert.match(failures[0].reason, /exit/);
});

test('a request notify failure carries requestId while a finished failure does not', async t => {
  const { root, options, home } = setup(t, '[chat] notify failure correlation');
  const { command } = nodeCommand(root, 'notify-fail-both', 'process.exit(1);');
  const { started, running } = background(t, { ...options, notifyCmd: command }, home);
  const id = await started;
  const request = await waitJob({ id }, 10, home);
  assert.equal(request.reason, 'request');
  const requestId = request.pendingRequests[0].requestId;
  sendMessage(readJob(id, home), 'host follow up', home);
  answerRequest(readJob(id, home), requestId,
    { answers: [{ id: 'choice', selected: [], custom: 'Continue' }] }, home);
  const finished = await waitJob({ id }, 10, home);
  assert.equal(finished.reason, 'finished');
  const job = await running;
  assert.equal(job.processState, 'completed', job.error);
  const failures = eventsPage(job, 0, 200).events.filter(event => event.event === 'notify_failed');
  assert.equal(failures.length, 2);
  const requestFailure = failures.find(event => event.notifyEvent === 'request');
  const finishedFailure = failures.find(event => event.notifyEvent === 'finished');
  assert.equal(requestFailure.requestId, requestId);
  assert.equal(requestFailure.exitCode, 1);
  assert.equal('requestId' in finishedFailure, false);
  assert.equal(finishedFailure.exitCode, 1);
});

test('a rejected answer records the requestId on input_rejected', async t => {
  const { options, home } = setup(t, '[chat] rejected answer');
  const { started, running } = background(t, options, home);
  const id = await started;
  const request = await waitJob({ id }, 10, home);
  assert.equal(request.reason, 'request');
  const requestId = request.pendingRequests[0].requestId;
  const queued = answerRequest(readJob(id, home), requestId, { answers: [] }, home);
  const rejected = await waitForEvent(id, home, 'input_rejected');
  assert.equal(rejected.requestId, requestId);
  assert.equal(rejected.inputId, queued.inputId);
  assert.match(rejected.error, /Answer each original question id/);
  sendMessage(readJob(id, home), 'host follow up', home);
  answerRequest(readJob(id, home), requestId,
    { answers: [{ id: 'choice', selected: [], custom: 'Continue' }] }, home);
  const finished = await waitJob({ id }, 10, home);
  assert.equal(finished.reason, 'finished');
  const job = await running;
  assert.equal(job.processState, 'completed', job.error);
});

test('a timed-out notify command is terminated without changing the job result', async t => {
  const { root, options, home } = setup(t, 'notify timeout');
  const marker = path.join(root, 'notify-started.txt');
  const { command } = nodeCommand(root, 'notify-slow', `
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(marker)}, 'started');
setTimeout(() => {}, 5000);
`);
  const began = Date.now();
  const job = await runJob({ ...options, notifyCmd: command, notifyTimeout: 200 }, () => {}, home);
  assert.equal(job.processState, 'completed', job.error);
  assert.equal(job.reportedResult, 'OK');
  assert.ok(fs.existsSync(marker));
  assert.ok(Date.now() - began < 4000, `notify timeout took ${Date.now() - began}ms`);
  const failures = eventsPage(job, 0, 200).events.filter(event => event.event === 'notify_failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].notifyEvent, 'finished');
  assert.match(failures[0].reason, /timed out after 200 ms/);
});

test('retry carries the parent notify command and accepts an override', async t => {
  const { root, options, home } = setup(t, 'notify retry');
  const out = path.join(root, 'retry.out'), command = envNotifier(root, 'notify-retry', out);
  const override = nodeCommand(root, 'notify-override', 'process.exit(0);').command;
  const job = await runJob({ ...options, notifyCmd: command }, () => {}, home);
  const retry = await retryJob(job, 'try again', () => {}, home);
  assert.equal(retry.processState, 'completed', retry.error);
  assert.equal(retry.notifyCmd, command);
  assert.deepEqual(outputRecords(out).map(record => record.job), [job.id, retry.id]);
  const third = await retryJob(retry, 'one more', () => {}, home, override);
  assert.equal(third.processState, 'completed', third.error);
  assert.equal(third.notifyCmd, override);
});

test('notify-cmd rejects blank, multiline and overlong commands before launch', async t => {
  const { options, home } = setup(t, 'bad notify');
  const marker = path.join(options.cwd, 'started.txt');
  fs.writeFileSync(options.dshEntry, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'started');`);
  await assert.rejects(runJob({ ...options, notifyCmd: '' }, () => {}, home), /notify-cmd must not be blank/);
  await assert.rejects(runJob({ ...options, notifyCmd: '   ' }, () => {}, home), /notify-cmd must not be blank/);
  await assert.rejects(runJob({ ...options, notifyCmd: 'echo ok\necho no' }, () => {}, home), /notify-cmd must not contain line breaks/);
  await assert.rejects(runJob({ ...options, notifyCmd: 'x'.repeat(2001) }, () => {}, home), /notify-cmd must be at most 2000 characters/);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(home), false);
});
