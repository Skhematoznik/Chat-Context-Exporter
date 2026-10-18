'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src/adapters/chatgpt/generation-guard.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context);
const isGenerating = context.__chatContextExporterGenerationGuard.isGenerating;

function button(label = 'Остановить', opts = {}) {
  const {layoutVisible = true, cssVisibility = 'visible', disabled = false,
    ariaHidden = false, inert = false, connected = true, testid = null} = opts;
  return {
    disabled, isConnected: connected,
    getAttribute(key) {return key === 'aria-label' ? label : key === 'data-testid' ? testid : null;},
    closest(selector) {
      if (selector.includes('aria-hidden') && ariaHidden) return {getAttribute:()=> 'true'};
      if (selector.includes('[inert]') && inert) return {};
      return null;
    },
    getClientRects() {return layoutVisible ? [{width:32, height:32}] : [];},
    ownerDocument: {defaultView: {getComputedStyle: () => ({visibility: cssVisibility})}},
  };
}
const doc = (...buttons) => ({querySelectorAll: () => buttons});

test('two dormant Stop buttons under display:none !important do not block before-start', () => {
  // Sanitized reduction of the real ChatGPT HTML provided for the 1.3.1 failure:
  // two offscreen composer trees are descendants of <div style="display: none;">.
  const dormantA = button('Остановить', {layoutVisible:false});
  const dormantB = button('Остановить', {layoutVisible:false});
  assert.equal(isGenerating(doc(dormantA, dormantB)), false);
});

test('a genuine displayed Stop continues to protect the capture', () => {
  assert.equal(isGenerating(doc(button('Остановить', {layoutVisible:false}), button('Остановить'))), true);
  assert.equal(isGenerating(doc(button('Stop generating'))), true);
  assert.equal(isGenerating(doc(button('Stop'))), true);
  assert.equal(isGenerating(doc(button(null, {testid: 'stop-button'}))), true);
});

test('visibility hidden, zero-sized, detached, disabled, aria-hidden and inert stop are ignored', () => {
  const invisible = [
    {cssVisibility:'hidden'},
    {cssVisibility:'collapse'},
    {layoutVisible:false},
    {disabled:true},
    {ariaHidden:true},
    {inert:true},
    {connected:false},
  ];
  for (const options of invisible) {
    assert.equal(isGenerating(doc(button('Остановить', options))), false, JSON.stringify(options));
  }
  assert.equal(isGenerating(doc(button('Повторить'))), false);
});

test('when layout visibility is unavailable, Stop is not trusted as a visible control', () => {
  const missingLayout = button('Остановить');
  delete missingLayout.getClientRects;
  assert.equal(isGenerating(doc(missingLayout)), false);
});
