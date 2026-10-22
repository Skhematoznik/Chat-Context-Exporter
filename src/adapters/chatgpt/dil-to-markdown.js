(() => {
  'use strict';

  // ChatGPT sometimes includes rendered-interface DIL in text.parts. Convert only
  // recognized components; preserve code and unrecognized dynamic expressions.
  const INLINE = new Set([
    'Link', 'Entity', 'text', 'title', 'caption', 'bold', 'italic', 'underline',
    'strikethrough', 'badge', 'label', 'code', 'math', 'escape',
  ]);
  const BLOCK = new Set([
    'box', 'row', 'col', 'card', 'grid', 'grid-item', 'flow', 'flow-item',
    'carousel', 'carousel-item', 'carousel-media-item', 'list', 'list-item',
    'blockquote', 'popover', 'popover-trigger', 'popover-content', 'pressable',
    'form', 'table', 'table-row', 'table-cell', 'table-section',
  ]);
  const SELF = new Set(['icon', 'divider', 'spacer', 'favicon', 'AsyncImage', 'AsyncVideo', 'Chart',
    'Cite', 'CodeCite', 'FileCite', 'MemoryCite']);
  const CONTROL = new Set(['button', 'checkbox', 'input', 'select', 'slider', 'textarea', 'date-picker', 'radio', 'radio-group']);
  const KNOWN = new Set([...INLINE, ...BLOCK, ...SELF, ...CONTROL, 'CodeBlock', 'WritingBlock']);

  function fenced(text, language = 'dil') {
    const runs = [...String(text).matchAll(/`+/g)].map((match) => match[0].length);
    const fence = '`'.repeat(Math.max(3, ...runs.map((length) => length + 1)));
    return `${fence}${language}\n${text}\n${fence}`;
  }

  function protectCode(text, protectedSegments) {
    const lines = String(text).split('\n');
    let marker = null;
    let buffer = [];
    const replaced = [];
    const capture = (value) => {
      const id = protectedSegments.length;
      protectedSegments.push(value);
      return `\uE0A0${id}\uE0A1`;
    };
    for (const line of lines) {
      const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (marker) {
        buffer.push(line);
        if (fence && fence[1][0] === marker[0] && fence[1].length >= marker.length) {
          replaced.push(capture(buffer.join('\n')));
          marker = null;
          buffer = [];
        }
      } else if (fence) {
        marker = fence[1];
        buffer = [line];
      } else {
        replaced.push(line);
      }
    }
    if (marker) replaced.push(capture(buffer.join('\n')));

    const source = replaced.join('\n');
    let output = '';
    let cursor = 0;
    while (cursor < source.length) {
      if (source[cursor] !== '`') {
        output += source[cursor++];
        continue;
      }
      let end = cursor;
      while (source[end] === '`') end += 1;
      const run = source.slice(cursor, end);
      let closeAt = source.indexOf(run, end);
      while (closeAt >= 0 && source[closeAt + run.length] === '`') {
        closeAt = source.indexOf(run, closeAt + run.length);
      }
      if (closeAt < 0) {
        output += run;
        cursor = end;
      } else {
        output += capture(source.slice(cursor, closeAt + run.length));
        cursor = closeAt + run.length;
      }
    }
    return output;
  }

  function staticLoopAsTable(source, protect) {
    // No JavaScript evaluation. Only plain literal records (name/value/desc)
    // are supported; anything else is preserved verbatim in a DIL code block.
    return source.replace(/\{#each\s+(\[[\s\S]*?\])\s+as\s+([\w$]+)(?:\s*,\s*[\w$]+)?\s*\}([\s\S]*?)\{\/each\}/g,
      (whole, literal, item, template) => {
        try {
          if (!template.includes(`{${item}.name}`) || !template.includes(`{${item}.value}`)) {
            return protect(fenced(whole));
          }
          const json = literal.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3');
          const entries = JSON.parse(json);
          if (!Array.isArray(entries) || entries.length === 0 || entries.length > 100
              || entries.some((entry) => !entry || typeof entry !== 'object'
                || typeof entry.name !== 'string' || !Number.isFinite(entry.value)
                || (entry.desc != null && typeof entry.desc !== 'string')
                || Object.keys(entry).some((key) => !['name', 'value', 'desc'].includes(key)))) {
            return protect(fenced(whole));
          }
          const hasDesc = entries.some((entry) => entry.desc != null);
          const percent = new RegExp(`\\{(?:\\$\\{)?${item}\\.value\\}\\}?\\s*%`).test(template);
          const safeCell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
          const heading = hasDesc
            ? '| Показатель | Значение | Описание |\n| --- | ---: | --- |'
            : '| Показатель | Значение |\n| --- | ---: |';
          const rows = entries.map((entry) => hasDesc
            ? `| ${safeCell(entry.name)} | ${safeCell(entry.value)}${percent ? '%' : ''} | ${safeCell(entry.desc)} |`
            : `| ${safeCell(entry.name)} | ${safeCell(entry.value)}${percent ? '%' : ''} |`);
          return `\n${heading}\n${rows.join('\n')}\n`;
        } catch {
          return protect(fenced(whole));
        }
      });
  }

  function readTag(source, start) {
    const match = source.slice(start).match(/^<(\/)?([A-Za-z][\w-]*)\b/);
    if (!match || !KNOWN.has(match[2])) return null;
    let pos = start + match[0].length;
    let quote = null;
    let braces = 0;
    while (pos < source.length) {
      const char = source[pos];
      if (quote) {
        if (char === '\\') pos += 2;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '{') braces += 1;
      else if (char === '}' && braces > 0) braces -= 1;
      else if (char === '>' && braces === 0) {
        const raw = source.slice(start, pos + 1);
        return {
          raw, name: match[2], closing: Boolean(match[1]),
          selfClosing: /\/\s*>$/.test(raw) || SELF.has(match[2]),
          attributes: raw.slice(match[0].length, raw.length - 1),
          end: pos + 1,
        };
      }
      pos += 1;
    }
    return null;
  }

  function attribute(tag, attr) {
    const match = tag.attributes.match(new RegExp(`(?:^|\\s)${attr}\\s*=\\s*(["'])([\\s\\S]*?)\\1`));
    return match ? match[2] : null;
  }

  function mdUrl(raw) {
    const url = String(raw || '').trim().replace(/&amp;/g, '&');
    if (!/^(?:https?:\/\/|mailto:|sandbox:)/i.test(url)) return null;
    return url.replace(/\\/g, '\\\\').replace(/([()])/g, '\\$1').replace(/\s/g, '%20');
  }

  function renderNodes(nodes, stats) {
    return nodes.map((node) => {
      if (typeof node === 'string') return node;
      stats.components += 1;
      const name = node.tag.name;
      const inside = renderNodes(node.children, stats);
      if (name === 'Link') {
        const href = mdUrl(attribute(node.tag, 'url'));
        const label = inside.trim() || attribute(node.tag, 'title') || href || '';
        return href ? `[${label.replace(/\]/g, '\\]')}](${href})` : label;
      }
      if (name === 'Entity') return inside || attribute(node.tag, 'value') || '';
      // Tool citations are UI-only metadata; no offline target exists for them.
      if (['Cite', 'CodeCite', 'FileCite', 'MemoryCite'].includes(name)) return '';
      if (name === 'icon') {
        const icon = attribute(node.tag, 'name');
        return icon === 'arrow-right' ? ' → ' : icon === 'arrow-down' ? '\n↓\n' : '';
      }
      if (name === 'button') {
        return /GenUI\.copy\s*\(/.test(node.tag.raw) ? '' : inside.trim();
      }
      if (name === 'badge') return inside.trim() ? `**${inside.trim()}**` : '';
      if (name === 'bold') return `**${inside.trim()}**`;
      if (name === 'italic') return `*${inside.trim()}*`;
      if (name === 'strikethrough') return `~~${inside.trim()}~~`;
      if (name === 'code') return `\`${inside.trim().replace(/`/g, "'")}\``;
      if (name === 'math') return inside.trim() || attribute(node.tag, 'value') || '';
      if (name === 'divider' || name === 'spacer' || name === 'favicon') return '\n';
      if (name === 'AsyncImage' || name === 'AsyncVideo' || name === 'Chart') {
        return attribute(node.tag, 'alt') || `[${name}: визуализация не переносится в Markdown]`;
      }
      if (BLOCK.has(name)) {
        const content = inside.replace(/\n[ \t]{2,}(?=\S)/g, '\n').trim();
        return `\n${content}\n`;
      }
      return inside;
    }).join('');
  }

  function convertMarkup(source, stats) {
    const root = { children: [] };
    const stack = [root];
    let cursor = 0;
    while (cursor < source.length) {
      const index = source.indexOf('<', cursor);
      if (index < 0) {
        stack[stack.length - 1].children.push(source.slice(cursor));
        break;
      }
      if (index > cursor) stack[stack.length - 1].children.push(source.slice(cursor, index));
      if (index > 0 && source[index - 1] === '\\') {
        stack[stack.length - 1].children.push('<');
        cursor = index + 1;
        continue;
      }
      const tag = readTag(source, index);
      if (!tag) {
        stack[stack.length - 1].children.push('<');
        cursor = index + 1;
        continue;
      }
      if (tag.closing) {
        if (stack.length > 1 && stack[stack.length - 1].tag.name === tag.name) {
          stack.pop();
        } else {
          // Malformed input: keep it losslessly rather than discard content.
          return { markdown: source, failed: true };
        }
      } else {
        const node = { tag, children: [] };
        stack[stack.length - 1].children.push(node);
        if (!tag.selfClosing) stack.push(node);
      }
      cursor = tag.end;
    }
    if (stack.length !== 1) return { markdown: source, failed: true };
    return { markdown: renderNodes(root.children, stats), failed: false };
  }

  function normalize(input) {
    const source = String(input ?? '');
    if (!/<(?:\/?(?:Link|row|box|icon|badge|button|text|title|caption|divider|col|card|grid|flow|Entity|WritingBlock|Cite|CodeCite|FileCite|MemoryCite)\b)|\{#(?:each|if)\b/.test(source)) {
      return { markdown: source, components: 0, failed: false };
    }
    const protectedSegments = [];
    let work = protectCode(source.replace(/<CodeBlock\b([^>]*)>([\s\S]*?)<\/CodeBlock>/g,
      (full, attrs, body) => {
        const lang = /language\s*=\s*["']([^"']+)["']/.exec(attrs)?.[1] || '';
        return fenced(body, lang.replace(/[^\w+#.-]/g, '') || 'text');
      }), protectedSegments);
    const protectDirective = (value) => {
      const id = protectedSegments.length;
      protectedSegments.push(value);
      return `\uE0A0${id}\uE0A1`;
    };
    // WritingBlock owns raw Markdown content. Strip its UI wrapper, but do not
    // interpret embedded examples, tags or code inside the author's draft.
    work = work.replace(/<WritingBlock\b[^>]*>([\s\S]*?)<\/WritingBlock>/g,
      (_whole, body) => protectDirective(body));
    work = staticLoopAsTable(work, protectDirective);
    work = work.replace(/\{#if\b[\s\S]*?\{\/if\}/g, (value) => protectDirective(fenced(value)));
    const stats = { components: 0 };
    const converted = convertMarkup(work, stats);
    if (converted.failed) return { markdown: source, components: 0, failed: true };
    let result = converted.markdown;
    // Unknown dynamic directives must not disappear or be rendered as a misleading
    // completed table. Keep their unexecuted source in a fenced block.
    result = result.replace(/\{#(?:if|each)\b[\s\S]*?\{\/(?:if|each)\}/g, (raw) => fenced(raw));
    result = result.replace(/\n{3,}/g, '\n\n').trim();
    // A raw WritingBlock may contain a protected Markdown code fence.
    // Restore nested placeholders without interpreting their contents.
    for (let depth = 0; depth <= protectedSegments.length && /\uE0A0\d+\uE0A1/.test(result); depth++) {
      result = result.replace(/\uE0A0(\d+)\uE0A1/g, (match, id) => protectedSegments[Number(id)] ?? match);
    }
    return { markdown: result, components: stats.components, failed: false };
  }

  globalThis.__chatContextExporterDilToMarkdown = Object.freeze({ normalize });
})();
