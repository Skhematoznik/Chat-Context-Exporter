'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');

function parseFixture(passLists) {
  const app={modules:{chatGptProfiles:{}}};
  const context=vm.createContext({
    __chatContextExporter:app,
    document:{title:'Проверяемый разговор'},
    location:{hostname:'chatgpt.com',pathname:'/c/thread'},
  });
  vm.runInContext(read('src/adapters/chatgpt/thread-profile.js'),context);
  const captures=passLists.flatMap((items,i)=>[{pass:i+1,pageSequence:1,requestBefore:null,
    processed:{pageInfo:{startCursor:'first',endCursor:'last',hasPreviousPage:false,hasNextPage:false},
      conversationId:'thread',title:'Разговор',rawMessages:items.length,
      stats:{total:items.length,user:items.filter(x=>x.role==='user').length,
        assistant:items.filter(x=>x.role==='assistant').length},
      messages:items}}]);
  return app.modules.chatGptProfiles.thread.parseNetworkCaptures(captures);
}
function msg(id, text=null){return {id:String(id),role:Number(id)%2?'user':'assistant',timestamp:null,
  blocks:[{type:'markdown',value:text || String(id)}]};}

test('1.4: missing distinct messages in different full passes are merged by stable ID and ordered',()=>{
  const result=parseFixture([[1,2,3,4,5,7,8].map(x=>msg(x)),[1,2,3,4,6,7,8].map(x=>msg(x))]);
  assert.deepEqual(Array.from(result.conversation.messages,x=>x.id),['1','2','3','4','5','6','7','8']);
  assert.equal(result.diagnostics.merge.added,1);
  assert.equal(result.diagnostics.merge.conflicts,0);
  assert.equal(result.stats.total,8);
});

test('1.4: equal IDs are deduplicated, changed text is reported rather than silently overwritten',()=>{
  const result=parseFixture([[msg(1),msg(2,'original')],[msg(1),msg(2,'changed')]]);
  assert.equal(result.conversation.messages.length,2);
  assert.equal(result.conversation.messages[1].blocks[0].value,'original');
  assert.equal(result.diagnostics.merge.conflicts,1);
  assert.match(result.diagnostics.warnings[0],/изменённым содержимым/);
});

test('1.4: conflicting branch order does not produce an invented ordering',()=>{
  const result=parseFixture([[msg(1),msg(2)],[msg(2),msg(1)]]);
  assert.deepEqual(Array.from(result.conversation.messages,x=>x.id),['1','2']);
  assert.equal(result.diagnostics.merge.orderConflicts,true);
  assert.match(result.diagnostics.warnings.join(' '),/Конфликт порядка/);
});

test('1.4: options expose exact two error settings and defaults; Stop remains start-only',async()=>{
  const app={modules:{}};
  const context=vm.createContext({__chatContextExporter:app,chrome:{storage:{local:{get:async()=>({})}}}});
  vm.runInContext(read('src/core/settings.js'),context);
  const settings=app.modules.settings;
  assert.equal(settings.DEFAULT_SETTINGS.errorRetryCount,10);
  assert.equal(settings.DEFAULT_SETTINGS.errorRetryBaseSeconds,10);
  assert.equal(settings.clampErrorRetryCount(30),25);
  assert.equal(settings.clampErrorRetryCount(0),1);
  assert.equal(settings.clampErrorRetryBaseSeconds(99),60);
  assert.equal(settings.clampErrorRetryBaseSeconds(0),1);
  assert.match(read('src/options/options.html'),/id="errorRetryCount" type="number" min="1" max="25"/);
  assert.match(read('src/options/options.html'),/id="errorRetryBaseSeconds" type="number" min="1" max="60"/);
  const content=read('src/content/start.js');
  assert.match(content,/config\.responseProcessor === 'chatgpt-thread-json' && isChatGptGenerating\(\)/);
  assert.doesNotMatch(content,/waitForChatGptGenerationToSettle\('after-reload'/);
  assert.doesNotMatch(content,/waitForChatGptGenerationToSettle\('before-scroll'/);
});

test('1.4: emergency HTML tail is saved only on failed primary; completion is requested before success UI',async()=>{
  const source=read('src/content/start.js');
  const start=source.indexOf('  async function saveEmergencyLimitTailOnFailure(');
  const stop=source.indexOf('  async function runNetworkAdapter(',start);
  assert.ok(start>=0&&stop>start);
  const code=source.slice(start,stop).trim();
  const statuses=[];let saved=null;
  const context={runtime:{adapter:{id:'chatgpt'},panel:{setStatus:x=>statuses.push(x),markError(){},setCloseTitle(){}}},
    log:{write(){}},document:{title:'№ 11 Фреймворк'},
    markdownExporter:{createFilename:(name)=>name+'.md'},
    async saveMarkdownArtifact(artifact,reason,opts){saved={artifact,reason,opts};return {downloadId:21};},
    async sendCaptureMessage(){throw Error('unexpected state retrieval');},
  };
  const fn=vm.runInNewContext('('+code+')',context);
  const tail={authoritative:true,reason:'conversation-limit',user:{markdown:'Вопрос'},assistant:{markdown:'Ответ до reload'}};
  assert.equal(await fn({phase:'error',completedPasses:1,preReloadTailSnapshot:tail}),false);
  assert.equal(saved,null);
  assert.equal(await fn({phase:'error',completedPasses:0,error:'HTTP 429',preReloadTailSnapshot:tail}),true);
  assert.equal(saved.reason,'emergency-tail');
  assert.equal(saved.opts.waitForCompletion,true);
  assert.match(saved.artifact.filename,/последний ответ/);
  assert.match(saved.artifact.content,/Ответ до reload/);
  assert.match(saved.artifact.content,/полный экспорт не завершён/i);
  assert.match(statuses.at(-1),/последний ответ ассистента сохранён/);
});

test('1.4: browser completion event is needed for emergency-download confirmation',async()=>{
  const source=read('src/background/service-worker.js');
  const start=source.indexOf('function waitForCompletedDownload(');
  const stop=source.indexOf('function decodeBase64Utf8(',start);
  const code=source.slice(start,stop);
  let listener=null;let next=0;
  const context={
    ALLOWED_TEXT_MIME_TYPES:new Set(['text/markdown']),
    encodeURIComponent,
    chrome:{downloads:{
      onChanged:{addListener(fn){listener=fn;},removeListener(fn){if(listener===fn)listener=null;}},
      search:async()=>[{id:7,state:'in_progress'}],
      download:async()=>7,
    }},
    setTimeout(fn){return ++next;},clearTimeout(){},
  };
  const f=vm.runInNewContext(code+'\ncreateSaveOperation',context);
  const task=f({filename:'tail.md',mimeType:'text/markdown',content:'answer',waitForCompletion:true});
  await new Promise(setImmediate);
  assert.equal(typeof listener,'function');
  let completed=false;
  task.then(()=>{completed=true;});
  await new Promise(setImmediate);
  assert.equal(completed,false);
  listener({id:7,state:{current:'complete'}});
  const saved=await task;
  assert.equal(saved.ok,true);
  assert.equal(saved.completed,true);
  assert.equal(listener,null);
});
