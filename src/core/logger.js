(() => {
  'use strict';

  const app = globalThis.__chatContextExporter;
  if (!app) {
    throw new Error('Chat Context Exporter: namespace is not initialized.');
  }

  const SAVE_FILE_MESSAGE = 'chat-context-exporter:save-file';

  function formatLocalTimestamp(date = new Date()) {
    const pad = (value, width = 2) => String(value).padStart(width, '0');
    const offsetMinutes = -date.getTimezoneOffset();
    const offsetSign = offsetMinutes >= 0 ? '+' : '-';
    const offsetAbs = Math.abs(offsetMinutes);
    const offsetHours = pad(Math.floor(offsetAbs / 60));
    const offsetRemainder = pad(offsetAbs % 60);

    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
      + `.${pad(date.getMilliseconds(), 3)}${offsetSign}${offsetHours}:${offsetRemainder}`;
  }

  function formatFilenameTimestamp(date = new Date()) {
    const pad = (value, width = 2) => String(value).padStart(width, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      + `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  }

  function sanitizePageUrl() {
    try {
      const url = new URL(window.location.href);
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return window.location.href.split('#', 1)[0].split('?', 1)[0];
    }
  }

  function stringifyLogValue(value) {
    if (value === undefined) {
      return 'undefined';
    }
    if (value === null) {
      return 'null';
    }
    if (typeof value === 'string') {
      return value.replace(/[\r\n]+/g, ' ');
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }

    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  function formatDuration(milliseconds) {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return [hours, minutes, seconds]
      .map((value) => String(value).padStart(2, '0'))
      .join(':');
  }

  function createLogger({ getSettings, startedAt }) {
    const lines = [];
    let savePromise = null;

    function write(event, details = null) {
      const suffix = details && typeof details === 'object'
        ? Object.entries(details)
          .map(([key, value]) => `${key}=${stringifyLogValue(value)}`)
          .join('; ')
        : details == null
          ? ''
          : stringifyLogValue(details);

      lines.push(
        `[${formatLocalTimestamp()}] ${event}${suffix ? ` | ${suffix}` : ''}`,
      );
    }

    async function saveOnce(finalState) {
      if (savePromise) {
        return savePromise;
      }

      savePromise = (async () => {
        const settings = await getSettings();
        if (!settings.saveLog) {
          return;
        }

        const durationMs = Date.now() - startedAt;
        write('FINAL', {
          state: finalState,
          durationMs,
          duration: formatDuration(durationMs),
        });

        const header = [
          'Chat Context Exporter',
          'Technical log',
          `Page: ${sanitizePageUrl()}`,
          `Generated: ${formatLocalTimestamp()}`,
          '',
        ];

        const content = `${header.join('\r\n')}${lines.join('\r\n')}\r\n`;
        const filename = `Chat-Context-Exporter_${formatFilenameTimestamp()}.txt`;

        try {
          const response = await chrome.runtime.sendMessage({
            type: SAVE_FILE_MESSAGE,
            filename,
            content,
            mimeType: 'text/plain',
            saveAs: false,
          });

          if (!response?.ok) {
            throw new Error(response?.error || 'Service worker отклонил сохранение лога.');
          }
        } catch (error) {
          console.error('Chat Context Exporter: не удалось сохранить лог.', error);
        }
      })();

      return savePromise;
    }

    return {
      write,
      saveOnce,
      formatDuration,
    };
  }

  app.modules.logger = {
    SAVE_FILE_MESSAGE,
    createLogger,
    formatDuration,
    formatLocalTimestamp,
    sanitizePageUrl,
  };
})();
