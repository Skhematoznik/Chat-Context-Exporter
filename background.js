const SUPPORTED_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);
const DEFAULT_SETTINGS = Object.freeze({
  autoSaveExport: true,
  saveDiagnosticLog: false,
  useDomBackup: false
});

const MENU_AUTO_SAVE = "chat-context-exporter:auto-save";
const MENU_LOG = "chat-context-exporter:save-log";

chrome.runtime.onInstalled.addListener(async () => {
  await ensureSettings();
  await rebuildContextMenus();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureSettings();
  await rebuildContextMenus();
});

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.autoSaveExport || changes.saveDiagnosticLog || changes.useDomBackup) {
    await syncContextMenus();
  }
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === MENU_AUTO_SAVE) {
    await chrome.storage.local.set({ autoSaveExport: Boolean(info.checked) });
    return;
  }
  if (info.menuItemId === MENU_LOG) {
    await chrome.storage.local.set({ saveDiagnosticLog: Boolean(info.checked) });
    return;
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url) return;

  let url;
  try {
    url = new URL(tab.url);
  } catch {
    return;
  }

  if (url.protocol !== "https:" || !SUPPORTED_HOSTS.has(url.hostname)) {
    await showTemporaryBadge(tab.id, "!", "#b91c1c", "Откройте чат на chatgpt.com");
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["conversation-source.js", "exporter.js"]
    });

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const exporter = globalThis.__ChatGPTConversationExporter;
        if (!exporter) throw new Error("Экспортер не инициализирован");
        exporter.start();
      }
    });
  } catch (error) {
    console.error("Chat Context Exporter:", error);
    await showTemporaryBadge(tab.id, "ERR", "#b91c1c", "Не удалось запустить экспорт");
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "chat-context-exporter:download-text") return false;

  downloadText(message)
    .then(result => sendResponse({ ok: true, ...result }))
    .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});

async function ensureSettings() {
  const current = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const patch = {};
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (typeof current[key] !== typeof value) patch[key] = value;
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  return { ...DEFAULT_SETTINGS, ...current, ...patch };
}

async function rebuildContextMenus() {
  try { await chrome.contextMenus.removeAll(); } catch {}
  const settings = await ensureSettings();

  chrome.contextMenus.create({
    id: MENU_AUTO_SAVE,
    title: "Автоматически сохранять экспорт",
    type: "checkbox",
    checked: Boolean(settings.autoSaveExport),
    contexts: ["action"]
  });
  chrome.contextMenus.create({
    id: MENU_LOG,
    title: "Сохранять диагностический лог (Downloads)",
    type: "checkbox",
    checked: Boolean(settings.saveDiagnosticLog),
    contexts: ["action"]
  });
}

async function syncContextMenus() {
  const settings = await ensureSettings();
  try { await chrome.contextMenus.update(MENU_AUTO_SAVE, { checked: Boolean(settings.autoSaveExport) }); } catch {}
  try { await chrome.contextMenus.update(MENU_LOG, { checked: Boolean(settings.saveDiagnosticLog) }); } catch {}
}

async function downloadText({ filename, content, mimeType = "text/plain", saveAs = false }) {
  if (!filename || typeof content !== "string") throw new Error("Некорректные параметры сохранения");
  const dataUrl = `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`;
  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: Boolean(saveAs),
    conflictAction: "uniquify"
  });
  return { downloadId };
}

async function showTemporaryBadge(tabId, text, color, title) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeText({ tabId, text });
    if (title) await chrome.action.setTitle({ tabId, title });
    setTimeout(async () => {
      try {
        await chrome.action.setBadgeText({ tabId, text: "" });
        await chrome.action.setTitle({ tabId, title: "Экспортировать контекст чата" });
      } catch {}
    }, 3500);
  } catch {}
}
