'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

require('../src/adapters/chatgpt/dil-to-markdown.js');
const normalize = globalThis.__chatContextExporterDilToMarkdown.normalize;

function convert(src) { return normalize(src).markdown; }

test('DIL Link inside a Markdown table becomes native Markdown link', () => {
  const original = '| Архив | Размер |\n|---|---|\n| <Link url="https://drive.google.com/file/d/1abc/view">№ 1 AWF.md</Link> | 485 КБ |';
  assert.match(convert(original), /\| \[№ 1 AWF\.md\]\(https:\/\/drive\.google\.com\/file\/d\/1abc\/view\) \| 485 КБ \|/);
  assert.doesNotMatch(convert(original), /<Link/);
});

test('decorative row/icon removed without removing link text', () => {
  const html = '<row align="center"><icon name="folder-open"/><Link url="https://example.org/folder">Открыть папку</Link></row>';
  assert.equal(convert(html), '[Открыть папку](https://example.org/folder)');
});

test('status badge and nested layout become readable native text', () => {
  const source = '<box><row><text color="secondary">Приемка</text><badge color="warning">PENDING</badge></row></box>';
  assert.match(convert(source), /Приемка[\s\S]*\*\*PENDING\*\*/);
  assert.doesNotMatch(convert(source), /<box|<row|<badge/);
});

test('copy buttons disappear but commit text remains', () => {
  const source = '<row><text size="sm">`git commit -m "fix"`</text><button onClick={()=>GenUI.copy("git commit -m fix")}><icon name="copy"/> Копировать</button></row>';
  const result = convert(source);
  assert.match(result, /git commit -m/);
  assert.doesNotMatch(result, /Копировать|GenUI\.copy/);
});

test('code fences and inline code are byte-preserved', () => {
  const fenced = '```jsx\n<Link url="https://literal.test">Do not change</Link>\n<box><text>literal</text></box>\n```';
  const inline = '`<Link url="https://inline.test">also literal</Link>`';
  const source = `Before\n${fenced}\n${inline}\n<Link url="https://real.test">Real</Link>`;
  const result = convert(source);
  assert.ok(result.includes(fenced));
  assert.ok(result.includes(inline));
  assert.ok(result.includes('[Real](https://real.test)'));
});

test('user-authored regular Markdown without DIL stays byte identical', () => {
  const source = '# Header\n\n    indent block\n\n- item\n  - nested\n\n[already](https://example.org)';
  assert.equal(convert(source), source);
});

test('literal loop of measurable records converts into complete data table', () => {
  const source = `<box>{#each [
    {name:"A",value:80,desc:"First"},
    {name:"B",value:20,desc:"Second"}
  ] as item}
  <box><text>{item.name}</text><text>{item.value}%</text><caption>{item.desc}</caption></box>
  {/each}</box>`;
  const result = convert(source);
  assert.match(result, /\| A \| 80% \| First \|/);
  assert.match(result, /\| B \| 20% \| Second \|/);
  assert.doesNotMatch(result, /\{#each|<box/);
});

test('unknown dynamic loop is fenced instead of discarded or executed', () => {
  const source = '{#each computeItems() as item}<text>{item.name}</text>{/each}';
  const result = convert(source);
  assert.match(result, /^```dil\n\{#each computeItems\(\) as item\}/);
  assert.match(result, /\{\/each\}/);
});

test('malformed component markup is preserved rather than dropped', () => {
  const source = '<box>partial <Link url="https://example.org">text</box>';
  assert.equal(convert(source), source);
  assert.equal(normalize(source).failed, true);
});

test('real exported chat fixture normalizes DIL while keeping examples', () => {
  const file = '/mnt/data/№ 7 AWF.md';
  if (!fs.existsSync(file)) return;
  const source = fs.readFileSync(file, 'utf8');
  const messages = source.split(/\n---\n/).filter((chunk) => chunk.includes('***Ассистент***'));
  assert.equal(messages.length, 13);
  let normalizedCount = 0;
  for (const message of messages) {
    const converted = normalize(message);
    assert.equal(converted.failed, false);
    normalizedCount += converted.components;
    assert.doesNotMatch(converted.markdown, /<\/?(?:Link|row|box|icon|badge|button|text|title|caption|divider)\b/);
  }
  assert.ok(normalizedCount >= 120);
});

test('ChatGPT authenticated thread parser normalizes real wire response only for assistant', () => {
  const wirePath = '/mnt/data/Вставленный текст.txt';
  if (!fs.existsSync(wirePath)) return;
  require('../src/adapters/chatgpt/thread-wire-parser.js');
  const payload = fs.readFileSync(wirePath, 'utf8');
  const parsed = globalThis.__chatContextExporterThreadWireParser.parsePageBody(payload, {});
  assert.equal(parsed.stats.total, 10);
  const withMarkup = parsed.messages.filter((item) => item.role === 'assistant'
    && item.blocks[0].value.includes('['));
  assert.ok(withMarkup.length > 0);
  for (const item of parsed.messages.filter((item) => item.role === 'assistant')) {
    assert.doesNotMatch(item.blocks[0].value, /<\/?(?:Link|row|box|icon|badge|button)\b/);
  }
});
