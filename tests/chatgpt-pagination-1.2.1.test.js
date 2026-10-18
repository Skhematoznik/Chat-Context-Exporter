'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/background/service-worker.js'), 'utf8');
const pages = require('./fixtures/chatgpt-cursor-chain.json');

function createHarness({pageInfoList=pages} = {}) {
  const timers = new Map();
  const commands = [];
  const handlers = {};
  let seq=0;
  const bodies = new Map();
  const chrome = {
    debugger: {
      onEvent: {addListener: f=>handlers.event=f},
      onDetach: {addListener: f=>handlers.detach=f},
      sendCommand: async (_target,method, params) => {
        commands.push({method,params});
        if (method === 'Network.getResponseBody') return {body:bodies.get(params.requestId),base64Encoded:false};
        return {};
      },
      detach:async()=>{},
    },
    tabs:{sendMessage:async()=>{},onUpdated:{addListener:f=>handlers.updated=f},onRemoved:{addListener:f=>handlers.removed=f}},
    action:{onClicked:{addListener:()=>{}}},
    runtime:{onMessage:{addListener:f=>handlers.message=f}},
    storage:{session:{set:async()=>{},get:async()=>({}),remove:async()=>{}}},
    scripting:{executeScript:async()=>{}},
  };
  const context=vm.createContext({
    chrome, URL, TextDecoder, TextEncoder, structuredClone, console,
    crypto:{randomUUID:()=>`uuid-${++seq}`},
    setTimeout(fn,ms){const id=++seq;timers.set(id,{fn,ms});return id;},
    clearTimeout(id){timers.delete(id);},
    importScripts(){},
    __chatContextExporterThreadWireParser:{parsePageBody(body){
      const data=JSON.parse(body);
      return {pageInfo:{...data.pageInfo},rawMessages:data.rawMessages,
        stats:{total:2,user:1,assistant:1},messages:[{id:`message-${data.pageInfo.startCursor}`}]};
    }},
    __chatContextExporterShareWireParser:{parseDocumentBody:()=>({})},
  });
  vm.runInContext(source,context);
  const session = {
    tabId:19,id:'id',adapterId:'chatgpt',
    matcher:/^https:\/\/chatgpt\.com\/backend-api\/conversations\/thread\/messages(?:\?.*)?$/,
    paginationMode:'scroll-up-until-start',responseProcessor:'chatgpt-thread-json',
    requestMethod:'GET',requestResourceType:null,
    pass:1,totalPasses:1,attemptEpoch:1,phase:'capturing',
    minDelayMs:100,maxDelayMs:1000,timeoutMs:180000,
    pageState:null,pagesCapturedInPass:0,currentPassCaptured:false,
    currentPassTranscriptIds:new Set(),seenPageStartCursors:new Set(),acceptedRequestBeforeCursors:new Set(),bufferedPages:new Map(),
    bufferedPageBytes:0,cursorGapTimer:null,cursorGapStartedAt:null,drainingPages:false,
    generationRestartCount:0,http403RetryCount:0,http429RetryCount:0,http500RetryCount:0,
    captures:[],events:[],pendingRequests:new Map(),
    matchedRequests:0,timer:null,attached:true,detaching:false,error:null,
  };
  vm.runInContext('captureSessions',context).set(19,session);
  function sendPage(index,id=`p${index}`) {
    const page=pageInfoList[index];
    const before = index===0 ? '' : `?before=${encodeURIComponent(pageInfoList[index-1].startCursor)}`;
    const url='https://chatgpt.com/backend-api/conversations/thread/messages'+before;
    bodies.set(id,JSON.stringify({pageInfo:page,rawMessages:page.rawMessages}));
    handlers.event({tabId:19},'Network.requestWillBeSent',{requestId:id,type:'Fetch',request:{url,method:'GET'}});
    handlers.event({tabId:19},'Network.responseReceived',{requestId:id,response:{status:200,mimeType:'application/json'}});
    handlers.event({tabId:19},'Network.loadingFinished',{requestId:id,encodedDataLength:1000});
  }
  const flush=async()=>{for(let i=0;i<12;i++) await new Promise(r=>setImmediate(r));};
  async function expire(ms) {
    const t=[...timers].filter(([,x])=>x.ms===ms).at(-1);
    assert.ok(t,`missing timeout ${ms}`);
    timers.delete(t[0]);t[1].fn();await flush();
  }
  return {session,handlers,sendPage,flush,expire,timers,commands,context};
}

test('real six-cursor cascade accepts pages in order without extra scroll',async()=>{
  const h=createHarness();
  h.sendPage(0);await h.flush();
  assert.equal(h.session.phase,'awaiting-scroll');
  assert.equal(h.session.pagesCapturedInPass,1);
  // The browser can launch the first legitimate request before the scroll coordinator arms.
  h.sendPage(1);await h.flush();
  // Four further pages may arrive while the extension is still in awaiting-scroll.
  for(let i=2;i<6;i++) h.sendPage(i);
  await h.flush();
  assert.equal(h.session.pagesCapturedInPass,6);
  assert.equal(h.session.captures.length,6);
  assert.equal(h.session.pageState.startCursor,pages[5].startCursor);
  assert.equal(h.session.bufferedPages.size,0);
  assert.equal(h.session.events.filter(x=>x.event==='CHATGPT_THREAD_PAGE_BUFFERED').length,5);
  assert.equal(h.session.events.filter(x=>x.event==='CHATGPT_THREAD_RESPONSE_SKIPPED').length,0);
});

test('future pages are buffered and linked after missing intermediate arrives',async()=>{
  const h=createHarness();
  h.sendPage(0);await h.flush();
  h.sendPage(2);h.sendPage(4);h.sendPage(3);await h.flush();
  assert.equal(h.session.pagesCapturedInPass,1);
  assert.equal(h.session.bufferedPages.size,3);
  assert.ok(h.session.cursorGapTimer!==null);
  h.sendPage(1);await h.flush();
  assert.equal(h.session.pagesCapturedInPass,5);
  assert.equal(h.session.bufferedPages.size,0);
  assert.equal(h.session.cursorGapTimer,null);
});

test('unresolved gap fails with exact CURSOR_CHAIN_INCOMPLETE, no partial success',async()=>{
  const h=createHarness();
  h.sendPage(0);await h.flush();
  h.sendPage(2);await h.flush();
  await h.expire(15000);
  assert.equal(h.session.phase,'error');
  assert.match(h.session.error,/CURSOR_CHAIN_INCOMPLETE/);
  assert.ok(h.session.events.some(x=>x.event==='CHATGPT_THREAD_CURSOR_CHAIN_INCOMPLETE'));
  assert.ok(!h.session.events.some(x=>x.event==='CAPTURE_READY'));
  assert.equal(h.session.captures.length,1);
});

test('a page observed before initial tail is retained and drained',async()=>{
  const h=createHarness();
  h.sendPage(1);await h.flush();
  assert.equal(h.session.bufferedPages.size,1);
  h.sendPage(0);await h.flush();
  assert.equal(h.session.pagesCapturedInPass,2);
  assert.equal(h.session.bufferedPages.size,0);
});

test('duplicate before cursor does not duplicate accepted messages',async()=>{
  const h=createHarness();
  h.sendPage(0);await h.flush();
  h.sendPage(1);h.sendPage(1,'dup');await h.flush();
  assert.equal(h.session.captures.length,2);
  assert.ok(h.session.events.some(x=>x.event==='CHATGPT_THREAD_RESPONSE_SKIPPED' && x.details.reason==='duplicate-before-cursor'));
});

test('generation-stabilization restart discards incomplete current pass only once',async()=>{
  const h=createHarness();
  h.session.pass=2;h.session.totalPasses=2;
  h.session.captures.push({pass:1,requestId:'prior'});
  h.sendPage(0);await h.flush();
  const result=await vmFakeRestart(h);
  assert.equal(result.ok,true);
  assert.equal(h.session.phase,'capturing');
  assert.equal(h.session.pagesCapturedInPass,0);
  assert.equal(h.session.captures.length,1);
  assert.equal(h.session.captures[0].pass,1);
  assert.equal(h.session.generationRestartCount,1);
  assert.ok(h.commands.some(x=>x.method==='Page.reload'));
  const denied=await vmFakeRestart(h);
  assert.equal(denied.ok,false);
  assert.equal(h.session.phase,'error');
  assert.match(h.session.error,/Автоматический повтор ограничен/);
});

async function vmFakeRestart(h){
  let respond;
  const done=new Promise(resolve=>respond=resolve);
  h.handlers.message({type:'chat-context-exporter:capture:generation-restart'}, {tab:{id:19}}, respond);
  await h.flush();return done;
}

test('generation guard sees active Stop, not terminal Retry, and ignores hidden Stop',()=>{
  const src=fs.readFileSync(path.join(root,'src/adapters/chatgpt/generation-guard.js'),'utf8');
  const ctx=vm.createContext({});vm.runInContext(src,ctx);
  const check=ctx.__chatContextExporterGenerationGuard.isGenerating;
  const node=(label, hidden=false)=>({disabled:false,getAttribute:k=>k==='aria-label'?label:null,closest:()=>hidden?{}:null,
    getClientRects:()=>[{width:32,height:32}], ownerDocument:{defaultView:{getComputedStyle:()=>({visibility:'visible'})}}});
  assert.equal(check({querySelectorAll:()=>[node('Остановить')]}),true);
  assert.equal(check({querySelectorAll:()=>[node('Stop generating')]}),true);
  assert.equal(check({querySelectorAll:()=>[node('Остановить',true)]}),false);
  assert.equal(check({querySelectorAll:()=>[node('Повторить')]}),false);
  const activeFixture='<button aria-label="Остановить" type="button"></button>';
  const finishedFixture='<button type="button">Повторить</button>';
  assert.match(activeFixture,/aria-label="Остановить"/);
  assert.doesNotMatch(finishedFixture,/aria-label="Остановить"/);
});

test('short ready chat is eligible for a single generation-stabilization recapture',async()=>{
  const h=createHarness({pageInfoList:[{...pages[0],hasPreviousPage:false}]});
  h.sendPage(0);await h.flush();
  assert.equal(h.session.phase,'ready');
  assert.equal(h.session.captures.length,1);
  const result=await vmFakeRestart(h);
  assert.equal(result.ok,true);
  assert.equal(h.session.captures.length,0);
  assert.equal(h.session.phase,'capturing');
  assert.equal(h.session.generationRestartCount,1);
});

test('cancellation invalidates pending gap watchdog and prevents later reload',async()=>{
  const h=createHarness();h.sendPage(0);await h.flush();h.sendPage(2);await h.flush();
  assert.ok(h.session.cursorGapTimer!==null);
  let respond;
  const done=new Promise(resolve=>respond=resolve);
  h.handlers.message({type:'chat-context-exporter:capture:cancel'}, {tab:{id:19}}, respond);
  await h.flush();await done;
  assert.equal(h.session.phase,'cancelled');
  assert.equal(h.session.cursorGapTimer,null);
  assert.equal(h.timers.size,0);
  assert.ok(!h.commands.some(x=>x.method==='Page.reload'));
});

test('pending expected request remains visible until CDP body capture completes',async()=>{
  const h=createHarness();h.sendPage(0);await h.flush();
  const url=`https://chatgpt.com/backend-api/conversations/thread/messages?before=${pages[0].startCursor}`;
  h.handlers.event({tabId:19},'Network.requestWillBeSent',{
    requestId:'pending',type:'Fetch',request:{url,method:'GET'},
  });
  let state=vm.runInContext('serializeCaptureSession(captureSessions.get(19))',
    // VM context access is available through the captured runtime context in harness below.
    h.context);
  assert.equal(state.paginationRequest.beforeCursor,pages[0].startCursor);
  assert.equal(state.paginationRequest.handled,false);
});


// Candidate 1.3: HTTP 429 is handled only for the cursor currently required
// by the pagination chain. Accepted pages are checkpointed and revalidated.
function send429(h, {id='rate-limited',before,headers={}}={}) {
  const url='https://chatgpt.com/backend-api/conversations/thread/messages'
    +(before ? `?before=${encodeURIComponent(before)}` : '');
  h.handlers.event({tabId:19},'Network.requestWillBeSent',{
    requestId:id,type:'Fetch',request:{url,method:'GET'},
  });
  h.handlers.event({tabId:19},'Network.responseReceived',{
    requestId:id,response:{status:429,mimeType:'application/json',headers},
  });
}

test('429 on expected cursor preserves accepted pages, waits, verifies them and continues',async()=>{
  const h=createHarness();
  for(let i=0;i<3;i++){h.sendPage(i);await h.flush();}
  assert.equal(h.session.captures.length,3);
  const previous=h.session.captures.slice();
  send429(h,{before:pages[2].startCursor});await h.flush();
  assert.equal(h.session.phase,'waiting-http-retry');
  assert.equal(h.session.captures.length,3);
  assert.equal(h.commands.filter(c=>c.method==='Page.reload').length,0);
  assert.ok(h.session.events.some(e=>e.event==='CHATGPT_THREAD_HTTP_429_RETRY_SCHEDULED'
    && e.details.preservedPages===3 && e.details.delayMs===120000));
  await h.expire(120000);
  assert.equal(h.session.phase,'capturing');
  assert.equal(h.session.pageState,null);
  assert.equal(h.session.http429Checkpoint.length,3);
  assert.equal(h.session.captures.length,3);
  assert.equal(h.commands.filter(c=>c.method==='Page.reload').length,1);
  for(let i=0;i<3;i++){h.sendPage(i,`replayed-${i}`);await h.flush();}
  assert.equal(h.session.captures.length,3);
  assert.equal(h.session.http429Checkpoint,null);
  assert.equal(h.session.pagesCapturedInPass,3);
  for(let i=0;i<3;i++)assert.equal(h.session.captures[i],previous[i]);
  h.sendPage(3,'continued-page');await h.flush();
  assert.equal(h.session.captures.length,4);
  assert.equal(h.session.captures[3].pageSequence,4);
  assert.equal(h.session.pageState.startCursor,pages[3].startCursor);
  assert.ok(h.session.events.some(e=>e.event==='CHATGPT_THREAD_HTTP_429_CHECKPOINT_RESTORED'
    && e.details.preservedPages===3));
});

test('429 Retry-After is respected; overlong server restriction cannot trigger reload',async()=>{
  const h=createHarness();h.sendPage(0);await h.flush();
  send429(h,{before:pages[0].startCursor,headers:{'retry-after':'240'}});await h.flush();
  assert.equal(h.session.phase,'waiting-http-retry');
  assert.ok([...h.timers.values()].some(t=>t.ms===240000));
  assert.equal(h.commands.filter(c=>c.method==='Page.reload').length,0);
  const g=createHarness();g.sendPage(0);await g.flush();
  send429(g,{before:pages[0].startCursor,headers:{'Retry-After':'1200'}});await g.flush();
  assert.equal(g.session.phase,'error');
  assert.match(g.session.error,/HTTP 429.*1200/);
  assert.ok(!g.commands.some(c=>c.method==='Page.reload'));
});

test('second HTTP 429 after cooldown is terminal and cannot save a partial first pass',async()=>{
  const h=createHarness();h.sendPage(0);await h.flush();
  send429(h,{before:pages[0].startCursor});await h.flush();await h.expire(120000);
  h.sendPage(0,'replayed');await h.flush();
  send429(h,{id:'again',before:pages[0].startCursor});await h.flush();
  assert.equal(h.session.phase,'error');
  assert.match(h.session.error,/HTTP 429/);
  assert.ok(!h.session.events.some(e=>e.event==='CAPTURE_READY'));
  assert.equal(h.commands.filter(c=>c.method==='Page.reload').length,1);
  assert.equal(h.session.captures.length,1);
});

test('429 on unsolicited initial requests is ignored and never initiates reload',async()=>{
  const h=createHarness();h.sendPage(0);await h.flush();
  send429(h,{before:null});await h.flush();
  assert.equal(h.session.phase,'awaiting-scroll');
  assert.equal(h.session.http429RetryCount,0);
  assert.ok(!h.commands.some(c=>c.method==='Page.reload'));
});

test('changed historical content after reload is rejected, even with equal cursors',async()=>{
  const h=createHarness();h.sendPage(0);await h.flush();h.sendPage(1);await h.flush();
  send429(h,{before:pages[1].startCursor});await h.flush();await h.expire(120000);
  h.sendPage(0,'replayed-tail');await h.flush();
  h.session.http429Checkpoint[1].processed.messages[0].id='tampered-historical-message';
  h.sendPage(1,'changed-history');await h.flush();
  assert.equal(h.session.phase,'error');
  assert.match(h.session.error,/HTTP_429_CHECKPOINT_MISMATCH/);
  assert.ok(!h.session.events.some(e=>e.event==='CAPTURE_READY'));
});

test('tail finalized during cooldown is refreshed only when all cursor boundaries match',async()=>{
  const h=createHarness();h.sendPage(0);await h.flush();h.sendPage(1);await h.flush();
  const oldTail=h.session.captures[0];
  send429(h,{before:pages[1].startCursor});await h.flush();await h.expire(120000);
  oldTail.processed.messages[0].id='stale-partial-assistant';
  h.sendPage(0,'fresh-final-tail');await h.flush();
  assert.equal(h.session.phase,'awaiting-scroll');
  assert.equal(h.session.captures[0],oldTail);
  assert.equal(h.session.captures[0].processed.messages[0].id,`message-${pages[0].startCursor}`);
  assert.ok(h.session.events.some(e=>e.event==='CHATGPT_THREAD_HTTP_429_TAIL_REFRESHED'));
  h.sendPage(1,'unchanged-history');await h.flush();
  assert.equal(h.session.captures.length,2);
  assert.equal(h.session.http429Checkpoint,null);
});

test('cancel during rate-limit cooldown prevents a delayed reload',async()=>{
  const h=createHarness();h.sendPage(0);await h.flush();
  send429(h,{before:pages[0].startCursor});await h.flush();
  let respond;
  const done=new Promise(resolve=>respond=resolve);
  h.handlers.message({type:'chat-context-exporter:capture:cancel'},{tab:{id:19}},respond);
  await h.flush();await done;
  assert.equal(h.session.phase,'cancelled');
  assert.equal(h.timers.size,0);
  assert.ok(!h.commands.some(c=>c.method==='Page.reload'));
});

test('after HTTP 429 cooldown, a revalidated checkpoint can reach start without duplicate captures',async()=>{
  const fixture=pages.map((p,i)=>({...p,hasPreviousPage:i!==pages.length-1}));
  const h=createHarness({pageInfoList:fixture});
  for(let i=0;i<4;i++){h.sendPage(i);await h.flush();}
  send429(h,{before:fixture[3].startCursor});await h.flush();
  await h.expire(120000);
  for(let i=0;i<fixture.length;i++){h.sendPage(i,`retry-${i}`);await h.flush();}
  assert.equal(h.session.phase,'ready');
  assert.equal(h.session.captures.length,fixture.length);
  assert.equal(h.session.pagesCapturedInPass,fixture.length);
  assert.equal(h.session.http429Checkpoint,null);
  assert.ok(h.session.events.some(e=>e.event==='CHATGPT_THREAD_START_REACHED'));
  assert.equal(h.commands.filter(c=>c.method==='Page.reload').length,1);
});

test('second-pass repeated 429 falls back to the already completed first pass',async()=>{
  const h=createHarness();
  h.session.pass=2;h.session.totalPasses=2;h.session.completedPasses=1;
  h.session.captures.push({pass:1,requestId:'complete-pass'});
  h.sendPage(0);await h.flush();
  send429(h,{before:pages[0].startCursor});await h.flush();await h.expire(120000);
  h.sendPage(0,'replayed');await h.flush();
  send429(h,{id:'retry-failed',before:pages[0].startCursor});await h.flush();
  assert.equal(h.session.phase,'ready');
  assert.match(h.session.captureWarning,/Дополнительная проверка/);
  assert.equal(h.session.captures.length,1);
  assert.equal(h.session.captures[0].requestId,'complete-pass');
  assert.ok(h.session.events.some(e=>e.event==='CHATGPT_EXTRA_PASS_SKIPPED'));
});

// Candidate 1.3.4: HTTP 500 retry with the same in-memory cursor checkpoint
// guarantees as 429, but a separate bounded retry budget and delay.
function send500(h, { id = 'internal-error', before, headers = {} } = {}) {
  const url = 'https://chatgpt.com/backend-api/conversations/thread/messages'
    + (before ? `?before=${encodeURIComponent(before)}` : '');
  h.handlers.event({tabId:19}, 'Network.requestWillBeSent', {
    requestId: id, type: 'Fetch', request: {url, method: 'GET'},
  });
  h.handlers.event({tabId:19}, 'Network.responseReceived', {
    requestId: id, response: {status:500, mimeType:'application/json', headers},
  });
}

test('HTTP 500 preserves accepted pages, delays 30 seconds, revalidates and continues with no duplicates', async () => {
  const h = createHarness();
  for (let i=0;i<3;i++){h.sendPage(i);await h.flush();}
  const accepted = h.session.captures.slice();
  send500(h,{before:pages[2].startCursor});await h.flush();
  assert.equal(h.session.phase,'waiting-http-retry');
  assert.equal(h.session.httpRetryStatus,500);
  assert.equal(h.session.http500RetryCount,1);
  assert.equal(h.session.captures.length,3);
  assert.equal(h.commands.filter(c=>c.method==='Page.reload').length,0);
  assert.ok(h.session.events.some(e=>e.event==='CHATGPT_THREAD_HTTP_500_RETRY_SCHEDULED'
    &&e.details.delayMs===30000 &&e.details.preservedPages===3));
  await h.expire(30000);
  assert.equal(h.session.phase,'capturing');
  assert.equal(h.session.http500Checkpoint.length,3);
  assert.equal(h.session.pageState,null);
  assert.equal(h.commands.filter(c=>c.method==='Page.reload').length,1);
  for(let i=0;i<3;i++){h.sendPage(i,`500-replayed-${i}`);await h.flush();}
  assert.equal(h.session.http500Checkpoint,null);
  assert.equal(h.session.captures.length,3);
  for(let i=0;i<3;i++) assert.equal(h.session.captures[i],accepted[i]);
  h.sendPage(3,'continued-after-500');await h.flush();
  assert.equal(h.session.captures.length,4);
  assert.equal(h.session.pagesCapturedInPass,4);
  assert.ok(h.session.events.some(e=>e.event==='CHATGPT_THREAD_HTTP_500_CHECKPOINT_RESTORED'
    &&e.details.preservedPages===3));
});

test('HTTP 500 respects bounded Retry-After and avoids overly late reload',async()=>{
  const h=createHarness();h.sendPage(0);await h.flush();
  send500(h,{before:pages[0].startCursor,headers:{'Retry-After':'75'}});await h.flush();
  assert.equal(h.session.phase,'waiting-http-retry');
  assert.ok([...h.timers.values()].some(t=>t.ms===75000));
  const g=createHarness();g.sendPage(0);await g.flush();
  send500(g,{before:pages[0].startCursor,headers:{'Retry-After':'360'}});await g.flush();
  assert.equal(g.session.phase,'error');
  assert.match(g.session.error,/HTTP 500.*360/);
  assert.ok(!g.commands.some(c=>c.method==='Page.reload'));
});

test('second HTTP 500 on required cursor fails mandatory pass without another reload',async()=>{
  const h=createHarness();h.sendPage(0);await h.flush();
  send500(h,{before:pages[0].startCursor});await h.flush();await h.expire(30000);
  h.sendPage(0,'retry-page');await h.flush();
  send500(h,{id:'500-again',before:pages[0].startCursor});await h.flush();
  assert.equal(h.session.phase,'error');
  assert.match(h.session.error,/HTTP 500/);
  assert.match(h.session.error,/Экспорт не создан/);
  assert.ok(!h.session.events.some(e=>e.event==='CAPTURE_READY'));
  assert.equal(h.commands.filter(c=>c.method==='Page.reload').length,1);
});

test('HTTP 500 in optional pass retries once, then retains full first pass without contradictory warning',async()=>{
  const h=createHarness();h.session.pass=2;h.session.totalPasses=2;h.session.completedPasses=1;
  h.session.captures.push({pass:1,requestId:'completed-main'});
  h.sendPage(0);await h.flush();
  send500(h,{before:pages[0].startCursor});await h.flush();await h.expire(30000);
  h.sendPage(0,'500-extra-replay');await h.flush();
  send500(h,{id:'500-extra-failed',before:pages[0].startCursor});await h.flush();
  assert.equal(h.session.phase,'ready');
  assert.equal(h.session.captures.length,1);
  assert.equal(h.session.captures[0].requestId,'completed-main');
  assert.match(h.session.captureWarning,/Сохранён только полный проход 1 из 2/);
  assert.doesNotMatch(h.session.captureWarning,/Экспорт не создан|история неполная/);
  assert.ok(h.session.events.some(e=>e.event==='CHATGPT_EXTRA_PASS_SKIPPED'));
  assert.equal(h.commands.filter(c=>c.method==='Page.reload').length,1);
});

test('HTTP 500 checkpoint rejects modified historic page even when cursors remain the same',async()=>{
  const h=createHarness();h.sendPage(0);await h.flush();h.sendPage(1);await h.flush();
  send500(h,{before:pages[1].startCursor});await h.flush();await h.expire(30000);
  h.sendPage(0,'tail-replayed-500');await h.flush();
  h.session.http500Checkpoint[1].processed.messages[0].id='changed-history-500';
  h.sendPage(1,'history-replayed-500');await h.flush();
  assert.equal(h.session.phase,'error');
  assert.match(h.session.error,/HTTP_500_CHECKPOINT_MISMATCH/);
});

test('unrelated HTTP 500 does not disturb pagination or schedule a recovery',async()=>{
  const h=createHarness();h.sendPage(0);await h.flush();
  send500(h,{before:null});await h.flush();
  assert.equal(h.session.phase,'awaiting-scroll');
  assert.equal(h.session.http500RetryCount || 0,0);
  assert.ok(!h.commands.some(c=>c.method==='Page.reload'));
});

test('cancel during HTTP 500 pause disarms the delayed reload',async()=>{
  const h=createHarness();h.sendPage(0);await h.flush();
  send500(h,{before:pages[0].startCursor});await h.flush();
  let respond;const done=new Promise(r=>respond=r);
  h.handlers.message({type:'chat-context-exporter:capture:cancel'},{tab:{id:19}},respond);
  await h.flush();await done;
  assert.equal(h.session.phase,'cancelled');
  assert.equal(h.timers.size,0);
  assert.ok(!h.commands.some(c=>c.method==='Page.reload'));
});

test('HTTP 500 recovery can replay a full checkpoint and reach the beginning',async()=>{
  const list=pages.map((p,i)=>({...p,hasPreviousPage:i!==pages.length-1}));
  const h=createHarness({pageInfoList:list});
  for(let i=0;i<3;i++){h.sendPage(i);await h.flush();}
  send500(h,{before:list[2].startCursor});await h.flush();await h.expire(30000);
  for(let i=0;i<list.length;i++){h.sendPage(i,`replay-all-500-${i}`);await h.flush();}
  assert.equal(h.session.phase,'ready');
  assert.equal(h.session.captures.length,list.length);
  assert.equal(h.session.http500Checkpoint,null);
  assert.ok(h.session.events.some(e=>e.event==='CHATGPT_THREAD_START_REACHED'));
});

test('HTTP 500 on initial page retries safely with zero preserved pages',async()=>{
  const h=createHarness();
  send500(h,{before:null});await h.flush();
  assert.equal(h.session.phase,'waiting-http-retry');
  await h.expire(30000);
  assert.equal(h.session.phase,'capturing');
  assert.equal(h.session.http500Checkpoint,null);
  h.sendPage(0,'initial-500-retry-success');await h.flush();
  assert.equal(h.session.captures.length,1);
  assert.equal(h.session.pagesCapturedInPass,1);
});
