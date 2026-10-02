(() => {
  'use strict';

  const STREAM_CALL = 'window.__reactRouterContext.streamController.enqueue(';
  const SHARE_ROUTE_KEY = 'routes/share.$shareId.($action)';
  const NULL_SENTINEL = -5;
  const INTERNAL_MARKER_RE = /\uE200[^\uE201]*\uE201/g;

  function readJsonStringLiteral(source, startIndex) {
    let index = startIndex;
    while (/\s/.test(source[index] || '')) {
      index += 1;
    }
    if (source[index] !== '"') {
      return null;
    }

    let escaped = false;
    for (let cursor = index + 1; cursor < source.length; cursor += 1) {
      const char = source[cursor];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        const literal = source.slice(index, cursor + 1);
        try {
          return {
            value: JSON.parse(literal),
            endIndex: cursor + 1,
          };
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  function extractCandidateTables(html) {
    const source = String(html || '');
    const tables = [];
    let offset = 0;

    while (offset < source.length) {
      const callIndex = source.indexOf(STREAM_CALL, offset);
      if (callIndex < 0) {
        break;
      }
      const argumentStart = callIndex + STREAM_CALL.length;
      const parsedString = readJsonStringLiteral(source, argumentStart);
      if (!parsedString) {
        offset = argumentStart + 1;
        continue;
      }
      offset = parsedString.endIndex;

      const chunk = typeof parsedString.value === 'string' ? parsedString.value : '';
      if (!chunk.includes(SHARE_ROUTE_KEY) || !chunk.includes('linear_conversation')) {
        continue;
      }

      try {
        const table = JSON.parse(chunk);
        if (Array.isArray(table) && table.length > 0) {
          tables.push(table);
        }
      } catch {
        // Ignore non-JSON chunks. The current public Shared loader uses JSON arrays.
      }
    }

    return tables;
  }

  function createTableResolver(table) {
    const memo = new Map();
    const resolving = new Set();

    function resolveRef(index) {
      if (index === NULL_SENTINEL) {
        return null;
      }
      if (!Number.isInteger(index)) {
        return index;
      }
      if (index < 0) {
        throw new Error(`ChatGPT Shared: неподдерживаемая ссылка React Router ${index}.`);
      }
      if (index >= table.length) {
        throw new Error(`ChatGPT Shared: ссылка React Router ${index} выходит за пределы таблицы ${table.length}.`);
      }
      if (memo.has(index)) {
        return memo.get(index);
      }
      if (resolving.has(index)) {
        throw new Error(`ChatGPT Shared: обнаружена циклическая ссылка React Router ${index}.`);
      }

      resolving.add(index);
      const raw = table[index];
      let resolved;

      if (Array.isArray(raw)) {
        resolved = [];
        memo.set(index, resolved);
        for (const item of raw) {
          resolved.push(Number.isInteger(item) ? resolveRef(item) : item);
        }
      } else if (raw && typeof raw === 'object') {
        resolved = {};
        memo.set(index, resolved);
        for (const [encodedKey, valueRef] of Object.entries(raw)) {
          const match = encodedKey.match(/^_(\d+)$/);
          if (!match || !Number.isInteger(valueRef)) {
            continue;
          }
          const key = resolveRef(Number(match[1]));
          resolved[String(key)] = resolveRef(valueRef);
        }
      } else {
        resolved = raw;
        memo.set(index, resolved);
      }

      resolving.delete(index);
      memo.set(index, resolved);
      return resolved;
    }

    function getPropertyRef(objectRef, propertyName) {
      if (!Number.isInteger(objectRef) || objectRef < 0 || objectRef >= table.length) {
        return null;
      }
      const raw = table[objectRef];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return null;
      }
      for (const [encodedKey, valueRef] of Object.entries(raw)) {
        const match = encodedKey.match(/^_(\d+)$/);
        if (!match || !Number.isInteger(valueRef)) {
          continue;
        }
        const keyRef = Number(match[1]);
        if (table[keyRef] === propertyName) {
          return valueRef;
        }
      }
      return null;
    }

    function resolveProperty(objectRef, propertyName) {
      const ref = getPropertyRef(objectRef, propertyName);
      return ref === null ? undefined : resolveRef(ref);
    }

    function countObjectEntries(objectRef) {
      if (!Number.isInteger(objectRef) || objectRef < 0 || objectRef >= table.length) {
        return null;
      }
      const raw = table[objectRef];
      return raw && typeof raw === 'object' && !Array.isArray(raw)
        ? Object.keys(raw).length
        : null;
    }

    return {
      resolveRef,
      getPropertyRef,
      resolveProperty,
      countObjectEntries,
    };
  }

  function normalizeTimestamp(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return null;
    }
    const milliseconds = numeric > 1e12 ? numeric : numeric * 1000;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  function escapeInlineCode(value) {
    return String(value || '').replace(/`+/g, "'");
  }

  function formatAttachmentList(message) {
    const attachments = Array.isArray(message?.metadata?.attachments)
      ? message.metadata.attachments
      : [];
    const seen = new Set();
    const lines = [];

    for (const attachment of attachments) {
      const id = typeof attachment?.id === 'string' ? attachment.id : '';
      const name = typeof attachment?.name === 'string' && attachment.name.trim()
        ? attachment.name.trim()
        : id || 'Вложение';
      const identity = id || name;
      if (seen.has(identity)) {
        continue;
      }
      seen.add(identity);

      const details = [];
      if (typeof attachment?.mime_type === 'string' && attachment.mime_type.trim()) {
        details.push(attachment.mime_type.trim());
      }
      const width = Number(attachment?.width);
      const height = Number(attachment?.height);
      if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
        details.push(`${Math.round(width)}×${Math.round(height)}`);
      }
      const size = Number(attachment?.size);
      if (Number.isFinite(size) && size > 0) {
        const kb = size / 1024;
        details.push(kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(1)} KB`);
      }

      lines.push(`- \`${escapeInlineCode(name)}\`${details.length ? ` — ${details.join(', ')}` : ''}`);
    }

    if (lines.length === 0) {
      return '';
    }
    return `**Вложения:**\n${lines.join('\n')}`;
  }

  function extractTextParts(content) {
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    return parts.filter((part) => typeof part === 'string').join('');
  }

  function formatFileReference(reference) {
    const name = typeof reference?.name === 'string' && reference.name.trim()
      ? reference.name.trim()
      : 'файл';
    const start = Number(reference?.input_pointer?.line_range_start);
    const end = Number(reference?.input_pointer?.line_range_end);
    const range = Number.isFinite(start)
      ? Number.isFinite(end) && end !== start
        ? `, строки ${start}–${end}`
        : `, строка ${start}`
      : '';
    return `[Источник: ${name}${range}]`;
  }

  function groupedWebReferenceReplacement(reference) {
    const alt = typeof reference?.alt === 'string' ? reference.alt.trim() : '';
    if (alt) {
      return alt;
    }
    const item = Array.isArray(reference?.items) ? reference.items[0] : null;
    const url = typeof item?.url === 'string' && item.url.trim()
      ? item.url.trim()
      : Array.isArray(reference?.safe_urls) && typeof reference.safe_urls[0] === 'string'
        ? reference.safe_urls[0]
        : '';
    if (!url) {
      return '';
    }
    const title = typeof item?.title === 'string' && item.title.trim()
      ? item.title.trim()
      : typeof item?.attribution === 'string' && item.attribution.trim()
        ? item.attribution.trim()
        : 'Источник';
    return `([${title}](${url}))`;
  }

  function trimFollowupTail(text, references) {
    const followups = (references || [])
      .filter((reference) => reference?.type === 'followup_a'
        && reference?.presentation_mode === 'bottom_list'
        && Number.isInteger(reference?.start_idx));
    if (followups.length === 0) {
      return { text, cutAt: text.length, removed: 0 };
    }

    const first = Math.min(...followups.map((reference) => reference.start_idx));
    if (first < 0 || first > text.length) {
      return { text, cutAt: text.length, removed: 0 };
    }

    let lineStart = text.lastIndexOf('\n', Math.max(0, first - 1));
    lineStart = lineStart < 0 ? 0 : lineStart + 1;
    let cutAt = lineStart;

    const beforeList = text.slice(0, lineStart).replace(/[ \t]+$/g, '').replace(/\n+$/g, '');
    const paragraphBreak = beforeList.lastIndexOf('\n\n');
    if (paragraphBreak >= 0) {
      const possibleHeading = beforeList.slice(paragraphBreak + 2).trim();
      if (possibleHeading && possibleHeading.length <= 160 && !possibleHeading.includes('\n')) {
        cutAt = paragraphBreak;
      }
    }

    return {
      text: text.slice(0, cutAt).trimEnd(),
      cutAt,
      removed: followups.length,
    };
  }

  function rewriteContentReferences(text, references) {
    const refs = Array.isArray(references) ? references : [];
    const trimmed = trimFollowupTail(String(text || ''), refs);
    let output = trimmed.text;
    const replacements = [];
    const stats = {
      total: refs.length,
      groupedWebpages: 0,
      file: 0,
      followup: 0,
      hidden: 0,
      sourcesFootnote: 0,
      other: 0,
      unresolvedMarkersRemoved: 0,
    };

    for (const reference of refs) {
      const type = typeof reference?.type === 'string' ? reference.type : '';
      if (type === 'grouped_webpages') {
        stats.groupedWebpages += 1;
      } else if (type === 'file') {
        stats.file += 1;
      } else if (type === 'followup_a') {
        stats.followup += 1;
      } else if (type === 'hidden') {
        stats.hidden += 1;
      } else if (type === 'sources_footnote') {
        stats.sourcesFootnote += 1;
      } else {
        stats.other += 1;
      }
    }

    for (const reference of refs) {
      const type = typeof reference?.type === 'string' ? reference.type : '';
      if (type === 'followup_a') {
        continue;
      }
      const start = Number(reference?.start_idx);
      const end = Number(reference?.end_idx);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= trimmed.cutAt) {
        continue;
      }
      const safeEnd = Math.min(end, trimmed.cutAt);
      let replacement = null;
      if (type === 'grouped_webpages') {
        replacement = groupedWebReferenceReplacement(reference);
      } else if (type === 'file') {
        replacement = formatFileReference(reference);
      } else if (type === 'hidden') {
        replacement = '';
      } else if (type === 'sources_footnote') {
        replacement = typeof reference?.matched_text === 'string' ? reference.matched_text : '';
      } else {
        continue;
      }

      if (replacement && start > 0 && !/\s/.test(output[start - 1] || '') && !/^\s/.test(replacement)) {
        replacement = ` ${replacement}`;
      }
      replacements.push({ start, end: safeEnd, value: replacement });
    }

    replacements.sort((left, right) => right.start - left.start || right.end - left.end);
    for (const replacement of replacements) {
      if (replacement.start > output.length) {
        continue;
      }
      const end = Math.min(replacement.end, output.length);
      output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(end)}`;
    }

    output = output.replace(INTERNAL_MARKER_RE, () => {
      stats.unresolvedMarkersRemoved += 1;
      return '';
    });

    return {
      markdown: output.trim(),
      stats,
    };
  }

  const GENERATED_FILE_CARD_RE = /^\s*\[(?:\\.|[^\]\n])+\]\(\s*<?sandbox:\/mnt\/data\/[^>\n]+>?\s*\)\s*$/;

  function scanFenceState(text, state) {
    let active = state;
    for (const line of String(text || '').split('\n')) {
      const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (!match) {
        continue;
      }
      const marker = match[1];
      const char = marker[0];
      if (!active) {
        active = { char, length: marker.length };
      } else if (active.char === char && marker.length >= active.length) {
        active = null;
      }
    }
    return active;
  }

  function splitMarkdownParagraphs(text) {
    const source = String(text || '');
    const chunks = [];
    const separatorRe = /\n[ \t]*\n(?:[ \t]*\n)*/g;
    let cursor = 0;
    let match;
    while ((match = separatorRe.exec(source)) !== null) {
      chunks.push({ content: source.slice(cursor, match.index), separator: match[0] });
      cursor = match.index + match[0].length;
    }
    chunks.push({ content: source.slice(cursor), separator: '' });
    return chunks;
  }

  function normalizeGeneratedFileCards(markdown) {
    const source = String(markdown || '').trim();
    if (!source) {
      return { markdown: '', found: 0, moved: 0 };
    }

    const chunks = splitMarkdownParagraphs(source);
    let fenceState = null;
    const cardIndexes = [];
    const nonEmptyIndexes = [];

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const trimmed = chunk.content.trim();
      if (trimmed) {
        nonEmptyIndexes.push(index);
      }
      const startsInsideFence = Boolean(fenceState);
      const isSingleLine = trimmed && !trimmed.includes('\n');
      if (!startsInsideFence && isSingleLine && GENERATED_FILE_CARD_RE.test(trimmed)) {
        cardIndexes.push(index);
      }
      fenceState = scanFenceState(chunk.content, fenceState);
    }

    if (cardIndexes.length === 0) {
      return { markdown: source, found: 0, moved: 0 };
    }

    const cardIndexSet = new Set(cardIndexes);
    let seenNonCardAfter = false;
    let moved = 0;
    for (let i = nonEmptyIndexes.length - 1; i >= 0; i -= 1) {
      const index = nonEmptyIndexes[i];
      if (cardIndexSet.has(index)) {
        if (seenNonCardAfter) {
          moved += 1;
        }
      } else {
        seenNonCardAfter = true;
      }
    }

    if (moved === 0) {
      return { markdown: source, found: cardIndexes.length, moved: 0 };
    }

    let body = '';
    const cards = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (cardIndexSet.has(index)) {
        cards.push(chunk.content.trim());
        continue;
      }
      body += chunk.content + chunk.separator;
    }

    body = body.trimEnd();
    const cardBlock = cards.join('\n\n');
    return {
      markdown: body ? `${body}\n\n${cardBlock}` : cardBlock,
      found: cardIndexes.length,
      moved,
    };
  }

  function getTurnExchangeId(message) {
    const metadata = message?.metadata && typeof message.metadata === 'object'
      ? message.metadata
      : {};
    const turnExchangeId = typeof metadata.turn_exchange_id === 'string'
      ? metadata.turn_exchange_id.trim()
      : '';
    if (turnExchangeId) {
      return turnExchangeId;
    }
    const workingTurnId = typeof metadata.working_turn_id === 'string'
      ? metadata.working_turn_id.trim()
      : '';
    return workingTurnId || null;
  }

  function isAssistantPreambleMessage(message) {
    return message?.author?.role === 'assistant'
      && message?.recipient === 'all'
      && message?.channel === 'commentary'
      && message?.metadata?.is_thinking_preamble_message === true;
  }

  function normalizeTargetedReplyEnvelope(markdown, metadata) {
    const source = String(markdown || '').trim();
    if (!source || typeof metadata?.targeted_reply_source_message_id !== 'string'
        || !metadata.targeted_reply_source_message_id.trim()) {
      return { markdown: source, normalized: false };
    }
    if (!/^# Selected text:\s*(?:\n|$)/i.test(source)) {
      return { markdown: source, normalized: false };
    }
    const requestMarker = /(?:^|\n)## My request:\s*(?:\n|$)/i;
    const match = requestMarker.exec(source);
    if (!match) {
      return { markdown: source, normalized: false };
    }
    const request = source.slice(match.index + match[0].length).trim();
    if (request) {
      return { markdown: request, normalized: true };
    }
    const dictated = typeof metadata?.dictation_original_text === 'string'
      ? metadata.dictation_original_text.trim()
      : '';
    return dictated
      ? { markdown: dictated, normalized: true }
      : { markdown: source, normalized: false };
  }

  function messageMarkdown(message) {
    const content = message?.content || {};
    const contentType = typeof content?.content_type === 'string' ? content.content_type : '';
    const baseText = extractTextParts(content);
    const rewritten = rewriteContentReferences(baseText, message?.metadata?.content_references);
    const isUser = message?.author?.role === 'user' && message?.recipient === 'all';
    const targetedReply = isUser
      ? normalizeTargetedReplyEnvelope(rewritten.markdown, message?.metadata)
      : { markdown: rewritten.markdown, normalized: false };
    const attachmentMarkdown = formatAttachmentList(message);
    const parts = [];
    if (targetedReply.markdown) {
      parts.push(targetedReply.markdown);
    }
    if (attachmentMarkdown) {
      parts.push(attachmentMarkdown);
    }
    const combinedMarkdown = parts.join('\n\n').trim();
    const isAssistantVisible = message?.author?.role === 'assistant'
      && message?.recipient === 'all'
      && (message?.channel === 'final' || isAssistantPreambleMessage(message));
    const generatedFiles = isAssistantVisible
      ? normalizeGeneratedFileCards(combinedMarkdown)
      : { markdown: combinedMarkdown, found: 0, moved: 0 };
    return {
      contentType,
      markdown: generatedFiles.markdown,
      referenceStats: rewritten.stats,
      attachmentCount: Array.isArray(message?.metadata?.attachments)
        ? message.metadata.attachments.length
        : 0,
      generatedFileCards: generatedFiles.found,
      generatedFileCardsMoved: generatedFiles.moved,
      targetedReplyEnvelopeNormalized: targetedReply.normalized ? 1 : 0,
    };
  }

  function parseTable(table, { expectedShareId = null } = {}) {
    const resolver = createTableResolver(table);
    const loaderDataRef = resolver.getPropertyRef(0, 'loaderData');
    const routeRef = resolver.getPropertyRef(loaderDataRef, SHARE_ROUTE_KEY);
    if (!Number.isInteger(routeRef)) {
      throw new Error('ChatGPT Shared: route loaderData не найден в React Router stream.');
    }

    const sharedConversationId = resolver.resolveProperty(routeRef, 'sharedConversationId');
    if (expectedShareId && sharedConversationId && sharedConversationId !== expectedShareId) {
      throw new Error(`ChatGPT Shared: shareId ответа ${sharedConversationId} не совпадает с URL ${expectedShareId}.`);
    }

    const serverResponseRef = resolver.getPropertyRef(routeRef, 'serverResponse');
    if (!Number.isInteger(serverResponseRef)) {
      throw new Error('ChatGPT Shared: serverResponse отсутствует в loaderData.');
    }
    const responseType = resolver.resolveProperty(serverResponseRef, 'type');
    if (responseType !== 'data') {
      throw new Error(`ChatGPT Shared: serverResponse.type=${String(responseType)} вместо data.`);
    }

    const dataRef = resolver.getPropertyRef(serverResponseRef, 'data');
    if (!Number.isInteger(dataRef)) {
      throw new Error('ChatGPT Shared: serverResponse.data отсутствует.');
    }

    const title = resolver.resolveProperty(dataRef, 'title');
    const conversationId = resolver.resolveProperty(dataRef, 'conversation_id');
    const createTime = resolver.resolveProperty(dataRef, 'create_time');
    const updateTime = resolver.resolveProperty(dataRef, 'update_time');
    const currentNode = resolver.resolveProperty(dataRef, 'current_node');
    const linearRef = resolver.getPropertyRef(dataRef, 'linear_conversation');
    const mappingRef = resolver.getPropertyRef(dataRef, 'mapping');
    const linear = Number.isInteger(linearRef) ? resolver.resolveRef(linearRef) : null;

    if (!Array.isArray(linear) || linear.length === 0) {
      throw new Error('ChatGPT Shared: linear_conversation отсутствует или пуст.');
    }

    const finalAssistantTurnExchangeIds = new Set();
    for (const node of linear) {
      const candidate = node?.message;
      if (!candidate || candidate?.metadata?.is_visually_hidden_from_conversation === true) {
        continue;
      }
      if (candidate?.author?.role === 'assistant'
          && candidate?.recipient === 'all'
          && candidate?.channel === 'final') {
        const exchangeId = getTurnExchangeId(candidate);
        if (exchangeId) {
          finalAssistantTurnExchangeIds.add(exchangeId);
        }
      }
    }

    const seenNodeIds = new Set();
    let parentMismatches = 0;
    let nodesWithoutMessage = 0;
    let hiddenSkipped = 0;
    let internalSkipped = 0;
    let unsupportedVisible = 0;
    const unsupportedContentTypes = new Set();
    let user = 0;
    let assistant = 0;
    let multimodalUserMessages = 0;
    let attachmentCount = 0;
    let generatedFileCards = 0;
    let generatedFileCardsMoved = 0;
    let targetedReplyEnvelopesNormalized = 0;
    let assistantPreambleCandidates = 0;
    let assistantPreambleFallbacksIncluded = 0;
    let assistantPreamblesSuppressedByFinal = 0;
    let attachmentMessages = 0;
    let timestampedMessages = 0;
    let missingTimestampMessages = 0;
    const referenceTotals = {
      total: 0,
      groupedWebpages: 0,
      file: 0,
      followup: 0,
      hidden: 0,
      sourcesFootnote: 0,
      other: 0,
      unresolvedMarkersRemoved: 0,
    };
    const messages = [];

    for (let index = 0; index < linear.length; index += 1) {
      const node = linear[index];
      const id = typeof node?.id === 'string' ? node.id : '';
      if (!id) {
        throw new Error(`ChatGPT Shared: raw node #${index + 1} не содержит id.`);
      }
      if (seenNodeIds.has(id)) {
        throw new Error(`ChatGPT Shared: повтор raw node id=${id}.`);
      }
      seenNodeIds.add(id);

      if (index > 0) {
        const previousId = linear[index - 1]?.id;
        if (node?.parent !== previousId) {
          parentMismatches += 1;
        }
      }

      const message = node?.message;
      if (!message || typeof message !== 'object') {
        nodesWithoutMessage += 1;
        continue;
      }

      const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : {};
      const hidden = metadata.is_visually_hidden_from_conversation === true;
      if (hidden) {
        hiddenSkipped += 1;
        continue;
      }

      const role = message?.author?.role;
      const recipient = message?.recipient;
      const turnExchangeId = getTurnExchangeId(message);
      const isUser = role === 'user' && recipient === 'all';
      const isAssistantFinal = role === 'assistant' && recipient === 'all' && message?.channel === 'final';
      const isAssistantPreamble = isAssistantPreambleMessage(message);
      if (isAssistantPreamble) {
        assistantPreambleCandidates += 1;
      }
      const isAssistantPreambleFallback = isAssistantPreamble
        && (!turnExchangeId || !finalAssistantTurnExchangeIds.has(turnExchangeId));
      if (isAssistantPreamble && !isAssistantPreambleFallback) {
        assistantPreamblesSuppressedByFinal += 1;
      }
      if (!isUser && !isAssistantFinal && !isAssistantPreambleFallback) {
        internalSkipped += 1;
        continue;
      }
      if (isAssistantPreambleFallback) {
        assistantPreambleFallbacksIncluded += 1;
      }

      const contentType = typeof message?.content?.content_type === 'string'
        ? message.content.content_type
        : '';
      const supportedContentType = isUser
        ? contentType === 'text' || contentType === 'multimodal_text'
        : contentType === 'text';
      if (!supportedContentType) {
        unsupportedVisible += 1;
        unsupportedContentTypes.add(contentType || '(unknown)');
        continue;
      }

      const normalized = messageMarkdown(message);
      if (!normalized.markdown) {
        unsupportedVisible += 1;
        unsupportedContentTypes.add(`${contentType || '(unknown)'}:empty`);
        continue;
      }

      const timestamp = normalizeTimestamp(message.create_time);
      if (timestamp) {
        timestampedMessages += 1;
      } else {
        missingTimestampMessages += 1;
      }

      attachmentCount += normalized.attachmentCount;
      if (normalized.attachmentCount > 0) {
        attachmentMessages += 1;
      }
      generatedFileCards += normalized.generatedFileCards || 0;
      generatedFileCardsMoved += normalized.generatedFileCardsMoved || 0;
      targetedReplyEnvelopesNormalized += normalized.targetedReplyEnvelopeNormalized || 0;
      if (isUser && contentType === 'multimodal_text') {
        multimodalUserMessages += 1;
      }

      for (const key of Object.keys(referenceTotals)) {
        referenceTotals[key] += normalized.referenceStats[key] || 0;
      }

      const normalizedRole = isUser ? 'user' : 'assistant';
      messages.push({
        id: typeof message.id === 'string' && message.id ? message.id : id,
        role: normalizedRole,
        timestamp,
        blocks: [{ type: 'markdown', value: normalized.markdown }],
      });
      if (normalizedRole === 'user') {
        user += 1;
      } else {
        assistant += 1;
      }
    }

    if (parentMismatches > 0) {
      throw new Error(`ChatGPT Shared: linear_conversation содержит ${parentMismatches} разрывов parent-chain.`);
    }

    const lastNodeId = typeof linear[linear.length - 1]?.id === 'string'
      ? linear[linear.length - 1].id
      : null;
    if (typeof currentNode === 'string' && currentNode && lastNodeId && currentNode !== lastNodeId) {
      throw new Error(`ChatGPT Shared: current_node=${currentNode} не совпадает с последним raw node=${lastNodeId}.`);
    }

    if (messages.length === 0) {
      throw new Error('ChatGPT Shared: после фильтрации не осталось сообщений transcript.');
    }

    const mappingNodes = Number.isInteger(mappingRef) ? resolver.countObjectEntries(mappingRef) : null;

    return {
      schemaVersion: 1,
      title: typeof title === 'string' ? title : null,
      conversationId: typeof conversationId === 'string' ? conversationId : null,
      sharedConversationId: typeof sharedConversationId === 'string' ? sharedConversationId : null,
      createTime: normalizeTimestamp(createTime),
      updateTime: normalizeTimestamp(updateTime),
      currentNode: typeof currentNode === 'string' ? currentNode : null,
      lastNodeId,
      rawNodes: linear.length,
      mappingNodes,
      chainComplete: parentMismatches === 0,
      uniqueRawNodeIds: seenNodeIds.size,
      messages,
      stats: {
        total: messages.length,
        user,
        assistant,
        other: 0,
        nodesWithoutMessage,
        hiddenSkipped,
        internalSkipped,
        unsupportedVisible,
        unsupportedContentTypes: [...unsupportedContentTypes].sort(),
        multimodalUserMessages,
        attachmentCount,
        attachmentMessages,
        generatedFileCards,
        generatedFileCardsMoved,
        targetedReplyEnvelopesNormalized,
        assistantPreambleCandidates,
        assistantPreambleFallbacksIncluded,
        assistantPreamblesSuppressedByFinal,
        timestampedMessages,
        missingTimestampMessages,
        references: referenceTotals,
      },
    };
  }

  function parseDocumentBody(body, options = {}) {
    const html = String(body || '');
    if (!html) {
      throw new Error('ChatGPT Shared: пустой Document response.');
    }

    const tables = extractCandidateTables(html);
    if (tables.length === 0) {
      throw new Error('ChatGPT Shared: в Document response не найден React Router stream с shared conversation.');
    }

    let lastError = null;
    for (const table of tables) {
      try {
        const snapshot = parseTable(table, options);
        return {
          ...snapshot,
          transport: {
            wireFormat: 'html-react-router-stream',
            tableEntries: table.length,
            candidateTables: tables.length,
          },
        };
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('ChatGPT Shared: React Router stream найден, но conversation snapshot не разобран.');
  }

  globalThis.__chatContextExporterShareWireParser = Object.freeze({
    parseDocumentBody,
  });
})();
