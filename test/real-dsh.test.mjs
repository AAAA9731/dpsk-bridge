// Opt-in keyless integration against an installed current dsh, not a fake SDK process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runJob, readJob, sendMessage, answerRequest, result, eventsPage } from '../lib/bridge.mjs';

test('published dsh runs real SDK, host question plugin, followup, and v4 logs without a model call', {
  skip: !process.env.DPSK_REAL_DSH_ENTRY, timeout: 60000,
}, async t => {
  const entry = fs.realpathSync(process.env.DPSK_REAL_DSH_ENTRY);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-real-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = { DSH_HOME: process.env.DSH_HOME, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED };
  process.env.DSH_HOME = path.join(root, '.dsh'); delete process.env.DEEPSEEK_API_KEY; process.env.DSH_TELEMETRY_DISABLED = '1';
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const llm = pathToFileURL(path.resolve(path.dirname(entry), '../../dsh-llm/lib/index.js')).href;
  const plugin = path.join(root, 'mock-provider.mjs');
  fs.writeFileSync(plugin, `
import { LlmAdapter } from ${JSON.stringify(llm)};
class Adapter extends LlmAdapter {
 async resolveModel(provider,model){return {provider,id:model,name:model};}
 async *stream(options){
  const tool=options.messages.at(-1)?.role==='tool';
  if(!tool){
   const args=JSON.stringify({questions:[{id:'choice',question:'Return the host response?',options:[]}]});
   yield {type:'block-start',index:0,blockType:'tool-call'};
   yield {type:'tool-call-delta',index:0,id:'ask',name:'ask_user_question',argumentsDelta:args};
   yield {type:'block-end',index:0,block:{type:'tool-call',id:'ask',name:'ask_user_question',arguments:args}};
   yield {type:'finish',reason:{kind:'tool-calls'}};return;
  }
  const latest=options.messages.filter(m=>m.role==='user').at(-1);
  const update=(latest?.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
  const text='RESULT: OK\\nreal harness mock: '+(update.includes('HOST_UPDATE')?'HOST_UPDATE':'initial');
  yield {type:'block-start',index:0,blockType:'text'};
  yield {type:'text-delta',index:0,text};
  yield {type:'block-end',index:0,block:{type:'text',text}};
  yield {type:'usage',usage:{inputTokens:7,outputTokens:4,cacheReadTokens:0,cacheWriteTokens:0}};
  yield {type:'finish',reason:{kind:'stop'}};
 }
}
export const name='bridge-keyless-provider';export const inject=['llm'];
export function apply(ctx){ctx.llm.registerAdapter(['bridge-test'],new Adapter());}
`);
  const patch = path.join(root, 'mock.patch.yml');
  fs.writeFileSync(patch, `- insert:\n    - id: bridge-keyless-provider\n      name: ${JSON.stringify(plugin)}\n`);
  const brief = path.join(root, 'brief.md'); fs.writeFileSync(brief, 'Run the keyless bridge integration. Ask the host, then return the mock report.');
  const home = path.join(process.env.DSH_HOME, 'bridge'); let asked = 0, sent = false;
  const job = await runJob({ cwd: root, brief, patch: [patch], dshEntry: entry, timeout: 40, provider: 'bridge-test', model: 'bridge-test' }, e => {
    if (e.event === 'request') {
      asked++;
      if (!sent) { sendMessage(readJob(e.id, home), 'HOST_UPDATE', home); sent = true; }
      answerRequest(readJob(e.id, home), e.requestId, { answers: [{ id: 'choice', selected: [], custom: 'Continue mock validation' }] }, home);
    }
  }, home);
  assert.equal(job.processState, 'completed', `${job.error}\n${fs.readFileSync(job.stderrFile, 'utf8')}`);
  assert.equal(job.reportedResult, 'OK'); assert.ok(asked > 0, JSON.stringify(eventsPage(job, 0, 200).events.filter(e => e.params?.event?.type === 'tool/result')));
  assert.match(result(job).report, /HOST_UPDATE/);
  assert.equal(job.session.matched, true, JSON.stringify(job.session)); assert.equal(job.session.version, 4);
  assert.ok(eventsPage(job, 0, 200).events.some(e => e.event === 'input_delivered'));
});
