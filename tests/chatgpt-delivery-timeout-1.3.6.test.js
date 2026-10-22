'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/adapters/chatgpt/generation-guard.js'), 'utf8');
const fixture = fs.readFileSync(path.join(root, 'tests/fixtures/chatgpt-delivery-timeout-alert.html'), 'utf8');
const context = vm.createContext({}); vm.runInContext(source, context);
const check = context.__chatContextExporterGenerationGuard.hasDeliveryFailure;
const text = fixture.match(/<div class="min-w-0 flex-1">([^<]+)<\/div>/)?.[1];
function alert(message, {hidden = false, historical = false, visible = true} = {}) {
  return {
    textContent: message,
    closest(selector) {
      if (selector.includes('article') && historical) return {};
      if (selector.includes('[hidden]') && hidden) return {};
      return null;
    },
    getClientRects() {return visible ? [{width:260, height:40}] : [];},
    ownerDocument:{defaultView:{getComputedStyle:()=>({visibility:'visible'})}},
  };
}
function doc(...alerts) {return {querySelectorAll(selector) {
  assert.match(selector, /\[role="alert"\]/); return alerts;
}};}
test('observed delivery-timeout alert structure from real DOM snapshot', () => {
  assert.match(fixture, /<aside[^>]*role="alert"/);
  assert.match(fixture, /<button[^>]*>Повторить<\/button>/);
  assert.equal(text, 'Время ожидания доставки сообщения истекло. Попробуйте снова.');
  assert.equal(check(doc(alert(text+' Повторить'))), true);
});
test('visible timeout banner recognized independently of Stop state', () => {
  assert.equal(check(doc(alert('Время ожидания доставки сообщения истекло. Попробуйте снова.'))), true);
  assert.equal(check(doc(alert('Message delivery has timed out. Try again.'))), true);
});
test('false positives blocked for historical, hidden, end-of-chat and rate-limit banners', () => {
  assert.equal(check(doc(alert(text,{historical:true}))), false);
  assert.equal(check(doc(alert(text,{hidden:true}))), false);
  assert.equal(check(doc(alert(text,{visible:false}))), false);
  assert.equal(check(doc(alert('Вы достигли конца истории.'))), false);
  assert.equal(check(doc(alert('Вы достигли лимита использования.'))), false);
});
test('delivery-failure skip remains restricted to optional pass with completed mandatory pass', () => {
  const start = fs.readFileSync(path.join(root, 'src/content/start.js'), 'utf8');
  const worker = fs.readFileSync(path.join(root, 'src/background/service-worker.js'), 'utf8');
  assert.match(start, /if \(optionalPass && globalThis\.__chatContextExporterGenerationGuard/);
  assert.match(start, /reason:'delivery-failed'/);
  assert.match(worker, /skipIncompleteExtraPass\(session/);
  assert.match(worker, /Нет завершённого основного прохода для безопасного сохранения/);
});
