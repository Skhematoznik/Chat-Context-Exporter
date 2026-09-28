(() => {
  'use strict';

  const app = globalThis.__chatContextExporter;
  if (!app) {
    throw new Error('Chat Context Exporter: namespace is not initialized.');
  }

  const profiles = app.modules.chatGptProfiles || (app.modules.chatGptProfiles = Object.create(null));
  const observedTurnIds = new Set();
  const standardMessageTurnIds = new Set();
  const fallbackMessageTurnIds = new Set();
  const transientTurnIds = new Set();
  const turnOrdinalById = new Map();

  const SELECTORS = Object.freeze({
    scroller: '[data-scroll-root]',
    turnContainer: '[data-turn-id-container]',
    turnSection: 'section[data-testid^="conversation-turn-"][data-turn]',
    roleMessage: '[data-message-author-role="user"], [data-message-author-role="assistant"]',
    userContent: [
      '[data-testid="collapsible-user-message-content"] .whitespace-pre-wrap',
      '[data-testid="collapsible-user-message-content"]',
      '.whitespace-pre-wrap',
    ].join(', '),
    assistantContent: [
      '.markdown.prose',
      '.markdown',
      '[class*="markdown"][class*="prose"]',
      '[class*="markdown"]',
    ].join(', '),
    transientStatus: '[data-streaming-response-status]',
    fallbackNoise: [
      'button',
      'script',
      'style',
      'svg',
      'noscript',
      'template',
      'input',
      'textarea',
      'select',
      '[role="button"]',
      '[role="menu"]',
      '[role="menuitem"]',
      '[data-markdown-copy="exclude"]',
      '[data-streaming-response-status]',
      '[aria-hidden="true"]',
      '[hidden]',
    ].join(', '),
  });

  function isElementVisible(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0
      && rect.height > 0
      && rect.bottom > 0
      && rect.right > 0
      && rect.top < window.innerHeight
      && rect.left < window.innerWidth
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number.parseFloat(style.opacity || '1') > 0;
  }

  function isScrollable(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const style = getComputedStyle(element);
    return (
      (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'overlay')
      && element.scrollHeight > element.clientHeight + 4
    );
  }

  function scoreScroller(element) {
    const rect = element.getBoundingClientRect();
    const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
    const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    const range = Math.max(0, element.scrollHeight - element.clientHeight);
    const hasConversation = Boolean(
      element.querySelector(SELECTORS.turnContainer)
      || element.querySelector(SELECTORS.turnSection)
      || element.querySelector(SELECTORS.roleMessage)
    );

    return (visibleWidth * visibleHeight) + range + (hasConversation ? 1_000_000_000 : 0);
  }

  function findScroller() {
    const candidates = [...document.querySelectorAll(SELECTORS.scroller)]
      .filter((element) => element instanceof HTMLElement && isElementVisible(element));

    if (candidates.length === 0) {
      return null;
    }

    const scrollable = candidates.filter(isScrollable);
    const pool = scrollable.length > 0 ? scrollable : candidates;
    pool.sort((left, right) => scoreScroller(right) - scoreScroller(left));
    return pool[0] || null;
  }

  function getTurnSection(element) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }
    return element.closest(SELECTORS.turnSection);
  }

  function getRole(element) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    const direct = element.getAttribute('data-message-author-role');
    if (direct === 'user' || direct === 'assistant') {
      return direct;
    }

    const sectionRole = getTurnSection(element)?.getAttribute('data-turn');
    return sectionRole === 'user' || sectionRole === 'assistant' ? sectionRole : null;
  }

  function getTurnId(section) {
    if (!(section instanceof HTMLElement)) {
      return null;
    }

    return section.getAttribute('data-turn-id-container')
      || section.getAttribute('data-turn-id')
      || null;
  }

  function getSectionOrdinal(section) {
    if (!(section instanceof HTMLElement)) {
      return null;
    }

    const testId = section.getAttribute('data-testid') || '';
    const match = testId.match(/^conversation-turn-(\d+)$/);
    return match ? Number(match[1]) : null;
  }

  function sanitizeFallbackTurnSnapshot(section) {
    if (!(section instanceof HTMLElement)) {
      return null;
    }

    const clone = section.cloneNode(true);
    if (!(clone instanceof HTMLElement)) {
      return null;
    }

    for (const noisy of [...clone.querySelectorAll(SELECTORS.fallbackNoise)]) {
      noisy.remove();
    }

    // Shared ChatGPT can render role headings around a turn. They are UI chrome, not message text.
    for (const heading of [...clone.querySelectorAll('h4, h5')]) {
      const label = String(heading.textContent || '').trim().replace(/\s+/g, ' ');
      if (/^(?:вы сказали|you said|chatgpt сказал|chatgpt said)$/i.test(label)) {
        heading.remove();
      }
    }

    return clone;
  }

  function hasMeaningfulSnapshot(root) {
    if (!(root instanceof HTMLElement)) {
      return false;
    }

    if (/\S/.test(String(root.textContent || '').replace(/\u00a0/g, ' '))) {
      return true;
    }

    return [...root.querySelectorAll('img[alt]')].some((image) => (image.getAttribute('alt') || '').trim());
  }

  function getFallbackContentRoot(section) {
    if (!(section instanceof HTMLElement)) {
      return null;
    }

    const role = getRole(section);
    if (role !== 'user' && role !== 'assistant') {
      return null;
    }

    if (role === 'user') {
      const userRoot = section.querySelector(SELECTORS.userContent);
      if (userRoot instanceof HTMLElement && hasMeaningfulSnapshot(userRoot)) {
        return userRoot;
      }
    } else {
      const assistantRoot = section.querySelector(SELECTORS.assistantContent);
      if (assistantRoot instanceof HTMLElement) {
        const sanitized = sanitizeAssistantSnapshot(assistantRoot);
        if (hasMeaningfulSnapshot(sanitized)) {
          return sanitized;
        }
      }
    }

    const fallback = sanitizeFallbackTurnSnapshot(section);
    return hasMeaningfulSnapshot(fallback) ? fallback : null;
  }

  function isTransientTurn(section) {
    if (!(section instanceof HTMLElement)) {
      return false;
    }

    if (getRole(section) !== 'assistant') {
      return false;
    }

    const roleMessages = [...section.querySelectorAll(SELECTORS.roleMessage)]
      .filter((element) => element instanceof HTMLElement)
      .filter((element) => getTurnSection(element) === section);
    if (roleMessages.length > 0) {
      return false;
    }

    return section.querySelector(SELECTORS.transientStatus) instanceof HTMLElement;
  }

  function isFallbackExportableSection(section) {
    if (!(section instanceof HTMLElement)) {
      return false;
    }

    if (isTransientTurn(section)) {
      return false;
    }

    const roleMessages = [...section.querySelectorAll(SELECTORS.roleMessage)]
      .filter((element) => element instanceof HTMLElement)
      .filter((element) => getTurnSection(element) === section);
    if (roleMessages.length > 0) {
      return false;
    }

    return getFallbackContentRoot(section) instanceof HTMLElement;
  }

  function getVisibleMessages() {
    const scroller = findScroller();
    if (!(scroller instanceof HTMLElement)) {
      return [];
    }

    const sections = getMountedTurnSections(scroller);
    observeMountedTurns(scroller, sections);
    const result = [];

    for (const section of sections) {
      const roleMessages = [...section.querySelectorAll(SELECTORS.roleMessage)]
        .filter((element) => element instanceof HTMLElement)
        .filter((element) => getTurnSection(element) === section);

      if (roleMessages.length > 0) {
        result.push(...roleMessages);
        continue;
      }

      if (isFallbackExportableSection(section)) {
        result.push(section);
      }
    }

    return result;
  }

  function getMessageId(element) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    const role = getRole(element) || 'message';
    const section = getTurnSection(element);
    const turnId = getTurnId(section);
    if (turnId) {
      return `chatgpt:${role}:turn:${turnId}`;
    }

    const messageId = element.getAttribute('data-message-id');
    return messageId ? `chatgpt:${role}:${messageId}` : null;
  }

  function getTurnOrdinal(element) {
    return getSectionOrdinal(getTurnSection(element));
  }

  function getMessageQualityRank(element) {
    const section = getTurnSection(element);
    if (!(section instanceof HTMLElement)) {
      return 0;
    }
    return element === section ? 0 : 10;
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

  function removeInteractiveSuggestionLists(root) {
    for (const list of [...root.querySelectorAll('ul, ol')]) {
      const items = [...list.children].filter((child) => child.tagName === 'LI');
      if (items.length === 0) {
        continue;
      }

      const allInteractive = items.every((item) => item.querySelector('[role="button"]'));
      if (!allInteractive) {
        continue;
      }

      const intro = list.previousElementSibling;
      const separator = intro?.previousElementSibling || null;
      list.remove();

      if (intro?.tagName === 'P') {
        intro.remove();
        if (separator?.tagName === 'HR') {
          separator.remove();
        }
      }
    }
  }

  function sanitizeAssistantSnapshot(contentRoot) {
    if (!(contentRoot instanceof HTMLElement)) {
      return null;
    }

    const clone = contentRoot.cloneNode(true);
    if (!(clone instanceof HTMLElement)) {
      return null;
    }

    removeInteractiveSuggestionLists(clone);

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

    for (const inline of [...clone.querySelectorAll('[data-markdown-copy="inline-code"]')]) {
      const code = document.createElement('code');
      code.textContent = inline.textContent || '';
      inline.replaceWith(code);
    }

    for (const math of [...clone.querySelectorAll('[data-math-source]')]) {
      const source = math.getAttribute('data-math-source');
      if (!source) {
        continue;
      }

      const style = String(math.getAttribute('style') || '');
      const display = math.getAttribute('data-math-display') === 'true'
        || /(?:^|;)\s*display\s*:\s*block\s*(?:;|$)/i.test(style)
        || math.querySelector('.katex-display') instanceof HTMLElement;
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
    if (!role) {
      return null;
    }

    const section = getTurnSection(element);
    const isFallbackSection = section instanceof HTMLElement && element === section;
    if (isFallbackSection) {
      return getFallbackContentRoot(section);
    }

    if (role === 'user') {
      const root = element.querySelector(SELECTORS.userContent);
      return root instanceof HTMLElement ? root : element;
    }

    const root = element.querySelector(SELECTORS.assistantContent);
    return root instanceof HTMLElement ? sanitizeAssistantSnapshot(root) : element;
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

  function getRawSkeletonEntries(scroller) {
    if (!(scroller instanceof HTMLElement)) {
      return [];
    }

    const result = [];
    const seen = new Set();
    for (const element of scroller.querySelectorAll(SELECTORS.turnContainer)) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }

      const id = element.getAttribute('data-turn-id-container');
      if (!id || seen.has(id)) {
        continue;
      }

      seen.add(id);
      result.push({ id, element });
    }
    return result;
  }

  function hasPlaceholderSizing(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const style = String(element.getAttribute('style') || '');
    if (/--(?:last-known-height|estimated-turn-height)\s*:/i.test(style)) {
      return true;
    }

    const className = String(element.getAttribute('class') || '');
    return className.includes('min-h-14')
      || className.includes('last-known-height')
      || className.includes('estimated-turn-height');
  }

  function isLeadingStructuralSkeletonEntry(entry) {
    const element = entry?.element;
    const id = entry?.id;
    if (!(element instanceof HTMLElement) || !id) {
      return false;
    }

    // Historical shared DOM used this explicit non-message root marker.
    if (id === 'client-created-root') {
      return true;
    }

    // Newer shared DOM can assign an ordinary UUID to the same structural root.
    // Keep this deliberately narrow: only a leading, intersecting, childless shell
    // without turn/message/status content or virtual-placeholder geometry qualifies.
    if (element.getAttribute('data-is-intersecting') !== 'true') {
      return false;
    }
    if (element.childElementCount !== 0) {
      return false;
    }
    if (element.matches(SELECTORS.turnSection) || element.querySelector(SELECTORS.turnSection)) {
      return false;
    }
    if (element.querySelector(SELECTORS.roleMessage) || element.querySelector(SELECTORS.transientStatus)) {
      return false;
    }
    if (element.hasAttribute('data-turn') || element.hasAttribute('data-message-id')) {
      return false;
    }
    if (hasPlaceholderSizing(element) || hasMeaningfulSnapshot(element)) {
      return false;
    }

    return true;
  }

  function getSkeletonModel(scroller) {
    const rawEntries = getRawSkeletonEntries(scroller);
    if (rawEntries.length === 0) {
      return {
        rawIds: [],
        structuralIds: [],
        structuralIndexes: [],
        expectedIds: [],
      };
    }

    const structuralIds = [];
    const structuralIndexes = [];
    let inLeadingStructuralPrefix = true;

    for (let index = 0; index < rawEntries.length; index += 1) {
      const entry = rawEntries[index];
      if (inLeadingStructuralPrefix && isLeadingStructuralSkeletonEntry(entry)) {
        structuralIds.push(entry.id);
        structuralIndexes.push(index);
        continue;
      }
      inLeadingStructuralPrefix = false;
    }

    const structuralSet = new Set(structuralIds);
    return {
      rawIds: rawEntries.map((entry) => entry.id),
      structuralIds,
      structuralIndexes,
      expectedIds: rawEntries
        .map((entry) => entry.id)
        .filter((id) => !structuralSet.has(id)),
    };
  }


  function getMountedTurnSections(scroller) {
    if (!(scroller instanceof HTMLElement)) {
      return [];
    }

    return [...scroller.querySelectorAll(SELECTORS.turnSection)]
      .filter((section) => section instanceof HTMLElement);
  }

  function findMountedSectionByTurnId(scroller, turnId) {
    if (!(scroller instanceof HTMLElement) || !turnId) {
      return null;
    }

    return getMountedTurnSections(scroller)
      .find((section) => getTurnId(section) === turnId) || null;
  }

  function classifyMountedTurn(section) {
    const id = getTurnId(section);
    if (!id) {
      return null;
    }

    observedTurnIds.add(id);
    const ordinal = getSectionOrdinal(section);
    if (Number.isFinite(ordinal)) {
      turnOrdinalById.set(id, ordinal);
    }

    const roleMessages = [...section.querySelectorAll(SELECTORS.roleMessage)]
      .filter((element) => element instanceof HTMLElement)
      .filter((element) => getTurnSection(element) === section);

    if (roleMessages.length > 0) {
      standardMessageTurnIds.add(id);
      fallbackMessageTurnIds.delete(id);
      transientTurnIds.delete(id);
      return { id, classification: 'standard-message' };
    }

    if (standardMessageTurnIds.has(id)) {
      return { id, classification: 'standard-message-seen' };
    }

    if (isTransientTurn(section)) {
      transientTurnIds.add(id);
      fallbackMessageTurnIds.delete(id);
      return { id, classification: 'transient-status' };
    }

    const role = getRole(section);
    if (role === 'user' || role === 'assistant') {
      if (getFallbackContentRoot(section) instanceof HTMLElement) {
        fallbackMessageTurnIds.add(id);
        transientTurnIds.delete(id);
        return { id, classification: 'fallback-message' };
      }

      if (fallbackMessageTurnIds.has(id) || transientTurnIds.has(id)) {
        return {
          id,
          classification: fallbackMessageTurnIds.has(id)
            ? 'fallback-message-seen'
            : 'transient-status-seen',
        };
      }

      return { id, classification: 'unresolved-message' };
    }

    return { id, classification: 'unresolved-turn' };
  }

  function observeMountedTurns(scroller, providedSections = null) {
    const sections = Array.isArray(providedSections) ? providedSections : getMountedTurnSections(scroller);
    const ids = [];
    for (const section of sections) {
      const classified = classifyMountedTurn(section);
      if (classified?.id) {
        ids.push(classified.id);
      }
    }
    return ids;
  }

  function getMountedTurnOrdinals(scroller) {
    return getMountedTurnSections(scroller)
      .map(getSectionOrdinal)
      .filter(Number.isFinite)
      .sort((left, right) => left - right);
  }

  function getVisibleMessageIds(scroller) {
    if (!(scroller instanceof HTMLElement)) {
      return [];
    }

    return [...scroller.querySelectorAll(SELECTORS.roleMessage)]
      .map((element) => element.getAttribute('data-message-id') || null)
      .filter(Boolean);
  }

  function getCollectionCoverage(scroller = null) {
    const target = scroller instanceof HTMLElement ? scroller : findScroller();
    if (!(target instanceof HTMLElement)) {
      return null;
    }

    const skeletonModel = getSkeletonModel(target);
    const skeletonIds = skeletonModel.expectedIds;
    observeMountedTurns(target);

    if (skeletonIds.length === 0) {
      return null;
    }

    const expectedSet = new Set(skeletonIds);
    const observedExpectedIds = [...observedTurnIds].filter((id) => expectedSet.has(id));
    const standardExpectedIds = [...standardMessageTurnIds].filter((id) => expectedSet.has(id));
    const fallbackExpectedIds = [...fallbackMessageTurnIds].filter((id) => expectedSet.has(id));
    const transientExpectedIds = [...transientTurnIds].filter((id) => expectedSet.has(id));
    const resolvedSet = new Set([
      ...standardExpectedIds,
      ...fallbackExpectedIds,
      ...transientExpectedIds,
    ]);
    const missingTurnIds = skeletonIds.filter((id) => !observedTurnIds.has(id));
    const unresolvedTurnIds = skeletonIds.filter((id) => observedTurnIds.has(id) && !resolvedSet.has(id));
    const resolvedTurnCount = skeletonIds.length - missingTurnIds.length - unresolvedTurnIds.length;
    const missingTurnSkeletonIndexes = skeletonIds
      .map((id, index) => (observedTurnIds.has(id) ? null : index))
      .filter(Number.isFinite)
      .slice(0, 24);

    return {
      rawSkeletonCount: skeletonModel.rawIds.length,
      structuralTurnCount: skeletonModel.structuralIds.length,
      structuralTurnIds: skeletonModel.structuralIds.slice(0, 24),
      structuralTurnSkeletonIndexes: skeletonModel.structuralIndexes.slice(0, 24),
      expectedTurnCount: skeletonIds.length,
      observedTurnCount: observedExpectedIds.length,
      resolvedTurnCount,
      standardMessageTurnCount: standardExpectedIds.length,
      fallbackMessageTurnCount: fallbackExpectedIds.length,
      transientTurnCount: transientExpectedIds.length,
      missingTurnCount: missingTurnIds.length,
      unresolvedTurnCount: unresolvedTurnIds.length,
      collectionComplete: missingTurnIds.length === 0 && unresolvedTurnIds.length === 0,
      skeletonFingerprint: hashString(skeletonIds.join('|')),
      missingTurnIds: missingTurnIds.slice(0, 24),
      missingTurnSkeletonIndexes,
      transientTurnIds: transientExpectedIds.slice(0, 24),
      transientTurnOrdinals: transientExpectedIds
        .map((id) => turnOrdinalById.get(id))
        .filter(Number.isFinite)
        .sort((left, right) => left - right)
        .slice(0, 24),
      unresolvedTurnIds: unresolvedTurnIds.slice(0, 24),
      unresolvedTurnOrdinals: unresolvedTurnIds
        .map((id) => turnOrdinalById.get(id))
        .filter(Number.isFinite)
        .sort((left, right) => left - right)
        .slice(0, 24),
    };
  }

  function getTopLoaderState(scroller, firstSection) {
    if (!(scroller instanceof HTMLElement) || !(firstSection instanceof HTMLElement)) {
      return { topStatusPresent: false, topStatusText: null };
    }

    for (const status of scroller.querySelectorAll('[role="status"]')) {
      if (!(status instanceof HTMLElement)) {
        continue;
      }

      const style = getComputedStyle(status);
      const hidden = status.hidden
        || status.getAttribute('aria-hidden') === 'true'
        || style.display === 'none'
        || style.visibility === 'hidden'
        || Number.parseFloat(style.opacity || '1') <= 0.05;
      if (hidden) {
        continue;
      }

      const relation = status.compareDocumentPosition(firstSection);
      if ((relation & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) {
        return {
          topStatusPresent: true,
          topStatusText: (status.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160) || null,
        };
      }
    }

    return { topStatusPresent: false, topStatusText: null };
  }

  function getSummary(scroller) {
    const skeletonModel = getSkeletonModel(scroller);
    const skeletonIds = skeletonModel.expectedIds;
    const mountedTurnIds = observeMountedTurns(scroller);
    const mountedOrdinals = getMountedTurnOrdinals(scroller);
    const visibleMessageIds = getVisibleMessageIds(scroller);
    const coverage = getCollectionCoverage(scroller);
    const expectedTurnCount = skeletonIds.length;
    const expectedFirstTurnId = skeletonIds[0] || null;
    const expectedLastTurnId = skeletonIds.length > 0 ? skeletonIds[skeletonIds.length - 1] : null;
    const firstSection = findMountedSectionByTurnId(scroller, expectedFirstTurnId);
    const lastSection = findMountedSectionByTurnId(scroller, expectedLastTurnId);
    const firstTurnOrdinal = getSectionOrdinal(firstSection);
    const lastTurnOrdinal = getSectionOrdinal(lastSection);
    const topStatus = getTopLoaderState(scroller, firstSection);
    const roleNodes = [...scroller.querySelectorAll(SELECTORS.roleMessage)];
    let userMessages = 0;
    let assistantMessages = 0;
    for (const element of roleNodes) {
      const role = getRole(element);
      if (role === 'user') {
        userMessages += 1;
      } else if (role === 'assistant') {
        assistantMessages += 1;
      }
    }

    return {
      layoutVariant: 'shared-public',
      signature: `shared:${expectedTurnCount}:${hashString(skeletonIds.join('|'))}:${mountedOrdinals.join(',')}`,
      skeletonFingerprint: hashString(skeletonIds.join('|')),
      rawSkeletonCount: skeletonModel.rawIds.length,
      structuralTurnCount: skeletonModel.structuralIds.length,
      structuralTurnIds: skeletonModel.structuralIds.slice(0, 24),
      structuralTurnSkeletonIndexes: skeletonModel.structuralIndexes.slice(0, 24),
      expectedTurnCount,
      observedTurnCount: coverage?.observedTurnCount ?? null,
      resolvedTurnCount: coverage?.resolvedTurnCount ?? null,
      standardMessageTurnCount: coverage?.standardMessageTurnCount ?? null,
      fallbackMessageTurnCount: coverage?.fallbackMessageTurnCount ?? null,
      transientTurnCount: coverage?.transientTurnCount ?? null,
      transientTurnIds: coverage?.transientTurnIds ?? [],
      transientTurnOrdinals: coverage?.transientTurnOrdinals ?? [],
      missingTurnCount: coverage?.missingTurnCount ?? null,
      missingTurnIds: coverage?.missingTurnIds ?? [],
      missingTurnSkeletonIndexes: coverage?.missingTurnSkeletonIndexes ?? [],
      unresolvedTurnCount: coverage?.unresolvedTurnCount ?? null,
      unresolvedTurnIds: coverage?.unresolvedTurnIds ?? [],
      unresolvedTurnOrdinals: coverage?.unresolvedTurnOrdinals ?? [],
      collectionComplete: coverage?.collectionComplete ?? null,
      mountedTurnCount: mountedTurnIds.length,
      mountedMessageCount: roleNodes.length,
      placeholderCount: Math.max(0, expectedTurnCount - mountedTurnIds.length),
      mountedTurnOrdinals: mountedOrdinals,
      minMountedOrdinal: mountedOrdinals.length > 0 ? mountedOrdinals[0] : null,
      maxMountedOrdinal: mountedOrdinals.length > 0 ? mountedOrdinals[mountedOrdinals.length - 1] : null,
      visibleMessageIds,
      userMessages,
      assistantMessages,
      firstTurnPresent: firstSection instanceof HTMLElement,
      lastTurnPresent: lastSection instanceof HTMLElement,
      expectedFirstTurnId,
      expectedLastTurnId,
      firstTurnOrdinal: Number.isFinite(firstTurnOrdinal) ? firstTurnOrdinal : null,
      lastTurnOrdinal: Number.isFinite(lastTurnOrdinal) ? lastTurnOrdinal : null,
      topStatusPresent: topStatus.topStatusPresent,
      topStatusText: topStatus.topStatusText,
      dataScrollFromEnd: scroller.hasAttribute('data-scroll-from-end'),
    };
  }

  function getBoundaryState(scroller, kind) {
    if (!(scroller instanceof HTMLElement)) {
      return null;
    }

    const range = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const expected = kind === 'top' ? 0 : range;
    const atBoundary = Math.abs(scroller.scrollTop - expected) <= 2;
    const summary = getSummary(scroller);
    const semanticMarkerPresent = kind === 'top'
      ? summary.firstTurnPresent && !summary.topStatusPresent
      : summary.lastTurnPresent;

    return {
      reached: atBoundary && semanticMarkerPresent,
      atBoundary,
      scrollMode: 'normal',
      scrollTop: Math.round(scroller.scrollTop),
      scrollRange: range,
      expectedScrollTop: Math.round(expected),
      semanticMarkerPresent,
      ...summary,
    };
  }

  profiles.shared = Object.freeze({
    id: 'shared',
    variant: 'shared-public',
    scrollMode: 'normal',
    scrollerLabel: 'ChatGPT shared conversation',
    selectors: SELECTORS,

    detect() {
      let score = 0;
      if (location.pathname.startsWith('/share/')) {
        score += 60;
      }
      if (document.querySelector(SELECTORS.scroller)) {
        score += 25;
      }
      if (document.querySelector(SELECTORS.turnContainer)) {
        score += 15;
      }
      if (document.querySelector(SELECTORS.roleMessage)) {
        score += 10;
      }
      return score;
    },

    findScroller,
    getVisibleMessages,
    getMessageId,
    getMessageOrderKey: getTurnOrdinal,
    getMessageQualityRank,
    getMessageRole: getRole,
    getMessageTimestamp() {
      return null;
    },
    getMessageContentRoot,
    getCollectionCoverage,
    getHistoryStartState(scroller) {
      return getBoundaryState(scroller, 'top');
    },
    getHistoryEndState(scroller) {
      return getBoundaryState(scroller, 'bottom');
    },
  });
})();
