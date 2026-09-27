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
    operationStep: 0,
    stop: null,
  };

  globalThis[APP_KEY] = runtime;

  const MAX_ITERATIONS = 1000;
  const TOP_EPSILON_PX = 2;
  const BOTTOM_EPSILON_PX = 2;
  const TOP_STABILITY_CHECKS = 2;
  const BOTTOM_STABILITY_CHECKS = 2;
  const SEMANTIC_BOUNDARY_MAX_STABLE_CHECKS = 5;
  const SCROLL_MOVEMENT_EPSILON_PX = 1;
  const MAX_CONSECUTIVE_STALLED_SCROLLS = 3;

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

  function setPanelScrollState(element) {
    const state = scroller.readScrollState(element);
    runtime.panel?.setPosition(state.top, state.height, state.client);
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
    const recovery = scroller.scrollToDirect(scrollContainer, command.target);

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
            runtime.panel.setStatus(`Сохранено: ${stats.total} сообщений.`);
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
          runtime.panel.hideActions();
          runtime.panel.setStatus('Сохранение отменено.');
          runtime.panel.setCloseTitle('Закрыть');
          runtime.panel.markDone();
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
    let scrollCommands = 0;
    let effectiveMoves = 0;
    let consecutiveStalledScrolls = 0;
    let addedDuringPhase = 0;
    let updatedDuringPhase = 0;
    const phaseStartedAt = Date.now();

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

      if (scroller.isAtTop(scrollContainer, TOP_EPSILON_PX)) {
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
        const topStillReached = scroller.isAtTop(scrollContainer, TOP_EPSILON_PX);
        const heightUnchanged = previousTopHeight !== null && afterWait.height === previousTopHeight;
        const boundaryState = runtime.adapter.getHistoryStartState?.(scrollContainer) || null;
        const semanticReached = boundaryState ? Boolean(boundaryState.reached) : true;

        log.write('TOP_CHECK', {
          ...passContext,
          scrollTop: Math.round(afterWait.top),
          scrollHeight: afterWait.height,
          topStillReached,
          heightUnchanged,
          semanticReached,
          stableTopChecks,
          messages: batch?.total ?? runtime.collector?.getStats?.().total ?? 0,
        });
        logBoundaryState('HISTORY_START_SIGNAL', boundaryState ? { ...passContext, ...boundaryState } : null);

        if (topStillReached && heightUnchanged) {
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

        previousTopHeight = afterWait.height;

        if (topStillReached && stableTopChecks >= TOP_STABILITY_CHECKS && semanticReached) {
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

        if (
          boundaryState
          && stableTopChecks >= SEMANTIC_BOUNDARY_MAX_STABLE_CHECKS
          && !semanticReached
        ) {
          throw new Error('Grok: верхняя позиция стабильна, но DOM-признак начала истории не подтвержден.');
        }

        continue;
      }

      stableTopChecks = 0;
      semanticStableChecks = 0;
      previousTopHeight = null;
      runtime.panel.setStatus(formatPassStatus(
        passContext,
        'Едем к началу истории...',
        'еду к началу истории...',
      ));

      const command = scroller.scrollUpOneStep(scrollContainer);
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

      if (scroller.isAtBottom(scrollContainer, BOTTOM_EPSILON_PX)) {
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
        const bottomStillReached = scroller.isAtBottom(scrollContainer, BOTTOM_EPSILON_PX);
        const heightUnchanged = previousBottomHeight !== null && afterWait.height === previousBottomHeight;
        const boundaryState = runtime.adapter.getHistoryEndState?.(scrollContainer) || null;
        const semanticReached = boundaryState ? Boolean(boundaryState.reached) : true;
        const batch = collectForPhase('bottom-check');

        log.write('BOTTOM_CHECK', {
          ...passContext,
          scrollTop: Math.round(afterWait.top),
          scrollHeight: afterWait.height,
          bottomStillReached,
          heightUnchanged,
          semanticReached,
          stableBottomChecks,
          physicalBottomChecks,
          messages: batch?.total ?? runtime.collector.getStats().total,
        });
        logBoundaryState('HISTORY_END_SIGNAL', boundaryState ? { ...passContext, ...boundaryState } : null);

        if (bottomStillReached && heightUnchanged) {
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
            durationMs: phaseDurationMs,
            duration: loggerModule.formatDuration(phaseDurationMs),
          });

          return {
            ...stats,
            scrollCommands,
            effectiveMoves,
            addedDuringPhase,
            updatedDuringPhase,
            durationMs: phaseDurationMs,
          };
        }

        if (
          boundaryState
          && physicalBottomChecks >= SEMANTIC_BOUNDARY_MAX_STABLE_CHECKS
          && !semanticReached
        ) {
          throw new Error('Grok: нижняя позиция стабильна, но DOM-признак конца истории не подтвержден.');
        }

        continue;
      }

      stableBottomChecks = 0;
      physicalBottomChecks = 0;
      previousBottomHeight = null;
      runtime.panel.setStatus(formatPassStatus(
        passContext,
        'Добираю историю вниз...',
        'добираю историю вниз...',
      ));

      const command = scroller.scrollDownOneStep(scrollContainer);
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

  async function run() {
    runtime.stop = stopRuntime;

    log.write('START', {
      page: loggerModule.sanitizePageUrl(),
      title: document.title,
      version: app.version,
    });

    runtime.panel = panelModule.createPanel({
      startedAt: runtime.startedAt,
      onStop: stopRuntime,
    });

    runtime.settingsPromise = settings.loadSettings();
    const currentSettings = await resolveSettings();
    const configuredExtraPasses = currentSettings.extraPassesEnabled
      ? settings.clampExtraPassCount(currentSettings.extraPassCount)
      : 0;

    log.write('SETTINGS', {
      autoSave: currentSettings.autoSave,
      saveLog: currentSettings.saveLog,
      autoClosePanel: currentSettings.autoClosePanel,
      extraPassesEnabled: currentSettings.extraPassesEnabled,
      extraPassCount: currentSettings.extraPassCount,
      minDelayMs: currentSettings.minDelayMs,
      maxDelayMs: currentSettings.maxDelayMs,
    });

    if (runtime.aborted) {
      await log.saveOnce('CANCELLED');
      return;
    }

    const detection = adapterRegistry.detect();
    runtime.adapter = detection?.adapter || null;

    if (!runtime.adapter) {
      throw new Error('Не удалось определить адаптер страницы.');
    }

    runtime.panel.setAssistant(runtime.adapter.displayName || runtime.adapter.id);
    log.write('ADAPTER_SELECTED', {
      id: runtime.adapter.id,
      name: runtime.adapter.displayName,
      score: detection.score,
      supportsMessageCollection: Boolean(runtime.adapter.supportsMessageCollection),
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
        };
        passResults.push(passResult);

        log.write('PASS_COMPLETED', {
          ...passContext,
          messagesBefore: beforeStats.total,
          messagesAfter: afterStats.total,
          added: addedThisPass,
          updatedDuringSeek: seekResult.updatedDuringPhase,
          updatedDuringCollect: collectResult.updatedDuringPhase,
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
        runtime.panel.setStatus(`Сохранено: ${finalStats.total} сообщений.`);
        runtime.panel.setCloseTitle('Закрыть');
        runtime.panel.markDone();

        const durationMs = Date.now() - runtime.startedAt;
        log.write('COMPLETED', {
          reason: 'grok-markdown-export',
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

      runtime.panel.setStatus(`Сбор завершен: ${finalStats.total} сообщений.`);
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
        reason: 'grok-markdown-export-manual',
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
      console.error('Chat Context Exporter: ошибка выполнения.', error);
      const message = error instanceof Error ? error.message : String(error);
      log.write('ERROR', { message });
      runtime.panel?.setStatus(`Ошибка: ${message}`);
      runtime.panel?.markError();
      await log.saveOnce('ERROR');
    } finally {
      runtime.running = false;
    }
  }

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
