(() => {
  'use strict';

  const app = globalThis.__chatContextExporter;
  if (!app) {
    throw new Error('Chat Context Exporter: namespace is not initialized.');
  }

  const DEFAULT_SETTINGS = Object.freeze({
    autoSave: true,
    saveLog: false,
    autoClosePanel: true,
    extraPassesEnabled: false,
    extraPassCount: 1,
    generationWaitSeconds: 300,
    errorRetryCount: 10,
    errorRetryBaseSeconds: 10,
    minDelayMs: 3000,
    maxDelayMs: 5000,
  });

  function clampDelay(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }

    return Math.min(60_000, Math.max(100, Math.round(parsed)));
  }

  function clampExtraPassCount(value, fallback = DEFAULT_SETTINGS.extraPassCount) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }

    return Math.min(3, Math.max(1, Math.round(parsed)));
  }

  function clampGenerationWaitSeconds(value, fallback = DEFAULT_SETTINGS.generationWaitSeconds) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(3600, Math.max(30, Math.round(parsed)));
  }

  function clampErrorRetryCount(value, fallback = DEFAULT_SETTINGS.errorRetryCount) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(25, Math.max(1, Math.round(number))) : fallback;
  }

  function clampErrorRetryBaseSeconds(value, fallback = DEFAULT_SETTINGS.errorRetryBaseSeconds) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(60, Math.max(1, Math.round(number))) : fallback;
  }

  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
      return {
        ...DEFAULT_SETTINGS,
        ...stored,
        autoSave: typeof stored.autoSave === 'boolean' ? stored.autoSave : DEFAULT_SETTINGS.autoSave,
        saveLog: typeof stored.saveLog === 'boolean' ? stored.saveLog : DEFAULT_SETTINGS.saveLog,
        autoClosePanel: typeof stored.autoClosePanel === 'boolean'
          ? stored.autoClosePanel
          : DEFAULT_SETTINGS.autoClosePanel,
        extraPassesEnabled: typeof stored.extraPassesEnabled === 'boolean'
          ? stored.extraPassesEnabled
          : DEFAULT_SETTINGS.extraPassesEnabled,
        extraPassCount: clampExtraPassCount(stored.extraPassCount),
        generationWaitSeconds: clampGenerationWaitSeconds(stored.generationWaitSeconds),
        errorRetryCount: clampErrorRetryCount(stored.errorRetryCount),
        errorRetryBaseSeconds: clampErrorRetryBaseSeconds(stored.errorRetryBaseSeconds),
        minDelayMs: clampDelay(stored.minDelayMs, DEFAULT_SETTINGS.minDelayMs),
        maxDelayMs: clampDelay(stored.maxDelayMs, DEFAULT_SETTINGS.maxDelayMs),
      };
    } catch (error) {
      return { ...DEFAULT_SETTINGS };
    }
  }

  app.modules.settings = {
    DEFAULT_SETTINGS,
    clampDelay,
    clampExtraPassCount,
    clampGenerationWaitSeconds,
    clampErrorRetryCount,
    clampErrorRetryBaseSeconds,
    loadSettings,
  };
})();
