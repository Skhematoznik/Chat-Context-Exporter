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

  // Also match the observed ChatGPT delivery-timeout alert (Russian locale).
  // This is an error state, not the end-of-history or a rate-limit banner.
  const DELIVERY_FAILURE_RE = /(?:время\s+ожидания\s+доставки\s+сообщения\s+истекло|истекло\s+время\s+ожидания\s+доставки\s+сообщения|message\s+delivery\s+(?:has\s+)?timed\s+out|ответ\s+не\s+доставлен|не\s+удалось\s+(?:доставить|получить|сгенерировать)\s+ответ|failed to (?:get|generate|deliver) (?:a |the )?response|there was an error generating (?:a |the )?response)/i;

  function hasDeliveryFailure(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return false;
    // Only current visible error/alert UI, never historical chat messages or
    // arbitrary text quoted by the user in the transcript.
    for (const element of doc.querySelectorAll('[role="alert"], [data-sonner-toast], [data-testid*="error"], [data-testid*="toast"]')) {
      if (element.closest?.('article, [data-message-id], [data-testid^="conversation-turn"]')) continue;
      if (!DELIVERY_FAILURE_RE.test(element.textContent || '')) continue;
      if (element.closest?.('[hidden], [aria-hidden="true"], [inert]')) continue;
      if (typeof element.getClientRects !== 'function'
          || !Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0)) continue;
      const visibility = element.ownerDocument?.defaultView?.getComputedStyle?.(element)?.visibility;
      if (visibility === 'hidden' || visibility === 'collapse') continue;
      return true;
    }
    return false;
  }

  // A ChatGPT conversation-limit banner can supply an authoritative DOM tail
  // captured before the first reload. If the same user/assistant tail remains
  // visible after a transient Stop, the accepted first page is not stale at
  // the boundary that matters: the existing exporter uses that authoritative
  // DOM answer instead of the network copy. Fail closed on absent evidence.
  function isAuthoritativeLimitTailUnchanged(original, fresh) {
    if (!original || original.captured !== true || original.authoritative !== true
        || original.reason !== 'conversation-limit' || !fresh
        || fresh.authoritative !== true || fresh.reason !== 'conversation-limit') return false;
    if (!original.conversationId || original.conversationId !== fresh.conversationId) return false;
    const oldUser = original.user || {
      messageId: original.userMessageId, turnKey: original.userTurnKey, hash: original.userHash,
    };
    const freshUser = fresh.user || {};
    if (!oldUser.messageId || oldUser.messageId !== freshUser.messageId) return false;
    if (!oldUser.turnKey || oldUser.turnKey !== freshUser.turnKey) return false;
    if (!oldUser.hash || oldUser.hash !== freshUser.hash) return false;
    if (!original.assistantHash || original.assistantHash !== fresh.assistant?.hash) return false;
    if (!Number.isInteger(original.assistantChars) || original.assistantChars <= 0
        || original.assistantChars !== fresh.assistant?.markdown?.length) return false;
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

  globalThis.__chatContextExporterGenerationGuard = Object.freeze({isGenerating, hasDeliveryFailure, isAuthoritativeLimitTailUnchanged});
})();
