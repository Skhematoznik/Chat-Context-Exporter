(() => {
  'use strict';

  const app = globalThis.__chatContextExporter;
  if (!app) {
    throw new Error('Chat Context Exporter: namespace is not initialized.');
  }

  function hashString(value) {
    let hash = 2166136261;
    const text = String(value ?? '');

    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }

    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function createFallbackId({ role, orderKey, contentRoot }) {
    const text = contentRoot?.textContent || '';
    const orderPart = Number.isFinite(orderKey) ? String(orderKey) : 'na';
    return `fallback:${role}:${orderPart}:${hashString(text)}`;
  }

  function createCollector(adapter) {
    const records = new Map();
    let discoveryIndex = 0;

    function collectVisible() {
      const elements = adapter.getVisibleMessages?.() || [];
      const batch = {
        visible: elements.length,
        added: 0,
        updated: 0,
        skipped: 0,
      };

      for (const element of elements) {
        if (!(element instanceof HTMLElement)) {
          batch.skipped += 1;
          continue;
        }

        const role = adapter.getMessageRole?.(element) || null;
        const contentRoot = adapter.getMessageContentRoot?.(element) || null;

        if (!role || !(contentRoot instanceof HTMLElement)) {
          batch.skipped += 1;
          continue;
        }

        const orderCandidate = Number(adapter.getMessageOrderKey?.(element));
        const orderKey = Number.isFinite(orderCandidate) ? orderCandidate : null;
        const stableId = adapter.getMessageId?.(element)
          || createFallbackId({ role, orderKey, contentRoot });
        const timestamp = adapter.getMessageTimestamp?.(element) || null;
        const qualityCandidate = Number(adapter.getMessageQualityRank?.(element));
        const qualityRank = Number.isFinite(qualityCandidate) ? qualityCandidate : 0;
        const html = contentRoot.innerHTML;
        const textLength = (contentRoot.textContent || '').length;
        const existing = records.get(stableId);

        if (existing) {
          const existingQualityRank = Number.isFinite(existing.qualityRank) ? existing.qualityRank : 0;
          const shouldRefresh = qualityRank > existingQualityRank
            || (qualityRank === existingQualityRank && (
              textLength > existing.textLength
              || (textLength === existing.textLength && html.length > existing.html.length)
            ));
          if (shouldRefresh) {
            records.set(stableId, {
              ...existing,
              role,
              timestamp,
              orderKey: orderKey ?? existing.orderKey,
              qualityRank,
              html,
              textLength,
            });
            batch.updated += 1;
          }
          continue;
        }

        records.set(stableId, {
          id: stableId,
          role,
          timestamp,
          orderKey,
          discoveryIndex,
          qualityRank,
          html,
          textLength,
        });
        discoveryIndex += 1;
        batch.added += 1;
      }

      return {
        ...batch,
        ...getStats(),
      };
    }

    function getStats() {
      let user = 0;
      let assistant = 0;
      let other = 0;

      for (const record of records.values()) {
        if (record.role === 'user') {
          user += 1;
        } else if (record.role === 'assistant') {
          assistant += 1;
        } else {
          other += 1;
        }
      }

      return {
        total: records.size,
        user,
        assistant,
        other,
      };
    }

    function getMessages() {
      return [...records.values()].sort((left, right) => {
        const leftHasOrder = Number.isFinite(left.orderKey);
        const rightHasOrder = Number.isFinite(right.orderKey);

        if (leftHasOrder && rightHasOrder && left.orderKey !== right.orderKey) {
          return left.orderKey - right.orderKey;
        }
        if (leftHasOrder !== rightHasOrder) {
          return leftHasOrder ? -1 : 1;
        }
        return left.discoveryIndex - right.discoveryIndex;
      });
    }

    return {
      collectVisible,
      getMessages,
      getStats,
    };
  }

  app.modules.collector = {
    createCollector,
  };
})();
