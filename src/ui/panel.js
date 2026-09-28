(() => {
  'use strict';

  const app = globalThis.__chatContextExporter;
  const loggerModule = app?.modules.logger;

  if (!app || !loggerModule) {
    throw new Error('Chat Context Exporter: panel dependencies are not initialized.');
  }

  const HOST_ID = 'chat-context-exporter-ui';

  function enableDragging(host, handle) {
    let pointerId = null;
    let offsetX = 0;
    let offsetY = 0;

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest?.('button')) {
        return;
      }

      const rect = host.getBoundingClientRect();
      pointerId = event.pointerId;
      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;
      handle.setPointerCapture(pointerId);
      handle.classList.add('dragging');
      event.preventDefault();
    });

    handle.addEventListener('pointermove', (event) => {
      if (event.pointerId !== pointerId) {
        return;
      }

      const maxLeft = Math.max(0, window.innerWidth - host.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - host.offsetHeight);
      const nextLeft = Math.min(maxLeft, Math.max(0, event.clientX - offsetX));
      const nextTop = Math.min(maxTop, Math.max(0, event.clientY - offsetY));

      host.style.left = `${Math.round(nextLeft)}px`;
      host.style.top = `${Math.round(nextTop)}px`;
      host.style.right = 'auto';
      host.style.bottom = 'auto';
    });

    const stopDragging = (event) => {
      if (event.pointerId !== pointerId) {
        return;
      }

      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        // Pointer capture может быть уже снят браузером.
      }

      pointerId = null;
      handle.classList.remove('dragging');
    };

    handle.addEventListener('pointerup', stopDragging);
    handle.addEventListener('pointercancel', stopDragging);
  }

  function createPanel({ startedAt, onStop }) {
    const existing = document.getElementById(HOST_ID);
    existing?.remove();

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.dataset.chatContextExporterUi = 'true';

    Object.assign(host.style, {
      position: 'fixed',
      top: '16px',
      left: '16px',
      zIndex: '2147483647',
      width: '320px',
      maxWidth: 'calc(100vw - 32px)',
      fontFamily: 'Arial, Helvetica, sans-serif',
      pointerEvents: 'auto',
    });

    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
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
          cursor: grab;
          user-select: none;
          touch-action: none;
        }
        .header.dragging { cursor: grabbing; }
        .icon { width: 28px; height: 28px; flex: 0 0 auto; display: block; }
        .title { flex: 1 1 auto; min-width: 0; font-size: 14px; font-weight: 700; line-height: 1.2; }
        .close {
          appearance: none;
          border: 0;
          width: 28px;
          height: 28px;
          border-radius: 7px;
          background: rgba(255, 255, 255, 0.06);
          color: #fff;
          font-size: 20px;
          line-height: 1;
          cursor: pointer;
        }
        .close:hover { background: rgba(255, 255, 255, 0.12); }
        .body { padding: 12px; }
        .timer {
          margin: 0 0 8px;
          font-variant-numeric: tabular-nums;
          font-size: 13px;
          font-weight: 700;
        }
        .status { margin: 0 0 10px; font-size: 13px; line-height: 1.45; }
        .meta {
          display: grid;
          grid-template-columns: auto 1fr;
          gap: 5px 10px;
          font-size: 12px;
          color: #cfcfd5;
        }
        .meta-row { display: contents; }
        .meta-row[hidden] { display: none; }
        .value { color: #fff; overflow-wrap: anywhere; }
        .actions {
          display: flex;
          gap: 8px;
          margin-top: 12px;
        }
        .actions[hidden] { display: none; }
        .action-button {
          appearance: none;
          border: 1px solid rgba(255, 255, 255, 0.18);
          border-radius: 8px;
          padding: 7px 11px;
          background: rgba(255, 255, 255, 0.08);
          color: #fff;
          font: inherit;
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
        }
        .action-button:hover { background: rgba(255, 255, 255, 0.14); }
        .action-button.primary {
          border-color: transparent;
          background: #343840;
        }
        .action-button.primary:hover { background: #434852; }
        .action-button:disabled { opacity: 0.55; cursor: default; }
        .progress {
          height: 4px;
          margin-top: 12px;
          border-radius: 4px;
          overflow: hidden;
          background: rgba(255, 255, 255, 0.12);
        }
        .progress > div {
          width: 35%;
          height: 100%;
          background: #aeb4bf;
          animation: travel 1.2s ease-in-out infinite alternate;
        }
        .progress.done > div { width: 100%; animation: none; }
        .progress.error > div { width: 100%; animation: none; background: #ff5b6e; }
        @keyframes travel { from { transform: translateX(-90%); } to { transform: translateX(280%); } }
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
          <button class="close" type="button" title="Остановить">×</button>
        </header>
        <div class="body">
          <div class="timer">Время: <span class="elapsed">00:00:00</span></div>
          <p class="status">Подготовка...</p>
          <div class="meta">
            <div class="meta-row" data-meta-field="assistant"><span>Чат:</span><span class="value assistant">определение</span></div>
            <div class="meta-row" data-meta-field="method"><span>Метод:</span><span class="value method">определение</span></div>
            <div class="meta-row" data-meta-field="messages"><span>Сообщений:</span><span class="value messages">0</span></div>
            <div class="meta-row" data-meta-field="pass"><span>Проход:</span><span class="value pass">1 / 1</span></div>
            <div class="meta-row" data-meta-field="iteration"><span>Шаг:</span><span class="value iteration">0</span></div>
            <div class="meta-row" data-meta-field="position"><span>Позиция:</span><span class="value position">—</span></div>
          </div>
          <div class="actions" hidden>
            <button class="action-button primary save" type="button">Сохранить</button>
            <button class="action-button cancel" type="button">Закрыть</button>
          </div>
          <div class="progress"><div></div></div>
        </div>
      </section>
    `;

    document.documentElement.appendChild(host);

    const header = shadow.querySelector('.header');
    const closeButton = shadow.querySelector('.close');
    const elapsed = shadow.querySelector('.elapsed');
    const status = shadow.querySelector('.status');
    const assistant = shadow.querySelector('.assistant');
    const method = shadow.querySelector('.method');
    const messages = shadow.querySelector('.messages');
    const pass = shadow.querySelector('.pass');
    const iteration = shadow.querySelector('.iteration');
    const position = shadow.querySelector('.position');
    const metaRows = new Map(
      [...shadow.querySelectorAll('[data-meta-field]')].map((row) => [row.dataset.metaField, row]),
    );
    const progress = shadow.querySelector('.progress');
    const actions = shadow.querySelector('.actions');
    const saveButton = shadow.querySelector('.save');
    const cancelButton = shadow.querySelector('.cancel');

    let timerId = null;
    let stoppedAt = null;
    let onSaveAction = null;
    let onCancelAction = null;

    const updateTimer = () => {
      const end = stoppedAt ?? Date.now();
      elapsed.textContent = loggerModule.formatDuration(end - startedAt);
    };

    updateTimer();
    timerId = window.setInterval(updateTimer, 250);

    closeButton.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
    });

    closeButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onStop?.();
    });

    saveButton.addEventListener('click', () => onSaveAction?.());
    cancelButton.addEventListener('click', () => onCancelAction?.());

    enableDragging(host, header);

    function stopTimer() {
      if (stoppedAt === null) {
        stoppedAt = Date.now();
      }
      if (timerId !== null) {
        window.clearInterval(timerId);
        timerId = null;
      }
      updateTimer();
    }

    return {
      host,
      bringToFront() {
        host.style.zIndex = '2147483647';
        host.animate(
          [
            { transform: 'scale(1)' },
            { transform: 'scale(1.02)' },
            { transform: 'scale(1)' },
          ],
          { duration: 220 },
        );
      },
      setStatus(text) { status.textContent = text; },
      setAssistant(text) { assistant.textContent = text; },
      setMethod(text) { method.textContent = text; },
      setFieldVisible(field, visible) {
        const row = metaRows.get(field);
        if (row) {
          row.hidden = !visible;
        }
      },
      configureFields(fields = {}) {
        for (const [field, visible] of Object.entries(fields)) {
          const row = metaRows.get(field);
          if (row) {
            row.hidden = !visible;
          }
        }
      },
      setMessageCount(value) { messages.textContent = String(value); },
      setPass(current, total) { pass.textContent = `${current} / ${total}`; },
      setIteration(value) { iteration.textContent = String(value); },
      setPosition(scrollTop, scrollHeight, clientHeight) {
        const max = Math.max(0, Math.round(scrollHeight - clientHeight));
        position.textContent = `${Math.round(scrollTop)} / ${max} px`;
      },
      setCloseTitle(text) { closeButton.title = text; },
      showActions({ onSave, onCancel }) {
        onSaveAction = onSave || null;
        onCancelAction = onCancel || null;
        saveButton.disabled = false;
        cancelButton.disabled = false;
        actions.hidden = false;
      },
      hideActions() {
        actions.hidden = true;
        onSaveAction = null;
        onCancelAction = null;
      },
      setActionsDisabled(disabled) {
        saveButton.disabled = Boolean(disabled);
        cancelButton.disabled = Boolean(disabled);
      },
      markDone() { progress.classList.add('done'); stopTimer(); },
      markError() { progress.classList.add('error'); stopTimer(); },
      stopTimer,
      remove() {
        stopTimer();
        host.remove();
      },
    };
  }

  app.modules.panel = {
    HOST_ID,
    createPanel,
  };
})();
