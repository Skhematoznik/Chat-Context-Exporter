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

  function normalizeScrollMode(mode) {
    return mode === 'reverse' ? 'reverse' : 'normal';
  }

  function getScrollBounds(element, mode = 'normal') {
    const range = Math.max(0, element.scrollHeight - element.clientHeight);
    if (normalizeScrollMode(mode) === 'reverse') {
      return { min: -range, max: 0, start: -range, end: 0, range };
    }
    return { min: 0, max: range, start: 0, end: range, range };
  }

  function clampScrollTop(element, targetTop, mode = 'normal') {
    const bounds = getScrollBounds(element, mode);
    const requested = Number(targetTop);
    const finiteTarget = Number.isFinite(requested) ? requested : 0;
    return Math.min(bounds.max, Math.max(bounds.min, finiteTarget));
  }

  function scrollToDirect(element, targetTop, mode = 'normal') {
    const safeTarget = clampScrollTop(element, targetTop, mode);
    const from = element.scrollTop;
    const immediate = applyDirectScrollTop(element, safeTarget);

    return {
      from,
      target: safeTarget,
      immediate,
      strategy: 'direct-recovery',
    };
  }

  function scrollUpOneStep(element, mode = 'normal') {
    const stepPx = getStepPx(element);
    const from = element.scrollTop;
    const bounds = getScrollBounds(element, mode);
    const target = Math.max(bounds.min, from - stepPx);
    const atBottom = Math.abs(from - bounds.end) <= 2;

    // Некоторые виртуализированные чаты удерживают список в режиме
    // «приклеен к последнему сообщению». При старте ровно с нижней границы smooth-scroll
    // иногда немедленно компенсируется интерфейсом. Первый шаг выполняем прямой установкой
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

  function scrollDownOneStep(element, mode = 'normal') {
    const stepPx = getStepPx(element);
    const from = element.scrollTop;
    const bounds = getScrollBounds(element, mode);
    const target = Math.min(bounds.max, from + stepPx);

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

  function isAtTop(element, epsilonPx = 2, mode = 'normal') {
    const bounds = getScrollBounds(element, mode);
    return Math.abs(element.scrollTop - bounds.start) <= epsilonPx;
  }

  function isAtBottom(element, epsilonPx = 2, mode = 'normal') {
    const bounds = getScrollBounds(element, mode);
    return Math.abs(element.scrollTop - bounds.end) <= epsilonPx;
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
    getScrollBounds,
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
