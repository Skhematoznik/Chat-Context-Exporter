(() => {
  const API_SOURCE_VERSION = "1.0.40";

  function getConversationId() {
    const match = location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/);
    return match ? match[1] : null;
  }

  async function getAuthorizationToken(signal) {
    const report = {
      tokenAvailable: false,
      method: "",
      error: ""
    };

    const candidates = [
      async () => {
        const response = await fetch("/api/auth/session", {
          credentials: "include",
          signal,
          headers: { "accept": "application/json" }
        });
        if (!response.ok) throw new Error(`session-http-${response.status}`);
        const data = await response.json();
        if (!data.accessToken) throw new Error("access-token-not-found");
        return data.accessToken;
      }
    ];

    for (const candidate of candidates) {
      try {
        const token = await candidate();
        report.tokenAvailable = true;
        report.method = "api-auth-session";
        return { token, report };
      } catch (error) {
        report.error = String(error?.message || error);
      }
    }

    return { token: null, report };
  }

  // Preserve the original message, including channel and visibility metadata.
  function normalizeMessage(item, fallbackId) {
    if (!item || typeof item !== "object") throw new Error("invalid-message-node");
    const message = Object.hasOwn(item, "message") ? item.message : item;
    return {
      id: item.id || message?.id || fallbackId,
      parent: item.parent ?? message?.parent_id ?? message?.metadata?.parent_id ?? null,
      message
    };
  }

  function selectSequence(nodes, currentNode, isMapping) {
    const byId = new Map();
    for (const node of nodes) {
      if (!node.id) throw new Error("message-id-missing");
      byId.set(node.id, node);
    }
    const hasLinks = nodes.some(n => n.parent != null);
    if (!hasLinks && !isMapping) return [...byId.values()];
    const parents = new Set(nodes.map(n => n.parent).filter(Boolean));
    const leaves = [...byId.keys()].filter(id => !parents.has(id));
    const tip = currentNode || (leaves.length === 1 ? leaves[0] : null);
    if (!tip) throw new Error("active-branch-ambiguous");
    const ordered = [], visited = new Set();
    let id = tip;
    while (id != null) {
      if (visited.has(id)) throw new Error("history-parent-cycle");
      const node = byId.get(id);
      if (!node) throw new Error("history-parent-missing");
      visited.add(id);
      ordered.push(node);
      id = node.parent;
    }
    // A flat paginated list must form one chain; branches require an explicit tip.
    if (!isMapping && !currentNode && ordered.length !== byId.size) {
      throw new Error("history-disconnected");
    }
    return ordered.reverse();
  }

  async function tryRequest(url, token, signal) {
    const response = await fetch(url, {
      credentials: "include",
      signal,
      headers: {
        "accept": "application/json",
        ...(token ? { "Authorization": `Bearer ${token}` } : {})
      }
    });

    const text = await response.text();

    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}

    return {
      response,
      data,
      responseSize: text.length
    };
  }


  async function requestConversationPage(url, token, signal) {
    const result = await tryRequest(url, token, signal);
    return {
      ...result,
      messages: Array.isArray(result.data?.messages) ? result.data.messages : [],
      pageInfo: result.data?.page_info || null
    };
  }

  function mergeMessages(pages) {
    const map = new Map();
    for (const page of [...pages].reverse()) {
      for (const message of page.messages || []) {
        const id = message?.id || message?.message?.id;
        if (!id) throw new Error("message-id-missing");
        map.set(id, message);
      }
    }
    return [...map.values()];
  }

  async function loadConversationPages(conversationId, token, firstResult, onProgress, signal) {
    const pages = [];
    const visited = new Set();

    let current = {
      messages: firstResult.data?.messages || [],
      pageInfo: firstResult.data?.page_info || null
    };

    pages.push(current);
    onProgress?.({ stage: "FETCHING", pagesLoaded: 1, rawMessages: current.messages.length,
      hasPreviousPage: Boolean(current.pageInfo?.has_previous_page), status: "Получена первая страница истории." });

    while (current.pageInfo?.has_previous_page) {
      const cursor = current.pageInfo.start_cursor;
      if (!cursor || visited.has(cursor)) {
        throw new Error("pagination-cursor-missing-or-repeated");
      }

      visited.add(cursor);

      onProgress?.({ stage: "FETCHING", pagesLoaded: pages.length, rawMessages: pages.reduce((n, page) => n + page.messages.length, 0),
        hasPreviousPage: true, status: `Загружаю следующую страницу истории (${pages.length + 1}).` });
      const next = await requestConversationPage(
        `/backend-api/conversations/${conversationId}/messages?before=${encodeURIComponent(cursor)}&include_has_versions=true&num_turns=100`,
        token, signal
      );

      if (!next.response.ok) {
        throw new Error(`pagination-http-${next.response.status}`);
      }

      if (!Array.isArray(next.data?.messages) || !next.pageInfo || !next.messages.length) {
        throw new Error("pagination-invalid-page");
      }
      current = {
        messages: next.messages,
        pageInfo: next.pageInfo
      };

      pages.push(current);
      onProgress?.({ stage: "FETCHING", pagesLoaded: pages.length, rawMessages: pages.reduce((n, page) => n + page.messages.length, 0),
        hasPreviousPage: Boolean(current.pageInfo.has_previous_page), status: current.pageInfo.has_previous_page
          ? `Получено страниц: ${pages.length}. Продолжаю загрузку истории.` : `Получено страниц: ${pages.length}. История загружена.` });
    }

    const messages = mergeMessages(pages);
    onProgress?.({ stage: "NORMALIZING", pagesLoaded: pages.length, rawMessages: messages.length,
      hasPreviousPage: false, status: `История загружена: ${pages.length} страниц, ${messages.length} записей. Обрабатываю сообщения.` });
    return { pages, messages };
  }


  function buildApiResponseDiagnostic(result) {
    const data = result?.data;
    return {
      httpStatus: result?.response?.status ?? null,
      contentType: result?.response?.headers?.get?.("content-type") || "",
      responseSize: result?.responseSize || 0,
      jsonParsed: Boolean(data),
      conversationId: Boolean(data?.conversation_id),
      hasPageInfo: Boolean(data?.page_info),
      pageInfo: data?.page_info ? {
        hasStartCursor: Boolean(data.page_info.start_cursor),
        hasEndCursor: Boolean(data.page_info.end_cursor),
        hasPreviousPage: Boolean(data.page_info.has_previous_page),
        hasNextPage: Boolean(data.page_info.has_next_page)
      } : null,
      hasMessages: Array.isArray(data?.messages),
      rawMessages: Array.isArray(data?.messages) ? data.messages.length : 0,
      hasMapping: Boolean(data?.mapping),
      rawMappingNodes: data?.mapping ? Object.keys(data.mapping).length : 0,
      schema: Array.isArray(data?.messages) ? "messages" : (data?.mapping ? "mapping" : "unknown")
    };
  }

  async function loadConversationSource({ onProgress = () => {}, signal } = {}) {
    const conversationId = getConversationId();

    const baseReport = {
      sourceVersion: API_SOURCE_VERSION,
      conversationId,
      available: false,
      httpStatus: null,
      endpoint: "",
      responseSize: 0,
      messages: 0,
      hasMapping: false,
      mappingNodes: 0,
      tokenAvailable: false,
      error: ""
    };

    if (!conversationId) {
      return { ...baseReport, error: "conversation-id-not-found" };
    }

    onProgress({ stage: "CONNECTING", status: "Подключаюсь к источнику истории…" });
    const auth = await getAuthorizationToken(signal);
    if (signal?.aborted) throw new Error("Экспорт отменен пользователем");
    baseReport.tokenAvailable = auth.report.tokenAvailable;

    const urls = [
      `/backend-api/conversations/${conversationId}?include_has_versions=true&num_turns=100`,
      `/backend-api/conversation/${conversationId}`
    ];

    const errors = [];

    for (const url of urls) {
      try {
        onProgress({ stage: "FETCHING", pagesLoaded: 0, rawMessages: 0, hasPreviousPage: null,
          status: "Запрашиваю историю чата у сервера…" });
        const result = await tryRequest(url, auth.token, signal);
        if (signal?.aborted) throw new Error("Экспорт отменен пользователем");

        baseReport.httpStatus = result.response.status;
        baseReport.endpoint = url;
        baseReport.responseSize = result.responseSize;

        if (!result.response.ok) {
          errors.push(`${url}:http-${result.response.status}`);
          continue;
        }

        const data = result.data;
        const isMapping = data?.mapping && typeof data.mapping === "object" && !Array.isArray(data.mapping);
        if (!isMapping && !Array.isArray(data?.messages)) throw new Error("unsupported-json-schema");
        if (!isMapping && (!data.page_info || data.page_info.has_next_page !== false ||
            typeof data.page_info.has_previous_page !== "boolean")) {
          throw new Error("history-boundaries-unconfirmed");
        }
        const loaded = isMapping ? { pages: [data], messages: [] } :
          await loadConversationPages(conversationId, auth.token, result, onProgress, signal);
        const nodes = isMapping ? Object.entries(data.mapping).map(([id, node]) => normalizeMessage(node, id)) :
          loaded.messages.map(m => normalizeMessage(m));
        // Flat API messages are already the selected, ordered history. Metadata
        // parent_id may reference omitted internal nodes and is not a tree edge.
        const wrappedNodes = !isMapping && loaded.messages.every(m => Object.hasOwn(m, "message"));
        const sequence = isMapping || wrappedNodes
          ? selectSequence(nodes, data.current_node, Boolean(isMapping)) : nodes;
        if (!isMapping && data.current_node && sequence.at(-1)?.id !== data.current_node) {
          throw new Error("history-end-node-mismatch");
        }
        onProgress({ stage: "NORMALIZING", pagesLoaded: loaded.pages.length, rawMessages: sequence.length,
          hasPreviousPage: false, status: `Нормализую историю: ${sequence.length} записей…` });
        const records = await normalizeExportRecords(sequence, onProgress, loaded.pages.length, signal);
        const normalization = { ...globalThis.__ChatContextNormalizationReport };
        onProgress({ stage: "NORMALIZED", pagesLoaded: loaded.pages.length, rawMessages: sequence.length,
          records: records.length, filtered: normalization.filtered, emptyContent: normalization.emptyContent,
          hasPreviousPage: false, status: `Обработка завершена: ${sequence.length} записей, ${records.length} сообщений войдут в файл.` });
        if (!records.length) throw new Error("no-exportable-messages");

        return {
          ...baseReport,
          available: true,
          pagesLoaded: loaded.pages.length,
          messages: loaded.messages.length,
          hasMapping: Boolean(result.data?.mapping),
          mappingNodes: isMapping ? nodes.length : 0,
          title: result.data?.title || "",
          messagesData: loaded.messages,
          records,
          sequenceIds: sequence.map(n => n.id),
          normalization,
          apiDiagnostic: buildApiResponseDiagnostic(result)
        };
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError" || error?.message === "Экспорт отменен пользователем") throw error;
        errors.push(`${url}:${error?.message || "fetch-error"}`);
      }
    }

    return {
      ...baseReport,
      errors,
      error: "api-request-failed"
    };
  }


  function markdownLink(label, url) {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return "";
    const text = String(label || url).replace(/\s+/g, " ").replace(/([\\\[\]])/g, "\\$1");
    const target = url.replace(/[\s<>\\()]/g, ch => encodeURIComponent(ch) === ch
      ? `%${ch.charCodeAt(0).toString(16).toUpperCase()}` : encodeURIComponent(ch));
    return `[${text}](${target})`;
  }

  function normalizeMarkdown(text, metadata, stats) {
    const references = new Map();
    for (const ref of metadata?.content_references || []) {
      if (typeof ref.matched_text === "string") references.set(ref.matched_text, ref);
    }
    // Literal examples inside code fences or inline code must stay unchanged.
    return text.split(/(`{3,}[^\n]*\n[\s\S]*?\n`{3,}|~{3,}[^\n]*\n[\s\S]*?\n~{3,}|`+[^`\n]*`+)/g)
      .map((part, index) => index % 2 ? part : part.replace(/([^]*)/g, (token, body) => {
        const fields = body.split("");
        if (fields[0] === "url" && fields.length >= 3) {
          const link = markdownLink(fields[1], fields.slice(2).join(""));
          if (link) { stats.convertedReferences++; return link; }
        }
        const ref = references.get(token);
        if (ref) {
          const links = [...new Map([...(ref.items || []), ...(ref.item ? [ref.item] : [])]
            .filter(item => item?.url).map(item => [item.url,
              markdownLink(item.attribution || item.title, item.url)])).values()].filter(Boolean);
          if (links.length) { stats.convertedReferences++; return links.join("; "); }
          if (ref.alt && !ref.alt.includes("")) { stats.convertedReferences++; return ref.alt; }
          const fallback = (ref.safe_urls || []).map(url => markdownLink(ref.title || "Источник", url)).filter(Boolean);
          if (fallback.length) { stats.convertedReferences++; return [...new Set(fallback)].join("; "); }
        }
        stats.unresolvedReferences++;
        return "[Ссылка или элемент: данные для преобразования отсутствуют]";
      })).join("");
  }

  function formatMessageDate(seconds) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "";
    const date = new Date(seconds * 1000);
    if (!Number.isFinite(date.getTime())) return "";
    const pad = n => String(n).padStart(2, "0");
    const offset = -date.getTimezoneOffset();
    const zone = `UTC${offset < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
    return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} (${zone})`;
  }

  async function normalizeExportRecords(source, onProgress = () => {}, pagesLoaded = 0, signal) {
    const stats = {
      inputMessages: source.length,
      acceptedUser: 0,
      acceptedAssistantFinal: 0,
      filtered: 0,
      emptyContent: 0,
      convertedReferences: 0,
      unresolvedReferences: 0
    };

    globalThis.__ChatContextNormalizationReport = stats;

    const records = [];
    for (let index = 0; index < source.length; index++) {
      if (signal?.aborted) throw new Error("Экспорт отменен пользователем");
      const node = source[index];
      const m = node.message;
      const role = m?.author?.role || m?.role || "";
      const channel = m?.channel || "";
      const hidden = Boolean(m?.metadata?.is_visually_hidden_from_conversation);

      if (hidden || !["user", "assistant"].includes(role)) {
        stats.filtered++;
        records.push(null);
        continue;
      }

      if (role === "assistant" && ((channel && channel !== "final") || (m?.recipient && m.recipient !== "all"))) {
        stats.filtered++;
        records.push(null);
        continue;
      }

      const parts = Array.isArray(m?.content?.parts) ? m.content.parts : [];
      const markdown = parts.map((part) => {
        if (typeof part === "string") return part;
        if (part?.asset_pointer || part?.content_type === "image_asset_pointer") {
          return "[attachment]";
        }
        return "";
      }).filter(Boolean).join("\n\n").trim();

      if (!markdown) {
        stats.emptyContent++;
        records.push(null);
        continue;
      }

      if (role === "user") stats.acceptedUser++;
      if (role === "assistant") stats.acceptedAssistantFinal++;

      records.push({
        messageId: m?.id || node.id,
        role,
        turnId: m?.metadata?.turn_id || "",
        markdown: normalizeMarkdown(markdown, m?.metadata, stats),
        createTime: m?.create_time ?? null,
        messageDateLabel: formatMessageDate(m?.create_time),
        attachments: [],
        generatedArtifacts: [],
        processing: [],
        parentId: node.parent,
        dateLabel: "",
        signature: `api:${m?.id || index}`
      });
      if ((index + 1) % 100 === 0 || index === source.length - 1) {
        onProgress({ stage: "NORMALIZING", pagesLoaded, rawMessages: source.length,
          records: stats.acceptedUser + stats.acceptedAssistantFinal, filtered: stats.filtered, emptyContent: stats.emptyContent,
          hasPreviousPage: false, status: `Обработано записей: ${index + 1} из ${source.length}. В экспорт включено ${stats.acceptedUser + stats.acceptedAssistantFinal}.` });
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    const exportRecords = records.filter(Boolean);
    stats.records = exportRecords.length;
    return exportRecords;
  }

  async function loadFullConversationForExport(options = {}) {
    const report = await loadConversationSource(options);
    report.extractedMessages = report.messagesData?.length || 0;
    return {
      ...report,
      success: Boolean(report.available && report.records?.length),
      records: report.records || []
    };
  }

  globalThis.__ChatContextConversationSource = Object.freeze({
    version: API_SOURCE_VERSION,
    loadConversationSource,
    loadFullConversationForExport
  });
})();
