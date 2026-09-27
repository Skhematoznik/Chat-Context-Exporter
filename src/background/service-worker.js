'use strict';

const CONTENT_SCRIPTS = [
  'src/core/namespace.js',
  'src/core/settings.js',
  'src/core/logger.js',
  'src/core/file-saver.js',
  'src/core/scroller.js',
  'src/core/collector.js',
  'src/core/dom/rich-text-parser.js',
  'src/adapters/registry.js',
  'src/adapters/generic-adapter.js',
  'src/adapters/grok-adapter.js',
  'src/exporters/markdown-exporter.js',
  'src/ui/panel.js',
  'src/content/start.js',
];

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) {
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: CONTENT_SCRIPTS,
    });
  } catch (error) {
    console.error('Chat Context Exporter: не удалось запустить content scripts.', error);

    await chrome.action.setBadgeText({
      tabId: tab.id,
      text: 'ERR',
    });

    await chrome.action.setBadgeBackgroundColor({
      tabId: tab.id,
      color: '#d6008f',
    });

    setTimeout(() => {
      chrome.action.setBadgeText({ tabId: tab.id, text: '' }).catch(() => {});
    }, 3000);
  }
});

const SAVE_FILE_MESSAGE = 'chat-context-exporter:save-file';
const ALLOWED_TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/html',
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== SAVE_FILE_MESSAGE) {
    return false;
  }

  const filename = typeof message.filename === 'string' ? message.filename : '';
  const content = typeof message.content === 'string' ? message.content : '';
  const requestedMimeType = typeof message.mimeType === 'string'
    ? message.mimeType.toLowerCase()
    : 'text/plain';
  const mimeType = ALLOWED_TEXT_MIME_TYPES.has(requestedMimeType)
    ? requestedMimeType
    : 'text/plain';
  const saveAs = message.saveAs === true;

  if (!filename || !content) {
    sendResponse({ ok: false, error: 'Некорректные данные для сохранения файла.' });
    return false;
  }

  const dataUrl = `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`;

  chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs,
    conflictAction: 'uniquify',
  })
    .then((downloadId) => {
      sendResponse({ ok: true, downloadId });
    })
    .catch((error) => {
      console.error('Chat Context Exporter: не удалось сохранить файл.', error);
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });

  return true;
});
