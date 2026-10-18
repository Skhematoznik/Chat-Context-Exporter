'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src/ui/panel.js'), 'utf8');
const early = fs.readFileSync(path.join(root, 'src/content/early-panel.js'), 'utf8');

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `rule ${selector} exists`);
  return Object.fromEntries([...match[1].matchAll(/([\w-]+)\s*:\s*([^;]+);/g)]
    .map(([, name, value]) => [name, value.trim()]));
}

function svg(source) {
  const match = source.match(/<svg class="icon"[^>]*>[\s\S]*?<\/svg>/);
  assert.ok(match, 'inline icon exists');
  return match[0].replace(/\s+/g, ' ').replace(/> </g, '><').trim();
}

test('early header renders the exact main-panel icon and title in matching order', () => {
  assert.equal(svg(early), svg(main));
  assert.match(early, /<header class="header">\s*<svg class="icon"[\s\S]*?<\/svg>\s*<div class="title">Chat Context Exporter<\/div>\s*<\/header>/);
  assert.doesNotMatch(early, /<img[^>]*src=["']https?:/);
});

test('early floating panel shares the main panel colors and header typography', () => {
  const fields = {
    '.panel': ['width', 'border', 'border-radius', 'background', 'color', 'box-shadow', 'overflow', 'backdrop-filter'],
    '.header': ['display', 'align-items', 'gap', 'padding', 'background', 'border-bottom'],
    '.icon': ['width', 'height', 'flex', 'display'],
    '.title': ['flex', 'min-width', 'font-size', 'font-weight', 'line-height'],
    '.progress': ['height', 'margin-top', 'border-radius', 'background', 'overflow'],
  };
  for (const [selector, props] of Object.entries(fields)) {
    const actual = cssRule(early, selector);
    const expected = cssRule(main, selector);
    for (const key of props) assert.equal(actual[key], expected[key], `${selector}: ${key}`);
  }
  assert.equal(cssRule(early, '.progress div').background, cssRule(main, '.progress > div').background);
  assert.match(early, /const STATE_MESSAGE = 'chat-context-exporter:capture:get-state'/);
});
