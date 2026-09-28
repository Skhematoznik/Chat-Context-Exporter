(() => {
  'use strict';

  const app = globalThis.__chatContextExporter;
  const registry = app?.modules.adapterRegistry;

  if (!registry) {
    throw new Error('Chat Context Exporter: adapter registry is not initialized.');
  }

  const LOAD_RESPONSES_PATTERN = '^https://grok\\.com/rest/app-chat/conversations/[0-9a-f-]+/load-responses(?:[/?#].*)?$';
  const ATTACHMENT_FIELDS = Object.freeze([
    'generatedImageUrls',
    'imageAttachments',
    'fileAttachments',
    'cardAttachmentsJson',
    'fileUris',
    'fileAttachmentsMetadata',
    'imageEditUris',
    'fileAttachmentAssetMetadata',
    'fileIds',
  ]);

  function countAttachments(response) {
    let count = 0;
    for (const key of ATTACHMENT_FIELDS) {
      const value = response?.[key];
      if (Array.isArray(value)) {
        count += value.length;
      } else if (value) {
        count += 1;
      }
    }
    return count;
  }

  function responseQuality(response) {
    const messageLength = typeof response?.message === 'string' ? response.message.length : 0;
    const completedBonus = response?.partial === true ? 0 : 1_000_000;
    const attachmentBonus = countAttachments(response) * 10_000;
    return completedBonus + attachmentBonus + messageLength;
  }

  function mergeCaptures(captures) {
    const records = new Map();
    const passStats = [];
    let discoveryIndex = 0;

    for (const capture of captures || []) {
      let payload;
      try {
        payload = JSON.parse(String(capture?.body ?? ''));
      } catch (error) {
        throw new Error(`Grok: не удалось разобрать JSON прохода ${capture?.pass ?? '?' }: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (!payload || !Array.isArray(payload.responses)) {
        throw new Error(`Grok: проход ${capture?.pass ?? '?'} не содержит массив responses.`);
      }

      const stats = {
        pass: capture?.pass ?? passStats.length + 1,
        received: payload.responses.length,
        added: 0,
        updated: 0,
        duplicates: 0,
        malformed: 0,
      };

      for (const response of payload.responses) {
        const id = typeof response?.responseId === 'string' ? response.responseId.trim() : '';
        if (!id) {
          stats.malformed += 1;
          continue;
        }

        const existing = records.get(id);
        const quality = responseQuality(response);
        if (!existing) {
          records.set(id, {
            response,
            quality,
            discoveryIndex,
          });
          discoveryIndex += 1;
          stats.added += 1;
          continue;
        }

        const changedAtSameQuality = quality === existing.quality
          && JSON.stringify(response) !== JSON.stringify(existing.response);
        if (quality > existing.quality || changedAtSameQuality) {
          records.set(id, {
            ...existing,
            response,
            quality,
          });
          stats.updated += 1;
        } else {
          stats.duplicates += 1;
        }
      }

      passStats.push(stats);
    }

    return { records, passStats };
  }

  function buildLinearChain(records) {
    if (records.size === 0) {
      throw new Error('Grok: сетевой ответ не содержит сообщений.');
    }

    const childrenByParent = new Map();
    const roots = [];

    for (const { response } of records.values()) {
      const id = response.responseId;
      const parentId = typeof response.parentResponseId === 'string'
        ? response.parentResponseId.trim()
        : '';

      if (!parentId || !records.has(parentId)) {
        roots.push(id);
        continue;
      }

      const children = childrenByParent.get(parentId) || [];
      children.push(id);
      childrenByParent.set(parentId, children);
    }

    if (roots.length !== 1) {
      throw new Error(`Grok: ожидалась одна корневая цепочка responses, обнаружено ${roots.length}.`);
    }

    for (const [parentId, children] of childrenByParent.entries()) {
      if (children.length > 1) {
        throw new Error(`Grok: обнаружено ветвление responses у parentResponseId=${parentId}; выбор активной ветки пока не определен.`);
      }
    }

    const ordered = [];
    const visited = new Set();
    let currentId = roots[0];

    while (currentId) {
      if (visited.has(currentId)) {
        throw new Error(`Grok: обнаружен цикл parentResponseId около responseId=${currentId}.`);
      }

      const record = records.get(currentId);
      if (!record) {
        break;
      }

      visited.add(currentId);
      ordered.push(record.response);
      const children = childrenByParent.get(currentId) || [];
      currentId = children[0] || null;
    }

    if (visited.size !== records.size) {
      throw new Error(`Grok: цепочка responses разорвана: связано ${visited.size} из ${records.size} элементов.`);
    }

    const first = ordered[0];
    const externalRootParentId = typeof first?.parentResponseId === 'string'
      && first.parentResponseId.trim()
      && !records.has(first.parentResponseId.trim())
      ? first.parentResponseId.trim()
      : null;

    return {
      ordered,
      externalRootParentId,
      internalLinkCount: Math.max(0, ordered.length - 1),
    };
  }

  function normalizeCreateTime(value) {
    if (typeof value !== 'string' || !value.trim()) {
      return null;
    }

    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
      return null;
    }

    return date.toISOString();
  }

  function normalizeResponses(ordered) {
    const messages = [];
    let user = 0;
    let assistant = 0;
    let control = 0;
    let partial = 0;
    let unknownSender = 0;
    let empty = 0;
    let attachmentCount = 0;
    let attachmentMessages = 0;
    let timestampedMessages = 0;
    let missingTimestampMessages = 0;

    for (const response of ordered) {
      const currentAttachmentCount = countAttachments(response);
      if (currentAttachmentCount > 0) {
        attachmentCount += currentAttachmentCount;
        attachmentMessages += 1;
      }

      if (response?.isControl === true) {
        control += 1;
        continue;
      }

      if (response?.partial === true) {
        partial += 1;
        continue;
      }

      let role = null;
      if (response?.sender === 'human') {
        role = 'user';
      } else if (response?.sender === 'assistant') {
        role = 'assistant';
      } else {
        unknownSender += 1;
        continue;
      }

      const markdown = typeof response?.message === 'string' ? response.message.trim() : '';
      if (!markdown && currentAttachmentCount === 0) {
        empty += 1;
        continue;
      }

      const timestamp = normalizeCreateTime(response?.createTime);
      if (timestamp) {
        timestampedMessages += 1;
      } else {
        missingTimestampMessages += 1;
      }

      messages.push({
        id: response.responseId,
        role,
        timestamp,
        blocks: markdown ? [{ type: 'markdown', value: markdown }] : [],
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
        control,
        partial,
        unknownSender,
        empty,
        attachmentCount,
        attachmentMessages,
        timestampedMessages,
        missingTimestampMessages,
      },
    };
  }

  registry.register({
    id: 'grok',
    displayName: 'Grok',
    acquisitionMode: 'network',
    supportsMessageCollection: true,

    detect() {
      if (location.hostname === 'grok.com' || location.hostname.endsWith('.grok.com')) {
        return 100;
      }
      return 0;
    },

    getNetworkCaptureConfig() {
      return {
        urlPattern: LOAD_RESPONSES_PATTERN,
        timeoutMs: 60_000,
      };
    },

    parseNetworkCaptures(captures) {
      const { records, passStats } = mergeCaptures(captures);
      const chain = buildLinearChain(records);
      const normalized = normalizeResponses(chain.ordered);

      return {
        conversation: {
          startedAt: null,
          messages: normalized.messages,
        },
        stats: normalized.stats,
        diagnostics: {
          responses: chain.ordered.length,
          uniqueResponseIds: records.size,
          internalLinkCount: chain.internalLinkCount,
          externalRootParentId: chain.externalRootParentId,
          chainComplete: true,
          passStats,
          ...normalized.stats,
        },
      };
    },
  });
})();
