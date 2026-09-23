const DEFAULT_SETTINGS = {
  autoSaveExport: true,
  saveDiagnosticLog: false,
  useDomBackup: false
};

const autoSave = document.getElementById("autoSaveExport");
const saveLog = document.getElementById("saveDiagnosticLog");
const domBackup = document.getElementById("useDomBackup");
const status = document.getElementById("status");
let statusTimer = null;

async function load() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  autoSave.checked = stored.autoSaveExport ?? DEFAULT_SETTINGS.autoSaveExport;
  saveLog.checked = stored.saveDiagnosticLog ?? DEFAULT_SETTINGS.saveDiagnosticLog;
  domBackup.checked = stored.useDomBackup ?? DEFAULT_SETTINGS.useDomBackup;
}

async function save() {
  await chrome.storage.local.set({
    autoSaveExport: autoSave.checked,
    saveDiagnosticLog: saveLog.checked,
    useDomBackup: domBackup.checked
  });
  status.textContent = "Сохранено";
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { status.textContent = ""; }, 1200);
}

autoSave.addEventListener("change", save);
saveLog.addEventListener("change", save);
domBackup.addEventListener("change", save);
load();
