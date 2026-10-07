(() => {
  'use strict';

  const app = globalThis.__chatContextExporter;
  const registry = app?.modules.adapterRegistry;
  const profiles = app?.modules.chatGptProfiles;

  if (!registry) {
    throw new Error('Chat Context Exporter: adapter registry is not initialized.');
  }
  if (!profiles?.shared || !profiles?.thread) {
    throw new Error('Chat Context Exporter: ChatGPT profiles are not initialized.');
  }

  function isChatGptHost() {
    return location.hostname === 'chatgpt.com'
      || location.hostname.endsWith('.chatgpt.com')
      || location.hostname === 'chat.openai.com';
  }

  function isThreadPath() {
    return /(?:^|\/)c\/[^/?#]+\/?$/i.test(location.pathname);
  }

  function selectProfile() {
    if (location.pathname.startsWith('/share/')) {
      return profiles.shared;
    }

    if (isThreadPath()) {
      return profiles.thread;
    }

    const ranked = [profiles.thread, profiles.shared]
      .map((profile) => ({ profile, score: Number(profile.detect?.()) || 0 }))
      .sort((left, right) => right.score - left.score);

    return ranked[0]?.score > 0 ? ranked[0].profile : null;
  }

  const activeProfile = selectProfile();

  function delegate(method, fallback = null) {
    return (...args) => {
      const fn = activeProfile?.[method];
      return typeof fn === 'function' ? fn.apply(activeProfile, args) : fallback;
    };
  }

  registry.register({
    id: 'chatgpt',
    displayName: 'ChatGPT',
    scrollerLabel: activeProfile?.scrollerLabel || 'ChatGPT conversation',
    supportsMessageCollection: activeProfile?.supportsMessageCollection !== false,
    acquisitionMode: activeProfile?.acquisitionMode || null,
    panelFields: activeProfile?.panelFields || Object.freeze({}),
    variant: activeProfile?.variant || 'unknown',
    parseEvent: activeProfile?.parseEvent || null,
    scrollMode: activeProfile?.scrollMode || 'normal',
    selectors: activeProfile?.selectors || Object.freeze({}),

    detect() {
      if (!isChatGptHost()) {
        return 0;
      }

      let score = 50;
      if (location.pathname.startsWith('/share/')) {
        score += 40;
      } else if (isThreadPath()) {
        score += 25;
      }
      score += Math.min(40, Number(activeProfile?.detect?.()) || 0);
      return score;
    },

    findScroller: delegate('findScroller'),
    getVisibleMessages: delegate('getVisibleMessages', []),
    getMessageId: delegate('getMessageId'),
    getMessageOrderKey: delegate('getMessageOrderKey'),
    getMessageQualityRank: delegate('getMessageQualityRank'),
    getMessageRole: delegate('getMessageRole'),
    getMessageTimestamp: delegate('getMessageTimestamp'),
    getConversationStartTimestamp: delegate('getConversationStartTimestamp'),
    getMessageContentRoot: delegate('getMessageContentRoot'),
    getCollectionCoverage: delegate('getCollectionCoverage'),
    getHistoryStartState: delegate('getHistoryStartState'),
    getHistoryEndState: delegate('getHistoryEndState'),
    getNetworkCaptureConfig: delegate('getNetworkCaptureConfig'),
    capturePreReloadTailSnapshot: delegate('capturePreReloadTailSnapshot'),
    parseNetworkCaptures: delegate('parseNetworkCaptures'),

    isHistoryStartReached(scroller) {
      return this.getHistoryStartState(scroller)?.reached ?? false;
    },
  });
})();
