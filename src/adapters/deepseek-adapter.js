(() => {
  'use strict';

  const app = globalThis.__chatContextExporter;
  const registry = app?.modules.adapterRegistry;

  if (!registry) {
    throw new Error('Chat Context Exporter: adapter registry is not initialized.');
  }

  const DATABASE_NAME = 'deepseek-chat';
  const STORE_NAME = 'history-message';
  const UUID_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i;
  const FINAL_FRAGMENT_BY_ROLE = Object.freeze({
    USER: 'REQUEST',
    ASSISTANT: 'RESPONSE',
  });

  function getSessionIdFromLocation() {
    if (!(location.hostname === 'chat.deepseek.com' || location.hostname.endsWith('.deepseek.com'))) {
      return null;
    }

    const match = `${location.pathname}${location.search}${location.hash}`.match(UUID_PATTERN);
    return match?.[1]?.toLowerCase() || null;
  }

  function toSafeInteger(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  function normalizeTimestamp(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) {
      return null;
    }

    const date = new Date(seconds * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  function getSnapshotFromRecord(record, pass) {
    if (!record || typeof record !== 'object') {
      throw new Error(`DeepSeek: локальная запись прохода ${pass} отсутствует.`);
    }

    let source = null;
    let wrapper = record;

    if (Array.isArray(record?.data?.chat_messages)) {
      source = record.data;
    } else if (Array.isArray(record?.chat_messages)) {
      source = record;
    } else if (Array.isArray(record?.data?.biz_data?.chat_messages)) {
      source = record.data.biz_data;
    } else if (Array.isArray(record?.data?.biz_data?.chat_session?.chat_messages)) {
      source = record.data.biz_data.chat_session;
    }

    if (!source) {
      throw new Error(`DeepSeek: локальная запись прохода ${pass} не содержит chat_messages.`);
    }

    const chatSession = source.chat_session && typeof source.chat_session === 'object'
      ? source.chat_session
      : null;
    const wrapperVersion = toSafeInteger(wrapper?.version);
    const sourceVersion = toSafeInteger(source?.version);
    const sessionVersion = toSafeInteger(chatSession?.version);
    const version = wrapperVersion ?? sourceVersion ?? sessionVersion;
    const explicitCurrentMessageId = toSafeInteger(
      source?.current_message_id
      ?? wrapper?.current_message_id
      ?? chatSession?.current_message_id,
    );

    return {
      chatMessages: source.chat_messages,
      cacheControl: typeof source.cache_control === 'string' ? source.cache_control.trim().toUpperCase() : null,
      cacheResetAt: Number.isFinite(Number(source.cache_reset_at)) ? Number(source.cache_reset_at) : null,
      version,
      currentMessageId: explicitCurrentMessageId,
      title: typeof chatSession?.title === 'string' ? chatSession.title.trim() : '',
      sessionId: typeof chatSession?.id === 'string' ? chatSession.id.trim() : '',
    };
  }

  function finalFragmentLength(message) {
    const role = typeof message?.role === 'string' ? message.role.toUpperCase() : '';
    const expectedType = FINAL_FRAGMENT_BY_ROLE[role];
    if (!expectedType || !Array.isArray(message?.fragments)) {
      return 0;
    }

    return message.fragments
      .filter((fragment) => fragment?.type === expectedType && typeof fragment?.content === 'string')
      .reduce((sum, fragment) => sum + fragment.content.length, 0);
  }

  function messageQuality(message) {
    const finishedBonus = message?.status === 'FINISHED' ? 1_000_000 : 0;
    const completeBonus = message?.incomplete_message == null ? 500_000 : 0;
    const finalContentBonus = finalFragmentLength(message) * 10;
    const fragmentBonus = Array.isArray(message?.fragments) ? message.fragments.length : 0;
    return finishedBonus + completeBonus + finalContentBonus + fragmentBonus;
  }

  function mergeReads(reads) {
    const records = new Map();
    const passStats = [];
    const metadataCandidates = [];
    let discoveryIndex = 0;

    for (const read of reads || []) {
      const pass = toSafeInteger(read?.pass) ?? passStats.length + 1;
      const snapshot = getSnapshotFromRecord(read?.record, pass);
      const stats = {
        pass,
        received: snapshot.chatMessages.length,
        added: 0,
        updated: 0,
        duplicates: 0,
        malformed: 0,
        cacheControl: snapshot.cacheControl,
        version: snapshot.version,
      };

      metadataCandidates.push({
        pass,
        version: snapshot.version,
        currentMessageId: snapshot.currentMessageId,
        title: snapshot.title,
        sessionId: snapshot.sessionId,
        cacheControl: snapshot.cacheControl,
        cacheResetAt: snapshot.cacheResetAt,
      });

      for (const message of snapshot.chatMessages) {
        const messageId = toSafeInteger(message?.message_id);
        if (messageId === null) {
          stats.malformed += 1;
          continue;
        }

        const key = String(messageId);
        const quality = messageQuality(message);
        const existing = records.get(key);
        if (!existing) {
          records.set(key, {
            message,
            quality,
            discoveryIndex,
          });
          discoveryIndex += 1;
          stats.added += 1;
          continue;
        }

        const changedAtSameQuality = quality === existing.quality
          && JSON.stringify(message) !== JSON.stringify(existing.message);
        if (quality > existing.quality || changedAtSameQuality) {
          records.set(key, {
            ...existing,
            message,
            quality,
          });
          stats.updated += 1;
        } else {
          stats.duplicates += 1;
        }
      }

      stats.totalAfterPass = records.size;
      passStats.push(stats);
    }

    if (metadataCandidates.length === 0) {
      throw new Error('DeepSeek: локальная история не была прочитана.');
    }

    const metadata = [...metadataCandidates].sort((left, right) => {
      const leftVersion = left.version ?? -1;
      const rightVersion = right.version ?? -1;
      if (leftVersion !== rightVersion) {
        return rightVersion - leftVersion;
      }
      return right.pass - left.pass;
    })[0];

    return { records, passStats, metadata, metadataCandidates };
  }

  function chooseLeafId(records, metadata) {
    const explicit = toSafeInteger(metadata?.currentMessageId);
    if (explicit !== null && records.has(String(explicit))) {
      return explicit;
    }

    const parentIds = new Set();
    for (const { message } of records.values()) {
      const parentId = toSafeInteger(message?.parent_id);
      if (parentId !== null) {
        parentIds.add(String(parentId));
      }
    }

    const leaves = [...records.values()]
      .map(({ message }) => toSafeInteger(message?.message_id))
      .filter((messageId) => messageId !== null && !parentIds.has(String(messageId)));

    if (leaves.length === 1) {
      return leaves[0];
    }

    // В локальной записи DeepSeek version совпадал с current_message_id в
    // подтвержденном fixture. Используем его только для выбора среди нескольких
    // leaf, а не раньше графа: так более свежие сообщения не будут потеряны,
    // если wrapper.version обновился на несколько миллисекунд позже массива.
    const version = toSafeInteger(metadata?.version);
    if (version !== null && leaves.includes(version)) {
      return version;
    }

    throw new Error(`DeepSeek: не удалось однозначно определить текущий leaf: обнаружено ${leaves.length}.`);
  }

  function buildActiveChain(records, metadata) {
    if (records.size === 0) {
      throw new Error('DeepSeek: локальная база не содержит сообщений текущего диалога.');
    }

    const leafId = chooseLeafId(records, metadata);
    const reverseChain = [];
    const visited = new Set();
    let currentId = leafId;
    let rootParentId = null;

    while (currentId !== null) {
      const key = String(currentId);
      if (visited.has(key)) {
        throw new Error(`DeepSeek: обнаружен цикл parent_id около message_id=${currentId}.`);
      }

      const record = records.get(key);
      if (!record) {
        throw new Error(`DeepSeek: активная цепочка разорвана: message_id=${currentId} отсутствует.`);
      }

      visited.add(key);
      reverseChain.push(record.message);
      const rawParent = record.message?.parent_id;
      if (rawParent === null || rawParent === undefined) {
        rootParentId = null;
        break;
      }

      const parentId = toSafeInteger(rawParent);
      if (parentId === null) {
        throw new Error(`DeepSeek: некорректный parent_id у message_id=${currentId}.`);
      }
      if (!records.has(String(parentId))) {
        throw new Error(`DeepSeek: активная цепочка разорвана: parent_id=${parentId} отсутствует.`);
      }
      currentId = parentId;
    }

    const ordered = reverseChain.reverse();
    const firstMessageId = toSafeInteger(ordered[0]?.message_id);
    const lastMessageId = toSafeInteger(ordered.at(-1)?.message_id);

    return {
      ordered,
      leafMessageId: leafId,
      rootMessageId: firstMessageId,
      rootParentId,
      inactiveBranchMessages: Math.max(0, records.size - ordered.length),
      firstMessageId,
      lastMessageId,
    };
  }

  function findSearchResultOrdinal(fragmentById, toolOpenFragment) {
    const referenceId = toSafeInteger(toolOpenFragment?.reference?.id);
    if (referenceId === null) {
      return null;
    }

    const searchFragment = fragmentById.get(referenceId);
    const url = toolOpenFragment?.result?.url;
    if (searchFragment?.type !== 'TOOL_SEARCH' || !Array.isArray(searchFragment.results) || typeof url !== 'string') {
      return null;
    }

    const index = searchFragment.results.findIndex((result) => result?.url === url);
    return index >= 0 ? index + 1 : null;
  }

  function escapeMarkdownDestination(value) {
    return String(value ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/([()])/g, '\\$1')
      .replace(/\s/g, '%20');
  }

  function renderResponseContent(message, responseFragment) {
    let content = typeof responseFragment?.content === 'string' ? responseFragment.content.trim() : '';
    const fragmentById = new Map(
      (Array.isArray(message?.fragments) ? message.fragments : [])
        .map((fragment) => [toSafeInteger(fragment?.id), fragment])
        .filter(([id]) => id !== null),
    );
    const references = Array.isArray(responseFragment?.references) ? responseFragment.references : [];
    let resolvedReferences = 0;
    let unresolvedReferences = 0;

    content = content.replace(/\[reference:(\d+)\]/g, (fullMatch, rawIndex, offset, sourceText) => {
      const referenceIndex = Number(rawIndex);
      const reference = references[referenceIndex];
      if (!reference) {
        unresolvedReferences += 1;
        return fullMatch;
      }

      const fragmentId = toSafeInteger(reference.id);
      const fragment = fragmentId === null ? null : fragmentById.get(fragmentId);
      if (reference.type === 'TOOL_OPEN' && fragment?.type === 'TOOL_OPEN') {
        const url = typeof fragment?.result?.url === 'string' ? fragment.result.url.trim() : '';
        if (url) {
          const ordinal = findSearchResultOrdinal(fragmentById, fragment) ?? referenceIndex + 1;
          const needsLeadingSpace = offset > 0 && !/\s/.test(sourceText[offset - 1]);
          resolvedReferences += 1;
          return `${needsLeadingSpace ? ' ' : ''}[${ordinal}](${escapeMarkdownDestination(url)})`;
        }
      }

      unresolvedReferences += 1;
      return '';
    });

    return { content, resolvedReferences, unresolvedReferences };
  }

  function normalizeMessages(ordered) {
    const messages = [];
    const fragmentTypes = new Map();
    const unsupportedFragmentTypes = new Set();
    let user = 0;
    let assistant = 0;
    let unknownRole = 0;
    let unfinished = 0;
    let incomplete = 0;
    let empty = 0;
    let timestampedMessages = 0;
    let missingTimestampMessages = 0;
    let resolvedReferences = 0;
    let unresolvedReferences = 0;

    for (const message of ordered) {
      const roleName = typeof message?.role === 'string' ? message.role.toUpperCase() : '';
      let role = null;
      if (roleName === 'USER') {
        role = 'user';
      } else if (roleName === 'ASSISTANT') {
        role = 'assistant';
      } else {
        unknownRole += 1;
        continue;
      }

      if (message?.status !== 'FINISHED') {
        unfinished += 1;
      }
      if (message?.incomplete_message != null) {
        incomplete += 1;
      }

      const fragments = Array.isArray(message?.fragments) ? message.fragments : [];
      for (const fragment of fragments) {
        const type = typeof fragment?.type === 'string' ? fragment.type : 'UNKNOWN';
        fragmentTypes.set(type, (fragmentTypes.get(type) || 0) + 1);
        if (!['REQUEST', 'RESPONSE', 'THINK', 'TOOL_SEARCH', 'TOOL_OPEN'].includes(type)) {
          unsupportedFragmentTypes.add(type);
        }
      }

      const expectedType = FINAL_FRAGMENT_BY_ROLE[roleName];
      const finalFragments = fragments.filter((fragment) => fragment?.type === expectedType);
      const blocks = [];

      if (role === 'assistant') {
        for (const fragment of finalFragments) {
          const rendered = renderResponseContent(message, fragment);
          resolvedReferences += rendered.resolvedReferences;
          unresolvedReferences += rendered.unresolvedReferences;
          if (rendered.content) {
            blocks.push({ type: 'markdown', value: rendered.content });
          }
        }
      } else {
        for (const fragment of finalFragments) {
          const content = typeof fragment?.content === 'string' ? fragment.content.trim() : '';
          if (content) {
            blocks.push({ type: 'markdown', value: content });
          }
        }
      }

      if (blocks.length === 0) {
        empty += 1;
      }

      const timestamp = normalizeTimestamp(message?.inserted_at);
      if (timestamp) {
        timestampedMessages += 1;
      } else {
        missingTimestampMessages += 1;
      }

      messages.push({
        id: String(message.message_id),
        role,
        timestamp,
        blocks,
      });

      if (role === 'user') {
        user += 1;
      } else {
        assistant += 1;
      }
    }

    if (unfinished > 0 || incomplete > 0) {
      throw new Error(`DeepSeek: активная цепочка содержит незавершенные сообщения (status!=FINISHED: ${unfinished}; incomplete_message: ${incomplete}).`);
    }

    return {
      messages,
      stats: {
        total: messages.length,
        user,
        assistant,
        other: 0,
        unknownRole,
        unfinished,
        incomplete,
        empty,
        timestampedMessages,
        missingTimestampMessages,
        resolvedReferences,
        unresolvedReferences,
        fragmentTypes: Object.fromEntries([...fragmentTypes.entries()].sort(([a], [b]) => a.localeCompare(b))),
        unsupportedFragmentTypes: [...unsupportedFragmentTypes].sort(),
      },
    };
  }

  registry.register({
    id: 'deepseek',
    displayName: 'DeepSeek',
    acquisitionMode: 'local-cache',
    reloadBeforeLocalCacheRead: true,
    supportsMessageCollection: true,
    panelFields: Object.freeze({
      iteration: false,
      position: false,
    }),

    detect() {
      if (location.hostname === 'chat.deepseek.com' || location.hostname.endsWith('.deepseek.com')) {
        return getSessionIdFromLocation() ? 100 : 70;
      }
      return 0;
    },

    getLocalCacheConfig() {
      const sessionId = getSessionIdFromLocation();
      if (!sessionId) {
        throw new Error('DeepSeek: не удалось определить chat_session_id из адреса текущего чата.');
      }

      return {
        databaseName: DATABASE_NAME,
        storeName: STORE_NAME,
        key: sessionId,
        sessionId,
      };
    },

    parseLocalCacheReads(reads) {
      const { records, passStats, metadata, metadataCandidates } = mergeReads(reads);
      const chain = buildActiveChain(records, metadata);
      const normalized = normalizeMessages(chain.ordered);

      const details = {
        databaseName: DATABASE_NAME,
        storeName: STORE_NAME,
        sessionId: metadata.sessionId || getSessionIdFromLocation(),
        cacheControl: metadata.cacheControl,
        cacheResetAt: metadata.cacheResetAt,
        version: metadata.version,
        currentMessageId: metadata.currentMessageId ?? chain.leafMessageId,
        mergedMessages: records.size,
        activeChainMessages: chain.ordered.length,
        inactiveBranchMessages: chain.inactiveBranchMessages,
        rootMessageId: chain.rootMessageId,
        rootParentId: chain.rootParentId,
        leafMessageId: chain.leafMessageId,
        chainComplete: true,
        user: normalized.stats.user,
        assistant: normalized.stats.assistant,
        unfinished: normalized.stats.unfinished,
        incomplete: normalized.stats.incomplete,
        empty: normalized.stats.empty,
        unknownRole: normalized.stats.unknownRole,
        timestampedMessages: normalized.stats.timestampedMessages,
        missingTimestampMessages: normalized.stats.missingTimestampMessages,
        resolvedReferences: normalized.stats.resolvedReferences,
        unresolvedReferences: normalized.stats.unresolvedReferences,
        fragmentTypes: normalized.stats.fragmentTypes,
        unsupportedFragmentTypes: normalized.stats.unsupportedFragmentTypes,
        readVersions: metadataCandidates.map((item) => item.version),
        readCacheControls: metadataCandidates.map((item) => item.cacheControl),
      };

      return {
        conversation: {
          startedAt: null,
          messages: normalized.messages,
        },
        stats: normalized.stats,
        diagnostics: {
          sourceMessages: chain.ordered.length,
          uniqueMessageIds: records.size,
          passStats,
          logEntries: [
            { event: 'DEEPSEEK_CACHE_STATUS', details },
          ],
        },
      };
    },
  });
})();
