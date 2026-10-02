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
const MAX_CAPTURE_BODY_BYTES = 100 * 1024 * 1024;
const LOCAL_CACHE_SYNC_TTL_MS = 2 * 60 * 1000;
const LOCAL_CACHE_SYNC_STORAGE_PREFIX = 'chat-context-exporter:local-cache-sync:';
const saveRequests = new Map();
const captureSessions = new Map();
function nowMs() {
  return Date.now();
}

function createId(prefix) {
  const random = crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}:${random}`;
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
    if (getRequestBeforeCursor(requestInfo.url) !== expectedBefore) {
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

function serializeCaptureSession(session, { includeCaptures = false } = {}) {
  if (!session) {
    return null;
  }

  return {
    id: session.id,
    adapterId: session.adapterId,
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
    error: session.error || null,
    events: session.events.map((entry) => ({ ...entry })),
    captures: includeCaptures
      ? session.captures.map((capture) => ({ ...capture }))
      : undefined,
  };
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

  try {
    await injectRuntime(session.tabId);
    await chrome.tabs.sendMessage(session.tabId, message).catch(() => {});
  } catch {
    // tabs.onUpdated повторит инъекцию после завершения навигации.
  }
}

async function failCaptureSession(session, error, stage) {
  if (!session || session.phase === 'released' || session.phase === 'cancelled') {
    return;
  }

  clearCaptureTimer(session);
  session.phase = 'error';
  session.error = error instanceof Error ? error.message : String(error);
  appendCaptureEvent(session, 'CAPTURE_ERROR', {
    stage,
    pass: session.pass,
    message: session.error,
  });
  await detachCaptureDebugger(session);
  appendCaptureEvent(session, 'DEBUGGER_DETACHED', { reason: 'error' });
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

async function beginCapturePass(session) {
  if (!session || session.phase === 'cancelled' || session.phase === 'released' || session.phase === 'error') {
    return;
  }

  session.pass += 1;
  session.phase = 'capturing';
  session.error = null;
  session.currentPassCaptured = false;
  session.pagesCapturedInPass = 0;
  session.pageState = null;
  session.seenPageStartCursors = new Set();
  session.currentPassTranscriptIds = new Set();
  session.pendingRequests.clear();
  appendCaptureEvent(session, 'PASS_STARTED', {
    pass: session.pass,
    totalPasses: session.totalPasses,
    extraPass: session.pass > 1,
    capturesBefore: session.captures.length,
  });
  appendCaptureEvent(session, 'PAGE_RELOAD_REQUESTED', {
    pass: session.pass,
    totalPasses: session.totalPasses,
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
  clearCaptureTimer(session);
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

async function captureResponseBody(session, requestId, requestInfo, params) {
  const paginated = session?.paginationMode === 'scroll-up-until-start';
  if (!session || (!paginated && session.currentPassCaptured) || requestInfo.handled) {
    return;
  }

  requestInfo.handled = true;

  try {
    const result = await chrome.debugger.sendCommand(
      { tabId: session.tabId },
      'Network.getResponseBody',
      { requestId },
    );

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

    let pageSequence = null;
    if (paginated) {
      pageSequence = session.pagesCapturedInPass + 1;
      const pageInfo = processed?.pageInfo;
      if (!pageInfo) {
        throw new Error('Paginated capture processor не вернул pageInfo.');
      }
      if (pageSequence === 1) {
        if (requestBefore) {
          appendCaptureEvent(session, 'CHATGPT_THREAD_RESPONSE_SKIPPED', {
            pass: session.pass,
            requestId,
            reason: 'before-cursor-before-tail',
            requestBefore,
          });
          return;
        }
        if (pageInfo.hasNextPage !== false) {
          appendCaptureEvent(session, 'CHATGPT_THREAD_RESPONSE_SKIPPED', {
            pass: session.pass,
            requestId,
            reason: 'initial-response-not-tail',
            startCursor: pageInfo.startCursor || null,
            endCursor: pageInfo.endCursor || null,
          });
          return;
        }
      } else {
        const expectedBefore = session.pageState?.startCursor || null;
        if (!expectedBefore || requestBefore !== expectedBefore) {
          appendCaptureEvent(session, 'CHATGPT_THREAD_RESPONSE_SKIPPED', {
            pass: session.pass,
            requestId,
            reason: 'cursor-chain-mismatch',
            requestBefore,
            expectedBefore,
          });
          return;
        }
      }
      if (pageInfo.startCursor && session.seenPageStartCursors.has(pageInfo.startCursor)) {
        appendCaptureEvent(session, 'CHATGPT_THREAD_RESPONSE_SKIPPED', {
          pass: session.pass,
          requestId,
          reason: 'duplicate-start-cursor',
          startCursor: pageInfo.startCursor,
        });
        return;
      }
      if (pageInfo.startCursor) {
        session.seenPageStartCursors.add(pageInfo.startCursor);
      }
      session.pagesCapturedInPass = pageSequence;
      for (const message of processed.messages || []) {
        if (typeof message?.id === 'string' && message.id) {
          session.currentPassTranscriptIds.add(message.id);
        }
      }
    } else {
      session.currentPassCaptured = true;
    }

    session.captures.push({
      pass: session.pass,
      pageSequence,
      requestId,
      requestBefore,
      url: requestInfo.url,
      method: requestInfo.method,
      resourceType: requestInfo.resourceType || null,
      status: requestInfo.status ?? null,
      mimeType: requestInfo.mimeType ?? null,
      bodyBytes,
      encodedDataLength: Number.isFinite(params?.encodedDataLength)
        ? params.encodedDataLength
        : null,
      ...(processed ? { processed } : { body }),
    });

    appendCaptureEvent(session, 'NETWORK_BODY_CAPTURED', {
      pass: session.pass,
      totalPasses: session.totalPasses,
      pageSequence,
      requestId,
      url: requestInfo.url,
      method: requestInfo.method,
      resourceType: requestInfo.resourceType || null,
      status: requestInfo.status ?? null,
      mimeType: requestInfo.mimeType ?? null,
      bodyBytes,
      encodedDataLength: Number.isFinite(params?.encodedDataLength)
        ? params.encodedDataLength
        : null,
    });

    if (paginated) {
      const pageInfo = processed.pageInfo;
      if (requestBefore) {
        appendCaptureEvent(session, 'CHATGPT_THREAD_PAGINATION_REQUEST_RESOLVED', {
          pass: session.pass,
          pageSequence,
          requestId,
          beforeCursor: requestBefore,
        });
      }
      session.pageState = {
        pageSequence,
        startCursor: pageInfo.startCursor || null,
        endCursor: pageInfo.endCursor || null,
        hasPreviousPage: pageInfo.hasPreviousPage === true,
        hasNextPage: pageInfo.hasNextPage === true,
        transcriptMessagesInPage: processed?.stats?.total ?? 0,
        transcriptMessagesInPass: session.currentPassTranscriptIds.size,
        rawMessagesInPage: processed?.rawMessages ?? 0,
      };

      if (pageInfo.hasPreviousPage === false) {
        appendCaptureEvent(session, 'CHATGPT_THREAD_START_REACHED', {
          pass: session.pass,
          pageSequence,
          startCursor: pageInfo.startCursor || null,
          pagesCaptured: session.pagesCapturedInPass,
          transcriptMessages: session.currentPassTranscriptIds.size,
        });
        await completeCapturePass(session);
      } else {
        clearCaptureTimer(session);
        session.phase = 'awaiting-scroll';
        appendCaptureEvent(session, 'CHATGPT_THREAD_PAGE_READY_FOR_SCROLL', {
          pass: session.pass,
          pageSequence,
          startCursor: pageInfo.startCursor || null,
          transcriptMessages: session.currentPassTranscriptIds.size,
        });
        await notifyCaptureSession(session);
      }
    } else {
      await completeCapturePass(session);
    }
  } catch (error) {
    appendCaptureEvent(session, 'NETWORK_BODY_CAPTURE_FAILED', {
      pass: session.pass,
      requestId,
      message: error instanceof Error ? error.message : String(error),
    });
    await failCaptureSession(session, error, 'get-response-body');
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!tabId) {
    return;
  }

  const session = captureSessions.get(tabId);
  if (!session || session.phase !== 'capturing') {
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
      handled: false,
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
  if (!requestInfo) {
    return;
  }

  if (method === 'Network.responseReceived') {
    requestInfo.status = params.response?.status ?? null;
    requestInfo.mimeType = params.response?.mimeType ?? null;
    appendCaptureEvent(session, 'NETWORK_RESPONSE_RECEIVED', {
      pass: session.pass,
      requestId: params.requestId,
      status: requestInfo.status,
      mimeType: requestInfo.mimeType,
      url: requestInfo.url,
    });
    return;
  }

  if (method === 'Network.loadingFailed') {
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
    expectedConversationId: typeof message.expectedConversationId === 'string' && message.expectedConversationId.trim()
      ? message.expectedConversationId.trim()
      : null,
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
    currentPassTranscriptIds: new Set(),
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
  session.pendingRequests.clear();
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
  session.phase = 'cancelled';
  appendCaptureEvent(session, 'CANCEL_REQUESTED', {
    pass: session.pass,
    captures: session.captures.length,
  });
  await detachCaptureDebugger(session);
  appendCaptureEvent(session, 'DEBUGGER_DETACHED', { reason: 'cancelled' });
  const state = serializeCaptureSession(session, { includeCaptures: false });
  captureSessions.delete(tabId);
  return { ok: true, state };
}

async function releaseCaptureSession(tabId) {
  const session = captureSessions.get(tabId);
  if (!session) {
    return { ok: true };
  }

  clearCaptureTimer(session);
  session.phase = 'released';
  await detachCaptureDebugger(session);
  appendCaptureEvent(session, 'DEBUGGER_DETACHED', { reason: 'completed' });
  const state = serializeCaptureSession(session, { includeCaptures: false });
  captureSessions.delete(tabId);
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
      state: serializeCaptureSession(session, { includeCaptures: message.includeCaptures === true }),
    };
  }

  if (message.type === CAPTURE_CONTINUE_MESSAGE) {
    return continueCaptureSession(tabId, message);
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
  if (changeInfo.status !== 'complete') {
    return;
  }

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
  void removeLocalCacheSyncSession(tabId).catch(() => {});

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
