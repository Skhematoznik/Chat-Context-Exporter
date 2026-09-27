(() => {
  'use strict';

  const app = globalThis.__chatContextExporter;
  if (!app) {
    throw new Error('Chat Context Exporter: namespace is not initialized.');
  }

  function escapeText(value) {
    const escaped = String(value ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/([`*_\[\]<>~])/g, '\\$1');

    return escaped
      .replace(/^([#>+-])(?=\s)/gm, '\\$1')
      .replace(/^(\d+)\.(?=\s)/gm, '$1\\.')
      .replace(/\n/g, '  \n');
  }

  function escapeHeadingText(value) {
    return String(value ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/([`*_\[\]<>~])/g, '\\$1')
      .replace(/\n+/g, ' ')
      .trim();
  }

  function longestBacktickRun(value) {
    let longest = 0;
    for (const match of String(value ?? '').matchAll(/`+/g)) {
      longest = Math.max(longest, match[0].length);
    }
    return longest;
  }

  function renderInlineCode(value) {
    const text = String(value ?? '');
    const fence = '`'.repeat(Math.max(1, longestBacktickRun(text) + 1));
    const needsPadding = /^\s|\s$|^`|`$/.test(text);
    return `${fence}${needsPadding ? ' ' : ''}${text}${needsPadding ? ' ' : ''}${fence}`;
  }

  function escapeLinkDestination(value) {
    return String(value ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/([()])/g, '\\$1')
      .replace(/\s/g, '%20');
  }

  function renderInline(nodes, options = {}) {
    const headingContext = options.context === 'heading';

    return (nodes || []).map((node) => {
      switch (node.type) {
        case 'text':
          return headingContext ? escapeHeadingText(node.value) : escapeText(node.value);
        case 'break':
          return '  \n';
        case 'strong':
          return `**${renderInline(node.children, options)}**`;
        case 'emphasis':
          return `*${renderInline(node.children, options)}*`;
        case 'strike':
          return `~~${renderInline(node.children, options)}~~`;
        case 'code':
          return renderInlineCode(node.value);
        case 'link':
          return `[${renderInline(node.children, options)}](${escapeLinkDestination(node.href)})`;
        default:
          return '';
      }
    }).join('');
  }

  function renderCodeBlock(block) {
    const code = String(block.code ?? '');
    const fenceLength = Math.max(3, longestBacktickRun(code) + 1);
    const fence = '`'.repeat(fenceLength);
    const language = String(block.language ?? '').replace(/[^a-z0-9_+#.-]/gi, '');
    return `${fence}${language}\n${code}\n${fence}`;
  }

  function indentLines(text, prefixFirst, prefixRest) {
    const lines = String(text ?? '').split('\n');
    return lines.map((line, index) => `${index === 0 ? prefixFirst : prefixRest}${line}`).join('\n');
  }

  function renderList(block) {
    return block.items.map((itemBlocks, index) => {
      const marker = block.ordered ? `${(block.start || 1) + index}. ` : '- ';
      const continuation = ' '.repeat(marker.length);
      const itemText = renderBlocks(itemBlocks).trim();
      return indentLines(itemText, marker, continuation);
    }).join('\n');
  }

  function renderBlockquote(block) {
    const content = renderBlocks(block.blocks).trim();
    return content
      .split('\n')
      .map((line) => (line ? `> ${line}` : '>'))
      .join('\n');
  }

  function renderTableCell(inlineNodes) {
    return renderInline(inlineNodes)
      .replace(/\|/g, '\\|')
      .replace(/\n/g, '<br>')
      .trim();
  }

  function renderTable(block) {
    const rows = block.rows || [];
    if (rows.length === 0) {
      return '';
    }

    const columnCount = Math.max(...rows.map((row) => row.length));
    const normalizedRows = rows.map((row) => {
      const cells = [...row];
      while (cells.length < columnCount) {
        cells.push([]);
      }
      return cells;
    });

    const renderRow = (row) => `| ${row.map(renderTableCell).join(' | ')} |`;
    const output = [renderRow(normalizedRows[0])];
    output.push(`| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`);
    for (const row of normalizedRows.slice(1)) {
      output.push(renderRow(row));
    }
    return output.join('\n');
  }

  function renderBlock(block) {
    switch (block.type) {
      case 'paragraph':
        return renderInline(block.children).trim();
      case 'heading':
        return `${'#'.repeat(Math.min(6, Math.max(1, Number(block.level) || 1)))} ${renderInline(block.children, { context: 'heading' }).trim()}`;
      case 'codeBlock':
        return renderCodeBlock(block);
      case 'list':
        return renderList(block);
      case 'blockquote':
        return renderBlockquote(block);
      case 'table':
        return renderTable(block);
      case 'separator':
        return '---';
      default:
        return '';
    }
  }

  function renderBlocks(blocks) {
    return (blocks || [])
      .map(renderBlock)
      .filter((value) => value !== '')
      .join('\n\n');
  }

  function formatRole(role) {
    if (role === 'user') {
      return 'Пользователь';
    }
    if (role === 'assistant') {
      return 'Ассистент';
    }
    return 'Сообщение';
  }

  function exportConversation(conversation) {
    const title = escapeHeadingText(conversation.title || 'Экспорт диалога');
    const sections = [`# ${title}`];
    const messages = conversation.messages || [];

    messages.forEach((message, index) => {
      if (index > 0) {
        sections.push('---');
      }

      const timestampSuffix = message.timestamp ? ` — ${escapeHeadingText(message.timestamp)}` : '';
      sections.push(`**${formatRole(message.role)}${timestampSuffix}**`);

      const content = renderBlocks(message.blocks || []);
      if (content) {
        sections.push(content);
      }
    });

    return `${sections.join('\n\n').trim()}\n`;
  }

  const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

  function sanitizeFilenameBase(value, fallback = 'Chat export') {
    let safe = String(value ?? '')
      .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' - ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/g, '');

    if (!safe) {
      safe = fallback;
    }

    if (WINDOWS_RESERVED_NAMES.test(safe)) {
      safe = `_${safe}`;
    }

    // Оставляем запас для расширения и ограничений файловых систем/путей.
    if (safe.length > 200) {
      safe = safe.slice(0, 200).trim().replace(/[. ]+$/g, '');
    }

    return safe || fallback;
  }

  function createFilename(pageTitle, fallbackTitle = 'Chat export') {
    return `${sanitizeFilenameBase(pageTitle, fallbackTitle)}.md`;
  }

  app.modules.markdownExporter = {
    exportConversation,
    sanitizeFilenameBase,
    createFilename,
  };
})();
