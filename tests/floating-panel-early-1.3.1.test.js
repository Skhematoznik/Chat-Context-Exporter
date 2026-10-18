'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = (name) => fs.readFileSync(path.join(root, name), 'utf8');

function workerHarness() {
  const callbacks = {};
  const timers = [];
  const injections = [];
  const chrome = {
    debugger: {onEvent: {addListener() {}}, onDetach: {addListener() {}}, sendCommand: async () => ({}), detach: async () => {}},
    tabs: {onUpdated: {addListener: (fn) => {callbacks.updated = fn;}},
      onRemoved: {addListener() {}}, sendMessage: async () => {}},
    action: {onClicked: {addListener() {}}},
    runtime: {onMessage: {addListener: (fn) => {callbacks.message = fn;}}},
    storage: {session: {get: async () => ({}), set: async () => {}, remove: async () => {}}},
    scripting: {executeScript: async (opts) => {injections.push(opts);}},
  };
  const context = vm.createContext({chrome, console, URL, TextEncoder, TextDecoder, structuredClone,
    importScripts() {}, crypto: {randomUUID: () => 'abc'},
    setTimeout: (fn, delay) => {timers.push({fn, delay}); return timers.length;}, clearTimeout() {},
    __chatContextExporterShareWireParser: {}, __chatContextExporterThreadWireParser: {}});
  vm.runInContext(source('src/background/service-worker.js'), context);
  return {context, callbacks, timers, injections};
}

async function pump(timers) {
  const batch = timers.splice(0);
  for (const {fn} of batch) await fn();
  await new Promise((resolve) => setImmediate(resolve));
}

test('loading injects a lightweight floating indicator before full runtime and has bounded retries', async () => {
  const h = workerHarness();
  const sessions = vm.runInContext('captureSessions', h.context);
  const session = {id: 'session-1', tabId: 11, adapterId:'chatgpt', expectedConversationId:'c-id',
    phase:'capturing',startedAt: 1000, pass:1,totalPasses:2,captures:[],events:[],pendingRequests:new Map(),
    pageState:{pageSequence:8,transcriptMessagesInPass:82},bufferedPages:new Map()};
  sessions.set(11, session);
  h.callbacks.updated(11, {status:'loading'});
  assert.deepEqual(h.timers.map(x=>x.delay), [0,350,1400]);
  await pump(h.timers);
  assert.equal(h.injections.length,3);
  assert.ok(h.injections.every(x => x.world === 'ISOLATED' && x.injectImmediately === true));
  assert.ok(h.injections.every(x => x.files[0] === 'src/content/early-panel.js'));
  assert.equal(h.injections.some(x=>x.files.includes('src/content/start.js')), false);
  h.callbacks.updated(11,{status:'complete'});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.injections.at(-1).files.at(-1),'src/content/start.js');
});

test('inactive, ready and cancelled captures must never resurrect the early panel', async () => {
  const h = workerHarness();
  h.callbacks.updated(1,{status:'loading'});
  assert.equal(h.timers.length,0);
  const sessions = vm.runInContext('captureSessions', h.context);
  sessions.set(1,{id:'one',phase:'capturing'});
  h.callbacks.updated(1,{status:'loading'});
  sessions.get(1).phase='cancelled';
  await pump(h.timers);
  assert.equal(h.injections.length,0);
  sessions.get(1).phase='ready';
  h.callbacks.updated(1,{status:'loading'});
  assert.equal(h.timers.length,0);
});

test('summary-only state omits bulky event history and never returns transcript bodies', async () => {
  const h = workerHarness();
  const sessions = vm.runInContext('captureSessions', h.context);
  sessions.set(10,{
    id:'capture-10',tabId:10,adapterId:'chatgpt',expectedConversationId:'target-c',phase:'capturing',
    startedAt:1000,pass:1,totalPasses:2,captures:[],events:[{event:'expensive-event'}],
    pendingRequests:new Map(), bufferedPages:new Map(),pageState:{pageSequence:3,transcriptMessagesInPass:32},
  });
  const send = (message) => new Promise((resolve) => {
    const keepOpen = h.callbacks.message(message,{tab:{id:10}},resolve);
    assert.equal(keepOpen,true);
  });
  const response = await send({type:'chat-context-exporter:capture:get-state',summaryOnly:true,includeCaptures:true});
  assert.equal(response.ok,true);
  assert.equal(response.state.events,undefined);
  assert.equal(response.state.captures,undefined);
  assert.equal(response.state.pageState.pageSequence,3);
  assert.equal(response.state.expectedConversationId,'target-c');
  const regular = await send({type:'chat-context-exporter:capture:get-state'});
  assert.equal(regular.state.events.length,1);
});

test('early indicator is self-contained, uses existing DOM host ID and validates conversation', () => {
  const code = source('src/content/early-panel.js');
  const manifest = JSON.parse(source('manifest.json'));
  assert.match(code,/const PANEL_ID = 'chat-context-exporter-ui'/);
  assert.match(code,/attachShadow\(\{mode: 'closed'\}\)/);
  assert.match(code,/summaryOnly: true/);
  assert.match(code,/location\.pathname\.includes\(expected\)/);
  assert.match(code,/g\[RUNTIME_KEY\]\?\.running/);
  assert.match(code,/MutationObserver/);
  assert.doesNotMatch(JSON.stringify(manifest),/sidePanel|webNavigation|host_permissions/);
  assert.equal(manifest.version,'1.3.1');
  assert.equal(manifest.version_name,'1.3.1');
  assert.equal(source('src/core/namespace.js').includes("version: '1.3.1'"),true);
});

function panelHarness({conversationId = 'target-c',state = null,hostname = 'chatgpt.com'} = {}) {
  const elements = new Map();
  const nodes = new Map();
  const root = {appendChild(host) {host.isConnected = true; elements.set(host.id, host);}};
  const document = {
    documentElement: root,
    getElementById: (id) => elements.get(id) || null,
    createElement: () => ({id: '', dataset: {}, style: {}, isConnected: false,
      remove() {this.isConnected = false; elements.delete(this.id);},
      attachShadow() {return {innerHTML: '', querySelector(sel) {
        if (!nodes.has(sel)) nodes.set(sel, {textContent: ''});
        return nodes.get(sel);
      }};}}),
  };
  const intervals = [];
  const chrome = {runtime:{sendMessage: async () => ({ok:true,state: state || {
    id:'s', adapterId:'chatgpt', expectedConversationId:conversationId,
    startedAt:Date.now()-30000,phase:'waiting-http-retry',pass:1,totalPasses:2,
    httpRetryStatus:429,httpRetryAt:Date.now()+90000,
    pageState:{pageSequence:8,transcriptMessagesInPass:82},
  }})}};
  const ctx = vm.createContext({document,location:{hostname,pathname:'/c/'+conversationId},
    chrome,Date,console,clearInterval(){},setInterval(fn) {intervals.push(fn);return intervals.length;},
    MutationObserver: class {observe() {} disconnect() {}}});
  vm.runInContext(source('src/content/early-panel.js'),ctx);
  return {ctx,document,elements,nodes,intervals};
}

test('early overlay displays 429 cooldown, checkpoint counts, original time; ignores duplicate injection', async () => {
  const h=panelHarness();
  await new Promise(r=>setImmediate(r));
  assert.equal(h.elements.size,1);
  assert.match(h.nodes.get('.status').textContent,/HTTP 429.*ожидание.*Страницы сохранены/i);
  assert.equal(h.nodes.get('.pages').textContent,'8');
  assert.equal(h.nodes.get('.messages').textContent,'82');
  assert.equal(h.nodes.get('.pass').textContent,'1 / 2');
  assert.match(h.nodes.get('.elapsed').textContent,/00:00:3[0-9]/);
  vm.runInContext(source('src/content/early-panel.js'),h.ctx);
  assert.equal(h.elements.size,1);
  assert.equal(h.intervals.length,1);
});

test('early overlay never appears without a supported host or when normal runtime owns the panel',()=> {
  assert.equal(panelHarness({hostname:'example.org'}).elements.size,0);
  const h = panelHarness({hostname:'chatgpt.com'});
  h.elements.get('chat-context-exporter-ui').remove();
  h.ctx.__chatContextExporterRuntime = {running:true};
  vm.runInContext(source('src/content/early-panel.js'),h.ctx);
  assert.equal(h.elements.size,0);
});

test('status notifications do not bootstrap full runtime in a half-loaded document', async () => {
  const h = workerHarness();
  const sessions = vm.runInContext('captureSessions', h.context);
  const session = {id:'s',tabId:7,phase:'capturing',adapterId:'chatgpt',
    captures:[],events:[],pendingRequests:new Map(),bufferedPages:new Map(),pass:1,totalPasses:2};
  sessions.set(7,session);
  h.context.chrome.tabs.sendMessage = async () => {throw new Error('no full runtime yet');};
  h.callbacks.updated(7,{status:'loading'});
  await vm.runInContext('notifyCaptureSession',h.context)(session);
  assert.equal(h.injections.length,0,'no full/runtime injection before complete');
  h.callbacks.updated(7,{status:'complete'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.injections.length,1);
  assert.equal(h.injections[0].files.at(-1),'src/content/start.js');
});
