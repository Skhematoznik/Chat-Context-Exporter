(() => {
  'use strict';
  // In-page floating indicator, deliberately independent of the regular runtime.
  // Executed as soon as Chrome allows isolated-world injection during reload.
  const PANEL_ID = 'chat-context-exporter-ui';
  const EARLY_KEY = '__chatContextExporterEarlyPanel';
  const RUNTIME_KEY = '__chatContextExporterRuntime';
  const STATE_MESSAGE = 'chat-context-exporter:capture:get-state';
  const POLL_MS = 1000;
  const g = globalThis;
  const validHost = /^(?:chatgpt\.com|chat\.openai\.com|claude\.ai|grok\.com|x\.com)$/i.test(location.hostname);
  if (!validHost || g[RUNTIME_KEY]?.running) return;
  const active = g[EARLY_KEY];
  if (active && active.host?.isConnected) return;
  active?.cleanup?.();

  let disposed = false;
  let tickId = null;
  let retryObserver = null;
  let startedAt = Date.now();
  let lastState = null;
  let host = null;
  let ui = null;
  const cleanup = () => {
    disposed = true;
    if (tickId !== null) clearInterval(tickId);
    retryObserver?.disconnect();
    if (g[EARLY_KEY]?.cleanup === cleanup) delete g[EARLY_KEY];
  };
  g[EARLY_KEY] = { host: null, cleanup };

  function clock(ms) {
    const secs = Math.max(0, Math.floor(ms / 1000));
    return [Math.floor(secs / 3600), Math.floor(secs / 60) % 60, secs % 60]
      .map((number) => String(number).padStart(2, '0')).join(':');
  }

  function statusFor(state) {
    if (!state) return 'Загружаю страницу и восстанавливаю статус экспорта...';
    if (state.phase === 'waiting-http-retry') {
      if (state.httpRetryStatus === 429) {
        const remaining = Math.max(0, Math.ceil(((state.httpRetryAt || Date.now()) - Date.now()) / 1000));
        return `HTTP 429: ожидание ${remaining} с. Собранные страницы сохранены.`;
      }
      if (state.httpRetryStatus === 500) {
        const remaining = Math.max(0, Math.ceil(((state.httpRetryAt || Date.now()) - Date.now()) / 1000));
        return `HTTP 500: повтор через ${remaining} с. Собранные страницы сохранены.`;
      }
      return 'HTTP 403: ожидаю повторной загрузки страницы...';
    }
    if (state.phase === 'waiting-next-pass') return 'Подготовка дополнительного прохода...';
    if (state.phase === 'ready') return 'Сбор завершён. Проверяю данные...';
    if (state.phase === 'error') return `Ошибка: ${state.error || 'захват остановлен'}`;
    if (state.phase === 'cancelled' || state.phase === 'released') return 'Экспорт остановлен.';
    if (state.generationGuardWaiting) return 'Ожидаю завершения ответа ChatGPT...';
    if (state.phase === 'awaiting-scroll') return 'Сбор истории: переход к предыдущей странице...';
    if (state.phase === 'capturing' && state.pageState?.pageSequence) return 'Сбор истории продолжается...';
    return 'Страница загружается. Экспорт работает...';
  }

  function show(state) {
    if (!ui || disposed || g[RUNTIME_KEY]?.running) return;
    if (state) {
      lastState = state;
      if (Number.isFinite(Number(state.startedAt))) startedAt = Number(state.startedAt);
    }
    ui.timer.textContent = clock(Date.now() - startedAt);
    ui.status.textContent = statusFor(lastState);
    if (lastState) {
      ui.pass.textContent = `${Math.max(1, lastState.pass || 1)} / ${Math.max(1, lastState.totalPasses || 1)}`;
      ui.pages.textContent = String(lastState.pageState?.pageSequence || lastState.capturesCompleted || 0);
      ui.messages.textContent = String(lastState.pageState?.transcriptMessagesInPass || 0);
    }
  }

  async function refresh() {
    if (disposed || g[RUNTIME_KEY]?.running || !host?.isConnected) {
      cleanup();
      return;
    }
    try {
      const response = await chrome.runtime.sendMessage({type: STATE_MESSAGE, summaryOnly: true});
      if (disposed || g[RUNTIME_KEY]?.running || !host?.isConnected) return;
      if (response?.ok && response.state) {
        // Never display a session from a different conversation in this tab.
        const expected = response.state.expectedConversationId;
        if (expected && !location.pathname.includes(expected)) { cleanup(); host.remove(); return; }
        show(response.state);
      } else {
        cleanup(); host.remove();
      }
    } catch {
      // A temporarily sleeping MV3 worker must not hide the activity indicator.
      show(null);
    }
  }

  function mount() {
    if (disposed || g[RUNTIME_KEY]?.running) { cleanup(); return; }
    if (!document.documentElement) return;
    if (document.getElementById(PANEL_ID)) { cleanup(); return; }
    host = document.createElement('div');
    host.id = PANEL_ID;
    host.dataset.chatContextExporterEarly = 'true';
    Object.assign(host.style, {
      position: 'fixed', top: '16px', left: '16px', zIndex: '2147483647',
      width: '320px', maxWidth: 'calc(100vw - 32px)', pointerEvents: 'auto',
      fontFamily: 'Arial, Helvetica, sans-serif',
    });
    const root = host.attachShadow({mode: 'closed'});
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * {box-sizing:border-box;}
        .panel {
          width: 100%;
          border: 1px solid rgba(255, 255, 255, 0.18);
          border-radius: 12px;
          background: rgba(24, 24, 28, 0.96);
          color: #fff;
          box-shadow: 0 12px 36px rgba(0, 0, 0, 0.34);
          overflow: hidden;
          backdrop-filter: blur(10px);
        }
        .header {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 12px;
          background: #202228;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }
        .icon { width: 28px; height: 28px; flex: 0 0 auto; display: block; }
        .title { flex: 1 1 auto; min-width: 0; font-size: 14px; font-weight: 700; line-height: 1.2; }
        .body { padding: 12px; font: 13px/1.45 Arial, sans-serif; }
        .timer { font-weight: 700; font-variant-numeric: tabular-nums; margin-bottom: 8px; }
        .status { margin: 0 0 10px; }
        .meta { color: #cfcfd5; font-size: 12px; }
        .meta span { color: #fff; }
        .progress {
          height: 4px;
          margin-top: 12px;
          border-radius: 4px;
          background: rgba(255, 255, 255, 0.12);
          overflow: hidden;
        }
        .progress div {
          width: 35%;
          height: 100%;
          background: #aeb4bf;
          animation: travel 1.2s ease-in-out infinite alternate;
        }
        @keyframes travel {from{transform:translateX(-90%)}to{transform:translateX(280%)}}
      </style>
      <section class="panel" role="status" aria-live="polite">
        <header class="header">
          <svg class="icon" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
            <path fill="#fff" d="M11 8h42a7 7 0 0 1 7 7v28a7 7 0 0 1-7 7H29L16 59v-9h-5a7 7 0 0 1-7-7V15a7 7 0 0 1 7-7Z"/>
            <rect x="15" y="20" width="34" height="22" rx="10" fill="#d6008f"/>
            <rect x="21" y="26" width="5" height="9" rx="2.5" fill="#fff"/>
            <rect x="38" y="26" width="5" height="9" rx="2.5" fill="#fff"/>
            <rect x="29" y="13" width="6" height="8" rx="3" fill="#d6008f"/>
            <circle cx="32" cy="11" r="4" fill="#d6008f"/>
          </svg>
          <div class="title">Chat Context Exporter</div>
        </header>
        <div class="body">
          <div class="timer">Время: <span class="elapsed">00:00:00</span></div>
          <p class="status">Страница загружается. Экспорт работает...</p>
          <div class="meta">Проход: <span class="pass">1 / 1</span>
            · Страниц: <span class="pages">0</span>
            · Сообщений: <span class="messages">0</span></div>
          <div class="progress"><div></div></div>
        </div>
      </section>`;
    document.documentElement.appendChild(host);
    ui = {
      timer: root.querySelector('.elapsed'), status: root.querySelector('.status'),
      pass: root.querySelector('.pass'), pages: root.querySelector('.pages'),
      messages: root.querySelector('.messages'),
    };
    g[EARLY_KEY].host = host;
    show(null);
    void refresh();
    tickId = setInterval(() => { show(null); void refresh(); }, POLL_MS);
  }

  if (document.documentElement) {
    mount();
  } else {
    retryObserver = new MutationObserver(() => {
      if (document.documentElement) { retryObserver.disconnect(); mount(); }
    });
    retryObserver.observe(document, {childList: true});
  }
})();
