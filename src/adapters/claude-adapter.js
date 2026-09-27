(() => {
  'use strict';

  const app = globalThis.__chatContextExporter;
  const registry = app?.modules.adapterRegistry;

  if (!registry) {
    throw new Error('Chat Context Exporter: adapter registry is not initialized.');
  }

  const SELECTORS = Object.freeze({
    scroller: '[data-autoscroll-container="true"]',
    transcriptList: '[data-testid="transcript-list"]',
    transcriptSizer: '[data-testid="transcript-sizer"]',
    transcriptRow: '[data-testid="transcript-row"]',
    transcriptSpacer: '[data-testid="transcript-spacer"]',
    userMessage: '[data-testid="user-message"]',
    assistantMessage: '[data-testid="assistant-message"]',
    assistantContent: '[data-testid="assistant-message"] .standard-markdown',
    transcriptEnd: '[data-testid="transcript-end"]',
    lastMessageSentinel: '[data-testid="last-message-sentinel"]',
    jumpToLatest: '[data-testid="jump-to-latest"]',
  });

  function parseFiniteInteger(value) {
    if (!/^-?\d+$/.test(String(value ?? ''))) {
      return null;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  function getRowIndex(row) {
    if (!(row instanceof HTMLElement)) {
      return null;
    }

    return parseFiniteInteger(row.getAttribute('data-index'))
      ?? parseFiniteInteger(row.getAttribute('data-rs-index'));
  }

  function getArticle(row) {
    return row instanceof HTMLElement
      ? row.querySelector(':scope > [role="article"], [role="article"]')
      : null;
  }

  function getRoleForRow(row) {
    if (!(row instanceof HTMLElement)) {
      return null;
    }

    const perfRole = row.getAttribute('data-perf-row');
    if (perfRole === 'human') {
      return 'user';
    }
    if (perfRole === 'assistant') {
      return 'assistant';
    }

    if (row.querySelector(SELECTORS.userMessage)) {
      return 'user';
    }
    if (row.querySelector(SELECTORS.assistantMessage)) {
      return 'assistant';
    }

    return null;
  }

  function getTranscriptRows(scroller) {
    if (!(scroller instanceof HTMLElement)) {
      return [];
    }

    const transcript = scroller.querySelector(SELECTORS.transcriptList) || scroller;
    return [...transcript.querySelectorAll(SELECTORS.transcriptRow)];
  }

  function getSpacerHeights(scroller) {
    if (!(scroller instanceof HTMLElement)) {
      return [];
    }

    return [...scroller.querySelectorAll(SELECTORS.transcriptSpacer)].map((element) => {
      const raw = element instanceof HTMLElement
        ? (element.style.height || getComputedStyle(element).height || '')
        : '';
      const match = raw.match(/^(-?\d+(?:\.\d+)?)px$/i);
      return match ? Number(match[1]) : null;
    });
  }

  function hasLoadButton(scroller, direction) {
    if (!(scroller instanceof HTMLElement)) {
      return false;
    }

    const expected = direction === 'earlier' ? 'load earlier messages' : 'load later messages';
    return [...scroller.querySelectorAll('button')].some((button) => {
      const text = (button.textContent || '').trim().toLowerCase();
      return text === expected;
    });
  }

  function getRowSummary(scroller) {
    const rows = getTranscriptRows(scroller);
    const indices = [];
    const positions = [];
    const userIndices = [];
    const assistantIndices = [];
    let totalMessages = null;
    let unknownRows = 0;
    let firstMessagePresent = false;
    let lastMessagePresent = false;

    for (const row of rows) {
      const index = getRowIndex(row);
      if (index !== null) {
        indices.push(index);
      }

      const article = getArticle(row);
      const pos = parseFiniteInteger(article?.getAttribute('aria-posinset'));
      const setSize = parseFiniteInteger(article?.getAttribute('aria-setsize'));
      if (pos !== null) {
        positions.push(pos);
      }
      if (setSize !== null) {
        totalMessages = totalMessages === null ? setSize : Math.max(totalMessages, setSize);
      }

      const role = getRoleForRow(row);
      if (role === 'user') {
        if (index !== null) userIndices.push(index);
      } else if (role === 'assistant') {
        if (index !== null) assistantIndices.push(index);
      } else {
        unknownRows += 1;
      }

      if (index === 0 || pos === 1) {
        firstMessagePresent = true;
      }
      if (
        row.hasAttribute('data-last-message')
        || (pos !== null && setSize !== null && pos === setSize)
      ) {
        lastMessagePresent = true;
      }
    }

    const sorted = [...indices].sort((a, b) => a - b);
    const jumpToLatest = scroller.querySelector(SELECTORS.jumpToLatest);
    const jumpToLatestHidden = jumpToLatest instanceof HTMLElement
      ? jumpToLatest.getAttribute('aria-hidden') === 'true' || jumpToLatest.hasAttribute('inert')
      : null;

    return {
      visibleIndices: indices,
      indexFingerprint: sorted.join(','),
      minIndex: sorted.length > 0 ? sorted[0] : null,
      maxIndex: sorted.length > 0 ? sorted[sorted.length - 1] : null,
      positions,
      totalMessages,
      userRows: userIndices.length,
      assistantRows: assistantIndices.length,
      unknownRows,
      userIndices,
      assistantIndices,
      firstMessagePresent,
      lastMessagePresent,
      loadEarlierPresent: hasLoadButton(scroller, 'earlier'),
      loadLaterPresent: hasLoadButton(scroller, 'later'),
      spacerHeights: getSpacerHeights(scroller),
      transcriptEndPresent: Boolean(scroller.querySelector(SELECTORS.transcriptEnd)),
      lastMessageSentinelPresent: Boolean(scroller.querySelector(SELECTORS.lastMessageSentinel)),
      jumpToLatestHidden,
    };
  }

  function getBoundaryState(scroller, kind) {
    if (!(scroller instanceof HTMLElement)) {
      return null;
    }

    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const atBoundary = kind === 'top'
      ? scroller.scrollTop <= 2
      : Math.abs(scroller.scrollTop - maxTop) <= 2;
    const busy = scroller.getAttribute('aria-busy') === 'true';
    const summary = getRowSummary(scroller);
    const semanticMarkerPresent = kind === 'top'
      ? summary.firstMessagePresent
      : summary.lastMessagePresent;

    return {
      reached: atBoundary && semanticMarkerPresent && !busy,
      atBoundary,
      semanticMarkerPresent,
      busy,
      signature: summary.indexFingerprint || null,
      ...summary,
    };
  }

  registry.register({
    id: 'claude',
    displayName: 'Claude',
    scrollerLabel: 'Claude transcript',
    supportsMessageCollection: true,
    selectors: SELECTORS,

    detect() {
      let score = 0;

      if (location.hostname === 'claude.ai' || location.hostname.endsWith('.claude.ai')) {
        score += 50;
      }
      if (document.querySelector(SELECTORS.scroller)) {
        score += 25;
      }
      if (document.querySelector(SELECTORS.transcriptList)) {
        score += 15;
      }
      if (document.querySelector(SELECTORS.transcriptRow)) {
        score += 5;
      }
      if (document.querySelector(SELECTORS.assistantMessage)) {
        score += 5;
      }

      return score;
    },

    findScroller() {
      const candidates = [...document.querySelectorAll(SELECTORS.scroller)];
      return candidates.find((element) => (
        element instanceof HTMLElement
        && element.querySelector(SELECTORS.transcriptList)
      )) || null;
    },

    getVisibleMessages() {
      const scroller = this.findScroller();
      return getTranscriptRows(scroller).filter((row) => Boolean(getRoleForRow(row)));
    },

    getMessageId(element) {
      const index = getRowIndex(element);
      if (index !== null) {
        return `claude:${index}`;
      }

      const article = getArticle(element);
      const pos = parseFiniteInteger(article?.getAttribute('aria-posinset'));
      return pos !== null ? `claude:pos:${pos}` : null;
    },

    getMessageOrderKey(element) {
      const index = getRowIndex(element);
      if (index !== null) {
        return index;
      }

      const article = getArticle(element);
      const pos = parseFiniteInteger(article?.getAttribute('aria-posinset'));
      return pos !== null ? pos - 1 : null;
    },

    getMessageRole(element) {
      return getRoleForRow(element);
    },

    getMessageTimestamp() {
      // В Claude время присутствует в DOM message actions, но на первом этапе
      // не включаем его в экспорт до проверки стабильности на живом прогоне.
      return null;
    },

    getMessageContentRoot(element) {
      const role = getRoleForRow(element);
      if (role === 'user') {
        return element.querySelector(SELECTORS.userMessage);
      }
      if (role === 'assistant') {
        return element.querySelector(SELECTORS.assistantContent)
          || element.querySelector(`${SELECTORS.assistantMessage} [data-cds="Prose"]`);
      }
      return null;
    },

    getHistoryStartState(scroller) {
      return getBoundaryState(scroller, 'top');
    },

    isHistoryStartReached(scroller) {
      return this.getHistoryStartState(scroller)?.reached ?? false;
    },

    getHistoryEndState(scroller) {
      return getBoundaryState(scroller, 'bottom');
    },
  });
})();
