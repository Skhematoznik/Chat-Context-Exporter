(() => {
  'use strict';

  const app = globalThis.__chatContextExporter;
  if (!app) {
    throw new Error('Chat Context Exporter: namespace is not initialized.');
  }

  const SCROLL_STEP_RATIO = 0.7;
  const MIN_SCROLL_STEP_PX = 240;

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);

    return (
      rect.width >= 180 &&
      rect.height >= 100 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number.parseFloat(style.opacity || '1') > 0
    );
  }

  function isScrollableElement(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (element.closest?.('[data-chat-context-exporter-ui="true"]')) {
      return false;
    }

    const style = getComputedStyle(element);
    const overflowY = style.overflowY;
    const allowsScroll = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';

    return (
      allowsScroll &&
      element.scrollHeight > element.clientHeight + 4 &&
      isVisible(element)
    );
  }

  function scoreScrollableElement(element) {
    const rect = element.getBoundingClientRect();
    const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
    const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    const visibleArea = visibleWidth * visibleHeight;
    const scrollRange = Math.max(1, element.scrollHeight - element.clientHeight);
    const depthFactor = Math.log10(scrollRange + 10);

    return visibleArea * depthFactor;
  }

  function findGenericScrollContainer() {
    const candidates = [];
    const scrollingElement = document.scrollingElement;

    if (
      scrollingElement &&
      scrollingElement.scrollHeight > scrollingElement.clientHeight + 4
    ) {
      candidates.push(scrollingElement);
    }

    for (const element of document.querySelectorAll('body *')) {
      if (isScrollableElement(element)) {
        candidates.push(element);
      }
    }

    if (candidates.length === 0) {
      return scrollingElement || document.documentElement;
    }

    let winner = candidates[0];
    let winnerScore = scoreScrollableElement(winner);

    for (let index = 1; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const candidateScore = scoreScrollableElement(candidate);

      if (candidateScore > winnerScore) {
        winner = candidate;
        winnerScore = candidateScore;
      }
    }

    return winner;
  }

  function describeElement(element) {
    if (!element) {
      return 'не найден';
    }

    if (element === document.scrollingElement) {
      return 'страница';
    }

    const tag = element.tagName?.toLowerCase?.() || 'element';
    const id = element.id ? `#${element.id}` : '';
    const classes = typeof element.className === 'string'
      ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 3)
      : [];
    const classSuffix = classes.length > 0 ? `.${classes.join('.')}` : '';

    return `${tag}${id}${classSuffix}`;
  }

  function readScrollState(element) {
    return {
      top: element.scrollTop,
      height: element.scrollHeight,
      client: element.clientHeight,
    };
  }

  function getStepPx(element) {
    return Math.max(
      MIN_SCROLL_STEP_PX,
      Math.round(element.clientHeight * SCROLL_STEP_RATIO),
    );
  }

  function restoreInlineScrollBehavior(element, previousScrollBehavior) {
    requestAnimationFrame(() => {
      if (element.isConnected) {
        element.style.scrollBehavior = previousScrollBehavior;
      }
    });
  }

  function applyDirectScrollTop(element, targetTop) {
    const previousScrollBehavior = element.style.scrollBehavior;
    element.style.scrollBehavior = 'auto';
    element.scrollTop = targetTop;
    const immediateTop = element.scrollTop;
    restoreInlineScrollBehavior(element, previousScrollBehavior);
    return immediateTop;
  }

  function scrollToDirect(element, targetTop) {
    const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const safeTarget = Math.min(maxTop, Math.max(0, Number(targetTop) || 0));
    const from = element.scrollTop;
    const immediate = applyDirectScrollTop(element, safeTarget);

    return {
      from,
      target: safeTarget,
      immediate,
      strategy: 'direct-recovery',
    };
  }

  function scrollUpOneStep(element) {
    const stepPx = getStepPx(element);
    const from = element.scrollTop;
    const target = Math.max(0, from - stepPx);
    const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const atBottom = Math.abs(from - maxTop) <= 2;

    // Grok может удерживать transcript в режиме «приклеен к последнему сообщению».
    // При старте ровно с нижней границы smooth-scroll иногда немедленно
    // компенсируется самим интерфейсом. Первый шаг выполняем прямой установкой
    // scrollTop: это штатная локальная прокрутка DOM и не инициирует запросов
    // со стороны расширения. После отрыва от низа снова используем smooth.
    if (atBottom && target < from) {
      const immediate = applyDirectScrollTop(element, target);
      return {
        stepPx,
        from,
        target,
        immediate,
        strategy: 'direct-unpin',
      };
    }

    element.scrollBy({
      top: -stepPx,
      left: 0,
      behavior: 'smooth',
    });

    return {
      stepPx,
      from,
      target,
      immediate: element.scrollTop,
      strategy: 'smooth',
    };
  }

  function scrollDownOneStep(element) {
    const stepPx = getStepPx(element);
    const from = element.scrollTop;
    const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const target = Math.min(maxTop, from + stepPx);

    element.scrollBy({
      top: stepPx,
      left: 0,
      behavior: 'smooth',
    });

    return {
      stepPx,
      from,
      target,
      immediate: element.scrollTop,
      strategy: 'smooth',
    };
  }

  function isAtTop(element, epsilonPx = 2) {
    return element.scrollTop <= epsilonPx;
  }

  function isAtBottom(element, epsilonPx = 2) {
    const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
    return Math.abs(element.scrollTop - maxTop) <= epsilonPx;
  }

  function cancelCurrentScroll(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected) {
      return;
    }

    const currentTop = element.scrollTop;
    const currentLeft = element.scrollLeft;
    const previousScrollBehavior = element.style.scrollBehavior;

    element.style.scrollBehavior = 'auto';
    element.scrollTop = currentTop;
    element.scrollLeft = currentLeft;

    requestAnimationFrame(() => {
      if (element.isConnected) {
        element.style.scrollBehavior = previousScrollBehavior;
      }
    });
  }

  app.modules.scroller = {
    MIN_SCROLL_STEP_PX,
    SCROLL_STEP_RATIO,
    cancelCurrentScroll,
    describeElement,
    findGenericScrollContainer,
    getStepPx,
    isScrollableElement,
    isAtBottom,
    isAtTop,
    readScrollState,
    scrollDownOneStep,
    scrollToDirect,
    scrollUpOneStep,
  };
})();
