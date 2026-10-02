(() => {
  'use strict';

  const INTERNAL_MARKER_RE = /\uE200[^\uE201]*\uE201/g;

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

    return lines.length > 0 ? `**Вложения:**\n${lines.join('\n')}` : '';
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
      if (type === 'grouped_webpages') stats.groupedWebpages += 1;
      else if (type === 'file') stats.file += 1;
      else if (type === 'followup_a') stats.followup += 1;
      else if (type === 'hidden') stats.hidden += 1;
      else if (type === 'sources_footnote') stats.sourcesFootnote += 1;
      else stats.other += 1;
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
      if (type === 'grouped_webpages') replacement = groupedWebReferenceReplacement(reference);
      else if (type === 'file') replacement = formatFileReference(reference);
      else if (type === 'hidden') replacement = '';
      else if (type === 'sources_footnote') replacement = typeof reference?.matched_text === 'string' ? reference.matched_text : '';
      else continue;

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

    return { markdown: output.trim(), stats };
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
    if (targetedReply.markdown) parts.push(targetedReply.markdown);
    if (attachmentMarkdown) parts.push(attachmentMarkdown);
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

  function parsePageBody(body, { expectedConversationId = null } = {}) {
    const text = String(body || '');
    if (!text) {
      throw new Error('ChatGPT Thread: пустой JSON response.');
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('ChatGPT Thread: response не является корректным JSON.');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('ChatGPT Thread: корневой JSON должен быть объектом.');
    }

    const conversationId = typeof payload.conversation_id === 'string' ? payload.conversation_id : null;
    if (expectedConversationId && conversationId && conversationId !== expectedConversationId) {
      throw new Error(`ChatGPT Thread: conversation_id=${conversationId} не совпадает с URL ${expectedConversationId}.`);
    }

    const rawMessages = Array.isArray(payload.messages) ? payload.messages : null;
    if (!rawMessages) {
      throw new Error('ChatGPT Thread: messages[] отсутствует.');
    }

    const pageInfo = payload.page_info;
    if (!pageInfo || typeof pageInfo !== 'object') {
      throw new Error('ChatGPT Thread: page_info отсутствует.');
    }
    if (typeof pageInfo.has_previous_page !== 'boolean' || typeof pageInfo.has_next_page !== 'boolean') {
      throw new Error('ChatGPT Thread: page_info не содержит boolean has_previous_page/has_next_page.');
    }

    const startCursor = typeof pageInfo.start_cursor === 'string' ? pageInfo.start_cursor : null;
    const endCursor = typeof pageInfo.end_cursor === 'string' ? pageInfo.end_cursor : null;
    const finalAssistantTurnExchangeIds = new Set();
    for (const candidate of rawMessages) {
      if (candidate?.metadata?.is_visually_hidden_from_conversation === true) {
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
    if (rawMessages.length > 0) {
      const firstId = typeof rawMessages[0]?.id === 'string' ? rawMessages[0].id : null;
      const lastId = typeof rawMessages[rawMessages.length - 1]?.id === 'string'
        ? rawMessages[rawMessages.length - 1].id
        : null;
      if (!startCursor || startCursor !== firstId) {
        throw new Error(`ChatGPT Thread: start_cursor не совпадает с первым message id (${String(startCursor)} / ${String(firstId)}).`);
      }
      if (!endCursor || endCursor !== lastId) {
        throw new Error(`ChatGPT Thread: end_cursor не совпадает с последним message id (${String(endCursor)} / ${String(lastId)}).`);
      }
    }

    let hiddenSkipped = 0;
    let internalSkipped = 0;
    let unsupportedVisible = 0;
    let malformed = 0;
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
    const unsupportedContentTypes = new Set();
    const seenRawIds = new Set();
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

    for (const rawMessage of rawMessages) {
      const id = typeof rawMessage?.id === 'string' ? rawMessage.id : '';
      if (!id) {
        malformed += 1;
        continue;
      }
      if (seenRawIds.has(id)) {
        throw new Error(`ChatGPT Thread: повтор message id=${id} внутри одной страницы.`);
      }
      seenRawIds.add(id);

      const metadata = rawMessage.metadata && typeof rawMessage.metadata === 'object'
        ? rawMessage.metadata
        : {};
      if (metadata.is_visually_hidden_from_conversation === true) {
        hiddenSkipped += 1;
        continue;
      }

      const role = rawMessage?.author?.role;
      const recipient = rawMessage?.recipient;
      const turnExchangeId = getTurnExchangeId(rawMessage);
      const isUser = role === 'user' && recipient === 'all';
      const isAssistantFinal = role === 'assistant' && recipient === 'all' && rawMessage?.channel === 'final';
      const isAssistantPreamble = isAssistantPreambleMessage(rawMessage);
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

      const contentType = typeof rawMessage?.content?.content_type === 'string'
        ? rawMessage.content.content_type
        : '';
      const supported = isUser
        ? contentType === 'text' || contentType === 'multimodal_text'
        : contentType === 'text';
      if (!supported) {
        unsupportedVisible += 1;
        unsupportedContentTypes.add(contentType || '(unknown)');
        continue;
      }

      const normalized = messageMarkdown(rawMessage);
      if (!normalized.markdown) {
        unsupportedVisible += 1;
        unsupportedContentTypes.add(`${contentType || '(unknown)'}:empty`);
        continue;
      }

      const timestamp = normalizeTimestamp(rawMessage.create_time);
      if (timestamp) timestampedMessages += 1;
      else missingTimestampMessages += 1;

      attachmentCount += normalized.attachmentCount;
      if (normalized.attachmentCount > 0) attachmentMessages += 1;
      generatedFileCards += normalized.generatedFileCards || 0;
      generatedFileCardsMoved += normalized.generatedFileCardsMoved || 0;
      targetedReplyEnvelopesNormalized += normalized.targetedReplyEnvelopeNormalized || 0;
      if (isUser && contentType === 'multimodal_text') multimodalUserMessages += 1;
      for (const key of Object.keys(referenceTotals)) {
        referenceTotals[key] += normalized.referenceStats[key] || 0;
      }

      const normalizedRole = isUser ? 'user' : 'assistant';
      const normalizedMessage = {
        id,
        role: normalizedRole,
        timestamp,
        blocks: [{ type: 'markdown', value: normalized.markdown }],
      };
      if (!isUser) {
        normalizedMessage._chatgpt = {
          turnExchangeId,
          assistantVariant: isAssistantFinal ? 'final' : 'preamble-fallback',
        };
      }
      messages.push(normalizedMessage);
      if (normalizedRole === 'user') user += 1;
      else assistant += 1;
    }

    return {
      schemaVersion: 1,
      title: typeof payload.title === 'string' ? payload.title : null,
      conversationId: conversationId || expectedConversationId || null,
      createTime: normalizeTimestamp(payload.create_time),
      updateTime: normalizeTimestamp(payload.update_time),
      currentNode: typeof payload.current_node === 'string' ? payload.current_node : null,
      rawMessages: rawMessages.length,
      uniqueRawMessageIds: seenRawIds.size,
      pageInfo: {
        startCursor,
        endCursor,
        hasPreviousPage: pageInfo.has_previous_page,
        hasNextPage: pageInfo.has_next_page,
      },
      messages,
      stats: {
        total: messages.length,
        user,
        assistant,
        other: 0,
        malformed,
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
      transport: {
        wireFormat: 'json-paginated-conversation',
      },
    };
  }

  globalThis.__chatContextExporterThreadWireParser = Object.freeze({
    parsePageBody,
  });
})();
