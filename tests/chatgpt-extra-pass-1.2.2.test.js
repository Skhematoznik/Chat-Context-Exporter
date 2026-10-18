'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const background = fs.readFileSync(path.join(root, 'src/background/service-worker.js'), 'utf8');
const content = fs.readFileSync(path.join(root, 'src/content/start.js'), 'utf8');
const manifest = require('../manifest.json');

function setup() {
  const events = {};
  const calls = {detach:0, inject:0, remove:0, reload:0};
  const timers = new Map();
  let next = 0;
  const chrome = {
    debugger: {
      onEvent:{addListener:fn=>events.debug=fn}, onDetach:{addListener:fn=>events.detach=fn},
      detach:async()=>{calls.detach++;},
      sendCommand:async(_target, method)=>{if(method==='Page.reload') calls.reload++; return {};},
    },
    tabs:{sendMessage:async()=>{},onUpdated:{addListener:fn=>events.updated=fn},onRemoved:{addListener:fn=>events.removed=fn}},
    action:{onClicked:{addListener:()=>{}}},
    runtime:{onMessage:{addListener:fn=>events.message=fn}},
    storage:{session:{set:async()=>{},get:async()=>({}),remove:async()=>{calls.remove++;}}},
    scripting:{executeScript:async()=>{calls.inject++;}},
  };
  const context = vm.createContext({chrome, URL, TextDecoder, TextEncoder, structuredClone,console,
    crypto:{randomUUID:()=>`uuid${++next}`},
    setTimeout(fn,ms){const id=++next;timers.set(id,{fn,ms});return id;},
    clearTimeout(id){timers.delete(id);},importScripts(){},
    __chatContextExporterShareWireParser:{},__chatContextExporterThreadWireParser:{},
  });
  vm.runInContext(background,context);
  const session = {
    tabId:5, id:'test', adapterId:'chatgpt', responseProcessor:'chatgpt-thread-json',
    paginationMode:'scroll-up-until-start',pass:1,totalPasses:2,completedPasses:0,
    attemptEpoch:1,phase:'capturing',minDelayMs:100,maxDelayMs:100,timeoutMs:180000,
    currentPassCaptured:false,pagesCapturedInPass:1,currentPassTranscriptIds:new Set(['one']),
    seenPageStartCursors:new Set(),acceptedRequestBeforeCursors:new Set(),
    bufferedPages:new Map(),bufferedPageBytes:0,cursorGapTimer:null,cursorGapStartedAt:null,
    drainingPages:false,generationRestartCount:0,http403RetryCount:0,captures:[{pass:1,id:'main'}],
    pendingRequests:new Map(),events:[],attached:true,detaching:false,timer:null,matchedRequests:1,
  };
  vm.runInContext('captureSessions',context).set(5,session);
  const flush=async()=>{for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r));};
  async function message(type) {
    let callback;
    const promise=new Promise(r=>{callback=r;});
    events.message({type}, {tab:{id:5}}, callback);
    await flush();
    return promise;
  }
  async function completeMain() {
    await vm.runInContext('completeCapturePass',context)(session);
    assert.equal(session.completedPasses,1);
    assert.equal(session.phase,'waiting-next-pass');
    const [id,timer]=[...timers].find(([,v])=>v.ms===100);
    assert.ok(id);
    timers.delete(id);timer.fn();await flush();
    assert.equal(session.pass,2);
    assert.equal(session.phase,'capturing');
    assert.equal(calls.reload,1);
  }
  return {context,session,calls,events,timers,flush,message,completeMain};
}

test('complete primary, Stop resumes on optional reload: skip optional and preserve main pass', async()=>{
  const h=setup();await h.completeMain();
  h.session.captures.push({pass:2,id:'incomplete-extra'});
  const response=await h.message('chat-context-exporter:capture:skip-extra-pass');
  assert.equal(response.ok,true);
  assert.equal(h.session.phase,'ready');
  assert.equal(h.session.completedPasses,1);
  assert.equal(h.session.skippedExtraPasses,1);
  assert.equal(h.session.captures.length,1);
  assert.equal(h.session.captures[0].id,'main');
  assert.match(h.session.captureWarning,/Дополнительная проверка/);
  assert.ok(h.session.events.some(x=>x.event==='CAPTURE_READY_WITH_WARNING'));
  assert.equal(h.calls.reload,1, 'skipping must not initiate another reload');
  assert.equal(h.calls.detach,1);
  assert.equal(h.timers.size,0);
  assert.equal(response.state.completedPasses,1);
  assert.equal(response.state.skippedExtraPasses,1);
  const duplicate=await h.message('chat-context-exporter:capture:skip-extra-pass');
  assert.equal(duplicate.ok,true);
  assert.equal(h.calls.detach,1,'idempotent skip');
});

test('HTTP 429 / network failure of optional pass degrades to ready-with-warning, never ERROR',async()=>{
  const h=setup();await h.completeMain();
  h.session.captures.push({pass:2,id:'partial'});
  await vm.runInContext('failCaptureSession',h.context)(h.session,new Error('HTTP 429 Too Many Requests'),'http-response');
  assert.equal(h.session.phase,'ready');
  assert.equal(h.session.completedPasses,1);
  assert.equal(h.session.captures.length,1);
  assert.equal(h.session.error,null);
  assert.match(h.session.captureWarning,/429/);
  assert.ok(!h.session.events.some(x=>x.event==='CAPTURE_ERROR'));
  assert.equal(h.calls.detach,1);
});

test('mandatory incomplete first pass still fails without partial export',async()=>{
  const h=setup();
  await vm.runInContext('failCaptureSession',h.context)(h.session,new Error('CURSOR_CHAIN_INCOMPLETE'),'cursor-chain-incomplete');
  assert.equal(h.session.phase,'error');
  assert.equal(h.session.completedPasses,0);
  assert.equal(h.session.captureWarning,undefined);
  assert.ok(!h.session.events.some(x=>x.event==='CAPTURE_READY_WITH_WARNING'));
  assert.equal(h.calls.detach,1);
  const final=await h.message('chat-context-exporter:capture:cancel');
  assert.equal(final.ok,true);
  assert.equal(h.calls.detach,1,'already failed session must not detach twice');
  assert.ok(!h.session.events.some(x=>x.event==='CANCEL_REQUESTED'));
});

test('real successfully completed optional pass remains a true two-pass completion',async()=>{
  const h=setup();await h.completeMain();
  h.session.captures.push({pass:2,id:'extra-complete'});
  await vm.runInContext('completeCapturePass',h.context)(h.session);
  assert.equal(h.session.phase,'ready');
  assert.equal(h.session.completedPasses,2);
  assert.equal(h.session.captureWarning,undefined);
  assert.equal(h.session.captures.length,2);
  assert.ok(h.session.events.some(x=>x.event==='CAPTURE_READY'));
});

test('skip after Stop is forbidden when no main pass was completed',async()=>{
  const h=setup();h.session.pass=2;
  const response=await h.message('chat-context-exporter:capture:skip-extra-pass');
  assert.equal(response.ok,false);
  assert.equal(h.session.phase,'capturing');
  assert.equal(h.calls.detach,0);
});

test('correct version in manifest and runtime; explicit export-warning mechanism',()=>{
  const namespace=fs.readFileSync(path.join(root,'src/core/namespace.js'),'utf8');
  assert.equal(manifest.version,'1.3.2');
  assert.equal(manifest.version_name,'1.3.2');
  assert.match(namespace,/version: '1\.3\.2'/);
  assert.match(content,/CAPTURE_SKIP_EXTRA_PASS_MESSAGE/);
  assert.match(content,/EXPORT_WITH_WARNING/);
  assert.match(content,/Предупреждение экспорта/);
  assert.match(content,/waitForChatGptGenerationToSettle\('before-start', currentSettings\)/);
});
