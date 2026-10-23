'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const content = fs.readFileSync(path.join(root, 'src/content/start.js'), 'utf8');
const background = fs.readFileSync(path.join(root, 'src/background/service-worker.js'), 'utf8');
const guardSource = fs.readFileSync(path.join(root, 'src/adapters/chatgpt/generation-guard.js'), 'utf8');
const observedAlert = fs.readFileSync(path.join(root, 'tests/fixtures/chatgpt-delivery-timeout-alert.html'), 'utf8');
function functionCode(startMarker, endMarker) {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker, start + 10);
  assert.ok(start >= 0 && end > start, `Missing function ${startMarker}`);
  return content.slice(start, end).trim();
}
const waitCode = functionCode('  async function waitForChatGptGenerationToSettle(', '  async function waitForNetworkScroller()');
const noteCode = functionCode('  async function notePrimaryDeliveryFailure(', '  async function advanceNetworkPagination(');

test('real Russian timeout banner is a terminal status on the first pass, not an endless Stop wait', async () => {
  const text = 'Время ожидания доставки сообщения истекло. Попробуйте снова.';
  assert.ok(observedAlert.includes(text));
  let polledStop = 0; const events = [];
  const fn = vm.runInNewContext('(' + waitCode + ')', {
    settings:{clampGenerationWaitSeconds:()=>3600},runtime:{aborted:false},
    log:{write(event,details){events.push({event,details});}},
    globalThis:{__chatContextExporterGenerationGuard:{hasDeliveryFailure:()=>true}},
    document:{},isChatGptGenerating(){polledStop++;return true;},
    CHATGPT_GENERATION_STABILITY_MS:1800,CHATGPT_GENERATION_POLL_MS:350,
    sleep:()=>{throw Error('Should not sleep once delivery has failed');},
  });
  const result = await fn('before-scroll',{generationWaitSeconds:3600},false);
  assert.equal(result.deliveryFailed,true);
  assert.equal(polledStop,0);
  assert.ok(events.some(e=>e.event==='CHATGPT_PRIMARY_PASS_DELIVERY_FAILURE'));
});

test('when terminal alert absent, visible Stop is still guarded; no unconditional bypass', async () => {
  let now=0, checks=0;
  const fn = vm.runInNewContext('(' + waitCode + ')', {
    settings:{clampGenerationWaitSeconds:()=>30},runtime:{aborted:false},
    log:{write(){}},globalThis:{__chatContextExporterGenerationGuard:{hasDeliveryFailure:()=>false}},
    document:{},isChatGptGenerating(){checks++;return true;},
    Date:{now(){now += 10_000;return now;}},
    CHATGPT_GENERATION_STABILITY_MS:1800,CHATGPT_GENERATION_POLL_MS:350,
    sleep:async()=>true,
  });
  await assert.rejects(()=>fn('before-scroll',{generationWaitSeconds:30},false),/продолжает формировать ответ/);
  assert.ok(checks>0);
});

test('delivery failure is recorded in the worker session and survives subsequent reloads and extra passes', async () => {
  assert.match(background,/const CAPTURE_DELIVERY_FAILURE_MESSAGE = 'chat-context-exporter:capture:delivery-failure'/);
  assert.match(background,/primaryDeliveryFailureObserved: false/);
  assert.match(background,/primaryDeliveryFailureObserved: session\.primaryDeliveryFailureObserved === true/);
  assert.match(background,/session\.primaryDeliveryFailureObserved = true/);
  assert.match(background,/message\.type === CAPTURE_DELIVERY_FAILURE_MESSAGE/);
  assert.match(content,/state\.primaryDeliveryFailureObserved \|\| runtime\.primaryDeliveryFailureObserved/);
  assert.match(content,/полнота последнего ответа не подтверждена/);
  const events=[];const runtime={primaryDeliveryFailureObserved:false};
  const fn = vm.runInNewContext('(' + noteCode + ')', {
    runtime,log:{write(event){events.push(event);}},
    sendCaptureMessage:async()=>({ok:true}),
    CAPTURE_DELIVERY_FAILURE_MESSAGE:'chat-context-exporter:capture:delivery-failure',
  });
  await fn({pass:1},'before-scroll');
  assert.equal(runtime.primaryDeliveryFailureObserved,true);
  assert.ok(events.includes('CHATGPT_PRIMARY_PASS_DELIVERY_FAILURE_TERMINAL'));
});

test('delivery failure is only logged during active capture; full cursor chain is still mandatory', () => {
  const resume = content.slice(content.indexOf('  async function runNetworkAdapter('));
  assert.match(resume,/await notePrimaryDeliveryFailure\(state, 'after-reload'\)/);
  assert.match(resume,/state = await waitForNetworkCaptureState\(state, currentSettings, config\)/);
  assert.doesNotMatch(resume,/guardedGenerationWait\(/);
  assert.match(background,/CHATGPT_THREAD_START_REACHED/);
});

test('a nested Retry alert on the latest turn is detected; the same text quoted in historical turns is ignored', () => {
  const ctx=vm.createContext({});vm.runInContext(guardSource,ctx);
  const check=ctx.__chatContextExporterGenerationGuard.hasDeliveryFailure;
  const make = (historical=false, retry=true)=>{
    const element = {
      textContent:'Время ожидания доставки сообщения истекло. Попробуйте снова.',
      closest(selector){return selector.includes('article')?{}:null;},
      querySelectorAll(){return retry?[{textContent:'Повторить', getAttribute:()=>null}]:[];},
      getClientRects(){return [{width:220,height:40}];},
      ownerDocument:{defaultView:{getComputedStyle:()=>({visibility:'visible'})}},
    };
    const turn = {contains(e){return !historical && e===element;}};
    const doc={querySelectorAll(selector){return selector.startsWith('[data-turn-key]')?[turn]:[element];}};
    return check(doc);
  };
  assert.equal(make(false,true),true);
  assert.equal(make(true,true),false);
  assert.equal(make(false,false),false);
});
