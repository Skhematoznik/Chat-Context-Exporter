(() => {
  'use strict';

  const app = globalThis.__chatContextExporter;
  if (!app) {
    throw new Error('Chat Context Exporter: namespace is not initialized.');
  }

  const INLINE_TAGS = new Set([
    'A', 'ABBR', 'B', 'BDI', 'BDO', 'BR', 'CITE', 'CODE', 'DEL', 'EM', 'I',
    'IMG', 'KBD', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRIKE',
    'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR',
  ]);

  const SKIP_TAGS = new Set([
    'BUTTON', 'SCRIPT', 'STYLE', 'SVG', 'NOSCRIPT', 'TEMPLATE', 'INPUT',
    'TEXTAREA', 'SELECT', 'OPTION',
  ]);

  function normalizeText(value) {
    return String(value ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n?/g, '\n');
  }

  function isMeaningfulText(value) {
    return /\S/.test(normalizeText(value));
  }

  function isExplicitlyHidden(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') {
      return true;
    }

    const style = String(element.getAttribute('style') || '');
    return (
      /(?:^|;)\s*display\s*:\s*none\s*(?:!important)?\s*(?:;|$)/i.test(style)
      || /(?:^|;)\s*visibility\s*:\s*(?:hidden|collapse)\s*(?:!important)?\s*(?:;|$)/i.test(style)
      || /(?:^|;)\s*opacity\s*:\s*0(?:\.0+)?\s*(?:!important)?\s*(?:;|$)/i.test(style)
    );
  }

  function parseLanguageFromCodeBlock(element, codeElement) {
    const candidates = [
      codeElement?.getAttribute?.('data-language'),
      element?.getAttribute?.('data-language'),
      codeElement?.className,
      element?.className,
    ].filter(Boolean);

    for (const candidate of candidates) {
      const text = String(candidate);
      const match = text.match(/(?:language-|lang-)([a-z0-9_+#.-]+)/i);
      if (match) {
        return match[1].toLowerCase();
      }
    }

    const labelCandidates = [
      element?.querySelector?.('[data-language]')?.getAttribute('data-language'),
      element?.querySelector?.('.font-mono')?.textContent,
      element?.querySelector?.('[class*="language"]')?.textContent,
    ];

    for (const candidate of labelCandidates) {
      const label = String(candidate ?? '').trim();
      if (
        label
        && label.length <= 32
        && /^[a-z0-9_+#. -]+$/i.test(label)
        && !/^(copy|copied|копировать|скопировано|свернуть|перенос)$/i.test(label)
      ) {
        return label.toLowerCase().replace(/\s+/g, '-');
      }
    }

    return null;
  }

  function isCodeBlockWrapper(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    if (element.matches('[data-markdown-copy="code-block"]')) {
      return Boolean(element.querySelector('pre, code'));
    }

    return (
      element.matches('[data-testid="code-block"]')
      || element.classList.contains('chat-code-block')
    ) && Boolean(element.querySelector('pre'));
  }

  function resolveHref(rawHref, baseUrl) {
    if (!rawHref) {
      return null;
    }

    try {
      return new URL(rawHref, baseUrl || window.location.href).toString();
    } catch {
      return rawHref;
    }
  }

  function parseInlineNode(node, context) {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = normalizeText(node.nodeValue);
      return value ? [{ type: 'text', value }] : [];
    }

    if (!(node instanceof Element) || SKIP_TAGS.has(node.tagName)) {
      return [];
    }

    if (isExplicitlyHidden(node)) {
      return [];
    }

    if (node.matches('[data-cce-math-inline]')) {
      return [{ type: 'math', value: normalizeText(node.textContent).trim() }];
    }

    const children = () => parseInlineChildren(node, context);

    switch (node.tagName) {
      case 'BR':
        return [{ type: 'break' }];
      case 'STRONG':
      case 'B':
        return [{ type: 'strong', children: children() }];
      case 'EM':
      case 'I':
        return [{ type: 'emphasis', children: children() }];
      case 'DEL':
      case 'S':
      case 'STRIKE':
        return [{ type: 'strike', children: children() }];
      case 'CODE':
      case 'KBD':
      case 'SAMP':
        return [{ type: 'code', value: normalizeText(node.textContent) }];
      case 'A': {
        const href = resolveHref(node.getAttribute('href'), context.baseUrl);
        const label = children();
        if (!href) {
          return label;
        }
        return [{ type: 'link', href, children: label }];
      }
      case 'IMG': {
        const alt = String(node.getAttribute('alt') || '').trim();
        return alt ? [{ type: 'text', value: alt }] : [];
      }
      default:
        return children();
    }
  }

  function parseInlineChildren(element, context) {
    const result = [];
    for (const child of element.childNodes) {
      result.push(...parseInlineNode(child, context));
    }
    return result;
  }

  function parseCodeBlock(element) {
    const pre = element.tagName === 'PRE' ? element : element.querySelector('pre');
    const codeElement = pre
      ? (pre.querySelector('code') || pre)
      : element.matches('[data-markdown-copy="code-block"]')
        ? element.querySelector('code')
        : null;
    if (!codeElement) {
      return null;
    }

    return {
      type: 'codeBlock',
      language: parseLanguageFromCodeBlock(element, codeElement),
      code: normalizeText(codeElement.textContent).replace(/\n$/, ''),
    };
  }

  function parseTable(element, context) {
    const rows = [];
    let hasExplicitHeader = false;

    for (const row of element.querySelectorAll('tr')) {
      const cells = [];
      for (const cell of row.children) {
        if (cell.tagName !== 'TH' && cell.tagName !== 'TD') {
          continue;
        }
        if (cell.tagName === 'TH') {
          hasExplicitHeader = true;
        }
        cells.push(parseInlineChildren(cell, context));
      }
      if (cells.length > 0) {
        rows.push(cells);
      }
    }

    if (rows.length === 0) {
      return null;
    }

    return {
      type: 'table',
      rows,
      hasExplicitHeader,
    };
  }

  function parseList(element, context) {
    const items = [];

    for (const child of element.children) {
      if (child.tagName !== 'LI') {
        continue;
      }
      const blocks = parseMixedChildren(child, context);
      if (blocks.length > 0) {
        items.push(blocks);
      }
    }

    if (items.length === 0) {
      return null;
    }

    return {
      type: 'list',
      ordered: element.tagName === 'OL',
      start: element.tagName === 'OL'
        ? Math.max(1, Number.parseInt(element.getAttribute('start') || '1', 10) || 1)
        : null,
      items,
    };
  }

  function parseBlockNode(node, context) {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = normalizeText(node.nodeValue);
      if (!isMeaningfulText(value)) {
        return [];
      }
      return [{ type: 'paragraph', children: [{ type: 'text', value }] }];
    }

    if (!(node instanceof Element) || SKIP_TAGS.has(node.tagName)) {
      return [];
    }

    if (isExplicitlyHidden(node)) {
      return [];
    }

    if (node.matches('[data-cce-math-block]')) {
      const value = normalizeText(node.textContent).trim();
      return value ? [{ type: 'mathBlock', value }] : [];
    }

    if (isCodeBlockWrapper(node)) {
      const codeBlock = parseCodeBlock(node);
      return codeBlock ? [codeBlock] : [];
    }

    if (/^H[1-6]$/.test(node.tagName)) {
      return [{
        type: 'heading',
        level: Number(node.tagName.slice(1)),
        children: parseInlineChildren(node, context),
      }];
    }

    switch (node.tagName) {
      case 'P':
        return [{ type: 'paragraph', children: parseInlineChildren(node, context) }];
      case 'PRE': {
        const codeBlock = parseCodeBlock(node);
        return codeBlock ? [codeBlock] : [];
      }
      case 'UL':
      case 'OL': {
        const list = parseList(node, context);
        return list ? [list] : [];
      }
      case 'BLOCKQUOTE': {
        const blocks = parseMixedChildren(node, context);
        return blocks.length > 0 ? [{ type: 'blockquote', blocks }] : [];
      }
      case 'TABLE': {
        const table = parseTable(node, context);
        return table ? [table] : [];
      }
      case 'HR':
        return [{ type: 'separator' }];
      default:
        return parseMixedChildren(node, context);
    }
  }

  function parseMixedChildren(element, context) {
    const blocks = [];
    let inlineBuffer = [];

    const flushInline = () => {
      if (inlineBuffer.length === 0) {
        return;
      }

      const hasContent = inlineBuffer.some((item) => {
        if (item.type === 'text') {
          return isMeaningfulText(item.value);
        }
        return true;
      });

      if (hasContent) {
        blocks.push({ type: 'paragraph', children: inlineBuffer });
      }
      inlineBuffer = [];
    };

    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const value = normalizeText(child.nodeValue);
        if (value) {
          inlineBuffer.push({ type: 'text', value });
        }
        continue;
      }

      if (!(child instanceof Element) || SKIP_TAGS.has(child.tagName)) {
        continue;
      }

      if (isExplicitlyHidden(child)) {
        continue;
      }

      if (INLINE_TAGS.has(child.tagName)) {
        inlineBuffer.push(...parseInlineNode(child, context));
        continue;
      }

      flushInline();
      blocks.push(...parseBlockNode(child, context));
    }

    flushInline();
    return blocks;
  }

  function parseHtml(html, options = {}) {
    const template = document.createElement('template');
    template.innerHTML = String(html ?? '');

    const wrapper = document.createElement('div');
    wrapper.append(template.content.cloneNode(true));

    return parseMixedChildren(wrapper, {
      baseUrl: options.baseUrl || window.location.href,
    });
  }

  app.modules.richTextParser = {
    parseHtml,
  };
})();
