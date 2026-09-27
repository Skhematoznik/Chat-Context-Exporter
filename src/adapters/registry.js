(() => {
  'use strict';

  const app = globalThis.__chatContextExporter;
  if (!app) {
    throw new Error('Chat Context Exporter: namespace is not initialized.');
  }

  function register(adapter) {
    if (!adapter?.id || typeof adapter.detect !== 'function') {
      throw new Error('Chat Context Exporter: invalid chat adapter.');
    }

    const existingIndex = app.adapters.findIndex((item) => item.id === adapter.id);
    if (existingIndex >= 0) {
      app.adapters[existingIndex] = adapter;
      return;
    }

    app.adapters.push(adapter);
  }

  function detect() {
    const ranked = app.adapters
      .map((adapter) => {
        let score = 0;
        try {
          score = Number(adapter.detect()) || 0;
        } catch (error) {
          console.warn(`Chat Context Exporter: ошибка detect() адаптера ${adapter.id}.`, error);
        }
        return { adapter, score };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score);

    return ranked[0] || null;
  }

  app.modules.adapterRegistry = {
    register,
    detect,
  };
})();
