const DEFAULT_SETTINGS = {
  autoSaveExport: true,
  saveDiagnosticLog: false
};

const autoSave = document.getElementById("autoSaveExport");
const saveLog = document.getElementById("saveDiagnosticLog");
const status = document.getElementById("status");
let statusTimer = null;

async function load() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  autoSave.checked = stored.autoSaveExport ?? DEFAULT_SETTINGS.autoSaveExport;
  saveLog.checked = stored.saveDiagnosticLog ?? DEFAULT_SETTINGS.saveDiagnosticLog;
}

async function save() {
  await chrome.storage.local.set({
    autoSaveExport: autoSave.checked,
    saveDiagnosticLog: saveLog.checked
  });
  status.textContent = "Сохранено";
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { status.textContent = ""; }, 1200);
}

autoSave.addEventListener("change", save);
saveLog.addEventListener("change", save);
load();
