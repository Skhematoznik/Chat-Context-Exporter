(() => {
  const VERSION = "1.0.40";
  if (globalThis.__ChatGPTConversationExporter?.version === VERSION) return;

  const MESSAGE_SELECTOR = '[data-message-author-role="user"], [data-message-author-role="assistant"]';
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const ROOT_SENTINEL_SELECTOR = '[data-turn-id-container="client-created-root"]';
  const TURN_CONTAINER_SELECTOR = '[data-turn-id-container]';
  const DEFAULT_SETTINGS = Object.freeze({ autoSaveExport: true, saveDiagnosticLog: false, useDomBackup: false });

  let runtimeSettings = { ...DEFAULT_SETTINGS };

chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS)).then((stored) => {
  runtimeSettings = { ...DEFAULT_SETTINGS, ...stored };
});

function shouldUseDomBackup() {
  return Boolean(runtimeSettings.useDomBackup);
}

const CONFIG = Object.freeze({
    initialUpwardStepRatio: 0.58,
    minUpwardStepRatio: 0.36,
    maxUpwardStepRatio: 0.92,
    adaptiveStepDelta: 0.07,
    targetOverlapLow: 3,
    targetOverlapHigh: 6,
    minStepPx: 220,
    boundaryPrefetchRatio: 0.42,
    boundaryMinGainRatio: 0.72,
    boundaryMaxJumpViewports: 32,
    boundaryHistoryMaxJumpViewports: 4,
    boundaryControlMaxJumpViewports: 2,
    boundaryNearbyViewportMargin: 0.75,
    boundaryBackoffFactor: 0.5,
    boundaryBackoffRetries: 2,
    targetedRepairAttempts: 3,
    targetedRepairMaxSlots: 8,
    targetedPromptRepairMaxMissing: 32,
    targetedPromptRepairMaxRatio: 0.15,
    targetedPromptRepairNeighborRadius: 1,
    targetedPromptRepairAttempts: 2,
    targetedPromptRepairSettleMs: 320,
    visibilityResumeSettleMs: 900,
    fastTopProbeMs: 5200,
    fastTopPollMs: 240,
    fastTopStablePasses: 4,
    fastTopMaxCycles: 120,
    forwardStepRatio: 0.78,
    recoveryForwardStepRatio: 0.58,
    forwardMountedWindowPrefetchRatio: 0.38,
    forwardMountedWindowMinGainRatio: 1.10,
    forwardMountedWindowMaxViewports: 8,
    recoveryMountedWindowMaxViewports: 3,
    forwardLongTurnPrefetchRatio: 0.42,
    forwardLongTurnMaxViewports: 12,
    recoveryLongTurnMaxViewports: 4,
    forwardBackoffRetries: 3,
    maxForwardScans: 2,
    emptyTurnMaxHeightPx: 48,
    stableBottomPasses: 3,
    stableTopPasses: 2,
    maxBottomSeekAttempts: 12,
    maxUpwardScans: 2,
    maxUpwardSteps: 2200,
    maxNoProgressSteps: 18,
    regularMinWaitMs: 650,
    edgeMinWaitMs: 1800,
    quietWindowMs: 700,
    regularMaxWaitMs: 10000,
    edgeMaxWaitMs: 26000,
    auxiliaryExpandMaxWaitMs: 10000,
    stableObservationsRequired: 2,
    checkpointEveryNewRecords: 20,
    checkpointMinIntervalMs: 4000,
    checkpointSeekEveryNewRecords: 30,
    checkpointSeekMinIntervalMs: 7000,
    checkpointScanEveryNewRecords: 40,
    checkpointScanMinIntervalMs: 12000,
    overlayAutoCloseMs: 1600,
    bridgeRetries: 3,
    tocStableObservations: 3,
    tocStableMs: 1200
  });

  const state = {
    running: false,
    cancelRequested: false,
    records: new Map(),
    observations: new Map(),
    edgeCounts: new Map(),
    auxiliaryVisitedIds: new Set(),
    overlay: null,
    timerHandle: null,
    startedAt: 0,
    finishedElapsedMs: null,
    settings: { ...DEFAULT_SETTINGS },
    pageTitle: "",
    conversationKey: "",
    checkpointKey: "",
    checkpointDirty: false,
    checkpointInFlight: Promise.resolve(),
    lastCheckpointAt: 0,
    recordsAtCheckpoint: 0,
    currentPhase: "IDLE",
    currentStatus: "",
    apiMode: false,
    apiProgress: null,
    apiAbortController: null,
    currentScan: 0,
    bottomSeekAttempt: 0,
    reachedBottom: false,
    reachedTop: false,
    bottomMessageId: "",
    topMessageId: "",
    bottomRole: "",
    expectedPromptCount: null,
    expectedMessageCount: null,
    expectedCountSource: "unknown",
    tocCandidateCount: null,
    tocCandidateObservations: 0,
    tocCandidateSince: 0,
    lastTocObservedAt: 0,
    currentStepRatio: 0.58,
    lastSnapshotIds: [],
    lastOverlap: null,
    pendingMarkdown: "",
    pendingFilename: "",
    logEntries: [],
    logSaved: false,
    lastValidation: null,
    confirmedEmptyTurnIds: new Set(),
    resolvedNoncanonicalTurns: new Map(),
    confirmedTurnBridges: new Map(),
    lastSkeletonStats: null,
    visibilityPaused: false,
    visibilityPhaseBeforePause: "",
    visibilityPauseStartedAt: 0,
    visibilityPausedTotalMs: 0,
    visibilityResumeEpoch: 0,
    visibilityListenerInstalled: false
  };

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  function nowIso() { return new Date().toISOString(); }
  function elapsedMs() {
    if (Number.isFinite(state.finishedElapsedMs)) return state.finishedElapsedMs;
    if (!state.startedAt) return 0;
    let paused = state.visibilityPausedTotalMs || 0;
    if (state.visibilityPaused && state.visibilityPauseStartedAt) paused += Math.max(0, Date.now() - state.visibilityPauseStartedAt);
    return Math.max(0, Date.now() - state.startedAt - paused);
  }
  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0
      ? `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`
      : `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  }

  function normalizeText(text) {
    return String(text ?? "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function diagnosticSnippet(text, maxLength = 240) {
    return normalizeText(text).replace(/\s+/g, " ").slice(0, maxLength);
  }

  function sanitizeFilename(value) {
    return normalizeText(value || "Chat Context")
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/[. ]+$/g, "")
      .slice(0, 180) || "Chat Context";
  }

  function pageTitle() {
    return normalizeText(document.title || "Chat Context");
  }

  function conversationIdentity() {
    try {
      const url = new URL(location.href);
      return `${url.origin}${url.pathname}`;
    } catch {
      return location.href.split(/[?#]/)[0];
    }
  }

  function checkpointStorageKey() {
    return `chat-context-exporter:v15:${conversationIdentity()}`;
  }

  function stripTrackingParams(url) {
    try {
      const parsed = new URL(url, location.href);
      for (const key of [...parsed.searchParams.keys()]) {
        if (/^utm_/i.test(key)) parsed.searchParams.delete(key);
      }
      return parsed.href;
    } catch {
      return url;
    }
  }

  function cleanUrl(raw) {
    if (!raw) return "";
    const value = String(raw).trim();
    if (/^sandbox:/i.test(value)) return value;
    try {
      const url = new URL(value, location.href);
      if (!["http:", "https:", "mailto:"].includes(url.protocol)) return "";
      return stripTrackingParams(url.href);
    } catch {
      return "";
    }
  }

  function inlineChildren(node, context = {}) {
    return Array.from(node.childNodes).map(child => nodeToMarkdown(child, context)).join("");
  }

  function listItemToMarkdown(li, ordered, index, depth) {
    const clone = li.cloneNode(true);
    const nestedLists = Array.from(clone.querySelectorAll(":scope > ul, :scope > ol"));
    for (const nested of nestedLists) nested.remove();
    let body = normalizeText(inlineChildren(clone, { listDepth: depth })).replace(/\n+/g, " ").trim();
    const marker = ordered ? `${index + 1}. ` : "- ";
    let result = `${"  ".repeat(depth)}${marker}${body}`.trimEnd();
    for (const nested of nestedLists) {
      const nestedMd = nodeToMarkdown(nested, { listDepth: depth + 1 }).trimEnd();
      if (nestedMd) result += `\n${nestedMd}`;
    }
    return result;
  }

  function tableToMarkdown(table) {
    const rows = Array.from(table.querySelectorAll("tr"));
    if (!rows.length) return "";
    const parsed = rows.map(row => Array.from(row.querySelectorAll(":scope > th, :scope > td"))
      .map(cell => normalizeText(cell.innerText || cell.textContent || "").replace(/\|/g, "\\|").replace(/\n+/g, "<br>")));
    const width = Math.max(...parsed.map(row => row.length));
    if (!width) return "";
    for (const row of parsed) while (row.length < width) row.push("");
    const out = [
      `| ${parsed[0].join(" | ")} |`,
      `| ${Array(width).fill("---").join(" | ")} |`
    ];
    for (const row of parsed.slice(1)) out.push(`| ${row.join(" | ")} |`);
    return `${out.join("\n")}\n\n`;
  }

  function citationPillToMarkdown(el) {
    const anchor = el.matches("a[href]") ? el : el.querySelector("a[href]");
    const label = normalizeText(el.innerText || el.textContent || "").replace(/\s*\+\d+\s*$/, "");
    const href = cleanUrl(anchor?.getAttribute("href") || "");
    if (!label) return "";
    return href ? `[Источник: ${label}](${href})` : `[Источник: ${label}]`;
  }

  function looksLikeFilename(value) {
    return /\.[a-z0-9]{1,12}$/i.test(String(value || "").trim());
  }

  function filenameFromElement(el) {
    if (!el) return "";
    for (const code of el.querySelectorAll?.("code") || []) {
      const value = normalizeText(code.textContent || "");
      if (looksLikeFilename(value)) return value;
    }
    const aria = normalizeText(el.getAttribute?.("aria-label") || "");
    if (looksLikeFilename(aria)) {
      const match = aria.match(/([^\\/:*?"<>|\n]+?\.[a-z0-9]{1,12})$/i);
      return normalizeText(match?.[1] || aria);
    }
    const text = normalizeText(el.innerText || el.textContent || "");
    if (looksLikeFilename(text)) {
      const match = text.match(/([^\\/:*?"<>|\n]+?\.[a-z0-9]{1,12})$/i);
      return normalizeText(match?.[1] || text);
    }
    return "";
  }

  function isFileEntityButton(el) {
    if (!el || el.tagName?.toLowerCase() !== "button") return false;
    if (el.querySelector('[data-testid="library-file-icon"]')) return true;
    const cls = String(el.getAttribute("class") || "");
    return /open-file|file-tile|entity-underline/.test(cls) && Boolean(filenameFromElement(el));
  }

  function fileEntityButtonToMarkdown(el) {
    const label = normalizeText(el.innerText || el.textContent || el.getAttribute("aria-label") || "");
    const filename = filenameFromElement(el);
    if (label) return label;
    return filename ? `Файл: ${filename}` : "";
  }

  const GENERATED_DOWNLOAD_BUTTON_RE = /^(?:скачать|download)(?:\s+|$)/i;

  function generatedDownloadButtonLabel(button) {
    if (!button || button.tagName?.toLowerCase() !== "button") return "";
    const label = normalizeText(button.innerText || button.textContent || button.getAttribute("aria-label") || "");
    return GENERATED_DOWNLOAD_BUTTON_RE.test(label) ? label : "";
  }

  function nodeToMarkdown(node, context = {}) {
    if (!node) return "";
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node;
    const tag = el.tagName.toLowerCase();

    if (el.matches?.('[data-testid="webpage-citation-pill"]')) return citationPillToMarkdown(el);
    if (tag === "button" && isFileEntityButton(el)) return fileEntityButtonToMarkdown(el);
    if (["script","style","noscript","button","textarea","input","select","option","svg","path"].includes(tag)) return "";
    if (el.getAttribute("aria-hidden") === "true" || el.classList.contains("sr-only")) return "";
    if (tag === "br") return "\n";
    if (tag === "hr") return "\n---\n\n";
    if (/^h[1-6]$/.test(tag)) return `${"#".repeat(Number(tag[1]))} ${normalizeText(inlineChildren(el, context))}\n\n`;
    if (tag === "p") return `${normalizeText(inlineChildren(el, context))}\n\n`;
    if (tag === "strong" || tag === "b") return `**${normalizeText(inlineChildren(el, context))}**`;
    if (tag === "em" || tag === "i") return `*${normalizeText(inlineChildren(el, context))}*`;
    if (tag === "del" || tag === "s") return `~~${normalizeText(inlineChildren(el, context))}~~`;
    if (tag === "code" && el.parentElement?.tagName.toLowerCase() !== "pre") return `\`${(el.textContent || "").replace(/`/g,"\\`")}\``;
    if (tag === "pre") {
      const code = el.querySelector("code") || el;
      const raw = (code.textContent || "").replace(/\n+$/, "");
      const match = (code.getAttribute("class") || "").match(/language-([\w#+.-]+)/i);
      const fence = raw.includes("```") ? "````" : "```";
      return `${fence}${match ? match[1] : ""}\n${raw}\n${fence}\n\n`;
    }
    if (tag === "blockquote") {
      const body = normalizeText(inlineChildren(el, context));
      return `${body.split("\n").map(line => `> ${line}`).join("\n")}\n\n`;
    }
    if (tag === "a") {
      const label = normalizeText(inlineChildren(el, context)) || normalizeText(el.textContent || "");
      const href = cleanUrl(el.getAttribute("href"));
      if (!label) return "";
      return href ? `[${label}](${href})` : label;
    }
    if (tag === "ul" || tag === "ol") {
      const ordered = tag === "ol";
      const depth = Number(context.listDepth || 0);
      const items = Array.from(el.children).filter(child => child.tagName?.toLowerCase() === "li");
      return `${items.map((li,index) => listItemToMarkdown(li, ordered, index, depth)).join("\n")}\n\n`;
    }
    if (tag === "li") return normalizeText(inlineChildren(el, context));
    if (tag === "table") return tableToMarkdown(el);
    if (tag === "img") {
      const alt = normalizeText(el.getAttribute("alt") || "");
      return alt ? `[Изображение: ${alt}]` : "[Изображение]";
    }
    return inlineChildren(el, context);
  }

  function collectAttachments(messageEl) {
    const names = new Set();
    for (const tile of messageEl.querySelectorAll('[role="group"][aria-label]')) {
      const label = normalizeText(tile.getAttribute("aria-label") || "");
      const className = String(tile.getAttribute("class") || "");
      const hasFileMarker = className.includes("group/file-tile") || tile.querySelector('[data-testid="library-file-icon"], [data-testid*="file"]');
      if (label && (hasFileMarker || looksLikeFilename(label))) names.add(label);
    }
    for (const tile of messageEl.querySelectorAll('[data-testid*="file"][aria-label]')) {
      const label = normalizeText(tile.getAttribute("aria-label") || "");
      if (label && looksLikeFilename(label)) names.add(label);
    }
    return [...names];
  }

  function collectGeneratedArtifacts(messageEl) {
    if (!messageEl || messageEl.getAttribute("data-message-author-role") !== "assistant") return [];
    const turnEl = messageEl.closest(TURN_SELECTOR) || messageEl;
    const items = new Map();
    function add(name, url = "", label = "") {
      name = normalizeText(name || "");
      label = normalizeText(label || "");
      url = cleanUrl(url || "");
      if (!name && !label) return;
      const key = `${name || label}|${url}`;
      if (!items.has(key)) items.set(key, { name: name || label, label: label || name, url });
    }
    for (const row of turnEl.querySelectorAll('[class*="artifact-row"]')) {
      const button = row.querySelector('button[aria-label]') || row.querySelector("button");
      const name = filenameFromElement(button || row);
      const label = normalizeText(button?.innerText || button?.textContent || button?.getAttribute("aria-label") || name);
      const anchor = row.querySelector("a[href]");
      if (name || label) add(name, anchor?.getAttribute("href") || "", label);
    }
    for (const icon of turnEl.querySelectorAll('[data-testid="library-file-icon"]')) {
      const control = icon.closest("button, a") || icon.parentElement;
      const name = filenameFromElement(control);
      const label = normalizeText(control?.innerText || control?.textContent || control?.getAttribute?.("aria-label") || name);
      const href = control?.tagName?.toLowerCase() === "a" ? control.getAttribute("href") : "";
      if (name || label) add(name, href, label);
    }
    for (const anchor of turnEl.querySelectorAll('a[href^="sandbox:"], a[href*="/mnt/data/"]')) {
      add(filenameFromElement(anchor) || normalizeText(anchor.textContent || ""), anchor.getAttribute("href") || "", normalizeText(anchor.textContent || ""));
    }
    // Новые версии ChatGPT могут рендерить созданный файл как behavior-btn без href/aria-label.
    // Сохраняем хотя бы пользовательски видимую семантику такой кнопки как artifact.
    for (const button of turnEl.querySelectorAll("button")) {
      const label = generatedDownloadButtonLabel(button);
      if (!label) continue;
      const name = normalizeText(label.replace(GENERATED_DOWNLOAD_BUTTON_RE, "")) || label;
      const anchor = button.closest("a[href]") || button.parentElement?.closest?.("a[href]");
      add(name, anchor?.getAttribute?.("href") || "", label);
    }
    return [...items.values()];
  }

  function cloneForExtraction(messageEl) {
    const clone = messageEl.cloneNode(true);
    for (const el of clone.querySelectorAll([
      "script","style","noscript","textarea","input","select","svg",'[aria-hidden="true"]',".sr-only",'[data-testid*="copy"]','[data-testid*="feedback"]'
    ].join(","))) el.remove();
    for (const button of clone.querySelectorAll("button")) if (!isFileEntityButton(button)) button.remove();
    for (const tile of clone.querySelectorAll('[role="group"][aria-label]')) {
      const label = normalizeText(tile.getAttribute("aria-label") || "");
      const className = String(tile.getAttribute("class") || "");
      if (className.includes("group/file-tile") || looksLikeFilename(label)) tile.remove();
    }
    return clone;
  }

  function extractObservedTurnIndex(messageEl) {
    const turn = messageEl.closest(TURN_SELECTOR);
    const match = String(turn?.getAttribute("data-testid") || "").match(/conversation-turn-(\d+)/);
    return match ? Number(match[1]) : null;
  }

  function getCurrentDateMap() {
    const map = new Map();
    let pendingDate = "";
    const nodes = Array.from(document.querySelectorAll(`${TURN_SELECTOR}, [role="separator"][aria-label]`));
    for (const node of nodes) {
      if (node.matches('[role="separator"][aria-label]')) {
        pendingDate = normalizeText(node.getAttribute("aria-label") || node.innerText || "");
        continue;
      }
      const match = String(node.getAttribute("data-testid") || "").match(/conversation-turn-(\d+)/);
      if (match && pendingDate) {
        // A ChatGPT date/time separator is a boundary marker, not a value that
        // should be inherited by every subsequently mounted virtualized turn.
        // Attach it only to the immediately following turn. This prevents a
        // responsive/virtualized layout from leaking one separator across a
        // large mounted window and assigning different dates to the same
        // canonical message in different viewport widths.
        map.set(Number(match[1]), pendingDate);
        pendingDate = "";
      }
    }
    return map;
  }

  const PROCESS_DISCLOSURE_RE = /(обработка заняла|processing took|worked for|thinking for|thought for|размышлял|думал)/i;

  function processingDisclosureButtons(turnEl) {
    if (!turnEl) return [];
    return Array.from(turnEl.querySelectorAll('button[aria-expanded]')).filter(button => {
      const label = normalizeText(button.innerText || button.textContent || button.getAttribute("aria-label") || "");
      return label && PROCESS_DISCLOSURE_RE.test(label);
    });
  }

  function processingDetailRoot(button, turnEl) {
    const controls = normalizeText(button?.getAttribute("aria-controls") || "");
    if (controls) {
      const byId = document.getElementById(controls);
      if (byId && turnEl.contains(byId)) return byId;
    }
    const sibling = button?.nextElementSibling;
    if (sibling && turnEl.contains(sibling)) return sibling;
    const parent = button?.parentElement;
    if (parent) {
      for (const candidate of Array.from(parent.children)) {
        if (candidate === button || candidate.contains(button)) continue;
        if (normalizeText(candidate.innerText || candidate.textContent || "")) return candidate;
      }
    }
    return null;
  }

  function extractProcessingDisclosures(turnEl) {
    const result = [];
    for (const button of processingDisclosureButtons(turnEl)) {
      const label = normalizeText(button.innerText || button.textContent || button.getAttribute("aria-label") || "");
      const expanded = button.getAttribute("aria-expanded") === "true";
      const detailRoot = processingDetailRoot(button, turnEl);
      let markdown = "";
      if (expanded && detailRoot) {
        const clone = cloneForExtraction(detailRoot);
        markdown = normalizeText(nodeToMarkdown(clone)) || normalizeText(detailRoot.innerText || detailRoot.textContent || "");
      }
      result.push({ label, expanded, captured: Boolean(markdown), markdown });
    }
    return result;
  }

  function mergeProcessingItems(previous = [], incoming = []) {
    const byLabel = new Map();
    for (const item of [...previous, ...incoming]) {
      if (!item) continue;
      const label = normalizeText(item.label || "");
      const key = label || `processing:${byLabel.size}`;
      const old = byLabel.get(key);
      if (!old || (item.captured && !old.captured) || ((item.markdown?.length || 0) > (old.markdown?.length || 0))) {
        byLabel.set(key, { label, expanded: Boolean(item.expanded), captured: Boolean(item.captured), markdown: item.markdown || "" });
      }
    }
    return [...byLabel.values()];
  }

  function mergeGeneratedArtifacts(previous = [], incoming = []) {
    const byKey = new Map();
    for (const item of [...previous, ...incoming]) {
      if (!item) continue;
      const key = `${normalizeText(item.name || item.label || "")}|${cleanUrl(item.url || "")}`;
      if (!key || key === "|") continue;
      const old = byKey.get(key);
      if (!old || (item.url && !old.url)) byKey.set(key, item);
    }
    return [...byKey.values()];
  }

  function extractMessage(messageEl, dateMap, { captureProcessing = false } = {}) {
    const role = messageEl.getAttribute("data-message-author-role");
    if (role !== "user" && role !== "assistant") return null;
    const messageId = normalizeText(messageEl.getAttribute("data-message-id") || "");
    if (!messageId) return null;
    const observedTurnIndex = extractObservedTurnIndex(messageEl);
    const turnEl = messageEl.closest(TURN_SELECTOR) || messageEl;
    const turnId = normalizeText(turnEl.getAttribute?.("data-turn-id") || turnEl.getAttribute?.("data-turn-id-container") || "");
    const attachments = collectAttachments(messageEl);
    const generatedArtifacts = role === "assistant" ? collectGeneratedArtifacts(messageEl) : [];
    const processing = role === "assistant" && captureProcessing ? extractProcessingDisclosures(turnEl) : [];
    let contentRoot = messageEl;
    if (role === "user") {
      contentRoot = messageEl.querySelector('[data-testid="collapsible-user-message-content"]') || messageEl.querySelector(".whitespace-pre-wrap") || messageEl;
    } else {
      contentRoot = messageEl.querySelector(".markdown") || messageEl;
    }
    const clone = cloneForExtraction(contentRoot);
    const markdown = normalizeText(nodeToMarkdown(clone)) || normalizeText(contentRoot.innerText || contentRoot.textContent || "");
    const dateLabel = Number.isFinite(observedTurnIndex) ? (dateMap.get(observedTurnIndex) || "") : "";
    const signature = JSON.stringify([
      role,
      markdown,
      [...attachments].sort(),
      generatedArtifacts.map(item => [item.name,item.label,item.url]),
      processing.map(item => [item.label,item.captured,item.markdown])
    ]);
    return { messageId, role, turnId, observedTurnIndex, dateLabel, markdown, attachments, generatedArtifacts, processing, signature };
  }

  function recordQuality(record) {
    const processingChars = (record?.processing || []).reduce((sum,item) => sum + (item.markdown?.length || 0), 0);
    return (record?.markdown?.length || 0) + (record?.attachments?.length || 0) * 500 + (record?.generatedArtifacts?.length || 0) * 700 + processingChars;
  }

  function updateDateLabelEvidence(record, observedLabel) {
    const label = normalizeText(observedLabel || "");
    const evidence = { ...(record.dateLabelEvidence || {}) };
    if (label) evidence[label] = (Number(evidence[label]) || 0) + 1;

    const ranked = Object.entries(evidence)
      .filter(([key,count]) => key && Number(count) > 0)
      .sort((a,b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0]));

    let selected = normalizeText(record.dateLabel || "");
    if (ranked.length) {
      const [bestLabel,bestCount] = ranked[0];
      const secondCount = ranked.length > 1 ? Number(ranked[1][1]) : -1;
      // A unique leader is accepted. If two conflicting labels have exactly
      // the same evidence, keep the date uncommitted rather than freezing the
      // first observation forever. Later observations can resolve the tie.
      selected = Number(bestCount) > secondCount ? bestLabel : "";
    }

    const changed = selected !== normalizeText(record.dateLabel || "")
      || JSON.stringify(evidence) !== JSON.stringify(record.dateLabelEvidence || {});
    record.dateLabel = selected;
    record.dateLabelEvidence = evidence;
    return changed;
  }

  function observeRecord(record) {
    const obs = state.observations.get(record.messageId);
    const stableCount = obs?.signature === record.signature ? obs.stableCount + 1 : 1;
    state.observations.set(record.messageId, { signature: record.signature, stableCount, lastSeenAt: Date.now() });
    record.stable = stableCount >= CONFIG.stableObservationsRequired;
    record.lastSeenAt = Date.now();

    const old = state.records.get(record.messageId);
    if (!old) {
      const stored = {
        ...record,
        dateLabel: "",
        dateLabelEvidence: {},
        observedTurns: Number.isFinite(record.observedTurnIndex) ? [record.observedTurnIndex] : [],
        observedTurnIds: record.turnId ? [record.turnId] : []
      };
      updateDateLabelEvidence(stored, record.dateLabel);
      state.records.set(record.messageId, stored);
      state.checkpointDirty = true;
      return { added: true, updated: false };
    }

    let updated = false;
    const mergedProcessing = mergeProcessingItems(old.processing || [], record.processing || []);
    const mergedArtifacts = mergeGeneratedArtifacts(old.generatedArtifacts || [], record.generatedArtifacts || []);
    const observedTurns = new Set(old.observedTurns || []);
    if (Number.isFinite(record.observedTurnIndex)) observedTurns.add(record.observedTurnIndex);
    old.observedTurns = [...observedTurns].slice(-12);
    old.lastObservedTurnIndex = record.observedTurnIndex;
    const observedTurnIds = new Set(old.observedTurnIds || []);
    if (record.turnId) observedTurnIds.add(record.turnId);
    old.observedTurnIds = [...observedTurnIds].slice(-12);
    if (record.turnId) old.turnId = record.turnId;

    if (recordQuality(record) > recordQuality(old) || (record.stable && !old.stable && recordQuality(record) >= recordQuality(old))) {
      old.markdown = record.markdown;
      old.attachments = record.attachments;
      old.signature = record.signature;
      updated = true;
    }
    if (JSON.stringify(mergedProcessing) !== JSON.stringify(old.processing || [])) { old.processing = mergedProcessing; updated = true; }
    if (JSON.stringify(mergedArtifacts) !== JSON.stringify(old.generatedArtifacts || [])) { old.generatedArtifacts = mergedArtifacts; updated = true; }
    if (updateDateLabelEvidence(old, record.dateLabel)) updated = true;
    if (record.stable && !old.stable) { old.stable = true; updated = true; }
    old.lastSeenAt = Date.now();
    if (updated) state.checkpointDirty = true;
    return { added: false, updated };
  }

  function addEdge(fromId, toId) {
    if (!fromId || !toId || fromId === toId) return;
    const key = `${fromId}>${toId}`;
    state.edgeCounts.set(key, (state.edgeCounts.get(key) || 0) + 1);
    state.checkpointDirty = true;
  }

  function edgeCandidatesFrom(id) {
    const out = [];
    for (const [key,count] of state.edgeCounts) {
      const split = key.indexOf(">");
      if (split < 0 || key.slice(0,split) !== id) continue;
      out.push({ id: key.slice(split + 1), count });
    }
    return out.sort((a,b) => b.count - a.count || a.id.localeCompare(b.id));
  }

  function edgeCandidatesTo(id) {
    const out = [];
    for (const [key,count] of state.edgeCounts) {
      const split = key.indexOf(">");
      if (split < 0 || key.slice(split + 1) !== id) continue;
      out.push({ id: key.slice(0,split), count });
    }
    return out.sort((a,b) => b.count - a.count || a.id.localeCompare(b.id));
  }

  function bestSuccessor(id) {
    const candidates = edgeCandidatesFrom(id).filter(x => {
      const a = state.records.get(id), b = state.records.get(x.id);
      return Boolean(a && b);
    });
    return candidates[0]?.id || "";
  }

  function buildChain() {
    if (!state.topMessageId) return { ids: [], connectedToBottom: false, loop: false, ambiguities: [] };
    const ids = [];
    const seen = new Set();
    const ambiguities = [];
    let current = state.topMessageId;
    let loop = false;

    while (current && !seen.has(current) && ids.length <= state.records.size + 5) {
      ids.push(current);
      seen.add(current);
      if (current === state.bottomMessageId) break;
      const forcedBridge = confirmedBridgeSuccessor(current);
      if (forcedBridge) {
        current = forcedBridge.id;
        continue;
      }
      const candidates = edgeCandidatesFrom(current).filter(x => {
        const a = state.records.get(current), b = state.records.get(x.id);
        return Boolean(a && b);
      });
      if (!candidates.length) break;
      if (candidates.length > 1 && candidates[0].count === candidates[1].count) ambiguities.push(current);
      current = candidates[0].id;
    }
    if (current && seen.has(current) && current !== ids[ids.length - 1]) loop = true;
    return { ids, connectedToBottom: ids.at(-1) === state.bottomMessageId, loop, ambiguities };
  }

  function confirmedBridgeSuccessor(id) {
    const matches = [];
    for (const [key, turnIds] of state.confirmedTurnBridges) {
      const split = key.indexOf(">");
      if (split < 0 || key.slice(0, split) !== id) continue;
      const toId = key.slice(split + 1);
      if (state.records.has(toId)) matches.push({ id: toId, turnIds: turnIds || [] });
    }
    return matches.length === 1 ? matches[0] : null;
  }

  function confirmedBridgePredecessor(id) {
    const matches = [];
    for (const [key, turnIds] of state.confirmedTurnBridges) {
      const split = key.indexOf(">");
      if (split < 0 || key.slice(split + 1) !== id) continue;
      const fromId = key.slice(0, split);
      if (state.records.has(fromId)) matches.push({ id: fromId, turnIds: turnIds || [] });
    }
    return matches.length === 1 ? matches[0] : null;
  }

  function parseCssPx(styleText, variableName) {
    const escaped = String(variableName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = String(styleText || "").match(new RegExp(`${escaped}\\s*:\\s*([0-9.]+)px`, "i"));
    return match ? Number(match[1]) : null;
  }

  function outerTurnContainers() {
    // ChatGPT has used two real DOM layouts for turn virtualization:
    //   1) an outer [data-turn-id-container] wrapper containing conversation-turn-N;
    //   2) conversation-turn-N itself carrying data-turn-id-container.
    // 1.0.18 deliberately skipped layout (2), which made the entire skeleton
    // disappear on affected chats. Resolve both layouts to one container per
    // turn-id, preferring the older outer wrapper when both are present.
    const groups = new Map();
    let domOrder = 0;
    for (const el of document.querySelectorAll(TURN_CONTAINER_SELECTOR)) {
      const turnId = normalizeText(el.getAttribute?.("data-turn-id-container") || "");
      if (!turnId || turnId === "client-created-root") continue;
      const entry = groups.get(turnId) || { firstOrder: domOrder, elements: [] };
      entry.elements.push(el);
      groups.set(turnId, entry);
      domOrder++;
    }

    const result = [];
    for (const [turnId, entry] of groups) {
      const elements = entry.elements;
      let chosen = elements.find(el => !el.matches?.(TURN_SELECTOR));
      if (!chosen) chosen = elements.find(el => el.matches?.(TURN_SELECTOR)) || elements[0];
      if (chosen) result.push({ turnId, firstOrder: entry.firstOrder, element: chosen });
    }
    result.sort((a, b) => a.firstOrder - b.firstOrder);
    return result.map(item => item.element);
  }

  function collectTurnSkeleton() {
    const slots = [];
    for (const [index, el] of outerTurnContainers().entries()) {
      const turnId = normalizeText(el.getAttribute("data-turn-id-container") || "");
      const messageIds = [];
      for (const msg of el.querySelectorAll(MESSAGE_SELECTOR)) {
        const id = normalizeText(msg.getAttribute("data-message-id") || "");
        if (id && !messageIds.includes(id)) messageIds.push(id);
      }
      const styleText = el.getAttribute("style") || "";
      const rect = el.getBoundingClientRect?.();
      slots.push({
        index,
        ordinal: index + 1,
        turnId,
        element: el,
        messageIds,
        lastKnownHeight: parseCssPx(styleText, "--last-known-height"),
        estimatedHeight: parseCssPx(styleText, "--estimated-turn-height"),
        rectHeight: rect ? Math.max(0, rect.height || (rect.bottom - rect.top) || 0) : null,
        intersecting: el.getAttribute("data-is-intersecting") === "true"
      });
    }
    return slots;
  }

  function recordTurnIds() {
    const ids = new Set();
    for (const record of state.records.values()) if (record.turnId) ids.add(record.turnId);
    return ids;
  }

  function recordsForTurnId(turnId) {
    const result = [];
    for (const record of state.records.values()) if (record.turnId === turnId) result.push(record);
    return result;
  }

  function resolvedNoncanonicalTurn(turnId) {
    return state.resolvedNoncanonicalTurns.get(turnId) || null;
  }

  function isResolvedTurnSlot(turnId) {
    return Boolean(turnId && (recordTurnIds().has(turnId) || state.confirmedEmptyTurnIds.has(turnId) || state.resolvedNoncanonicalTurns.has(turnId)));
  }

  function noncanonicalTypeCounts() {
    let processingOnly = 0, auxiliaryAssistant = 0;
    for (const item of state.resolvedNoncanonicalTurns.values()) {
      if (item?.type === "PROCESSING_ONLY") processingOnly++;
      else if (item?.type === "AUXILIARY_ASSISTANT") auxiliaryAssistant++;
    }
    return { processingOnly, auxiliaryAssistant };
  }

  function skeletonCoverageStats() {
    const skeleton = collectTurnSkeleton();
    const recorded = recordTurnIds();
    const unresolved = [];
    let recordedSlots = 0;
    let emptySlots = 0;
    let processingOnlySlots = 0;
    let auxiliaryAssistantSlots = 0;
    for (const slot of skeleton) {
      if (recorded.has(slot.turnId)) {
        recordedSlots++;
        continue;
      }
      if (state.confirmedEmptyTurnIds.has(slot.turnId)) {
        emptySlots++;
        continue;
      }
      const noncanonical = state.resolvedNoncanonicalTurns.get(slot.turnId);
      if (noncanonical?.type === "PROCESSING_ONLY") {
        processingOnlySlots++;
        continue;
      }
      if (noncanonical?.type === "AUXILIARY_ASSISTANT") {
        auxiliaryAssistantSlots++;
        continue;
      }
      unresolved.push(slot);
    }
    const resolvedNoncanonicalSlots = emptySlots + processingOnlySlots + auxiliaryAssistantSlots;
    const resolvedSlots = recordedSlots + resolvedNoncanonicalSlots;
    const stats = {
      total: skeleton.length,
      recordedSlots,
      resolvedSlots,
      resolvedNoncanonicalSlots,
      emptySlots,
      processingOnlySlots,
      auxiliaryAssistantSlots,
      unresolvedSlots: unresolved.length,
      unresolvedTurnIds: unresolved.map(slot => slot.turnId),
      skeleton
    };
    state.lastSkeletonStats = stats;
    return stats;
  }

  function turnRecordEndpoints(turnId) {
    const records = recordsForTurnId(turnId);
    const ids = records.map(record => record.messageId);
    if (!ids.length) return null;
    if (ids.length === 1) return { head: ids[0], tail: ids[0], ids };
    const set = new Set(ids);
    const heads = ids.filter(id => !edgeCandidatesTo(id).some(edge => set.has(edge.id)));
    const tails = ids.filter(id => !edgeCandidatesFrom(id).some(edge => set.has(edge.id)));
    if (heads.length === 1 && tails.length === 1) return { head: heads[0], tail: tails[0], ids };
    return null;
  }

  function skeletonMissingGroups({ includeConfirmed = false } = {}) {
    const skeleton = collectTurnSkeleton();
    const recorded = recordTurnIds();
    const missing = slot => !recorded.has(slot.turnId)
      && (includeConfirmed || (!state.confirmedEmptyTurnIds.has(slot.turnId) && !state.resolvedNoncanonicalTurns.has(slot.turnId)));
    const groups = [];
    for (let i = 0; i < skeleton.length;) {
      if (!missing(skeleton[i])) { i++; continue; }
      const start = i;
      while (i + 1 < skeleton.length && missing(skeleton[i + 1])) i++;
      const end = i;
      let prev = start - 1;
      while (prev >= 0 && !recorded.has(skeleton[prev].turnId)) prev--;
      let next = end + 1;
      while (next < skeleton.length && !recorded.has(skeleton[next].turnId)) next++;
      groups.push({
        slots: skeleton.slice(start, end + 1),
        prevSlot: prev >= 0 ? skeleton[prev] : null,
        nextSlot: next < skeleton.length ? skeleton[next] : null
      });
      i++;
    }
    return groups;
  }

  function removeBridgesContainingTurn(turnId) {
    for (const [key, ids] of [...state.confirmedTurnBridges.entries()]) {
      if ((ids || []).includes(turnId)) state.confirmedTurnBridges.delete(key);
    }
  }

  function pruneRecoveredResolvedTurns() {
    let changed = false;
    const recoveredIds = new Set();
    for (const turnId of state.confirmedEmptyTurnIds) if (recordsForTurnId(turnId).length) recoveredIds.add(turnId);
    for (const turnId of state.resolvedNoncanonicalTurns.keys()) if (recordsForTurnId(turnId).length) recoveredIds.add(turnId);
    for (const turnId of recoveredIds) {
      const former = state.resolvedNoncanonicalTurns.get(turnId)?.type || (state.confirmedEmptyTurnIds.has(turnId) ? "EMPTY_OR_ABORTED" : "RESOLVED_NONCANONICAL");
      state.confirmedEmptyTurnIds.delete(turnId);
      state.resolvedNoncanonicalTurns.delete(turnId);
      removeBridgesContainingTurn(turnId);
      changed = true;
      logEvent("NONCANONICAL_TURN_REVOKED", { turnId, formerType: former, reason: "message-recovered" });
    }
    if (changed) state.checkpointDirty = true;
  }

  function resolvedGapTurnIds(skeleton, recorded, start, end) {
    const ids = [];
    for (let i = start; i <= end; i++) {
      const turnId = skeleton[i].turnId;
      if (recorded.has(turnId)) return null;
      if (!state.confirmedEmptyTurnIds.has(turnId) && !state.resolvedNoncanonicalTurns.has(turnId)) return null;
      ids.push(turnId);
    }
    return ids;
  }

  function bridgeResolvedSkeletonGaps() {
    pruneRecoveredResolvedTurns();
    let added = 0;
    const skeleton = collectTurnSkeleton();
    const recorded = recordTurnIds();
    for (let i = 0; i < skeleton.length;) {
      if (recorded.has(skeleton[i].turnId)) { i++; continue; }
      const start = i;
      while (i + 1 < skeleton.length && !recorded.has(skeleton[i + 1].turnId)) i++;
      const end = i;
      const turnIds = resolvedGapTurnIds(skeleton, recorded, start, end);
      if (!turnIds?.length) { i++; continue; }
      const prevSlot = start > 0 ? skeleton[start - 1] : null;
      const nextSlot = end + 1 < skeleton.length ? skeleton[end + 1] : null;
      if (!prevSlot || !nextSlot || !recorded.has(prevSlot.turnId) || !recorded.has(nextSlot.turnId)) { i++; continue; }
      const prev = turnRecordEndpoints(prevSlot.turnId);
      const next = turnRecordEndpoints(nextSlot.turnId);
      if (!prev || !next) { i++; continue; }
      const key = `${prev.tail}>${next.head}`;
      const old = state.confirmedTurnBridges.get(key) || [];
      if (JSON.stringify(old) !== JSON.stringify(turnIds)) {
        state.confirmedTurnBridges.set(key, turnIds);
        state.checkpointDirty = true;
        added++;
        logEvent("SKELETON_BRIDGE", {
          fromMessageId: prev.tail,
          toMessageId: next.head,
          resolvedTurns: turnIds.join(","),
          types: turnIds.map(id => state.confirmedEmptyTurnIds.has(id) ? "EMPTY_OR_ABORTED" : (state.resolvedNoncanonicalTurns.get(id)?.type || "UNKNOWN")).join(",")
        });
      }
      i++;
    }
    return added;
  }

  function findOuterTurnContainer(turnId) {
    for (const el of outerTurnContainers()) {
      if (normalizeText(el.getAttribute("data-turn-id-container") || "") === turnId) return el;
    }
    return null;
  }

  function inferTurnRole(el) {
    if (!el) return "";
    const selfTurn = normalizeText(el.getAttribute?.("data-turn") || "").toLowerCase();
    if (selfTurn === "user" || selfTurn === "assistant") return selfTurn;
    const turnNode = el.querySelector?.('[data-turn="assistant"], [data-turn="user"]');
    const nested = normalizeText(turnNode?.getAttribute?.("data-turn") || "").toLowerCase();
    if (nested === "user" || nested === "assistant") return nested;
    const roleNode = el.querySelector?.('[data-message-author-role="assistant"], [data-message-author-role="user"]');
    const role = normalizeText(roleNode?.getAttribute?.("data-message-author-role") || "").toLowerCase();
    if (role === "user" || role === "assistant") return role;
    const headingText = normalizeText(Array.from(el.querySelectorAll?.("h4.sr-only, h4") || []).map(x => x.textContent || "").join(" ")).toLowerCase();
    if (/chatgpt|assistant|ассистент/.test(headingText)) return "assistant";
    if (/вы сказали|you said|user/.test(headingText)) return "user";
    return "";
  }

  function extractNoncanonicalSlotMarkdown(el) {
    if (!el) return "";
    const markdownRoots = Array.from(el.querySelectorAll?.(".markdown") || []).filter(root => !root.closest?.(MESSAGE_SELECTOR));
    if (markdownRoots.length) {
      const parts = [];
      for (const root of markdownRoots) {
        const clone = cloneForExtraction(root);
        const md = normalizeText(nodeToMarkdown(clone)) || normalizeText(root.innerText || root.textContent || "");
        if (md) parts.push(md);
      }
      if (parts.length) return normalizeText(parts.join("\n\n"));
    }
    const root = el.querySelector?.('[data-turn="assistant"]') || el.querySelector?.("section") || el;
    const clone = cloneForExtraction(root);
    for (const action of clone.querySelectorAll?.('[aria-label^="Действия"], [aria-label^="Actions"], [role="group"][aria-label*="ейств"], [role="group"][aria-label*="ction"]') || []) action.remove();
    const md = normalizeText(nodeToMarkdown(clone));
    return md;
  }

  const PROCESSING_ONLY_TEXT_RE = /^(?:обработка заняла|processing took|worked for|thinking for|thought for)\s+\d/i;
  const ABORTED_THINKING_TEXT_RE = /^(?:thinking\s+(?:остановлено|stopped)|(?:размышление|рассуждение)\s+остановлено)$/i;
  // ChatGPT can leave an assistant conversation-turn in the skeleton after an
  // interrupted/aborted response. The visible DOM then contains no canonical
  // data-message-id and no response body; innerText consists only of the
  // accessibility heading (for example "ChatGPT сказал:" / "ChatGPT said:").
  // This is not a lost assistant message. Treat it as EMPTY_OR_ABORTED only
  // when targeted repair also proves zero canonical content and tiny height.
  const ASSISTANT_SHELL_ONLY_TEXT_RE = /^(?:chatgpt|assistant|ассистент)\s+(?:сказал(?:а)?|said)\s*:?$/i;

  function classifyTurnSlotObservation(observation) {
    if (!observation?.exists || !observation.visible || observation.messageCount !== 0) return null;
    const roleHint = observation.roleHint || (observation.processingLabels?.length ? "assistant" : "");
    const content = normalizeText(observation.markdown || "");
    const raw = normalizeText(observation.text || "");
    const labels = observation.processingLabels || [];
    const processingOnly = !content && (labels.length > 0 || (raw.length <= 96 && PROCESSING_ONLY_TEXT_RE.test(raw)));
    if (processingOnly && roleHint !== "user") {
      return {
        type: "PROCESSING_ONLY",
        role: "assistant",
        label: labels[0] || raw,
        markdown: "",
        textLength: observation.textLength,
        height: observation.height
      };
    }
    if (roleHint === "assistant" && content) {
      return {
        type: "AUXILIARY_ASSISTANT",
        role: "assistant",
        label: labels[0] || "",
        markdown: content,
        textLength: observation.textLength,
        height: observation.height
      };
    }
    const stoppedThinking = roleHint === "assistant"
      && !content
      && raw.length <= 64
      && ABORTED_THINKING_TEXT_RE.test(raw)
      && Number.isFinite(observation.height)
      && observation.height <= CONFIG.emptyTurnMaxHeightPx;
    if (stoppedThinking) {
      return {
        type: "EMPTY_OR_ABORTED",
        role: "assistant",
        reason: "THINKING_STOPPED",
        label: "",
        markdown: "",
        textLength: observation.textLength,
        height: observation.height
      };
    }
    const assistantShellOnly = roleHint === "assistant"
      && !content
      && labels.length === 0
      && raw.length <= 64
      && ASSISTANT_SHELL_ONLY_TEXT_RE.test(raw)
      && Number.isFinite(observation.height)
      && observation.height <= CONFIG.emptyTurnMaxHeightPx;
    if (assistantShellOnly) {
      return {
        type: "EMPTY_OR_ABORTED",
        role: "assistant",
        reason: "ASSISTANT_SHELL_ONLY",
        label: "",
        markdown: "",
        textLength: observation.textLength,
        height: observation.height
      };
    }
    const tinyEmpty = roleHint !== "user"
      && raw.length === 0
      && Number.isFinite(observation.height)
      && observation.height <= CONFIG.emptyTurnMaxHeightPx;
    if (tinyEmpty) {
      return {
        type: "EMPTY_OR_ABORTED",
        role: roleHint || "assistant",
        label: "",
        markdown: "",
        textLength: 0,
        height: observation.height
      };
    }
    return null;
  }

  function turnSlotCandidateSignature(candidate) {
    if (!candidate) return "";
    return JSON.stringify([candidate.type, candidate.role || "", candidate.label || "", candidate.markdown || ""]);
  }

  function turnSlotObservation(container, turnId) {
    const el = findOuterTurnContainer(turnId);
    if (!el) return { exists: false, visible: false, messageCount: 0, textLength: 0, height: null, lastKnownHeight: null, text: "", markdown: "", roleHint: "", processingLabels: [] };
    const bounds = elementContentBounds(container, el);
    const metrics = scrollMetrics(container);
    const messageCount = Array.from(el.querySelectorAll(MESSAGE_SELECTOR)).filter(msg => normalizeText(msg.getAttribute("data-message-id") || "")).length;
    const text = normalizeText(el.innerText || el.textContent || "");
    const textLength = text.length;
    const styleText = el.getAttribute("style") || "";
    const lastKnownHeight = parseCssPx(styleText, "--last-known-height");
    const height = Number.isFinite(lastKnownHeight) ? lastKnownHeight : (bounds?.height ?? null);
    const visible = Boolean(bounds && bounds.bottom >= metrics.top - 2 && bounds.top <= metrics.top + metrics.client + 2);
    const processingLabels = processingDisclosureButtons(el).map(button => normalizeText(button.innerText || button.textContent || button.getAttribute("aria-label") || "")).filter(Boolean);
    const roleHint = inferTurnRole(el) || (processingLabels.length ? "assistant" : "");
    const markdown = messageCount === 0 ? extractNoncanonicalSlotMarkdown(el) : "";
    return {
      exists: true,
      visible,
      messageCount,
      textLength,
      text,
      markdown,
      roleHint,
      processingLabels,
      height,
      lastKnownHeight,
      intersecting: el.getAttribute("data-is-intersecting") === "true",
      bounds
    };
  }

  async function centerTurnSlot(container, turnId, nudge = 0) {
    const el = findOuterTurnContainer(turnId);
    if (!el) return false;
    const bounds = elementContentBounds(container, el);
    if (!bounds) return false;
    const metrics = scrollMetrics(container);
    const visibleHeight = Math.min(Math.max(bounds.height, 24), metrics.client);
    const target = Math.max(0, bounds.top - Math.max(0, (metrics.client - visibleHeight) / 2) + nudge);
    metrics.setTop(target);
    return true;
  }

  function deriveTargetedTurnRepairEligibility(validation = state.lastValidation, stats = null) {
    const skeleton = stats || skeletonCoverageStats();
    const expectedKnown = Number.isInteger(state.expectedPromptCount);

    if (!skeleton.total) {
      return { ok: false, reason: "no-skeleton", proofMode: "none", stats: skeleton };
    }
    if (!skeleton.unresolvedSlots) {
      return { ok: false, reason: "no-unresolved-slots", proofMode: "none", stats: skeleton };
    }
    if (skeleton.unresolvedSlots > CONFIG.targetedRepairMaxSlots) {
      return { ok: false, reason: "too-many-slots", proofMode: "none", stats: skeleton };
    }

    // Existing TOC-backed path: preserve 1.0.21 behavior exactly when the
    // expected prompt count is known and every prompt group has been collected.
    if (expectedKnown) {
      if (promptGroupCount() !== state.expectedPromptCount) {
        return { ok: false, reason: "toc-prompt-groups-not-complete", proofMode: "toc", stats: skeleton };
      }
      return { ok: true, reason: "all-prompt-groups-collected", proofMode: "toc", stats: skeleton };
    }

    // 1.0.25: some ChatGPT layouts expose the complete turn skeleton but no TOC.
    // Do not require the canonical edge-chain to be connected before inspecting a
    // small unresolved skeleton gap: the unresolved noncanonical slot may itself be
    // the only reason that the chain is disconnected. Requiring connectedToBottom
    // here is circular and caused real 114/116 -> 89-chain false INCOMPLETE exports.
    //
    // This is inspection eligibility only, NOT completeness proof. The existing
    // classifier still needs three identical observations, and validateCompleteness()
    // must subsequently prove the whole conversation from confirmed top to bottom.
    // A genuinely unloaded canonical message therefore remains UNRESOLVED.
    if (!validation) {
      return { ok: false, reason: "no-validation", proofMode: "structural-no-toc", stats: skeleton };
    }
    if (!state.reachedTop || !state.topMessageId) {
      return { ok: false, reason: "top-not-proven", proofMode: "structural-no-toc", stats: skeleton };
    }
    if (!state.reachedBottom || !state.bottomMessageId) {
      return { ok: false, reason: "bottom-not-proven", proofMode: "structural-no-toc", stats: skeleton };
    }
    if (validation.chain?.loop) {
      return { ok: false, reason: "canonical-chain-loop", proofMode: "structural-no-toc", stats: skeleton };
    }
    if ((validation.chain?.ambiguities || []).length) {
      return { ok: false, reason: "canonical-chain-ambiguous", proofMode: "structural-no-toc", stats: skeleton };
    }
    if (stableRecordCount() !== state.records.size) {
      return { ok: false, reason: "canonical-records-not-stable", proofMode: "structural-no-toc", stats: skeleton };
    }
    // For this no-TOC escape hatch every stable canonical record must map to one
    // concrete skeleton slot. This prevents targeted classification from being used
    // while canonical records are still outside/inconsistent with the mounted tree.
    if (skeleton.recordedSlots !== state.records.size) {
      return { ok: false, reason: "canonical-records-not-one-to-one-with-skeleton", proofMode: "structural-no-toc", stats: skeleton };
    }
    if ((validation.aux?.unvisited || []).length) {
      return { ok: false, reason: "auxiliary-context-unvisited", proofMode: "structural-no-toc", stats: skeleton };
    }
    if ((validation.aux?.unresolved || []).length) {
      return { ok: false, reason: "processing-context-unresolved", proofMode: "structural-no-toc", stats: skeleton };
    }
    if (validation.chainRecords?.length && validation.chainRecords[0]?.role !== "user") {
      return { ok: false, reason: "canonical-first-message-not-user", proofMode: "structural-no-toc", stats: skeleton };
    }

    return { ok: true, reason: "bounded-local-gap-inspection-without-toc", proofMode: "structural-no-toc", stats: skeleton };
  }

  async function targetedRepairTurnSlots(container, validation = state.lastValidation) {
    await waitForVisible();
    const beforeStats = skeletonCoverageStats();
    const eligibility = deriveTargetedTurnRepairEligibility(validation, beforeStats);
    if (!eligibility.ok) {
      logEvent("TARGETED_REPAIR_SKIPPED", {
        reason: eligibility.reason,
        proofMode: eligibility.proofMode,
        expectedPrompts: state.expectedPromptCount ?? "unknown",
        collectedPromptGroups: promptGroupCount(),
        unresolvedSlots: beforeStats.unresolvedSlots,
        maxSlots: CONFIG.targetedRepairMaxSlots
      });
      return { attempted: false, resolved: beforeStats.unresolvedSlots === 0, stats: beforeStats, eligibility };
    }

    state.currentPhase = "TARGETED_REPAIR";
    renderOverlay(`Сканирование завершено. Проверяю ${beforeStats.unresolvedSlots} turn-slot…`);
    logEvent("TARGETED_REPAIR_START", {
      proofMode: eligibility.proofMode,
      reason: eligibility.reason,
      expectedPrompts: state.expectedPromptCount ?? "unknown",
      collectedPromptGroups: promptGroupCount(),
      connectedPromptGroups: validation?.connectedPromptGroups ?? "unknown",
      canonicalChainLength: validation?.chain?.ids?.length ?? "unknown",
      canonicalRecords: state.records.size,
      stableMessages: stableRecordCount(),
      skeletonSlots: beforeStats.total,
      unresolvedSlots: beforeStats.unresolvedSlots,
      turnIds: beforeStats.unresolvedTurnIds.join(",")
    });

    let recovered = 0;
    let confirmedEmpty = 0;
    let confirmedProcessingOnly = 0;
    let confirmedAuxiliaryAssistant = 0;

    for (const initialSlot of beforeStats.skeleton.filter(slot => beforeStats.unresolvedTurnIds.includes(slot.turnId))) {
      await waitForVisible();
      if (state.cancelRequested) break;
      const turnId = initialSlot.turnId;
      let slotRecovered = false;
      const evidence = new Map();

      for (let attempt = 1; attempt <= CONFIG.targetedRepairAttempts && !state.cancelRequested; attempt++) {
        await waitForVisible();
        const nudge = attempt === 1 ? 0 : (attempt % 2 ? -28 : 28);
        const moved = await centerTurnSlot(container, turnId, nudge);
        if (!moved) {
          logEvent("TARGETED_SLOT_CHECK", { turnId, attempt, exists: false, result: "container-missing" });
          break;
        }
        await waitForDomStability(container, true);
        await processCurrentSnapshot(container);
        pruneRecoveredResolvedTurns();

        const recoveredRecords = recordsForTurnId(turnId);
        if (recoveredRecords.length) {
          recovered++;
          slotRecovered = true;
          logEvent("TARGETED_SLOT_RECOVERED", { turnId, attempt, messages: recoveredRecords.map(r => r.messageId).join(",") });
          break;
        }

        const observation = turnSlotObservation(container, turnId);
        const candidate = classifyTurnSlotObservation(observation);
        const signature = turnSlotCandidateSignature(candidate);
        if (signature) {
          const old = evidence.get(signature) || { count: 0, candidate };
          old.count++;
          old.candidate = candidate;
          evidence.set(signature, old);
        }
        const best = [...evidence.values()].sort((a,b) => b.count - a.count)[0] || null;

        logEvent("TARGETED_SLOT_CHECK", {
          turnId,
          attempt,
          exists: observation.exists,
          visible: observation.visible,
          intersecting: observation.intersecting,
          messageCount: observation.messageCount,
          roleHint: observation.roleHint || "unknown",
          textLength: observation.textLength,
          contentLength: normalizeText(observation.markdown || "").length,
          processingLabels: (observation.processingLabels || []).length,
          height: Number.isFinite(observation.height) ? Math.round(observation.height) : "unknown",
          candidateType: candidate?.type || "UNRESOLVED",
          candidateReason: candidate?.reason || "",
          candidateEvidence: best?.count || 0,
          rawText: candidate ? "" : diagnosticSnippet(observation.text, 240),
          rawMarkdown: candidate ? "" : diagnosticSnippet(observation.markdown, 240)
        });
      }

      if (slotRecovered) continue;
      const best = [...evidence.values()].sort((a,b) => b.count - a.count)[0] || null;
      if (!best || best.count < CONFIG.targetedRepairAttempts) continue;
      const resolved = { ...best.candidate, observations: best.count, confirmedAt: Date.now() };
      if (resolved.type === "EMPTY_OR_ABORTED") {
        state.confirmedEmptyTurnIds.add(turnId);
        state.resolvedNoncanonicalTurns.delete(turnId);
        confirmedEmpty++;
      } else {
        state.confirmedEmptyTurnIds.delete(turnId);
        state.resolvedNoncanonicalTurns.set(turnId, resolved);
        if (resolved.type === "PROCESSING_ONLY") confirmedProcessingOnly++;
        if (resolved.type === "AUXILIARY_ASSISTANT") confirmedAuxiliaryAssistant++;
      }
      state.checkpointDirty = true;
      logEvent("NONCANONICAL_TURN_CONFIRMED", {
        turnId,
        type: resolved.type,
        role: resolved.role || "unknown",
        reason: resolved.reason || "",
        observations: best.count,
        textLength: resolved.textLength || 0,
        contentLength: normalizeText(resolved.markdown || "").length,
        height: Number.isFinite(resolved.height) ? Math.round(resolved.height) : "unknown"
      });
    }

    bridgeResolvedSkeletonGaps();
    await saveCheckpoint({ force: true });
    const afterStats = skeletonCoverageStats();
    const resolved = afterStats.unresolvedSlots === 0;
    logEvent("TARGETED_REPAIR_RESULT", {
      recovered,
      confirmedEmpty,
      confirmedProcessingOnly,
      confirmedAuxiliaryAssistant,
      unresolvedSlots: afterStats.unresolvedSlots,
      resolvedSlots: afterStats.resolvedSlots,
      skeletonSlots: afterStats.total,
      bridges: state.confirmedTurnBridges.size,
      resolved
    });
    return { attempted: true, resolved, recovered, confirmedEmpty, confirmedProcessingOnly, confirmedAuxiliaryAssistant, stats: afterStats };
  }

  function getExpectedPromptCount() {
    const indexes = new Set();
    for (const el of document.querySelectorAll('[data-toc-item-index]')) {
      const value = Number(el.getAttribute("data-toc-item-index"));
      if (Number.isInteger(value) && value >= 0) indexes.add(value);
    }
    if (!indexes.size) return null;
    const max = Math.max(...indexes);
    for (let i=0;i<=max;i++) if (!indexes.has(i)) return null;
    return max + 1;
  }

  function userPromptGroupKey(record) {
    if (!record || record.role !== "user") return "";
    if (record.turnId) return `turn:${record.turnId}`;
    if (Number.isFinite(record.lastObservedTurnIndex ?? record.observedTurnIndex)) return `observed:${record.lastObservedTurnIndex ?? record.observedTurnIndex}`;
    return `message:${record.messageId}`;
  }

  function promptGroupCount(recordsOrIds = null) {
    const keys = new Set();
    const source = Array.isArray(recordsOrIds)
      ? recordsOrIds.map(item => typeof item === "string" ? state.records.get(item) : item)
      : [...state.records.values()];
    for (const record of source) {
      const key = userPromptGroupKey(record);
      if (key) keys.add(key);
    }
    return keys.size;
  }

  function deriveTargetedPromptRepairPlan() {
    const expected = state.expectedPromptCount;
    const collected = promptGroupCount();
    if (!Number.isInteger(expected) || expected < 1 || collected >= expected) {
      return { ok: false, reason: "no-missing-prompts", expected, collected, missing: [] };
    }

    const missingCount = expected - collected;
    if (missingCount > CONFIG.targetedPromptRepairMaxMissing || missingCount / expected > CONFIG.targetedPromptRepairMaxRatio) {
      return { ok: false, reason: "too-many-missing-prompts", expected, collected, missingCount, missing: [] };
    }

    const skeleton = collectTurnSkeleton();
    if (!skeleton.length) return { ok: false, reason: "turn-skeleton-unavailable", expected, collected, missingCount, missing: [] };
    const slotByTurnId = new Map(skeleton.map(slot => [slot.turnId, slot]));
    const votes = { user: [0, 0], assistant: [0, 0] };
    const seenRoleTurns = new Set();

    for (const record of state.records.values()) {
      if (!record?.turnId || !["user", "assistant"].includes(record.role)) continue;
      const key = `${record.turnId}|${record.role}`;
      if (seenRoleTurns.has(key)) continue;
      seenRoleTurns.add(key);
      const slot = slotByTurnId.get(record.turnId);
      if (!slot) continue;
      votes[record.role][slot.index % 2]++;
    }

    const userParity = votes.user[0] >= votes.user[1] ? 0 : 1;
    const userEvidence = votes.user[userParity];
    const userViolations = votes.user[1 - userParity];
    const assistantExpectedParity = 1 - userParity;
    const assistantEvidence = votes.assistant[assistantExpectedParity];
    const assistantViolations = votes.assistant[userParity];
    if (userEvidence < 3 || assistantEvidence < 2 || userViolations > 0 || assistantViolations > 0) {
      return {
        ok: false,
        reason: "skeleton-parity-not-proven",
        expected,
        collected,
        missingCount,
        userParity,
        userEvidence,
        userViolations,
        assistantEvidence,
        assistantViolations,
        missing: []
      };
    }

    const promptSlots = skeleton.filter(slot => slot.index % 2 === userParity);
    if (promptSlots.length !== expected) {
      return { ok: false, reason: "prompt-slot-count-mismatch", expected, collected, missingCount, promptSlots: promptSlots.length, userParity, missing: [] };
    }

    const knownUserTurns = new Set();
    for (const record of state.records.values()) if (record?.role === "user" && record.turnId) knownUserTurns.add(record.turnId);
    const missing = [];
    for (let promptIndex = 0; promptIndex < promptSlots.length; promptIndex++) {
      const slot = promptSlots[promptIndex];
      if (!knownUserTurns.has(slot.turnId)) missing.push({ promptIndex, turnId: slot.turnId, slotIndex: slot.index });
    }
    if (missing.length !== missingCount) {
      return {
        ok: false,
        reason: "missing-prompt-count-mismatch",
        expected,
        collected,
        missingCount,
        inferredMissing: missing.length,
        userParity,
        missing
      };
    }

    for (const item of missing) {
      if (!document.querySelector(`[data-toc-item-index="${item.promptIndex}"]`)) {
        return { ok: false, reason: "toc-target-missing", expected, collected, missingCount, userParity, missing, missingTocIndex: item.promptIndex };
      }
    }

    return { ok: true, reason: "proven-by-skeleton-parity", expected, collected, missingCount, userParity, missing, skeletonSlots: skeleton.length };
  }

  async function visitTocPrompt(container, promptIndex, reason = "repair") {
    await waitForVisible();
    const button = document.querySelector(`[data-toc-item-index="${promptIndex}"]`);
    if (!button) {
      logEvent("TARGETED_PROMPT_VISIT", { promptIndex, reason, result: "toc-button-missing" });
      return false;
    }
    const beforeRecords = state.records.size;
    const beforePrompts = promptGroupCount();
    try { button.click(); } catch (error) {
      logEvent("TARGETED_PROMPT_VISIT", { promptIndex, reason, result: "click-error", error: error?.message || error });
      return false;
    }
    if (CONFIG.targetedPromptRepairSettleMs > 0) await sleep(CONFIG.targetedPromptRepairSettleMs);
    await waitForDomStability(container, false);
    const snapshot = await processCurrentSnapshot(container);
    const afterPrompts = promptGroupCount();
    logEvent("TARGETED_PROMPT_VISIT", {
      promptIndex,
      reason,
      result: "visited",
      newMessages: Math.max(0, state.records.size - beforeRecords),
      newPromptGroups: Math.max(0, afterPrompts - beforePrompts),
      promptGroupsCollected: afterPrompts,
      expectedPrompts: state.expectedPromptCount ?? "unknown",
      domMessages: snapshot.ids.length
    });
    return true;
  }

  async function targetedRepairPromptGroups(container) {
    await waitForVisible();
    const initialPlan = deriveTargetedPromptRepairPlan();
    if (!initialPlan.ok) {
      logEvent("TARGETED_PROMPT_REPAIR_SKIPPED", {
        reason: initialPlan.reason,
        expectedPrompts: initialPlan.expected ?? "unknown",
        promptGroupsCollected: initialPlan.collected ?? promptGroupCount(),
        missingPrompts: initialPlan.missingCount ?? "unknown",
        inferredMissing: initialPlan.inferredMissing ?? "",
        userParity: initialPlan.userParity ?? ""
      });
      return { attempted: false, resolved: false, reason: initialPlan.reason, plan: initialPlan };
    }

    state.currentPhase = "TARGETED_PROMPT_REPAIR";
    state.currentStatus = `Адресно добираю ${initialPlan.missingCount} отсутствующих prompt-групп…`;
    renderOverlay();
    logEvent("TARGETED_PROMPT_REPAIR_START", {
      expectedPrompts: initialPlan.expected,
      promptGroupsCollected: initialPlan.collected,
      missingPrompts: initialPlan.missingCount,
      userParity: initialPlan.userParity,
      skeletonSlots: initialPlan.skeletonSlots,
      promptIndexes: initialPlan.missing.map(item => item.promptIndex).join(","),
      turnIds: initialPlan.missing.map(item => item.turnId).join(",")
    });

    const targetSet = new Set();
    for (const item of initialPlan.missing) {
      for (let d = -CONFIG.targetedPromptRepairNeighborRadius; d <= CONFIG.targetedPromptRepairNeighborRadius; d++) {
        const idx = item.promptIndex + d;
        if (idx >= 0 && idx < initialPlan.expected) targetSet.add(idx);
      }
    }
    const targets = [...targetSet].sort((a, b) => a - b);

    let visits = 0;
    for (let round = 1; round <= CONFIG.targetedPromptRepairAttempts && !state.cancelRequested; round++) {
      for (const promptIndex of targets) {
        await waitForVisible();
        if (state.cancelRequested) break;
        await visitTocPrompt(container, promptIndex, round === 1 ? "missing-neighborhood" : "retry-neighborhood");
        visits++;
        renderOverlay();
        if (Number.isInteger(state.expectedPromptCount) && promptGroupCount() >= state.expectedPromptCount) break;
      }
      if (Number.isInteger(state.expectedPromptCount) && promptGroupCount() >= state.expectedPromptCount) break;
    }

    pruneRecoveredResolvedTurns();
    bridgeResolvedSkeletonGaps();
    await saveCheckpoint({ force: true });
    const remaining = Number.isInteger(state.expectedPromptCount) ? Math.max(0, state.expectedPromptCount - promptGroupCount()) : null;
    const resolved = remaining === 0;
    logEvent("TARGETED_PROMPT_REPAIR_RESULT", {
      visits,
      expectedPrompts: state.expectedPromptCount ?? "unknown",
      promptGroupsCollected: promptGroupCount(),
      remainingPrompts: remaining ?? "unknown",
      uniqueMessages: state.records.size,
      resolved
    });
    return { attempted: true, resolved, remaining, visits, plan: initialPlan };
  }

  function refreshExpectedCountFromToc({ force = false, source = "dom" } = {}) {
    const promptCount = getExpectedPromptCount();
    if (!Number.isInteger(promptCount) || promptCount < 1) return false;

    const now = Date.now();
    state.lastTocObservedAt = now;
    if (state.tocCandidateCount !== promptCount) {
      if (Number.isInteger(state.tocCandidateCount) && promptCount < state.tocCandidateCount) {
        logEvent("TOC_IGNORED_LOWER", { source, prompts: promptCount, candidate: state.tocCandidateCount });
        return false;
      }
      state.tocCandidateCount = promptCount;
      state.tocCandidateObservations = 1;
      state.tocCandidateSince = now;
      logEvent("TOC_CANDIDATE", { source, prompts: promptCount });
    } else {
      state.tocCandidateObservations++;
    }

    const stableEnough = state.tocCandidateObservations >= CONFIG.tocStableObservations
      && now - state.tocCandidateSince >= CONFIG.tocStableMs;
    const observedPromptGroups = promptGroupCount();
    const clearlyAhead = promptCount >= observedPromptGroups;
    if (!force && (!stableEnough || !(state.reachedBottom || state.reachedTop) || !clearlyAhead)) return false;

    if (!Number.isInteger(state.expectedPromptCount) || promptCount > state.expectedPromptCount) {
      const previous = state.expectedPromptCount;
      state.expectedPromptCount = promptCount;
      state.expectedMessageCount = null;
      state.expectedCountSource = force ? "toc-final" : "toc-dynamic";
      state.checkpointDirty = true;
      logEvent(previous == null ? "EXPECTED_PROMPTS_SET" : "EXPECTED_PROMPTS_REVISED", {
        source, prompts: promptCount, previous: previous ?? "unknown", observedPromptGroups
      });
      return true;
    }
    return false;
  }

  function collectSnapshot({ captureProcessing = false, markAuxiliary = false } = {}) {
    const dateMap = getCurrentDateMap();
    const items = [];
    const seen = new Set();
    for (const messageEl of document.querySelectorAll(MESSAGE_SELECTOR)) {
      const record = extractMessage(messageEl, dateMap, { captureProcessing });
      if (!record || seen.has(record.messageId)) continue;
      seen.add(record.messageId);
      observeRecord(record);
      if (markAuxiliary) state.auxiliaryVisitedIds.add(record.messageId);
      items.push({ messageId: record.messageId, role: record.role, turnId: record.turnId || "", observedTurnIndex: record.observedTurnIndex, element: messageEl });
    }

    for (let i=0;i<items.length-1;i++) {
      const a = items[i], b = items[i+1];
      const sameTurn = Boolean(a.turnId && b.turnId && a.turnId === b.turnId)
        || (Number.isFinite(a.observedTurnIndex) && Number.isFinite(b.observedTurnIndex) && b.observedTurnIndex === a.observedTurnIndex);
      const nextTurn = Number.isFinite(a.observedTurnIndex) && Number.isFinite(b.observedTurnIndex)
        && b.observedTurnIndex === a.observedTurnIndex + 1;
      if (sameTurn || nextTurn) addEdge(a.messageId, b.messageId);
    }

    const ids = items.map(item => item.messageId);
    refreshExpectedCountFromToc({ source: "snapshot" });
    return { items, ids, first: items[0] || null, last: items.at(-1) || null };
  }

  function intersectionCount(a, b) {
    const set = new Set(a || []);
    let n = 0;
    for (const id of b || []) if (set.has(id)) n++;
    return n;
  }

  async function waitForProcessingContent(button, turnEl) {
    let started = performance.now();
    let resumeEpoch = state.visibilityResumeEpoch;
    while (!state.cancelRequested && button?.isConnected && turnEl?.isConnected) {
      const resumed = await waitForVisible();
      if (resumed || resumeEpoch !== state.visibilityResumeEpoch) { started = performance.now(); resumeEpoch = state.visibilityResumeEpoch; }
      const root = processingDetailRoot(button, turnEl);
      if (button.getAttribute("aria-expanded") === "true" && normalizeText(root?.innerText || root?.textContent || "")) return true;
      if (performance.now() - started >= CONFIG.auxiliaryExpandMaxWaitMs) return false;
      await sleep(160);
    }
    return false;
  }

  function processingCapturedFor(messageId, label) {
    return (state.records.get(messageId)?.processing || []).some(item => item?.label === label && item?.captured);
  }

  async function processCurrentSnapshot(container) {
    await waitForVisible();
    const anchor = scrollMetrics(container).top;
    const base = collectSnapshot({ captureProcessing: false, markAuxiliary: true });
    let expandedAny = false;

    for (const item of base.items) {
      await waitForVisible();
      if (state.cancelRequested || item.role !== "assistant") continue;
      const turnEl = item.element.closest(TURN_SELECTOR) || item.element;
      const buttons = processingDisclosureButtons(turnEl);
      if (!buttons.length) continue;
      const opened = [];

      for (const button of buttons) {
        const label = normalizeText(button.innerText || button.textContent || button.getAttribute("aria-label") || "");
        if (processingCapturedFor(item.messageId, label)) continue;
        if (button.getAttribute("aria-expanded") !== "true") {
          try { button.click(); opened.push(button); expandedAny = true; } catch {}
        }
      }
      for (const button of buttons) {
        const label = normalizeText(button.innerText || button.textContent || button.getAttribute("aria-label") || "");
        if (!processingCapturedFor(item.messageId, label)) await waitForProcessingContent(button, turnEl);
      }
      const enriched = extractMessage(item.element, getCurrentDateMap(), { captureProcessing: true });
      if (enriched) observeRecord(enriched);
      for (const button of opened) {
        if (button?.isConnected && button.getAttribute("aria-expanded") === "true") {
          try { button.click(); } catch {}
        }
      }
    }

    if (expandedAny) {
      await sleep(120);
      try { scrollMetrics(container).setTop(anchor); } catch {}
      await sleep(80);
    }

    const finalSnapshot = collectSnapshot({ captureProcessing: false, markAuxiliary: true });
    await saveCheckpoint();
    return finalSnapshot;
  }

  function findScrollContainer() {
    const firstMessage = document.querySelector(MESSAGE_SELECTOR);
    if (!firstMessage) return document.scrollingElement || document.documentElement;
    const candidates = [];
    let node = firstMessage.parentElement;
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node);
      const range = node.scrollHeight - node.clientHeight;
      if (node.clientHeight > 200 && range > 200 && /auto|scroll|overlay/.test(style.overflowY)) candidates.push({ node, range });
      node = node.parentElement;
    }
    if (candidates.length) return candidates.sort((a,b) => b.range - a.range)[0].node;
    return document.scrollingElement || document.documentElement;
  }

  function scrollMetrics(container) {
    const isDocument = container === document.scrollingElement || container === document.documentElement || container === document.body;
    if (isDocument) {
      const el = document.scrollingElement || document.documentElement;
      return {
        top: el.scrollTop,
        height: el.scrollHeight,
        client: window.innerHeight || el.clientHeight,
        setTop: value => window.scrollTo(0, value),
        scrollBy: delta => window.scrollBy(0, delta)
      };
    }
    return {
      top: container.scrollTop,
      height: container.scrollHeight,
      client: container.clientHeight,
      setTop: value => { container.scrollTop = value; },
      scrollBy: delta => { container.scrollTop += delta; }
    };
  }

  function isAtBottom(metrics) { return metrics.height - metrics.client - metrics.top <= 8; }
  function isAtTop(metrics) { return metrics.top <= 8; }

  function beginVisibilityPause() {
    if (!state.running || state.visibilityPaused || document.visibilityState !== "hidden") return;
    state.visibilityPaused = true;
    state.visibilityPhaseBeforePause = state.currentPhase === "PAUSED_HIDDEN" ? (state.visibilityPhaseBeforePause || "INITIALIZING") : state.currentPhase;
    state.visibilityPauseStartedAt = Date.now();
    state.currentPhase = "PAUSED_HIDDEN";
    logEvent("TAB_HIDDEN", { previousPhase: state.visibilityPhaseBeforePause || "unknown" });
    logEvent("PAUSE_HIDDEN", { records: state.records.size, promptGroupsCollected: promptGroupCount() });
    renderOverlay("Вкладка неактивна. Сканирование приостановлено; checkpoint сохранен. Продолжу после возврата.");
    saveCheckpoint({ force: true, status: "PAUSED_HIDDEN" }).catch(() => {});
  }

  function endVisibilityPause() {
    if (!state.visibilityPaused || document.visibilityState !== "visible") return;
    const pausedMs = state.visibilityPauseStartedAt ? Math.max(0, Date.now() - state.visibilityPauseStartedAt) : 0;
    state.visibilityPausedTotalMs += pausedMs;
    state.visibilityPauseStartedAt = 0;
    state.visibilityPaused = false;
    const resumePhase = state.visibilityPhaseBeforePause || "INITIALIZING";
    state.visibilityPhaseBeforePause = "";
    state.currentPhase = resumePhase;
    state.visibilityResumeEpoch++;
    logEvent("TAB_VISIBLE", { pausedMs, resumePhase });
    logEvent("RESUME_AFTER_HIDDEN", { pausedMs, records: state.records.size, promptGroupsCollected: promptGroupCount() });
    renderOverlay("Вкладка активна. Восстанавливаю DOM и продолжаю сканирование…");
    saveCheckpoint({ force: true, status: "RUNNING" }).catch(() => {});
  }

  function installVisibilityGuard() {
    if (state.visibilityListenerInstalled) return;
    document.addEventListener("visibilitychange", () => {
      if (!state.running) return;
      if (document.visibilityState === "hidden") beginVisibilityPause();
      else if (document.visibilityState === "visible") endVisibilityPause();
    }, true);
    state.visibilityListenerInstalled = true;
  }

  async function waitForVisible() {
    if (document.visibilityState === "hidden") beginVisibilityPause();
    if (!state.visibilityPaused && document.visibilityState === "visible") return false;
    const epochBefore = state.visibilityResumeEpoch;
    await new Promise(resolve => {
      const onVisibility = () => {
        if (document.visibilityState !== "visible") return;
        document.removeEventListener("visibilitychange", onVisibility, true);
        resolve();
      };
      document.addEventListener("visibilitychange", onVisibility, true);
    });
    endVisibilityPause();
    if (CONFIG.visibilityResumeSettleMs > 0) await sleep(CONFIG.visibilityResumeSettleMs);
    return state.visibilityResumeEpoch !== epochBefore;
  }

  async function waitForDomStability(container, edgeMode = false) {
    await waitForVisible();
    let started = performance.now();
    let lastChange = started;
    let lastSig = "";
    let resumeEpoch = state.visibilityResumeEpoch;
    const minimum = edgeMode ? CONFIG.edgeMinWaitMs : CONFIG.regularMinWaitMs;
    const maximum = edgeMode ? CONFIG.edgeMaxWaitMs : CONFIG.regularMaxWaitMs;

    while (!state.cancelRequested) {
      await sleep(180);
      const resumed = await waitForVisible();
      if (resumed || resumeEpoch !== state.visibilityResumeEpoch) {
        started = performance.now();
        lastChange = started;
        lastSig = "";
        resumeEpoch = state.visibilityResumeEpoch;
      }
      const snap = collectSnapshot({ captureProcessing: false, markAuxiliary: false });
      const m = scrollMetrics(container);
      const sig = `${snap.ids.join("|")}::${Math.round(m.top)}::${m.height}`;
      if (sig !== lastSig) { lastSig = sig; lastChange = performance.now(); }
      await saveCheckpoint();
      const now = performance.now();
      if (now - started >= minimum && now - lastChange >= CONFIG.quietWindowMs) break;
      if (now - started >= maximum) break;
    }
  }

  function logEvent(type, fields = {}) {
    const entry = {
      t: Date.now(),
      elapsedMs: elapsedMs(),
      type,
      ...fields
    };
    state.logEntries.push(entry);
    if (state.logEntries.length > 12000) state.logEntries.shift();
  }

  function serializeLog() {
    const lines = [
      `Chat Context Exporter ${VERSION}`,
      `Started: ${new Date(state.startedAt).toISOString()}`,
      `URL: ${location.href}`,
      `Title: ${state.pageTitle}`,
      `Settings: autoSaveExport=${state.settings.autoSaveExport}; saveDiagnosticLog=${state.settings.saveDiagnosticLog}`,
      "",
      "time\telapsed\tevent\tdetails"
    ];
    for (const entry of state.logEntries) {
      const { t, elapsedMs: e, type, ...fields } = entry;
      const details = Object.entries(fields).map(([k,v]) => `${k}=${Array.isArray(v) ? v.join(",") : (v && typeof v === "object" ? JSON.stringify(v) : String(v))}`).join("; ");
      lines.push(`${new Date(t).toISOString()}\t${formatDuration(e)}\t${type}\t${details}`);
    }
    return `${lines.join("\n")}\n`;
  }

  async function downloadText(filename, content, mimeType, saveAs) {
    const response = await chrome.runtime.sendMessage({
      type: "chat-context-exporter:download-text",
      filename,
      content,
      mimeType,
      saveAs: Boolean(saveAs)
    });
    if (!response?.ok) throw new Error(response?.error || "Не удалось сохранить файл");
    return response;
  }

  async function maybeSaveLog(force = false) {
    if (state.logSaved) return;
    if (!state.settings.saveDiagnosticLog && !force) return;
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "_");
    const filename = `Chat Context Exporter - ${stamp}.log`;
    await downloadText(filename, serializeLog(), "text/plain", false);
    state.logSaved = true;
  }

  async function maybeSaveLogSafe(force = false) {
    try {
      await maybeSaveLog(force);
      return true;
    } catch (error) {
      logEvent("LOG_SAVE_ERROR", { error: error?.message || error });
      return false;
    }
  }

  function checkpointPayload(status = "RUNNING") {
    return {
      schema: 16,
      version: VERSION,
      conversationKey: state.conversationKey,
      status,
      savedAt: Date.now(),
      records: [...state.records.values()].map(r => ({
        messageId: r.messageId,
        role: r.role,
        turnId: r.turnId || "",
        markdown: r.markdown || "",
        attachments: r.attachments || [],
        generatedArtifacts: r.generatedArtifacts || [],
        processing: r.processing || [],
        dateLabel: r.dateLabel || "",
        dateLabelEvidence: r.dateLabelEvidence || {},
        signature: r.signature || "",
        stable: Boolean(r.stable),
        observedTurns: r.observedTurns || [],
        observedTurnIds: r.observedTurnIds || [],
        lastObservedTurnIndex: r.lastObservedTurnIndex ?? r.observedTurnIndex ?? null,
        lastSeenAt: r.lastSeenAt || 0
      })),
      observations: [...state.observations.entries()],
      edgeCounts: [...state.edgeCounts.entries()],
      auxiliaryVisitedIds: [...state.auxiliaryVisitedIds],
      confirmedEmptyTurnIds: [...state.confirmedEmptyTurnIds],
      resolvedNoncanonicalTurns: [...state.resolvedNoncanonicalTurns.entries()],
      confirmedTurnBridges: [...state.confirmedTurnBridges.entries()],
      reachedTop: state.reachedTop,
      reachedBottom: state.reachedBottom,
      topMessageId: state.topMessageId,
      bottomMessageId: state.bottomMessageId,
      bottomRole: state.bottomRole,
      expectedPromptCount: state.expectedPromptCount,
      expectedMessageCount: state.expectedMessageCount,
      expectedCountSource: state.expectedCountSource,
      tocCandidateCount: state.tocCandidateCount,
      tocCandidateObservations: state.tocCandidateObservations,
      tocCandidateSince: state.tocCandidateSince
    };
  }

  function checkpointPolicy() {
    if (["SCANNING_DOWN", "RECOVERY_SCAN_DOWN"].includes(state.currentPhase)) {
      return {
        everyNewRecords: CONFIG.checkpointScanEveryNewRecords,
        minIntervalMs: CONFIG.checkpointScanMinIntervalMs,
        name: "scan"
      };
    }
    if (state.currentPhase === "SEEKING_TOP") {
      return {
        everyNewRecords: CONFIG.checkpointSeekEveryNewRecords,
        minIntervalMs: CONFIG.checkpointSeekMinIntervalMs,
        name: "seek"
      };
    }
    return {
      everyNewRecords: CONFIG.checkpointEveryNewRecords,
      minIntervalMs: CONFIG.checkpointMinIntervalMs,
      name: "default"
    };
  }

  async function saveCheckpoint({ force = false, status = "RUNNING" } = {}) {
    if (!state.checkpointKey) return;
    const now = Date.now();
    const newRecords = state.records.size - state.recordsAtCheckpoint;
    const policy = checkpointPolicy();
    if (!force && (!state.checkpointDirty || (newRecords < policy.everyNewRecords && now - state.lastCheckpointAt < policy.minIntervalMs))) return;
    const payload = checkpointPayload(status);
    state.checkpointInFlight = state.checkpointInFlight.then(() => chrome.storage.local.set({ [state.checkpointKey]: payload })).catch(() => {});
    await state.checkpointInFlight;
    state.lastCheckpointAt = now;
    state.recordsAtCheckpoint = state.records.size;
    state.checkpointDirty = false;
    logEvent("CHECKPOINT", { records: state.records.size, edges: state.edgeCounts.size, status, policy: checkpointPolicy().name });
  }

  async function loadCheckpoint() {
    try {
      const result = await chrome.storage.local.get(state.checkpointKey);
      const cp = result?.[state.checkpointKey];
      if (!cp || ![15,16].includes(cp.schema) || cp.conversationKey !== state.conversationKey || !Array.isArray(cp.records)) return null;
      const legacyDateMetadata = cp.schema === 15;
      for (const r of cp.records) {
        if (!r?.messageId || !["user","assistant"].includes(r.role)) continue;
        const restored = {
          ...r,
          observedTurnIndex: r.lastObservedTurnIndex ?? null,
          // Schema 15 used inherited date labels and "first observation wins".
          // Keep all expensive scan/checkpoint evidence, but intentionally
          // reacquire date-boundary metadata under the safer 1.0.23 rules.
          dateLabel: legacyDateMetadata ? "" : normalizeText(r.dateLabel || ""),
          dateLabelEvidence: legacyDateMetadata ? {} : { ...(r.dateLabelEvidence || {}) }
        };
        if (!legacyDateMetadata && restored.dateLabel && !Object.keys(restored.dateLabelEvidence).length) {
          restored.dateLabelEvidence[restored.dateLabel] = 1;
        }
        state.records.set(r.messageId, restored);
      }
      state.observations = new Map(Array.isArray(cp.observations) ? cp.observations : []);
      state.edgeCounts = new Map(Array.isArray(cp.edgeCounts) ? cp.edgeCounts : []);
      state.auxiliaryVisitedIds = new Set(cp.auxiliaryVisitedIds || []);
      state.confirmedEmptyTurnIds = new Set(cp.confirmedEmptyTurnIds || []);
      state.resolvedNoncanonicalTurns = new Map(Array.isArray(cp.resolvedNoncanonicalTurns) ? cp.resolvedNoncanonicalTurns : []);
      state.confirmedTurnBridges = new Map(Array.isArray(cp.confirmedTurnBridges) ? cp.confirmedTurnBridges : []);
      state.reachedTop = Boolean(cp.reachedTop);
      state.reachedBottom = Boolean(cp.reachedBottom);
      state.topMessageId = cp.topMessageId || "";
      state.bottomMessageId = cp.bottomMessageId || "";
      state.bottomRole = cp.bottomRole || "";
      state.expectedPromptCount = Number.isInteger(cp.expectedPromptCount) ? cp.expectedPromptCount : null;
      state.expectedMessageCount = Number.isInteger(cp.expectedMessageCount) ? cp.expectedMessageCount : null;
      state.expectedCountSource = cp.expectedCountSource || "unknown";
      state.tocCandidateCount = Number.isInteger(cp.tocCandidateCount) ? cp.tocCandidateCount : null;
      state.tocCandidateObservations = Number.isInteger(cp.tocCandidateObservations) ? cp.tocCandidateObservations : 0;
      state.tocCandidateSince = Number.isFinite(cp.tocCandidateSince) ? cp.tocCandidateSince : 0;
      state.recordsAtCheckpoint = state.records.size;
      state.lastCheckpointAt = Date.now();
      logEvent("CHECKPOINT_LOADED", { records: state.records.size, edges: state.edgeCounts.size, status: cp.status || "?", schema: cp.schema, dateMetadataMigrated: cp.schema === 15 });
      return cp;
    } catch (error) {
      logEvent("CHECKPOINT_LOAD_ERROR", { error: error?.message || error });
      return null;
    }
  }

  async function clearCheckpoint() {
    if (!state.checkpointKey) return;
    try { await chrome.storage.local.remove(state.checkpointKey); } catch {}
  }

  function stableRecordCount() {
    let n = 0;
    for (const r of state.records.values()) if (r.stable) n++;
    return n;
  }

  function buildBackwardChainFromBottom() {
    if (!state.bottomMessageId) return { ids: [], ambiguities: [] };
    const reversed = [];
    const seen = new Set();
    const ambiguities = [];
    let current = state.bottomMessageId;
    while (current && !seen.has(current) && reversed.length <= state.records.size + 5) {
      reversed.push(current);
      seen.add(current);
      const forcedBridge = confirmedBridgePredecessor(current);
      if (forcedBridge) {
        current = forcedBridge.id;
        continue;
      }
      const candidates = edgeCandidatesTo(current).filter(x => {
        const a = state.records.get(x.id), b = state.records.get(current);
        return Boolean(a && b);
      });
      if (!candidates.length) break;
      if (candidates.length > 1 && candidates[0].count === candidates[1].count) ambiguities.push(current);
      current = candidates[0].id;
    }
    return { ids: reversed.reverse(), ambiguities };
  }

  function progressStats() {
    const promptGroupsDone = promptGroupCount();
    const totalPrompts = state.expectedPromptCount;
    let percent = Number.isInteger(totalPrompts) && totalPrompts > 0
      ? Math.max(0, Math.min(100, promptGroupsDone / totalPrompts * 100))
      : null;
    if (percent === 100 && (state.currentPhase === "SCANNING_UP" || state.currentPhase === "CONTROL_SCAN_UP") && !state.reachedTop) percent = 99.9;
    if (percent === 100 && (state.currentPhase === "SCANNING_DOWN" || state.currentPhase === "RECOVERY_SCAN_DOWN") && !state.reachedBottom) percent = 99.9;
    const remainingPrompts = Number.isInteger(totalPrompts) ? Math.max(0, totalPrompts - promptGroupsDone) : null;
    const chain = buildChain();
    // Keep the turn-slot line live during both full scans. In 1.0.14 this
    // field showed the last VERIFY snapshot and could stay at 104/112 even
    // after the control scan had already collected 110 canonical messages.
    const skeleton = collectTurnSkeleton().length ? skeletonCoverageStats() : (state.lastSkeletonStats || null);
    return {
      promptGroupsDone,
      totalPrompts,
      remainingPrompts,
      collectedMessages: stableRecordCount(),
      uniqueMessages: state.records.size,
      percent,
      chain,
      skeleton
    };
  }

  function renderOverlay(statusOverride = "") {
    const overlay = ensureOverlay();
    if (statusOverride) state.currentStatus = statusOverride;
    if (state.apiMode) {
      renderApiProgress(overlay);
      return;
    }
    overlay.bar.classList.remove("indeterminate");
    if (overlay.totalLabelEl) overlay.totalLabelEl.textContent = "Всего запросов";
    if (overlay.savedLabelEl) overlay.savedLabelEl.textContent = "Пройдено запросов";
    if (overlay.remainingLabelEl) overlay.remainingLabelEl.textContent = "Осталось запросов";
    if (overlay.messagesLabelEl) overlay.messagesLabelEl.textContent = "Собрано сообщений";
    if (overlay.structureLabelEl) overlay.structureLabelEl.textContent = "Структура turn-slot";
    if (overlay.percentLabelEl) overlay.percentLabelEl.textContent = "Прогресс сканирования";
    const p = progressStats();
    const pct = p.percent == null ? null : p.percent;
    overlay.timeEl.textContent = formatDuration(elapsedMs());
    overlay.phaseEl.textContent = phaseLabel(state.currentPhase);
    overlay.savedEl.textContent = p.totalPrompts == null ? `${p.promptGroupsDone}` : `${p.promptGroupsDone} / ${p.totalPrompts}`;
    overlay.remainingEl.textContent = p.remainingPrompts == null ? "—" : String(p.remainingPrompts);
    overlay.totalEl.textContent = p.totalPrompts == null ? "определяется" : String(p.totalPrompts);
    if (overlay.messagesEl) overlay.messagesEl.textContent = String(p.collectedMessages);
    if (overlay.structureEl) {
      const sk = p.skeleton;
      overlay.structureEl.textContent = sk?.total ? `${sk.resolvedSlots} / ${sk.total}` : "—";
    }
    overlay.percentEl.textContent = pct == null ? "—" : `${pct.toFixed(1)}%`;
    overlay.bar.classList.toggle("hidden", pct == null);
    overlay.barFill.style.width = pct == null ? "0%" : `${pct}%`;
    overlay.statusEl.textContent = state.currentStatus || defaultStatusText(p);
  }

  function updateApiProgress(progress) {
    state.apiMode = true;
    state.apiProgress = { ...(state.apiProgress || {}), ...progress };
    const stage = state.apiProgress.stage || "CONNECTING";
    logEvent("API_PROGRESS", { stage, pagesLoaded: state.apiProgress.pagesLoaded ?? 0,
      rawMessages: state.apiProgress.rawMessages ?? 0, records: state.apiProgress.records ?? 0,
      status: state.apiProgress.status || "" });
    state.currentPhase = `API_${stage}`;
    state.currentStatus = state.apiProgress.status || "Обрабатываю историю…";
    renderOverlay();
  }

  function renderApiProgress(overlay) {
    const p = state.apiProgress || {};
    overlay.timeEl.textContent = formatDuration(elapsedMs());
    overlay.phaseEl.textContent = phaseLabel(state.currentPhase);
    if (overlay.totalLabelEl) overlay.totalLabelEl.textContent = "Получено страниц";
    if (overlay.savedLabelEl) overlay.savedLabelEl.textContent = "Получено записей";
    if (overlay.remainingLabelEl) overlay.remainingLabelEl.textContent = "Страницы истории";
    if (overlay.messagesLabelEl) overlay.messagesLabelEl.textContent = "Включено в экспорт";
    if (overlay.structureLabelEl) overlay.structureLabelEl.textContent = "Исключено / пусто";
    if (overlay.percentLabelEl) overlay.percentLabelEl.textContent = "Этап";
    overlay.totalEl.textContent = String(p.pagesLoaded ?? 0);
    overlay.savedEl.textContent = String(p.rawMessages ?? 0);
    overlay.remainingEl.textContent = p.hasPreviousPage === true ? "загрузка" : p.hasPreviousPage === false ? "все получены" : "ожидание ответа";
    if (overlay.messagesEl) overlay.messagesEl.textContent = String(p.records ?? 0);
    if (overlay.structureEl) overlay.structureEl.textContent = `${p.filtered ?? 0} / ${p.emptyContent ?? 0}`;
    overlay.percentEl.textContent = p.stage === "NORMALIZED" || p.stage === "SERIALIZING" || p.stage === "SAVING" || p.stage === "COMPLETE" ? "готово" : "выполняется";
    const busy = ["CONNECTING", "FETCHING", "NORMALIZING", "SERIALIZING", "SAVING"].includes(p.stage);
    overlay.bar.classList.remove("hidden");
    overlay.bar.classList.toggle("indeterminate", busy);
    overlay.barFill.style.width = busy ? "34%" : (["NORMALIZED", "COMPLETE"].includes(p.stage) ? "100%" : "0%");
    overlay.statusEl.textContent = state.currentStatus || "Обрабатываю историю…";
  }

  function phaseLabel(phase) {
    const labels = {
      INITIALIZING: "Подготовка",
      API_CONNECTING: "Подключение к истории чата",
      API_FETCHING: "Загрузка истории через API",
      API_NORMALIZING: "Обработка сообщений",
      API_NORMALIZED: "Подготовка файла",
      API_SERIALIZING: "Формирование Markdown",
      API_SAVING: "Сохранение файла",
      API_COMPLETE: "Готово",
      API_ERROR: "Ошибка API",
      API_CANCELLED: "Остановлено",
      PAUSED_HIDDEN: "Пауза: вкладка неактивна",
      SEEKING_BOTTOM: "Определение конца разговора",
      SEEKING_TOP: "Быстрый поиск начала разговора",
      SCANNING_DOWN: "Сканирование истории вниз",
      RECOVERY_SCAN_DOWN: "Резервное сканирование вниз",
      SCANNING_UP: "Сканирование истории вверх",
      CONTROL_SCAN_UP: "Контрольное сканирование вверх",
      TARGETED_PROMPT_REPAIR: "Точечный добор запросов",
      TARGETED_REPAIR: "Точечная проверка turn-slot",
      VERIFYING: "Проверка полноты",
      COMPLETE: "Готово",
      INCOMPLETE: "Неполный результат",
      ERROR: "Ошибка",
      INTERRUPTED: "Остановлено"
    };
    return labels[phase] || "Ожидание";
  }

  function defaultStatusText(p) {
    if (state.currentPhase === "PAUSED_HIDDEN") return "Вкладка неактивна. Сканирование безопасно приостановлено.";
    if (state.currentPhase === "SEEKING_BOTTOM") return "Определяю общий объем разговора…";
    if (state.currentPhase === "SEEKING_TOP") return "Быстро загружаю старую историю. Встреченные сообщения сохраняются, но доказательный проход начнется от подтвержденного начала.";
    if (state.currentPhase === "SCANNING_DOWN" || state.currentPhase === "RECOVERY_SCAN_DOWN") {
      return Number.isInteger(p.totalPrompts)
        ? `Последовательно сканирую сверху вниз: ${p.promptGroupsDone}/${p.totalPrompts} prompt-групп.`
        : "Последовательно сканирую сверху вниз и ищу полный TOC.";
    }
    if (state.currentPhase === "SCANNING_UP" || state.currentPhase === "CONTROL_SCAN_UP") {
      return p.chain.connectedToBottom ? "Последовательность сообщений связна." : "Собираю и сшиваю последовательность сообщений…";
    }
    if (state.currentPhase === "TARGETED_PROMPT_REPAIR") {
      return Number.isInteger(p.totalPrompts) ? `Адресно добираю отсутствующие prompt-группы: осталось ${p.remainingPrompts}.` : "Адресно добираю отсутствующие запросы…";
    }
    if (state.currentPhase === "TARGETED_REPAIR") {
      const sk = state.lastSkeletonStats;
      return sk?.total ? `Сканирование завершено. Структура: ${sk.resolvedSlots}/${sk.total}; осталось ${sk.unresolvedSlots}.` : "Проверяю только подозрительные turn-slot…";
    }
    if (state.currentPhase === "VERIFYING") {
      const sk = state.lastSkeletonStats;
      return sk?.total ? `Проверяю структуру: ${sk.resolvedSlots}/${sk.total}; неразрешено ${sk.unresolvedSlots}.` : "Проверяю связность и полноту контекста…";
    }
    return "";
  }

  function ensureOverlay() {
    if (state.overlay?.host?.isConnected) return state.overlay;
    const host = document.createElement("div");
    host.id = "chat-context-exporter-overlay";
    host.style.cssText = "all:initial;position:fixed;left:18px;top:18px;z-index:2147483647;display:block;pointer-events:none;max-width:min(338px,calc(100vw - 36px));";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        .box{pointer-events:auto;font-family:Arial,sans-serif;width:min(338px,calc(100vw - 36px));box-sizing:border-box;background:#202020;color:#d8d8d8;border:1px solid #555;border-radius:10px;padding:13px 14px 12px;box-shadow:0 8px 24px rgba(0,0,0,.34)}
        .title{font-size:14px;font-weight:700;color:#e7e7e7;margin-bottom:10px}.phase{font-size:13px;color:#d0d0d0;margin-bottom:9px}.grid{display:grid;grid-template-columns:1fr auto;gap:5px 12px;font-size:12px;line-height:1.35}.k{color:#9d9d9d}.v{color:#dfdfdf;text-align:right;font-variant-numeric:tabular-nums}.bar.indeterminate .fill{width:34%!important;animation:api-sweep 1.2s ease-in-out infinite alternate}@keyframes api-sweep{from{transform:translateX(0)}to{transform:translateX(190%)}}.bar{height:7px;background:#353535;border:1px solid #4c4c4c;border-radius:5px;overflow:hidden;margin:10px 0 8px}.fill{height:100%;width:0;background:#8b8b8b;transition:width .2s linear}.status{font-size:12px;line-height:1.4;color:#bcbcbc;min-height:17px}.actions{display:flex;flex-wrap:wrap;gap:7px;margin-top:11px}.btn{appearance:none;border:1px solid #5d5d5d;background:#2d2d2d;color:#dcdcdc;border-radius:7px;padding:6px 9px;font-size:12px;cursor:pointer}.btn:hover{background:#383838}.primary{background:#d0d0d0;color:#1f1f1f;border-color:#d0d0d0}.primary:hover{background:#e0e0e0}.hidden{display:none!important}
      </style>
      <div class="box">
        <div class="title">Экспортер контекста</div>
        <div class="phase"></div>
        <div class="grid">
          <div class="k">Время</div><div class="v time">00:00</div>
          <div class="k total-label">Всего запросов</div><div class="v total">—</div>
          <div class="k saved-label">Пройдено запросов</div><div class="v saved">0</div>
          <div class="k remaining-label">Осталось запросов</div><div class="v remaining">—</div>
          <div class="k messages-label">Собрано сообщений</div><div class="v messages">0</div>
          <div class="k structure-label">Структура turn-slot</div><div class="v structure">—</div>
          <div class="k percent-label">Прогресс сканирования</div><div class="v percent">—</div>
        </div>
        <div class="bar"><div class="fill"></div></div>
        <div class="status"></div>
        <div class="actions">
          <button class="btn cancel">Отменить</button>
          <button class="btn primary save hidden">Сохранить</button>
          <button class="btn retry hidden">Повторить полный экспорт</button>
          <button class="btn save-partial hidden">Сохранить неполный</button>
          <button class="btn save-log hidden">Скачать лог</button>
        </div>
      </div>`;
    const overlay = {
      host, shadow,
      phaseEl: shadow.querySelector(".phase"),
      timeEl: shadow.querySelector(".time"),
      totalEl: shadow.querySelector(".total"),
      totalLabelEl: shadow.querySelector(".total-label"),
      savedLabelEl: shadow.querySelector(".saved-label"),
      remainingLabelEl: shadow.querySelector(".remaining-label"),
      messagesLabelEl: shadow.querySelector(".messages-label"),
      structureLabelEl: shadow.querySelector(".structure-label"),
      percentLabelEl: shadow.querySelector(".percent-label"),
      savedEl: shadow.querySelector(".saved"),
      remainingEl: shadow.querySelector(".remaining"),
      messagesEl: shadow.querySelector(".messages"),
      structureEl: shadow.querySelector(".structure"),
      percentEl: shadow.querySelector(".percent"),
      bar: shadow.querySelector(".bar"),
      barFill: shadow.querySelector(".fill"),
      statusEl: shadow.querySelector(".status"),
      cancel: shadow.querySelector(".cancel"),
      save: shadow.querySelector(".save"),
      retry: shadow.querySelector(".retry"),
      savePartial: shadow.querySelector(".save-partial"),
      saveLog: shadow.querySelector(".save-log")
    };

    overlay.cancel.addEventListener("click", async () => {
      state.cancelRequested = true;
      state.apiAbortController?.abort();
      if (state.apiMode) updateApiProgress({ stage: "CANCELLED", status: "Останавливаю запрос и сохраняю состояние…" });
      state.currentPhase = "INTERRUPTED";
      renderOverlay("Сохраняю checkpoint и останавливаю…");
      await saveCheckpoint({ force: true, status: "INTERRUPTED" });
    });

    overlay.save.addEventListener("click", async () => {
      if (!state.pendingMarkdown || !state.pendingFilename) return;
      overlay.save.disabled = true;
      if (state.apiMode) updateApiProgress({ stage: "SAVING", status: "Открываю выбор места сохранения…" });
      else renderOverlay("Открываю выбор места сохранения…");
      try {
        await downloadText(state.pendingFilename, state.pendingMarkdown, "text/markdown", true);
        if (state.apiMode) updateApiProgress({ stage: "COMPLETE", status: "Файл Markdown сохранен." });
        else renderOverlay("Файл сохранен.");
        setTimeout(removeOverlay, CONFIG.overlayAutoCloseMs);
      } catch (error) {
        overlay.save.disabled = false;
        if (state.apiMode) updateApiProgress({ stage: "NORMALIZED", status: `Сохранение не выполнено: ${error?.message || error}. Можно повторить.` });
        else renderOverlay(`Сохранение не выполнено: ${error?.message || error}`);
      }
    });

    overlay.retry.addEventListener("click", async () => {
      overlay.retry.classList.add("hidden");
      overlay.savePartial.classList.add("hidden");
      overlay.saveLog.classList.add("hidden");
      await clearCheckpoint();
      start({ fresh: true });
    });

    overlay.savePartial.addEventListener("click", async () => {
      const validation = state.lastValidation || validateCompleteness();
      const markdown = buildMarkdown({ incomplete: true, validation });
      const filename = `НЕПОЛНЫЙ - ${sanitizeFilename(state.pageTitle)}.md`;
      try {
        await downloadText(filename, markdown, "text/markdown", true);
        logEvent("PARTIAL_SAVED", { filename });
        await maybeSaveLogSafe();
        renderOverlay("Неполный экспорт сохранен.");
        setTimeout(removeOverlay, CONFIG.overlayAutoCloseMs);
      } catch (error) {
        renderOverlay(`Сохранение не выполнено: ${error?.message || error}`);
      }
    });

    overlay.saveLog.addEventListener("click", async () => {
      try {
        await maybeSaveLog(true);
        renderOverlay("Диагностический лог сохранен в папку загрузок браузера.");
      } catch (error) {
        renderOverlay(`Лог не сохранен: ${error?.message || error}`);
      }
    });

    (document.documentElement || document.body).appendChild(host);
    state.overlay = overlay;
    return overlay;
  }

  function removeOverlay() {
    stopTimer();
    try { state.overlay?.host?.remove(); } catch {}
    state.overlay = null;
  }

  function startTimer() {
    stopTimer();
    state.timerHandle = setInterval(() => {
      if (state.overlay?.host?.isConnected) renderOverlay();
    }, 1000);
  }

  function stopTimer() {
    if (state.timerHandle) clearInterval(state.timerHandle);
    state.timerHandle = null;
  }

  function setActionButtons({ cancel = false, save = false, retry = false, partial = false, log = false } = {}) {
    const o = ensureOverlay();
    o.cancel.classList.toggle("hidden", !cancel);
    o.save.classList.toggle("hidden", !save);
    o.retry.classList.toggle("hidden", !retry);
    o.savePartial.classList.toggle("hidden", !partial);
    o.saveLog.classList.toggle("hidden", !log);
  }

  async function fastSeekBottom(container) {
    await waitForVisible();
    state.currentPhase = "SEEKING_BOTTOM";
    state.reachedBottom = false;
    state.bottomSeekAttempt = 0;
    let stable = 0;
    let lastId = "";
    let lastExpected = null;

    for (let attempt=1; attempt<=CONFIG.maxBottomSeekAttempts && !state.cancelRequested; attempt++) {
      await waitForVisible();
      state.bottomSeekAttempt = attempt;
      const before = scrollMetrics(container);
      before.setTop(Math.max(0, before.height - before.client));
      renderOverlay("Определяю конец разговора…");
      await waitForDomStability(container, true);
      const snap = await processCurrentSnapshot(container);
      const after = scrollMetrics(container);
      const candidate = snap.last;
      const promptCount = getExpectedPromptCount();

      logEvent("SEEK_BOTTOM", {
        attempt,
        atBottom: isAtBottom(after),
        lastMessageId: candidate?.messageId || "",
        lastRole: candidate?.role || "",
        observedTurn: candidate?.observedTurnIndex ?? "",
        tocPrompts: promptCount ?? "",
        expectedPrompts: state.expectedPromptCount ?? promptCount ?? "",
        domMessages: snap.ids.length
      });

      if (!candidate || !isAtBottom(after)) {
        stable = 0;
        lastId = candidate?.messageId || "";
        lastExpected = promptCount;
        continue;
      }

      if (candidate.messageId === lastId && promptCount === lastExpected) stable++;
      else { stable = 1; lastId = candidate.messageId; lastExpected = promptCount; }

      if (stable >= CONFIG.stableBottomPasses) {
        state.reachedBottom = true;
        state.bottomMessageId = candidate.messageId;
        state.bottomRole = candidate.role;
        state.checkpointDirty = true;
        // Не принимаем единичный TOC у нижней границы как окончательный знаменатель.
        // Общий объем публикуется только через стабильный динамический TOC.
        refreshExpectedCountFromToc({ source: "bottom-confirmed" });
        logEvent("BOTTOM_CONFIRMED", {
          lastMessageId: candidate.messageId,
          lastRole: candidate.role,
          tocPrompts: promptCount ?? "",
          expectedPrompts: state.expectedPromptCount ?? promptCount ?? "unknown",
          stablePasses: stable
        });
        await saveCheckpoint({ force: true });
        renderOverlay(Number.isInteger(state.expectedPromptCount) ? `Конец подтвержден. TOC: ${state.expectedPromptCount} запросов.` : "Конец подтвержден. Общее число запросов определится после прохода.");
        return { reached: true, snapshot: snap };
      }
    }
    return { reached: false, reason: state.cancelRequested ? "cancelled" : "bottom-not-stable" };
  }


  function topHistoryFingerprint(container) {
    const turns = outerTurnContainers();
    const metrics = scrollMetrics(container);
    return {
      slots: turns.length,
      firstTurnId: normalizeText(turns[0]?.getAttribute?.("data-turn-id-container") || ""),
      lastTurnId: normalizeText(turns.at(-1)?.getAttribute?.("data-turn-id-container") || ""),
      rootPresent: Boolean(document.querySelector(ROOT_SENTINEL_SELECTOR)),
      scrollTop: Math.round(metrics.top),
      scrollHeight: Math.round(metrics.height)
    };
  }

  function topHistoryExpanded(before, after) {
    if (!before || !after) return false;
    return after.slots > before.slots
      || Boolean(before.firstTurnId && after.firstTurnId && before.firstTurnId !== after.firstTurnId);
  }

  async function waitForTopHistoryExpansion(container, baseline) {
    await waitForVisible();
    let started = performance.now();
    let resumeEpoch = state.visibilityResumeEpoch;
    let last = baseline;
    while (!state.cancelRequested && performance.now() - started < CONFIG.fastTopProbeMs) {
      await sleep(CONFIG.fastTopPollMs);
      const resumed = await waitForVisible();
      if (resumed || resumeEpoch !== state.visibilityResumeEpoch) {
        started = performance.now();
        resumeEpoch = state.visibilityResumeEpoch;
        last = topHistoryFingerprint(container);
        continue;
      }
      const current = topHistoryFingerprint(container);
      if (topHistoryExpanded(baseline, current)) {
        await waitForDomStability(container, false);
        return { expanded: true, before: baseline, after: topHistoryFingerprint(container) };
      }
      last = current;
    }
    return { expanded: false, before: baseline, after: last };
  }

  async function fastSeekTop(container, { recovery = false } = {}) {
    await waitForVisible();
    state.currentPhase = "SEEKING_TOP";
    state.reachedTop = false;
    let stable = 0;
    let snapshot = collectSnapshot({ captureProcessing: false, markAuxiliary: true });

    logEvent("FAST_SEEK_TOP_START", {
      recovery,
      records: state.records.size,
      promptGroupsCollected: promptGroupCount(),
      skeletonSlots: collectTurnSkeleton().length,
      expectedPrompts: state.expectedPromptCount ?? "unknown"
    });

    for (let cycle = 1; cycle <= CONFIG.fastTopMaxCycles && !state.cancelRequested; cycle++) {
      await waitForVisible();
      const metrics = scrollMetrics(container);
      metrics.setTop(0);
      await sleep(100);
      // Opportunistic collection only. This phase is not used as proof of continuity.
      snapshot = collectSnapshot({ captureProcessing: false, markAuxiliary: true });
      await saveCheckpoint();
      const baseline = topHistoryFingerprint(container);
      state.currentStatus = `Быстрый поиск начала: цикл ${cycle}. Загружено turn-slot: ${baseline.slots}.`;
      renderOverlay();

      const probe = await waitForTopHistoryExpansion(container, baseline);
      snapshot = collectSnapshot({ captureProcessing: false, markAuxiliary: true });
      const after = topHistoryFingerprint(container);
      const candidate = snapshot.first;
      const expanded = probe.expanded || topHistoryExpanded(baseline, after);

      if (expanded) stable = 0;
      else if (candidate && isAtTop(scrollMetrics(container))) stable++;
      else stable = 0;

      logEvent(expanded ? "TOP_EXPANDED" : "TOP_STABILIZATION", {
        cycle,
        recovery,
        stable,
        stableRequired: CONFIG.fastTopStablePasses,
        skeletonBefore: baseline.slots,
        skeletonAfter: after.slots,
        firstTurnBefore: baseline.firstTurnId,
        firstTurnAfter: after.firstTurnId,
        firstMessageId: candidate?.messageId || "",
        firstRole: candidate?.role || "",
        rootSentinel: after.rootPresent,
        records: state.records.size,
        promptGroupsCollected: promptGroupCount(),
        tocPrompts: getExpectedPromptCount() ?? "unknown"
      });

      if (stable >= CONFIG.fastTopStablePasses && candidate) {
        state.reachedTop = true;
        state.topMessageId = candidate.messageId;
        state.checkpointDirty = true;
        refreshExpectedCountFromToc({ force: true, source: "true-top-confirmed" });
        logEvent("TRUE_TOP_CONFIRMED", {
          cycle,
          recovery,
          firstMessageId: candidate.messageId,
          firstRole: candidate.role,
          skeletonSlots: after.slots,
          rootSentinel: after.rootPresent,
          expectedPrompts: state.expectedPromptCount ?? "unknown",
          records: state.records.size,
          promptGroupsCollected: promptGroupCount()
        });
        await saveCheckpoint({ force: true });
        state.currentStatus = Number.isInteger(state.expectedPromptCount)
          ? `Начало подтверждено. TOC: ${state.expectedPromptCount} запросов. Начинаю доказательное сканирование вниз.`
          : "Начало подтверждено. Начинаю доказательное сканирование вниз; TOC будет принят, когда станет доступен.";
        renderOverlay();
        return { reached: true, snapshot, cycles: cycle };
      }
    }

    logEvent("TRUE_TOP_NOT_CONFIRMED", {
      recovery,
      records: state.records.size,
      promptGroupsCollected: promptGroupCount(),
      skeletonSlots: collectTurnSkeleton().length
    });
    return { reached: false, snapshot, reason: state.cancelRequested ? "cancelled" : "top-not-stable" };
  }

  function elementContentBounds(container, element) {
    if (!element?.isConnected || !element?.getBoundingClientRect) return null;
    const metrics = scrollMetrics(container);
    const rect = element.getBoundingClientRect();
    const isDocument = container === document.scrollingElement || container === document.documentElement || container === document.body;
    const top = isDocument
      ? metrics.top + rect.top
      : metrics.top + (rect.top - container.getBoundingClientRect().top);
    const height = Math.max(0, rect.height || (rect.bottom - rect.top) || 0);
    return { top, bottom: top + height, height };
  }

  function boundaryJumpPlan(container, snapshot, scanNo = 1, gainScale = 1) {
    const metrics = scrollMetrics(container);
    const nearbyMargin = metrics.client * CONFIG.boundaryNearbyViewportMargin;
    let candidate = null;

    // Виртуализированный ChatGPT иногда оставляет старые turn-элементы в DOM,
    // хотя они находятся на десятки/сотни тысяч px выше текущего viewport.
    // Такой узел не является реальной границей текущего окна и использовать его
    // как anchor нельзя. Берем самый ранний turn, который физически пересекает
    // текущую область или находится непосредственно рядом с ней.
    for (const item of snapshot?.items || []) {
      const boundaryEl = item?.element?.closest?.(TURN_SELECTOR) || item?.element;
      const bounds = elementContentBounds(container, boundaryEl);
      if (!bounds || !Number.isFinite(bounds.top) || !Number.isFinite(bounds.bottom)) continue;
      if (bounds.bottom < metrics.top - nearbyMargin) continue;
      if (bounds.top > metrics.top + metrics.client + nearbyMargin) continue;
      candidate = { item, bounds };
      break;
    }
    if (!candidate) return null;

    const { item: firstItem, bounds } = candidate;
    const prefetch = Math.max(120, metrics.client * CONFIG.boundaryPrefetchRatio);
    const target = Math.max(0, bounds.top - prefetch);
    const rawGain = metrics.top - target;
    const minGain = Math.max(CONFIG.minStepPx, metrics.client * CONFIG.boundaryMinGainRatio);
    if (rawGain < minGain) return null;

    // Если текущий viewport находится внутри уже считанного длинного turn, можно
    // безопасно быстро пройти его собственную высоту: содержимое turn уже целиком
    // прочитано из DOM. Переход через верхнюю границу turn гораздо осторожнее:
    // там должны появиться новые исторические message-id, иначе выполняется backoff.
    const spansViewportTop = bounds.top < metrics.top - 2 && bounds.bottom > metrics.top + 2;
    const historyLimit = scanNo > 1 ? CONFIG.boundaryControlMaxJumpViewports : CONFIG.boundaryHistoryMaxJumpViewports;
    const maxViewports = spansViewportTop ? CONFIG.boundaryMaxJumpViewports : historyLimit;
    const maxGain = Math.max(minGain, metrics.client * maxViewports * Math.max(0.1, gainScale));
    const gain = Math.min(rawGain, maxGain);
    return {
      target: Math.max(0, metrics.top - gain),
      gain,
      boundaryTop: bounds.top,
      boundaryBottom: bounds.bottom,
      boundaryMessageId: firstItem?.messageId || "",
      kind: spansViewportTop ? "known-message-span" : "history-boundary"
    };
  }

  function locallyAdjacentSnapshotItems(a, b) {
    if (!a || !b) return false;
    if (a.turnId && b.turnId && a.turnId === b.turnId) return true;
    if (!Number.isFinite(a.observedTurnIndex) || !Number.isFinite(b.observedTurnIndex)) return false;
    return b.observedTurnIndex === a.observedTurnIndex
      || b.observedTurnIndex === a.observedTurnIndex + 1;
  }

  function frontierAdvanceEvidence(previousIds, nextSnapshot, boundaryMessageId) {
    const nextItems = nextSnapshot?.items || [];
    const nextIds = nextSnapshot?.ids || [];
    const previous = new Set(previousIds || []);
    const boundaryIndex = boundaryMessageId ? nextIds.indexOf(boundaryMessageId) : -1;
    if (boundaryIndex < 0) {
      return { advanced: false, newBeforeBoundary: 0, boundaryRetained: false, locallyContiguous: false, firstNewIndex: -1 };
    }

    let newBeforeBoundary = 0;
    let firstNewIndex = -1;
    for (let i=0; i<boundaryIndex; i++) {
      if (!previous.has(nextIds[i])) {
        newBeforeBoundary++;
        if (firstNewIndex < 0) firstNewIndex = i;
      }
    }

    let locallyContiguous = firstNewIndex >= 0;
    if (locallyContiguous) {
      // conversation-turn-N нестабилен между разными snapshot и поэтому не является ID.
      // Но внутри одного конкретного DOM-снимка он полезен как локальная проверка:
      // соседние реально смонтированные turn не должны внезапно прыгать через N+2/N+5.
      for (let i=firstNewIndex; i<boundaryIndex; i++) {
        if (!locallyAdjacentSnapshotItems(nextItems[i], nextItems[i + 1])) {
          locallyContiguous = false;
          break;
        }
      }
    }

    return {
      advanced: newBeforeBoundary > 0 && locallyContiguous,
      newBeforeBoundary,
      boundaryRetained: true,
      locallyContiguous,
      firstNewIndex
    };
  }

  async function tryBridgeGap(container, previousIds, step) {
    let delta = step / 2;
    for (let attempt=1; attempt<=CONFIG.bridgeRetries && !state.cancelRequested; attempt++) {
      const m = scrollMetrics(container);
      m.scrollBy(delta);
      await waitForDomStability(container, false);
      const bridge = await processCurrentSnapshot(container);
      const overlap = intersectionCount(previousIds, bridge.ids);
      logEvent("BRIDGE_RETRY", { attempt, overlap, delta: Math.round(delta), domMessages: bridge.ids.length });
      if (overlap > 0) return { bridged: true, snapshot: bridge, overlap };
      delta = Math.max(60, delta / 2);
    }
    return { bridged: false };
  }

  async function scanUpward(container, scanNo, initialSnapshot) {
    await waitForVisible();
    state.currentPhase = scanNo === 1 ? "SCANNING_UP" : "CONTROL_SCAN_UP";
    state.currentScan = scanNo;
    state.reachedTop = false;
    let snapshot = initialSnapshot || await processCurrentSnapshot(container);
    let stableTop = 0;
    let noProgress = 0;
    let previousTop = scrollMetrics(container).top;
    let stepRatio = CONFIG.initialUpwardStepRatio;
    state.currentStepRatio = stepRatio;

    for (let stepNo=1; stepNo<=CONFIG.maxUpwardSteps && !state.cancelRequested; stepNo++) {
      await waitForVisible();
      renderOverlay();
      const before = scrollMetrics(container);

      if (isAtTop(before)) {
        before.setTop(0);
        await waitForDomStability(container, true);
        snapshot = await processCurrentSnapshot(container);
        const after = scrollMetrics(container);
        const candidate = snapshot.first;
        const rootPresent = Boolean(document.querySelector(ROOT_SENTINEL_SELECTOR));
        if (candidate && isAtTop(after)) stableTop++; else stableTop = 0;
        logEvent("TOP_CHECK", {
          step: stepNo,
          stableTop,
          firstMessageId: candidate?.messageId || "",
          firstRole: candidate?.role || "",
          observedTurn: candidate?.observedTurnIndex ?? "",
          rootSentinel: rootPresent
        });
        if (stableTop >= CONFIG.stableTopPasses && candidate) {
          state.reachedTop = true;
          state.topMessageId = candidate.messageId;
          state.checkpointDirty = true;
          await saveCheckpoint({ force: true });
          refreshExpectedCountFromToc({ force: true, source: "top-confirmed" });
          logEvent("TOP_CONFIRMED", { firstMessageId: candidate.messageId, firstRole: candidate.role, rootSentinel: rootPresent, expectedPrompts: state.expectedPromptCount ?? "unknown" });
          return { reached: true, snapshot, steps: stepNo };
        }
        continue;
      }

      const fallbackStep = Math.max(CONFIG.minStepPx, before.client * stepRatio);
      const stepRecordsBefore = state.records.size;
      const stepPromptGroupsBefore = promptGroupCount();
      let previousIds = snapshot.ids;
      let boundaryPlan = boundaryJumpPlan(container, snapshot, scanNo, 1);
      let moveMode = boundaryPlan ? "message-boundary" : "viewport-fallback";
      let intendedStep = boundaryPlan ? boundaryPlan.gain : fallbackStep;
      let boundaryBackoffs = 0;
      let frontierNew = 0;
      let boundaryRetained = false;
      let next = null;
      let overlap = 0;

      if (boundaryPlan) {
        const anchorTop = before.top;
        let scale = 1;
        let accepted = false;

        for (let attempt=0; attempt<=CONFIG.boundaryBackoffRetries && !state.cancelRequested; attempt++) {
          if (attempt > 0) {
            // Важно: backoff повторяет тот же самый интервал от исходной позиции,
            // а не продолжает движение из уже потенциально пропущенного места.
            const restore = scrollMetrics(container);
            restore.setTop(anchorTop);
            await waitForDomStability(container, false);
            snapshot = await processCurrentSnapshot(container);
            previousIds = snapshot.ids;
            scale *= CONFIG.boundaryBackoffFactor;
            boundaryPlan = boundaryJumpPlan(container, snapshot, scanNo, scale);
            if (!boundaryPlan) break;
          }

          intendedStep = boundaryPlan.gain;
          scrollMetrics(container).setTop(boundaryPlan.target);
          await waitForDomStability(container, false);
          next = await processCurrentSnapshot(container);
          overlap = intersectionCount(previousIds, next.ids);
          const evidence = frontierAdvanceEvidence(previousIds, next, boundaryPlan.boundaryMessageId);
          frontierNew = evidence.newBeforeBoundary;
          boundaryRetained = evidence.boundaryRetained;

          const safeKnownSpan = boundaryPlan.kind === "known-message-span"
            && overlap > 0
            && boundaryRetained;
          const safeHistoryAdvance = boundaryPlan.kind === "history-boundary"
            && overlap > 0
            && evidence.advanced;

          if (safeKnownSpan || safeHistoryAdvance) {
            accepted = true;
            break;
          }

          boundaryBackoffs++;
          logEvent("BOUNDARY_BACKOFF", {
            scan: scanNo,
            step: stepNo,
            attempt: attempt + 1,
            kind: boundaryPlan.kind,
            boundaryMessageId: boundaryPlan.boundaryMessageId,
            gainPx: Math.round(boundaryPlan.gain),
            overlap,
            boundaryRetained,
            frontierNew,
            locallyContiguous: evidence.locallyContiguous,
            records: state.records.size,
            promptGroupsCollected: promptGroupCount()
          });
        }

        if (!accepted) {
          // Крупный переход не доказал прохождение соседнего исторического блока.
          // Возвращаемся к исходной точке и используем старый безопасный viewport-шаг.
          const restore = scrollMetrics(container);
          restore.setTop(anchorTop);
          await waitForDomStability(container, false);
          snapshot = await processCurrentSnapshot(container);
          previousIds = snapshot.ids;
          const safeStep = Math.max(CONFIG.minStepPx, scrollMetrics(container).client * Math.min(stepRatio, CONFIG.initialUpwardStepRatio));
          scrollMetrics(container).scrollBy(-safeStep);
          await waitForDomStability(container, false);
          next = await processCurrentSnapshot(container);
          overlap = intersectionCount(previousIds, next.ids);
          intendedStep = safeStep;
          moveMode = "viewport-fallback";
          boundaryPlan = null;

          if (overlap === 0 && !isAtTop(scrollMetrics(container))) {
            const bridge = await tryBridgeGap(container, previousIds, safeStep);
            if (bridge.bridged) {
              next = bridge.snapshot;
              overlap = bridge.overlap;
            }
          }
        }
      } else {
        before.scrollBy(-fallbackStep);
        await waitForDomStability(container, false);
        next = await processCurrentSnapshot(container);
        overlap = intersectionCount(previousIds, next.ids);
        if (overlap === 0 && !isAtTop(scrollMetrics(container))) {
          const bridge = await tryBridgeGap(container, previousIds, fallbackStep);
          if (bridge.bridged) {
            next = bridge.snapshot;
            overlap = bridge.overlap;
          }
        }
      }

      snapshot = next || snapshot;
      state.lastOverlap = overlap;

      if (overlap >= CONFIG.targetOverlapHigh + 1) {
        stepRatio = Math.min(CONFIG.maxUpwardStepRatio, stepRatio + CONFIG.adaptiveStepDelta);
      } else if (overlap > 0 && overlap < CONFIG.targetOverlapLow) {
        stepRatio = Math.max(CONFIG.minUpwardStepRatio, stepRatio - CONFIG.adaptiveStepDelta);
      } else if (overlap === 0) {
        stepRatio = Math.max(CONFIG.minUpwardStepRatio, stepRatio - CONFIG.adaptiveStepDelta);
      }
      state.currentStepRatio = stepRatio;
      refreshExpectedCountFromToc({ source: "scan-up" });

      const after = scrollMetrics(container);
      const newMessages = Math.max(0, state.records.size - stepRecordsBefore);
      const newPromptGroups = Math.max(0, promptGroupCount() - stepPromptGroupsBefore);
      const moved = Math.abs(after.top - previousTop) > 2 || overlap > 0 || newMessages > 0;
      noProgress = moved ? 0 : noProgress + 1;
      previousTop = after.top;
      logEvent("SCAN_UP", {
        scan: scanNo,
        step: stepNo,
        scrollTop: Math.round(after.top),
        overlap,
        moveMode,
        stepPx: Math.round(intendedStep),
        boundaryKind: boundaryPlan?.kind || "",
        boundaryMessageId: boundaryPlan?.boundaryMessageId || "",
        boundaryTop: Number.isFinite(boundaryPlan?.boundaryTop) ? Math.round(boundaryPlan.boundaryTop) : "",
        boundaryBackoffs,
        boundaryRetained,
        frontierNew,
        newMessages,
        newPromptGroups,
        nextStepRatio: Number(stepRatio.toFixed(2)),
        domMessages: snapshot.ids.length,
        uniqueMessages: state.records.size,
        stableMessages: stableRecordCount(),
        promptGroupsCollected: promptGroupCount(),
        expectedPrompts: state.expectedPromptCount ?? "unknown"
      });

      if (noProgress >= CONFIG.maxNoProgressSteps) return { reached: false, snapshot, steps: stepNo, reason: "no-progress" };
    }
    return { reached: false, snapshot, reason: state.cancelRequested ? "cancelled" : "step-limit" };
  }


  function downwardMountedWindowJumpPlan(container, snapshot, conservative = false) {
    const metrics = scrollMetrics(container);
    const viewportBottom = metrics.top + metrics.client;
    const maxViewports = conservative ? CONFIG.recoveryMountedWindowMaxViewports : CONFIG.forwardMountedWindowMaxViewports;
    const maxTargetTop = metrics.top + metrics.client * maxViewports;
    const prefetch = Math.max(140, metrics.client * CONFIG.forwardMountedWindowPrefetchRatio);
    const minGain = Math.max(CONFIG.minStepPx, metrics.client * CONFIG.forwardMountedWindowMinGainRatio);
    const skeleton = collectTurnSkeleton();
    const slotIndexByTurnId = new Map(skeleton.map(slot => [slot.turnId, slot.index]));
    const recordedTurnIds = recordTurnIds();
    const slotAlreadyResolved = turnId => Boolean(turnId && (
      recordedTurnIds.has(turnId)
      || state.confirmedEmptyTurnIds.has(turnId)
      || state.resolvedNoncanonicalTurns.has(turnId)
    ));
    let anchorSlotIndex = null;
    let candidate = null;

    // Determine the last already-read turn at the current viewport boundary.
    for (const item of snapshot?.items || []) {
      const bounds = elementContentBounds(container, item?.element);
      if (!bounds || !Number.isFinite(bounds.top) || !Number.isFinite(bounds.bottom)) continue;
      if (bounds.top > viewportBottom + 8) break;
      const slotIndex = slotIndexByTurnId.get(item?.turnId || "");
      if (Number.isInteger(slotIndex)) anchorSlotIndex = slotIndex;
    }
    if (!Number.isInteger(anchorSlotIndex)) return null;

    // processCurrentSnapshot() has already extracted every canonical message in
    // snapshot.items, including auxiliary/progress data for assistant messages.
    // The fast path is allowed to cross only skeleton slots that are already
    // resolved in state. An unhydrated/unknown slot therefore blocks the jump.
    // After the move the normal overlap/skeleton continuity proof still applies.
    for (const item of snapshot?.items || []) {
      const bounds = elementContentBounds(container, item?.element);
      if (!bounds || !Number.isFinite(bounds.top) || !Number.isFinite(bounds.bottom)) continue;
      if (bounds.top <= viewportBottom + 8) continue;
      if (bounds.top > maxTargetTop) break;
      const candidateSlotIndex = slotIndexByTurnId.get(item?.turnId || "");
      if (!Number.isInteger(candidateSlotIndex) || candidateSlotIndex <= anchorSlotIndex) continue;

      let intervalResolved = true;
      for (let i = anchorSlotIndex; i <= candidateSlotIndex; i++) {
        if (!slotAlreadyResolved(skeleton[i]?.turnId || "")) { intervalResolved = false; break; }
      }
      if (!intervalResolved) continue;

      const target = Math.max(metrics.top, bounds.top - prefetch);
      const gain = target - metrics.top;
      if (gain < minGain) continue;
      candidate = {
        target,
        gain,
        boundaryMessageId: item?.messageId || "",
        boundaryTurnId: item?.turnId || "",
        boundaryTop: bounds.top,
        boundaryBottom: bounds.bottom,
        fromSlot: anchorSlotIndex,
        toSlot: candidateSlotIndex,
        kind: "mounted-window"
      };
    }
    return candidate;
  }

  function downwardLongTurnJumpPlan(container, snapshot, conservative = false) {
    const metrics = scrollMetrics(container);
    const viewportBottom = metrics.top + metrics.client;
    const nearbyMargin = metrics.client * CONFIG.boundaryNearbyViewportMargin;
    let candidate = null;

    for (let i = (snapshot?.items || []).length - 1; i >= 0; i--) {
      const item = snapshot.items[i];
      const turnEl = item?.element?.closest?.(TURN_SELECTOR) || item?.element;
      const bounds = elementContentBounds(container, turnEl);
      if (!bounds || !Number.isFinite(bounds.top) || !Number.isFinite(bounds.bottom)) continue;
      if (bounds.top > viewportBottom + nearbyMargin) continue;
      if (bounds.bottom < metrics.top - nearbyMargin) continue;
      candidate = { item, bounds };
      break;
    }
    if (!candidate) return null;

    const { item, bounds } = candidate;
    // Only jump aggressively inside a turn whose DOM has already been fully read.
    // We deliberately do not jump across an unseen turn boundary.
    const spansViewportBottom = bounds.top < viewportBottom - 2 && bounds.bottom > viewportBottom + 2;
    if (!spansViewportBottom) return null;

    const prefetch = Math.max(140, metrics.client * CONFIG.forwardLongTurnPrefetchRatio);
    const rawTarget = Math.max(metrics.top, bounds.bottom - prefetch);
    const rawGain = rawTarget - metrics.top;
    const minGain = Math.max(CONFIG.minStepPx, metrics.client * 0.9);
    if (rawGain < minGain) return null;

    const maxViewports = conservative ? CONFIG.recoveryLongTurnMaxViewports : CONFIG.forwardLongTurnMaxViewports;
    const gain = Math.min(rawGain, metrics.client * maxViewports);
    return {
      target: metrics.top + gain,
      gain,
      boundaryMessageId: item?.messageId || "",
      boundaryTop: bounds.top,
      boundaryBottom: bounds.bottom,
      kind: "known-long-turn"
    };
  }


  function forwardContinuityEvidence(previousSnapshot, nextSnapshot) {
    if (!previousSnapshot || !nextSnapshot) return { proven: false, reason: "snapshot-missing" };
    const overlap = intersectionCount(previousSnapshot.ids || [], nextSnapshot.ids || []);
    if (overlap > 0) return { proven: true, reason: "message-overlap", overlap };
    const a = previousSnapshot.last;
    const b = nextSnapshot.first;
    if (!a?.turnId || !b?.turnId) return { proven: false, reason: "no-overlap-no-turn-anchor", overlap: 0 };
    if (a.turnId === b.turnId) return { proven: true, reason: "same-turn-anchor", overlap: 0 };
    const skeleton = collectTurnSkeleton();
    const index = new Map(skeleton.map(slot => [slot.turnId, slot.index]));
    const ai = index.get(a.turnId);
    const bi = index.get(b.turnId);
    if (Number.isInteger(ai) && Number.isInteger(bi) && bi === ai + 1) {
      return { proven: true, reason: "adjacent-skeleton-turns", overlap: 0, fromSlot: ai, toSlot: bi };
    }
    return { proven: false, reason: "skeleton-gap", overlap: 0, fromSlot: ai ?? "unknown", toSlot: bi ?? "unknown" };
  }

  async function scanDownward(container, scanNo = 1, initialSnapshot = null, { conservative = false } = {}) {
    await waitForVisible();
    state.currentPhase = scanNo === 1 ? "SCANNING_DOWN" : "RECOVERY_SCAN_DOWN";
    state.currentScan = scanNo;
    state.reachedBottom = false;
    let snapshot = initialSnapshot || await processCurrentSnapshot(container);
    let stableBottom = 0;
    let lastBottomId = "";
    let noProgress = 0;
    let previousTop = scrollMetrics(container).top;
    const baseRatio = conservative ? CONFIG.recoveryForwardStepRatio : CONFIG.forwardStepRatio;

    logEvent("FORWARD_SCAN_START", {
      scan: scanNo,
      conservative,
      expectedPrompts: state.expectedPromptCount ?? "unknown",
      promptGroupsCollected: promptGroupCount(),
      records: state.records.size,
      skeletonSlots: collectTurnSkeleton().length
    });

    for (let stepNo = 1; stepNo <= CONFIG.maxUpwardSteps && !state.cancelRequested; stepNo++) {
      await waitForVisible();
      renderOverlay();
      const before = scrollMetrics(container);

      if (isAtBottom(before)) {
        before.setTop(Math.max(0, before.height - before.client));
        await waitForDomStability(container, true);
        snapshot = await processCurrentSnapshot(container);
        const after = scrollMetrics(container);
        const candidate = snapshot.last;
        if (candidate && isAtBottom(after)) {
          stableBottom = candidate.messageId === lastBottomId ? stableBottom + 1 : 1;
          lastBottomId = candidate.messageId;
        } else {
          stableBottom = 0;
          lastBottomId = candidate?.messageId || "";
        }
        logEvent("FORWARD_BOTTOM_CHECK", {
          scan: scanNo,
          step: stepNo,
          stableBottom,
          stableRequired: CONFIG.stableBottomPasses,
          lastMessageId: candidate?.messageId || "",
          lastRole: candidate?.role || "",
          records: state.records.size,
          promptGroupsCollected: promptGroupCount(),
          expectedPrompts: state.expectedPromptCount ?? "unknown",
          skeletonSlots: collectTurnSkeleton().length
        });
        if (stableBottom >= CONFIG.stableBottomPasses && candidate) {
          state.reachedBottom = true;
          state.bottomMessageId = candidate.messageId;
          state.bottomRole = candidate.role;
          state.checkpointDirty = true;
          refreshExpectedCountFromToc({ force: true, source: "forward-bottom-confirmed" });
          await saveCheckpoint({ force: true });
          logEvent("BOTTOM_CONFIRMED_AFTER_FORWARD", {
            scan: scanNo,
            lastMessageId: candidate.messageId,
            lastRole: candidate.role,
            expectedPrompts: state.expectedPromptCount ?? "unknown",
            promptGroupsCollected: promptGroupCount(),
            records: state.records.size,
            skeletonSlots: collectTurnSkeleton().length
          });
          return { reached: true, snapshot, steps: stepNo };
        }
        continue;
      }

      const previousIds = snapshot.ids || [];
      const stepRecordsBefore = state.records.size;
      const stepPromptsBefore = promptGroupCount();
      const anchorTop = before.top;
      const mountedPlan = downwardMountedWindowJumpPlan(container, snapshot, conservative);
      const longPlan = mountedPlan ? null : downwardLongTurnJumpPlan(container, snapshot, conservative);
      let plannedGain = mountedPlan?.gain || longPlan?.gain || Math.max(CONFIG.minStepPx, before.client * baseRatio);
      let moveMode = mountedPlan ? "mounted-window" : (longPlan ? "known-long-turn" : "viewport-overlap");
      let accepted = false;
      let overlap = 0;
      let next = null;
      let backoffs = 0;

      for (let attempt = 0; attempt <= CONFIG.forwardBackoffRetries && !state.cancelRequested; attempt++) {
        if (attempt > 0) {
          backoffs++;
          const restore = scrollMetrics(container);
          restore.setTop(anchorTop);
          await waitForDomStability(container, false);
          snapshot = await processCurrentSnapshot(container);
          plannedGain = Math.max(CONFIG.minStepPx * 0.55, plannedGain * 0.5);
          moveMode = "backoff-overlap";
        }

        const m = scrollMetrics(container);
        const maxTop = Math.max(0, m.height - m.client);
        const target = Math.min(maxTop, anchorTop + plannedGain);
        m.setTop(target);
        await waitForDomStability(container, false);
        next = await processCurrentSnapshot(container);
        overlap = intersectionCount(previousIds, next.ids);
        const continuity = forwardContinuityEvidence(snapshot, next);
        if (continuity.proven || isAtBottom(scrollMetrics(container))) {
          accepted = true;
          if (overlap === 0) logEvent("FORWARD_CONTINUITY_BY_SKELETON", { scan: scanNo, step: stepNo, reason: continuity.reason, fromSlot: continuity.fromSlot ?? "", toSlot: continuity.toSlot ?? "" });
          break;
        }
        logEvent("FORWARD_BACKOFF", {
          scan: scanNo,
          step: stepNo,
          attempt: attempt + 1,
          gainPx: Math.round(plannedGain),
          overlap,
          records: state.records.size,
          promptGroupsCollected: promptGroupCount()
        });
      }

      if (!accepted) {
        // Quality-first fallback: move by a deliberately small overlapping step.
        const restore = scrollMetrics(container);
        restore.setTop(anchorTop);
        await waitForDomStability(container, false);
        snapshot = await processCurrentSnapshot(container);
        const safeGain = Math.max(120, scrollMetrics(container).client * 0.30);
        scrollMetrics(container).scrollBy(safeGain);
        await waitForDomStability(container, false);
        next = await processCurrentSnapshot(container);
        overlap = intersectionCount(previousIds, next.ids);
        plannedGain = safeGain;
        moveMode = "quality-safe-step";
        const safeContinuity = forwardContinuityEvidence(snapshot, next);
        logEvent("FORWARD_SAFE_STEP", {
          scan: scanNo,
          step: stepNo,
          gainPx: Math.round(safeGain),
          overlap,
          continuityProven: safeContinuity.proven,
          continuityReason: safeContinuity.reason,
          records: state.records.size,
          promptGroupsCollected: promptGroupCount()
        });
        if (!safeContinuity.proven && !isAtBottom(scrollMetrics(container))) {
          logEvent("FORWARD_CONTINUITY_UNPROVEN", {
            scan: scanNo,
            step: stepNo,
            reason: safeContinuity.reason,
            fromSlot: safeContinuity.fromSlot ?? "unknown",
            toSlot: safeContinuity.toSlot ?? "unknown"
          });
          return { reached: false, snapshot: next || snapshot, steps: stepNo, reason: "forward-continuity-unproven" };
        }
      }

      snapshot = next || snapshot;
      refreshExpectedCountFromToc({ source: "scan-down" });
      const after = scrollMetrics(container);
      const newMessages = Math.max(0, state.records.size - stepRecordsBefore);
      const newPromptGroups = Math.max(0, promptGroupCount() - stepPromptsBefore);
      const moved = Math.abs(after.top - previousTop) > 2 || overlap > 0 || newMessages > 0 || newPromptGroups > 0;
      noProgress = moved ? 0 : noProgress + 1;
      previousTop = after.top;

      logEvent("SCAN_DOWN", {
        scan: scanNo,
        step: stepNo,
        conservative,
        scrollTop: Math.round(after.top),
        overlap,
        moveMode,
        stepPx: Math.round(plannedGain),
        mountedBoundaryMessageId: mountedPlan?.boundaryMessageId || "",
        mountedBoundaryTurnId: mountedPlan?.boundaryTurnId || "",
        mountedFromSlot: mountedPlan?.fromSlot ?? "",
        mountedToSlot: mountedPlan?.toSlot ?? "",
        backoffs,
        newMessages,
        newPromptGroups,
        domMessages: snapshot.ids.length,
        uniqueMessages: state.records.size,
        stableMessages: stableRecordCount(),
        promptGroupsCollected: promptGroupCount(),
        expectedPrompts: state.expectedPromptCount ?? "unknown",
        skeletonSlots: collectTurnSkeleton().length
      });

      await saveCheckpoint();
      if (noProgress >= CONFIG.maxNoProgressSteps) {
        logEvent("FORWARD_SCAN_STALLED", { scan: scanNo, step: stepNo, noProgress });
        return { reached: false, snapshot, steps: stepNo, reason: "no-progress" };
      }
    }

    return { reached: false, snapshot, reason: state.cancelRequested ? "cancelled" : "step-limit" };
  }

  function getAuxiliaryStats(chainIds) {
    let processingFound = 0, processingCaptured = 0, artifacts = 0;
    const unresolved = [];
    const unvisited = [];
    for (const id of chainIds) {
      const r = state.records.get(id);
      if (!r) continue;
      if (!state.auxiliaryVisitedIds.has(id)) unvisited.push(id);
      const p = r.processing || [];
      processingFound += p.length;
      processingCaptured += p.filter(x => x?.captured).length;
      artifacts += (r.generatedArtifacts || []).length;
      if (p.some(x => !x?.captured)) unresolved.push(id);
    }
    return { processingFound, processingCaptured, artifacts, unresolved, unvisited };
  }

  function validateCompleteness() {
    refreshExpectedCountFromToc({ force: true, source: "verify" });
    pruneRecoveredResolvedTurns();
    bridgeResolvedSkeletonGaps();
    const issues = [];
    const chain = buildChain();
    const chainRecords = chain.ids.map(id => state.records.get(id)).filter(Boolean);
    const stableMissing = chainRecords.filter(r => !r.stable).map(r => r.messageId);
    const aux = getAuxiliaryStats(chain.ids);
    const skeleton = skeletonCoverageStats();
    const roleCounts = {
      user: chainRecords.filter(r => r.role === "user").length,
      assistant: chainRecords.filter(r => r.role === "assistant").length
    };

    if (!state.reachedBottom || !state.bottomMessageId) issues.push("не подтвержден конец разговора");
    if (!state.reachedTop || !state.topMessageId) issues.push("не подтверждено начало разговора");
    if (!chain.connectedToBottom) issues.push("последовательность message-id с учетом разрешенных turn-slot не сшита от начала до конца");
    if (chain.loop) issues.push("обнаружен цикл в графе последовательности сообщений");
    if (chain.ambiguities.length) issues.push(`неоднозначные переходы message-id: ${chain.ambiguities.length}`);
    if (stableMissing.length) issues.push(`нестабильные сообщения: ${stableMissing.length}`);
    if (aux.unvisited.length) issues.push(`не обработан дополнительный контекст сообщений: ${aux.unvisited.length}`);
    if (aux.unresolved.length) issues.push(`не извлечены доступные progress-блоки: ${aux.unresolved.length}`);
    if (skeleton.total && skeleton.unresolvedSlots) issues.push(`не разрешены turn-slot каркаса: ${skeleton.unresolvedSlots}`);

    if (chainRecords.length && chainRecords[0].role !== "user") issues.push("первая каноническая реплика активной ветки не является сообщением пользователя");

    const connectedPromptGroups = promptGroupCount(chainRecords);
    const collectedPromptGroups = promptGroupCount();
    if (Number.isInteger(state.expectedPromptCount) && connectedPromptGroups !== state.expectedPromptCount) {
      issues.push(`TOC содержит ${state.expectedPromptCount} prompt-групп, в связной цепочке подтверждено ${connectedPromptGroups}`);
    }

    const complete = issues.length === 0;
    const validation = { complete, issues, chain, chainRecords, roleCounts, aux, skeleton, expectedMessages: null, expectedPrompts: state.expectedPromptCount, connectedPromptGroups, collectedPromptGroups };
    state.lastValidation = validation;
    logEvent("VERIFY", {
      complete,
      chainLength: chain.ids.length,
      expectedPrompts: state.expectedPromptCount ?? "unknown",
      collectedPromptGroups,
      connectedPromptGroups,
      uniqueMessages: state.records.size,
      stableMessages: stableRecordCount(),
      userMessages: roleCounts.user,
      assistantMessages: roleCounts.assistant,
      skeletonSlots: skeleton.total,
      resolvedSkeletonSlots: skeleton.resolvedSlots,
      processingOnlySlots: skeleton.processingOnlySlots,
      auxiliaryAssistantSlots: skeleton.auxiliaryAssistantSlots,
      emptyTurnSlots: skeleton.emptySlots,
      unresolvedTurnSlots: skeleton.unresolvedSlots,
      auxUnvisited: aux.unvisited.length,
      unresolvedProcessing: aux.unresolved.length,
      issues: issues.join(" | ") || "0"
    });
    return validation;
  }

  function needsSecondScan(validation) {
    if (validation?.complete) return false;
    if (Number.isInteger(state.expectedPromptCount) && promptGroupCount() >= state.expectedPromptCount) return false;
    return true;
  }

  function appendResolvedTurnSlotMarkdown(lines, turnId) {
    if (state.confirmedEmptyTurnIds.has(turnId)) {

      return false;
    }
    const slot = state.resolvedNoncanonicalTurns.get(turnId);
    if (!slot) {

      return false;
    }
    if (slot.type === "PROCESSING_ONLY") {
      lines.push("**ChatGPT — обработка**", "");
      if (slot.label) lines.push(`*${slot.label}*`, "");
      return true;
    }
    if (slot.type === "AUXILIARY_ASSISTANT") {
      lines.push("**ChatGPT — промежуточное сообщение**", "");
      if (slot.label) lines.push(`*${slot.label}*`, "");
      if (slot.markdown) lines.push(slot.markdown, "");
      return true;
    }

    return false;
  }

  function trailingResolvedTurnIds(chainRecords, validation) {
    if (!chainRecords?.length) return [];
    const skeleton = validation?.skeleton?.skeleton || collectTurnSkeleton();
    if (!skeleton.length) return [];
    const lastTurnId = chainRecords.at(-1)?.turnId || "";
    if (!lastTurnId) return [];
    const lastIndex = skeleton.findIndex(slot => slot.turnId === lastTurnId);
    if (lastIndex < 0) return [];
    const recorded = recordTurnIds();
    const out = [];
    for (let i = lastIndex + 1; i < skeleton.length; i++) {
      const turnId = skeleton[i].turnId;
      if (recorded.has(turnId)) break;
      if (state.confirmedEmptyTurnIds.has(turnId) || state.resolvedNoncanonicalTurns.has(turnId)) out.push(turnId);
      else break;
    }
    return out;
  }

  function expectedResolvedNoncanonicalTurnIds(validation) {
    const skeleton = validation?.skeleton?.skeleton || collectTurnSkeleton();
    const recorded = recordTurnIds();
    const ids = new Set();
    for (const slot of skeleton) {
      if (recorded.has(slot.turnId)) continue;
      if (state.confirmedEmptyTurnIds.has(slot.turnId) || state.resolvedNoncanonicalTurns.has(slot.turnId)) ids.add(slot.turnId);
    }
    return ids;
  }

  function checkNoncanonicalSerialization(serialized, validation) {
    const expected = expectedResolvedNoncanonicalTurnIds(validation);
    const actual = serialized instanceof Set ? serialized : new Set(serialized || []);
    const missing = [...expected].filter(id => !actual.has(id));
    const unexpected = [...actual].filter(id => !expected.has(id));
    return { ok: missing.length === 0 && unexpected.length === 0, expected, serialized: actual, missing, unexpected };
  }

  function buildMarkdown({ incomplete = false, validation = null, serializedNoncanonicalOut = null } = {}) {
    validation = validation || validateCompleteness();
    const chainIds = validation.chain.ids;
    const chainSet = new Set(chainIds);
    const records = chainIds.map(id => state.records.get(id)).filter(Boolean);
    const leftovers = [...state.records.values()].filter(r => !chainSet.has(r.messageId));
    const lines = [`# ${state.pageTitle || pageTitle()}`, ""];
    const serializedNoncanonical = new Set();
    const appendNoncanonical = turnId => {
      serializedNoncanonical.add(turnId);
      return appendResolvedTurnSlotMarkdown(lines, turnId);
    };

    if (incomplete) {
      lines.push("> ВНИМАНИЕ: полнота этого экспорта не подтверждена.", "");
      for (const issue of validation.issues) lines.push(`> ${issue}`);
      lines.push("", "---", "");
    }

    let lastDate = "";
    records.forEach((record,index) => {
      if (index > 0) {
        lines.push("---", "");
        const previous = records[index - 1];
        const bridgedTurns = state.confirmedTurnBridges.get(`${previous.messageId}>${record.messageId}`) || [];
        for (const turnId of bridgedTurns) {
          const visible = appendNoncanonical(turnId);
          if (visible) lines.push("---", "");
        }
      }
      if (record.dateLabel && record.dateLabel !== lastDate) {
        lines.push(`*${record.dateLabel}*`, "");
        lastDate = record.dateLabel;
      }
      lines.push(record.role === "user" ? "**Пользователь**" : "**ChatGPT**", "");
      if (record.messageDateLabel) lines.push(`*${record.messageDateLabel}*`, "");
      if (record.role === "assistant" && (record.processing || []).length) {
        lines.push("**Промежуточные сообщения ChatGPT**", "");
        for (const item of record.processing) {
          if (item.label) lines.push(`*${item.label}*`, "");
          if (item.markdown) lines.push(item.markdown, "");
          else lines.push("*[Детали блока не удалось извлечь]*", "");
        }
      }
      if (record.attachments?.length) {
        lines.push("**Вложения:**", "");
        for (const name of record.attachments) lines.push(`- \`${name}\``);
        lines.push("");
      }
      if (record.markdown) lines.push(record.markdown, "");
      if (record.generatedArtifacts?.length) {
        lines.push("**Созданные файлы:**", "");
        for (const item of record.generatedArtifacts) {
          const label = item.label || item.name || "Файл";
          lines.push(item.url ? `- [${label}](${item.url})` : `- \`${item.name || label}\``);
        }
        lines.push("");
      }
    });

    const trailingTurns = trailingResolvedTurnIds(records, validation);
    if (trailingTurns.length) {
      lines.push("---", "");
      for (let i = 0; i < trailingTurns.length; i++) {
        const visible = appendNoncanonical(trailingTurns[i]);
        if (visible && i < trailingTurns.length - 1) lines.push("---", "");
      }
    }

    if (incomplete && leftovers.length) {
      lines.push("---", "", "## Несшитые сообщения", "", "> Ниже приведены сообщения, найденные во время сканирования, но не вошедшие в доказанную непрерывную последовательность.", "");
      for (const record of leftovers.sort((a,b) => (a.lastSeenAt || 0) - (b.lastSeenAt || 0))) {
        lines.push(record.role === "user" ? "**Пользователь**" : "**ChatGPT**", "");
        if (record.markdown) lines.push(record.markdown, "");
      }
    }

    if (serializedNoncanonicalOut instanceof Set) {
      serializedNoncanonicalOut.clear();
      for (const turnId of serializedNoncanonical) serializedNoncanonicalOut.add(turnId);
    }
    return `${lines.join("\n").replace(/\n{4,}/g,"\n\n\n").trim()}\n`;
  }

  async function finishComplete(validation) {
    await waitForVisible();
    const serializedNoncanonical = new Set();
    const markdown = buildMarkdown({ incomplete: false, validation, serializedNoncanonicalOut: serializedNoncanonical });
    const serialization = checkNoncanonicalSerialization(serializedNoncanonical, validation);
    logEvent("SERIALIZATION_CHECK", {
      expectedNoncanonical: serialization.expected.size,
      serializedNoncanonical: serialization.serialized.size,
      missing: serialization.missing.join(","),
      unexpected: serialization.unexpected.join(","),
      ok: serialization.ok
    });
    if (!serialization.ok) {
      const issue = `сериализация noncanonical turn-slot не совпала с verifier: ${serialization.serialized.size}/${serialization.expected.size}`;
      const failedValidation = { ...validation, complete: false, issues: [...(validation.issues || []), issue] };
      state.lastValidation = failedValidation;
      await finishIncomplete(failedValidation, "serialization-invariant-failed");
      return;
    }

    state.finishedElapsedMs = elapsedMs();
    stopTimer();
    state.currentPhase = state.apiMode ? "API_COMPLETE" : "COMPLETE";
    if (state.apiMode) updateApiProgress({ stage: state.settings.autoSaveExport ? "SAVING" : "NORMALIZED",
      status: state.settings.autoSaveExport ? "Markdown подготовлен. Сохраняю файл…" : "Markdown подготовлен. Нажмите «Сохранить», чтобы выбрать папку." });
    const filename = `${sanitizeFilename(state.pageTitle)}.md`;
    state.pendingMarkdown = markdown;
    state.pendingFilename = filename;
    logEvent("RESULT", { status: "COMPLETE", filename, elapsed: formatDuration(elapsedMs()) });
    await clearCheckpoint();

    if (state.settings.autoSaveExport) {
      setActionButtons({});
      renderOverlay("Проверка пройдена. Сохраняю файл…");
      try {
        await downloadText(filename, markdown, "text/markdown", false);
        logEvent("EXPORT_SAVED", { filename, saveAs: false });
        await maybeSaveLogSafe();
        if (state.apiMode) updateApiProgress({ stage: "COMPLETE", status: "Готово. Файл Markdown сохранен." });
        else renderOverlay("Готово. Файл сохранен.");
        setTimeout(removeOverlay, CONFIG.overlayAutoCloseMs);
      } catch (error) {
        logEvent("EXPORT_SAVE_ERROR", { error: error?.message || error });
        await maybeSaveLogSafe();
        setActionButtons({ save: true, log: true });
        if (state.apiMode) updateApiProgress({ stage: "NORMALIZED", status: `Файл подготовлен, но автосохранение не удалось: ${error?.message || error}. Нажмите «Сохранить».` });
        else renderOverlay("Экспорт подготовлен, но автоматическое сохранение не удалось. Нажмите «Сохранить».");
      }
    } else {
      await maybeSaveLogSafe();
      setActionButtons({ save: true });
      if (state.apiMode) updateApiProgress({ stage: "NORMALIZED", status: "Файл подготовлен. Нажмите «Сохранить», чтобы выбрать место." });
      else renderOverlay("Проверка пройдена. Нажмите «Сохранить» и выберите место для файла.");
    }
  }

  async function finishIncomplete(validation, reason = "") {
    await waitForVisible();
    state.currentPhase = "INCOMPLETE";
    logEvent("RESULT", { status: "INCOMPLETE", reason, issues: validation.issues.join(" | "), elapsed: formatDuration(elapsedMs()) });
    await saveCheckpoint({ force: true, status: "INCOMPLETE" });
    await maybeSaveLogSafe();
    setActionButtons({ retry: true, partial: true, log: true });
    const expectedPrompts = state.expectedPromptCount;
    const collectedPrompts = validation.collectedPromptGroups ?? promptGroupCount();
    const unresolvedSlots = validation.skeleton?.unresolvedSlots ?? 0;
    const promptDetail = Number.isInteger(expectedPrompts)
      ? `${collectedPrompts} / ${expectedPrompts} запросов собрано. Неразрешенных turn-slot: ${unresolvedSlots}.`
      : `${state.records.size} канонических сообщений собрано. Неразрешенных turn-slot: ${unresolvedSlots}.`;
    renderOverlay(`Полнота не подтверждена. ${promptDetail}`);
  }

  async function loadSettings() {
    const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
    return {
      autoSaveExport: stored.autoSaveExport ?? DEFAULT_SETTINGS.autoSaveExport,
      saveDiagnosticLog: stored.saveDiagnosticLog ?? DEFAULT_SETTINGS.saveDiagnosticLog
    };
  }

  async function resetRunState({ fresh = false } = {}) {
    state.cancelRequested = false;
    state.apiMode = false;
    state.apiProgress = null;
    state.apiAbortController = null;
    state.records.clear();
    state.apiSource = false;
    state.observations.clear();
    state.edgeCounts.clear();
    state.auxiliaryVisitedIds.clear();
    state.confirmedEmptyTurnIds.clear();
    state.resolvedNoncanonicalTurns.clear();
    state.confirmedTurnBridges.clear();
    state.lastSkeletonStats = null;
    state.pageTitle = pageTitle();
    state.conversationKey = conversationIdentity();
    state.checkpointKey = checkpointStorageKey();
    state.checkpointDirty = false;
    state.lastCheckpointAt = 0;
    state.recordsAtCheckpoint = 0;
    state.currentPhase = "INITIALIZING";
    state.currentStatus = "";
    state.currentScan = 0;
    state.bottomSeekAttempt = 0;
    state.reachedBottom = false;
    state.reachedTop = false;
    state.bottomMessageId = "";
    state.topMessageId = "";
    state.bottomRole = "";
    state.expectedPromptCount = null;
    state.expectedMessageCount = null;
    state.expectedCountSource = "unknown";
    state.tocCandidateCount = null;
    state.tocCandidateObservations = 0;
    state.tocCandidateSince = 0;
    state.lastTocObservedAt = 0;
    state.currentStepRatio = CONFIG.initialUpwardStepRatio;
    state.lastSnapshotIds = [];
    state.lastOverlap = null;
    state.pendingMarkdown = "";
    state.pendingFilename = "";
    state.logEntries = [];
    state.logSaved = false;
    state.lastValidation = null;
    state.visibilityPaused = false;
    state.visibilityPhaseBeforePause = "";
    state.visibilityPauseStartedAt = 0;
    state.visibilityPausedTotalMs = 0;
    state.visibilityResumeEpoch = 0;
    state.startedAt = Date.now();
    state.finishedElapsedMs = null;
    state.settings = await loadSettings();
    if (fresh) await clearCheckpoint();
    else await loadCheckpoint();
    logEvent("RUN_START", { version: VERSION, fresh, autoSaveExport: state.settings.autoSaveExport, saveDiagnosticLog: state.settings.saveDiagnosticLog });
  }

  function isResponseStreaming() {
    return Array.from(document.querySelectorAll("button[aria-label], button[data-testid]")).some(button => {
      const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("data-testid") || ""}`.toLowerCase();
      return /stop.*generat|останов.*ответ|stop-button/.test(label);
    });
  }

  async function start({ fresh = false } = {}) {
    if (state.running) {
      renderOverlay("Экспорт уже выполняется.");
      return;
    }
    if (!document.querySelector(MESSAGE_SELECTOR)) {
      ensureOverlay();
      state.currentPhase = "ERROR";
      renderOverlay("На странице не найдены сообщения чата.");
      setActionButtons({ log: true });
      return;
    }
    if (isResponseStreaming()) {
      ensureOverlay();
      state.currentPhase = "ERROR";
      renderOverlay("Ответ еще формируется. Дождитесь окончания генерации и повторите экспорт.");
      setActionButtons({});
      return;
    }

    state.running = true;
    ensureOverlay();
    setActionButtons({ cancel: true });

    try {
      await resetRunState({ fresh });

      // API retrieval can take time even before the first response arrives.
      state.apiMode = true;
      state.apiAbortController = new AbortController();
      state.startedAt = Date.now();
      startTimer();
      updateApiProgress({ stage: "CONNECTING", pagesLoaded: 0, rawMessages: 0, records: 0,
        filtered: 0, emptyContent: 0, hasPreviousPage: null, status: "Подключаюсь к источнику истории…" });

      // 1.0.40 API export pipeline.
      let apiExportLoaded = false;
      try {
        const source = globalThis.__ChatContextConversationSource;
        if (source && typeof source.loadFullConversationForExport === "function") {
          const api = await source.loadFullConversationForExport({
            signal: state.apiAbortController.signal,
            onProgress: updateApiProgress
          });
          logEvent("CONVERSATION_API_RESPONSE_REPORT", api.apiDiagnostic || {});
          logEvent("CONVERSATION_API_REPORT", {
            status: api.success ? "SUCCESS" : "FAILED",
            source: "API",
            rawMessages: api.apiDiagnostic?.rawMessages || 0,
            rawMappingNodes: api.apiDiagnostic?.rawMappingNodes || 0,
            messages: api.messages || 0,
            records: api.records?.length || 0,
            pages: api.pagesLoaded || 0,
            schema: api.apiDiagnostic?.schema || "unknown",
            errors: api.errors || [],
            normalization: api.normalization || {}
          });
          if (api.success && api.records?.length) {
            state.records.clear();
            for (const record of api.records) state.records.set(record.messageId, record);
            state.apiSource = true;
            // The page title can include a project prefix omitted by API title.
            // Use the same full title for the Markdown heading and filename.
            state.pageTitle = normalizeText(document.title) || normalizeText(api.title) || state.pageTitle;
            apiExportLoaded = true;
            logEvent("EXPORT_SOURCE_REPORT", { source: "API" });
          }
        }
      } catch (error) {
        if (state.cancelRequested || state.apiAbortController?.signal.aborted) {
          state.currentPhase = "INTERRUPTED";
          updateApiProgress({ stage: "CANCELLED", status: "Загрузка API остановлена." });
        } else {
          logEvent("CONVERSATION_API_REPORT", { status: "FAILED", source: "API", error: error?.message || String(error) });
          updateApiProgress({ stage: "ERROR", status: `Не удалось загрузить историю через API: ${error?.message || String(error)}` });
        }
      }
      if (state.cancelRequested) {
        logEvent("RESULT", { status: "INTERRUPTED", source: "API" });
        await maybeSaveLogSafe();
        setActionButtons({ log: true });
        renderOverlay("Загрузка API остановлена.");
        return;
      }
      if (!apiExportLoaded && !shouldUseDomBackup()) {
        if (state.apiMode && state.currentPhase !== "API_ERROR") {
          updateApiProgress({ stage: "ERROR", status: "API не вернул пригодную историю. Экспорт остановлен; резервный DOM-разбор отключен." });
        }
        throw new Error("API export unavailable and DOM backup disabled");
      }

      if (!apiExportLoaded) state.apiMode = false;
      installVisibilityGuard();
      await waitForVisible();
      startTimer();
      if (apiExportLoaded) updateApiProgress({ stage: "SERIALIZING", status: "Формирую Markdown из проверенной последовательности…" });
      else renderOverlay("Подготавливаю экспорт…");
      await saveCheckpoint({ force: true });
      if (apiExportLoaded) {
        if (state.cancelRequested) throw new Error("Экспорт остановлен");
        const records = [...state.records.values()];
        // API sequence is already selected and checked; DOM evidence is unrelated.
        const validation = {
          complete: true, issues: [], chain: { ids: records.map(r => r.messageId) },
          chainRecords: records,
          roleCounts: { user: records.filter(r => r.role === "user").length,
            assistant: records.filter(r => r.role === "assistant").length },
          aux: { processingCaptured: 0, processingFound: 0, artifacts: 0 },
          skeleton: { skeleton: [] }
        };
        state.lastValidation = validation;
        await finishComplete(validation);
        return;
      }

      const container = findScrollContainer();
      const initialMetrics = scrollMetrics(container);
      logEvent("SCROLL_ROOT", { clientHeight: initialMetrics.client, scrollHeight: initialMetrics.height, initialTop: Math.round(initialMetrics.top) });

      let validation = null;
      let lastReason = "";

      // 1.0.20 pipeline:
      //   FAST_SEEK_TOP (opportunistic, not continuity proof)
      //   -> one proof-oriented FORWARD_SCAN from true top to bottom
      //   -> targeted prompt/slot repair
      //   -> at most one conservative full forward recovery pass.
      for (let scanNo = 1; scanNo <= CONFIG.maxForwardScans && !state.cancelRequested; scanNo++) {
        const recovery = scanNo > 1;
        state.currentStatus = recovery
          ? "Резервный проход: повторно подтверждаю начало разговора перед консервативным сканированием."
          : "Сначала быстро загружаю историю до настоящего начала разговора.";
        renderOverlay();

        const top = await fastSeekTop(container, { recovery });
        if (!top.reached) {
          lastReason = top.reason || "true-top-not-reached";
          logEvent("NEXT_PHASE", { from: "SEEKING_TOP", to: "INCOMPLETE", scan: scanNo, reason: lastReason });
          break;
        }
        if (state.cancelRequested) break;

        // Re-read the confirmed top in full mode before the proof pass starts.
        const topSnapshot = await processCurrentSnapshot(container);
        state.currentStatus = recovery
          ? "Выполняю консервативный резервный проход сверху вниз."
          : "Начало подтверждено. Выполняю один последовательный доказательный проход сверху вниз.";
        renderOverlay();
        logEvent("NEXT_PHASE", {
          from: "SEEKING_TOP",
          to: recovery ? "RECOVERY_SCAN_DOWN" : "SCANNING_DOWN",
          scan: scanNo,
          reason: recovery ? "quality-first-recovery-pass" : "true-top-confirmed",
          expectedPrompts: state.expectedPromptCount ?? "unknown",
          promptGroupsCollected: promptGroupCount(),
          records: state.records.size
        });

        const down = await scanDownward(container, scanNo, topSnapshot, { conservative: recovery });
        if (!down.reached) lastReason = down.reason || "bottom-not-reached";
        if (state.cancelRequested) break;

        state.currentPhase = "VERIFYING";
        state.currentStatus = "";
        renderOverlay();
        validation = validateCompleteness();
        if (validation.complete) {
          logEvent("NEXT_PHASE", { from: "VERIFYING", to: "COMPLETE", scan: scanNo, reason: "validation-complete-after-forward-scan" });
          break;
        }

        let allPromptGroupsCollected = Number.isInteger(state.expectedPromptCount)
          && promptGroupCount() === state.expectedPromptCount;

        // Missing prompt groups are repaired by exact TOC targets whenever the
        // skeleton proves the mapping. A full second pass is not the default.
        if (!allPromptGroupsCollected) {
          const promptPlan = deriveTargetedPromptRepairPlan();
          if (promptPlan.ok) {
            logEvent("NEXT_PHASE", {
              from: "VERIFYING",
              to: "TARGETED_PROMPT_REPAIR",
              scan: scanNo,
              reason: "proven-missing-prompt-groups",
              expectedPrompts: state.expectedPromptCount,
              promptGroupsCollected: promptGroupCount(),
              missingPrompts: promptPlan.missingCount,
              promptIndexes: promptPlan.missing.map(item => item.promptIndex).join(",")
            });
            const promptRepair = await targetedRepairPromptGroups(container);
            state.currentPhase = "VERIFYING";
            state.currentStatus = "";
            renderOverlay();
            validation = validateCompleteness();
            if (validation.complete) {
              logEvent("NEXT_PHASE", { from: "TARGETED_PROMPT_REPAIR", to: "COMPLETE", scan: scanNo, reason: "validation-complete-after-targeted-prompt-repair" });
              break;
            }
            allPromptGroupsCollected = Number.isInteger(state.expectedPromptCount)
              && promptGroupCount() === state.expectedPromptCount;
            logEvent("TARGETED_PROMPT_POST_VERIFY", {
              scan: scanNo,
              attempted: promptRepair.attempted,
              expectedPrompts: state.expectedPromptCount ?? "unknown",
              promptGroupsCollected: promptGroupCount(),
              remainingPrompts: Number.isInteger(state.expectedPromptCount) ? Math.max(0, state.expectedPromptCount - promptGroupCount()) : "unknown",
              allPromptGroupsCollected
            });
          } else {
            logEvent("TARGETED_PROMPT_REPAIR_SKIPPED", {
              scan: scanNo,
              reason: promptPlan.reason,
              expectedPrompts: state.expectedPromptCount ?? "unknown",
              promptGroupsCollected: promptGroupCount(),
              missingPrompts: promptPlan.missingCount ?? "unknown"
            });
          }
        }

        // Remaining skeleton gaps are structural. With a known TOC, preserve
        // the existing 1.0.21 rule: repair them only after all prompt groups
        // are collected. Without a TOC, 1.0.22 permits the same local repair
        // only when the canonical chain is independently proven complete and
        // stable from confirmed top to confirmed bottom.
        const turnRepairEligibility = deriveTargetedTurnRepairEligibility(validation);
        if (turnRepairEligibility.ok) {
          logEvent("NEXT_PHASE", {
            from: "VERIFYING",
            to: "TARGETED_REPAIR",
            scan: scanNo,
            reason: turnRepairEligibility.reason,
            proofMode: turnRepairEligibility.proofMode,
            expectedPrompts: state.expectedPromptCount ?? "unknown",
            promptGroupsCollected: promptGroupCount(),
            connectedPromptGroups: validation.connectedPromptGroups,
            canonicalChainLength: validation.chain?.ids?.length ?? "unknown",
            canonicalRecords: state.records.size,
            unresolvedTurnSlots: validation.skeleton?.unresolvedSlots ?? "unknown"
          });
          const repair = await targetedRepairTurnSlots(container, validation);
          state.currentPhase = "VERIFYING";
          state.currentStatus = "";
          renderOverlay();
          validation = validateCompleteness();
          if (validation.complete) {
            logEvent("NEXT_PHASE", { from: "TARGETED_REPAIR", to: "COMPLETE", scan: scanNo, reason: "validation-complete-after-targeted-repair" });
            break;
          }
          lastReason = repair.attempted ? "targeted-turn-repair-unresolved" : `targeted-turn-repair-not-applicable-${repair.eligibility?.reason || "unknown"}`;
        } else if (!Number.isInteger(state.expectedPromptCount)) {
          logEvent("TARGETED_REPAIR_SKIPPED", {
            scan: scanNo,
            reason: turnRepairEligibility.reason,
            proofMode: turnRepairEligibility.proofMode,
            expectedPrompts: "unknown",
            promptGroupsCollected: promptGroupCount(),
            connectedPromptGroups: validation.connectedPromptGroups,
            canonicalChainLength: validation.chain?.ids?.length ?? "unknown",
            canonicalRecords: state.records.size,
            stableMessages: stableRecordCount(),
            unresolvedTurnSlots: validation.skeleton?.unresolvedSlots ?? "unknown"
          });
          lastReason = `expected-prompts-unknown-${turnRepairEligibility.reason}`;
        } else {
          lastReason = `missing-prompt-groups-${Math.max(0, state.expectedPromptCount - promptGroupCount())}`;
        }

        if (scanNo >= CONFIG.maxForwardScans) {
          logEvent("NEXT_PHASE", { from: "VERIFYING", to: "INCOMPLETE", scan: scanNo, reason: lastReason });
          break;
        }

        // Quality-first safety net. It is deliberately expensive but runs only
        // when local repair could not prove completeness.
        logEvent("NEXT_PHASE", {
          from: "VERIFYING",
          to: "SEEKING_TOP",
          scan: scanNo,
          reason: `${lastReason}-quality-fallback`,
          expectedPrompts: state.expectedPromptCount ?? "unknown",
          promptGroupsCollected: promptGroupCount(),
          unresolvedTurnSlots: validation.skeleton?.unresolvedSlots ?? "unknown"
        });
        logEvent("FULL_RECOVERY_PASS_REQUIRED", {
          scan: scanNo + 1,
          reason: lastReason,
          issues: validation.issues.join(" | ")
        });
        state.currentStatus = "Адресная проверка не доказала полноту. Выполняю один резервный консервативный проход; качество имеет приоритет над временем.";
        renderOverlay();
      }

      if (state.cancelRequested) {
        state.currentPhase = "INTERRUPTED";
        logEvent("RESULT", { status: "INTERRUPTED" });
        await saveCheckpoint({ force: true, status: "INTERRUPTED" });
        await maybeSaveLogSafe();
        renderOverlay("Остановлено. Checkpoint сохранен.");
        setActionButtons({ log: true });
        setTimeout(removeOverlay, CONFIG.overlayAutoCloseMs);
        return;
      }

      validation = validation || validateCompleteness();
      if (validation.complete) await finishComplete(validation);
      else await finishIncomplete(validation, lastReason);
    } catch (error) {
      state.currentPhase = "ERROR";
      logEvent("ERROR", { error: error?.message || error, stack: error?.stack || "" });
      try { await saveCheckpoint({ force: true, status: "ERROR" }); } catch {}
      await maybeSaveLogSafe();
      setActionButtons({ retry: true, log: true });
      renderOverlay(`Ошибка: ${error?.message || error}`);
      console.error("Chat Context Exporter:", error);
    } finally {
      state.running = false;
    }
  }

  globalThis.__ChatGPTConversationExporter = Object.freeze({
    version: VERSION,
    start,
    getState: () => ({
      running: state.running,
      source: state.apiMode ? "API" : "DOM",
      apiProgress: state.apiProgress ? { ...state.apiProgress } : null,
      phase: state.currentPhase,
      records: state.records.size,
      stableRecords: stableRecordCount(),
      expectedMessages: null,
      expectedPrompts: state.expectedPromptCount,
      expectedCountSource: state.expectedCountSource,
      currentStepRatio: state.currentStepRatio,
      topMessageId: state.topMessageId,
      bottomMessageId: state.bottomMessageId,
      chain: buildChain(),
      skeleton: skeletonCoverageStats(),
      confirmedEmptyTurnIds: [...state.confirmedEmptyTurnIds],
      resolvedNoncanonicalTurns: [...state.resolvedNoncanonicalTurns.entries()],
      confirmedTurnBridges: [...state.confirmedTurnBridges.entries()],
      elapsedMs: elapsedMs()
    })
  });
})();
