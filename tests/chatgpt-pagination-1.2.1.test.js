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
    retryMaxAttempts:5,retryBaseSeconds:5,
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

test('unresolved gap triggers shared recoverable retry, not partial success',async()=>{
  const h=createHarness();
  h.sendPage(0);await h.flush();
  h.sendPage(2);await h.flush();
  await h.expire(15000);
  assert.equal(h.session.phase,'waiting-http-retry');
  assert.equal(h.session.httpRetryCount,1);
  assert.ok(h.session.events.some(x=>x.event==='CHATGPT_THREAD_CURSOR_CHAIN_INCOMPLETE'));
  assert.ok(!h.session.events.some(x=>x.event==='CAPTURE_READY'));
  await h.expire(5000);
  assert.equal(h.session.captures.length,0);
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


// Candidate 1.3.9: HTTP 429 on required cursor restarts the current pass
// without pause, up to five times. No incomplete pages can survive a restart.
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

test('429 on required cursor reloads after linear backoff the pass, discarding incomplete pages',async()=>{
  const h=createHarness();
  for(let i=0;i<3;i++){h.sendPage(i);await h.flush();}
  send429(h,{before:pages[2].startCursor});await h.flush();
  assert.equal(h.session.phase,'waiting-http-retry');
  assert.equal(h.session.http429RetryCount,1);
  assert.ok(h.session.events.some(e=>e.event==='CHATGPT_THREAD_RETRY_SCHEDULED'
    &&e.details.delayMs===5000&&e.details.maxRetries===5));
  await h.expire(5000);
  assert.equal(h.session.phase,'capturing');
  assert.equal(h.session.pageState,null);
  assert.equal(h.session.captures.length,0);
  assert.equal(h.commands.filter(c=>c.method==='Page.reload').length,1);
  for(let i=0;i<4;i++){h.sendPage(i,`retry-${i}`);await h.flush();}
  assert.equal(h.session.captures.length,4);
  assert.equal(h.session.pagesCapturedInPass,4);
  assert.deepEqual(h.session.captures.map(c=>c.pageSequence),[1,2,3,4]);
});

test('HTTP 429 uses configured backoff independent of response headers',async()=>{
  const h=createHarness();h.sendPage(0);await h.flush();
  send429(h,{before:pages[0].startCursor,headers:{'Retry-After':'1200'}});await h.flush();
  assert.equal(h.session.phase,'waiting-http-retry');
  assert.ok([...h.timers.values()].some(t=>t.ms===5000));
  await h.expire(5000);
  assert.equal(h.commands.filter(c=>c.method==='Page.reload').length,1);
});

test('at most five HTTP 429 restarts; sixth error fails incomplete mandatory pass',async()=>{
  const h=createHarness();
  for(let i=1;i<=6;i++){
    send429(h,{id:`429-${i}`,before:null});await h.flush();
    if(i<=5){assert.equal(h.session.httpRetryCount,i);await h.expire(i*5000);}
  }
  assert.equal(h.session.phase,'error');
  assert.match(h.session.error,/HTTP 429/);
  assert.equal(h.commands.filter(c=>c.method==='Page.reload').length,5);
  assert.ok(!h.session.events.some(e=>e.event==='CAPTURE_READY'));
});

test('429 on unsolicited initial requests is ignored after the initial page is accepted',async()=>{
  const h=createHarness();h.sendPage(0);await h.flush();
  send429(h,{before:null});await h.flush();
  assert.equal(h.session.phase,'awaiting-scroll');
  assert.equal(h.session.http429RetryCount,0);
  assert.ok(!h.commands.some(c=>c.method==='Page.reload'));
});

test('new 429 restart always uses freshly loaded historical messages',async()=>{
  const h=createHarness();h.sendPage(0);await h.flush();h.sendPage(1);await h.flush();
  const oldTail=h.session.captures[0];
  send429(h,{before:pages[1].startCursor});await h.flush();await h.expire(5000);
  assert.equal(h.session.captures.length,0);
  h.sendPage(0,'fresh-tail');await h.flush();
  h.sendPage(1,'fresh-history');await h.flush();
  assert.equal(h.session.captures.length,2);
  assert.notEqual(h.session.captures[0],oldTail);
  assert.equal(h.session.http429Checkpoint,null);
});

test('cancel before immediate retry prevents reload',async()=>{
  const h=createHarness();h.sendPage(0);await h.flush();
  send429(h,{before:pages[0].startCursor});await h.flush();
  let respond; const done=new Promise(resolve=>respond=resolve);
  h.handlers.message({type:'chat-context-exporter:capture:cancel'},{tab:{id:19}},respond);
  await h.flush();await done;
  assert.equal(h.session.phase,'cancelled');
  assert.equal(h.timers.size,0);
  assert.ok(!h.commands.some(c=>c.method==='Page.reload'));
});

test('after immediate restart a complete cursor chain reaches the beginning',async()=>{
  const fixture=pages.map((p,i)=>({...p,hasPreviousPage:i!==pages.length-1}));
  const h=createHarness({pageInfoList:fixture});
  for(let i=0;i<4;i++){h.sendPage(i);await h.flush();}
  send429(h,{before:fixture[3].startCursor});await h.flush();await h.expire(5000);
  for(let i=0;i<fixture.length;i++){h.sendPage(i,`retry-${i}`);await h.flush();}
  assert.equal(h.session.phase,'ready');
  assert.equal(h.session.captures.length,fixture.length);
  assert.ok(h.session.events.some(e=>e.event==='CHATGPT_THREAD_START_REACHED'));
});

test('exhausted retries in optional pass retain complete primary capture',async()=>{
  const h=createHarness();
  h.session.pass=2;h.session.totalPasses=2;h.session.completedPasses=1;
  h.session.captures.push({pass:1,requestId:'complete-pass'});
  for(let i=1;i<=6;i++){
    send429(h,{id:`extra429-${i}`,before:null});await h.flush();
    if(i<=5) await h.expire(i*5000);
  }
  assert.equal(h.session.phase,'ready');
  assert.match(h.session.captureWarning,/Дополнительная проверка/);
  assert.equal(h.session.captures.length,1);
  assert.equal(h.session.captures[0].requestId,'complete-pass');
});

// 1.4: HTTP 500 uses the same retry budget as 403 and 429, restarts the pass.
function send500(h, {id='internal-error',before,headers={}}={}) {
  const url='https://chatgpt.com/backend-api/conversations/thread/messages'
    +(before ? `?before=${encodeURIComponent(before)}` : '');
  h.handlers.event({tabId:19},'Network.requestWillBeSent',{
    requestId:id,type:'Fetch',request:{url,method:'GET'},
  });
  h.handlers.event({tabId:19},'Network.responseReceived',{
    requestId:id,response:{status:500,mimeType:'application/json',headers},
  });
}

test('HTTP 500 waits five seconds, discards incomplete current pass, retains verified earlier pass',async()=>{
  const h=createHarness();h.session.pass=2;h.session.totalPasses=2;h.session.completedPasses=1;
  h.session.captures.push({pass:1,requestId:'verified-main'});
  h.sendPage(0);await h.flush();
  send500(h,{before:pages[0].startCursor});await h.flush();
  assert.equal(h.session.phase,'waiting-http-retry');
  assert.equal(h.session.httpRetryCount,1);
  assert.ok([...h.timers.values()].some(t=>t.ms===5000));
  await h.expire(5000);
  assert.equal(h.session.phase,'capturing');
  assert.equal(h.session.http500Checkpoint,null);
  assert.deepEqual(h.session.captures.map(c=>c.requestId),['verified-main']);
});

test('HTTP 500 obeys common linear backoff even if server supplies Retry-After',async()=>{
  const h=createHarness();
  send500(h,{headers:{'Retry-After':'360'}});await h.flush();
  assert.equal(h.session.phase,'waiting-http-retry');
  assert.ok([...h.timers.values()].some(t=>t.ms===5000));
  await h.expire(5000);
  send500(h,{id:'500-next',headers:{'Retry-After':'400'}});await h.flush();
  assert.equal(h.session.httpRetryCount,2);
  assert.ok([...h.timers.values()].some(t=>t.ms===10000));
});

test('mixed HTTP 403, 429, 500 consume one shared five-retry budget',async()=>{
  const h=createHarness();
  const codes=[403,429,500,403,429,500];
  for(let i=0;i<codes.length;i++){
    const id=`mixed-${i}`;
    const url='https://chatgpt.com/backend-api/conversations/thread/messages';
    h.handlers.event({tabId:19},'Network.requestWillBeSent',{
      requestId:id,type:'Fetch',request:{url,method:'GET'},
    });
    h.handlers.event({tabId:19},'Network.responseReceived',{
      requestId:id,response:{status:codes[i],mimeType:'application/json'},
    });
    await h.flush();
    if(i<5) {
      assert.equal(h.session.httpRetryCount,i+1);
      await h.expire((i+1)*5000);
    }
  }
  assert.equal(h.session.phase,'error');
  assert.equal(h.commands.filter(c=>c.method==='Page.reload').length,5);
  assert.match(h.session.error,/HTTP 500/);
});

test('HTTP 500 on unsolicited initial page does not reset accepted historical cursor',async()=>{
  const h=createHarness();h.sendPage(0);await h.flush();
  send500(h,{before:null});await h.flush();
  assert.equal(h.session.phase,'awaiting-scroll');
  assert.equal(h.session.httpRetryCount||0,0);
});

test('HTTP 500 successful reload can complete a valid full chain',async()=>{
  const list=pages.map((x,i)=>({...x,hasPreviousPage:i!==pages.length-1}));
  const h=createHarness({pageInfoList:list});
  for(let i=0;i<3;i++){h.sendPage(i);await h.flush();}
  send500(h,{before:list[2].startCursor});await h.flush();await h.expire(5000);
  for(let i=0;i<list.length;i++){h.sendPage(i,`fresh-${i}`);await h.flush();}
  assert.equal(h.session.phase,'ready');
  assert.equal(h.session.captures.length,list.length);
  assert.ok(h.session.events.some(x=>x.event==='CHATGPT_THREAD_START_REACHED'));
});
