importScripts('../adapters/chatgpt/dil-to-markdown.js');
importScripts('../adapters/chatgpt/shared-wire-parser.js');
importScripts('../adapters/chatgpt/thread-wire-parser.js');

'use strict';

const chatGptShareWireParser = globalThis.__chatContextExporterShareWireParser;
const chatGptThreadWireParser = globalThis.__chatContextExporterThreadWireParser;
const CAPTURE_RESPONSE_PROCESSORS = Object.freeze({
  'chatgpt-shared-document': (body, session) => chatGptShareWireParser.parseDocumentBody(body, {
    expectedShareId: session.expectedShareId,
  }),
  'chatgpt-thread-json': (body, session) => chatGptThreadWireParser.parsePageBody(body, {
    expectedConversationId: session.expectedConversationId,
  }),
});

const EARLY_PANEL_SCRIPT = 'src/content/early-panel.js';
const EARLY_PANEL_RETRY_DELAYS_MS = [0, 350, 1400];

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
  'src/adapters/deepseek-adapter.js',
  'src/adapters/claude-adapter.js',
  'src/adapters/chatgpt/shared-profile.js',
  'src/adapters/chatgpt/thread-profile.js',
  'src/adapters/chatgpt/generation-guard.js',
  'src/adapters/chatgpt-adapter.js',
  'src/exporters/markdown-exporter.js',
  'src/ui/panel.js',
  'src/content/start.js',
];

const SAVE_FILE_MESSAGE = 'chat-context-exporter:save-file';
const CAPTURE_START_MESSAGE = 'chat-context-exporter:capture:start';
const CAPTURE_GET_STATE_MESSAGE = 'chat-context-exporter:capture:get-state';
const CAPTURE_CANCEL_MESSAGE = 'chat-context-exporter:capture:cancel';
const CAPTURE_RELEASE_MESSAGE = 'chat-context-exporter:capture:release';
const CAPTURE_CONTINUE_MESSAGE = 'chat-context-exporter:capture:continue';
const CAPTURE_SCROLL_STEP_MESSAGE = 'chat-context-exporter:capture:scroll-step';
const CAPTURE_GENERATION_RESTART_MESSAGE = 'chat-context-exporter:capture:generation-restart';
const CAPTURE_SKIP_EXTRA_PASS_MESSAGE = 'chat-context-exporter:capture:skip-extra-pass';
const CAPTURE_GENERATION_WAIT_MESSAGE = 'chat-context-exporter:capture:generation-wait';
const CAPTURE_STATUS_MESSAGE = 'chat-context-exporter:capture:status';
const LOCAL_CACHE_SYNC_START_MESSAGE = 'chat-context-exporter:local-cache-sync:start';
const LOCAL_CACHE_SYNC_GET_STATE_MESSAGE = 'chat-context-exporter:local-cache-sync:get-state';
const LOCAL_CACHE_SYNC_RELEASE_MESSAGE = 'chat-context-exporter:local-cache-sync:release';

const ALLOWED_TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/html',
]);
const SAVE_REQUEST_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CAPTURE_TIMEOUT_MS = 60_000;
const CHATGPT_HTTP_403_RETRY_DELAY_MS = 2500;
const CHATGPT_HTTP_403_MAX_RETRIES_PER_PASS = 1;
// HTTP 429 is a server-side rate limit, not an authorization challenge.
// Respect Retry-After and never perform a rapid or unbounded reload loop.
const CHATGPT_HTTP_429_MAX_RETRIES_PER_PASS = 1;
const CHATGPT_HTTP_429_DEFAULT_COOLDOWN_MS = 120_000;
const CHATGPT_HTTP_429_MAX_COOLDOWN_MS = 15 * 60_000;
const CHATGPT_CURSOR_GAP_TIMEOUT_MS = 15000;
const CHATGPT_MAX_BUFFERED_PAGES = 24;
const CHATGPT_MAX_BUFFERED_PAGE_BYTES = 24 * 1024 * 1024;
const CHATGPT_MAX_GENERATION_RESTARTS_PER_PASS = 1;
const MAX_CAPTURE_BODY_BYTES = 100 * 1024 * 1024;
const LOCAL_CACHE_SYNC_TTL_MS = 2 * 60 * 1000;
const LOCAL_CACHE_SYNC_STORAGE_PREFIX = 'chat-context-exporter:local-cache-sync:';
const PRE_RELOAD_TAIL_STORAGE_PREFIX = 'chat-context-exporter:pre-reload-tail:';
const MAX_PRE_RELOAD_TAIL_USER_CHARS = 256 * 1024;
const MAX_PRE_RELOAD_TAIL_ASSISTANT_CHARS = 2 * 1024 * 1024;
const saveRequests = new Map();
const captureSessions = new Map();
const loadingTabs = new Set();
function nowMs() {
  return Date.now();
}

function createId(prefix) {
  const random = crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}:${random}`;
}

function preReloadTailStorageKey(tabId) {
  return `${PRE_RELOAD_TAIL_STORAGE_PREFIX}${tabId}`;
}

async function storePreReloadTailSnapshot(tabId, snapshot) {
  await chrome.storage.session.set({
    [preReloadTailStorageKey(tabId)]: snapshot,
  });
}

async function removePreReloadTailSnapshot(tabId) {
  await chrome.storage.session.remove(preReloadTailStorageKey(tabId));
}

function sanitizePreReloadTailSnapshot(value, expectedConversationId) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  if (value.authoritative !== true || value.reason !== 'conversation-limit') {
    throw new Error('Некорректный контракт pre-reload DOM-tail snapshot.');
  }

  const conversationId = typeof value.conversationId === 'string' ? value.conversationId.trim() : '';
  if (!conversationId) {
    throw new Error('Pre-reload DOM-tail snapshot не содержит conversationId.');
  }
  if (expectedConversationId && conversationId !== expectedConversationId) {
    throw new Error(`Pre-reload DOM-tail относится к другому разговору (${conversationId}).`);
  }

  const userMarkdown = typeof value.user?.markdown === 'string' ? value.user.markdown.trim() : '';
  const userNormalizedText = typeof value.user?.normalizedText === 'string'
    ? value.user.normalizedText.trim()
    : '';
  const assistantMarkdown = typeof value.assistant?.markdown === 'string'
    ? value.assistant.markdown.trim()
    : '';
  if (!userMarkdown || !userNormalizedText) {
    throw new Error('Pre-reload DOM-tail snapshot не содержит последнее сообщение пользователя.');
  }
  if (!assistantMarkdown) {
    throw new Error('Pre-reload DOM-tail snapshot не содержит последний ответ ассистента.');
  }
  if (userMarkdown.length > MAX_PRE_RELOAD_TAIL_USER_CHARS) {
    throw new Error('Последнее сообщение пользователя слишком велико для pre-reload snapshot.');
  }
  if (assistantMarkdown.length > MAX_PRE_RELOAD_TAIL_ASSISTANT_CHARS) {
    throw new Error('Последний ответ ассистента слишком велик для pre-reload snapshot.');
  }

  return {
    schemaVersion: 1,
    source: 'pre-reload-limit-dom',
    reason: 'conversation-limit',
    authoritative: true,
    conversationId,
    capturedAt: typeof value.capturedAt === 'string' ? value.capturedAt : null,
    user: {
      turnKey: typeof value.user?.turnKey === 'string' && value.user.turnKey.trim()
        ? value.user.turnKey.trim()
        : null,
      messageId: typeof value.user?.messageId === 'string' && value.user.messageId.trim()
        ? value.user.messageId.trim()
        : null,
      markdown: userMarkdown,
      normalizedText: userNormalizedText,
      hash: typeof value.user?.hash === 'string' ? value.user.hash : null,
    },
    assistant: {
      markdown: assistantMarkdown,
      normalizedText: typeof value.assistant?.normalizedText === 'string'
        ? value.assistant.normalizedText.trim()
        : '',
      hash: typeof value.assistant?.hash === 'string' ? value.assistant.hash : null,
      primaryCandidates: Number.isFinite(Number(value.assistant?.primaryCandidates))
        ? Math.max(1, Math.round(Number(value.assistant.primaryCandidates)))
        : null,
    },
  };
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function randomInteger(min, max) {
  const safeMin = Math.ceil(Math.min(min, max));
  const safeMax = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
}

function appendCaptureEvent(session, event, details = {}) {
  session.events.push({
    timestampMs: nowMs(),
    event,
    details,
  });
}

function getRequestBeforeCursor(url) {
  try {
    return new URL(url).searchParams.get('before');
  } catch {
    return null;
  }
}

function getRetryAfterMs(headers, currentTimeMs = nowMs()) {
  if (!headers || typeof headers !== 'object') return null;
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'retry-after');
  if (!entry) return null;
  const value = String(entry[1] ?? '').trim();
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.ceil(Number(value) * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - currentTimeMs) : null;
}

function getCurrentPassCheckpoint(session) {
  const pages = session.captures.filter((capture) => capture.pass === session.pass);
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    if (page.pageSequence !== i + 1 || !page.processed?.pageInfo?.startCursor
        || (i > 0 && page.requestBefore !== pages[i - 1].processed.pageInfo.startCursor)) {
      throw new Error('Нарушена целостность сохранённых страниц перед восстановлением HTTP 429.');
    }
  }
  return pages;
}

function checkpointPageIdentityMatches(checkpoint, incoming) {
  const oldInfo = checkpoint?.processed?.pageInfo;
  const newInfo = incoming?.processed?.pageInfo;
  if (!oldInfo || !newInfo || checkpoint.requestBefore !== incoming.requestBefore) return false;
  for (const field of ['startCursor', 'endCursor', 'hasPreviousPage', 'hasNextPage']) {
    if (oldInfo[field] !== newInfo[field]) return false;
  }
  return true;
}

function checkpointPageContentMatches(checkpoint, incoming) {
  return JSON.stringify(checkpoint.processed.messages || [])
    === JSON.stringify(incoming.processed.messages || []);
}

function getCurrentPaginationRequest(session) {
  if (
    !session
    || session.paginationMode !== 'scroll-up-until-start'
    || !session.pageState?.startCursor
  ) {
    return null;
  }

  const expectedBefore = session.pageState.startCursor;
  let matched = null;
  for (const requestInfo of session.pendingRequests.values()) {
    if (requestInfo.bodyProcessed || getRequestBeforeCursor(requestInfo.url) !== expectedBefore) {
      continue;
    }
    matched = {
      requestId: requestInfo.requestId,
      beforeCursor: expectedBefore,
      pageSequence: session.pageState.pageSequence || null,
      responseReceived: requestInfo.status !== null,
      handled: Boolean(requestInfo.handled),
    };
  }
  return matched;
}

function serializeCaptureSession(session, { includeCaptures = false, includeEvents = true } = {}) {
  if (!session) {
    return null;
  }

  return {
    id: session.id,
    adapterId: session.adapterId,
    expectedConversationId: session.expectedConversationId || null,
    tabId: session.tabId,
    phase: session.phase,
    startedAt: session.startedAt,
    pass: session.pass,
    totalPasses: session.totalPasses,
    extraPasses: Math.max(0, session.totalPasses - 1),
    capturesCompleted: session.captures.length,
    matchedRequests: session.matchedRequests,
    paginationMode: session.paginationMode || null,
    pageState: session.pageState ? { ...session.pageState } : null,
    paginationRequest: getCurrentPaginationRequest(session),
    bufferedPaginationPages: session.bufferedPages?.size || 0,
    generationRestartCount: session.generationRestartCount || 0,
    completedPasses: session.completedPasses || 0,
    captureWarning: session.captureWarning || null,
    skippedExtraPasses: session.skippedExtraPasses || 0,
    error: session.error || null,
    http403RetryCount: session.http403RetryCount || 0,
    http403MaxRetries: session.responseProcessor === 'chatgpt-thread-json'
      ? CHATGPT_HTTP_403_MAX_RETRIES_PER_PASS
      : 0,
    http429RetryCount: session.http429RetryCount || 0,
    http429MaxRetries: session.responseProcessor === 'chatgpt-thread-json'
      ? CHATGPT_HTTP_429_MAX_RETRIES_PER_PASS : 0,
    httpRetryStatus: session.httpRetryStatus || null,
    httpRetryAt: session.httpRetryAt || null,
    http429CheckpointPages: session.http429Checkpoint?.length || 0,
    preReloadTail: session.preReloadTailSnapshot ? {
      captured: true,
      source: session.preReloadTailSnapshot.source,
      reason: session.preReloadTailSnapshot.reason,
      conversationId: session.preReloadTailSnapshot.conversationId,
      userMessageId: session.preReloadTailSnapshot.user?.messageId || null,
      userTurnKey: session.preReloadTailSnapshot.user?.turnKey || null,
      assistantChars: session.preReloadTailSnapshot.assistant?.markdown?.length || 0,
      assistantHash: session.preReloadTailSnapshot.assistant?.hash || null,
    } : null,
    preReloadTailSnapshot: includeCaptures && session.preReloadTailSnapshot
      ? structuredClone(session.preReloadTailSnapshot)
      : undefined,
    events: includeEvents ? session.events.map((entry) => ({ ...entry })) : undefined,
    captures: includeCaptures
      ? session.captures.map((capture) => ({ ...capture }))
      : undefined,
  };
}

// The full runtime still starts only when the document has finished loading.
// This lightweight, isolated UI is injected on navigation/loading so that the
// operator can see the active session while ChatGPT itself is still loading.
async function injectEarlyPanel(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    files: [EARLY_PANEL_SCRIPT],
    injectImmediately: true,
  });
}

function scheduleEarlyPanelForLoading(tabId) {
  const session = captureSessions.get(tabId);
  if (!session || ['released', 'cancelled', 'error', 'ready'].includes(session.phase)) return;
  for (const delayMs of EARLY_PANEL_RETRY_DELAYS_MS) {
    setTimeout(() => {
      const current = captureSessions.get(tabId);
      if (!current || current.id !== session.id
          || ['released', 'cancelled', 'error', 'ready'].includes(current.phase)) return;
      void injectEarlyPanel(tabId).catch(() => {
        // Chrome can reject injections while a navigation is committing.
        // A later attempt or the complete-stage runtime remains the fallback.
      });
    }, delayMs);
  }
}

async function injectRuntime(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    files: CONTENT_SCRIPTS,
  });
}

async function setTemporaryErrorBadge(tabId) {
  await chrome.action.setBadgeText({ tabId, text: 'ERR' }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#7f1d1d' }).catch(() => {});
  setTimeout(() => {
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  }, 3000);
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) {
    return;
  }

  try {
    await injectRuntime(tab.id);
  } catch (error) {
    console.error('Chat Context Exporter: не удалось запустить content scripts.', error);
    await setTemporaryErrorBadge(tab.id);
  }
});

function pruneSaveRequests() {
  const cutoff = Date.now() - SAVE_REQUEST_TTL_MS;
  for (const [requestId, entry] of saveRequests.entries()) {
    if (entry.createdAt < cutoff) {
      saveRequests.delete(requestId);
    }
  }
}

function createSaveOperation(message) {
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
    return Promise.resolve({ ok: false, error: 'Некорректные данные для сохранения файла.' });
  }

  const dataUrl = `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`;
  return chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs,
    conflictAction: 'uniquify',
  })
    .then((downloadId) => ({ ok: true, downloadId }))
    .catch((error) => {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    });
}

function decodeBase64Utf8(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function clearCursorGapTimer(session) {
  if (session?.cursorGapTimer != null) {
    clearTimeout(session.cursorGapTimer);
    session.cursorGapTimer = null;
  }
}

function clearCaptureTimer(session) {
  if (session.timer !== null) {
    clearTimeout(session.timer);
    session.timer = null;
  }
}

async function detachCaptureDebugger(session) {
  clearCaptureTimer(session);
  if (!session.attached) {
    return;
  }

  session.detaching = true;
  try {
    await chrome.debugger.detach({ tabId: session.tabId });
  } catch (error) {
    appendCaptureEvent(session, 'DEBUGGER_DETACH_FAILED', {
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    session.attached = false;
    session.detaching = false;
  }
}

async function notifyCaptureSession(session) {
  const message = {
    type: CAPTURE_STATUS_MESSAGE,
    state: serializeCaptureSession(session),
  };

  try {
    await chrome.tabs.sendMessage(session.tabId, message);
    return;
  } catch {
    // После reload content script может еще не быть установлен.
  }

  // Do not start the full runtime inside a document that has not completed
  // navigation; its DOM and adapter are not yet guaranteed to exist.
  if (loadingTabs.has(session.tabId)) return;
  try {
    await injectRuntime(session.tabId);
    await chrome.tabs.sendMessage(session.tabId, message).catch(() => {});
  } catch {
    // tabs.onUpdated повторит инъекцию после завершения навигации.
  }
}

// A confirmed complete pass is immutable. A failure in an optional pass must not
// destroy its result, but must be visible in the log and exported artifact.
async function skipIncompleteExtraPass(session, error, stage) {
  if (!session || session.responseProcessor !== 'chatgpt-thread-json'
      || session.pass <= 1 || (session.completedPasses || 0) < 1
      || !session.captures.some((capture) => capture.pass === session.completedPasses)) {
    return false;
  }
  clearCaptureTimer(session);
  clearCursorGapTimer(session);
  const dropped = session.captures.filter((capture) => capture.pass > session.completedPasses).length;
  session.captures = session.captures.filter((capture) => capture.pass <= session.completedPasses);
  session.pendingRequests.clear();
  session.bufferedPages?.clear?.();
  session.bufferedPageBytes = 0;
  session.cursorGapStartedAt = null;
  session.skippedExtraPasses = Math.max(0, session.totalPasses - session.completedPasses);
  const cause = error instanceof Error ? error.message : String(error);
  session.captureWarning = `Дополнительная проверка истории не выполнена (${cause}). `
    + `Сохранён только полный проход ${session.completedPasses} из ${session.totalPasses}.`;
  session.error = null;
  session.phase = 'ready';
  appendCaptureEvent(session, 'CHATGPT_EXTRA_PASS_SKIPPED', {
    failedPass: session.pass, completedPasses: session.completedPasses,
    requestedPasses: session.totalPasses, discardedPages: dropped,
    stage, cause,
  });
  appendCaptureEvent(session, 'CAPTURE_READY_WITH_WARNING', {
    completedPasses: session.completedPasses,
    requestedPasses: session.totalPasses,
    captures: session.captures.length,
    warning: session.captureWarning,
  });
  const wasAttached = session.attached;
  await detachCaptureDebugger(session);
  if (wasAttached) appendCaptureEvent(session, 'DEBUGGER_DETACHED', {reason:'optional-pass-skipped'});
  await notifyCaptureSession(session);
  return true;
}

async function skipExtraPassAfterGeneration(tabId) {
  const session = captureSessions.get(tabId);
  if (!session) return {ok:false, error:'Сессия захвата не найдена.'};
  if (session.phase === 'ready' && session.captureWarning) {
    return {ok:true, state:serializeCaptureSession(session)};
  }
  const skipped = await skipIncompleteExtraPass(session,
    new Error('при перезагрузке страницы повторно обнаружена активная генерация ChatGPT'),
    'generation-active-extra-pass');
  return skipped
    ? {ok:true, state:serializeCaptureSession(session)}
    : {ok:false, error:'Нет завершённого основного прохода для безопасного сохранения.'};
}

async function failCaptureSession(session, error, stage) {
  if (!session || ['released', 'cancelled', 'ready', 'error'].includes(session.phase)) {
    return;
  }
  if (await skipIncompleteExtraPass(session, error, stage)) return;

  clearCaptureTimer(session);
  clearCursorGapTimer(session);
  session.phase = 'error';
  session.error = error instanceof Error ? error.message : String(error);
  appendCaptureEvent(session, 'CAPTURE_ERROR', {
    stage,
    pass: session.pass,
    message: session.error,
  });
  const wasAttached = session.attached;
  await detachCaptureDebugger(session);
  if (wasAttached) appendCaptureEvent(session, 'DEBUGGER_DETACHED', { reason: 'error' });
  await removePreReloadTailSnapshot(session.tabId).catch(() => {});
  await notifyCaptureSession(session);
}

function scheduleCaptureTimeout(session) {
  clearCaptureTimer(session);
  session.timer = setTimeout(() => {
    void failCaptureSession(
      session,
      new Error(`Не получен ожидаемый сетевой ответ за ${session.timeoutMs} мс.`),
      'response-timeout',
    );
  }, session.timeoutMs);
}

async function beginCapturePass(session, { retryHttp403 = false, retryHttp429 = false } = {}) {
  if (!session || session.phase === 'cancelled' || session.phase === 'released' || session.phase === 'error') {
    return;
  }
  if ((retryHttp403 || retryHttp429) && session.phase !== 'waiting-http-retry') return;
  if (retryHttp403 && retryHttp429) return;
  session.httpRetryStatus = null;
  session.httpRetryAt = null;
  if (retryHttp403) {
    // A failed pagination attempt is incomplete: discard only this pass.
    // Completed earlier passes and the authoritative pre-reload tail remain intact.
    const discarded = session.captures.length;
    session.captures = session.captures.filter((capture) => capture.pass !== session.pass);
    appendCaptureEvent(session, 'CHATGPT_THREAD_HTTP_403_RETRY_STARTED', {
      pass: session.pass,
      retry: session.http403RetryCount,
      discardedCaptures: discarded - session.captures.length,
      previousPassCapturesPreserved: session.captures.length,
    });
  } else if (retryHttp429) {
    try {
      // Keep the accepted pages and their parsed contents. Replay only verifies
      // the already-accepted prefix after reload; it must not duplicate captures.
      session.http429Checkpoint = getCurrentPassCheckpoint(session);
    } catch (error) {
      await failCaptureSession(session, error, 'http-429-checkpoint');
      return;
    }
    appendCaptureEvent(session, 'CHATGPT_THREAD_HTTP_429_RETRY_STARTED', {
      pass: session.pass, retry: session.http429RetryCount,
      preservedPages: session.http429Checkpoint.length,
      previousPassCapturesPreserved: session.captures.filter(c => c.pass < session.pass).length,
    });
  } else {
    session.pass += 1;
    session.http403RetryCount = 0;
    session.http429RetryCount = 0;
  }
  if (!retryHttp429) session.http429Checkpoint = null;
  session.attemptEpoch += 1;
  session.phase = 'capturing';
  session.generationGuardWaiting = false;
  session.error = null;
  session.currentPassCaptured = false;
  session.pagesCapturedInPass = 0;
  session.pageState = null;
  session.seenPageStartCursors = new Set();
  session.acceptedRequestBeforeCursors = new Set();
  session.bufferedPages = new Map();
  session.bufferedPageBytes = 0;
  session.cursorGapStartedAt = null;
  session.drainingPages = false;
  clearCursorGapTimer(session);
  if (!retryHttp403 && !retryHttp429) session.generationRestartCount = 0;
  session.currentPassTranscriptIds = new Set();
  session.pendingRequests.clear();
  if (!retryHttp403 && !retryHttp429) {
    appendCaptureEvent(session, 'PASS_STARTED', {
      pass: session.pass,
      totalPasses: session.totalPasses,
      extraPass: session.pass > 1,
      capturesBefore: session.captures.length,
    });
  }
  appendCaptureEvent(session, 'PAGE_RELOAD_REQUESTED', {
    pass: session.pass,
    totalPasses: session.totalPasses,
    reason: retryHttp403 ? 'http-403-recovery' : retryHttp429 ? 'http-429-cooldown-recovery' : 'normal-pass',
    http403RetryCount: session.http403RetryCount,
    http429RetryCount: session.http429RetryCount,
    preservedPages: session.http429Checkpoint?.length || 0,
  });

  scheduleCaptureTimeout(session);

  try {
    await chrome.debugger.sendCommand(
      { tabId: session.tabId },
      'Page.reload',
      { ignoreCache: false },
    );
  } catch (error) {
    await failCaptureSession(session, error, 'page-reload');
  }
}

async function completeCapturePass(session) {
  if (session.phase === 'error' || session.phase === 'ready' || session.phase === 'cancelled') return;
  clearCaptureTimer(session);
  session.completedPasses = Math.max(session.completedPasses || 0, session.pass);
  clearCursorGapTimer(session);
  appendCaptureEvent(session, 'PASS_COMPLETED', {
    pass: session.pass,
    totalPasses: session.totalPasses,
    extraPass: session.pass > 1,
    capturesAfter: session.captures.length,
  });

  if (session.pass < session.totalPasses) {
    const delayMs = randomInteger(session.minDelayMs, session.maxDelayMs);
    session.phase = 'waiting-next-pass';
    appendCaptureEvent(session, 'WAIT', {
      reason: 'between-network-passes',
      delayMs,
      pass: session.pass,
      totalPasses: session.totalPasses,
    });
    await notifyCaptureSession(session);
    session.timer = setTimeout(() => {
      session.timer = null;
      void beginCapturePass(session);
    }, delayMs);
    return;
  }

  session.phase = 'ready';
  appendCaptureEvent(session, 'CAPTURE_READY', {
    passes: session.totalPasses,
    captures: session.captures.length,
    matchedRequests: session.matchedRequests,
  });
  await notifyCaptureSession(session);
}

function isCurrentChatGptThreadPageRequest(session, requestInfo) {
  if (session.responseProcessor !== 'chatgpt-thread-json') {
    return false;
  }
  const requestBefore = getRequestBeforeCursor(requestInfo.url);
  if (!session.pageState) {
    return !requestBefore;
  }
  return Boolean(requestBefore && requestBefore === session.pageState.startCursor);
}

async function handleCaptureHttpError(session, requestId, requestInfo) {
  if (!['capturing', 'awaiting-scroll'].includes(session.phase) || requestInfo.attemptEpoch !== session.attemptEpoch) {
    return;
  }
  const status = Number(requestInfo.status);
  const requestBefore = getRequestBeforeCursor(requestInfo.url);
  const isChatGptPage = isCurrentChatGptThreadPageRequest(session, requestInfo);
  if (session.responseProcessor === 'chatgpt-thread-json' && !isChatGptPage) {
    appendCaptureEvent(session, 'CHATGPT_THREAD_RESPONSE_SKIPPED', {
      pass: session.pass,
      requestId,
      reason: 'http-error-outside-current-cursor-chain',
      status,
    });
    return;
  }

  appendCaptureEvent(session, 'NETWORK_HTTP_ERROR', {
    pass: session.pass,
    requestId,
    status,
    mimeType: requestInfo.mimeType,
    beforeCursor: requestBefore,
    pageSequence: session.pageState?.pageSequence || null,
  });

  if (status === 429 && isChatGptPage
      && session.http429RetryCount < CHATGPT_HTTP_429_MAX_RETRIES_PER_PASS) {
    const serverRetryAfterMs = getRetryAfterMs(requestInfo.responseHeaders);
    if (serverRetryAfterMs != null && serverRetryAfterMs > CHATGPT_HTTP_429_MAX_COOLDOWN_MS) {
      await failCaptureSession(session, new Error(
        `HTTP 429: сервер запросил ожидание ${Math.ceil(serverRetryAfterMs / 1000)} секунд. `
        + 'Автоматическая перезагрузка отменена: длительное ограничение частоты запросов. '
        + 'Дождитесь разрешённого времени и повторите экспорт вручную.',
      ), 'http-429-retry-after-too-long');
      return;
    }
    const delayMs = Math.max(CHATGPT_HTTP_429_DEFAULT_COOLDOWN_MS, serverRetryAfterMs || 0);
    session.http429RetryCount += 1;
    clearCaptureTimer(session);
    session.phase = 'waiting-http-retry';
    session.httpRetryStatus = 429;
    session.httpRetryAt = nowMs() + delayMs;
    session.pendingRequests.clear();
    clearCursorGapTimer(session);
    appendCaptureEvent(session, 'CHATGPT_THREAD_HTTP_429_RETRY_SCHEDULED', {
      pass: session.pass, retry: session.http429RetryCount,
      maxRetries: CHATGPT_HTTP_429_MAX_RETRIES_PER_PASS,
      delayMs, serverRetryAfterMs,
      beforeCursor: requestBefore,
      preservedPages: session.captures.filter(c => c.pass === session.pass).length,
    });
    session.timer = setTimeout(() => {
      session.timer = null;
      void beginCapturePass(session, { retryHttp429: true });
    }, delayMs);
    await notifyCaptureSession(session);
    return;
  }

  if (status === 403 && isChatGptPage
      && session.http403RetryCount < CHATGPT_HTTP_403_MAX_RETRIES_PER_PASS) {
    session.http403RetryCount += 1;
    clearCaptureTimer(session);
    session.phase = 'waiting-http-retry';
    session.httpRetryStatus = 403;
    session.httpRetryAt = nowMs() + CHATGPT_HTTP_403_RETRY_DELAY_MS;
    session.pendingRequests.clear();
    clearCursorGapTimer(session);
    appendCaptureEvent(session, 'CHATGPT_THREAD_HTTP_403_RETRY_SCHEDULED', {
      pass: session.pass,
      retry: session.http403RetryCount,
      maxRetries: CHATGPT_HTTP_403_MAX_RETRIES_PER_PASS,
      delayMs: CHATGPT_HTTP_403_RETRY_DELAY_MS,
      beforeCursor: requestBefore,
    });
    session.timer = setTimeout(() => {
      session.timer = null;
      void beginCapturePass(session, { retryHttp403: true });
    }, CHATGPT_HTTP_403_RETRY_DELAY_MS);
    await notifyCaptureSession(session);
    return;
  }

  const description = status === 403
    ? 'Сервер ChatGPT вернул HTTP 403 (доступ к странице истории отклонён).'
    : `Сервер вернул HTTP ${status} при получении истории диалога.`;
  const retryNote = status === 403 && isChatGptPage
    ? ' Повторная попытка через 2,5 секунды и перезагрузка страницы не помогли.'
    : status === 429 && isChatGptPage && session.http429RetryCount > 0
      ? ' После паузы и единственной повторной перезагрузки ограничение сервера сохранилось.'
      : '';
  await failCaptureSession(session, new Error(
    `${description}${retryNote} Экспорт не создан: история неполная. `
    + 'Попробуйте обновить страницу и повторить экспорт позже.',
  ), 'http-response');
}

function refreshCursorGapWatch(session) {
  clearCursorGapTimer(session);
  if (!session || !['capturing', 'awaiting-scroll'].includes(session.phase)) return;
  const expected = session.pageState?.startCursor || null;
  if (!expected || session.bufferedPages.size === 0 || session.bufferedPages.has(expected)) {
    session.cursorGapStartedAt = null;
    return;
  }
  if (!session.cursorGapStartedAt) session.cursorGapStartedAt = nowMs();
  const epoch = session.attemptEpoch;
  const pass = session.pass;
  const elapsed = nowMs() - session.cursorGapStartedAt;
  session.cursorGapTimer = setTimeout(() => {
    session.cursorGapTimer = null;
    if (session.attemptEpoch !== epoch || session.pass !== pass ||
        !['capturing', 'awaiting-scroll'].includes(session.phase)) return;
    const waitingFor = session.pageState?.startCursor || null;
    if (!waitingFor || !session.bufferedPages.size || session.bufferedPages.has(waitingFor)) return;
    appendCaptureEvent(session, 'CHATGPT_THREAD_CURSOR_CHAIN_INCOMPLETE', {
      expectedBefore: waitingFor,
      bufferedBefore: [...session.bufferedPages.keys()].slice(0, CHATGPT_MAX_BUFFERED_PAGES),
      acceptedPages: session.pagesCapturedInPass,
    });
    void failCaptureSession(session, new Error(
      `CURSOR_CHAIN_INCOMPLETE: ожидалась страница before=${waitingFor}, `
      + `но пришли другие страницы (${session.bufferedPages.size}). `
      + `Принято страниц: ${session.pagesCapturedInPass}. Экспорт не сохранён: история неполная.`,
    ), 'cursor-chain-incomplete');
  }, Math.max(1, CHATGPT_CURSOR_GAP_TIMEOUT_MS - elapsed));
}

async function drainBufferedPaginationPages(session) {
  if (session.drainingPages || !['capturing', 'awaiting-scroll'].includes(session.phase)) return;
  session.drainingPages = true;
  try {
    while (['capturing', 'awaiting-scroll'].includes(session.phase)) {
      const expected = session.pageState?.startCursor || null;
      const buffered = session.bufferedPages.get(expected);
      if (!expected || !buffered) break;
      session.bufferedPages.delete(expected);
      session.bufferedPageBytes -= buffered.bodyBytes;
      const { processed, requestInfo, requestId, bodyBytes, params, requestBefore } = buffered;
      if (processed.pageInfo.startCursor && session.seenPageStartCursors.has(processed.pageInfo.startCursor)) {
        appendCaptureEvent(session, 'CHATGPT_THREAD_CURSOR_CHAIN_INCOMPLETE', {
          pass: session.pass, requestId, reason: 'no-progress-duplicate-start-cursor',
          startCursor: processed.pageInfo.startCursor, expectedBefore: requestBefore,
        });
        await failCaptureSession(session, new Error(
          `CURSOR_CHAIN_INCOMPLETE: повторно получена страница ${processed.pageInfo.startCursor}, `
          + 'курсорная цепочка не продвигается. Экспорт не сохранён.',
        ), 'cursor-chain-incomplete');
        return;
      }
      await acceptPaginatedPage(session, buffered);
      if (session.phase === 'ready' || session.phase === 'waiting-next-pass') return;
    }
  } finally {
    session.drainingPages = false;
    refreshCursorGapWatch(session);
  }
}

async function acceptPaginatedPage(session, item) {
  const { processed, requestInfo, requestId, bodyBytes, params, requestBefore } = item;
  const pageSequence = session.pagesCapturedInPass + 1;
  const pageInfo = processed.pageInfo;
  if (pageInfo.startCursor && session.seenPageStartCursors.has(pageInfo.startCursor)) return;
  const checkpoint = session.http429Checkpoint?.[pageSequence - 1] || null;
  if (checkpoint && !checkpointPageIdentityMatches(checkpoint, item)) {
    throw new Error('HTTP_429_CHECKPOINT_MISMATCH: после перезагрузки изменилась '
      + `курсорная идентичность страницы ${pageSequence}. Объединение разных версий истории запрещено.`);
  }
  if (checkpoint && !checkpointPageContentMatches(checkpoint, item)) {
    if (pageSequence !== 1 || requestBefore) {
      throw new Error('HTTP_429_CHECKPOINT_MISMATCH: изменилось содержимое ранее '
        + `принятой исторической страницы ${pageSequence}. Безопасное объединение запрещено.`);
    }
    // The tail may contain the assistant answer finalized during the cooldown.
    // Replace only this tail snapshot, and only with identical cursor boundaries.
    checkpoint.processed = processed;
    checkpoint.bodyBytes = bodyBytes;
    checkpoint.requestId = requestId;
    checkpoint.status = requestInfo.status;
    appendCaptureEvent(session, 'CHATGPT_THREAD_HTTP_429_TAIL_REFRESHED', {
      pass: session.pass, pageSequence, startCursor: pageInfo.startCursor,
      reason: 'same-cursors-new-tail-content',
    });
  }
  if (pageInfo.startCursor) session.seenPageStartCursors.add(pageInfo.startCursor);
  if (requestBefore) session.acceptedRequestBeforeCursors.add(requestBefore);
  session.pagesCapturedInPass = pageSequence;
  for (const message of processed.messages || []) {
    if (typeof message?.id === 'string' && message.id) session.currentPassTranscriptIds.add(message.id);
  }
  if (checkpoint) {
    appendCaptureEvent(session, 'CHATGPT_THREAD_HTTP_429_CHECKPOINT_VERIFIED', {
      pass: session.pass, pageSequence, startCursor: pageInfo.startCursor,
      preservedRequestId: checkpoint.requestId,
    });
    if (pageSequence === session.http429Checkpoint.length) {
      appendCaptureEvent(session, 'CHATGPT_THREAD_HTTP_429_CHECKPOINT_RESTORED', {
        pass: session.pass, preservedPages: pageSequence,
      });
      session.http429Checkpoint = null;
    }
  } else {
    session.captures.push({
      pass: session.pass, pageSequence, requestId, requestBefore, url: requestInfo.url,
      method: requestInfo.method, resourceType: requestInfo.resourceType || null,
      status: requestInfo.status ?? null, mimeType: requestInfo.mimeType ?? null,
      bodyBytes, encodedDataLength: Number.isFinite(params?.encodedDataLength) ? params.encodedDataLength : null,
      processed,
    });
    appendCaptureEvent(session, 'NETWORK_BODY_CAPTURED', {
      pass: session.pass, totalPasses: session.totalPasses, pageSequence, requestId,
      url: requestInfo.url, method: requestInfo.method, resourceType: requestInfo.resourceType || null,
      status: requestInfo.status ?? null, mimeType: requestInfo.mimeType ?? null,
      bodyBytes, encodedDataLength: Number.isFinite(params?.encodedDataLength) ? params.encodedDataLength : null,
    });
  }
  if (requestBefore) appendCaptureEvent(session, 'CHATGPT_THREAD_PAGINATION_REQUEST_RESOLVED', {
    pass: session.pass, pageSequence, requestId, beforeCursor: requestBefore,
  });
  session.pageState = {
    pageSequence, startCursor: pageInfo.startCursor || null,
    endCursor: pageInfo.endCursor || null,
    hasPreviousPage: pageInfo.hasPreviousPage === true,
    hasNextPage: pageInfo.hasNextPage === true,
    transcriptMessagesInPage: processed?.stats?.total ?? 0,
    transcriptMessagesInPass: session.currentPassTranscriptIds.size,
    rawMessagesInPage: processed?.rawMessages ?? 0,
  };
  session.cursorGapStartedAt = null;
  if (pageInfo.hasPreviousPage === false) {
    appendCaptureEvent(session, 'CHATGPT_THREAD_START_REACHED', {
      pass: session.pass, pageSequence, startCursor: pageInfo.startCursor || null,
      pagesCaptured: session.pagesCapturedInPass,
      transcriptMessages: session.currentPassTranscriptIds.size,
    });
    session.bufferedPages.clear();
    session.bufferedPageBytes = 0;
    await completeCapturePass(session);
  } else {
    clearCaptureTimer(session);
    session.phase = 'awaiting-scroll';
    appendCaptureEvent(session, 'CHATGPT_THREAD_PAGE_READY_FOR_SCROLL', {
      pass: session.pass, pageSequence, startCursor: pageInfo.startCursor || null,
      transcriptMessages: session.currentPassTranscriptIds.size,
    });
    await notifyCaptureSession(session);
  }
}

async function captureResponseBody(session, requestId, requestInfo, params) {
  const paginated = session?.paginationMode === 'scroll-up-until-start';
  if (!session || !['capturing', 'awaiting-scroll'].includes(session.phase)
      || requestInfo.attemptEpoch !== session.attemptEpoch
      || (!paginated && session.currentPassCaptured) || requestInfo.handled) {
    return;
  }

  requestInfo.handled = true;

  try {
    const result = await chrome.debugger.sendCommand(
      { tabId: session.tabId },
      'Network.getResponseBody',
      { requestId },
    );
    // An HTTP recovery or cancellation may have started during the CDP call.
    if (!['capturing', 'awaiting-scroll'].includes(session.phase) || requestInfo.attemptEpoch !== session.attemptEpoch) {
      return;
    }

    let body = typeof result?.body === 'string' ? result.body : '';
    if (result?.base64Encoded) {
      body = decodeBase64Utf8(body);
    }

    if (!body) {
      throw new Error('Network.getResponseBody вернул пустое тело ответа.');
    }

    const bodyBytes = new TextEncoder().encode(body).byteLength;
    if (bodyBytes > MAX_CAPTURE_BODY_BYTES) {
      throw new Error(`Тело ответа превышает лимит ${MAX_CAPTURE_BODY_BYTES} байт.`);
    }

    let processed = null;
    const responseProcessor = session.responseProcessor
      ? CAPTURE_RESPONSE_PROCESSORS[session.responseProcessor]
      : null;
    if (responseProcessor) {
      processed = responseProcessor(body, session);
      if (session.responseProcessor === 'chatgpt-shared-document') {
        appendCaptureEvent(session, 'CHATGPT_SHARE_DOCUMENT_PARSED', {
          pass: session.pass,
          requestId,
          wireFormat: processed?.transport?.wireFormat || null,
          tableEntries: processed?.transport?.tableEntries ?? null,
          rawNodes: processed?.rawNodes ?? null,
          mappingNodes: processed?.mappingNodes ?? null,
          uniqueRawNodeIds: processed?.uniqueRawNodeIds ?? null,
          currentNodeMatchesLast: Boolean(processed?.currentNode && processed?.currentNode === processed?.lastNodeId),
          messages: processed?.stats?.total ?? null,
          user: processed?.stats?.user ?? null,
          assistant: processed?.stats?.assistant ?? null,
          generatedFileCards: processed?.stats?.generatedFileCards ?? null,
          generatedFileCardsMoved: processed?.stats?.generatedFileCardsMoved ?? null,
          targetedReplyEnvelopesNormalized: processed?.stats?.targetedReplyEnvelopesNormalized ?? null,
          assistantPreambleFallbacksIncluded: processed?.stats?.assistantPreambleFallbacksIncluded ?? null,
          assistantPreamblesSuppressedByFinal: processed?.stats?.assistantPreamblesSuppressedByFinal ?? null,
        });
      } else if (session.responseProcessor === 'chatgpt-thread-json') {
        appendCaptureEvent(session, 'CHATGPT_THREAD_PAGE_PARSED', {
          pass: session.pass,
          requestId,
          pageSequence: session.pagesCapturedInPass + 1,
          rawMessages: processed?.rawMessages ?? null,
          messages: processed?.stats?.total ?? null,
          user: processed?.stats?.user ?? null,
          assistant: processed?.stats?.assistant ?? null,
          generatedFileCards: processed?.stats?.generatedFileCards ?? null,
          generatedFileCardsMoved: processed?.stats?.generatedFileCardsMoved ?? null,
          targetedReplyEnvelopesNormalized: processed?.stats?.targetedReplyEnvelopesNormalized ?? null,
          assistantPreambleFallbacksIncluded: processed?.stats?.assistantPreambleFallbacksIncluded ?? null,
          assistantPreamblesSuppressedByFinal: processed?.stats?.assistantPreamblesSuppressedByFinal ?? null,
          startCursor: processed?.pageInfo?.startCursor || null,
          endCursor: processed?.pageInfo?.endCursor || null,
          hasPreviousPage: processed?.pageInfo?.hasPreviousPage ?? null,
          hasNextPage: processed?.pageInfo?.hasNextPage ?? null,
        });
      }
    }

    const requestBefore = getRequestBeforeCursor(requestInfo.url);
    if (paginated) {
      const pageInfo = processed?.pageInfo;
      if (!pageInfo) throw new Error('Paginated capture processor не вернул pageInfo.');
      if (!session.pageState && !requestBefore) {
        if (pageInfo.hasNextPage !== false) {
          appendCaptureEvent(session, 'CHATGPT_THREAD_RESPONSE_SKIPPED', {
            pass: session.pass, requestId, reason: 'initial-response-not-tail',
          });
          return;
        }
        await acceptPaginatedPage(session, { processed, requestInfo, requestId, bodyBytes, params, requestBefore });
        await drainBufferedPaginationPages(session);
        return;
      }
      if (!requestBefore) {
        appendCaptureEvent(session, 'CHATGPT_THREAD_RESPONSE_SKIPPED', {
          pass: session.pass, requestId, reason: 'unsolicited-initial-response',
        });
        return;
      }
      if (session.bufferedPages.has(requestBefore) || session.acceptedRequestBeforeCursors.has(requestBefore)) {
        appendCaptureEvent(session, 'CHATGPT_THREAD_RESPONSE_SKIPPED', {
          pass: session.pass, requestId, reason: 'duplicate-before-cursor', requestBefore,
        });
        return;
      }
      if (session.bufferedPages.size >= CHATGPT_MAX_BUFFERED_PAGES
          || session.bufferedPageBytes + bodyBytes > CHATGPT_MAX_BUFFERED_PAGE_BYTES) {
        throw new Error('Буфер страниц ChatGPT переполнен. Экспорт остановлен без потери контроля полноты.');
      }
      session.bufferedPages.set(requestBefore, {processed, requestInfo, requestId, bodyBytes, params, requestBefore});
      session.bufferedPageBytes += bodyBytes;
      appendCaptureEvent(session, 'CHATGPT_THREAD_PAGE_BUFFERED', {
        pass: session.pass, requestId, requestBefore,
        expectedBefore: session.pageState?.startCursor || null,
        bufferedPages: session.bufferedPages.size,
      });
      await drainBufferedPaginationPages(session);
      return;
    }

    session.currentPassCaptured = true;
    session.captures.push({
      pass: session.pass, pageSequence: null, requestId, requestBefore,
      url: requestInfo.url, method: requestInfo.method,
      resourceType: requestInfo.resourceType || null, status: requestInfo.status ?? null,
      mimeType: requestInfo.mimeType ?? null, bodyBytes,
      encodedDataLength: Number.isFinite(params?.encodedDataLength) ? params.encodedDataLength : null,
      ...(processed ? { processed } : { body }),
    });
    appendCaptureEvent(session, 'NETWORK_BODY_CAPTURED', {
      pass: session.pass, totalPasses: session.totalPasses,
      pageSequence: null, requestId, url: requestInfo.url, method: requestInfo.method,
      resourceType: requestInfo.resourceType || null, status: requestInfo.status ?? null,
      mimeType: requestInfo.mimeType ?? null, bodyBytes,
      encodedDataLength: Number.isFinite(params?.encodedDataLength) ? params.encodedDataLength : null,
    });
    await completeCapturePass(session);
  } catch (error) {
    if (!['capturing', 'awaiting-scroll'].includes(session.phase) || requestInfo.attemptEpoch !== session.attemptEpoch) {
      return;
    }
    appendCaptureEvent(session, 'NETWORK_BODY_CAPTURE_FAILED', {
      pass: session.pass,
      requestId,
      message: error instanceof Error ? error.message : String(error),
    });
    await failCaptureSession(session, error, 'get-response-body');
  } finally {
    requestInfo.bodyProcessed = true;
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!tabId) {
    return;
  }

  const session = captureSessions.get(tabId);
  if (!session || !['capturing', 'awaiting-scroll'].includes(session.phase)) {
    return;
  }

  if (method === 'Network.requestWillBeSent') {
    const url = params?.request?.url || '';
    const requestMethod = String(params?.request?.method || '').toUpperCase();
    if (!session.matcher.test(url)) {
      return;
    }
    if (session.requestMethod && requestMethod !== session.requestMethod) {
      return;
    }
    if (session.requestResourceType && String(params?.type || '') !== session.requestResourceType) {
      return;
    }

    session.matchedRequests += 1;
    const requestInfo = {
      requestId: params.requestId,
      url,
      method: requestMethod || null,
      resourceType: String(params?.type || '') || null,
      status: null,
      mimeType: null,
      responseHeaders: null,
      attemptEpoch: session.attemptEpoch,
      handled: false,
      bodyProcessed: false,
    };
    session.pendingRequests.set(params.requestId, requestInfo);
    appendCaptureEvent(session, 'NETWORK_REQUEST_MATCHED', {
      pass: session.pass,
      requestId: params.requestId,
      method: requestInfo.method,
      resourceType: requestInfo.resourceType,
      url,
      postDataPresent: typeof params.request.postData === 'string' && params.request.postData.length > 0,
      postDataBytes: typeof params.request.postData === 'string'
        ? new TextEncoder().encode(params.request.postData).byteLength
        : 0,
    });

    const requestBefore = getRequestBeforeCursor(url);
    if (
      session.paginationMode === 'scroll-up-until-start'
      && requestBefore
      && requestBefore === session.pageState?.startCursor
    ) {
      appendCaptureEvent(session, 'CHATGPT_THREAD_PAGINATION_REQUEST_PENDING', {
        pass: session.pass,
        pageSequence: session.pageState?.pageSequence || null,
        requestId: params.requestId,
        beforeCursor: requestBefore,
      });
    }
    return;
  }

  const requestInfo = session.pendingRequests.get(params?.requestId);
  if (!requestInfo || requestInfo.attemptEpoch !== session.attemptEpoch
      || !['capturing', 'awaiting-scroll'].includes(session.phase)) {
    return;
  }

  if (method === 'Network.responseReceived') {
    requestInfo.status = params.response?.status ?? null;
    requestInfo.mimeType = params.response?.mimeType ?? null;
    requestInfo.responseHeaders = params.response?.headers || null;
    appendCaptureEvent(session, 'NETWORK_RESPONSE_RECEIVED', {
      pass: session.pass,
      requestId: params.requestId,
      status: requestInfo.status,
      mimeType: requestInfo.mimeType,
      url: requestInfo.url,
    });
    if (Number(requestInfo.status) >= 400) {
      // Never parse a service-side HTTP failure (often an HTML challenge) as JSON.
      requestInfo.handled = true;
      requestInfo.bodyProcessed = true;
      void handleCaptureHttpError(session, params.requestId, requestInfo);
    }
    return;
  }

  if (method === 'Network.loadingFailed') {
    requestInfo.bodyProcessed = true;
    appendCaptureEvent(session, 'NETWORK_LOADING_FAILED', {
      pass: session.pass,
      requestId: params.requestId,
      errorText: params.errorText || null,
      canceled: Boolean(params.canceled),
      url: requestInfo.url,
    });
    return;
  }

  if (method === 'Network.loadingFinished') {
    void captureResponseBody(session, params.requestId, requestInfo, params);
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (!tabId) {
    return;
  }

  const session = captureSessions.get(tabId);
  if (!session) {
    return;
  }

  session.attached = false;
  if (session.detaching || session.phase === 'released' || session.phase === 'cancelled' || session.phase === 'error') {
    return;
  }

  void failCaptureSession(
    session,
    new Error(`Debugger отключен: ${reason || 'unknown'}.`),
    'debugger-detached',
  );
});

async function startCaptureSession(tabId, message) {
  const existing = captureSessions.get(tabId);
  if (existing && !['released', 'cancelled', 'error'].includes(existing.phase)) {
    return { ok: true, state: serializeCaptureSession(existing) };
  }

  let matcher;
  try {
    matcher = new RegExp(String(message.urlPattern || ''), 'i');
  } catch {
    return { ok: false, error: 'Некорректный URL pattern сетевого адаптера.' };
  }

  const totalPasses = clampInteger(message.totalPasses, 1, 4, 1);
  const minDelayMs = clampInteger(message.minDelayMs, 100, 60_000, 100);
  const maxDelayMs = clampInteger(message.maxDelayMs, 100, 60_000, 1000);
  const timeoutMs = clampInteger(
    message.timeoutMs,
    10_000,
    180_000,
    DEFAULT_CAPTURE_TIMEOUT_MS,
  );
  const expectedConversationId = typeof message.expectedConversationId === 'string'
    && message.expectedConversationId.trim()
    ? message.expectedConversationId.trim()
    : null;

  let preReloadTailSnapshot = null;
  if (message.preReloadTailSnapshot != null) {
    try {
      preReloadTailSnapshot = sanitizePreReloadTailSnapshot(
        message.preReloadTailSnapshot,
        expectedConversationId,
      );
      await storePreReloadTailSnapshot(tabId, preReloadTailSnapshot);
    } catch (error) {
      return {
        ok: false,
        error: `Не удалось надежно сохранить последний DOM-tail до перезагрузки: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  } else {
    await removePreReloadTailSnapshot(tabId).catch(() => {});
  }

  const session = {
    id: createId('capture'),
    adapterId: String(message.adapterId || 'unknown'),
    tabId,
    matcher,
    urlPattern: String(message.urlPattern || ''),
    requestMethod: typeof message.requestMethod === 'string' && message.requestMethod.trim()
      ? message.requestMethod.trim().toUpperCase()
      : null,
    requestResourceType: typeof message.requestResourceType === 'string' && message.requestResourceType.trim()
      ? message.requestResourceType.trim()
      : null,
    responseProcessor: typeof message.responseProcessor === 'string'
      && Object.prototype.hasOwnProperty.call(CAPTURE_RESPONSE_PROCESSORS, message.responseProcessor)
      ? message.responseProcessor
      : null,
    expectedShareId: typeof message.expectedShareId === 'string' && message.expectedShareId.trim()
      ? message.expectedShareId.trim()
      : null,
    expectedConversationId,
    preReloadTailSnapshot,
    paginationMode: message.paginationMode === 'scroll-up-until-start'
      ? 'scroll-up-until-start'
      : null,
    startedAt: nowMs(),
    phase: 'attaching',
    pass: 0,
    totalPasses,
    minDelayMs,
    maxDelayMs,
    timeoutMs,
    currentPassCaptured: false,
    pagesCapturedInPass: 0,
    pageState: null,
    seenPageStartCursors: new Set(),
    acceptedRequestBeforeCursors: new Set(),
    bufferedPages: new Map(),
    bufferedPageBytes: 0,
    cursorGapStartedAt: null,
    cursorGapTimer: null,
    drainingPages: false,
    generationRestartCount: 0,
    generationGuardWaiting: false,
    completedPasses: 0,
    captureWarning: null,
    skippedExtraPasses: 0,
    currentPassTranscriptIds: new Set(),
    attemptEpoch: 0,
    http403RetryCount: 0,
    http429RetryCount: 0,
    http429Checkpoint: null,
    httpRetryStatus: null,
    httpRetryAt: null,
    matchedRequests: 0,
    captures: [],
    events: [],
    pendingRequests: new Map(),
    timer: null,
    attached: false,
    detaching: false,
    error: null,
    lastReloadCompletedAt: 0,
    lastReloadCompletedPass: 0,
  };
  captureSessions.set(tabId, session);

  appendCaptureEvent(session, 'START', {
    page: typeof message.page === 'string' ? message.page : null,
    title: typeof message.title === 'string' ? message.title : null,
    version: typeof message.version === 'string' ? message.version : null,
  });
  appendCaptureEvent(session, 'SETTINGS', {
    autoSave: Boolean(message.settings?.autoSave),
    saveLog: Boolean(message.settings?.saveLog),
    autoClosePanel: Boolean(message.settings?.autoClosePanel),
    extraPassesEnabled: Boolean(message.settings?.extraPassesEnabled),
    extraPassCount: message.settings?.extraPassCount ?? null,
    generationWaitSeconds: clampInteger(message.settings?.generationWaitSeconds, 30, 3600, 300),
    minDelayMs,
    maxDelayMs,
  });
  appendCaptureEvent(session, 'ADAPTER_SELECTED', {
    id: session.adapterId,
    name: typeof message.adapterName === 'string' ? message.adapterName : session.adapterId,
    score: Number(message.adapterScore) || 0,
    acquisitionMode: 'network',
    variant: typeof message.adapterVariant === 'string' ? message.adapterVariant : null,
  });
  appendCaptureEvent(session, 'CAPTURE_METHOD_SELECTED', {
    method: 'chrome.debugger',
    protocolDomain: 'Network',
    urlPattern: session.urlPattern,
    requestMethod: session.requestMethod,
    requestResourceType: session.requestResourceType,
    responseProcessor: session.responseProcessor,
    expectedShareId: session.expectedShareId,
    expectedConversationId: session.expectedConversationId,
    paginationMode: session.paginationMode,
    passive: true,
    pageExecution: false,
    ownNetworkRequests: false,
    requestInterception: false,
    responseModification: false,
  });
  if (preReloadTailSnapshot) {
    appendCaptureEvent(session, 'CHATGPT_LIMIT_TAIL_CAPTURED', {
      conversationId: preReloadTailSnapshot.conversationId,
      userMessageId: preReloadTailSnapshot.user?.messageId || null,
      userTurnKey: preReloadTailSnapshot.user?.turnKey || null,
      userChars: preReloadTailSnapshot.user?.markdown?.length || 0,
      userHash: preReloadTailSnapshot.user?.hash || null,
      userCaptureMode: preReloadTailSnapshot.user?.captureMode || null,
      assistantChars: preReloadTailSnapshot.assistant?.markdown?.length || 0,
      assistantHash: preReloadTailSnapshot.assistant?.hash || null,
      assistantPrimaryCandidates: preReloadTailSnapshot.assistant?.primaryCandidates || null,
      assistantCaptureMode: preReloadTailSnapshot.assistant?.captureMode || null,
      authoritative: true,
      storage: 'chrome.storage.session',
    });
  }
  appendCaptureEvent(session, 'DEBUGGER_ATTACH_STARTED', {});

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    session.attached = true;
    appendCaptureEvent(session, 'DEBUGGER_ATTACHED', {});

    await chrome.debugger.sendCommand(
      { tabId },
      'Network.enable',
      {
        maxTotalBufferSize: MAX_CAPTURE_BODY_BYTES,
        maxResourceBufferSize: Math.min(MAX_CAPTURE_BODY_BYTES, 50 * 1024 * 1024),
      },
    );
    appendCaptureEvent(session, 'NETWORK_ENABLED', {
      maxTotalBufferSize: MAX_CAPTURE_BODY_BYTES,
      maxResourceBufferSize: Math.min(MAX_CAPTURE_BODY_BYTES, 50 * 1024 * 1024),
    });

    session.phase = 'armed';
    setTimeout(() => {
      void beginCapturePass(session);
    }, 80);

    return { ok: true, state: serializeCaptureSession(session) };
  } catch (error) {
    await failCaptureSession(session, error, 'debugger-attach-or-network-enable');
    return {
      ok: false,
      error: session.error,
      state: serializeCaptureSession(session),
    };
  }
}

async function restartCaptureAfterGeneration(tabId) {
  const session = captureSessions.get(tabId);
  if (!session || session.paginationMode !== 'scroll-up-until-start') {
    return {ok:false, error:'Нет активного ChatGPT Thread захвата.'};
  }
  if (!['capturing', 'awaiting-scroll', 'ready'].includes(session.phase)) {
    return {ok:false, error:'Нельзя перезапустить уже завершенный проход.'};
  }
  if (session.pass > 1 && (session.completedPasses || 0) >= 1) {
    return skipExtraPassAfterGeneration(tabId);
  }
  if (session.generationRestartCount >= CHATGPT_MAX_GENERATION_RESTARTS_PER_PASS) {
    await failCaptureSession(session, new Error(
      'После перезагрузки ChatGPT снова начал генерацию ответа. '
      + 'Автоматический повтор ограничен. Дождитесь устойчивого завершения ответа и начните экспорт заново.',
    ), 'generation-unstable');
    return {ok:false, error:session.error, state:serializeCaptureSession(session)};
  }
  if (session.http429Checkpoint?.length) {
    await failCaptureSession(session, new Error(
      'После восстановления HTTP 429 ChatGPT продолжил генерацию. '
      + 'Ранее сохранённые страницы могли измениться; автоматическое объединение запрещено.',
    ), 'http-429-generation-changed');
    return {ok:false, error:session.error, state:serializeCaptureSession(session)};
  }
  session.generationRestartCount += 1;
  appendCaptureEvent(session, 'CHATGPT_THREAD_GENERATION_RESTART', {
    pass:session.pass, retry:session.generationRestartCount,
    discardedCurrentPassPages:session.pagesCapturedInPass,
  });
  session.captures = session.captures.filter((x) => x.pass !== session.pass);
  // Begin the same pass, not the next pass, without consuming the HTTP403 budget.
  session.attemptEpoch += 1;
  session.phase = 'capturing';
  session.pageState = null;
  session.pagesCapturedInPass = 0;
  session.seenPageStartCursors = new Set();
  session.acceptedRequestBeforeCursors = new Set();
  session.currentPassTranscriptIds = new Set();
  session.bufferedPages.clear();
  session.bufferedPageBytes = 0;
  session.cursorGapStartedAt = null;
  clearCursorGapTimer(session);
  session.pendingRequests.clear();
  appendCaptureEvent(session, 'PAGE_RELOAD_REQUESTED', {
    pass:session.pass, reason:'generation-stabilized-recapture',
  });
  scheduleCaptureTimeout(session);
  try {
    await chrome.debugger.sendCommand({tabId:session.tabId}, 'Page.reload', {ignoreCache:false});
  } catch(error) {
    await failCaptureSession(session,error,'generation-reload');
  }
  return {ok:session.phase!=='error', state:serializeCaptureSession(session)};
}

async function continueCaptureSession(tabId, message) {
  const session = captureSessions.get(tabId);
  if (!session) {
    return { ok: false, error: 'Сессия сетевого захвата не найдена.' };
  }
  if (session.paginationMode !== 'scroll-up-until-start') {
    return { ok: false, error: 'Текущий сетевой адаптер не использует scroll pagination.' };
  }
  if (session.phase !== 'awaiting-scroll') {
    return { ok: true, state: serializeCaptureSession(session) };
  }

  session.phase = 'capturing';
  // Keep in-flight requests: scrolling can trigger a cascade of responses.
  appendCaptureEvent(session, 'CHATGPT_THREAD_SCROLL_ARMED', {
    pass: session.pass,
    pageSequence: session.pageState?.pageSequence || null,
    beforeCursor: session.pageState?.startCursor || null,
    iteration: Number(message.iteration) || null,
  });
  scheduleCaptureTimeout(session);
  await notifyCaptureSession(session);
  return { ok: true, state: serializeCaptureSession(session) };
}

async function appendCaptureScrollStep(tabId, message) {
  const session = captureSessions.get(tabId);
  if (!session || session.paginationMode !== 'scroll-up-until-start') {
    return { ok: true, state: serializeCaptureSession(session) };
  }
  appendCaptureEvent(session, 'SCROLL_UP', {
    phase: 'network-pagination',
    pass: session.pass,
    totalPasses: session.totalPasses,
    pageSequence: session.pageState?.pageSequence || null,
    iteration: Number(message.iteration) || null,
    step: Number(message.step) || null,
    stepPx: Number.isFinite(Number(message.stepPx)) ? Number(message.stepPx) : null,
    from: Number.isFinite(Number(message.from)) ? Math.round(Number(message.from)) : null,
    target: Number.isFinite(Number(message.target)) ? Math.round(Number(message.target)) : null,
    immediate: Number.isFinite(Number(message.immediate)) ? Math.round(Number(message.immediate)) : null,
    strategy: typeof message.strategy === 'string' ? message.strategy : null,
    delayMs: Number.isFinite(Number(message.delayMs)) ? Math.round(Number(message.delayMs)) : null,
    actual: Number.isFinite(Number(message.actual)) ? Math.round(Number(message.actual)) : null,
    delta: Number.isFinite(Number(message.delta)) ? Math.round(Number(message.delta)) : null,
    moved: typeof message.moved === 'boolean' ? message.moved : null,
    scrollHeight: Number.isFinite(Number(message.scrollHeight)) ? Math.round(Number(message.scrollHeight)) : null,
    clientHeight: Number.isFinite(Number(message.clientHeight)) ? Math.round(Number(message.clientHeight)) : null,
  });
  return { ok: true, state: serializeCaptureSession(session) };
}

async function cancelCaptureSession(tabId) {
  const session = captureSessions.get(tabId);
  if (!session) {
    return { ok: true, state: null };
  }

  clearCaptureTimer(session);
  clearCursorGapTimer(session);
  const alreadyFailed = session.phase === 'error';
  session.phase = alreadyFailed ? 'error' : 'cancelled';
  if (!alreadyFailed) appendCaptureEvent(session, 'CANCEL_REQUESTED', {
    pass: session.pass,
    captures: session.captures.length,
  });
  const wasAttached = session.attached;
  await detachCaptureDebugger(session);
  if (wasAttached && !alreadyFailed) appendCaptureEvent(session, 'DEBUGGER_DETACHED', { reason: 'cancelled' });
  const state = serializeCaptureSession(session, { includeCaptures: false });
  captureSessions.delete(tabId);
  await removePreReloadTailSnapshot(tabId).catch(() => {});
  return { ok: true, state };
}

async function releaseCaptureSession(tabId) {
  const session = captureSessions.get(tabId);
  if (!session) {
    return { ok: true };
  }

  clearCaptureTimer(session);
  session.phase = 'released';
  const wasAttached = session.attached;
  await detachCaptureDebugger(session);
  if (wasAttached) appendCaptureEvent(session, 'DEBUGGER_DETACHED', { reason: 'completed' });
  const state = serializeCaptureSession(session, { includeCaptures: false });
  captureSessions.delete(tabId);
  await removePreReloadTailSnapshot(tabId).catch(() => {});
  return { ok: true, state };
}

function localCacheSyncStorageKey(tabId) {
  return `${LOCAL_CACHE_SYNC_STORAGE_PREFIX}${tabId}`;
}

async function getLocalCacheSyncSession(tabId) {
  const key = localCacheSyncStorageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  const session = stored?.[key];
  if (!session || typeof session !== 'object') {
    return null;
  }

  const startedAt = Number(session.startedAt) || 0;
  if (!startedAt || nowMs() - startedAt > LOCAL_CACHE_SYNC_TTL_MS) {
    await chrome.storage.session.remove(key).catch(() => {});
    return null;
  }

  return session;
}

async function setLocalCacheSyncSession(tabId, session) {
  const key = localCacheSyncStorageKey(tabId);
  await chrome.storage.session.set({ [key]: session });
}

async function removeLocalCacheSyncSession(tabId) {
  await chrome.storage.session.remove(localCacheSyncStorageKey(tabId));
}

async function startLocalCacheSyncSession(tabId, message) {
  const existing = await getLocalCacheSyncSession(tabId);
  if (existing) {
    return { ok: true, state: existing };
  }

  const startedAt = nowMs();
  const state = {
    id: createId('local-cache-sync'),
    tabId,
    adapterId: typeof message.adapterId === 'string' ? message.adapterId : null,
    sessionId: typeof message.sessionId === 'string' ? message.sessionId : null,
    page: typeof message.page === 'string' ? message.page : null,
    title: typeof message.title === 'string' ? message.title : null,
    version: typeof message.version === 'string' ? message.version : null,
    phase: 'reloading',
    startedAt,
    reloadRequestedAt: startedAt,
    reloadCompletedAt: null,
  };

  await setLocalCacheSyncSession(tabId, state);
  setTimeout(() => {
    void chrome.tabs.reload(tabId, { bypassCache: false }).catch(async (error) => {
      const failedState = {
        ...state,
        phase: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
      await setLocalCacheSyncSession(tabId, failedState).catch(() => {});
      await injectRuntime(tabId).catch(() => {});
    });
  }, 80);

  return { ok: true, state };
}

async function handleLocalCacheSyncMessage(message, sender) {
  const tabId = sender.tab?.id;
  if (!tabId) {
    return { ok: false, error: 'Не удалось определить вкладку локальной синхронизации.' };
  }

  if (message.type === LOCAL_CACHE_SYNC_START_MESSAGE) {
    return startLocalCacheSyncSession(tabId, message);
  }

  if (message.type === LOCAL_CACHE_SYNC_GET_STATE_MESSAGE) {
    return { ok: true, state: await getLocalCacheSyncSession(tabId) };
  }

  if (message.type === LOCAL_CACHE_SYNC_RELEASE_MESSAGE) {
    const state = await getLocalCacheSyncSession(tabId);
    await removeLocalCacheSyncSession(tabId).catch(() => {});
    return { ok: true, state };
  }

  return { ok: false, error: 'Неизвестная команда локальной синхронизации.' };
}

async function updateGenerationGuardWait(tabId, waiting) {
  const session = captureSessions.get(tabId);
  if (!session) return {ok:false, error:'Сессия захвата не найдена.'};
  if (session.responseProcessor !== 'chatgpt-thread-json') {
    return {ok:false, error:'Ожидание генерации доступно только для ChatGPT Thread.'};
  }
  if (!['capturing', 'awaiting-scroll'].includes(session.phase)) {
    return {ok:true, state:serializeCaptureSession(session)};
  }
  if (waiting === true && !session.generationGuardWaiting) {
    session.generationGuardWaiting = true;
    clearCaptureTimer(session);
    appendCaptureEvent(session, 'CHATGPT_GENERATION_NETWORK_TIMEOUT_PAUSED', {pass:session.pass});
  } else if (waiting === false && session.generationGuardWaiting) {
    session.generationGuardWaiting = false;
    if (session.phase === 'capturing') scheduleCaptureTimeout(session);
    appendCaptureEvent(session, 'CHATGPT_GENERATION_NETWORK_TIMEOUT_RESUMED', {pass:session.pass});
  }
  return {ok:true, state:serializeCaptureSession(session)};
}

async function handleCaptureMessage(message, sender) {
  const tabId = sender.tab?.id;
  if (!tabId) {
    return { ok: false, error: 'Не удалось определить вкладку захвата.' };
  }

  if (message.type === CAPTURE_START_MESSAGE) {
    return startCaptureSession(tabId, message);
  }

  if (message.type === CAPTURE_GET_STATE_MESSAGE) {
    const session = captureSessions.get(tabId);
    return {
      ok: true,
      state: serializeCaptureSession(session, {
        includeCaptures: message.includeCaptures === true && message.summaryOnly !== true,
        includeEvents: message.summaryOnly !== true,
      }),
    };
  }

  if (message.type === CAPTURE_CONTINUE_MESSAGE) {
    return continueCaptureSession(tabId, message);
  }

  if (message.type === CAPTURE_GENERATION_RESTART_MESSAGE) {
    return restartCaptureAfterGeneration(tabId);
  }
  if (message.type === CAPTURE_GENERATION_WAIT_MESSAGE) {
    return updateGenerationGuardWait(tabId, message.waiting === true);
  }
  if (message.type === CAPTURE_SKIP_EXTRA_PASS_MESSAGE) {
    return skipExtraPassAfterGeneration(tabId);
  }
  if (message.type === CAPTURE_SCROLL_STEP_MESSAGE) {
    return appendCaptureScrollStep(tabId, message);
  }

  if (message.type === CAPTURE_CANCEL_MESSAGE) {
    return cancelCaptureSession(tabId);
  }

  if (message.type === CAPTURE_RELEASE_MESSAGE) {
    return releaseCaptureSession(tabId);
  }

  return { ok: false, error: 'Неизвестная команда сетевого захвата.' };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') {
    return false;
  }

  if (message.type === SAVE_FILE_MESSAGE) {
    pruneSaveRequests();
    const requestId = typeof message.requestId === 'string' && message.requestId
      ? message.requestId
      : null;

    let operation = requestId ? saveRequests.get(requestId)?.promise : null;
    if (!operation) {
      operation = createSaveOperation(message).then((response) => {
        if (requestId && !response?.ok) {
          saveRequests.delete(requestId);
        }
        return response;
      });
      if (requestId) {
        saveRequests.set(requestId, {
          createdAt: Date.now(),
          promise: operation,
        });
      }
    }

    operation
      .then((response) => sendResponse(response))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }


  if (
    message.type === LOCAL_CACHE_SYNC_START_MESSAGE
    || message.type === LOCAL_CACHE_SYNC_GET_STATE_MESSAGE
    || message.type === LOCAL_CACHE_SYNC_RELEASE_MESSAGE
  ) {
    handleLocalCacheSyncMessage(message, sender)
      .then((response) => sendResponse(response))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }


  if (
    message.type === CAPTURE_START_MESSAGE
    || message.type === CAPTURE_GET_STATE_MESSAGE
    || message.type === CAPTURE_CONTINUE_MESSAGE
    || message.type === CAPTURE_GENERATION_RESTART_MESSAGE
    || message.type === CAPTURE_SKIP_EXTRA_PASS_MESSAGE
    || message.type === CAPTURE_GENERATION_WAIT_MESSAGE
    || message.type === CAPTURE_SCROLL_STEP_MESSAGE
    || message.type === CAPTURE_CANCEL_MESSAGE
    || message.type === CAPTURE_RELEASE_MESSAGE
  ) {
    handleCaptureMessage(message, sender)
      .then((response) => sendResponse(response))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    loadingTabs.add(tabId);
    scheduleEarlyPanelForLoading(tabId);
    return;
  }
  if (changeInfo.status !== 'complete') {
    return;
  }
  loadingTabs.delete(tabId);

  const session = captureSessions.get(tabId);
  if (session && !['released', 'cancelled'].includes(session.phase)) {
    const completedAt = nowMs();
    const duplicateCompletion = session.lastReloadCompletedPass === session.pass
      && completedAt - session.lastReloadCompletedAt < 500;

    if (!duplicateCompletion) {
      session.lastReloadCompletedPass = session.pass;
      session.lastReloadCompletedAt = completedAt;
      appendCaptureEvent(session, 'PAGE_RELOAD_COMPLETED', {
        pass: session.pass,
        totalPasses: session.totalPasses,
        phase: session.phase,
      });
    }
    void injectRuntime(tabId).catch(() => {});
    return;
  }

  void (async () => {
    const localCacheSession = await getLocalCacheSyncSession(tabId);
    if (!localCacheSession || localCacheSession.phase !== 'reloading') {
      return;
    }

    const readyState = {
      ...localCacheSession,
      phase: 'ready',
      reloadCompletedAt: nowMs(),
    };
    await setLocalCacheSyncSession(tabId, readyState);
    await injectRuntime(tabId).catch(() => {});
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  loadingTabs.delete(tabId);
  void removeLocalCacheSyncSession(tabId).catch(() => {});
  void removePreReloadTailSnapshot(tabId).catch(() => {});

  const session = captureSessions.get(tabId);
  if (!session) {
    return;
  }
  clearCaptureTimer(session);
  session.phase = 'released';
  void detachCaptureDebugger(session).finally(() => {
    captureSessions.delete(tabId);
  });
});
