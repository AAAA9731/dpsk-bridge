import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runJob, readJob, sendMessage, answerRequest, eventsPage, cancelJob, result, retryJob } from '../lib/bridge.mjs';

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

function setup(t, brief) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'runtime', 'lib'), { recursive: true });
  const entry = path.join(root, 'runtime', 'lib', 'bin.mjs'); fs.writeFileSync(entry, fake);
  fs.writeFileSync(path.join(root, 'runtime', 'package.json'), JSON.stringify({ version: '0.2.1-rc.3' }));
  const briefFile = path.join(root, 'brief.md'); fs.writeFileSync(briefFile, brief);
  return { root, home: path.join(root, 'bridge'), options: { cwd: root, brief: briefFile, dshEntry: entry, timeout: 10 } };
}

test('SDK delivers followups and answers during wait, persists receipts and usage', async t => {
  const { options, home } = setup(t, '[chat] bounded task');
  let id, messageInput, answerInput;
  const job = await runJob(options, event => {
    if (event.event === 'started') {
      id = event.id;
      messageInput = sendMessage(readJob(id, home), 'host update 中文', home).inputId;
    }
    if (event.event === 'request') answerInput = answerRequest(readJob(id, home), event.requestId,
      { answers: [{ id: 'choice', selected: [], custom: 'Continue' }] }, home).inputId;
  }, home);
  assert.equal(job.processState, 'completed', job.error);
  assert.equal(job.reportedResult, 'OK');
  assert.match(result(job).report, /host update 中文/);
  assert.equal(job.usage.tokens.uncachedInputTokens, 10);
  const page = eventsPage(job, 0, 200);
  assert.ok(page.events.some(e => e.event === 'input_delivered' && e.inputId === messageInput));
  assert.ok(page.events.some(e => e.event === 'input_delivered' && e.inputId === answerInput));
  assert.equal(eventsPage(job, page.cursor).events.length, 0);
  assert.throws(() => eventsPage(job, 1), /Cursor/);
  assert.throws(() => sendMessage(job, 'too late', home), /no longer accepting/);
});

test('cancellation terminates the dedicated SDK process and releases its reservation', async t => {
  const { options, home } = setup(t, '[hold] wait forever');
  const job = await runJob(options, e => {
    if (e.event === 'started') setTimeout(() => cancelJob(readJob(e.id, home), home), 100);
  }, home);
  assert.equal(job.processState, 'cancelled', job.error);
  const next = await runJob({ ...options, originalBrief: 'simple' }, () => {}, home);
  assert.equal(next.processState, 'completed', next.error);
});

test('timeout settles a waiting SDK and old installed SDK gives an upgrade error', async t => {
  const { options, home, root } = setup(t, '[hold] wait forever');
  const job = await runJob({ ...options, timeout: 0.3 }, () => {}, home);
  assert.equal(job.processState, 'timed_out', job.error);
  fs.writeFileSync(path.join(root, 'runtime', 'package.json'), JSON.stringify({ version: '0.1.5-rc.1' }));
  await assert.rejects(runJob(options, () => {}, home), /Update/);
});

test('retry preserves the original task and current SDK settings', async t => {
  const { options, home } = setup(t, 'bounded task');
  const job = await runJob(options, () => {}, home);
  assert.equal(job.processState, 'completed', job.error);
  assert.equal(job.reportedResult, 'OK');
  const retry = await retryJob(job, 'verify again', () => {}, home);
  assert.equal(retry.model, job.model);
  assert.equal(retry.parentId, job.id);
  assert.match(fs.readFileSync(path.join(path.dirname(retry.reportFile), 'prompt.txt'), 'utf8'), /verify again/);
  assert.equal(retry.processState, 'completed', retry.error);
});

test('a timer-delivered followup must cross a new wait barrier before shutdown', async t => {
  const { options, home } = setup(t, 'race');
  fs.writeFileSync(options.dshEntry, `
import readline from 'node:readline';
const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
let sessionId, prompts=0, waits=0, seq=0, completed=false;
const event=(type,data)=>send({method:'session.event',params:{sessionId,event:{type,seq:++seq,time:Date.now(),data}}});
const finish=text=>{event('assistant/message',{turn:prompts,step:1,message:{role:'assistant',content:[{type:'text',text:'RESULT: OK\\n'+text}]}});event('turn/end',{turn:prompts,reason:{kind:'completed'}});};
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{serverInfo:{name:'deepseek-harness-sdk-runtime'}}});
 if(m.method==='session/prompt'){
  sessionId=m.params.sessionId;prompts++;
  if(prompts===1)send({id:m.id,result:{messageId:'first'}});
  else setTimeout(()=>{send({id:m.id,result:{messageId:'second'}});event('turn/start',{turn:2});},100);
 }
 if(m.method==='session/wait'){
  waits++;
  if(waits===1)setTimeout(()=>{finish('stale first answer');send({id:m.id,result:{}});},140);
  else setTimeout(()=>{finish('updated answer');completed=true;send({id:m.id,result:{}});},60);
 }
 if(m.method==='shutdown'){send({id:m.id,result:{}});setTimeout(()=>process.exit(completed?0:9),10);}
});`);
  const job = await runJob(options, e => {
    if (e.event === 'started') setTimeout(() => sendMessage(readJob(e.id, home), 'second turn', home), 70);
  }, home);
  assert.equal(job.processState, 'completed', job.error);
  assert.match(result(job).report, /updated answer/);
});

test('malformed SDK output fails the job and still releases the workspace', async t => {
  const { options, home } = setup(t, 'bad runtime');
  fs.writeFileSync(options.dshEntry, `console.log('invalid JSON');setInterval(()=>{},1000);`);
  const failed = await runJob(options, () => {}, home);
  assert.equal(failed.processState, 'failed');
  assert.match(failed.error, /JSON|Unexpected/);
  fs.writeFileSync(options.dshEntry, fake);
  const next = await runJob(options, () => {}, home);
  assert.equal(next.processState, 'completed', next.error);
});
