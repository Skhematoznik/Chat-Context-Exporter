(() => {
  'use strict';

  const app = globalThis.__chatContextExporter;
  if (!app) {
    throw new Error('Chat Context Exporter: namespace is not initialized.');
  }

  const profiles = app.modules.chatGptProfiles || (app.modules.chatGptProfiles = Object.create(null));
  const TURN_RANK_GAP = 1024;

  const SELECTORS = Object.freeze({
    scroller: '[data-app-action-timeline-scroll].thread-scroll-container',
    conversation: '[data-chatgpt-conversation-selection-target="true"][data-thread-find-target="conversation"]',
    turn: '[data-turn-key]',
    userMessage: '[data-user-message-bubble="true"]',
    assistantMarker: '[data-conversation-role="assistant"]',
    assistantContainer: '[data-chatgpt-selection-message-id]',
    assistantContent: '[data-markdown-text-style="assistant-message"]',
    selectionMessage: '[data-chatgpt-selection-message-id]',
    agentTurnStart: '[data-chatgpt-agent-turn-start]',
    turnTimestamp: 'time[datetime]',
    scrollToBottomButton: [
      'button[class*="scroll-to-bottom"]',
      'button[class*="group/scroll-to-bottom"]',
      '[data-testid="scroll-to-bottom-button"]',
    ].join(', '),
  });

  const turnRanks = new Map();
  let lastScrollTop = null;

  function findScroller() {
    const candidates = [...document.querySelectorAll(SELECTORS.scroller)];
    return candidates.find((element) => (
      element instanceof HTMLElement
      && element.querySelector(SELECTORS.conversation)
    )) || null;
  }

  function getConversation(scroller) {
    return scroller instanceof HTMLElement
      ? scroller.querySelector(SELECTORS.conversation)
      : null;
  }

  function getTurns(scroller) {
    const conversation = getConversation(scroller);
    if (!(conversation instanceof HTMLElement)) {
      return [];
    }

    return [...conversation.querySelectorAll(SELECTORS.turn)]
      .filter((turn) => turn instanceof HTMLElement && Boolean(turn.getAttribute('data-turn-key')));
  }

  function getTurnKey(element) {
    const turn = element instanceof HTMLElement ? element.closest(SELECTORS.turn) : null;
    return turn?.getAttribute('data-turn-key') || null;
  }

  function getAssistantMessageId(element) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    return element.getAttribute('data-chatgpt-selection-message-id')
      || element.closest(SELECTORS.assistantContainer)?.getAttribute('data-chatgpt-selection-message-id')
      || element.querySelector(SELECTORS.selectionMessage)?.getAttribute('data-chatgpt-selection-message-id')
      || null;
  }

  function getAssistantContent(element) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    if (element.matches(SELECTORS.assistantContent)) {
      return element;
    }

    const content = element.querySelector(SELECTORS.assistantContent);
    return content instanceof HTMLElement ? content : null;
  }

  function isTransientAssistantContent(element) {
    const content = getAssistantContent(element);
    if (!(content instanceof HTMLElement)) {
      return false;
    }

    if (content.getAttribute('data-markdown-text-tone') !== 'tertiary') {
      return false;
    }

    const turn = content.closest(SELECTORS.turn);
    if (!(turn instanceof HTMLElement)) {
      return false;
    }

    if (getAssistantMessageId(content)) {
      return false;
    }

    return turn.querySelector(SELECTORS.agentTurnStart) instanceof HTMLElement;
  }

  function getFallbackTurnIndex(turn) {
    if (!(turn instanceof HTMLElement)) {
      return null;
    }

    const keyed = turn.querySelector('[data-content-search-turn-key^="fallback-turn-"]');
    const raw = keyed?.getAttribute('data-content-search-turn-key') || '';
    const match = raw.match(/^fallback-turn-(\d+)$/);
    return match ? Number(match[1]) : null;
  }

  function observeOrderedIds(ids, { movedTowardStart }) {
    const uniqueIds = [];
    const seen = new Set();
    for (const id of ids) {
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      uniqueIds.push(id);
    }

    if (uniqueIds.length === 0) {
      return;
    }

    const known = [];
    for (let index = 0; index < uniqueIds.length; index += 1) {
      const rank = turnRanks.get(uniqueIds[index]);
      if (Number.isFinite(rank)) {
        known.push({ index, rank });
      }
    }

    if (known.length === 0) {
      const existingRanks = [...turnRanks.values()].filter(Number.isFinite);
      if (existingRanks.length === 0) {
        uniqueIds.forEach((id, index) => turnRanks.set(id, index * TURN_RANK_GAP));
      } else if (movedTowardStart) {
        const minRank = Math.min(...existingRanks);
        const firstRank = minRank - (uniqueIds.length * TURN_RANK_GAP);
        uniqueIds.forEach((id, index) => turnRanks.set(id, firstRank + (index * TURN_RANK_GAP)));
      } else {
        const maxRank = Math.max(...existingRanks);
        uniqueIds.forEach((id, index) => turnRanks.set(id, maxRank + ((index + 1) * TURN_RANK_GAP)));
      }
      return;
    }

    const firstKnown = known[0];
    for (let index = firstKnown.index - 1; index >= 0; index -= 1) {
      turnRanks.set(uniqueIds[index], firstKnown.rank - ((firstKnown.index - index) * TURN_RANK_GAP));
    }

    for (let anchorIndex = 0; anchorIndex < known.length - 1; anchorIndex += 1) {
      const left = known[anchorIndex];
      const right = known[anchorIndex + 1];
      const gapItems = right.index - left.index - 1;
      if (gapItems <= 0) {
        continue;
      }

      const span = right.rank - left.rank;
      const step = span > 0 ? span / (gapItems + 1) : 1 / (gapItems + 1);
      for (let offset = 1; offset <= gapItems; offset += 1) {
        turnRanks.set(uniqueIds[left.index + offset], left.rank + (step * offset));
      }
    }

    const lastKnown = known[known.length - 1];
    for (let index = lastKnown.index + 1; index < uniqueIds.length; index += 1) {
      turnRanks.set(uniqueIds[index], lastKnown.rank + ((index - lastKnown.index) * TURN_RANK_GAP));
    }
  }

  function observeTurnOrder(turns, scroller) {
    const ids = turns.map((turn) => turn.getAttribute('data-turn-key')).filter(Boolean);
    const currentTop = scroller instanceof HTMLElement ? scroller.scrollTop : null;
    const movedTowardStart = Number.isFinite(currentTop)
      && Number.isFinite(lastScrollTop)
      && currentTop < lastScrollTop - 1;

    observeOrderedIds(ids, { movedTowardStart });
    if (Number.isFinite(currentTop)) {
      lastScrollTop = currentTop;
    }
  }

  function getRole(element) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }
    if (element.matches(SELECTORS.userMessage)) {
      return 'user';
    }
    if (
      element.matches(SELECTORS.assistantContent)
      || element.matches(SELECTORS.assistantContainer)
      || element.querySelector(SELECTORS.assistantContent) instanceof HTMLElement
    ) {
      return isTransientAssistantContent(element) ? null : 'assistant';
    }
    return null;
  }

  function getVisibleMessages() {
    const scroller = findScroller();
    if (!(scroller instanceof HTMLElement)) {
      return [];
    }

    const turns = getTurns(scroller);
    observeTurnOrder(turns, scroller);
    const result = [];

    for (const turn of turns) {
      const user = turn.querySelector(SELECTORS.userMessage);
      if (user instanceof HTMLElement) {
        result.push(user);
      }

      const assistantContent = turn.querySelector(SELECTORS.assistantContent);
      if (assistantContent instanceof HTMLElement && !isTransientAssistantContent(assistantContent)) {
        const assistantContainer = assistantContent.closest(SELECTORS.assistantContainer);
        result.push(assistantContainer instanceof HTMLElement ? assistantContainer : assistantContent);
      }
    }

    return result;
  }

  function getMessageId(element) {
    const role = getRole(element);
    const turnKey = getTurnKey(element);

    if (role === 'user' && turnKey) {
      return `chatgpt:user:${turnKey}`;
    }

    if (role === 'assistant') {
      const messageId = getAssistantMessageId(element);
      if (messageId) {
        return `chatgpt:assistant:${messageId}`;
      }
      if (turnKey) {
        return `chatgpt:assistant:${turnKey}`;
      }
    }

    return null;
  }

  function getMessageOrderKey(element) {
    const key = getTurnKey(element);
    const rank = key ? turnRanks.get(key) : null;
    const role = getRole(element);
    if (!Number.isFinite(rank) || !role) {
      return null;
    }
    return (rank * 2) + (role === 'assistant' ? 1 : 0);
  }

  function normalizeCodeLanguageLabel(value) {
    const label = String(value || '').trim().replace(/\s+/g, ' ');
    if (!label || label.length > 32) {
      return null;
    }

    if (/^(?:обычный текст|plain text|plaintext|text|код|code)$/i.test(label)) {
      return null;
    }

    if (!/^[a-z0-9_+#. -]+$/i.test(label)) {
      return null;
    }

    return label.toLowerCase().replace(/\s+/g, '-');
  }

  function sanitizeAssistantSnapshot(contentRoot) {
    if (!(contentRoot instanceof HTMLElement)) {
      return null;
    }

    const clone = contentRoot.cloneNode(true);
    if (!(clone instanceof HTMLElement)) {
      return null;
    }

    // ChatGPT помечает собственные служебные элементы для исключения при копировании.
    // Сначала сворачиваем code-block wrapper в обычный PRE/CODE, чтобы не экспортировать
    // заголовки вроде «Обычный текст» и кнопки управления блоком.
    for (const wrapper of [...clone.querySelectorAll('[data-markdown-copy="code-block"]')]) {
      const sourceCode = wrapper.querySelector('code');
      if (!(sourceCode instanceof HTMLElement)) {
        continue;
      }

      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = sourceCode.textContent || '';

      const header = wrapper.querySelector('[data-markdown-copy="exclude"]');
      const language = normalizeCodeLanguageLabel(header?.textContent || '');
      if (language) {
        code.setAttribute('data-language', language);
      }

      pre.append(code);
      wrapper.replaceWith(pre);
    }

    // В authenticated thread inline-code визуально является SPAN, но ChatGPT
    // оставляет явный семантический marker data-markdown-copy="inline-code".
    for (const inline of [...clone.querySelectorAll('[data-markdown-copy="inline-code"]')]) {
      const code = document.createElement('code');
      code.textContent = inline.textContent || '';
      inline.replaceWith(code);
    }

    // KaTeX содержит одновременно MathML и HTML-представление формулы. Используем
    // уже отрисованный DOM marker data-math-source, чтобы не дублировать одну формулу.
    for (const math of [...clone.querySelectorAll('[data-math-source]')]) {
      const source = math.getAttribute('data-math-source');
      if (!source) {
        continue;
      }

      const display = math.getAttribute('data-math-display') === 'true';
      const replacement = document.createElement(display ? 'div' : 'span');
      replacement.setAttribute(display ? 'data-cce-math-block' : 'data-cce-math-inline', 'true');
      replacement.textContent = source;
      math.replaceWith(replacement);
    }

    for (const excluded of [...clone.querySelectorAll('[data-markdown-copy="exclude"]')]) {
      excluded.remove();
    }

    return clone;
  }

  function getMessageContentRoot(element) {
    const role = getRole(element);
    if (role === 'user') {
      return element;
    }
    if (role === 'assistant') {
      const content = getAssistantContent(element);
      if (!(content instanceof HTMLElement) || isTransientAssistantContent(content)) {
        return null;
      }
      return sanitizeAssistantSnapshot(content);
    }
    return null;
  }

  function getConversationStartTimestamp(scroller) {
    const turns = getTurns(scroller);
    const firstTurn = turns[0] || null;
    if (!(firstTurn instanceof HTMLElement)) {
      return null;
    }

    const firstUser = firstTurn.querySelector(SELECTORS.userMessage);
    if (!(firstUser instanceof HTMLElement)) {
      return null;
    }

    for (const time of firstTurn.querySelectorAll(SELECTORS.turnTimestamp)) {
      if (!(time instanceof HTMLElement)) {
        continue;
      }

      const relation = time.compareDocumentPosition(firstUser);
      if ((relation & Node.DOCUMENT_POSITION_FOLLOWING) === 0) {
        continue;
      }

      const datetime = time.getAttribute('datetime');
      if (datetime && Number.isFinite(Date.parse(datetime))) {
        return datetime;
      }
    }

    return null;
  }

  function parsePx(value) {
    const match = String(value || '').trim().match(/^(-?\d+(?:\.\d+)?)px$/i);
    return match ? Number(match[1]) : null;
  }

  function getVirtualGeometry(turns) {
    const firstTurn = turns[0];
    if (!(firstTurn instanceof HTMLElement)) {
      return { virtualHeight: null, virtualMarginTop: null };
    }

    const segment = firstTurn.parentElement;
    const flexColumn = segment?.parentElement;
    const virtualCanvas = flexColumn?.parentElement;
    return {
      virtualHeight: virtualCanvas instanceof HTMLElement ? parsePx(virtualCanvas.style.height) : null,
      virtualMarginTop: flexColumn instanceof HTMLElement ? parsePx(flexColumn.style.marginTop) : null,
    };
  }

  function elementIsHidden(element) {
    if (!(element instanceof HTMLElement)) {
      return true;
    }
    if (element.hidden || element.getAttribute('aria-hidden') === 'true') {
      return true;
    }

    const style = getComputedStyle(element);
    return style.display === 'none'
      || style.visibility === 'hidden'
      || Number.parseFloat(style.opacity || '1') <= 0.05;
  }

  function getTopStatusState(root, firstTurn) {
    if (!(root instanceof HTMLElement) || !(firstTurn instanceof HTMLElement)) {
      return { topStatusPresent: false, topStatusText: null };
    }

    for (const status of root.querySelectorAll('[role="status"]')) {
      if (!(status instanceof HTMLElement) || elementIsHidden(status)) {
        continue;
      }

      const relation = status.compareDocumentPosition(firstTurn);
      if ((relation & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) {
        return {
          topStatusPresent: true,
          topStatusText: (status.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160) || null,
        };
      }
    }

    return { topStatusPresent: false, topStatusText: null };
  }

  function getScrollToBottomState(scroller) {
    const button = scroller?.querySelector?.(SELECTORS.scrollToBottomButton) || null;
    if (!(button instanceof HTMLElement)) {
      return { scrollToBottomPresent: false, scrollToBottomHidden: null };
    }

    const style = getComputedStyle(button);
    const className = typeof button.className === 'string' ? button.className : '';
    const hidden = button.hidden
      || button.hasAttribute('inert')
      || button.getAttribute('aria-hidden') === 'true'
      || style.display === 'none'
      || style.visibility === 'hidden'
      || style.pointerEvents === 'none'
      || Number.parseFloat(style.opacity || '1') <= 0.05
      || /(?:^|\s)opacity-0(?:\s|$)/.test(className);

    return { scrollToBottomPresent: true, scrollToBottomHidden: hidden };
  }

  function getSummary(scroller) {
    const turns = getTurns(scroller);
    observeTurnOrder(turns, scroller);

    const turnKeys = [];
    const fallbackIndices = [];
    const ranks = [];
    const transientAssistantTurnKeys = [];
    const transientAssistantStatusPreviews = [];
    let userMessages = 0;
    let assistantMessages = 0;
    let transientAssistantStatusCount = 0;

    for (const turn of turns) {
      const key = turn.getAttribute('data-turn-key');
      if (key) {
        turnKeys.push(key);
        const rank = turnRanks.get(key);
        ranks.push(Number.isFinite(rank) ? rank : null);
      }

      const fallbackIndex = getFallbackTurnIndex(turn);
      if (fallbackIndex !== null) {
        fallbackIndices.push(fallbackIndex);
      }
      if (turn.querySelector(SELECTORS.userMessage)) {
        userMessages += 1;
      }
      const assistantContent = turn.querySelector(SELECTORS.assistantContent);
      if (assistantContent instanceof HTMLElement) {
        if (isTransientAssistantContent(assistantContent)) {
          transientAssistantStatusCount += 1;
          if (key) {
            transientAssistantTurnKeys.push(key);
          }
          const preview = String(assistantContent.textContent || '')
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 160);
          if (preview) {
            transientAssistantStatusPreviews.push(preview);
          }
        } else {
          assistantMessages += 1;
        }
      }
    }

    const firstTurn = turns[0] || null;
    const conversation = getConversation(scroller);
    const topStatus = getTopStatusState(conversation, firstTurn);
    const scrollButton = getScrollToBottomState(scroller);
    const geometry = getVirtualGeometry(turns);

    return {
      layoutVariant: 'authenticated-thread',
      signature: turnKeys.join(','),
      visibleTurnKeys: turnKeys,
      fallbackIndices,
      firstFallbackIndex: fallbackIndices.length > 0 ? Math.min(...fallbackIndices) : null,
      lastFallbackIndex: fallbackIndices.length > 0 ? Math.max(...fallbackIndices) : null,
      turnRanks: ranks,
      userMessages,
      assistantMessages,
      transientAssistantStatusCount,
      transientAssistantTurnKeys: transientAssistantTurnKeys.slice(0, 12),
      transientAssistantStatusPreviews: transientAssistantStatusPreviews.slice(0, 12),
      topStatusPresent: topStatus.topStatusPresent,
      topStatusText: topStatus.topStatusText,
      ...scrollButton,
      ...geometry,
    };
  }

  function getBoundaryState(scroller, kind) {
    if (!(scroller instanceof HTMLElement)) {
      return null;
    }

    const range = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const expected = kind === 'top' ? -range : 0;
    const atBoundary = Math.abs(scroller.scrollTop - expected) <= 2;
    const summary = getSummary(scroller);
    const semanticMarkerPresent = kind === 'top'
      ? !summary.topStatusPresent
      : (summary.scrollToBottomHidden !== false);

    return {
      reached: atBoundary && semanticMarkerPresent,
      atBoundary,
      scrollMode: 'reverse',
      scrollTop: Math.round(scroller.scrollTop),
      scrollRange: range,
      expectedScrollTop: Math.round(expected),
      semanticMarkerPresent,
      ...summary,
    };
  }

  profiles.thread = Object.freeze({
    id: 'thread',
    variant: 'authenticated-thread',
    scrollMode: 'reverse',
    scrollerLabel: 'ChatGPT transcript',
    selectors: SELECTORS,

    detect() {
      let score = 0;
      if (document.querySelector(SELECTORS.scroller)) {
        score += 35;
      }
      if (document.querySelector(SELECTORS.turn)) {
        score += 20;
      }
      if (document.querySelector(SELECTORS.conversation)) {
        score += 15;
      }
      return score;
    },

    findScroller,
    getVisibleMessages,
    getMessageId,
    getMessageOrderKey,
    getMessageRole: getRole,
    getMessageTimestamp() {
      return null;
    },
    getConversationStartTimestamp,
    getMessageContentRoot,
    getCollectionCoverage() {
      return null;
    },
    getHistoryStartState(scroller) {
      return getBoundaryState(scroller, 'top');
    },
    getHistoryEndState(scroller) {
      return getBoundaryState(scroller, 'bottom');
    },
  });
})();
