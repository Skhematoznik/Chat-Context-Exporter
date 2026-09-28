(() => {
  'use strict';

  const app = globalThis.__chatContextExporter;
  const registry = app?.modules.adapterRegistry;

  if (!registry) {
    throw new Error('Chat Context Exporter: adapter registry is not initialized.');
  }

  const ROOT_MESSAGE_UUID = '00000000-0000-4000-8000-000000000000';
  const CONVERSATION_PATTERN = '^https://claude\\.ai/api/organizations/[0-9a-f-]+/chat_conversations/[0-9a-f-]+\\?(?=[^#]*tree=true(?:&|$))(?=[^#]*rendering_mode=messages(?:&|$))[^#]+(?:#.*)?$';

  function normalizeTimestamp(value) {
    if (typeof value !== 'string' || !value.trim()) {
      return null;
    }

    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
      return null;
    }

    return date.toISOString();
  }

  function countAttachments(message) {
    let count = 0;
    for (const key of ['attachments', 'files', 'sync_sources']) {
      const value = message?.[key];
      if (Array.isArray(value)) {
        count += value.length;
      } else if (value) {
        count += 1;
      }
    }
    return count;
  }

  function readTextBlocks(message) {
    const blocks = [];
    const unsupportedTypes = [];

    if (Array.isArray(message?.content)) {
      for (const block of message.content) {
        const type = typeof block?.type === 'string' ? block.type : '';
        if (type === 'text') {
          const text = typeof block?.text === 'string' ? block.text.trim() : '';
          if (text) {
            blocks.push({ type: 'markdown', value: text });
          }
          continue;
        }

        if (type) {
          unsupportedTypes.push(type);
        } else if (block && typeof block === 'object') {
          unsupportedTypes.push('(unknown)');
        }
      }
    }

    if (blocks.length === 0) {
      const fallbackText = typeof message?.text === 'string' ? message.text.trim() : '';
      if (fallbackText) {
        blocks.push({ type: 'markdown', value: fallbackText });
      }
    }

    return { blocks, unsupportedTypes };
  }

  function messageQuality(message) {
    const { blocks } = readTextBlocks(message);
    const textLength = blocks.reduce((sum, block) => sum + String(block.value || '').length, 0);
    const completeBonus = message?.truncated === true ? 0 : 1_000_000;
    const endTurnBonus = message?.sender === 'assistant' && message?.stop_reason === 'end_turn'
      ? 100_000
      : 0;
    const attachmentBonus = countAttachments(message) * 10_000;
    return completeBonus + endTurnBonus + attachmentBonus + textLength;
  }

  function chooseConversationMetadata(candidates) {
    if (candidates.length === 0) {
      throw new Error('Claude: сетевые ответы не содержат metadata разговора.');
    }

    return [...candidates].sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt || '') || 0;
      const rightTime = Date.parse(right.updatedAt || '') || 0;
      if (leftTime !== rightTime) {
        return rightTime - leftTime;
      }
      return right.pass - left.pass;
    })[0];
  }

  function mergeCaptures(captures) {
    const records = new Map();
    const passStats = [];
    const metadataCandidates = [];
    let conversationUuid = null;
    let discoveryIndex = 0;

    for (const capture of captures || []) {
      let payload;
      try {
        payload = JSON.parse(String(capture?.body ?? ''));
      } catch (error) {
        throw new Error(`Claude: не удалось разобрать JSON прохода ${capture?.pass ?? '?'}: ${error instanceof Error ? error.message : String(error)}`);
      }

      const currentConversationUuid = typeof payload?.uuid === 'string' ? payload.uuid.trim() : '';
      if (!currentConversationUuid) {
        throw new Error(`Claude: проход ${capture?.pass ?? '?'} не содержит uuid разговора.`);
      }
      if (conversationUuid && conversationUuid !== currentConversationUuid) {
        throw new Error(`Claude: проходы относятся к разным разговорам (${conversationUuid} / ${currentConversationUuid}).`);
      }
      conversationUuid = currentConversationUuid;

      if (!Array.isArray(payload.chat_messages)) {
        throw new Error(`Claude: проход ${capture?.pass ?? '?'} не содержит массив chat_messages.`);
      }

      const currentLeafMessageUuid = typeof payload.current_leaf_message_uuid === 'string'
        ? payload.current_leaf_message_uuid.trim()
        : '';
      if (!currentLeafMessageUuid) {
        throw new Error(`Claude: проход ${capture?.pass ?? '?'} не содержит current_leaf_message_uuid.`);
      }

      metadataCandidates.push({
        pass: capture?.pass ?? metadataCandidates.length + 1,
        uuid: currentConversationUuid,
        name: typeof payload.name === 'string' ? payload.name.trim() : '',
        createdAt: normalizeTimestamp(payload.created_at),
        updatedAt: normalizeTimestamp(payload.updated_at),
        currentLeafMessageUuid,
      });

      const stats = {
        pass: capture?.pass ?? passStats.length + 1,
        received: payload.chat_messages.length,
        added: 0,
        updated: 0,
        duplicates: 0,
        malformed: 0,
      };

      for (const message of payload.chat_messages) {
        const id = typeof message?.uuid === 'string' ? message.uuid.trim() : '';
        if (!id) {
          stats.malformed += 1;
          continue;
        }

        const quality = messageQuality(message);
        const existing = records.get(id);
        if (!existing) {
          records.set(id, {
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
          records.set(id, {
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

    return {
      records,
      passStats,
      metadata: chooseConversationMetadata(metadataCandidates),
    };
  }

  function buildActiveChain(records, metadata) {
    if (records.size === 0) {
      throw new Error('Claude: сетевой ответ не содержит сообщений.');
    }

    const leafId = metadata.currentLeafMessageUuid;
    if (!records.has(leafId)) {
      throw new Error(`Claude: current_leaf_message_uuid=${leafId} отсутствует среди chat_messages.`);
    }

    const reverseChain = [];
    const visited = new Set();
    let currentId = leafId;
    let rootParentMessageUuid = null;

    while (currentId) {
      if (visited.has(currentId)) {
        throw new Error(`Claude: обнаружен цикл parent_message_uuid около uuid=${currentId}.`);
      }

      const record = records.get(currentId);
      if (!record) {
        throw new Error(`Claude: отсутствует сообщение uuid=${currentId}, необходимое для активной ветки.`);
      }

      visited.add(currentId);
      reverseChain.push(record.message);

      const parentId = typeof record.message?.parent_message_uuid === 'string'
        ? record.message.parent_message_uuid.trim()
        : '';

      if (!parentId || parentId === ROOT_MESSAGE_UUID) {
        rootParentMessageUuid = parentId || null;
        break;
      }

      if (!records.has(parentId)) {
        throw new Error(`Claude: активная ветка разорвана: parent_message_uuid=${parentId} отсутствует.`);
      }

      currentId = parentId;
    }

    const ordered = reverseChain.reverse();
    const indices = ordered
      .map((message) => Number(message?.index))
      .filter(Number.isSafeInteger);
    let indexBreaks = 0;
    for (let index = 1; index < indices.length; index += 1) {
      if (indices[index] !== indices[index - 1] + 1) {
        indexBreaks += 1;
      }
    }

    return {
      ordered,
      currentLeafMessageUuid: leafId,
      rootMessageUuid: ordered[0]?.uuid || null,
      rootParentMessageUuid,
      inactiveBranchMessages: Math.max(0, records.size - ordered.length),
      indexBreaks,
      minIndex: indices.length > 0 ? Math.min(...indices) : null,
      maxIndex: indices.length > 0 ? Math.max(...indices) : null,
    };
  }

  function normalizeMessages(ordered) {
    const messages = [];
    const unsupportedContentTypes = new Set();
    let user = 0;
    let assistant = 0;
    let unknownSender = 0;
    let empty = 0;
    let truncated = 0;
    let attachmentCount = 0;
    let attachmentMessages = 0;
    let timestampedMessages = 0;
    let missingTimestampMessages = 0;
    let unsupportedContentBlocks = 0;
    let assistantEndTurn = 0;
    let assistantOtherStopReason = 0;

    for (const message of ordered) {
      let role = null;
      if (message?.sender === 'human') {
        role = 'user';
      } else if (message?.sender === 'assistant') {
        role = 'assistant';
      } else {
        unknownSender += 1;
        continue;
      }

      if (message?.truncated === true) {
        truncated += 1;
      }

      if (role === 'assistant') {
        if (message?.stop_reason === 'end_turn') {
          assistantEndTurn += 1;
        } else {
          assistantOtherStopReason += 1;
        }
      }

      const currentAttachmentCount = countAttachments(message);
      if (currentAttachmentCount > 0) {
        attachmentCount += currentAttachmentCount;
        attachmentMessages += 1;
      }

      const parsedContent = readTextBlocks(message);
      for (const type of parsedContent.unsupportedTypes) {
        unsupportedContentTypes.add(type);
        unsupportedContentBlocks += 1;
      }

      if (parsedContent.blocks.length === 0 && currentAttachmentCount === 0) {
        empty += 1;
        continue;
      }

      const timestamp = normalizeTimestamp(message?.created_at);
      if (timestamp) {
        timestampedMessages += 1;
      } else {
        missingTimestampMessages += 1;
      }

      messages.push({
        id: message.uuid,
        role,
        timestamp,
        blocks: parsedContent.blocks,
      });

      if (role === 'user') {
        user += 1;
      } else {
        assistant += 1;
      }
    }

    return {
      messages,
      stats: {
        total: messages.length,
        user,
        assistant,
        other: 0,
        unknownSender,
        empty,
        truncated,
        attachmentCount,
        attachmentMessages,
        timestampedMessages,
        missingTimestampMessages,
        unsupportedContentBlocks,
        unsupportedContentTypes: [...unsupportedContentTypes].sort(),
        assistantEndTurn,
        assistantOtherStopReason,
      },
    };
  }

  registry.register({
    id: 'claude',
    displayName: 'Claude',
    acquisitionMode: 'network',
    supportsMessageCollection: true,
    panelFields: Object.freeze({
      iteration: false,
      position: false,
    }),

    detect() {
      if (location.hostname === 'claude.ai' || location.hostname.endsWith('.claude.ai')) {
        return 100;
      }
      return 0;
    },

    getNetworkCaptureConfig() {
      return {
        urlPattern: CONVERSATION_PATTERN,
        method: 'GET',
        timeoutMs: 60_000,
      };
    },

    parseNetworkCaptures(captures) {
      const { records, passStats, metadata } = mergeCaptures(captures);
      const chain = buildActiveChain(records, metadata);
      const normalized = normalizeMessages(chain.ordered);

      const chainDetails = {
        conversationUuid: metadata.uuid,
        conversationName: metadata.name || null,
        currentLeafMessageUuid: chain.currentLeafMessageUuid,
        rootMessageUuid: chain.rootMessageUuid,
        rootParentMessageUuid: chain.rootParentMessageUuid,
        mergedMessages: records.size,
        activeChainMessages: chain.ordered.length,
        inactiveBranchMessages: chain.inactiveBranchMessages,
        indexBreaks: chain.indexBreaks,
        minIndex: chain.minIndex,
        maxIndex: chain.maxIndex,
        chainComplete: true,
        truncated: normalized.stats.truncated,
        unknownSender: normalized.stats.unknownSender,
        empty: normalized.stats.empty,
        attachmentMessages: normalized.stats.attachmentMessages,
        attachmentCount: normalized.stats.attachmentCount,
        timestampedMessages: normalized.stats.timestampedMessages,
        missingTimestampMessages: normalized.stats.missingTimestampMessages,
        unsupportedContentBlocks: normalized.stats.unsupportedContentBlocks,
        unsupportedContentTypes: normalized.stats.unsupportedContentTypes,
        assistantEndTurn: normalized.stats.assistantEndTurn,
        assistantOtherStopReason: normalized.stats.assistantOtherStopReason,
      };

      const logEntries = [
        { event: 'CLAUDE_CHAIN_STATUS', details: chainDetails },
      ];

      if (normalized.stats.attachmentCount > 0) {
        logEntries.push({
          event: 'CLAUDE_ATTACHMENT_DATA_PRESENT',
          details: {
            messages: normalized.stats.attachmentMessages,
            attachments: normalized.stats.attachmentCount,
            note: 'attachment payload mapping is not yet validated in network adapter',
          },
        });
      }

      if (normalized.stats.unsupportedContentBlocks > 0) {
        logEntries.push({
          event: 'CLAUDE_UNSUPPORTED_CONTENT_PRESENT',
          details: {
            blocks: normalized.stats.unsupportedContentBlocks,
            types: normalized.stats.unsupportedContentTypes,
            note: 'only text content blocks are exported in 0.6.0',
          },
        });
      }

      return {
        conversation: {
          title: metadata.name || null,
          startedAt: metadata.createdAt,
          messages: normalized.messages,
        },
        stats: normalized.stats,
        diagnostics: {
          sourceMessages: chain.ordered.length,
          uniqueMessageIds: records.size,
          passStats,
          logEntries,
          ...chainDetails,
        },
      };
    },
  });
})();
