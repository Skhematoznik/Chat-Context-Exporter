'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const app = { modules: {} };
const context = vm.createContext({ __chatContextExporter: app });
vm.runInContext(fs.readFileSync(path.join(root, 'src/exporters/markdown-exporter.js'), 'utf8'), context);
const exporter = app.modules.markdownExporter;
const markdown = (value) => exporter.renderBlocks([{ type: 'markdown', value }]);
const heading = (children, level = 3) => exporter.renderBlocks([{ type: 'heading', level, children }]);

test('normalize two-column compact table delimiter with spaces around dashes', () => {
  const source = '| Поле | Пример |\n|---|---|\n| Версия | 1.2.4 |';
  assert.equal(markdown(source), '| Поле | Пример |\n| --- | --- |\n| Версия | 1.2.4 |');
});

test('preserve all GFM alignment markers when formatting compact delimiters', () => {
  assert.equal(markdown('| Имя | Центр | Значение |\n|:---|:---:|---:|\n| A | B | 5 |'),
    '| Имя | Центр | Значение |\n| :--- | :---: | ---: |\n| A | B | 5 |');
  assert.equal(markdown('| A | B | C |\n| --- | ---: | --- |\n| x | 1 | y |'),
    '| A | B | C |\n| --- | ---: | --- |\n| x | 1 | y |');
});

test('preserve compact delimiters in fenced Markdown and code examples', () => {
  const source = '```md\n|---|---|\n```\n~~~text\n|---|---|\n~~~\n| Поле | Пример |\n|---|---|';
  assert.equal(markdown(source), '```md\n|---|---|\n```\n~~~text\n|---|---|\n~~~\n| Поле | Пример |\n| --- | --- |');
});

test('keep indented code blocks unchanged', () => {
  const source = 'Пример:\n    |---|---|\n\t|---|---|\n| Имя | Значение |\n|---|---|';
  assert.equal(markdown(source), 'Пример:\n    |---|---|\n\t|---|---|\n| Имя | Значение |\n| --- | --- |');
});

test('non-table prose, short hyphen patterns and code are unchanged', () => {
  const source = '|--|--|\n\nПростой --- текст.\n\n`|---|---|`';
  assert.equal(markdown(source), source);
});

test('preserve whitespace at adjacent DOM text nodes inside headings', () => {
  const title = heading([
    { type: 'text', value: 'Структура ' },
    { type: 'text', value: 'документации' },
  ]);
  assert.equal(title, '### Структура документации');
  assert.equal(heading([
    { type: 'text', value: 'Что ' },
    { type: 'text', value: 'осталось' },
  ]), '### Что осталось');
  assert.equal(heading([
    { type: 'text', value: '  AWF ' },
    { type: 'text', value: '2.63.16' },
    { type: 'text', value: ' — кандидат ' },
    { type: 'text', value: 'подготовлен  ' },
  ], 2), '## AWF 2.63.16 — кандидат подготовлен');
});

test('retain whitespace around inline rich formatting inside headings', () => {
  assert.equal(heading([
    { type: 'text', value: 'Проверка ' },
    { type: 'strong', children: [{ type: 'text', value: 'важного' }] },
    { type: 'text', value: ' ответа' },
  ]), '### Проверка **важного** ответа');
});

test('end-to-end exporter retains spaced headings and compact-table formatting', () => {
  const result = exporter.exportConversation({
    title: '№ 7 AWF',
    messages: [{ role: 'assistant', blocks: [
      { type: 'heading', level: 3, children: [
        { type: 'text', value: 'Структура ' }, { type: 'text', value: 'документации' },
      ] },
      { type: 'markdown', value: '| Поле | Пример |\n|---|---|\n| Название | AUTO-ATR |' },
      { type: 'heading', level: 3, children: [
        { type: 'text', value: 'Что ' }, { type: 'text', value: 'осталось' },
      ] },
    ] }],
  });
  assert.match(result, /### Структура документации/);
  assert.match(result, /\| --- \| --- \|/);
  assert.match(result, /### Что осталось/);
  assert.doesNotMatch(result, /Структурадокументации|Чтоосталось|\|---\|---\|/);
});

test('documentation: the production DOM serializer uses whitespace-aware Markdown renderer', () => {
  const source = fs.readFileSync(path.join(root,'src/adapters/chatgpt/thread-profile.js'),'utf8');
  assert.match(source, /markdownExporter\.renderBlocks\(blocks\)\.trim\(\)/);
  assert.match(fs.readFileSync(path.join(root,'src/core/dom/rich-text-parser.js'),'utf8'),
    /value = normalizeText\(node\.nodeValue\)/);
  const manifest = JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  assert.equal(manifest.version, '1.3.4');
  assert.equal(manifest.version_name, '1.3.4');
});
