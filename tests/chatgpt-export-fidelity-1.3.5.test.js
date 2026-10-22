 'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = (file) => fs.readFileSync(path.join(root, file),'utf8');
const context = vm.createContext({__chatContextExporter:{modules:{}}});
vm.runInContext(source('src/adapters/chatgpt/dil-to-markdown.js'),context);
vm.runInContext(source('src/exporters/markdown-exporter.js'),context);
const dil = context.__chatContextExporterDilToMarkdown.normalize;
const md = context.__chatContextExporter.modules.markdownExporter;
const render = (input)=>md.renderBlocks([{type:'markdown', value:input}]);

test('CodeCite and Cite metadata do not leak into exported prose',()=>{
 const input='Проверено. <CodeCite tool="container" citation_id="abc" line_range_start={1} line_range_end={8} /> <Cite refs={["search1","search2"]} />';
 const result=dil(input);
 assert.equal(result.failed,false);
 assert.equal(result.markdown,'Проверено.');
});
test('WritingBlock wrapper is removed but raw body survives unchanged',()=>{
 const body='# Записка\n\n```cpp\nint x=0;\n```\n\n<CodeCite tool="literal" />';
 const result=dil('До\n<WritingBlock id="12345" variant="document">'+body+'</WritingBlock>\nПосле');
 assert.equal(result.failed,false);
 assert.ok(result.markdown.includes(body));
 assert.ok(!result.markdown.includes('<WritingBlock'));
 assert.ok(result.markdown.includes('До'));
 assert.ok(result.markdown.includes('После'));
});
test('Citations in code and inline code are literal; author placeholders survive',()=>{
 const fence='```xml\n<CodeCite tool="example" />\n```';
 const inline='`<Cite ref="demo"/>`';
 const value=dil(fence+'\n'+inline+'\n<GUID>\n<Cite ref="live" />').markdown;
 assert.ok(value.includes(fence));
 assert.ok(value.includes(inline));
 assert.ok(value.includes('<GUID>'));
 assert.ok(!value.includes('live'));
});
test('Markdown input with no info string gets text on opening fence, not closing',()=>{
 const input='Intro\n```\nraw output\n```\n~~~  \nother output\n~~~\n```powershell\nGet-Item\n```';
 const result=render(input);
 assert.equal(result,'Intro\n```text\nraw output\n```\n~~~text\nother output\n~~~\n```powershell\nGet-Item\n```');
});
test('DOM code blocks with missing language get text, explicit language kept',()=>{
 assert.equal(md.renderBlocks([{type:'codeBlock',code:'raw'}]),'```text\nraw\n```');
 assert.equal(md.renderBlocks([{type:'codeBlock',language:'cpp',code:'int x;'}]),'```cpp\nint x;\n```');
});
test('actual exported chat fixture: tool citations normalized while fence content is protected',()=>{
 const file='/mnt/data/MT5 FRAMEWORK - № 3 Tools MT5 Framework.md';
 if (!fs.existsSync(file)) return;
 const original=fs.readFileSync(file,'utf8');
 assert.match(original,/<CodeCite\b/);
 const converted=dil(original).markdown;
 assert.doesNotMatch(converted,/<\/?(?:CodeCite|Cite|WritingBlock)\b/);
 assert.match(converted, /```cpp/);
 assert.match(render('```\nauthor text\n```'),/```text/);
});

test('literal HTML-like placeholders are escaped but code and autolinks remain',()=>{
  const input='Файл_<GUID>.mq5 и <timestamp>.txt\n\n`<GUID>`\n\n```xml\n<GUID>\n```\n\n<https://example.org/path>';
  const output=render(input);
  assert.match(output,/Файл_&lt;GUID&gt;\.mq5 и &lt;timestamp&gt;\.txt/);
  assert.match(output, /`<GUID>`/);
  assert.match(output, /```xml\n<GUID>\n```/);
  assert.match(output, /<https:\/\/example\.org\/path>/);
});
