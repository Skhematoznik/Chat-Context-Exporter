(() => {
  'use strict';

  const app = globalThis.__chatContextExporter;
  const registry = app?.modules.adapterRegistry;

  if (!registry) {
    throw new Error('Chat Context Exporter: adapter registry is not initialized.');
  }

  const SELECTORS = Object.freeze({
    scroller: '[data-testid="chat-transcript-scroller"]',
    userMessage: '[data-testid="user-message"]',
    assistantMessage: '[data-testid="assistant-message"]',
    content: '.response-content-markdown',
    planeRow: '[data-plane-row]',
    topInset: '[data-plane-row="transcript:top-inset"][data-plane-row-kind="top-inset"]',
    submitSpacer: '[data-plane-row="transcript:submit-spacer"][data-plane-row-kind="submit-spacer"]',
  });

  function parseTranslateY(element) {
    const transform = element?.style?.transform || '';
    const match = transform.match(/translateY\((-?\d+(?:\.\d+)?)px\)/i);
    if (!match) {
      return null;
    }

    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
  }

  function getBoundaryState(scroller, selector, expectedPosition, kind) {
    if (!(scroller instanceof HTMLElement)) {
      return null;
    }

    const marker = scroller.querySelector(selector);
    const markerPosition = parseTranslateY(marker);
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const atBoundary = kind === 'top'
      ? scroller.scrollTop <= 2
      : Math.abs(scroller.scrollTop - maxTop) <= 2;
    const expectedMarkerPosition = typeof expectedPosition === 'function'
      ? expectedPosition(scroller, marker)
      : null;
    const markerAligned = expectedMarkerPosition === null
      ? Boolean(marker)
      : markerPosition !== null
        && Math.abs(markerPosition - expectedMarkerPosition) <= 2;
    const busy = scroller.getAttribute('aria-busy') === 'true';

    return {
      reached: atBoundary && Boolean(marker) && markerAligned && !busy,
      atBoundary,
      markerPresent: Boolean(marker),
      markerPosition,
      markerAligned,
      busy,
    };
  }

  registry.register({
    id: 'grok',
    displayName: 'Grok',
    scrollerLabel: 'Grok transcript',
    supportsMessageCollection: true,
    selectors: SELECTORS,

    detect() {
      let score = 0;

      if (location.hostname === 'grok.com' || location.hostname.endsWith('.grok.com')) {
        score += 50;
      }
      if (document.querySelector(SELECTORS.scroller)) {
        score += 35;
      }
      if (document.querySelector(SELECTORS.userMessage)) {
        score += 8;
      }
      if (document.querySelector(SELECTORS.assistantMessage)) {
        score += 8;
      }

      return score;
    },

    findScroller() {
      return document.querySelector(SELECTORS.scroller);
    },

    getVisibleMessages() {
      const scroller = this.findScroller();
      const root = scroller || document;
      return [
        ...root.querySelectorAll(
          `${SELECTORS.userMessage}, ${SELECTORS.assistantMessage}`,
        ),
      ];
    },

    getMessageId(element) {
      const responseId = element.closest('[id^="response-"]')?.id;
      if (responseId) {
        return responseId;
      }

      const row = element.closest(SELECTORS.planeRow);
      return row?.getAttribute('data-plane-row') || null;
    },

    getMessageOrderKey(element) {
      return parseTranslateY(element.closest(SELECTORS.planeRow));
    },

    getMessageRole(element) {
      if (element.matches(SELECTORS.userMessage)) {
        return 'user';
      }
      if (element.matches(SELECTORS.assistantMessage)) {
        return 'assistant';
      }
      return null;
    },

    getMessageTimestamp() {
      // Время сохраняется только если оно будет явно найдено в DOM сообщения.
      // На текущем этапе Grok timestamp не предоставляет устойчивого DOM-маркера.
      return null;
    },

    getMessageContentRoot(element) {
      return element.querySelector(SELECTORS.content);
    },

    getHistoryStartState(scroller) {
      return getBoundaryState(
        scroller,
        SELECTORS.topInset,
        () => 0,
        'top',
      );
    },

    isHistoryStartReached(scroller) {
      return this.getHistoryStartState(scroller)?.reached ?? false;
    },

    getHistoryEndState(scroller) {
      return getBoundaryState(
        scroller,
        SELECTORS.submitSpacer,
        null,
        'bottom',
      );
    },
  });
})();
