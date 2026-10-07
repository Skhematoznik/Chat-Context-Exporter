(() => {
  'use strict';

  const app = globalThis.__chatContextExporter;
  if (!app) {
    throw new Error('Chat Context Exporter: namespace is not initialized.');
  }

  const profiles = app.modules.chatGptProfiles || (app.modules.chatGptProfiles = Object.create(null));
  const SELECTORS = Object.freeze({
    scroller: '[data-app-action-timeline-scroll].thread-scroll-container',
    conversation: '[data-chatgpt-conversation-selection-target="true"][data-thread-find-target="conversation"]',
  });

  function getConversationId() {
    const match = location.pathname.match(/(?:^|\/)c\/([^/?#]+)(?:\/)?$/i);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function findScroller() {
    const candidates = [...document.querySelectorAll(SELECTORS.scroller)];
    return candidates.find((element) => (
      element instanceof HTMLElement
      && element.querySelector(SELECTORS.conversation)
    )) || candidates.find((element) => element instanceof HTMLElement) || null;
  }

  function captureConfig() {
    const conversationId = getConversationId();
    if (!conversationId) {
      return null;
    }

    const id = escapeRegExp(conversationId);
    return {
      urlPattern: `^https://chatgpt\\.com/backend-api/conversations/${id}(?:/messages)?(?:[?#].*)?$`,
      method: 'GET',
      resourceType: null,
      timeoutMs: 180_000,
      responseProcessor: 'chatgpt-thread-json',
      expectedConversationId: conversationId,
      paginationMode: 'scroll-up-until-start',
    };
  }

  const LIMIT_ALERT_PATTERNS = Object.freeze([
    /достигли максимальной длины (?:этого )?обсуждения/i,
    /reached (?:the )?maximum length (?:for|of) (?:this|the) (?:conversation|discussion)/i,
  ]);

  function normalizeDomText(value) {
    return String(value ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\u200b-\u200d\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function hashString(value) {
    let hash = 2166136261;
    const text = String(value ?? '');
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function findConversationLimitAlert() {
    const alerts = [...document.querySelectorAll('aside[role="alert"]')];
    for (let index = alerts.length - 1; index >= 0; index -= 1) {
      const alert = alerts[index];
      const text = normalizeDomText(alert.textContent);
      if (text && LIMIT_ALERT_PATTERNS.some((pattern) => pattern.test(text))) {
        return alert;
      }
    }
    return null;
  }

  function renderDomElementMarkdown(element) {
    const richTextParser = app.modules.richTextParser;
    const markdownExporter = app.modules.markdownExporter;
    if (!richTextParser?.parseHtml || !markdownExporter?.renderBlocks) {
      throw new Error('ChatGPT Thread: DOM Markdown serializer недоступен.');
    }

    const clone = element.cloneNode(true);
    for (const excluded of clone.querySelectorAll('[data-markdown-copy="exclude"]')) {
      excluded.remove();
    }
    const blocks = richTextParser.parseHtml(clone.innerHTML, {
      baseUrl: window.location.href,
    });
    return markdownExporter.renderBlocks(blocks).trim();
  }

  function isSearchUnitRole(element, role) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    const keys = [
      element.getAttribute('data-chatgpt-search-unit-key'),
      element.getAttribute('data-content-search-unit-key'),
    ];
    return keys.some((key) => typeof key === 'string' && key.toLowerCase().endsWith(`:${role}`));
  }

  function findLastUserPresentationRoot(turn) {
    const bubble = turn.querySelector('[data-user-message-bubble="true"]');
    if (bubble instanceof HTMLElement) {
      return { element: bubble, mode: 'user-message-bubble' };
    }

    const candidates = [...turn.querySelectorAll(
      '[data-chatgpt-search-unit-key], [data-content-search-unit-key]',
    )].filter((element) => (
      element instanceof HTMLElement
      && isSearchUnitRole(element, 'user')
      && (normalizeDomText(element.textContent) || element.querySelector('[data-file-reference="true"], img, video'))
    ));
    const element = candidates[candidates.length - 1] || null;
    return element instanceof HTMLElement
      ? { element, mode: 'search-unit-user' }
      : null;
  }

  function findAssistantPresentationRoots(turn, userRoot) {
    const candidates = [...turn.querySelectorAll('[data-markdown-text-style="assistant-message"]')]
      .filter((element) => (
        element instanceof HTMLElement
        && !userRoot?.contains?.(element)
        && !element.closest('[data-markdown-copy="exclude"]')
        && normalizeDomText(element.textContent)
      ));
    const primary = candidates.filter((element) => (
      element.getAttribute('data-markdown-text-tone') === 'primary'
    ));
    if (primary.length) {
      return { roots: primary, mode: 'tone-primary' };
    }

    const assistantScoped = candidates.filter((element) => {
      const unit = element.closest('[data-chatgpt-search-unit-key], [data-content-search-unit-key]');
      return isSearchUnitRole(unit, 'assistant');
    });
    if (assistantScoped.length) {
      return { roots: assistantScoped, mode: 'search-unit-assistant' };
    }

    return { roots: candidates, mode: candidates.length ? 'assistant-style-fallback' : 'none' };
  }

  function resolveUserMessageId(turn, userRoot) {
    const candidates = [
      userRoot?.closest?.('[data-chatgpt-search-message-ids]'),
      userRoot?.querySelector?.('[data-chatgpt-search-message-ids]'),
      turn?.querySelector?.('[data-chatgpt-search-unit-key$=":user"][data-chatgpt-search-message-ids]'),
      turn?.querySelector?.('[data-content-search-unit-key$=":user"][data-chatgpt-search-message-ids]'),
    ];

    for (const candidate of candidates) {
      const raw = candidate?.getAttribute?.('data-chatgpt-search-message-ids');
      if (!raw) {
        continue;
      }
      const first = raw.split(/[\s,]+/).map((item) => item.trim()).find(Boolean);
      if (first) {
        return first;
      }
    }
    return null;
  }

  function capturePreReloadTailSnapshot() {
    const limitAlert = findConversationLimitAlert();
    if (!limitAlert) {
      return null;
    }

    const conversationId = getConversationId();
    if (!conversationId) {
      throw new Error('ChatGPT Thread: обнаружена плашка лимита, но conversation id не определен. Перезагрузка отменена.');
    }

    const turns = [...document.querySelectorAll('[data-turn-key]')];
    const turn = limitAlert.closest('[data-turn-key]') || turns[turns.length - 1] || null;
    if (!(turn instanceof HTMLElement)) {
      throw new Error('ChatGPT Thread: обнаружена плашка лимита, но последний turn не найден. Перезагрузка отменена.');
    }

    const userPresentation = findLastUserPresentationRoot(turn);
    const userRoot = userPresentation?.element || null;
    if (!(userRoot instanceof HTMLElement)) {
      throw new Error('ChatGPT Thread: обнаружена плашка лимита, но последнее сообщение пользователя не найдено. Перезагрузка отменена.');
    }

    const assistantPresentation = findAssistantPresentationRoots(turn, userRoot);
    const assistantRoots = assistantPresentation.roots;
    const assistantRoot = assistantRoots[assistantRoots.length - 1] || null;
    if (!(assistantRoot instanceof HTMLElement)) {
      throw new Error('ChatGPT Thread: обнаружена плашка лимита, но последний видимый ответ ассистента не найден. Перезагрузка отменена.');
    }

    const userMarkdown = renderDomElementMarkdown(userRoot);
    const assistantMarkdown = renderDomElementMarkdown(assistantRoot);
    const userText = normalizeDomText(userRoot.textContent);
    const assistantText = normalizeDomText(assistantRoot.textContent);
    if (!userMarkdown || !userText || !assistantMarkdown || !assistantText) {
      throw new Error('ChatGPT Thread: плашка лимита найдена, но DOM-tail не удалось сериализовать полностью. Перезагрузка отменена.');
    }

    const turnKey = normalizeDomText(turn.getAttribute('data-turn-key')) || null;
    const userMessageId = resolveUserMessageId(turn, userRoot);
    return {
      schemaVersion: 1,
      source: 'pre-reload-limit-dom',
      reason: 'conversation-limit',
      authoritative: true,
      conversationId,
      capturedAt: new Date().toISOString(),
      user: {
        turnKey,
        messageId: userMessageId,
        markdown: userMarkdown,
        normalizedText: userText,
        hash: hashString(userText),
        captureMode: userPresentation.mode,
      },
      assistant: {
        markdown: assistantMarkdown,
        normalizedText: assistantText,
        hash: hashString(assistantMarkdown),
        primaryCandidates: assistantRoots.length,
        captureMode: assistantPresentation.mode,
      },
    };
  }

  function messageMarkdownText(message) {
    return (Array.isArray(message?.blocks) ? message.blocks : [])
      .map((block) => block?.type === 'markdown' ? String(block.value || '') : '')
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }

  function normalizeAnchorMarkdown(value) {
    return normalizeDomText(String(value ?? '')
      .replace(/\\([\\`*_\[\]<>~#+.!-])/g, '$1'));
  }

  function applyPreReloadTailOverride(snapshot, preReloadTailSnapshot) {
    const tail = preReloadTailSnapshot && typeof preReloadTailSnapshot === 'object'
      ? preReloadTailSnapshot
      : null;
    const diagnostics = {
      captured: Boolean(tail),
      userMatched: false,
      matchMethod: null,
      applied: false,
      reason: tail ? 'not-matched' : 'not-captured',
      networkAssistantMessagesRemoved: 0,
      networkAssistantChars: 0,
      domAssistantChars: tail?.assistant?.markdown?.length || 0,
      domAssistantHash: tail?.assistant?.hash || null,
    };

    if (!tail) {
      return { snapshot, diagnostics };
    }
    if (tail.authoritative !== true || tail.reason !== 'conversation-limit') {
      diagnostics.reason = 'invalid-tail-contract';
      return { snapshot, diagnostics };
    }
    if (tail.conversationId && snapshot.conversationId && tail.conversationId !== snapshot.conversationId) {
      diagnostics.reason = 'conversation-mismatch';
      return { snapshot, diagnostics };
    }
    const domAssistantMarkdown = String(tail?.assistant?.markdown || '').trim();
    if (!domAssistantMarkdown) {
      diagnostics.reason = 'empty-dom-assistant';
      return { snapshot, diagnostics };
    }

    const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    const lastUserIndex = messages.findLastIndex((message) => message?.role === 'user');
    if (lastUserIndex < 0) {
      diagnostics.reason = 'network-user-missing';
      return { snapshot, diagnostics };
    }

    const expectedUserId = typeof tail?.user?.messageId === 'string' && tail.user.messageId.trim()
      ? tail.user.messageId.trim()
      : null;
    let anchorIndex = -1;
    if (expectedUserId) {
      anchorIndex = messages.findIndex((message) => message?.role === 'user' && message?.id === expectedUserId);
      if (anchorIndex >= 0) {
        diagnostics.matchMethod = 'message-id';
      }
    }

    if (anchorIndex < 0) {
      const expectedTurnKey = typeof tail?.user?.turnKey === 'string' && tail.user.turnKey.trim()
        ? tail.user.turnKey.trim()
        : null;
      if (expectedTurnKey) {
        anchorIndex = messages.findIndex((message) => message?.role === 'user' && message?.id === expectedTurnKey);
        if (anchorIndex >= 0) {
          diagnostics.matchMethod = 'turn-key';
        }
      }
    }

    if (anchorIndex < 0) {
      const expectedText = normalizeAnchorMarkdown(tail?.user?.markdown || tail?.user?.normalizedText || '');
      if (expectedText) {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index];
          if (message?.role !== 'user') {
            continue;
          }
          if (normalizeAnchorMarkdown(messageMarkdownText(message)) === expectedText) {
            anchorIndex = index;
            diagnostics.matchMethod = 'normalized-user-text';
            break;
          }
        }
      }
    }

    if (anchorIndex < 0) {
      diagnostics.reason = 'user-anchor-not-found';
      return { snapshot, diagnostics };
    }
    if (anchorIndex !== lastUserIndex) {
      diagnostics.reason = 'user-anchor-is-not-last-user';
      return { snapshot, diagnostics };
    }

    diagnostics.userMatched = true;
    const tailMessages = messages.slice(anchorIndex + 1);
    if (tailMessages.some((message) => message?.role === 'user')) {
      diagnostics.reason = 'unexpected-user-after-anchor';
      return { snapshot, diagnostics };
    }

    const removedAssistants = tailMessages.filter((message) => message?.role === 'assistant');
    diagnostics.networkAssistantMessagesRemoved = removedAssistants.length;
    diagnostics.networkAssistantChars = removedAssistants.reduce(
      (sum, message) => sum + messageMarkdownText(message).length,
      0,
    );
    const preservedTimestamp = [...removedAssistants]
      .reverse()
      .map((message) => message?.timestamp || null)
      .find(Boolean) || null;
    const anchorMessage = messages[anchorIndex];
    const assistantIdBase = expectedUserId || tail?.user?.turnKey || anchorMessage?.id || 'tail';
    const domAssistantMessage = {
      id: `dom-tail:${assistantIdBase}`,
      role: 'assistant',
      timestamp: preservedTimestamp,
      blocks: [{ type: 'markdown', value: domAssistantMarkdown }],
    };
    const resolvedMessages = [
      ...messages.slice(0, anchorIndex + 1),
      domAssistantMessage,
    ];
    const stats = {
      ...(snapshot.stats || {}),
      total: resolvedMessages.length,
      user: resolvedMessages.filter((message) => message.role === 'user').length,
      assistant: resolvedMessages.filter((message) => message.role === 'assistant').length,
      other: 0,
      timestampedMessages: resolvedMessages.filter((message) => Boolean(message.timestamp)).length,
      missingTimestampMessages: resolvedMessages.filter((message) => !message.timestamp).length,
      limitTailCaptured: true,
      limitTailUserMatched: true,
      limitTailMatchMethod: diagnostics.matchMethod,
      networkTailAssistantMessagesRemoved: diagnostics.networkAssistantMessagesRemoved,
      domTailAssistantApplied: true,
    };

    diagnostics.applied = true;
    diagnostics.reason = 'authoritative-dom-tail';
    return {
      snapshot: {
        ...snapshot,
        messages: resolvedMessages,
        stats,
      },
      diagnostics,
    };
  }

  function messageFingerprint(message) {
    return JSON.stringify([
      message?.role || null,
      message?.timestamp || null,
      Array.isArray(message?.blocks) ? message.blocks : [],
    ]);
  }

  function aggregateReferenceStats(pages) {
    const totals = {
      total: 0,
      groupedWebpages: 0,
      file: 0,
      followup: 0,
      hidden: 0,
      sourcesFootnote: 0,
      other: 0,
      unresolvedMarkersRemoved: 0,
    };
    for (const page of pages) {
      const refs = page?.stats?.references || {};
      for (const key of Object.keys(totals)) {
        totals[key] += Number(refs[key]) || 0;
      }
    }
    return totals;
  }

  function buildPassSnapshot(pass, captures) {
    const pages = captures
      .filter((capture) => Number(capture?.pass) === pass && capture?.processed?.pageInfo)
      .sort((left, right) => Number(left.pageSequence || 0) - Number(right.pageSequence || 0));

    if (pages.length === 0) {
      throw new Error(`ChatGPT Thread: проход ${pass} не содержит разобранных страниц.`);
    }

    const firstPage = pages[0];
    const lastPage = pages[pages.length - 1];
    if (firstPage.processed.pageInfo.hasNextPage !== false) {
      throw new Error(`ChatGPT Thread: проход ${pass} начался не с конца разговора (has_next_page != false).`);
    }
    if (lastPage.processed.pageInfo.hasPreviousPage !== false) {
      throw new Error(`ChatGPT Thread: проход ${pass} завершился до начала разговора (has_previous_page != false).`);
    }

    let cursorChainComplete = true;
    for (let index = 1; index < pages.length; index += 1) {
      const newer = pages[index - 1];
      const older = pages[index];
      const expectedBefore = newer.processed.pageInfo.startCursor;
      if (!expectedBefore || older.requestBefore !== expectedBefore) {
        cursorChainComplete = false;
        break;
      }
    }
    if (!cursorChainComplete) {
      throw new Error(`ChatGPT Thread: проход ${pass} содержит разрыв cursor-chain.`);
    }

    const orderedIds = [];
    const byId = new Map();
    let rawMessages = 0;
    let hiddenSkipped = 0;
    let internalSkipped = 0;
    let unsupportedVisible = 0;
    let malformed = 0;
    let multimodalUserMessages = 0;
    let attachmentMessages = 0;
    let attachmentCount = 0;
    let generatedFileCards = 0;
    let generatedFileCardsMoved = 0;
    let targetedReplyEnvelopesNormalized = 0;
    let assistantPreambleCandidates = 0;
    let assistantPreambleFallbacksPageIncluded = 0;
    let assistantPreamblesSuppressedByFinal = 0;
    let timestampedMessages = 0;
    let missingTimestampMessages = 0;
    const unsupportedContentTypes = new Set();

    // Network pages arrive newest -> oldest. Reverse them for transcript order.
    for (const capture of [...pages].reverse()) {
      const page = capture.processed;
      rawMessages += Number(page.rawMessages) || 0;
      hiddenSkipped += Number(page.stats?.hiddenSkipped) || 0;
      internalSkipped += Number(page.stats?.internalSkipped) || 0;
      unsupportedVisible += Number(page.stats?.unsupportedVisible) || 0;
      malformed += Number(page.stats?.malformed) || 0;
      multimodalUserMessages += Number(page.stats?.multimodalUserMessages) || 0;
      attachmentMessages += Number(page.stats?.attachmentMessages) || 0;
      attachmentCount += Number(page.stats?.attachmentCount) || 0;
      generatedFileCards += Number(page.stats?.generatedFileCards) || 0;
      generatedFileCardsMoved += Number(page.stats?.generatedFileCardsMoved) || 0;
      targetedReplyEnvelopesNormalized += Number(page.stats?.targetedReplyEnvelopesNormalized) || 0;
      assistantPreambleCandidates += Number(page.stats?.assistantPreambleCandidates) || 0;
      assistantPreambleFallbacksPageIncluded += Number(page.stats?.assistantPreambleFallbacksIncluded) || 0;
      assistantPreamblesSuppressedByFinal += Number(page.stats?.assistantPreamblesSuppressedByFinal) || 0;
      timestampedMessages += Number(page.stats?.timestampedMessages) || 0;
      missingTimestampMessages += Number(page.stats?.missingTimestampMessages) || 0;
      for (const contentType of page.stats?.unsupportedContentTypes || []) {
        unsupportedContentTypes.add(contentType);
      }

      for (const message of page.messages || []) {
        const id = typeof message?.id === 'string' ? message.id : '';
        if (!id) {
          malformed += 1;
          continue;
        }
        const fingerprint = messageFingerprint(message);
        const existing = byId.get(id);
        if (!existing) {
          orderedIds.push(id);
          byId.set(id, { message, fingerprint });
        } else if (existing.fingerprint !== fingerprint) {
          byId.set(id, { message, fingerprint });
        }
      }
    }

    const mergedMessages = orderedIds.map((id) => byId.get(id).message);
    const finalTurnExchangeIds = new Set(
      mergedMessages
        .filter((message) => message?._chatgpt?.assistantVariant === 'final'
          && typeof message?._chatgpt?.turnExchangeId === 'string'
          && message._chatgpt.turnExchangeId)
        .map((message) => message._chatgpt.turnExchangeId),
    );
    let crossPagePreamblesSuppressed = 0;
    const resolvedMessages = mergedMessages.filter((message) => {
      if (message?._chatgpt?.assistantVariant !== 'preamble-fallback') {
        return true;
      }
      const exchangeId = message?._chatgpt?.turnExchangeId;
      if (exchangeId && finalTurnExchangeIds.has(exchangeId)) {
        crossPagePreamblesSuppressed += 1;
        return false;
      }
      return true;
    });
    assistantPreamblesSuppressedByFinal += crossPagePreamblesSuppressed;
    const assistantPreambleFallbacksIncluded = resolvedMessages.filter(
      (message) => message?._chatgpt?.assistantVariant === 'preamble-fallback',
    ).length;
    const messages = resolvedMessages.map((message) => {
      const { _chatgpt, ...clean } = message || {};
      return clean;
    });
    const user = messages.filter((message) => message.role === 'user').length;
    const assistant = messages.filter((message) => message.role === 'assistant').length;
    const metadataSource = pages.find((capture) => capture.processed.title || capture.processed.createTime)?.processed
      || firstPage.processed;

    return {
      pass,
      pages,
      pageCount: pages.length,
      conversationId: metadataSource.conversationId || firstPage.processed.conversationId || null,
      title: metadataSource.title || null,
      createTime: metadataSource.createTime || null,
      updateTime: metadataSource.updateTime || null,
      currentNode: metadataSource.currentNode || null,
      startCursor: lastPage.processed.pageInfo.startCursor || null,
      endCursor: firstPage.processed.pageInfo.endCursor || null,
      startReached: lastPage.processed.pageInfo.hasPreviousPage === false,
      tailReached: firstPage.processed.pageInfo.hasNextPage === false,
      cursorChainComplete,
      rawMessages,
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
        attachmentMessages,
        attachmentCount,
        generatedFileCards,
        generatedFileCardsMoved,
        targetedReplyEnvelopesNormalized,
        assistantPreambleCandidates,
        assistantPreambleFallbacksPageIncluded,
        assistantPreambleFallbacksIncluded,
        assistantPreamblesSuppressedByFinal,
        timestampedMessages,
        missingTimestampMessages,
        references: aggregateReferenceStats(pages.map((capture) => capture.processed)),
      },
    };
  }

  function buildAllPassSnapshots(captures) {
    const passNumbers = [...new Set(
      (captures || [])
        .filter((capture) => capture?.processed?.pageInfo)
        .map((capture) => Number(capture.pass))
        .filter((pass) => Number.isInteger(pass) && pass > 0),
    )].sort((left, right) => left - right);

    if (passNumbers.length === 0) {
      throw new Error('ChatGPT Thread: сетевой capture не содержит JSON-страниц разговора.');
    }

    return passNumbers.map((pass) => buildPassSnapshot(pass, captures));
  }

  function buildPassStats(passSnapshots) {
    const seen = new Map();
    const stats = [];

    for (const snapshot of passSnapshots) {
      const passStats = {
        pass: snapshot.pass,
        received: snapshot.messages.length,
        added: 0,
        updated: 0,
        duplicates: 0,
        malformed: 0,
        totalAfterPass: 0,
        rawNodes: snapshot.rawMessages,
        pages: snapshot.pageCount,
      };

      for (const message of snapshot.messages) {
        const id = typeof message?.id === 'string' ? message.id : '';
        if (!id) {
          passStats.malformed += 1;
          continue;
        }
        const fingerprint = messageFingerprint(message);
        const previous = seen.get(id);
        if (!previous) {
          seen.set(id, fingerprint);
          passStats.added += 1;
        } else if (previous !== fingerprint) {
          seen.set(id, fingerprint);
          passStats.updated += 1;
        } else {
          passStats.duplicates += 1;
        }
      }

      passStats.totalAfterPass = seen.size;
      stats.push(passStats);
    }

    return stats;
  }

  function buildDiagnostics(snapshot, passStats, tailDiagnostics = null) {
    const stats = snapshot.stats || {};
    const references = stats.references || {};
    return {
      sourceMessages: snapshot.rawMessages,
      uniqueMessageIds: snapshot.messages.length,
      passStats,
      logEntries: [
        {
          event: 'CHATGPT_THREAD_SNAPSHOT_STATUS',
          details: {
            selectedPass: snapshot.pass,
            wireFormat: 'json-paginated-conversation',
            pages: snapshot.pageCount,
            conversationId: snapshot.conversationId,
            startCursor: snapshot.startCursor,
            endCursor: snapshot.endCursor,
            startReached: snapshot.startReached,
            tailReached: snapshot.tailReached,
            cursorChainComplete: snapshot.cursorChainComplete,
            rawMessages: snapshot.rawMessages,
            messages: stats.total,
            user: stats.user,
            assistant: stats.assistant,
            malformed: stats.malformed,
            hiddenSkipped: stats.hiddenSkipped,
            internalSkipped: stats.internalSkipped,
            unsupportedVisible: stats.unsupportedVisible,
            unsupportedContentTypes: stats.unsupportedContentTypes || [],
            multimodalUserMessages: stats.multimodalUserMessages,
            attachmentMessages: stats.attachmentMessages,
            attachmentCount: stats.attachmentCount,
            generatedFileCards: stats.generatedFileCards,
            generatedFileCardsMoved: stats.generatedFileCardsMoved,
            targetedReplyEnvelopesNormalized: stats.targetedReplyEnvelopesNormalized,
            assistantPreambleCandidates: stats.assistantPreambleCandidates,
            assistantPreambleFallbacksIncluded: stats.assistantPreambleFallbacksIncluded,
            assistantPreamblesSuppressedByFinal: stats.assistantPreamblesSuppressedByFinal,
            timestampedMessages: stats.timestampedMessages,
            missingTimestampMessages: stats.missingTimestampMessages,
            limitTailCaptured: Boolean(tailDiagnostics?.captured),
            limitTailUserMatched: Boolean(tailDiagnostics?.userMatched),
            limitTailMatchMethod: tailDiagnostics?.matchMethod || null,
            networkTailAssistantMessagesRemoved: tailDiagnostics?.networkAssistantMessagesRemoved || 0,
            domTailAssistantApplied: Boolean(tailDiagnostics?.applied),
          },
        },
        ...(tailDiagnostics?.captured ? [{
          event: 'CHATGPT_LIMIT_TAIL_USER_MATCHED',
          details: {
            matched: Boolean(tailDiagnostics.userMatched),
            matchMethod: tailDiagnostics.matchMethod || null,
            reason: tailDiagnostics.reason || null,
          },
        }, {
          event: 'CHATGPT_LIMIT_TAIL_NETWORK_OBSERVED',
          details: {
            assistantMessages: tailDiagnostics.networkAssistantMessagesRemoved || 0,
            assistantChars: tailDiagnostics.networkAssistantChars || 0,
          },
        }, {
          event: 'CHATGPT_LIMIT_TAIL_OVERRIDE_APPLIED',
          details: {
            applied: Boolean(tailDiagnostics.applied),
            source: tailDiagnostics.applied ? 'pre-reload-dom' : null,
            assistantChars: tailDiagnostics.domAssistantChars || 0,
            assistantHash: tailDiagnostics.domAssistantHash || null,
            networkAssistantMessagesRemoved: tailDiagnostics.networkAssistantMessagesRemoved || 0,
            reason: tailDiagnostics.reason || null,
          },
        }] : []),
        {
          event: 'CHATGPT_THREAD_REFERENCE_STATUS',
          details: {
            total: references.total ?? 0,
            groupedWebpages: references.groupedWebpages ?? 0,
            file: references.file ?? 0,
            followup: references.followup ?? 0,
            hidden: references.hidden ?? 0,
            sourcesFootnote: references.sourcesFootnote ?? 0,
            other: references.other ?? 0,
            unresolvedMarkersRemoved: references.unresolvedMarkersRemoved ?? 0,
          },
        },
      ],
    };
  }

  profiles.thread = Object.freeze({
    id: 'thread',
    variant: 'authenticated-thread',
    acquisitionMode: 'network',
    parseEvent: 'CHATGPT_THREAD_PARSED',
    supportsMessageCollection: true,
    scrollMode: 'reverse',
    scrollerLabel: 'ChatGPT transcript',
    selectors: SELECTORS,
    panelFields: Object.freeze({
      iteration: true,
      position: true,
    }),

    detect() {
      if (location.hostname !== 'chatgpt.com' || !getConversationId()) {
        return 0;
      }
      let score = 70;
      if (document.querySelector(SELECTORS.scroller)) score += 20;
      if (document.querySelector(SELECTORS.conversation)) score += 10;
      return score;
    },

    findScroller,

    capturePreReloadTailSnapshot,

    getNetworkCaptureConfig() {
      return captureConfig();
    },

    parseNetworkCaptures(captures, options = {}) {
      const passSnapshots = buildAllPassSnapshots(captures);
      const networkSelected = passSnapshots[passSnapshots.length - 1];
      const conversationIds = new Set(passSnapshots.map((snapshot) => snapshot.conversationId).filter(Boolean));
      if (conversationIds.size > 1) {
        throw new Error(`ChatGPT Thread: проходы относятся к разным разговорам (${[...conversationIds].join(' / ')}).`);
      }

      const passStats = buildPassStats(passSnapshots);
      const tailResult = applyPreReloadTailOverride(networkSelected, options.preReloadTailSnapshot || null);
      const selected = tailResult.snapshot;
      const stats = selected.stats;
      const startedAt = selected.createTime || selected.messages.find((message) => message.timestamp)?.timestamp || null;

      return {
        conversation: {
          title: selected.title || document.title || null,
          startedAt,
          messages: selected.messages,
        },
        stats: {
          total: stats.total,
          user: stats.user,
          assistant: stats.assistant,
          other: 0,
        },
        diagnostics: buildDiagnostics(selected, passStats, tailResult.diagnostics),
      };
    },
  });
})();
