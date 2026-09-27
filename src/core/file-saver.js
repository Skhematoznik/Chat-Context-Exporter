(() => {
  'use strict';

  const app = globalThis.__chatContextExporter;
  const logger = app?.modules.logger;

  if (!app || !logger) {
    throw new Error('Chat Context Exporter: file saver dependencies are not initialized.');
  }

  async function saveTextFile({ filename, content, mimeType, saveAs = false }) {
    const response = await chrome.runtime.sendMessage({
      type: logger.SAVE_FILE_MESSAGE,
      filename,
      content,
      mimeType,
      saveAs: Boolean(saveAs),
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Service worker отклонил сохранение файла.');
    }

    return response;
  }

  app.modules.fileSaver = {
    saveTextFile,
  };
})();
