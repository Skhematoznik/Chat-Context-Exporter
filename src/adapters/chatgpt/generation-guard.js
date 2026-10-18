(() => {
  'use strict';

  const STOP_LABELS = new Set(['Остановить', 'Stop generating', 'Stop']);

  // Only inspect the DOM. Never click Stop/Retry or access browser credentials.
  // ChatGPT keeps duplicate composer trees mounted in inactive workspaces.
  // A hidden Stop button must not block export for up to generationWaitSeconds.
  function isVisibleStopButton(button) {
    if (button.disabled || button.isConnected === false) return false;
    if (button.closest?.('[hidden], [aria-hidden="true"], [inert]')) return false;

    // Layout geometry detects an ancestor's `display: none` (including !important),
    // unlike checking button.hidden or button.closest('[hidden]') alone.
    if (typeof button.getClientRects !== 'function') return false;
    const rects = button.getClientRects();
    if (!rects || !Array.from(rects).some((rect) => rect.width > 0 && rect.height > 0)) return false;

    const win = button.ownerDocument?.defaultView;
    const visibility = win?.getComputedStyle?.(button)?.visibility;
    if (visibility === 'hidden' || visibility === 'collapse') return false;
    return true;
  }

  function isGenerating(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return false;
    for (const button of doc.querySelectorAll('button[aria-label], button[data-testid="stop-button"]')) {
      const label = button.getAttribute?.('aria-label')?.trim();
      const testId = button.getAttribute?.('data-testid');
      if (!STOP_LABELS.has(label) && testId !== 'stop-button') continue;
      if (!isVisibleStopButton(button)) continue;
      return true;
    }
    return false;
  }

  globalThis.__chatContextExporterGenerationGuard = Object.freeze({isGenerating});
})();
