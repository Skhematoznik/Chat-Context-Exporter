(() => {
  'use strict';

  const app = globalThis.__chatContextExporter;
  const registry = app?.modules.adapterRegistry;

  if (!registry) {
    throw new Error('Chat Context Exporter: adapter registry is not initialized.');
  }

  const SELECTORS = Object.freeze({
    scroller: '.ds-virtual-list.ds-virtual-list--printable',
    virtualItem: '[data-virtual-list-item-key]',
    message: '.ds-message',
    userContent: '.ds-collapsible-text',
    assistantContent: '.ds-assistant-message-main-content',
    thinkingContent: '.ds-think-content',
    visibleItems: '.ds-virtual-list-visible-items',
    items: '.ds-virtual-list-items',
  });

  function parseTranslateY(element) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    const transform = element.style.transform || getComputedStyle(element).transform || '';
    const translateMatch = transform.match(/translateY\((-?\d+(?:\.\d+)?)px\)/i);
    if (translateMatch) {
      const value = Number(translateMatch[1]);
      return Number.isFinite(value) ? value : null;
    }

    // Computed transforms are often returned as matrix(..., ty).
    const matrixMatch = transform.match(/matrix\([^,]+,[^,]+,[^,]+,[^,]+,[^,]+,\s*(-?\d+(?:\.\d+)?)\)/i);
    if (matrixMatch) {
      const value = Number(matrixMatch[1]);
      return Number.isFinite(value) ? value : null;
    }

    return null;
  }

  function getVirtualItems(scroller) {
    if (!(scroller instanceof HTMLElement)) {
      return [];
    }

    return [...scroller.querySelectorAll(SELECTORS.virtualItem)];
  }

  function getRoleForItem(element) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    if (element.querySelector(SELECTORS.assistantContent)) {
      return 'assistant';
    }

    if (element.querySelector(SELECTORS.userContent)) {
      return 'user';
    }

    return null;
  }

  function getNumericTurn(element) {
    const rawKey = element?.getAttribute?.('data-virtual-list-item-key') || '';
    if (!/^-?\d+$/.test(rawKey)) {
      return null;
    }

    const value = Math.abs(Number(rawKey));
    return Number.isFinite(value) ? value : null;
  }

  function getVisibleKeySummary(scroller) {
    const items = getVirtualItems(scroller);
    const keys = [];
    const normalizedTurns = [];
    let userItems = 0;
    let assistantItems = 0;
    let unknownItems = 0;
    const userKeys = [];
    const assistantKeys = [];

    for (const item of items) {
      const key = item.getAttribute('data-virtual-list-item-key');
      if (key) {
        keys.push(key);
      }

      const turn = getNumericTurn(item);
      if (turn !== null) {
        normalizedTurns.push(turn);
      }

      const role = getRoleForItem(item);
      if (role === 'user') {
        userItems += 1;
        if (key) userKeys.push(key);
      } else if (role === 'assistant') {
        assistantItems += 1;
        if (key) assistantKeys.push(key);
      } else {
        unknownItems += 1;
      }
    }

    const numericTurns = normalizedTurns.filter(Number.isFinite);
    return {
      visibleKeys: keys,
      keyFingerprint: keys.join(','),
      minTurn: numericTurns.length > 0 ? Math.min(...numericTurns) : null,
      maxTurn: numericTurns.length > 0 ? Math.max(...numericTurns) : null,
      userItems,
      assistantItems,
      unknownItems,
      userKeys,
      assistantKeys,
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
    const visibleItems = scroller.querySelector(SELECTORS.visibleItems);
    const virtualOffset = parseTranslateY(visibleItems);
    const virtualOffsetAligned = kind === 'top'
      ? virtualOffset === null || Math.abs(virtualOffset) <= 2
      : true;
    const busy = scroller.getAttribute('aria-busy') === 'true';
    const summary = getVisibleKeySummary(scroller);

    return {
      reached: atBoundary && virtualOffsetAligned && !busy,
      atBoundary,
      virtualOffset,
      virtualOffsetAligned,
      busy,
      signature: summary.keyFingerprint || null,
      visibleKeys: summary.visibleKeys,
      minTurn: summary.minTurn,
      maxTurn: summary.maxTurn,
      userItems: summary.userItems,
      assistantItems: summary.assistantItems,
      unknownItems: summary.unknownItems,
      userKeys: summary.userKeys,
      assistantKeys: summary.assistantKeys,
    };
  }

  registry.register({
    id: 'deepseek',
    displayName: 'DeepSeek',
    scrollerLabel: 'DeepSeek conversation',
    supportsMessageCollection: true,
    selectors: SELECTORS,

    detect() {
      let score = 0;

      if (location.hostname === 'chat.deepseek.com' || location.hostname.endsWith('.deepseek.com')) {
        score += 50;
      }
      if (document.querySelector(SELECTORS.scroller)) {
        score += 30;
      }
      if (document.querySelector(SELECTORS.virtualItem)) {
        score += 10;
      }
      if (document.querySelector(SELECTORS.assistantContent)) {
        score += 10;
      }

      return score;
    },

    findScroller() {
      return document.querySelector(SELECTORS.scroller);
    },

    getVisibleMessages() {
      const scroller = this.findScroller();
      if (!(scroller instanceof HTMLElement)) {
        return [];
      }

      return getVirtualItems(scroller).filter((element) => Boolean(getRoleForItem(element)));
    },

    getMessageId(element) {
      const key = element?.getAttribute?.('data-virtual-list-item-key');
      return key ? `deepseek:${key}` : null;
    },

    getMessageOrderKey(element) {
      const turn = getNumericTurn(element);
      if (turn === null) {
        return null;
      }

      const role = getRoleForItem(element);
      if (!role) {
        return null;
      }

      // В наблюдаемом DOM DeepSeek пользовательский элемент имеет ключ -N,
      // а ответ ассистента того же turn — +N. Роль берем из DOM, а числовую
      // часть ключа используем только для хронологического порядка.
      return (turn * 2) + (role === 'assistant' ? 1 : 0);
    },

    getMessageRole(element) {
      return getRoleForItem(element);
    },

    getMessageTimestamp() {
      // Сохраняем время только при наличии устойчивого видимого DOM-маркера.
      return null;
    },

    getMessageContentRoot(element) {
      const role = getRoleForItem(element);
      if (role === 'assistant') {
        // Важно: не берем .ds-message целиком, иначе в экспорт попадут
        // reasoning/search UI из .ds-think-content.
        return element.querySelector(SELECTORS.assistantContent);
      }
      if (role === 'user') {
        return element.querySelector(SELECTORS.userContent);
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
