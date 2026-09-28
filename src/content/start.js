(() => {
  'use strict';

  const APP_KEY = '__chatContextExporterRuntime';
  const app = globalThis.__chatContextExporter;

  if (!app) {
    console.error('Chat Context Exporter: core namespace is unavailable.');
    return;
  }

  const {
    settings,
    logger: loggerModule,
    scroller,
    collector: collectorModule,
    richTextParser,
    markdownExporter,
    fileSaver,
    adapterRegistry,
    panel: panelModule,
  } = app.modules;

  if (
    !settings
    || !loggerModule
    || !scroller
    || !collectorModule
    || !richTextParser
    || !markdownExporter
    || !fileSaver
    || !adapterRegistry
    || !panelModule
  ) {
    console.error('Chat Context Exporter: required modules are unavailable.');
    return;
  }

  const previousRuntime = globalThis[APP_KEY];
  const previousHost = document.getElementById(panelModule.HOST_ID);

  if (previousRuntime?.running && previousHost) {
    previousRuntime.panel?.bringToFront?.();
    return;
  }

  previousRuntime?.abortController?.abort();
  previousRuntime?.panel?.remove?.();
  previousHost?.remove();

  const runtime = {
    running: true,
    aborted: false,
    startedAt: Date.now(),
    scrollContainer: null,
    abortController: new AbortController(),
    settings: null,
    settingsPromise: null,
    panel: null,
    adapter: null,
    collector: null,
    conversationStartedAt: null,
    conversationStartChecked: false,
    operationStep: 0,
    stop: null,
    networkMode: false,
  };

  globalThis[APP_KEY] = runtime;

  const MAX_ITERATIONS = 1000;
  const TOP_EPSILON_PX = 2;
  const BOTTOM_EPSILON_PX = 2;
  const TOP_STABILITY_CHECKS = 2;
  const BOTTOM_STABILITY_CHECKS = 2;
  const SEMANTIC_BOUNDARY_MAX_STABLE_CHECKS = 5;
  const SEMANTIC_BOUNDARY_IDLE_TIMEOUT_MS = 45_000;
  const SCROLL_MOVEMENT_EPSILON_PX = 1;
  const MAX_CONSECUTIVE_STALLED_SCROLLS = 3;
  const CAPTURE_START_MESSAGE = 'chat-context-exporter:capture:start';
  const CAPTURE_GET_STATE_MESSAGE = 'chat-context-exporter:capture:get-state';
  const CAPTURE_CANCEL_MESSAGE = 'chat-context-exporter:capture:cancel';
  const CAPTURE_RELEASE_MESSAGE = 'chat-context-exporter:capture:release';
  const CAPTURE_STATUS_MESSAGE = 'chat-context-exporter:capture:status';
  const LOCAL_CACHE_SYNC_START_MESSAGE = 'chat-context-exporter:local-cache-sync:start';
  const LOCAL_CACHE_SYNC_GET_STATE_MESSAGE = 'chat-context-exporter:local-cache-sync:get-state';
  const LOCAL_CACHE_SYNC_RELEASE_MESSAGE = 'chat-context-exporter:local-cache-sync:release';
  const LOCAL_CACHE_POST_RELOAD_MIN_WAIT_MS = 1500;
  const LOCAL_CACHE_STABILITY_INTERVAL_MS = 350;
  const LOCAL_CACHE_STABILITY_MATCHES = 2;

  async function resolveSettings() {
    if (runtime.settings) {
      return runtime.settings;
    }

    if (!runtime.settingsPromise) {
      runtime.settingsPromise = settings.loadSettings();
    }

    runtime.settings = await runtime.settingsPromise;
    return runtime.settings;
  }

  const log = loggerModule.createLogger({
    getSettings: resolveSettings,
    startedAt: runtime.startedAt,
  });

  function sleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve(false);
        return;
      }

      const timer = window.setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve(true);
      }, ms);

      const onAbort = () => {
        window.clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(false);
      };

      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function randomInteger(min, max) {
    const safeMin = Math.ceil(Math.min(min, max));
    const safeMax = Math.floor(Math.max(min, max));
    return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
  }

  async function waitConfiguredDelay(currentSettings, reason) {
    const min = Math.min(currentSettings.minDelayMs, currentSettings.maxDelayMs);
    const max = Math.max(currentSettings.minDelayMs, currentSettings.maxDelayMs);
    const delayMs = randomInteger(min, max);
    log.write('WAIT', { reason, delayMs });
    return sleep(delayMs, runtime.abortController.signal);
  }

  function nextStep() {
    runtime.operationStep += 1;
    runtime.panel?.setIteration(runtime.operationStep);
    return runtime.operationStep;
  }


  function getScrollMode() {
    return runtime.adapter?.scrollMode === 'reverse' ? 'reverse' : 'normal';
  }

  function setPanelScrollState(element) {
    const state = scroller.readScrollState(element);
    const mode = getScrollMode();
    const bounds = scroller.getScrollBounds(element, mode);
    const panelTop = mode === 'reverse'
      ? state.top - bounds.start
      : state.top;
    runtime.panel?.setPosition(panelTop, state.height, state.client);
    return state;
  }

  function logScrollResult({ direction, step, before, after, requestedStepPx }) {
    const delta = after.top - before.top;
    const moved = Math.abs(delta) > SCROLL_MOVEMENT_EPSILON_PX;

    log.write('SCROLL_RESULT', {
      direction,
      step,
      requestedStepPx,
      from: Math.round(before.top),
      actual: Math.round(after.top),
      delta: Math.round(delta),
      moved,
      scrollHeight: after.height,
      clientHeight: after.client,
    });

    return moved;
  }

  async function recoverStalledScroll({ direction, phase, step, command, scrollContainer }) {
    const beforeRecovery = scroller.readScrollState(scrollContainer);
    const recovery = scroller.scrollToDirect(scrollContainer, command.target, getScrollMode());

    log.write('SCROLL_RECOVERY', {
      phase,
      direction,
      step,
      from: Math.round(recovery.from),
      target: Math.round(recovery.target),
      immediate: Math.round(recovery.immediate),
      strategy: recovery.strategy,
    });

    // Даем браузеру два кадра, чтобы виртуализатор успел принять новую позицию.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const afterRecovery = setPanelScrollState(scrollContainer);
    const delta = afterRecovery.top - beforeRecovery.top;
    const recovered = Math.abs(delta) > SCROLL_MOVEMENT_EPSILON_PX;

    log.write('SCROLL_RECOVERY_RESULT', {
      phase,
      direction,
      step,
      from: Math.round(beforeRecovery.top),
      actual: Math.round(afterRecovery.top),
      delta: Math.round(delta),
      recovered,
      scrollHeight: afterRecovery.height,
      clientHeight: afterRecovery.client,
    });

    return recovered;
  }

  function logBoundaryState(event, state) {
    if (!state) {
      return;
    }

    log.write(event, state);
  }

  function formatPassStatus(passContext, primaryText, extraText = primaryText) {
    if (!passContext || passContext.totalPasses <= 1 || passContext.pass <= 1) {
      return primaryText;
    }

    const extraIndex = passContext.pass - 1;
    const extraTotal = passContext.totalPasses - 1;
    return `Дополнительный проход ${extraIndex}/${extraTotal}: ${extraText}`;
  }

  function collectVisible(reason, passContext = null) {
    if (!runtime.collector) {
      return null;
    }

    const batch = runtime.collector.collectVisible();
    runtime.panel?.setMessageCount(batch.total);
    log.write('MESSAGE_BATCH', {
      reason,
      ...(passContext || {}),
      visible: batch.visible,
      added: batch.added,
      updated: batch.updated,
      skipped: batch.skipped,
      total: batch.total,
      user: batch.user,
      assistant: batch.assistant,
      other: batch.other,
    });

    return batch;
  }

  function buildMarkdownArtifact() {
    const sourceMessages = runtime.collector?.getMessages?.() || [];
    let blockCount = 0;
    let emptyMessages = 0;

    const messages = sourceMessages.map((message) => {
      const blocks = richTextParser.parseHtml(message.html, {
        baseUrl: window.location.href,
      });
      blockCount += blocks.length;
      if (blocks.length === 0) {
        emptyMessages += 1;
      }

      return {
        id: message.id,
        role: message.role,
        timestamp: message.timestamp,
        blocks,
      };
    });

    const pageTitle = String(document.title || '').trim() || `Диалог с ${runtime.adapter?.displayName || 'ассистентом'}`;
    const content = markdownExporter.exportConversation({
      title: pageTitle,
      startedAt: runtime.conversationStartedAt,
      messages,
    });
    const filename = markdownExporter.createFilename(
      pageTitle,
      `Диалог с ${runtime.adapter?.displayName || 'ассистентом'}`,
    );

    log.write('MARKDOWN_BUILT', {
      messages: messages.length,
      blocks: blockCount,
      emptyMessages,
      chars: content.length,
      filename,
      title: pageTitle,
      startedAt: runtime.conversationStartedAt,
    });

    return {
      filename,
      content,
      mimeType: 'text/markdown',
      messages: messages.length,
      blocks: blockCount,
      emptyMessages,
    };
  }

  function buildNetworkMarkdownArtifact(conversation) {
    const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
    const blockCount = messages.reduce((sum, message) => sum + (Array.isArray(message.blocks) ? message.blocks.length : 0), 0);
    const emptyMessages = messages.reduce((sum, message) => sum + ((message.blocks?.length || 0) === 0 ? 1 : 0), 0);
    const preferredTitle = runtime.adapter?.variant === 'shared-public'
      ? conversation?.title
      : null;
    const pageTitle = String(preferredTitle || document.title || '').trim()
      || `Диалог с ${runtime.adapter?.displayName || 'ассистентом'}`;
    const content = markdownExporter.exportConversation({
      title: pageTitle,
      startedAt: conversation?.startedAt || null,
      messages,
    });
    const filename = markdownExporter.createFilename(
      pageTitle,
      `Диалог с ${runtime.adapter?.displayName || 'ассистентом'}`,
    );

    log.write('MARKDOWN_BUILT', {
      messages: messages.length,
      blocks: blockCount,
      emptyMessages,
      chars: content.length,
      filename,
      title: pageTitle,
      startedAt: conversation?.startedAt || null,
    });

    return {
      filename,
      content,
      mimeType: 'text/markdown',
      messages: messages.length,
      blocks: blockCount,
      emptyMessages,
    };
  }

  async function sendCaptureMessage(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) {
      throw new Error(response?.error || 'Ошибка канала сетевого захвата.');
    }
    return response;
  }

  async function sendLocalCacheSyncMessage(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) {
      throw new Error(response?.error || 'Ошибка канала локальной синхронизации.');
    }
    return response;
  }

  async function saveMarkdownArtifact(artifact, reason, { saveAs = false } = {}) {
    log.write('MARKDOWN_SAVE_REQUESTED', {
      reason,
      filename: artifact.filename,
      chars: artifact.content.length,
      saveAs,
    });

    const response = await fileSaver.saveTextFile({
      ...artifact,
      saveAs,
      onAttempt(details) {
        log.write('MARKDOWN_SAVE_ATTEMPT', {
          reason,
          filename: artifact.filename,
          saveAs,
          ...details,
        });
      },
    });
    log.write('MARKDOWN_SAVED', {
      reason,
      filename: artifact.filename,
      downloadId: response.downloadId,
      saveAs,
    });
    return response;
  }

  function waitForManualExportAction(artifact, stats) {
    return new Promise((resolve) => {
      let settled = false;

      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        runtime.abortController.signal.removeEventListener('abort', handleAbort);
        resolve(result);
      };

      const handleAbort = () => finish({ state: 'aborted' });
      runtime.abortController.signal.addEventListener('abort', handleAbort, { once: true });

      runtime.panel.showActions({
        onSave: async () => {
          if (settled) {
            return;
          }

          runtime.panel.setActionsDisabled(true);
          runtime.panel.setStatus('Сохраняю файл...');
          try {
            await saveMarkdownArtifact(artifact, 'manual', { saveAs: true });
            runtime.panel.hideActions();
            runtime.panel.setStatus('Сохранено.');
            runtime.panel.setCloseTitle('Закрыть');
            runtime.panel.markDone();
            finish({ state: 'saved' });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.write('MARKDOWN_SAVE_ERROR', { reason: 'manual', message });
            runtime.panel.setStatus(`Ошибка сохранения: ${message}`);
            runtime.panel.setActionsDisabled(false);
          }
        },
        onCancel: () => {
          if (settled) {
            return;
          }
          log.write('MARKDOWN_SAVE_CANCELLED', { reason: 'manual' });
          runtime.panel.remove();
          finish({ state: 'cancelled' });
        },
      });
    });
  }

  function stopRuntime() {
    if (!runtime.running) {
      runtime.panel?.remove?.();
      return;
    }

    if (runtime.aborted) {
      runtime.panel?.remove?.();
      runtime.running = false;
      return;
    }

    if (runtime.networkMode) {
      runtime.aborted = true;
      runtime.abortController.abort();
      runtime.panel?.remove?.();
      runtime.running = false;
      void (async () => {
        try {
          const response = await sendCaptureMessage({ type: CAPTURE_CANCEL_MESSAGE });
          if (response.state?.startedAt) {
            runtime.startedAt = response.state.startedAt;
            log.setStartedAt?.(runtime.startedAt);
          }
          log.importEntries?.(response.state?.events || []);
        } catch (error) {
          log.write('CAPTURE_CANCEL_FAILED', {
            message: error instanceof Error ? error.message : String(error),
          });
        }
        await log.saveOnce('CANCELLED');
      })();
      return;
    }

    log.write('CANCEL_REQUESTED', {
      duration: loggerModule.formatDuration(Date.now() - runtime.startedAt),
      messages: runtime.collector?.getStats?.().total ?? 0,
    });
    runtime.aborted = true;
    runtime.abortController.abort();
    scroller.cancelCurrentScroll(runtime.scrollContainer);
    runtime.panel?.remove?.();
    runtime.running = false;
    void log.saveOnce('CANCELLED');
  }

  function reselectScroller() {
    const selected = runtime.adapter.findScroller?.() || scroller.findGenericScrollContainer();
    runtime.scrollContainer = selected;
    return selected;
  }

  async function seekHistoryStart(currentSettings, passContext) {
    let scrollContainer = runtime.scrollContainer;
    let stableTopChecks = 0;
    let semanticStableChecks = 0;
    let previousTopHeight = null;
    let previousTopSignature = null;
    let scrollCommands = 0;
    let effectiveMoves = 0;
    let consecutiveStalledScrolls = 0;
    let addedDuringPhase = 0;
    let updatedDuringPhase = 0;
    let semanticWaitStartedAt = null;
    const phaseStartedAt = Date.now();
    const semanticIdleTimeoutMs = Math.max(
      SEMANTIC_BOUNDARY_IDLE_TIMEOUT_MS,
      Math.max(currentSettings.minDelayMs, currentSettings.maxDelayMs) * 3,
    );

    const collectForPhase = (reason) => {
      const batch = collectVisible(reason, passContext);
      if (batch) {
        addedDuringPhase += batch.added;
        updatedDuringPhase += batch.updated;
      }
      return batch;
    };

    runtime.panel.setStatus(formatPassStatus(
      passContext,
      'Едем к началу истории...',
      'еду к началу истории...',
    ));

    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
      if (runtime.aborted) {
        return null;
      }

      if (!scrollContainer.isConnected) {
        log.write('SCROLL_CONTAINER_DISCONNECTED', { phase: 'seek-start', ...passContext });
        scrollContainer = reselectScroller();
        log.write('SCROLL_CONTAINER_RESELECTED', {
          phase: 'seek-start',
          ...passContext,
          container: scroller.describeElement(scrollContainer),
        });
      }

      const step = nextStep();
      const before = setPanelScrollState(scrollContainer);
      collectForPhase('before-up-step');
      log.write('ITERATION', {
        phase: 'seek-start',
        ...passContext,
        iteration,
        step,
        scrollTop: Math.round(before.top),
        scrollHeight: before.height,
        clientHeight: before.client,
        messages: runtime.collector?.getStats?.().total ?? 0,
      });

      if (scroller.isAtTop(scrollContainer, TOP_EPSILON_PX, getScrollMode())) {
        runtime.panel.setStatus(formatPassStatus(
          passContext,
          'Проверяю начало истории...',
          'проверяю начало истории...',
        ));
        log.write('TOP_REACHED', { ...passContext, iteration, step });

        const completedDelay = await waitConfiguredDelay(currentSettings, 'top-stability');
        if (!completedDelay || runtime.aborted) {
          return null;
        }

        const afterWait = setPanelScrollState(scrollContainer);
        const batch = collectForPhase('top-check');
        const topStillReached = scroller.isAtTop(scrollContainer, TOP_EPSILON_PX, getScrollMode());
        const heightUnchanged = previousTopHeight !== null && afterWait.height === previousTopHeight;
        const boundaryState = runtime.adapter.getHistoryStartState?.(scrollContainer) || null;
        const semanticReached = boundaryState ? Boolean(boundaryState.reached) : true;
        const boundarySignature = boundaryState?.signature ?? null;
        const signatureUnchanged = boundarySignature === null
          || (previousTopSignature !== null && boundarySignature === previousTopSignature);

        log.write('TOP_CHECK', {
          ...passContext,
          scrollTop: Math.round(afterWait.top),
          scrollHeight: afterWait.height,
          topStillReached,
          heightUnchanged,
          signatureUnchanged,
          semanticReached,
          stableTopChecks,
          messages: batch?.total ?? runtime.collector?.getStats?.().total ?? 0,
        });
        logBoundaryState('HISTORY_START_SIGNAL', boundaryState ? { ...passContext, ...boundaryState } : null);

        if (topStillReached && heightUnchanged && signatureUnchanged) {
          stableTopChecks += 1;
          if (semanticReached) {
            semanticStableChecks += 1;
          } else {
            semanticStableChecks = 0;
          }
        } else {
          stableTopChecks = 0;
          semanticStableChecks = 0;
        }

        const hadTopBaseline = previousTopHeight !== null || previousTopSignature !== null;
        const semanticProgress = hadTopBaseline && (
          afterWait.height !== previousTopHeight
          || boundarySignature !== previousTopSignature
          || (batch?.added || 0) > 0
          || (batch?.updated || 0) > 0
        );

        if (!semanticReached && topStillReached) {
          if (semanticWaitStartedAt === null || semanticProgress) {
            semanticWaitStartedAt = Date.now();
            log.write(semanticProgress ? 'HISTORY_START_PROGRESS' : 'HISTORY_START_WAIT_STARTED', {
              ...passContext,
              iteration,
              step,
              scrollHeight: afterWait.height,
              signature: boundarySignature,
              topStatusPresent: boundaryState?.topStatusPresent ?? null,
              topStatusText: boundaryState?.topStatusText ?? null,
              timeoutMs: semanticIdleTimeoutMs,
            });
          }
        } else if (semanticReached) {
          semanticWaitStartedAt = null;
        }

        previousTopHeight = afterWait.height;
        previousTopSignature = boundarySignature;

        if (topStillReached && stableTopChecks >= TOP_STABILITY_CHECKS && semanticReached) {
          if (!runtime.conversationStartedAt) {
            const startTimestamp = runtime.adapter.getConversationStartTimestamp?.(scrollContainer) || null;
            if (startTimestamp) {
              runtime.conversationStartedAt = startTimestamp;
              log.write('CONVERSATION_START_TIMESTAMP', {
                present: true,
                value: startTimestamp,
                variant: runtime.adapter.variant || null,
              });
            } else if (!runtime.conversationStartChecked) {
              log.write('CONVERSATION_START_TIMESTAMP', {
                present: false,
                variant: runtime.adapter.variant || null,
              });
            }
            runtime.conversationStartChecked = true;
          }

          const phaseDurationMs = Date.now() - phaseStartedAt;
          log.write('SEEK_START_COMPLETED', {
            ...passContext,
            iteration,
            step,
            stableTopChecks,
            semanticStableChecks,
            scrollCommands,
            effectiveMoves,
            addedDuringPhase,
            updatedDuringPhase,
            durationMs: phaseDurationMs,
            duration: loggerModule.formatDuration(phaseDurationMs),
          });

          return {
            iteration,
            scrollCommands,
            effectiveMoves,
            addedDuringPhase,
            updatedDuringPhase,
            durationMs: phaseDurationMs,
          };
        }

        if (boundaryState && topStillReached && !semanticReached && semanticWaitStartedAt !== null) {
          const semanticIdleMs = Date.now() - semanticWaitStartedAt;
          log.write('HISTORY_START_WAITING', {
            ...passContext,
            iteration,
            step,
            semanticIdleMs,
            semanticIdleTimeoutMs,
            topStatusPresent: boundaryState.topStatusPresent ?? null,
            topStatusText: boundaryState.topStatusText ?? null,
            scrollHeight: afterWait.height,
          });

          if (semanticIdleMs >= semanticIdleTimeoutMs) {
            throw new Error(`${runtime.adapter?.displayName || 'Чат'}: начало истории не подтверждено после ${Math.ceil(semanticIdleMs / 1000)} секунд без прогресса.`);
          }
        }

        continue;
      }

      stableTopChecks = 0;
      semanticStableChecks = 0;
      previousTopHeight = null;
      previousTopSignature = null;
      semanticWaitStartedAt = null;
      runtime.panel.setStatus(formatPassStatus(
        passContext,
        'Едем к началу истории...',
        'еду к началу истории...',
      ));

      const command = scroller.scrollUpOneStep(scrollContainer, getScrollMode());
      const requestedStepPx = command.stepPx;
      log.write('SCROLL_UP', {
        ...passContext,
        iteration,
        step,
        stepPx: requestedStepPx,
        from: Math.round(command.from),
        target: Math.round(command.target),
        immediate: Math.round(command.immediate),
        strategy: command.strategy,
      });
      scrollCommands += 1;

      const completedDelay = await waitConfiguredDelay(currentSettings, 'between-scroll-steps');
      if (!completedDelay || runtime.aborted) {
        log.write('WAIT_ABORTED', { phase: 'seek-start', ...passContext, iteration, step });
        return null;
      }

      const after = setPanelScrollState(scrollContainer);
      const moved = logScrollResult({
        direction: 'up',
        step,
        before,
        after,
        requestedStepPx,
      });
      collectForPhase('after-up-step');

      if (moved) {
        effectiveMoves += 1;
        consecutiveStalledScrolls = 0;
      } else {
        log.write('SCROLL_STALLED', {
          phase: 'seek-start',
          ...passContext,
          direction: 'up',
          step,
          consecutive: consecutiveStalledScrolls + 1,
          scrollTop: Math.round(after.top),
          target: Math.round(command.target),
          strategy: command.strategy,
        });

        const recovered = await recoverStalledScroll({
          direction: 'up',
          phase: 'seek-start',
          step,
          command,
          scrollContainer,
        });
        collectForPhase('after-up-recovery');

        if (recovered) {
          effectiveMoves += 1;
          consecutiveStalledScrolls = 0;
        } else {
          consecutiveStalledScrolls += 1;
          if (consecutiveStalledScrolls >= MAX_CONSECUTIVE_STALLED_SCROLLS) {
            throw new Error('Прокрутка вверх не сдвигает контейнер после smooth и прямого восстановления.');
          }
        }
      }
    }

    throw new Error(`Превышен лимит ${MAX_ITERATIONS} шагов при поиске начала истории.`);
  }

  async function collectHistoryDown(currentSettings, passContext) {
    let scrollContainer = runtime.scrollContainer;
    let stableBottomChecks = 0;
    let physicalBottomChecks = 0;
    let previousBottomHeight = null;
    let previousBottomSignature = null;
    let scrollCommands = 0;
    let effectiveMoves = 0;
    let consecutiveStalledScrolls = 0;
    let addedDuringPhase = 0;
    let updatedDuringPhase = 0;
    const phaseStartedAt = Date.now();

    if (!runtime.collector) {
      runtime.collector = collectorModule.createCollector(runtime.adapter);
    }

    const collectForPhase = (reason) => {
      const batch = collectVisible(reason, passContext);
      if (batch) {
        addedDuringPhase += batch.added;
        updatedDuringPhase += batch.updated;
      }
      return batch;
    };

    runtime.panel.setStatus(formatPassStatus(
      passContext,
      'Достигнут верх, собираю сообщения...',
      'достигнут верх, собираю сообщения...',
    ));
    collectForPhase('history-start');

    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
      if (runtime.aborted) {
        return null;
      }

      if (!scrollContainer.isConnected) {
        log.write('SCROLL_CONTAINER_DISCONNECTED', { phase: 'collect-down', ...passContext });
        scrollContainer = reselectScroller();
        log.write('SCROLL_CONTAINER_RESELECTED', {
          phase: 'collect-down',
          ...passContext,
          container: scroller.describeElement(scrollContainer),
        });
      }

      const step = nextStep();
      const before = setPanelScrollState(scrollContainer);
      collectForPhase('before-down-step');

      log.write('ITERATION', {
        phase: 'collect-down',
        ...passContext,
        iteration,
        step,
        scrollTop: Math.round(before.top),
        scrollHeight: before.height,
        clientHeight: before.client,
        messages: runtime.collector.getStats().total,
      });

      if (scroller.isAtBottom(scrollContainer, BOTTOM_EPSILON_PX, getScrollMode())) {
        runtime.panel.setStatus(formatPassStatus(
          passContext,
          'Проверяю конец истории...',
          'проверяю конец истории...',
        ));
        log.write('BOTTOM_REACHED', { ...passContext, iteration, step });

        const completedDelay = await waitConfiguredDelay(currentSettings, 'bottom-stability');
        if (!completedDelay || runtime.aborted) {
          return null;
        }

        const afterWait = setPanelScrollState(scrollContainer);
        const bottomStillReached = scroller.isAtBottom(scrollContainer, BOTTOM_EPSILON_PX, getScrollMode());
        const heightUnchanged = previousBottomHeight !== null && afterWait.height === previousBottomHeight;
        const batch = collectForPhase('bottom-check');
        const boundaryState = runtime.adapter.getHistoryEndState?.(scrollContainer) || null;
        const coverage = runtime.adapter.getCollectionCoverage?.(scrollContainer) || null;
        const expectedTurnCount = Number.isFinite(Number(coverage?.expectedTurnCount))
          ? Number(coverage.expectedTurnCount)
          : null;
        const observedTurnCount = Number.isFinite(Number(coverage?.observedTurnCount))
          ? Number(coverage.observedTurnCount)
          : null;
        const resolvedTurnCount = Number.isFinite(Number(coverage?.resolvedTurnCount))
          ? Number(coverage.resolvedTurnCount)
          : null;
        const missingTurnCount = Number.isFinite(Number(coverage?.missingTurnCount))
          ? Number(coverage.missingTurnCount)
          : null;
        const unresolvedTurnCount = Number.isFinite(Number(coverage?.unresolvedTurnCount))
          ? Number(coverage.unresolvedTurnCount)
          : null;
        const fallbackMessageTurnCount = Number.isFinite(Number(coverage?.fallbackMessageTurnCount))
          ? Number(coverage.fallbackMessageTurnCount)
          : null;
        const transientTurnCount = Number.isFinite(Number(coverage?.transientTurnCount))
          ? Number(coverage.transientTurnCount)
          : null;
        const collectedMessageCount = batch?.total ?? runtime.collector.getStats().total;
        const collectionComplete = coverage?.collectionComplete !== false;
        const boundaryReached = boundaryState ? Boolean(boundaryState.reached) : true;
        const semanticReached = boundaryReached && collectionComplete;
        const boundarySignature = boundaryState?.signature ?? null;
        const signatureUnchanged = boundarySignature === null
          || (previousBottomSignature !== null && boundarySignature === previousBottomSignature);

        log.write('BOTTOM_CHECK', {
          ...passContext,
          scrollTop: Math.round(afterWait.top),
          scrollHeight: afterWait.height,
          bottomStillReached,
          heightUnchanged,
          signatureUnchanged,
          semanticReached,
          collectionComplete,
          expectedTurnCount,
          observedTurnCount,
          resolvedTurnCount,
          missingTurnCount,
          unresolvedTurnCount,
          fallbackMessageTurnCount,
          transientTurnCount,
          transientTurnIds: coverage?.transientTurnIds || [],
          transientTurnOrdinals: coverage?.transientTurnOrdinals || [],
          missingTurnIds: coverage?.missingTurnIds || [],
          missingTurnSkeletonIndexes: coverage?.missingTurnSkeletonIndexes || [],
          unresolvedTurnOrdinals: coverage?.unresolvedTurnOrdinals || [],
          collectedMessageCount,
          stableBottomChecks,
          physicalBottomChecks,
          messages: collectedMessageCount,
        });
        logBoundaryState('HISTORY_END_SIGNAL', boundaryState ? {
          ...passContext,
          ...boundaryState,
          collectionComplete,
          expectedTurnCount,
          observedTurnCount,
          resolvedTurnCount,
          missingTurnCount,
          unresolvedTurnCount,
          fallbackMessageTurnCount,
          transientTurnCount,
          transientTurnIds: coverage?.transientTurnIds || [],
          transientTurnOrdinals: coverage?.transientTurnOrdinals || [],
          missingTurnIds: coverage?.missingTurnIds || [],
          missingTurnSkeletonIndexes: coverage?.missingTurnSkeletonIndexes || [],
          unresolvedTurnOrdinals: coverage?.unresolvedTurnOrdinals || [],
          collectedMessageCount,
        } : null);

        if (bottomStillReached && heightUnchanged && signatureUnchanged) {
          physicalBottomChecks += 1;
          if (semanticReached) {
            stableBottomChecks += 1;
          } else {
            stableBottomChecks = 0;
          }
        } else {
          physicalBottomChecks = 0;
          stableBottomChecks = 0;
        }

        previousBottomHeight = afterWait.height;
        previousBottomSignature = boundarySignature;

        if (bottomStillReached && stableBottomChecks >= BOTTOM_STABILITY_CHECKS && semanticReached) {
          const phaseDurationMs = Date.now() - phaseStartedAt;
          const stats = runtime.collector.getStats();
          log.write('COLLECT_COMPLETED', {
            ...passContext,
            total: stats.total,
            user: stats.user,
            assistant: stats.assistant,
            other: stats.other,
            scrollCommands,
            effectiveMoves,
            addedDuringPhase,
            updatedDuringPhase,
            collectionComplete,
            expectedTurnCount,
            observedTurnCount,
            resolvedTurnCount,
            missingTurnCount,
            unresolvedTurnCount,
            fallbackMessageTurnCount,
            transientTurnCount,
            durationMs: phaseDurationMs,
            duration: loggerModule.formatDuration(phaseDurationMs),
          });

          return {
            ...stats,
            scrollCommands,
            effectiveMoves,
            addedDuringPhase,
            updatedDuringPhase,
            collectionComplete,
            expectedTurnCount,
            observedTurnCount,
            resolvedTurnCount,
            missingTurnCount,
            unresolvedTurnCount,
            fallbackMessageTurnCount,
            transientTurnCount,
            durationMs: phaseDurationMs,
          };
        }

        if (
          boundaryState
          && physicalBottomChecks >= SEMANTIC_BOUNDARY_MAX_STABLE_CHECKS
          && !semanticReached
        ) {
          if (!collectionComplete && expectedTurnCount !== null) {
            const hasAnotherPass = passContext.pass < passContext.totalPasses;
            const phaseDurationMs = Date.now() - phaseStartedAt;
            const stats = runtime.collector.getStats();

            log.write(hasAnotherPass ? 'COLLECT_PASS_INCOMPLETE' : 'COLLECT_INCOMPLETE', {
              ...passContext,
              total: stats.total,
              user: stats.user,
              assistant: stats.assistant,
              expectedTurnCount,
              observedTurnCount,
              resolvedTurnCount,
              missingTurnCount,
              unresolvedTurnCount,
              fallbackMessageTurnCount,
              transientTurnCount,
              boundaryReached,
              transientTurnIds: coverage?.transientTurnIds || [],
              transientTurnOrdinals: coverage?.transientTurnOrdinals || [],
              missingTurnIds: coverage?.missingTurnIds || [],
              missingTurnSkeletonIndexes: coverage?.missingTurnSkeletonIndexes || [],
              unresolvedTurnIds: coverage?.unresolvedTurnIds || [],
              unresolvedTurnOrdinals: coverage?.unresolvedTurnOrdinals || [],
              nextPassAvailable: hasAnotherPass,
              durationMs: phaseDurationMs,
              duration: loggerModule.formatDuration(phaseDurationMs),
            });

            if (hasAnotherPass) {
              return {
                ...stats,
                scrollCommands,
                effectiveMoves,
                addedDuringPhase,
                updatedDuringPhase,
                collectionComplete: false,
                expectedTurnCount,
                observedTurnCount,
                resolvedTurnCount,
                missingTurnCount,
                unresolvedTurnCount,
                fallbackMessageTurnCount,
                transientTurnCount,
                durationMs: phaseDurationMs,
              };
            }

            const unresolvedSuffix = unresolvedTurnCount
              ? `; не распознано содержимое ${unresolvedTurnCount} turn`
              : '';
            throw new Error(`${runtime.adapter?.displayName || 'Чат'}: достигнут конец истории, но полностью обработано ${resolvedTurnCount ?? 0} из ${expectedTurnCount} ожидаемых turn${unresolvedSuffix}.`);
          }
          throw new Error(`${runtime.adapter?.displayName || 'Чат'}: нижняя позиция стабильна, но DOM-признак конца истории не подтвержден.`);
        }

        continue;
      }

      stableBottomChecks = 0;
      physicalBottomChecks = 0;
      previousBottomHeight = null;
      previousBottomSignature = null;
      runtime.panel.setStatus(formatPassStatus(
        passContext,
        'Добираю историю вниз...',
        'добираю историю вниз...',
      ));

      const command = scroller.scrollDownOneStep(scrollContainer, getScrollMode());
      const requestedStepPx = command.stepPx;
      log.write('SCROLL_DOWN', {
        ...passContext,
        iteration,
        step,
        stepPx: requestedStepPx,
        from: Math.round(command.from),
        target: Math.round(command.target),
        immediate: Math.round(command.immediate),
        strategy: command.strategy,
      });
      scrollCommands += 1;

      const completedDelay = await waitConfiguredDelay(currentSettings, 'between-collect-steps');
      if (!completedDelay || runtime.aborted) {
        log.write('WAIT_ABORTED', { phase: 'collect-down', ...passContext, iteration, step });
        return null;
      }

      const after = setPanelScrollState(scrollContainer);
      const moved = logScrollResult({
        direction: 'down',
        step,
        before,
        after,
        requestedStepPx,
      });

      if (moved) {
        effectiveMoves += 1;
        consecutiveStalledScrolls = 0;
      } else {
        log.write('SCROLL_STALLED', {
          phase: 'collect-down',
          ...passContext,
          direction: 'down',
          step,
          consecutive: consecutiveStalledScrolls + 1,
          scrollTop: Math.round(after.top),
          target: Math.round(command.target),
          strategy: command.strategy,
        });

        const recovered = await recoverStalledScroll({
          direction: 'down',
          phase: 'collect-down',
          step,
          command,
          scrollContainer,
        });
        collectForPhase('after-down-recovery');

        if (recovered) {
          effectiveMoves += 1;
          consecutiveStalledScrolls = 0;
        } else {
          consecutiveStalledScrolls += 1;
          if (consecutiveStalledScrolls >= MAX_CONSECUTIVE_STALLED_SCROLLS) {
            throw new Error('Прокрутка вниз не сдвигает контейнер после smooth и прямого восстановления.');
          }
        }
      }

      collectForPhase('after-down-step');
      runtime.panel.setStatus(formatPassStatus(
        passContext,
        'Добираю историю вниз...',
        'добираю историю вниз...',
      ));
    }

    throw new Error(`Превышен лимит ${MAX_ITERATIONS} шагов при сборе истории.`);
  }

  function configureNetworkPanel(totalPasses) {
    const adapterFields = runtime.adapter?.panelFields || {};
    runtime.panel?.configureFields?.({
      assistant: true,
      method: false,
      messages: true,
      pass: totalPasses > 1,
      iteration: adapterFields.iteration === true,
      position: adapterFields.position === true,
    });
  }

  function updateNetworkPanel(state) {
    if (!runtime.panel || !state) {
      return;
    }

    runtime.panel.setPass(Math.max(1, state.pass || 1), Math.max(1, state.totalPasses || 1));

    switch (state.phase) {
      case 'attaching':
        runtime.panel.setStatus('Подключаюсь...');
        break;
      case 'armed':
        runtime.panel.setStatus('Перезагружаю страницу...');
        break;
      case 'capturing':
        runtime.panel.setStatus('Получаю историю...');
        break;
      case 'waiting-next-pass':
        runtime.panel.setStatus('Готовлю дополнительный проход...');
        break;
      case 'ready':
        runtime.panel.setStatus('Проверяю данные...');
        break;
      case 'error':
        runtime.panel.setStatus(`Ошибка: ${state.error || 'сетевой захват не завершен'}`);
        break;
      case 'cancelled':
        runtime.panel.setStatus('Остановлено.');
        break;
      default:
        runtime.panel.setStatus('Подготовка...');
        break;
    }
  }

  async function waitForNetworkCaptureState(initialState) {
    let state = initialState;

    for (;;) {
      if (runtime.aborted) {
        return null;
      }

      updateNetworkPanel(state);
      if (!state || ['ready', 'error', 'cancelled', 'released'].includes(state.phase)) {
        return state;
      }

      const completed = await sleep(350, runtime.abortController.signal);
      if (!completed || runtime.aborted) {
        return null;
      }

      const response = await sendCaptureMessage({
        type: CAPTURE_GET_STATE_MESSAGE,
        includeCaptures: false,
      });
      state = response.state;
    }
  }

  async function readIndexedDbRecordReadonly(config) {
    const databaseName = typeof config?.databaseName === 'string' ? config.databaseName.trim() : '';
    const storeName = typeof config?.storeName === 'string' ? config.storeName.trim() : '';
    const key = config?.key;

    if (!databaseName || !storeName || key === undefined || key === null) {
      throw new Error('Некорректные параметры read-only чтения IndexedDB.');
    }

    if (!globalThis.indexedDB) {
      return { found: false, reason: 'indexeddb-unavailable', databaseVersion: null, record: null };
    }

    if (typeof indexedDB.databases === 'function') {
      try {
        const databases = await indexedDB.databases();
        const existing = databases.find((item) => item?.name === databaseName);
        if (!existing) {
          return { found: false, reason: 'database-missing', databaseVersion: null, record: null };
        }
      } catch {
        // Some Chromium builds may reject databases(); open() below still aborts
        // on upgradeneeded, so a missing DB is never committed by the extension.
      }
    }

    const openResult = await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      let missingDatabase = false;

      request.onupgradeneeded = () => {
        missingDatabase = true;
        try {
          request.transaction?.abort();
        } catch {}
      };
      request.onerror = () => {
        if (missingDatabase || request.error?.name === 'AbortError') {
          resolve({ database: null, missing: true });
          return;
        }
        reject(request.error || new Error('IndexedDB open failed.'));
      };
      request.onblocked = () => reject(new Error('IndexedDB open blocked.'));
      request.onsuccess = () => {
        if (missingDatabase) {
          try {
            request.result?.close?.();
          } catch {}
          resolve({ database: null, missing: true });
          return;
        }
        resolve({ database: request.result, missing: false });
      };
    });

    if (openResult.missing || !openResult.database) {
      return { found: false, reason: 'database-missing', databaseVersion: null, record: null };
    }

    const database = openResult.database;
    try {
      if (!database.objectStoreNames.contains(storeName)) {
        return {
          found: false,
          reason: 'store-missing',
          databaseVersion: database.version,
          record: null,
        };
      }

      const record = await new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readonly');
        const store = transaction.objectStore(storeName);
        const request = store.get(key);
        let value;
        let requestCompleted = false;

        request.onsuccess = () => {
          value = request.result;
          requestCompleted = true;
        };
        request.onerror = () => reject(request.error || new Error('IndexedDB get failed.'));
        transaction.oncomplete = () => resolve(requestCompleted ? value : undefined);
        transaction.onerror = () => reject(transaction.error || new Error('IndexedDB readonly transaction failed.'));
        transaction.onabort = () => reject(transaction.error || new Error('IndexedDB readonly transaction aborted.'));
      });

      return {
        found: record !== undefined,
        reason: record === undefined ? 'record-missing' : null,
        databaseVersion: database.version,
        record: record === undefined ? null : record,
      };
    } finally {
      database.close();
    }
  }

  function fingerprintLocalCacheRecord(record) {
    const json = JSON.stringify(record);
    let hash = 0x811c9dc5;
    for (let index = 0; index < json.length; index += 1) {
      hash ^= json.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }

    return {
      signature: `${json.length}:${hash >>> 0}`,
      recordBytes: new TextEncoder().encode(json).byteLength,
    };
  }

  async function readLocalCacheRecordWithRetry(
    config,
    passContext,
    { requireStable = false, minReadyAt = 0 } = {},
  ) {
    const timeoutMs = requireStable ? 8_000 : 5_000;
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    let stableSignature = null;
    let stableMatches = 0;

    if (requireStable && minReadyAt > Date.now()) {
      const waitMs = minReadyAt - Date.now();
      runtime.panel?.setStatus(formatPassStatus(
        passContext,
        'Жду синхронизацию DeepSeek...',
        'жду синхронизацию DeepSeek...',
      ));
      log.write('LOCAL_CACHE_SYNC_WAIT', {
        ...passContext,
        reason: 'post-reload-grace-period',
        delayMs: waitMs,
      });
      const completed = await sleep(waitMs, runtime.abortController.signal);
      if (!completed || runtime.aborted) {
        return null;
      }
    }

    for (;;) {
      if (runtime.aborted) {
        return null;
      }

      attempt += 1;
      log.write('LOCAL_CACHE_READ_STARTED', {
        ...passContext,
        attempt,
        databaseName: config.databaseName,
        storeName: config.storeName,
        key: config.key,
        requireStable,
      });

      const result = await readIndexedDbRecordReadonly(config);
      if (result?.found) {
        let fingerprint = { signature: null, recordBytes: null };
        try {
          fingerprint = fingerprintLocalCacheRecord(result.record);
        } catch {}

        log.write('LOCAL_CACHE_RECORD_READ', {
          ...passContext,
          attempt,
          databaseName: config.databaseName,
          storeName: config.storeName,
          databaseVersion: result.databaseVersion ?? null,
          recordBytes: fingerprint.recordBytes,
        });

        if (!requireStable) {
          return result;
        }

        if (fingerprint.signature && fingerprint.signature === stableSignature) {
          stableMatches += 1;
        } else {
          stableSignature = fingerprint.signature;
          stableMatches = 1;
        }

        log.write('LOCAL_CACHE_STABILITY_CHECK', {
          ...passContext,
          attempt,
          stableMatches,
          requiredMatches: LOCAL_CACHE_STABILITY_MATCHES,
          recordBytes: fingerprint.recordBytes,
        });

        if (stableMatches >= LOCAL_CACHE_STABILITY_MATCHES) {
          log.write('LOCAL_CACHE_STABLE', {
            ...passContext,
            attempts: attempt,
            stableMatches,
            recordBytes: fingerprint.recordBytes,
          });
          return result;
        }
      } else {
        stableSignature = null;
        stableMatches = 0;
        const reason = result?.reason || 'record-missing';
        log.write('LOCAL_CACHE_READ_MISS', {
          ...passContext,
          attempt,
          databaseName: config.databaseName,
          storeName: config.storeName,
          reason,
          databaseVersion: result?.databaseVersion ?? null,
        });
      }

      if (Date.now() >= deadline) {
        if (requireStable) {
          throw new Error(`${runtime.adapter?.displayName || 'Чат'}: локальная история не стабилизировалась после перезагрузки страницы.`);
        }
        const reason = result?.reason || 'record-missing';
        throw new Error(`${runtime.adapter?.displayName || 'Чат'}: локальная история не найдена (${reason}). Дождитесь полной загрузки чата и повторите экспорт.`);
      }

      runtime.panel?.setStatus(formatPassStatus(
        passContext,
        requireStable ? 'Проверяю обновление локальной истории...' : 'Жду локальную историю...',
        requireStable ? 'проверяю обновление локальной истории...' : 'жду локальную историю...',
      ));
      const completed = await sleep(
        requireStable ? LOCAL_CACHE_STABILITY_INTERVAL_MS : 250,
        runtime.abortController.signal,
      );
      if (!completed || runtime.aborted) {
        return null;
      }
    }
  }

  async function runLocalCacheAdapter(currentSettings, detection) {
    runtime.adapter = detection.adapter;
    runtime.stop = stopRuntime;

    const configuredExtraPasses = currentSettings.extraPassesEnabled
      ? settings.clampExtraPassCount(currentSettings.extraPassCount)
      : 0;
    const totalPasses = 1 + configuredExtraPasses;
    const config = runtime.adapter.getLocalCacheConfig?.();
    if (
      !config?.databaseName
      || !config?.storeName
      || config.key === undefined
      || typeof runtime.adapter.parseLocalCacheReads !== 'function'
    ) {
      throw new Error(`${runtime.adapter.displayName || runtime.adapter.id}: локальный адаптер настроен неполно.`);
    }

    let syncState = null;
    if (runtime.adapter.reloadBeforeLocalCacheRead === true) {
      const stateResponse = await sendLocalCacheSyncMessage({
        type: LOCAL_CACHE_SYNC_GET_STATE_MESSAGE,
      });
      syncState = stateResponse.state;

      if (!syncState) {
        runtime.panel = panelModule.createPanel({
          startedAt: runtime.startedAt,
          onStop: stopRuntime,
        });
        runtime.panel.setAssistant(runtime.adapter.displayName || runtime.adapter.id);
        configureNetworkPanel(totalPasses);
        runtime.panel.setMessageCount(0);
        runtime.panel.setPass(1, totalPasses);
        runtime.panel.setStatus('Перезагружаю страницу...');

        const startResponse = await sendLocalCacheSyncMessage({
          type: LOCAL_CACHE_SYNC_START_MESSAGE,
          adapterId: runtime.adapter.id,
          sessionId: config.sessionId || null,
          version: app.version,
          page: loggerModule.sanitizePageUrl(),
          title: document.title,
        });
        syncState = startResponse.state;
        if (syncState?.startedAt) {
          runtime.startedAt = syncState.startedAt;
          log.setStartedAt?.(syncState.startedAt);
        }

        // Background перезагрузит текущую вкладку. После завершения навигации
        // runtime будет автоматически внедрен снова и продолжит этот запуск.
        return true;
      }

      if (syncState.adapterId && syncState.adapterId !== runtime.adapter.id) {
        throw new Error(`Во вкладке уже активна локальная синхронизация адаптера ${syncState.adapterId}.`);
      }

      if (syncState.startedAt) {
        runtime.startedAt = syncState.startedAt;
        log.setStartedAt?.(syncState.startedAt);
      }

      if (syncState.phase === 'error') {
        await sendLocalCacheSyncMessage({ type: LOCAL_CACHE_SYNC_RELEASE_MESSAGE }).catch(() => {});
        throw new Error(syncState.error || 'Не удалось перезагрузить страницу для синхронизации DeepSeek.');
      }

      if (syncState.phase !== 'ready') {
        runtime.panel = panelModule.createPanel({
          startedAt: runtime.startedAt,
          onStop: stopRuntime,
        });
        runtime.panel.setAssistant(runtime.adapter.displayName || runtime.adapter.id);
        configureNetworkPanel(totalPasses);
        runtime.panel.setMessageCount(0);
        runtime.panel.setPass(1, totalPasses);
        runtime.panel.setStatus('Перезагружаю страницу...');
        return true;
      }
    }

    log.write('START', {
      page: loggerModule.sanitizePageUrl(),
      title: document.title,
      version: app.version,
    });
    log.write('SETTINGS', {
      autoSave: currentSettings.autoSave,
      saveLog: currentSettings.saveLog,
      autoClosePanel: currentSettings.autoClosePanel,
      extraPassesEnabled: currentSettings.extraPassesEnabled,
      extraPassCount: currentSettings.extraPassCount,
      minDelayMs: currentSettings.minDelayMs,
      maxDelayMs: currentSettings.maxDelayMs,
    });
    log.write('ADAPTER_SELECTED', {
      id: runtime.adapter.id,
      name: runtime.adapter.displayName,
      score: detection.score,
      acquisitionMode: 'local-cache',
      localCacheAccess: runtime.adapter.localCacheAccess || 'isolated-content-script-readonly',
      reloadBeforeRead: runtime.adapter.reloadBeforeLocalCacheRead === true,
    });
    log.write('LOCAL_CACHE_SELECTED', {
      databaseName: config.databaseName,
      storeName: config.storeName,
      key: config.key,
      sessionId: config.sessionId || null,
      access: 'read-only',
      executionWorld: 'ISOLATED',
      reader: 'content-script-indexeddb',
    });

    if (syncState) {
      log.write('PAGE_RELOAD_REQUESTED', {
        reason: 'local-cache-sync',
        requestedAt: syncState.reloadRequestedAt ?? null,
      });
      log.write('PAGE_RELOAD_COMPLETED', {
        reason: 'local-cache-sync',
        completedAt: syncState.reloadCompletedAt ?? null,
        reloadDurationMs: syncState.reloadRequestedAt && syncState.reloadCompletedAt
          ? syncState.reloadCompletedAt - syncState.reloadRequestedAt
          : null,
      });
      log.write('LOCAL_CACHE_SYNC_READY', {
        sessionId: config.sessionId || null,
        reloadCompletedAt: syncState.reloadCompletedAt ?? null,
      });
      await sendLocalCacheSyncMessage({ type: LOCAL_CACHE_SYNC_RELEASE_MESSAGE }).catch(() => {});
    }

    runtime.panel = panelModule.createPanel({
      startedAt: runtime.startedAt,
      onStop: stopRuntime,
    });
    runtime.panel.setAssistant(runtime.adapter.displayName || runtime.adapter.id);
    configureNetworkPanel(totalPasses);
    runtime.panel.setMessageCount(0);
    runtime.panel.setPass(1, totalPasses);
    runtime.panel.setStatus(syncState ? 'Жду синхронизацию DeepSeek...' : 'Читаю локальную историю...');

    const reads = [];
    for (let pass = 1; pass <= totalPasses; pass += 1) {
      if (runtime.aborted) {
        return false;
      }

      const passContext = {
        pass,
        totalPasses,
        extraPass: pass > 1,
      };
      runtime.panel.setPass(pass, totalPasses);
      runtime.panel.setStatus(formatPassStatus(
        passContext,
        pass === 1 && syncState ? 'Проверяю обновление локальной истории...' : 'Читаю локальную историю...',
        pass === 1 && syncState ? 'проверяю обновление локальной истории...' : 'читаю локальную историю...',
      ));
      log.write('PASS_STARTED', {
        ...passContext,
        acquisitionMode: 'local-cache',
        readsBefore: reads.length,
      });

      const result = await readLocalCacheRecordWithRetry(config, passContext, {
        requireStable: pass === 1 && Boolean(syncState),
        minReadyAt: pass === 1 && syncState?.reloadCompletedAt
          ? syncState.reloadCompletedAt + LOCAL_CACHE_POST_RELOAD_MIN_WAIT_MS
          : 0,
      });
      if (!result || runtime.aborted) {
        return false;
      }
      reads.push({
        pass,
        databaseVersion: result.databaseVersion ?? null,
        record: result.record,
      });

      log.write('PASS_COMPLETED', {
        ...passContext,
        acquisitionMode: 'local-cache',
        readsAfter: reads.length,
      });

      if (pass < totalPasses) {
        runtime.panel.setStatus('Готовлю дополнительный проход...');
        const completed = await waitConfiguredDelay(currentSettings, 'between-local-cache-passes');
        if (!completed || runtime.aborted) {
          return false;
        }
      }
    }

    runtime.panel.setStatus('Проверяю данные...');
    const parsed = runtime.adapter.parseLocalCacheReads(reads);
    const finalStats = parsed.stats;
    const diagnostics = parsed.diagnostics || {};

    for (const passStats of diagnostics.passStats || []) {
      log.write('MESSAGE_BATCH', {
        reason: 'local-cache-pass',
        pass: passStats.pass,
        totalPasses,
        extraPass: passStats.pass > 1,
        received: passStats.received,
        added: passStats.added,
        updated: passStats.updated,
        duplicates: passStats.duplicates,
        malformed: passStats.malformed,
        cacheControl: passStats.cacheControl ?? null,
        version: passStats.version ?? null,
        total: passStats.totalAfterPass ?? finalStats.total,
        user: finalStats.user,
        assistant: finalStats.assistant,
        other: finalStats.other,
      });
    }

    log.write('LOCAL_CACHE_PARSED', {
      adapter: runtime.adapter.id,
      reads: reads.length,
      sourceMessages: diagnostics.sourceMessages ?? null,
      uniqueMessageIds: diagnostics.uniqueMessageIds ?? null,
    });

    for (const entry of diagnostics.logEntries || []) {
      if (entry?.event) {
        log.write(entry.event, entry.details || {});
      }
    }

    runtime.panel.setMessageCount(finalStats.total);
    runtime.panel.stopTimer();
    runtime.panel.setStatus('Формирую файл...');

    const artifact = buildNetworkMarkdownArtifact(parsed.conversation);
    const workDurationMs = Date.now() - runtime.startedAt;
    const passAdditions = (diagnostics.passStats || []).map((item) => item.added);

    log.write('EXPORT_READY', {
      format: 'markdown',
      filename: artifact.filename,
      messages: finalStats.total,
      passes: totalPasses,
      extraPasses: Math.max(0, totalPasses - 1),
      passAdditions,
      acquisitionMode: 'local-cache',
      workDurationMs,
      workDuration: loggerModule.formatDuration(workDurationMs),
    });

    if (currentSettings.autoSave) {
      runtime.panel.setStatus('Сохраняю файл...');
      await saveMarkdownArtifact(artifact, 'auto', { saveAs: false });
      runtime.panel.setStatus('Сохранено.');
      runtime.panel.setCloseTitle('Закрыть');
      runtime.panel.markDone();

      const durationMs = Date.now() - runtime.startedAt;
      log.write('COMPLETED', {
        reason: `${runtime.adapter.id}-local-cache-markdown-export`,
        messages: finalStats.total,
        user: finalStats.user,
        assistant: finalStats.assistant,
        passes: totalPasses,
        extraPasses: Math.max(0, totalPasses - 1),
        passAdditions,
        acquisitionMode: 'local-cache',
        workDurationMs,
        workDuration: loggerModule.formatDuration(workDurationMs),
        durationMs,
        duration: loggerModule.formatDuration(durationMs),
        filename: artifact.filename,
      });
      if (currentSettings.autoClosePanel) {
        log.write('PANEL_AUTO_CLOSE', { reason: 'auto-save' });
      }
      await log.saveOnce('COMPLETED');
      if (currentSettings.autoClosePanel) {
        runtime.panel?.remove?.();
      }
      return false;
    }

    runtime.panel.setStatus('Сбор завершен.');
    runtime.panel.setCloseTitle('Закрыть');
    runtime.panel.markDone();
    log.write('WAITING_FOR_SAVE_DECISION', {
      messages: finalStats.total,
      passes: totalPasses,
      filename: artifact.filename,
    });

    const action = await waitForManualExportAction(artifact, finalStats);
    if (runtime.aborted || action.state === 'aborted') {
      return false;
    }

    if (action.state === 'cancelled') {
      log.write('COMPLETED', {
        reason: 'markdown-save-cancelled',
        messages: finalStats.total,
        passes: totalPasses,
        workDurationMs,
        workDuration: loggerModule.formatDuration(workDurationMs),
      });
      await log.saveOnce('CANCELLED');
      return false;
    }

    const durationMs = Date.now() - runtime.startedAt;
    log.write('COMPLETED', {
      reason: `${runtime.adapter.id}-local-cache-markdown-export-manual`,
      messages: finalStats.total,
      user: finalStats.user,
      assistant: finalStats.assistant,
      passes: totalPasses,
      extraPasses: Math.max(0, totalPasses - 1),
      passAdditions,
      acquisitionMode: 'local-cache',
      workDurationMs,
      workDuration: loggerModule.formatDuration(workDurationMs),
      durationMs,
      duration: loggerModule.formatDuration(durationMs),
      filename: artifact.filename,
    });
    if (currentSettings.autoClosePanel) {
      log.write('PANEL_AUTO_CLOSE', { reason: 'manual-save' });
    }
    await log.saveOnce('COMPLETED');
    if (currentSettings.autoClosePanel) {
      runtime.panel?.remove?.();
    }
    return false;
  }


  async function runNetworkAdapter(currentSettings, detection) {
    runtime.networkMode = true;
    runtime.adapter = detection.adapter;
    runtime.stop = stopRuntime;

    const configuredExtraPasses = currentSettings.extraPassesEnabled
      ? settings.clampExtraPassCount(currentSettings.extraPassCount)
      : 0;
    const totalPasses = 1 + configuredExtraPasses;
    const config = runtime.adapter.getNetworkCaptureConfig?.();
    if (!config?.urlPattern || typeof runtime.adapter.parseNetworkCaptures !== 'function') {
      throw new Error(`${runtime.adapter.displayName || runtime.adapter.id}: сетевой адаптер настроен неполно.`);
    }

    let stateResponse = await sendCaptureMessage({
      type: CAPTURE_GET_STATE_MESSAGE,
      includeCaptures: false,
    });
    let state = stateResponse.state;

    if (!state) {
      runtime.panel = panelModule.createPanel({
        startedAt: runtime.startedAt,
        onStop: stopRuntime,
      });
      runtime.panel.setAssistant(runtime.adapter.displayName || runtime.adapter.id);
      configureNetworkPanel(totalPasses);
      runtime.panel.setMessageCount(0);
      runtime.panel.setPass(1, totalPasses);
      runtime.panel.setStatus('Подключаюсь...');

      const startResponse = await sendCaptureMessage({
        type: CAPTURE_START_MESSAGE,
        adapterId: runtime.adapter.id,
        adapterName: runtime.adapter.displayName || runtime.adapter.id,
        adapterVariant: runtime.adapter.variant || null,
        adapterScore: detection.score,
        urlPattern: config.urlPattern,
        requestMethod: config.method || null,
        requestResourceType: config.resourceType || null,
        responseProcessor: config.responseProcessor || null,
        expectedShareId: config.expectedShareId || null,
        timeoutMs: config.timeoutMs || 60_000,
        totalPasses,
        minDelayMs: currentSettings.minDelayMs,
        maxDelayMs: currentSettings.maxDelayMs,
        version: app.version,
        page: loggerModule.sanitizePageUrl(),
        title: document.title,
        settings: currentSettings,
      });
      state = startResponse.state;
      if (state?.startedAt) {
        runtime.startedAt = state.startedAt;
        log.setStartedAt?.(state.startedAt);
      }
      updateNetworkPanel(state);

      if (state?.phase === 'error') {
        log.importEntries?.(state.events || []);
        await sendCaptureMessage({ type: CAPTURE_RELEASE_MESSAGE }).catch(() => {});
        throw new Error(state.error || 'Не удалось запустить сетевой захват.');
      }

      // Page.reload выполняется background-процессом. Текущий document будет уничтожен,
      // а runtime автоматически внедрится снова после завершения навигации.
      return true;
    }

    if (state.adapterId !== runtime.adapter.id) {
      throw new Error(`Во вкладке уже активен сетевой захват адаптера ${state.adapterId}.`);
    }

    if (state.startedAt) {
      runtime.startedAt = state.startedAt;
      log.setStartedAt?.(state.startedAt);
    }

    runtime.panel = panelModule.createPanel({
      startedAt: runtime.startedAt,
      onStop: stopRuntime,
    });
    runtime.panel.setAssistant(runtime.adapter.displayName || runtime.adapter.id);
    configureNetworkPanel(state.totalPasses || totalPasses);
    runtime.panel.setMessageCount(0);
    updateNetworkPanel(state);

    state = await waitForNetworkCaptureState(state);
    if (!state || runtime.aborted) {
      return;
    }

    if (state.phase === 'cancelled') {
      log.importEntries?.(state.events || []);
      await log.saveOnce('CANCELLED');
      return;
    }

    if (state.phase === 'error') {
      log.importEntries?.(state.events || []);
      const message = state.error || 'Сетевой захват завершился ошибкой.';
      log.write('ERROR', { message });
      runtime.panel.setStatus(`Ошибка: ${message}`);
      runtime.panel.markError();
      await log.saveOnce('ERROR');
      await sendCaptureMessage({ type: CAPTURE_RELEASE_MESSAGE }).catch(() => {});
      return;
    }

    stateResponse = await sendCaptureMessage({
      type: CAPTURE_GET_STATE_MESSAGE,
      includeCaptures: true,
    });
    state = stateResponse.state;
    if (!state || state.phase !== 'ready' || !Array.isArray(state.captures)) {
      throw new Error('Сетевой захват завершен без доступных данных ответа.');
    }

    // После получения тел сетевой debugger больше не нужен. Отключаем его до парсинга/сохранения.
    let releaseState = null;
    try {
      const releaseResponse = await sendCaptureMessage({ type: CAPTURE_RELEASE_MESSAGE });
      releaseState = releaseResponse.state || null;
    } catch (error) {
      log.write('DEBUGGER_RELEASE_FAILED', {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    log.importEntries?.(releaseState?.events || state.events || []);

    runtime.panel.setStatus('Разбираю данные...');
    const parsed = runtime.adapter.parseNetworkCaptures(state.captures);
    const finalStats = parsed.stats;
    const diagnostics = parsed.diagnostics || {};

    for (const passStats of diagnostics.passStats || []) {
      log.write('MESSAGE_BATCH', {
        reason: 'network-pass',
        pass: passStats.pass,
        totalPasses: state.totalPasses,
        extraPass: passStats.pass > 1,
        received: passStats.received,
        added: passStats.added,
        updated: passStats.updated,
        duplicates: passStats.duplicates,
        malformed: passStats.malformed,
        total: passStats.totalAfterPass ?? finalStats.total,
        user: finalStats.user,
        assistant: finalStats.assistant,
        other: finalStats.other,
      });
    }

    log.write(runtime.adapter.parseEvent || 'JSON_PARSED', {
      adapter: runtime.adapter.id,
      captures: state.captures.length,
      sourceMessages: diagnostics.sourceMessages ?? null,
      uniqueMessageIds: diagnostics.uniqueMessageIds ?? null,
    });

    for (const entry of diagnostics.logEntries || []) {
      if (!entry?.event) {
        continue;
      }
      log.write(entry.event, entry.details || {});
    }

    runtime.panel.setMessageCount(finalStats.total);
    runtime.panel.stopTimer();
    runtime.panel.setStatus('Формирую файл...');

    const artifact = buildNetworkMarkdownArtifact(parsed.conversation);
    const workDurationMs = Date.now() - runtime.startedAt;
    const passAdditions = (diagnostics.passStats || []).map((item) => item.added);

    log.write('EXPORT_READY', {
      format: 'markdown',
      filename: artifact.filename,
      messages: finalStats.total,
      passes: state.totalPasses,
      extraPasses: Math.max(0, state.totalPasses - 1),
      passAdditions,
      acquisitionMode: 'network',
      workDurationMs,
      workDuration: loggerModule.formatDuration(workDurationMs),
    });

    if (currentSettings.autoSave) {
      runtime.panel.setStatus('Сохраняю файл...');
      await saveMarkdownArtifact(artifact, 'auto', { saveAs: false });
      runtime.panel.setStatus('Сохранено.');
      runtime.panel.setCloseTitle('Закрыть');
      runtime.panel.markDone();

      const durationMs = Date.now() - runtime.startedAt;
      log.write('COMPLETED', {
        reason: `${runtime.adapter.id}-network-markdown-export`,
        messages: finalStats.total,
        user: finalStats.user,
        assistant: finalStats.assistant,
        passes: state.totalPasses,
        extraPasses: Math.max(0, state.totalPasses - 1),
        passAdditions,
        acquisitionMode: 'network',
        workDurationMs,
        workDuration: loggerModule.formatDuration(workDurationMs),
        durationMs,
        duration: loggerModule.formatDuration(durationMs),
        filename: artifact.filename,
      });
      if (currentSettings.autoClosePanel) {
        log.write('PANEL_AUTO_CLOSE', { reason: 'auto-save' });
      }
      await log.saveOnce('COMPLETED');
      if (currentSettings.autoClosePanel) {
        runtime.panel?.remove?.();
      }
      return;
    }

    runtime.panel.setStatus('Сбор завершен.');
    runtime.panel.setCloseTitle('Закрыть');
    runtime.panel.markDone();
    log.write('WAITING_FOR_SAVE_DECISION', {
      messages: finalStats.total,
      passes: state.totalPasses,
      filename: artifact.filename,
    });

    const action = await waitForManualExportAction(artifact, finalStats);
    if (runtime.aborted || action.state === 'aborted') {
      return;
    }

    if (action.state === 'cancelled') {
      log.write('COMPLETED', {
        reason: 'markdown-save-cancelled',
        messages: finalStats.total,
        passes: state.totalPasses,
        workDurationMs,
        workDuration: loggerModule.formatDuration(workDurationMs),
      });
      await log.saveOnce('CANCELLED');
      return;
    }

    const durationMs = Date.now() - runtime.startedAt;
    log.write('COMPLETED', {
      reason: `${runtime.adapter.id}-network-markdown-export-manual`,
      messages: finalStats.total,
      user: finalStats.user,
      assistant: finalStats.assistant,
      passes: state.totalPasses,
      extraPasses: Math.max(0, state.totalPasses - 1),
      passAdditions,
      acquisitionMode: 'network',
      workDurationMs,
      workDuration: loggerModule.formatDuration(workDurationMs),
      durationMs,
      duration: loggerModule.formatDuration(durationMs),
      filename: artifact.filename,
    });
    if (currentSettings.autoClosePanel) {
      log.write('PANEL_AUTO_CLOSE', { reason: 'manual-save' });
    }
    await log.saveOnce('COMPLETED');
    if (currentSettings.autoClosePanel) {
      runtime.panel?.remove?.();
    }
  }

  async function run() {
    runtime.stop = stopRuntime;
    runtime.settingsPromise = settings.loadSettings();
    const currentSettings = await resolveSettings();

    if (runtime.aborted) {
      await log.saveOnce('CANCELLED');
      return;
    }

    const detection = adapterRegistry.detect();
    runtime.adapter = detection?.adapter || null;

    if (!runtime.adapter) {
      throw new Error('Не удалось определить адаптер страницы.');
    }

    if (runtime.adapter.acquisitionMode === 'local-cache') {
      try {
        const reloadPending = await runLocalCacheAdapter(currentSettings, detection);
        if (!reloadPending) {
          runtime.running = false;
        }
      } catch (error) {
        console.warn('Chat Context Exporter: ошибка локального адаптера.', error);
        const message = error instanceof Error ? error.message : String(error);
        log.write('ERROR', { message });
        runtime.panel?.setStatus(`Ошибка: ${message}`);
        runtime.panel?.markError();
        runtime.running = false;
        await sendLocalCacheSyncMessage({ type: LOCAL_CACHE_SYNC_RELEASE_MESSAGE }).catch(() => {});
        await log.saveOnce('ERROR');
      }
      return;
    }

    if (runtime.adapter.acquisitionMode === 'network') {
      try {
        const capturePending = await runNetworkAdapter(currentSettings, detection);
        if (!capturePending) {
          runtime.running = false;
        }
      } catch (error) {
        console.warn('Chat Context Exporter: ошибка сетевого адаптера.', error);
        const message = error instanceof Error ? error.message : String(error);
        log.write('ERROR', { message });
        runtime.panel?.setStatus(`Ошибка: ${message}`);
        runtime.panel?.markError();
        runtime.running = false;
        await log.saveOnce('ERROR');
      }
      return;
    }

    const configuredExtraPasses = currentSettings.extraPassesEnabled
      ? settings.clampExtraPassCount(currentSettings.extraPassCount)
      : 0;

    log.write('START', {
      page: loggerModule.sanitizePageUrl(),
      title: document.title,
      version: app.version,
    });

    runtime.panel = panelModule.createPanel({
      startedAt: runtime.startedAt,
      onStop: stopRuntime,
    });
    runtime.panel.setMethod('DOM');

    log.write('SETTINGS', {
      autoSave: currentSettings.autoSave,
      saveLog: currentSettings.saveLog,
      autoClosePanel: currentSettings.autoClosePanel,
      extraPassesEnabled: currentSettings.extraPassesEnabled,
      extraPassCount: currentSettings.extraPassCount,
      minDelayMs: currentSettings.minDelayMs,
      maxDelayMs: currentSettings.maxDelayMs,
    });

    runtime.panel.setAssistant(runtime.adapter.displayName || runtime.adapter.id);
    log.write('ADAPTER_SELECTED', {
      id: runtime.adapter.id,
      name: runtime.adapter.displayName,
      score: detection.score,
      supportsMessageCollection: Boolean(runtime.adapter.supportsMessageCollection),
      acquisitionMode: 'dom',
      variant: runtime.adapter.variant || null,
      scrollMode: getScrollMode(),
    });

    let scrollContainer = runtime.adapter.findScroller?.();
    if (!scrollContainer) {
      scrollContainer = scroller.findGenericScrollContainer();
      log.write('ADAPTER_SCROLLER_FALLBACK', { adapter: runtime.adapter.id });
    }

    runtime.scrollContainer = scrollContainer;
    runtime.panel.setMessageCount(0);
    runtime.panel.setStatus('Едем к началу истории...');
    log.write('SCROLL_CONTAINER_SELECTED', {
      container: scroller.describeElement(scrollContainer),
      panelLabel: runtime.adapter.scrollerLabel || null,
      scrollTop: Math.round(scrollContainer.scrollTop),
      scrollHeight: scrollContainer.scrollHeight,
      clientHeight: scrollContainer.clientHeight,
    });

    try {
      if (!runtime.adapter.supportsMessageCollection) {
        const passContext = { pass: 1, totalPasses: 1, extraPass: false };
        runtime.panel.setPass(1, 1);
        const seekResult = await seekHistoryStart(currentSettings, passContext);
        if (!seekResult || runtime.aborted) {
          return;
        }

        const durationMs = Date.now() - runtime.startedAt;
        runtime.panel.setStatus('Готово: верх истории достигнут.');
        runtime.panel.markDone();
        log.write('COMPLETED', {
          reason: 'current-top-boundary',
          messages: 0,
          durationMs,
          duration: loggerModule.formatDuration(durationMs),
        });
        await log.saveOnce('COMPLETED');
        return;
      }

      const totalPasses = 1 + configuredExtraPasses;
      runtime.collector = collectorModule.createCollector(runtime.adapter);
      runtime.panel.setPass(1, totalPasses);

      const passResults = [];
      let totalSeekDurationMs = 0;
      let totalCollectDurationMs = 0;

      for (let pass = 1; pass <= totalPasses; pass += 1) {
        if (runtime.aborted) {
          return;
        }

        const passContext = {
          pass,
          totalPasses,
          extraPass: pass > 1,
        };
        const beforeStats = runtime.collector.getStats();
        const passStartedAt = Date.now();
        runtime.panel.setPass(pass, totalPasses);

        log.write('PASS_STARTED', {
          ...passContext,
          messagesBefore: beforeStats.total,
          userBefore: beforeStats.user,
          assistantBefore: beforeStats.assistant,
        });
        const passStartState = runtime.adapter.getHistoryEndState?.(runtime.scrollContainer) || null;
        logBoundaryState(
          'PASS_START_VIEW',
          passStartState ? { ...passContext, ...passStartState } : null,
        );

        const seekResult = await seekHistoryStart(currentSettings, passContext);
        if (!seekResult || runtime.aborted) {
          return;
        }

        const collectResult = await collectHistoryDown(currentSettings, passContext);
        if (!collectResult || runtime.aborted) {
          return;
        }

        const afterStats = runtime.collector.getStats();
        const passDurationMs = Date.now() - passStartedAt;
        const addedThisPass = Math.max(0, afterStats.total - beforeStats.total);
        totalSeekDurationMs += seekResult.durationMs;
        totalCollectDurationMs += collectResult.durationMs;

        const passResult = {
          pass,
          added: addedThisPass,
          total: afterStats.total,
          seekDurationMs: seekResult.durationMs,
          collectDurationMs: collectResult.durationMs,
          durationMs: passDurationMs,
          collectionComplete: collectResult.collectionComplete !== false,
          expectedTurnCount: collectResult.expectedTurnCount ?? null,
          observedTurnCount: collectResult.observedTurnCount ?? null,
          resolvedTurnCount: collectResult.resolvedTurnCount ?? null,
          missingTurnCount: collectResult.missingTurnCount ?? null,
          unresolvedTurnCount: collectResult.unresolvedTurnCount ?? null,
          fallbackMessageTurnCount: collectResult.fallbackMessageTurnCount ?? null,
          transientTurnCount: collectResult.transientTurnCount ?? null,
        };
        passResults.push(passResult);

        log.write('PASS_COMPLETED', {
          ...passContext,
          messagesBefore: beforeStats.total,
          messagesAfter: afterStats.total,
          added: addedThisPass,
          updatedDuringSeek: seekResult.updatedDuringPhase,
          updatedDuringCollect: collectResult.updatedDuringPhase,
          collectionComplete: collectResult.collectionComplete !== false,
          expectedTurnCount: collectResult.expectedTurnCount ?? null,
          observedTurnCount: collectResult.observedTurnCount ?? null,
          resolvedTurnCount: collectResult.resolvedTurnCount ?? null,
          missingTurnCount: collectResult.missingTurnCount ?? null,
          unresolvedTurnCount: collectResult.unresolvedTurnCount ?? null,
          fallbackMessageTurnCount: collectResult.fallbackMessageTurnCount ?? null,
          transientTurnCount: collectResult.transientTurnCount ?? null,
          durationMs: passDurationMs,
          duration: loggerModule.formatDuration(passDurationMs),
        });
      }

      const finalStats = runtime.collector.getStats();
      const collectionFinishedAt = Date.now();
      const workDurationMs = collectionFinishedAt - runtime.startedAt;
      runtime.panel.setMessageCount(finalStats.total);
      runtime.panel.stopTimer();
      runtime.panel.setStatus('Формирую файл...');

      const artifact = buildMarkdownArtifact();
      log.write('EXPORT_READY', {
        format: 'markdown',
        filename: artifact.filename,
        messages: finalStats.total,
        passes: totalPasses,
        extraPasses: configuredExtraPasses,
        passAdditions: passResults.map((item) => item.added),
        workDurationMs,
        workDuration: loggerModule.formatDuration(workDurationMs),
      });

      if (currentSettings.autoSave) {
        runtime.panel.setStatus('Сохраняю файл...');
        await saveMarkdownArtifact(artifact, 'auto', { saveAs: false });
        runtime.panel.setStatus('Сохранено.');
        runtime.panel.setCloseTitle('Закрыть');
        runtime.panel.markDone();

        const durationMs = Date.now() - runtime.startedAt;
        log.write('COMPLETED', {
          reason: `${runtime.adapter.id}-markdown-export`,
          messages: finalStats.total,
          user: finalStats.user,
          assistant: finalStats.assistant,
          passes: totalPasses,
          extraPasses: configuredExtraPasses,
          passAdditions: passResults.map((item) => item.added),
          seekDurationMs: totalSeekDurationMs,
          collectDurationMs: totalCollectDurationMs,
          workDurationMs,
          workDuration: loggerModule.formatDuration(workDurationMs),
          durationMs,
          duration: loggerModule.formatDuration(durationMs),
          filename: artifact.filename,
        });
        if (currentSettings.autoClosePanel) {
          log.write('PANEL_AUTO_CLOSE', { reason: 'auto-save' });
        }
        await log.saveOnce('COMPLETED');
        if (currentSettings.autoClosePanel) {
          runtime.panel?.remove?.();
        }
        return;
      }

      runtime.panel.setStatus('Сбор завершен.');
      runtime.panel.setCloseTitle('Закрыть');
      runtime.panel.markDone();
      log.write('WAITING_FOR_SAVE_DECISION', {
        messages: finalStats.total,
        passes: totalPasses,
        filename: artifact.filename,
      });

      const action = await waitForManualExportAction(artifact, finalStats);
      if (runtime.aborted || action.state === 'aborted') {
        return;
      }

      if (action.state === 'cancelled') {
        log.write('COMPLETED', {
          reason: 'markdown-save-cancelled',
          messages: finalStats.total,
          passes: totalPasses,
          workDurationMs,
          workDuration: loggerModule.formatDuration(workDurationMs),
        });
        await log.saveOnce('CANCELLED');
        return;
      }

      const durationMs = Date.now() - runtime.startedAt;
      log.write('COMPLETED', {
        reason: `${runtime.adapter.id}-markdown-export-manual`,
        messages: finalStats.total,
        user: finalStats.user,
        assistant: finalStats.assistant,
        passes: totalPasses,
        extraPasses: configuredExtraPasses,
        passAdditions: passResults.map((item) => item.added),
        seekDurationMs: totalSeekDurationMs,
        collectDurationMs: totalCollectDurationMs,
        workDurationMs,
        workDuration: loggerModule.formatDuration(workDurationMs),
        durationMs,
        duration: loggerModule.formatDuration(durationMs),
        filename: artifact.filename,
      });
      if (currentSettings.autoClosePanel) {
        log.write('PANEL_AUTO_CLOSE', { reason: 'manual-save' });
      }
      await log.saveOnce('COMPLETED');
      if (currentSettings.autoClosePanel) {
        runtime.panel?.remove?.();
      }
    } catch (error) {
      console.warn('Chat Context Exporter: ошибка выполнения.', error);
      const message = error instanceof Error ? error.message : String(error);
      log.write('ERROR', { message });
      runtime.panel?.setStatus(`Ошибка: ${message}`);
      runtime.panel?.markError();
      await log.saveOnce('ERROR');
    } finally {
      runtime.running = false;
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== CAPTURE_STATUS_MESSAGE || !runtime.networkMode) {
      return false;
    }
    updateNetworkPanel(message.state || null);
    return false;
  });

  run().catch((error) => {
    console.error('Chat Context Exporter: необработанная ошибка.', error);
    const message = error instanceof Error ? error.message : String(error);
    log.write('UNHANDLED_ERROR', { message });
    runtime.panel?.setStatus(`Ошибка: ${message}`);
    runtime.panel?.markError();
    runtime.running = false;
    void log.saveOnce('UNHANDLED_ERROR');
  });
})();
