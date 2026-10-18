'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const background=read('src/background/service-worker.js');
const content=read('src/content/start.js');
const manifest=require('../manifest.json');

function settingsHarness(stored={}) {
  const app={modules:{}};
  const chrome={storage:{local:{get:async()=>stored}}};
  const ctx=vm.createContext({globalThis:null,chrome,console});
  ctx.globalThis=ctx;
  ctx.__chatContextExporter=app;
  vm.runInContext(read('src/core/settings.js'),ctx);
  return app.modules.settings;
}

test('5 minute default, user override and bounded setting validation', async()=>{
  const mod=settingsHarness();
  assert.equal(mod.DEFAULT_SETTINGS.generationWaitSeconds,300);
  assert.equal((await mod.loadSettings()).generationWaitSeconds,300);
  assert.equal(mod.clampGenerationWaitSeconds(600),600);
  assert.equal(mod.clampGenerationWaitSeconds(2),30);
  assert.equal(mod.clampGenerationWaitSeconds(4000),3600);
  assert.equal(mod.clampGenerationWaitSeconds(Number.NaN),300);
  assert.equal((await settingsHarness({generationWaitSeconds:420}).loadSettings()).generationWaitSeconds,420);
  assert.equal((await settingsHarness({generationWaitSeconds:0}).loadSettings()).generationWaitSeconds,30);
});

test('settings page exposes editable seconds for 30..3600 and reset to 300',()=>{
  assert.match(read('src/options/options.html'),/id="generationWaitSeconds" type="number" min="30" max="3600"/);
  assert.match(read('src/options/options.js'),/generationWaitSeconds: 300/);
  assert.match(read('src/options/options.js'),/\['generationWaitSeconds', elements\.generationWaitSeconds/);
  assert.match(read('src/options/options.js'),/chrome\.storage\.local\.set\(\{ \.\.\.DEFAULT_SETTINGS \}\)/);
  assert.equal(manifest.version,'1.3.3');
  assert.equal(manifest.version_name,'1.3.3');
  assert.match(read('src/core/namespace.js'),/version: '1\.3\.3'/);
});

test('Stop wait is bound to configured seconds on first, after-reload and before-scroll checks',()=>{
  assert.match(content,/settings\.clampGenerationWaitSeconds\(currentSettings\?\.generationWaitSeconds\)/);
  assert.match(content,/waitForChatGptGenerationToSettle\('before-start', currentSettings\)/);
  assert.match(content,/guardedGenerationWait\('after-reload', currentSettings\)/);
  assert.match(content,/guardedGenerationWait\('before-scroll', currentSettings\)/);
  assert.match(content,/state = await ensureGenerationSettledBeforeScroll\(state, currentSettings\)/);
  assert.match(content,/currentState = await ensureGenerationSettledBeforeScroll\(currentState, currentSettings\)/);
  assert.match(content,/CAPTURE_GENERATION_WAIT_MESSAGE, waiting:true/);
  assert.match(content,/CAPTURE_GENERATION_WAIT_MESSAGE, waiting:false/);
  assert.doesNotMatch(content,/CHATGPT_GENERATION_MAX_WAIT_MS/);
});

function bgHarness(){
  const events={}; const timers=new Map();let nextId=0;
  const chrome={
    debugger:{onEvent:{addListener:f=>events.onEvent=f},onDetach:{addListener:f=>events.onDetach=f},sendCommand:async()=>({}),detach:async()=>{}},
    tabs:{onUpdated:{addListener:f=>events.updated=f},onRemoved:{addListener:f=>events.removed=f},sendMessage:async()=>{}},
    action:{onClicked:{addListener:f=>events.action=f}},runtime:{onMessage:{addListener:f=>events.message=f}},
    storage:{session:{set:async()=>{},get:async()=>({}),remove:async()=>{}}},
    scripting:{executeScript:async()=>{}},
  };
  const ctx=vm.createContext({chrome,URL,TextEncoder,TextDecoder,structuredClone,console,
    crypto:{randomUUID:()=>String(++nextId)},importScripts(){},
    setTimeout(fn,ms){const id=++nextId;timers.set(id,{fn,ms});return id;},
    clearTimeout(id){timers.delete(id);},
    __chatContextExporterShareWireParser:{},__chatContextExporterThreadWireParser:{}});
  vm.runInContext(background,ctx);
  const session={tabId:5,id:'s',pass:1,totalPasses:2,phase:'capturing',
    responseProcessor:'chatgpt-thread-json',generationGuardWaiting:false,
    events:[],timer:null,timeoutMs:180000,pendingRequests:new Map(),
    bufferedPages:new Map(),captures:[],attached:false};
  vm.runInContext('captureSessions',ctx).set(5,session);
  async function msg(waiting){
    return await vm.runInContext('updateGenerationGuardWait',ctx)(5,waiting);
  }
  return {ctx,session,timers,msg};
}

test('Stop waiting pauses 180s network watchdog and resumes it only after generation completes',async()=>{
  const h=bgHarness();
  vm.runInContext('scheduleCaptureTimeout',h.ctx)(h.session);
  assert.equal(h.timers.size,1);
  const paused=await h.msg(true);
  assert.equal(paused.ok,true);
  assert.equal(h.timers.size,0);
  assert.equal(h.session.generationGuardWaiting,true);
  // Real wall-clock 300s is longer than 180s watchdog. Timer must remain absent.
  assert.equal((await h.msg(true)).ok,true,'repeat pause is idempotent');
  assert.equal(h.timers.size,0);
  await h.msg(false);
  assert.equal(h.session.generationGuardWaiting,false);
  assert.equal([...h.timers.values()][0].ms,180000);
  assert.equal((await h.msg(false)).ok,true,'repeat resume is idempotent');
  assert.equal(h.timers.size,1);
});

test('in awaiting-scroll phase guard pause/resume does not arm premature response timer',async()=>{
  const h=bgHarness();h.session.phase='awaiting-scroll';
  await h.msg(true);await h.msg(false);
  assert.equal(h.timers.size,0);
  assert.ok(h.session.events.some(e=>e.event==='CHATGPT_GENERATION_NETWORK_TIMEOUT_PAUSED'));
  assert.ok(h.session.events.some(e=>e.event==='CHATGPT_GENERATION_NETWORK_TIMEOUT_RESUMED'));
});

test('never skip an incomplete mandatory pass; verified extra pass fallback unchanged',async()=>{
  assert.match(content,/if \(state\.pass > 1 && \(state\.completedPasses \|\| 0\) >= 1\)/);
  assert.match(content,/CAPTURE_SKIP_EXTRA_PASS_MESSAGE/);
  assert.match(content,/if \(state\.pass > 1 && \(state\.completedPasses \|\| 0\) >= 1 && state\.pageState\?\.pageSequence\)/);
});
