'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, '../src/background/service-worker.js'), 'utf8');

function harness() {
  const timers = new Map();
  const commands = [];
  const handlers = {};
  let sequence = 0;
  const chrome = {
    debugger: {
      onEvent: { addListener: (fn) => { handlers.network = fn; } },
      onDetach: { addListener: (fn) => { handlers.detach = fn; } },
      sendCommand: async (_, method, params) => {
        commands.push({ method, params });
        if (method === 'Network.getResponseBody') {
          return { body: '{"page":"unused"}', base64Encoded: false };
        }
        return {};
      },
      detach: async () => {},
    },
    tabs: {
      sendMessage: async () => {},
      onUpdated: { addListener: (fn) => { handlers.updated = fn; } },
      onRemoved: { addListener: (fn) => { handlers.removed = fn; } },
    },
    action: { onClicked: { addListener: () => {} } },
    runtime: { onMessage: { addListener: () => {} } },
    storage: { session: { remove: async () => {}, set: async () => {}, get: async () => ({}) } },
    scripting: { executeScript: async () => {} },
  };
  const context = vm.createContext({
    chrome, URL, TextEncoder, TextDecoder, console, structuredClone,
    setTimeout(fn, ms) { const id = ++sequence; timers.set(id, {fn, ms}); return id; },
    clearTimeout(id) { timers.delete(id); },
    importScripts() {},
    crypto: { randomUUID: () => 'fixed-id' },
    __chatContextExporterThreadWireParser: { parsePageBody: () => ({
      pageInfo: { startCursor: 'older', endCursor: 'end', hasPreviousPage: false, hasNextPage: false },
      stats: { total: 2 }, messages: [], rawMessages: 2,
    }) },
    __chatContextExporterShareWireParser: { parseDocumentBody: () => ({}) },
  });
  vm.runInContext(SOURCE, context, { filename: 'service-worker.js' });
  const sessions = vm.runInContext('captureSessions', context);
  const session = {
    id: 'capture:test', tabId: 19, adapterId: 'chatgpt',
    matcher: /^https:\/\/chatgpt\.com\/backend-api\/conversations\/thread(?:\/messages)?(?:\?.*)?$/,
    responseProcessor: 'chatgpt-thread-json', paginationMode: 'scroll-up-until-start',
    requestMethod: 'GET', requestResourceType: null,
    totalPasses: 1, minDelayMs: 100, maxDelayMs: 1000, timeoutMs: 60_000,
    retryMaxAttempts: 5, retryBaseSeconds: 5,
    phase: 'capturing', pass: 1, attemptEpoch: 1, http403RetryCount: 0, http429RetryCount: 0, http500RetryCount: 0,
    captures: [{pass: 1, requestId:'old-page'}, {pass: 0, requestId:'older-past-pass'}],
    currentPassCaptured: false, pagesCapturedInPass: 1,
    pageState: {pageSequence:1,startCursor:'cursor-1',hasPreviousPage:true},
    seenPageStartCursors: new Set(['cursor-1']), currentPassTranscriptIds: new Set(['message-1']),
    pendingRequests: new Map(), matchedRequests: 0, events: [], timer: null,
    attached: true, detaching: false, error: null,
    lastReloadCompletedAt:0,lastReloadCompletedPass:0,
  };
  sessions.set(session.tabId, session);
  function request(id, url='https://chatgpt.com/backend-api/conversations/thread/messages?before=cursor-1') {
    handlers.network({tabId:19}, 'Network.requestWillBeSent', {
      requestId: id, type:'Fetch', request: {url, method:'GET'},
    });
  }
  function response(id,status,mime='text/html') {
    handlers.network({tabId:19}, 'Network.responseReceived', {
      requestId:id,response:{status,mimeType:mime},
    });
  }
  const flush = async () => { await new Promise((resolve) => setImmediate(resolve)); };
  const advance = async (ms) => {
    const timer= [...timers].find(([,v]) => v.ms===ms);
    assert.ok(timer, `Expected timer ${ms}`);
    timers.delete(timer[0]);
    await timer[1].fn();
    await flush();
  };
  return {session,handlers,timers,commands,request,response,flush,advance,context};
}

test('HTTP 403 restarts the same pass after 5000ms and does not mix partial pages',async()=>{
  const h=harness();
  h.session.pass=2; h.session.totalPasses=2;
  h.session.captures[0].pass=2; h.session.captures[1].pass=1;
  h.request('blocked-page');
  h.response('blocked-page',403);
  await h.flush();
  assert.equal(h.session.phase,'waiting-http-retry');
  assert.equal(h.session.http403RetryCount,1);
  assert.equal(h.session.captures.length,2,'captured data remains in memory during delay');
  assert.equal(h.session.error,null);
  assert.equal(h.commands.filter(x=>x.method==='Network.getResponseBody').length,0,'HTML refusal is not parsed');
  assert.ok(h.session.events.some(x=>x.event==='CHATGPT_THREAD_RETRY_SCHEDULED'&&x.details.delayMs===5000));
  await h.advance(5000);
  assert.equal(h.session.pass,2);
  assert.equal(h.session.phase,'capturing');
  assert.equal(h.session.attemptEpoch,2);
  assert.equal(h.session.captures.length,1);
  assert.equal(h.session.captures[0].pass,1,'complete prior pass preserved');
  assert.equal(h.session.pageState,null);
  assert.equal(h.session.currentPassTranscriptIds.size,0);
  assert.equal(h.commands.filter(x=>x.method==='Page.reload').length,1);
});

test('second HTTP 403 uses 10-second linear backoff in the shared budget',async()=>{
  const h=harness();
  h.request('blocked-page');h.response('blocked-page',403);await h.flush();
  await h.advance(5000);
  h.request('blocked-again','https://chatgpt.com/backend-api/conversations/thread');
  h.response('blocked-again',403);await h.flush();
  assert.equal(h.session.phase,'waiting-http-retry');
  assert.equal(h.session.httpRetryCount,2);
  assert.ok([...h.timers.values()].some(x=>x.ms===10000));
  await h.advance(10000);
  assert.equal(h.commands.filter(x=>x.method==='Page.reload').length,2);
});

test('cancelled session cannot reload after HTTP 403',async()=>{
  const h=harness(); h.request('blocked-page');h.response('blocked-page',403);await h.flush();
  h.session.phase='cancelled';
  vm.runInContext('clearCaptureTimer(captureSessions.get(19))',h.context);
  assert.ok(![...h.timers.values()].some(x=>x.ms===5000));
  assert.equal(h.commands.filter(x=>x.method==='Page.reload').length,0);
});

test('HTTP 429 schedules five-second restart of the current pass with five-retry limit',async()=>{
  const h=harness();h.request('rate-limited');h.response('rate-limited',429);await h.flush();
  assert.equal(h.session.phase,'waiting-http-retry');
  assert.equal(h.session.http429RetryCount,1);
  assert.equal(h.commands.filter(x=>x.method==='Network.getResponseBody').length,0);
  assert.equal(h.commands.filter(x=>x.method==='Page.reload').length,0);
  assert.ok([...h.timers.values()].some(x=>x.ms===5000));
  await h.advance(5000);
  assert.equal(h.session.http429RetryCount,1);
  assert.equal(h.commands.filter(x=>x.method==='Page.reload').length,1);
  assert.deepEqual(h.session.captures.map(x=>x.requestId), ['older-past-pass']);
});

test('stale loadingFinished response is ignored after HTTP 403 recovery',async()=>{
  const h=harness();h.request('blocked-page');h.response('blocked-page',403);await h.flush();
  await h.advance(5000);
  h.handlers.network({tabId:19},'Network.loadingFinished',{requestId:'blocked-page',encodedDataLength:100});
  await h.flush();
  assert.equal(h.session.phase,'capturing');
  assert.equal(h.commands.filter(x=>x.method==='Network.getResponseBody').length,0);
});

test('successful HTTP 200 after retry completes capture without reusing the incomplete first page',async()=>{
  const h=harness();h.request('blocked-page');h.response('blocked-page',403);await h.flush();
  await h.advance(5000);
  h.request('fresh-initial','https://chatgpt.com/backend-api/conversations/thread?num_turns=10');
  h.response('fresh-initial',200,'application/json');
  h.handlers.network({tabId:19},'Network.loadingFinished',{
    requestId:'fresh-initial',encodedDataLength:300,
  });
  await h.flush();
  assert.equal(h.session.phase,'ready');
  assert.equal(h.session.pass,1);
  assert.equal(h.session.pagesCapturedInPass,1);
  assert.equal(h.session.captures.length,2);
  assert.deepEqual(h.session.captures.map(x=>x.requestId),['older-past-pass','fresh-initial']);
  assert.equal(h.commands.filter(x=>x.method==='Network.getResponseBody').length,1);
  assert.ok(h.session.events.some(x=>x.event==='CAPTURE_READY'));
});

test('nonmatching HTTP 403 does not reset the active cursor chain',async()=>{
  const h=harness();h.request('unrelated','https://chatgpt.com/backend-api/conversations/thread?num_turns=10');
  h.response('unrelated',403);await h.flush();
  assert.equal(h.session.phase,'capturing');
  assert.equal(h.session.http403RetryCount,0);
  assert.ok(h.session.events.some(x=>x.event==='CHATGPT_THREAD_RESPONSE_SKIPPED'
    &&x.details.reason==='http-error-outside-current-cursor-chain'));
});

test('1.4: custom retry settings (3 repeats, 2-second base) apply to cursor and HTTP faults',async()=>{
  const h=harness();h.session.retryMaxAttempts=3;h.session.retryBaseSeconds=2;
  h.request('first');h.response('first',403);await h.flush();
  await h.advance(2000);
  const fail=vm.runInContext('failCaptureSession',h.context);
  await fail(h.session,new Error('Missing previous page'),'response-timeout');
  assert.equal(h.session.phase,'waiting-http-retry');
  assert.equal(h.session.httpRetryCount,2);
  await h.advance(4000);
  h.request('third','https://chatgpt.com/backend-api/conversations/thread');h.response('third',500);await h.flush();
  assert.equal(h.session.httpRetryCount,3);
  await h.advance(6000);
  await fail(h.session,new Error('Missing previous page'),'response-timeout');
  assert.equal(h.session.phase,'error');
  assert.equal(h.commands.filter(x=>x.method==='Page.reload').length,3);
});
