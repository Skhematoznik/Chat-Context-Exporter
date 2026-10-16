(() => {
  'use strict';

  const STOP_LABELS = new Set(['Остановить', 'Stop generating', 'Stop']);

  // Only inspect the DOM. Never click Stop/Retry or access browser credentials.
  function isGenerating(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return false;
    for (const button of doc.querySelectorAll('button[aria-label], button[data-testid="stop-button"]')) {
      const label = button.getAttribute?.('aria-label')?.trim();
      const testId = button.getAttribute?.('data-testid');
      if (!STOP_LABELS.has(label) && testId !== 'stop-button') continue;
      if (button.disabled || button.closest?.('[hidden], [aria-hidden="true"]')) continue;
      return true;
    }
    return false;
  }

  globalThis.__chatContextExporterGenerationGuard = Object.freeze({isGenerating});
})();
