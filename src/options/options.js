'use strict';

const DEFAULT_SETTINGS = Object.freeze({
  autoSave: true,
  saveLog: false,
  autoClosePanel: true,
  extraPassesEnabled: false,
  extraPassCount: 1,
  minDelayMs: 100,
  maxDelayMs: 1000,
});

const SETTING_KEYS = Object.freeze(Object.keys(DEFAULT_SETTINGS));

const elements = {
  autoSave: document.querySelector('#autoSave'),
  saveLog: document.querySelector('#saveLog'),
  autoClosePanel: document.querySelector('#autoClosePanel'),
  extraPassesEnabled: document.querySelector('#extraPassesEnabled'),
  extraPassCount: document.querySelector('#extraPassCount'),
  extraPassCountRow: document.querySelector('#extraPassCountRow'),
  minDelayMs: document.querySelector('#minDelayMs'),
  maxDelayMs: document.querySelector('#maxDelayMs'),
  reset: document.querySelector('#reset'),
  message: document.querySelector('#message'),
};

let messageTimer = null;
let initialized = false;
const delayedSaveTimers = new Map();

function showMessage(text) {
  if (messageTimer !== null) {
    window.clearTimeout(messageTimer);
  }

  elements.message.textContent = text;

  messageTimer = window.setTimeout(() => {
    if (elements.message.textContent === text) {
      elements.message.textContent = 'Изменения применяются автоматически.';
    }
    messageTimer = null;
  }, 1800);
}

function clampNumber(value, min, max, fallback) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(numericValue)));
}

function readDelayValue(value, fallback) {
  return clampNumber(value, 100, 60_000, fallback);
}

function readExtraPassCount(value) {
  return clampNumber(value, 1, 3, DEFAULT_SETTINGS.extraPassCount);
}

function normalizeStoredSettings(stored) {
  return {
    autoSave: typeof stored.autoSave === 'boolean'
      ? stored.autoSave
      : DEFAULT_SETTINGS.autoSave,
    saveLog: typeof stored.saveLog === 'boolean'
      ? stored.saveLog
      : DEFAULT_SETTINGS.saveLog,
    autoClosePanel: typeof stored.autoClosePanel === 'boolean'
      ? stored.autoClosePanel
      : DEFAULT_SETTINGS.autoClosePanel,
    extraPassesEnabled: typeof stored.extraPassesEnabled === 'boolean'
      ? stored.extraPassesEnabled
      : DEFAULT_SETTINGS.extraPassesEnabled,
    extraPassCount: readExtraPassCount(stored.extraPassCount),
    minDelayMs: readDelayValue(stored.minDelayMs, DEFAULT_SETTINGS.minDelayMs),
    maxDelayMs: readDelayValue(stored.maxDelayMs, DEFAULT_SETTINGS.maxDelayMs),
  };
}

function updateExtraPassControls(enabled) {
  elements.extraPassCount.disabled = !enabled;
  elements.extraPassCountRow.classList.toggle('disabled', !enabled);
}

function render(settings) {
  elements.autoSave.checked = settings.autoSave;
  elements.saveLog.checked = settings.saveLog;
  elements.autoClosePanel.checked = settings.autoClosePanel;
  elements.extraPassesEnabled.checked = settings.extraPassesEnabled;
  elements.extraPassCount.value = String(settings.extraPassCount);
  elements.minDelayMs.value = String(settings.minDelayMs);
  elements.maxDelayMs.value = String(settings.maxDelayMs);
  updateExtraPassControls(settings.extraPassesEnabled);
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(SETTING_KEYS);
  const settings = normalizeStoredSettings(stored);
  render(settings);
  return settings;
}

async function saveSetting(key, value) {
  await chrome.storage.local.set({ [key]: value });
  const stored = await chrome.storage.local.get([key]);
  if (stored[key] !== value) {
    throw new Error(`Не удалось подтвердить сохранение параметра ${key}.`);
  }
  showMessage('Сохранено автоматически.');
}

async function saveNumberSetting(key, element, { min, max, fallback, forceClamp = false }) {
  const numericValue = Number(element.value);
  if (!Number.isFinite(numericValue)) {
    return false;
  }

  if (!forceClamp && (numericValue < min || numericValue > max)) {
    return false;
  }

  const value = clampNumber(numericValue, min, max, fallback);
  await chrome.storage.local.set({ [key]: value });
  if (forceClamp || value !== numericValue) {
    element.value = String(value);
  }
  showMessage('Сохранено автоматически.');
  return true;
}

function scheduleNumberSave(key, element, options) {
  const existingTimer = delayedSaveTimers.get(key);
  if (existingTimer !== undefined) {
    window.clearTimeout(existingTimer);
  }

  const timer = window.setTimeout(() => {
    delayedSaveTimers.delete(key);
    saveNumberSetting(key, element, options)
      .catch((error) => handleError(error, 'Ошибка сохранения числовой настройки.'));
  }, 350);

  delayedSaveTimers.set(key, timer);
}

function clearDelayedSaveTimers() {
  for (const timer of delayedSaveTimers.values()) {
    window.clearTimeout(timer);
  }
  delayedSaveTimers.clear();
}

function handleError(error, message) {
  showMessage(message);
}

function attachHandlers() {
  const toggles = [
    ['autoSave', elements.autoSave],
    ['saveLog', elements.saveLog],
    ['autoClosePanel', elements.autoClosePanel],
    ['extraPassesEnabled', elements.extraPassesEnabled],
  ];

  for (const [key, element] of toggles) {
    element.addEventListener('change', () => {
      if (!initialized) {
        return;
      }

      if (key === 'extraPassesEnabled') {
        updateExtraPassControls(element.checked);
      }

      saveSetting(key, element.checked)
        .catch((error) => handleError(error, 'Ошибка сохранения настройки.'));
    });
  }

  const numberFields = [
    ['minDelayMs', elements.minDelayMs, {
      min: 100,
      max: 60_000,
      fallback: DEFAULT_SETTINGS.minDelayMs,
    }],
    ['maxDelayMs', elements.maxDelayMs, {
      min: 100,
      max: 60_000,
      fallback: DEFAULT_SETTINGS.maxDelayMs,
    }],
    ['extraPassCount', elements.extraPassCount, {
      min: 1,
      max: 3,
      fallback: DEFAULT_SETTINGS.extraPassCount,
    }],
  ];

  for (const [key, element, options] of numberFields) {
    element.addEventListener('input', () => {
      if (!initialized) {
        return;
      }
      scheduleNumberSave(key, element, options);
    });

    element.addEventListener('change', () => {
      if (!initialized) {
        return;
      }
      saveNumberSetting(key, element, { ...options, forceClamp: true })
        .catch((error) => handleError(error, 'Ошибка сохранения числовой настройки.'));
    });
  }

  elements.reset.addEventListener('click', () => {
    clearDelayedSaveTimers();
    chrome.storage.local.set({ ...DEFAULT_SETTINGS })
      .then(() => {
        render(DEFAULT_SETTINGS);
        showMessage('Восстановлены значения по умолчанию.');
      })
      .catch((error) => handleError(error, 'Ошибка сброса настроек.'));
  });
}

async function initialize() {
  attachHandlers();

  try {
    await loadSettings();
    initialized = true;
  } catch (error) {
    render(DEFAULT_SETTINGS);
    initialized = true;
    showMessage('Не удалось прочитать настройки.');
  }
}

void initialize();
