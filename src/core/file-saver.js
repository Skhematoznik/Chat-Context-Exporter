(() => {
  'use strict';

  const app = globalThis.__chatContextExporter;
  const logger = app?.modules.logger;

  if (!app || !logger) {
    throw new Error('Chat Context Exporter: file saver dependencies are not initialized.');
  }

  const AUTO_SAVE_TIMEOUT_MS = 15_000;
  const MANUAL_SAVE_TIMEOUT_MS = 300_000;
  const AUTO_SAVE_MAX_ATTEMPTS = 3;
  const RETRY_BASE_DELAY_MS = 500;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function createRequestId() {
    if (typeof crypto?.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `cce-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function withTimeout(promise, timeoutMs, message) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });

    return Promise.race([promise, timeout]).finally(() => {
      if (timer !== null) {
        clearTimeout(timer);
      }
    });
  }

  async function saveTextFile({
    filename,
    content,
    mimeType,
    saveAs = false,
    requestId = null,
    onAttempt = null,
  }) {
    const stableRequestId = requestId || createRequestId();
    const manual = Boolean(saveAs);
    const maxAttempts = manual ? 1 : AUTO_SAVE_MAX_ATTEMPTS;
    const timeoutMs = manual ? MANUAL_SAVE_TIMEOUT_MS : AUTO_SAVE_TIMEOUT_MS;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      onAttempt?.({
        attempt,
        maxAttempts,
        timeoutMs,
        requestId: stableRequestId,
      });

      try {
        const response = await withTimeout(
          chrome.runtime.sendMessage({
            type: logger.SAVE_FILE_MESSAGE,
            requestId: stableRequestId,
            filename,
            content,
            mimeType,
            saveAs: manual,
          }),
          timeoutMs,
          `Истекло время ожидания сохранения файла (${Math.ceil(timeoutMs / 1000)} с).`,
        );

        if (!response?.ok) {
          throw new Error(response?.error || 'Service worker отклонил сохранение файла.');
        }

        return {
          ...response,
          requestId: stableRequestId,
          attempt,
          maxAttempts,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt >= maxAttempts) {
          break;
        }
        await sleep(RETRY_BASE_DELAY_MS * attempt);
      }
    }

    throw lastError || new Error('Не удалось сохранить файл.');
  }

  app.modules.fileSaver = {
    saveTextFile,
    createRequestId,
  };
})();
