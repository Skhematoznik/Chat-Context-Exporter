'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root=path.resolve(__dirname,'..');
const guardSource=fs.readFileSync(path.join(root,'src/adapters/chatgpt/generation-guard.js'),'utf8');
const guardContext=vm.createContext({});vm.runInContext(guardSource,guardContext);
const same=guardContext.__chatContextExporterGenerationGuard.isAuthoritativeLimitTailUnchanged;
const original={captured:true,authoritative:true,reason:'conversation-limit',conversationId:'abc',
  userMessageId:'u-last',userTurnKey:'t-last',userHash:'1234abcd',assistantHash:'f00dd00d',assistantChars:14};
const fresh={authoritative:true,reason:'conversation-limit',conversationId:'abc',
  user:{messageId:'u-last',turnKey:'t-last',hash:'1234abcd'},
  assistant:{hash:'f00dd00d',markdown:'0123456789abcd'}};
test('observed failed export HTML shows conversation-limit banner, not Stop or delivery timeout',()=>{
  const fixture=fs.readFileSync(path.join(root,'tests/fixtures/chatgpt-conversation-limit-1.3.7.html'),'utf8');
  assert.match(fixture,/<aside[^>]*role="alert"/);
  assert.match(fixture,/достигли максимальной длины этого обсуждения/);
  assert.doesNotMatch(fixture,/aria-label="Остановить"|data-testid="stop-button"/);
  assert.doesNotMatch(fixture,/Время ожидания доставки сообщения истекло/);
});
test('unchanged authoritative pre-reload DOM limit tail survives transient Stop without recapture',()=>{
  assert.equal(same(original,fresh),true);
});
test('changed answer, user, conversation or missing limit alert always requires recapture',()=>{
  assert.equal(same(original,{...fresh,assistant:{...fresh.assistant,hash:'changed'}}),false);
  assert.equal(same(original,{...fresh,assistant:{...fresh.assistant,markdown:'short'}}),false);
  assert.equal(same(original,{...fresh,user:{...fresh.user,messageId:'new'}}),false);
  assert.equal(same(original,{...fresh,user:{...fresh.user,turnKey:'new'}}),false);
  assert.equal(same(original,{...fresh,user:{...fresh.user,hash:'changed'}}),false);
  assert.equal(same(original,{...fresh,conversationId:'wrong'}),false);
  assert.equal(same(original,{...fresh,reason:'delivery-failure'}),false);
  assert.equal(same(original,null),false);
  assert.equal(same({...original,assistantHash:null},fresh),false);
  assert.equal(same({...original,authoritative:false},fresh),false);
  assert.equal(same({...original,userMessageId:null},fresh),false);
});
test('pre-reload tail preserved; no subsequent Stop check can block scrolling',()=>{
  const content=fs.readFileSync(path.join(root,'src/content/start.js'),'utf8');
  assert.doesNotMatch(content,/hasUnchangedLimitTail\(/);
  assert.doesNotMatch(content,/ensureGenerationSettledBeforeScroll\(/);
  assert.match(content,/if \(config\.responseProcessor === 'chatgpt-thread-json' && isChatGptGenerating\(\)\)/);
  const bg=fs.readFileSync(path.join(root,'src/background/service-worker.js'),'utf8');
  assert.match(bg,/attemptEpoch: session\.attemptEpoch \|\| 0/);
  assert.match(bg,/userHash: session\.preReloadTailSnapshot\.user\?\.hash/);
});

test('old scroll coordinator refuses movement after a 429 reload changed attemptEpoch',async()=>{
  const content=fs.readFileSync(path.join(root,'src/content/start.js'),'utf8');
  const start=content.indexOf('  async function advanceNetworkPagination(state, currentSettings) {');
  const end=content.indexOf('  async function signalRecoverablePaginationFailure(',start);
  assert.ok(start>0&&end>start);
  const code=content.slice(start,end);
  let scrollMoves=0;
  const container={isConnected:true,clientHeight:647};
  const initial={phase:'awaiting-scroll',pass:1,attemptEpoch:4,pageState:{pageSequence:1,startCursor:'p1'}};
  const armed={...initial,phase:'capturing'};
  const restarted={phase:'capturing',pass:1,attemptEpoch:5,pageState:null};
  let calls=0;
  const context={
    runtime:{aborted:false,abortController:{signal:{}},operationStep:0},
    sendCaptureMessage:async(req)=>({state:req.type==='continue'?armed:(++calls&&restarted)}),
    CAPTURE_CONTINUE_MESSAGE:'continue',CAPTURE_GET_STATE_MESSAGE:'get-state',
    waitForNetworkScroller:async()=>container,
    HTMLElement:class {},
    log:{write(){}},
    scroller:{FAST_SCROLL_STEP_VIEWPORTS:5,FAST_MIN_SCROLL_STEP_PX:1200,getFastStepPx:()=>3235,
      scrollUpFastStep(){scrollMoves++;return {}; }},
    MAX_ITERATIONS:5,CHATGPT_NETWORK_FAST_SCROLL_SETTLE_MS:120,
    randomInteger:()=>1,sleep:async()=>true,
    updateNetworkPanel(){},hasPendingPaginationRequest:()=>false,
  };
  Object.setPrototypeOf(container,context.HTMLElement.prototype);
  const fn=vm.runInNewContext('('+code.trim()+')',context);
  const result=await fn(initial,{minDelayMs:1,maxDelayMs:1});
  assert.equal(result.attemptEpoch,5);
  assert.equal(scrollMoves,0);
});

test('old extra-pass generation restart path cannot throw on an undefined message object',()=>{
 const worker=fs.readFileSync(path.join(root,'src/background/service-worker.js'),'utf8');
 const from=worker.indexOf('async function restartCaptureAfterGeneration(tabId)');
 const to=worker.indexOf('async function continueCaptureSession(',from);
 assert.ok(from>0&&to>from);
 assert.doesNotMatch(worker.slice(from,to),/message\.reason/);
});
