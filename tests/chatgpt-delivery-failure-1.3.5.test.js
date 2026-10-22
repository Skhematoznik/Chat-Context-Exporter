 'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const script=fs.readFileSync(path.join(root,'src/adapters/chatgpt/generation-guard.js'),'utf8');
const ctx=vm.createContext({});vm.runInContext(script,ctx);
const hasFailure=ctx.__chatContextExporterGenerationGuard.hasDeliveryFailure;
function notice(text,{visible=true,hidden=false,insideMessage=false}={}) {
 return {textContent:text,closest(selector){
   if(selector.includes('article') && insideMessage)return {};
   if(selector.includes('[hidden]')&&hidden)return {};
   return null;},
   getClientRects(){return visible?[{width:120,height:18}]:[];},
   ownerDocument:{defaultView:{getComputedStyle:()=>({visibility:'visible'})}}};
}
const doc=(...els)=>({querySelectorAll:()=>els});
test('visible response-not-delivered alert recognized in Russian and English',()=>{
 assert.equal(hasFailure(doc(notice('Ответ не доставлен'))),true);
 assert.equal(hasFailure(doc(notice('There was an error generating a response'))),true);
});
test('no failure from absent, hidden or historical text',()=>{
 assert.equal(hasFailure(doc()),false);
 assert.equal(hasFailure(doc(notice('Ответ не доставлен',{hidden:true}))),false);
 assert.equal(hasFailure(doc(notice('Ответ не доставлен',{visible:false}))),false);
 assert.equal(hasFailure(doc(notice('Ответ не доставлен',{insideMessage:true}))),false);
 assert.equal(hasFailure(doc(notice('Ограничение использования достигнуто'))),false);
});
test('only verified extra pass can skip when a visible delivery-failure alert is present',()=>{
 const s=fs.readFileSync(path.join(root,'src/content/start.js'),'utf8');
 assert.match(s,/optionalPass && globalThis\.__chatContextExporterGenerationGuard/);
 assert.match(s,/CHATGPT_EXTRA_PASS_DELIVERY_FAILURE_DETECTED/);
 assert.match(s,/state\.pass > 1 && \(state\.completedPasses \|\| 0\) >= 1/);
 assert.match(s,/CAPTURE_SKIP_EXTRA_PASS_MESSAGE/);
});
