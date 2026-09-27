(() => {
  'use strict';

  const app = globalThis.__chatContextExporter;
  const registry = app?.modules.adapterRegistry;
  const scroller = app?.modules.scroller;

  if (!registry || !scroller) {
    throw new Error('Chat Context Exporter: adapter dependencies are not initialized.');
  }

  registry.register({
    id: 'generic',
    displayName: 'Универсальный DOM',
    supportsMessageCollection: false,

    detect() {
      return 1;
    },

    findScroller() {
      return scroller.findGenericScrollContainer();
    },

    getVisibleMessages() {
      return [];
    },

    getMessageId() {
      return null;
    },

    getMessageRole() {
      return null;
    },

    getMessageTimestamp() {
      return null;
    },

    getMessageContentRoot() {
      return null;
    },

    isHistoryStartReached() {
      return null;
    },
  });
})();
