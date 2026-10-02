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

  function buildDiagnostics(snapshot, passStats) {
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
          },
        },
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

    getNetworkCaptureConfig() {
      return captureConfig();
    },

    parseNetworkCaptures(captures) {
      const passSnapshots = buildAllPassSnapshots(captures);
      const selected = passSnapshots[passSnapshots.length - 1];
      const conversationIds = new Set(passSnapshots.map((snapshot) => snapshot.conversationId).filter(Boolean));
      if (conversationIds.size > 1) {
        throw new Error(`ChatGPT Thread: проходы относятся к разным разговорам (${[...conversationIds].join(' / ')}).`);
      }

      const passStats = buildPassStats(passSnapshots);
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
        diagnostics: buildDiagnostics(selected, passStats),
      };
    },
  });
})();
