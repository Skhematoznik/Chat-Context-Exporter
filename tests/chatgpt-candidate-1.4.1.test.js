'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root,name),'utf8');

function workerHarness() {
  const timers = new Map(), messages = [], methods = [];
  let timerId = 0;
  const listeners = {};
  const chrome = {
    debugger: {onEvent:{addListener:fn=>{listeners.network=fn;}},
      onDetach:{addListener() {}},
      sendCommand: async (_,method) => {methods.push(method);return {};}, detach:async()=>{}},
    tabs: {sendMessage: async (_,msg) => {messages.push(msg);}, onUpdated:{addListener(){}}, onRemoved:{addListener(){}}},
    action: {onClicked:{addListener(){}}}, runtime: {onMessage:{addListener(){}}},
    storage:{session:{get:async()=>({}),set:async()=>{},remove:async()=>{}}},
    scripting:{executeScript:async()=>{}},
  };
  const ctx=vm.createContext({chrome,URL,TextEncoder,TextDecoder,structuredClone,console,
    crypto:{randomUUID:()=> 'random'},importScripts(){},
    setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},
    clearTimeout(id){timers.delete(id);},
    __chatContextExporterShareWireParser:{},__chatContextExporterThreadWireParser:{}});
  vm.runInContext(read('src/background/service-worker.js'),ctx);
  const session={id:'test',tabId:17,adapterId:'chatgpt',
    matcher:/^https:\/\/chatgpt\.com\/backend-api\/conversations\/test(?:\/messages)?(?:\?.*)?$/,
    responseProcessor:'chatgpt-thread-json',paginationMode:'scroll-up-until-start',
    requestMethod:'GET',requestResourceType:null,pass:1,totalPasses:1,completedPasses:0,
    minDelayMs:3000,maxDelayMs:5000,timeoutMs:60000,
    phase:'capturing',attemptEpoch:1,attached:true,detaching:false,
    retryMaxAttempts:25,retryBaseSeconds:10,httpRetryCount:0,
    currentPassCaptured:false,pagesCapturedInPass:0,pageState:null,
    captures:[],events:[],pendingRequests:new Map(),bufferedPages:new Map(),
    currentPassTranscriptIds:new Set(),seenPageStartCursors:new Set(),
    acceptedRequestBeforeCursors:new Set(),cursorGapTimer:null,
    generationRestartCount:0,matchedRequests:0,timer:null};
  vm.runInContext('captureSessions',ctx).set(17,session);
  const sendError=async(code,id,before=null)=>{
    const url=`https://chatgpt.com/backend-api/conversations/test${before===null?'':'/messages?before='+before}`;
    listeners.network({tabId:17},'Network.requestWillBeSent',{
      requestId:id,type:'Fetch',request:{url,method:'GET'}});
    listeners.network({tabId:17},'Network.responseReceived',{
      requestId:id,response:{status:code,mimeType:'application/json'}});
    await new Promise(setImmediate);
  };
  const expire=async(expectedMs)=>{
    const entry=[...timers].find(([,t])=>t.ms===expectedMs);
    assert.ok(entry,`Retry delay ${expectedMs} was not scheduled`);
    timers.delete(entry[0]);await entry[1].fn();await new Promise(setImmediate);
  };
  return {ctx,session,timers,messages,methods,sendError,expire};
}

test('1.4.1: defaults are 10 retries/10s and 3–5s scroll, with 25-retry limit and 100ms manual floor',async()=>{
  const app={modules:{}};
  const storage={get:async()=>({}),set:async()=>{}};
  vm.runInNewContext(read('src/core/settings.js'),{__chatContextExporter:app,chrome:{storage:{local:storage}}});
  const {DEFAULT_SETTINGS:defaults,clampErrorRetryCount,clampDelay,loadSettings}=app.modules.settings;
  assert.equal(defaults.errorRetryCount,10);
  assert.equal(defaults.errorRetryBaseSeconds,10);
  assert.equal(defaults.minDelayMs,3000);
  assert.equal(defaults.maxDelayMs,5000);
  assert.equal(clampErrorRetryCount(25),25);
  assert.equal(clampErrorRetryCount(26),25);
  assert.equal(clampDelay(100,3000),100);
  const actual=await loadSettings();
  assert.equal(actual.errorRetryCount,10);
  assert.equal(actual.minDelayMs,3000);
  assert.equal(actual.maxDelayMs,5000);
  // Existing operator choices are not silently overwritten by the new defaults.
  storage.get=async()=>({errorRetryCount:5,errorRetryBaseSeconds:5,minDelayMs:100,maxDelayMs:1000});
  const legacy=await loadSettings();
  assert.equal(legacy.errorRetryCount,5);
  assert.equal(legacy.errorRetryBaseSeconds,5);
  assert.equal(legacy.minDelayMs,100);
  assert.equal(legacy.maxDelayMs,1000);
  const opts=read('src/options/options.html');
  assert.match(opts,/id="errorRetryCount" type="number" min="1" max="25"/);
  assert.match(opts,/id="minDelayMs" type="number" min="100"/);
  const optsJs=read('src/options/options.js');
  assert.match(optsJs,/errorRetryCount: 10/);
  assert.match(optsJs,/minDelayMs: 3000/);
  assert.match(optsJs,/maxDelayMs: 5000/);
  assert.match(optsJs,/max: 25, fallback: DEFAULT_SETTINGS.errorRetryCount/);
  assert.match(read('src/background/service-worker.js'),/clampInteger\(message\.settings\?\.errorRetryCount \?\? message\.errorRetryCount, 1, 25,/);
});

test('1.4.1: mixed HTTP 403/429/500 use 25 shared attempts and 10-second linear increments',async()=>{
  const h=workerHarness();
  for(let i=1;i<=25;i++){
    const code=[403,429,500][(i-1)%3];
    await h.sendError(code,`error-${i}`);
    assert.equal(h.session.httpRetryCount,i);
    assert.equal(h.session.phase,'waiting-http-retry');
    assert.equal(h.session.httpRetryStatus,code);
    assert.equal(h.session.retryMaxAttempts,25);
    assert.ok(h.session.events.some(e=>e.event==='CHATGPT_THREAD_RETRY_SCHEDULED'
      &&e.details.retry===i&&e.details.maxRetries===25&&e.details.delayMs===i*10000));
    await h.expire(i*10000);
    assert.equal(h.session.phase,'capturing');
    assert.equal(h.session.attemptEpoch,i+1);
  }
  await h.sendError(429,'error-26');
  assert.equal(h.session.phase,'error');
  assert.equal(h.session.httpRetryCount,25);
  assert.equal(h.methods.filter(x=>x==='Page.reload').length,25);
  assert.equal(h.session.sawHttp429,true);
});

test('1.4.1: unsolicited HTTP 429 warns operator without resetting healthy cursor chain',async()=>{
  const h=workerHarness();
  h.session.pageState={pageSequence:1,startCursor:'cursor-1',hasPreviousPage:true};
  await h.sendError(429,'initial-repeat');
  assert.equal(h.session.phase,'capturing');
  assert.equal(h.session.httpRetryCount,0);
  assert.equal(h.session.sawHttp429,true);
  assert.ok(h.messages.some(m=>m.state?.sawHttp429 === true));
  assert.ok(h.session.events.some(e=>e.event==='CHATGPT_HTTP_429_SCROLL_DELAY_ADVICE'
    &&e.details.expectedCursorRequest===false));
  assert.equal(h.methods.filter(x=>x==='Page.reload').length,0);
});

test('1.4.1: regular and early panels display persistent advice independent of scan status',()=>{
  const main=read('src/ui/panel.js');
  const early=read('src/content/early-panel.js');
  const runtime=read('src/content/start.js');
  for(const file of [main,early]){
    assert.match(file,/HTTP 429: увеличьте задержку прокрутки в настройках\./);
    assert.match(file,/rate-limit-hint/);
  }
  assert.match(main,/setRateLimitWarning\(visible\)/);
  assert.match(runtime,/runtime\.panel\.setRateLimitWarning\?\.\(state\.sawHttp429 === true\)/);
  assert.match(early,/ui\.rateLimitHint\.hidden = lastState\?\.sawHttp429 !== true/);
});
