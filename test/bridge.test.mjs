import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runJob, readJob, sendMessage, answerRequest, eventsPage, cancelJob, result, retryJob, reviewJob, stats, briefText } from '../lib/bridge.mjs';

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

// A runtime that records the first prompt's contentBlocks so tests can inspect them.
function captureRuntime(file) {
  return `
import fs from 'node:fs';
import readline from 'node:readline';
const write = m => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
let sessionId, waitId, seq=0, finished=false;
const event=(type,data)=>write({method:'session.event',params:{sessionId,event:{type,seq:++seq,time:Date.now(),data}}});
const finish=()=>{
 if(finished)return;finished=true;
 event('assistant/message',{turn:1,step:1,message:{role:'assistant',content:[{type:'text',text:'RESULT: OK'}]}});
 event('turn/end',{turn:1,reason:{kind:'completed'}});
 if(waitId)write({id:waitId,result:{}});
};
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')write({id:m.id,result:{serverInfo:{name:'deepseek-harness-sdk-runtime',version:'0.0.1'}}});
 else if(m.method==='session/prompt'){
  sessionId=m.params.sessionId;
  fs.writeFileSync(${JSON.stringify(file)},JSON.stringify(m.params.contentBlocks));
  write({id:m.id,result:{messageId:'m'}});setTimeout(finish,20);
 }else if(m.method==='session/wait'){if(finished)write({id:m.id,result:{}});else waitId=m.id;}
 else if(m.method==='shutdown'){write({id:m.id,result:{}});setTimeout(()=>process.exit(0),10);}
});
`;
}

const digest = buffer => createHash('sha256').update(buffer).digest('hex');
const pngBytes = () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x49, 0x48, 0x44, 0x52]);
const jpegBytes = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

test('images are sent as base64 blocks after the text block and recorded without content', async t => {
  const { root, options, home } = setup(t, 'describe the images');
  const pngFile = path.join(root, 'first.png'), jpegFile = path.join(root, 'second.jpg');
  const png = pngBytes(), jpg = jpegBytes();
  fs.writeFileSync(pngFile, png); fs.writeFileSync(jpegFile, jpg);
  const capture = path.join(root, 'content-blocks.json');
  fs.writeFileSync(options.dshEntry, captureRuntime(capture));
  const job = await runJob({ ...options, image: [pngFile, jpegFile] }, () => {}, home);
  assert.equal(job.processState, 'completed', job.error);
  assert.equal(job.version, 2);
  assert.deepEqual(job.images, [
    { path: fs.realpathSync(pngFile), sha256: digest(png), mimeType: 'image/png' },
    { path: fs.realpathSync(jpegFile), sha256: digest(jpg), mimeType: 'image/jpeg' },
  ]);
  const blocks = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /【附带图片】本任务附带 2 张图片\(按顺序\):first\.png、second\.jpg。/);
  assert.equal(blocks[0].text.includes(pngFile), false);
  assert.equal(blocks[1].type, 'image');
  assert.equal(blocks[1].mimeType, 'image/png');
  assert.ok(Buffer.from(blocks[1].data, 'base64').equals(png));
  assert.equal(blocks[2].type, 'image');
  assert.equal(blocks[2].mimeType, 'image/jpeg');
  assert.ok(Buffer.from(blocks[2].data, 'base64').equals(jpg));
  const jobText = fs.readFileSync(path.join(path.dirname(job.reportFile), 'job.json'), 'utf8');
  assert.equal(jobText.includes(png.toString('base64')), false);
  assert.equal(jobText.includes(jpg.toString('base64')), false);
});

test('a job without images sends exactly one text block', async t => {
  const { root, options, home } = setup(t, 'plain task');
  const capture = path.join(root, 'content-blocks.json');
  fs.writeFileSync(options.dshEntry, captureRuntime(capture));
  const job = await runJob(options, () => {}, home);
  assert.equal(job.processState, 'completed', job.error);
  const prompt = fs.readFileSync(path.join(path.dirname(job.reportFile), 'prompt.txt'), 'utf8');
  assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')), [{ type: 'text', text: prompt }]);
  assert.deepEqual(job.images, []);
  assert.doesNotMatch(prompt, /【附带图片】/);
});

test('a non-image file is rejected before dsh starts or job files are written', async t => {
  const { root, options, home } = setup(t, 'reject');
  const fakeImage = path.join(root, 'not-really.png');
  fs.writeFileSync(fakeImage, 'plain text, not an image');
  const marker = path.join(root, 'started.txt');
  fs.writeFileSync(options.dshEntry, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'started');`);
  const real = fs.realpathSync(fakeImage);
  await assert.rejects(runJob({ ...options, image: [fakeImage] }, () => {}, home),
    error => /Unsupported image format \(JPEG, PNG, GIF and WebP only\): /.test(error.message) && error.message.includes(real));
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(home), false);
});

test('images beyond one SDK message or beyond the count limit are rejected before launch', async t => {
  const { root, options, home } = setup(t, 'too large');
  const marker = path.join(root, 'started.txt');
  fs.writeFileSync(options.dshEntry, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'started');`);
  const big = Buffer.alloc(7 * 1024 * 1024);
  pngBytes().copy(big);
  const bigFile = path.join(root, 'big.png'); fs.writeFileSync(bigFile, big);
  await assert.rejects(runJob({ ...options, image: [bigFile] }, () => {}, home),
    /Images are too large for one SDK message \(\d+ > 8388608\); downscale or split them/);
  assert.equal(fs.existsSync(marker), false);
  const many = Array.from({ length: 21 }, (_, index) => {
    const file = path.join(root, `many-${index}.png`); fs.writeFileSync(file, pngBytes()); return file;
  });
  await assert.rejects(runJob({ ...options, image: many }, () => {}, home), /At most 20 images per job/);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(home), false);
});

test('retry carries unchanged images and rejects images changed since the previous run', async t => {
  const { root, options, home } = setup(t, 'retry with image');
  const file = path.join(root, 'image.png'), png = pngBytes();
  fs.writeFileSync(file, png);
  const capture = path.join(root, 'content-blocks.json');
  fs.writeFileSync(options.dshEntry, captureRuntime(capture));
  const job = await runJob({ ...options, image: [file] }, () => {}, home);
  assert.equal(job.processState, 'completed', job.error);
  const retry = await retryJob(job, 'look again', () => {}, home);
  assert.equal(retry.processState, 'completed', retry.error);
  assert.deepEqual(retry.images.map(image => image.path), [fs.realpathSync(file)]);
  assert.equal(JSON.parse(fs.readFileSync(capture, 'utf8')).length, 2);
  fs.writeFileSync(file, Buffer.concat([pngBytes(), Buffer.from([0x01])]));
  await assert.rejects(retryJob(job, 'look again', () => {}, home), /Image changed since the previous run; create a new job/);
});

test('an image changed after launch fails the job with a clear error', async t => {
  const { root, options, home } = setup(t, 'change after launch');
  const file = path.join(root, 'image.png');
  fs.writeFileSync(file, pngBytes());
  const job = await runJob({ ...options, image: [file] }, event => {
    if (event.event === 'started') fs.writeFileSync(file, Buffer.concat([pngBytes(), Buffer.from([0x02])]));
  }, home);
  assert.equal(job.processState, 'failed');
  assert.match(job.error, /Image changed since launch: /);
});

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

test('dsh 0.2.1-rc.2 is rejected as below the minimum version', async t => {
  const { options, home, root } = setup(t, 'version gate');
  fs.writeFileSync(path.join(root, 'runtime', 'package.json'), JSON.stringify({ version: '0.2.1-rc.2' }));
  await assert.rejects(runJob(options, () => {}, home), /Update @deepseek-ai\/dsh to >=0\.2\.1-rc\.3/);
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

test('cleanup_failed jobs point at unlock before retry or review', async () => {
  const job = { id: '00000000-0000-4000-8000-000000000000', processState: 'cleanup_failed' };
  const expected = /Cleanup failed for this job; confirm its processes stopped and run dsb unlock .* --confirmed-stopped first/;
  await assert.rejects(retryJob(job, 'again', () => {}), expected);
  assert.throws(() => reviewJob(job, 'rework', 'note'), expected);
});

test('accounting accepts an unknown host Cost key and stats aggregates it', async t => {
  const { options, home } = setup(t, 'accounting');
  const job = await runJob(options, () => {}, home);
  reviewJob(job, 'rework', 'needs another look', home, { currency: 'CNY', source: 'test', geminiCost: 1.5, deepseekCost: 2 });
  const group = stats(home).costsByCurrency.CNY;
  assert.equal(group.geminiCost, 1.5);
  assert.equal(group.geminiRecords, 1);
  assert.equal(group.deepseekCost, 2);
  assert.equal(group.deepseekRecords, 1);
  assert.equal(group.claudeCost, 0);
  assert.equal(group.codexRecords, 0);
});

test('accounting rejects negative unknown host costs', async t => {
  const { options, home } = setup(t, 'negative accounting');
  const job = await runJob(options, () => {}, home);
  assert.throws(() => reviewJob(job, 'rework', 'look again', home, { currency: 'CNY', source: 'test', geminiCost: -1 }),
    /Costs must be nonnegative numbers/);
});

test('legacy accounting keys keep their aggregate behavior', async t => {
  const { options, home } = setup(t, 'legacy accounting');
  const job = await runJob(options, () => {}, home);
  reviewJob(job, 'rework', 'look again', home, { currency: 'USD', source: 'test', claudeCost: 1, codexCost: 2.5, deepseekCost: 3 });
  assert.deepEqual({ ...stats(home).costsByCurrency.USD },
    { claudeCost: 1, codexCost: 2.5, deepseekCost: 3, claudeRecords: 1, codexRecords: 1, deepseekRecords: 1 });
});

test('a null cost means unknown: it is accepted and neither summed nor counted', async t => {
  const { options, home } = setup(t, 'null accounting');
  const job = await runJob(options, () => {}, home);
  reviewJob(job, 'rework', 'look again', home, { currency: 'EUR', source: 'test', claudeCost: null, deepseekCost: 4 });
  const group = stats(home).costsByCurrency.EUR;
  assert.equal(group.claudeCost, 0);
  assert.equal(group.claudeRecords, 0);
  assert.equal(group.deepseekRecords, 1);
});

test('briefText uses the caller label in its errors', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-bridge-brief-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const long = path.join(root, 'long.md'), blank = path.join(root, 'blank.md');
  fs.writeFileSync(long, 'x'.repeat(48001)); fs.writeFileSync(blank, ' \n');
  assert.throws(() => briefText(long), /Brief is too long: use concise goals/);
  assert.throws(() => briefText(long, 'Message'), /Message file is too long \(limit 48000 bytes\)/);
  assert.throws(() => briefText(blank), /Brief must not be blank/);
  assert.throws(() => briefText(blank, 'Answer'), /Answer must not be blank/);
});
