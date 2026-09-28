(() => {
  'use strict';

  const app = globalThis.__chatContextExporter;
  if (!app) {
    throw new Error('Chat Context Exporter: namespace is not initialized.');
  }

  const profiles = app.modules.chatGptProfiles || (app.modules.chatGptProfiles = Object.create(null));

  function getShareId() {
    const match = location.pathname.match(/^\/share\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function captureConfig() {
    const shareId = getShareId();
    if (!shareId) {
      return null;
    }
    return {
      urlPattern: `^https://chatgpt\\.com/share/${escapeRegExp(shareId)}(?:[?#].*)?$`,
      method: 'GET',
      resourceType: 'Document',
      timeoutMs: 60_000,
      responseProcessor: 'chatgpt-shared-document',
      expectedShareId: shareId,
    };
  }

  function snapshotTimestamp(snapshot) {
    const parsed = Date.parse(snapshot?.updateTime || snapshot?.createTime || '');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function messageFingerprint(message) {
    return JSON.stringify([
      message?.role || null,
      message?.timestamp || null,
      Array.isArray(message?.blocks) ? message.blocks : [],
    ]);
  }

  function chooseSnapshot(captures) {
    const parsedCaptures = (captures || [])
      .filter((capture) => capture?.processed && Array.isArray(capture.processed.messages))
      .map((capture) => ({ capture, snapshot: capture.processed }));

    if (parsedCaptures.length === 0) {
      throw new Error('ChatGPT Shared: сетевой capture не содержит разобранного Document snapshot.');
    }

    const conversationIds = new Set(
      parsedCaptures
        .map(({ snapshot }) => snapshot.conversationId || snapshot.sharedConversationId || '')
        .filter(Boolean),
    );
    if (conversationIds.size > 1) {
      throw new Error(`ChatGPT Shared: проходы относятся к разным разговорам (${[...conversationIds].join(' / ')}).`);
    }

    return [...parsedCaptures].sort((left, right) => {
      const timeDiff = snapshotTimestamp(right.snapshot) - snapshotTimestamp(left.snapshot);
      if (timeDiff !== 0) {
        return timeDiff;
      }
      const rawDiff = Number(right.snapshot.rawNodes || 0) - Number(left.snapshot.rawNodes || 0);
      if (rawDiff !== 0) {
        return rawDiff;
      }
      return Number(right.capture.pass || 0) - Number(left.capture.pass || 0);
    })[0];
  }

  function buildPassStats(captures) {
    const seen = new Map();
    const stats = [];

    for (const capture of captures || []) {
      const snapshot = capture?.processed;
      if (!snapshot || !Array.isArray(snapshot.messages)) {
        continue;
      }

      const passStats = {
        pass: Number(capture.pass) || stats.length + 1,
        received: snapshot.messages.length,
        added: 0,
        updated: 0,
        duplicates: 0,
        malformed: 0,
        totalAfterPass: 0,
        rawNodes: snapshot.rawNodes ?? null,
      };

      for (const message of snapshot.messages) {
        const id = typeof message?.id === 'string' ? message.id : '';
        if (!id) {
          passStats.malformed += 1;
          continue;
        }
        const fingerprint = messageFingerprint(message);
        const previous = seen.get(id);
        if (!previous) {
          seen.set(id, fingerprint);
          passStats.added += 1;
        } else if (previous !== fingerprint) {
          seen.set(id, fingerprint);
          passStats.updated += 1;
        } else {
          passStats.duplicates += 1;
        }
      }

      passStats.totalAfterPass = seen.size;
      stats.push(passStats);
    }

    return stats;
  }

  function buildDiagnostics(snapshot, selectedPass, passStats) {
    const stats = snapshot.stats || {};
    const references = stats.references || {};
    return {
      sourceMessages: snapshot.rawNodes ?? null,
      uniqueMessageIds: snapshot.messages?.length ?? null,
      passStats,
      logEntries: [
        {
          event: 'CHATGPT_SHARE_SNAPSHOT_STATUS',
          details: {
            selectedPass,
            wireFormat: snapshot.transport?.wireFormat || null,
            tableEntries: snapshot.transport?.tableEntries ?? null,
            candidateTables: snapshot.transport?.candidateTables ?? null,
            conversationId: snapshot.conversationId || null,
            sharedConversationId: snapshot.sharedConversationId || null,
            rawNodes: snapshot.rawNodes ?? null,
            mappingNodes: snapshot.mappingNodes ?? null,
            uniqueRawNodeIds: snapshot.uniqueRawNodeIds ?? null,
            currentNode: snapshot.currentNode || null,
            lastNodeId: snapshot.lastNodeId || null,
            currentNodeMatchesLast: Boolean(
              snapshot.currentNode
              && snapshot.lastNodeId
              && snapshot.currentNode === snapshot.lastNodeId
            ),
            chainComplete: snapshot.chainComplete === true,
            messages: stats.total ?? null,
            user: stats.user ?? null,
            assistant: stats.assistant ?? null,
            nodesWithoutMessage: stats.nodesWithoutMessage ?? null,
            hiddenSkipped: stats.hiddenSkipped ?? null,
            internalSkipped: stats.internalSkipped ?? null,
            unsupportedVisible: stats.unsupportedVisible ?? null,
            unsupportedContentTypes: stats.unsupportedContentTypes || [],
            multimodalUserMessages: stats.multimodalUserMessages ?? null,
            attachmentMessages: stats.attachmentMessages ?? null,
            attachmentCount: stats.attachmentCount ?? null,
            timestampedMessages: stats.timestampedMessages ?? null,
            missingTimestampMessages: stats.missingTimestampMessages ?? null,
          },
        },
        {
          event: 'CHATGPT_SHARE_REFERENCE_STATUS',
          details: {
            total: references.total ?? 0,
            groupedWebpages: references.groupedWebpages ?? 0,
            file: references.file ?? 0,
            followup: references.followup ?? 0,
            hidden: references.hidden ?? 0,
            sourcesFootnote: references.sourcesFootnote ?? 0,
            other: references.other ?? 0,
            unresolvedMarkersRemoved: references.unresolvedMarkersRemoved ?? 0,
          },
        },
      ],
    };
  }

  profiles.shared = Object.freeze({
    variant: 'shared-public',
    acquisitionMode: 'network',
    parseEvent: 'CHATGPT_SHARE_PARSED',
    supportsMessageCollection: true,
    scrollMode: 'normal',
    selectors: Object.freeze({}),
    panelFields: Object.freeze({
      iteration: false,
      position: false,
    }),

    detect() {
      return location.hostname === 'chatgpt.com' && location.pathname.startsWith('/share/') ? 100 : 0;
    },

    getNetworkCaptureConfig() {
      return captureConfig();
    },

    parseNetworkCaptures(captures) {
      const selected = chooseSnapshot(captures);
      const snapshot = selected.snapshot;
      const passStats = buildPassStats(captures);
      const stats = snapshot.stats || {};

      return {
        conversation: {
          title: snapshot.title || null,
          startedAt: snapshot.createTime || null,
          messages: snapshot.messages,
        },
        stats: {
          total: stats.total ?? snapshot.messages.length,
          user: stats.user ?? snapshot.messages.filter((message) => message.role === 'user').length,
          assistant: stats.assistant ?? snapshot.messages.filter((message) => message.role === 'assistant').length,
          other: 0,
        },
        diagnostics: buildDiagnostics(snapshot, selected.capture.pass || 1, passStats),
      };
    },
  });
})();
