// ==UserScript==
// @name         ChatGPT Recent Messages
// @namespace    https://github.com/nonlog/my_scripts
// @version      0.8.2
// @description  Reduce long-chat rendering, tool-call layout, and client-state overhead in ChatGPT Web.
// @homepageURL  https://github.com/nonlog/my_scripts
// @supportURL   https://github.com/nonlog/my_scripts/issues
// @updateURL    https://raw.githubusercontent.com/nonlog/my_scripts/master/chatgpt-recent-turns.meta.js
// @downloadURL  https://raw.githubusercontent.com/nonlog/my_scripts/master/chatgpt-recent-turns.user.js
// @match        https://chatgpt.com/*
// @run-at       document-start
// @early-start
// @inject-into  page
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.8.2';
  const INITIAL_MESSAGES = 5;
  const LOAD_STEP = 5;
  const TOP_THRESHOLD_PX = 220;
  const PANEL_AUTO_COLLAPSE_MS = 4000;
  const PANEL_EDGE_PEEK_MS = 700;
  const PANEL_SNAP_PX = 48;
  const PANEL_DRAG_THRESHOLD_PX = 4;

  const TURBO_KEY = 'cgpt-recent-messages-turbo-v1';
  const TURBO_MAX_TURNS = 3;
  const TURBO_MAX_NODES = 450;
  const TURBO_MAX_CHARS = 700000;
  const TURBO_MIN_RESPONSE = 1000000;
  const TURBO_SERVER_TURNS = 3;
  const TURBO_FLAT_MAX_CHARS = 420000;
  const FLAT_DEEP_TRIGGER_NODES = 100;
  const FLAT_DEEP_TRIGGER_CHARS = 300000;
  const FLAT_DEEP_TAIL_NODES = 80;
  const DEEP_TRIGGER_NODES = 260;
  const DEEP_TRIGGER_CHARS = 500000;
  const DEEP_TAIL_NODES = 120;
  const HISTORY_BATCH_TURNS = 5;
  const HISTORY_MANUAL_FLAG = '__cgptRecentManualHistory';

  const TOOL_KEY = 'cgpt-recent-messages-tool-compact-v1';
  const TOOL_SELECTOR = 'span.group\\/tool-message';
  const TOOL_HIDDEN = 'data-cgpt-tool-compacted';
  const TOOL_BUNDLE = 'cgpt-tool-bundle';
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const SCROLL_SELECTOR = '[class~="group/scroll-root"]';
  const HIDDEN = 'data-cgpt-recent-hidden';
  const PANEL_ID = 'cgpt-recent-messages-panel';
  const STYLE_ID = 'cgpt-recent-messages-style';
  const PANEL_POSITION_KEY = 'cgpt-recent-messages-panel-position-v1';
  const HISTORY_ARCHIVE_ID = 'cgpt-recent-history-archive';

  const isZh = /^zh\b/i.test(navigator.languages?.[0] || navigator.language || '');
  const t = isZh ? {
    older: `加载前 ${LOAD_STEP} 条消息`, olderLoading: '正在加载更早消息…', olderNone: '没有更早消息', olderReopen: '重新打开已加载的轻量历史', all: '显示全部已加载消息', recent: `只显示最近 ${INITIAL_MESSAGES} 条消息`,
    reset: `重置为最近 ${INITIAL_MESSAGES} 条消息`, turboOn: 'Turbo 已开启；点击关闭并重新加载完整历史',
    turboOff: 'Turbo 已关闭；点击开启并重新加载', toolsOn: 'Tool Compactor 已开启；点击关闭',
    toolsOff: 'Tool Compactor 已关闭；点击开启', open: '展开工具栏', close: '折叠工具栏', drag: '拖动工具栏',
    bundle: (n, x) => x ? `${n} 个 tool calls · 收起` : `${n} 个 tool calls`, status: (v, n) => `${v}/${n}`,
    historyTitle: n => `轻量历史 · ${n} 个回合`, historyClose: '关闭轻量历史', historyUser: '你', historyAssistant: 'ChatGPT', historyTools: n => `${n} 个 tool calls 已省略`,
  } : {
    older: `Load ${LOAD_STEP} older messages`, olderLoading: 'Loading older messages…', olderNone: 'No older messages', olderReopen: 'Reopen loaded lightweight history', all: 'Show all currently loaded messages', recent: `Show only the latest ${INITIAL_MESSAGES} messages`,
    reset: `Reset to the latest ${INITIAL_MESSAGES} messages`, turboOn: 'Turbo is ON; click to disable and reload full history',
    turboOff: 'Turbo is OFF; click to enable and reload', toolsOn: 'Tool Compactor is ON; click to disable',
    toolsOff: 'Tool Compactor is OFF; click to enable', open: 'Open toolbar', close: 'Collapse toolbar', drag: 'Drag toolbar',
    bundle: (n, x) => x ? `${n} tool calls · collapse` : `${n} tool calls`, status: (v, n) => `${v}/${n}`,
    historyTitle: n => `Lightweight history · ${n} turns`, historyClose: 'Close lightweight history', historyUser: 'You', historyAssistant: 'ChatGPT', historyTools: n => `${n} tool calls omitted`,
  };

  let visibleCount = INITIAL_MESSAGES, showAll = false, updateTimer = null, collapseTimer = null, peekTimer = null;
  let scrollRoot = null, listRoot = null, listObserver = null, discoveryObserver = null, topLoadArmed = true;
  let lastUrl = location.href, toolUiTimer = null, dragState = null, suppressPanelClickUntil = 0;
  const toolObservers = new Map(), toolTimers = new Map();
  const historyState = { conversationId: null, initialCursor: null, cursor: null, initialHasPrevious: false, hasPrevious: false, loading: false, turns: [] };

  const turboEnabled = () => localStorage.getItem(TURBO_KEY) !== '0';
  const toolEnabled = () => localStorage.getItem(TOOL_KEY) !== '0';
  const setTurbo = value => localStorage.setItem(TURBO_KEY, value ? '1' : '0');
  const setTools = value => localStorage.setItem(TOOL_KEY, value ? '1' : '0');
  if (localStorage.getItem(TURBO_KEY) === null) setTurbo(true);
  if (localStorage.getItem(TOOL_KEY) === null) setTools(true);

  function conversationFetchInfo(input, init) {
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    if (method !== 'GET') return null;
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url || '';
    try {
      const url = new URL(raw, location.origin), path = url.pathname;
      if (/^\/backend-api\/conversation\/[0-9a-f-]+$/i.test(path)) return { kind: 'legacy', url };
      if (/^\/backend-api\/conversations\/[0-9a-f-]+$/i.test(path)) return { kind: 'flat-main', url };
      if (/^\/backend-api\/conversations\/[0-9a-f-]+\/messages$/i.test(path) && url.searchParams.has('before')) return { kind: 'flat-history', url };
    } catch {}
    return null;
  }

  function replaceFetchUrl(input, url) {
    if (typeof input === 'string') return url.href;
    if (input instanceof URL) return new URL(url.href);
    if (typeof Request !== 'undefined' && input instanceof Request) return new Request(url.href, input);
    return url.href;
  }

  function capFlatRequest(args, info) {
    const url = new URL(info.url.href), rawTurns = Number.parseInt(url.searchParams.get('num_turns') || '', 10);
    const requestedTurns = Number.isFinite(rawTurns) && rawTurns > 0 ? rawTurns : null;
    const networkTurns = Math.min(requestedTurns || TURBO_SERVER_TURNS, TURBO_SERVER_TURNS);
    url.searchParams.set('num_turns', String(networkTurns));
    return { args: [replaceFetchUrl(args[0], url), args[1]], requestedTurns, networkTurns };
  }

  function resetHistoryState() {
    historyState.conversationId = null;
    historyState.initialCursor = null;
    historyState.cursor = null;
    historyState.initialHasPrevious = false;
    historyState.hasPrevious = false;
    historyState.loading = false;
    historyState.turns = [];
    document.getElementById(HISTORY_ARCHIVE_ID)?.remove();
    window.__cgptRecentMessagesHistoryState = null;
  }

  function publishHistoryState() {
    window.__cgptRecentMessagesHistoryState = {
      conversationId: historyState.conversationId,
      cursor: historyState.cursor,
      hasPrevious: historyState.hasPrevious,
      loading: historyState.loading,
      archivedTurns: historyState.turns.length,
    };
  }

  function captureFlatHistory(data, info) {
    const id = info?.url?.pathname?.split('/').filter(Boolean).at(-1) || null;
    const cursor = data?.page_info?.start_cursor || data?.messages?.[0]?.id || null;
    const hasPrevious = Boolean(data?.page_info?.has_previous_page && cursor);
    const changedConversation = historyState.conversationId && historyState.conversationId !== id;
    if (changedConversation) resetHistoryState();
    historyState.conversationId = id;
    if (!historyState.initialCursor || changedConversation || !historyState.turns.length) {
      historyState.initialCursor = cursor;
      historyState.cursor = cursor;
      historyState.initialHasPrevious = hasPrevious;
      historyState.hasPrevious = hasPrevious;
    }
    historyState.loading = false;
    publishHistoryState();
    queueMicrotask(() => scheduleUpdate(0));
  }

  function resetHistoryArchive() {
    historyState.cursor = historyState.initialCursor;
    historyState.hasPrevious = historyState.initialHasPrevious;
    historyState.loading = false;
    historyState.turns = [];
    document.getElementById(HISTORY_ARCHIVE_ID)?.remove();
    publishHistoryState();
  }

  function textPart(part) {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    if (typeof part.content === 'string') return part.content;
    return '';
  }

  function messageText(message) {
    if (!message || message?.metadata?.is_visually_hidden_from_conversation) return '';
    const role = message?.author?.role, content = message?.content || {};
    const type = content.content_type || '';
    if (role === 'assistant' && !['text', 'reasoning_recap'].includes(type)) return '';
    if (role === 'user' && !['text', 'multimodal_text'].includes(type)) return '';
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const values = parts.map(textPart).filter(Boolean);
    if (!values.length && typeof content.text === 'string') values.push(content.text);
    return values.join('\n').trim();
  }

  function extractHistoryTurns(list) {
    if (!Array.isArray(list)) return [];
    const turns = [];
    let current = null;
    for (const message of list) {
      const role = message?.author?.role;
      if (role === 'user') {
        const text = messageText(message);
        if (!text) { current = null; continue; }
        current = { id: message.id || `user-${turns.length}`, user: text, assistant: [], tools: 0 };
        turns.push(current);
        continue;
      }
      if (!current) continue;
      if (role === 'tool') { current.tools++; continue; }
      if (role === 'assistant') {
        const text = messageText(message);
        if (text && !current.assistant.includes(text)) current.assistant.push(text);
      }
    }
    return turns;
  }

  function ensureHistoryArchive() {
    let host = document.getElementById(HISTORY_ARCHIVE_ID);
    if (host) return host;
    host = document.createElement('section');
    host.id = HISTORY_ARCHIVE_ID;
    host.setAttribute('role', 'region');
    document.body.appendChild(host);
    return host;
  }

  function renderHistoryArchive() {
    if (!historyState.turns.length) { document.getElementById(HISTORY_ARCHIVE_ID)?.remove(); return; }
    const host = ensureHistoryArchive();
    host.replaceChildren();
    const header = document.createElement('div'); header.className = 'cgpt-rh-head';
    const title = document.createElement('strong'); title.textContent = t.historyTitle(historyState.turns.length);
    const close = document.createElement('button'); close.type = 'button'; close.className = 'cgpt-rh-close'; close.textContent = '×'; close.setAttribute('aria-label', t.historyClose); close.addEventListener('click', () => { host.remove(); updatePanel(messages().length); });
    header.append(title, close); host.append(header);
    const body = document.createElement('div'); body.className = 'cgpt-rh-body';
    for (const turn of historyState.turns) {
      const section = document.createElement('article'); section.className = 'cgpt-rh-turn';
      const userLabel = document.createElement('div'); userLabel.className = 'cgpt-rh-label'; userLabel.textContent = t.historyUser;
      const user = document.createElement('div'); user.className = 'cgpt-rh-user'; user.textContent = turn.user;
      section.append(userLabel, user);
      for (const text of turn.assistant) {
        const label = document.createElement('div'); label.className = 'cgpt-rh-label'; label.textContent = t.historyAssistant;
        const assistant = document.createElement('div'); assistant.className = 'cgpt-rh-assistant'; assistant.textContent = text;
        section.append(label, assistant);
      }
      if (turn.tools) { const tools = document.createElement('div'); tools.className = 'cgpt-rh-tools'; tools.textContent = t.historyTools(turn.tools); section.append(tools); }
      body.append(section);
    }
    host.append(body);
  }

  async function loadOlderHistory() {
    if (!turboEnabled() || historyState.loading || !historyState.conversationId || !historyState.cursor || !historyState.hasPrevious) return;
    historyState.loading = true; publishHistoryState(); updatePanel(messages().length);
    try {
      const url = new URL(`/backend-api/conversations/${historyState.conversationId}/messages`, location.origin);
      url.searchParams.set('before', historyState.cursor);
      url.searchParams.set('num_turns', String(HISTORY_BATCH_TURNS));
      const response = await window.fetch(url.href, { credentials: 'same-origin', [HISTORY_MANUAL_FLAG]: true });
      if (!response.ok) throw new Error(`history request failed: ${response.status}`);
      const data = await response.json(), extracted = extractHistoryTurns(data?.messages);
      const seen = new Set(historyState.turns.map(x => x.id));
      const fresh = extracted.filter(x => !seen.has(x.id));
      if (fresh.length) historyState.turns = [...fresh, ...historyState.turns];
      const nextCursor = data?.page_info?.start_cursor || data?.messages?.[0]?.id || null;
      historyState.cursor = nextCursor;
      historyState.hasPrevious = Boolean(data?.page_info?.has_previous_page && nextCursor);
      renderHistoryArchive();
    } catch (error) {
      console.debug('[ChatGPT Recent Messages] Manual older-history load failed:', error);
    } finally {
      historyState.loading = false; publishHistoryState(); updatePanel(messages().length);
    }
  }

  function emptyFlatHistoryResponse() {
    const body = JSON.stringify({ messages: [], safe_urls: [], blocked_urls: [], page_info: { start_cursor: null, end_cursor: null, has_previous_page: false, has_next_page: false } });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }

  function trimConversation(data) {
    const mapping = data?.mapping, current = data?.current_node;
    if (!mapping || !current) return null;
    const path = [], seen = new Set();
    for (let id = current; id && mapping[id] && !seen.has(id); id = mapping[id].parent) { seen.add(id); path.push(id); }
    path.reverse();
    if (path.length < 2) return null;

    const users = [];
    path.forEach((id, i) => { if (mapping[id]?.message?.author?.role === 'user') users.push(i); });
    if (!users.length) return null;
    const segments = users.map((start, i) => {
      const end = i + 1 < users.length ? users[i + 1] : path.length;
      let chars = 0;
      for (let j = start; j < end; j++) { const m = mapping[path[j]]?.message; if (m) chars += JSON.stringify(m).length; }
      return { start, end, nodes: end - start, chars };
    });

    const latest = segments.at(-1);
    const deep = latest.nodes > DEEP_TRIGGER_NODES || latest.chars > DEEP_TRIGGER_CHARS;
    let first = segments.length - 1, turns = 1, nodes = latest.nodes, chars = latest.chars;
    if (!deep) {
      while (first > 0 && turns < TURBO_MAX_TURNS) {
        const c = segments[first - 1];
        if (nodes + c.nodes > TURBO_MAX_NODES || chars + c.chars > TURBO_MAX_CHARS) break;
        first--; turns++; nodes += c.nodes; chars += c.chars;
      }
      if (turns === users.length && users.length <= TURBO_MAX_TURNS) return null;
    }

    const root = path[0];
    let keep = path.slice(segments[first].start), deepOriginal = 0, deepRetained = 0;
    if (deep) {
      deepOriginal = keep.length;
      const userId = keep[0], tail = keep.slice(Math.max(1, keep.length - DEEP_TAIL_NODES));
      keep = [userId, ...tail.filter(id => id !== userId)];
      deepRetained = keep.length;
      chars = keep.reduce((sum, id) => { const m = mapping[id]?.message; return sum + (m ? JSON.stringify(m).length : 0); }, 0);
    }
    if (!root || !mapping[root] || !keep.length) return null;
    const ids = (keep[0] === root ? keep : [root, ...keep]).filter(id => mapping[id]);
    const trimmed = {};
    ids.forEach((id, i) => trimmed[id] = { ...mapping[id], parent: i ? ids[i - 1] : null, children: i + 1 < ids.length ? [ids[i + 1]] : [] });
    data.mapping = trimmed;
    return { originalNodes: Object.keys(mapping).length, retainedNodes: ids.length, userTurns: turns, retainedMessageChars: chars,
      adaptive: true, deep, deepOriginalTurnNodes: deepOriginal, deepRetainedTurnNodes: deepRetained,
      deepDroppedNodes: deep ? deepOriginal - deepRetained : 0 };
  }

  function trimFlatConversation(data) {
    const list = data?.messages;
    if (!Array.isArray(list) || !list.length) return null;
    const originalMessages = list.length, users = [];
    list.forEach((m, i) => { if (m?.author?.role === 'user') users.push(i); });

    let keep = list, turns = users.length, chars = list.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
    let deep = false, deepOriginal = 0, deepRetained = 0;
    if (users.length) {
      const segments = users.map((start, i) => {
        const end = i + 1 < users.length ? users[i + 1] : list.length;
        let segmentChars = 0;
        for (let j = start; j < end; j++) segmentChars += JSON.stringify(list[j]).length;
        return { start, end, nodes: end - start, chars: segmentChars };
      });
      const latest = segments.at(-1);
      deep = latest.nodes > FLAT_DEEP_TRIGGER_NODES || latest.chars > FLAT_DEEP_TRIGGER_CHARS;
      let first = segments.length - 1, nodes = latest.nodes;
      chars = latest.chars; turns = 1;
      if (!deep) {
        while (first > 0 && turns < TURBO_MAX_TURNS) {
          const c = segments[first - 1];
          if (nodes + c.nodes > TURBO_MAX_NODES || chars + c.chars > TURBO_FLAT_MAX_CHARS) break;
          first--; turns++; nodes += c.nodes; chars += c.chars;
        }
      }
      keep = list.slice(segments[first].start);
      if (deep) {
        deepOriginal = keep.length;
        const user = keep[0], tail = keep.slice(Math.max(1, keep.length - FLAT_DEEP_TAIL_NODES));
        keep = [user, ...tail.filter(m => m !== user)];
        deepRetained = keep.length;
        chars = keep.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
      }
    }

    let changed = keep.length !== list.length;
    if (changed) data.messages = keep;
    if (data.page_info) {
      const firstId = keep[0]?.id, lastId = keep.at(-1)?.id;
      if (data.page_info.has_previous_page !== false) changed = true;
      data.page_info = { ...data.page_info, start_cursor: firstId || data.page_info.start_cursor, end_cursor: lastId || data.page_info.end_cursor, has_previous_page: false };
    }
    if (!changed) return null;
    return {
      originalNodes: originalMessages, retainedNodes: keep.length, userTurns: turns, retainedMessageChars: chars,
      adaptive: true, flat: true, deep, deepOriginalTurnNodes: deepOriginal, deepRetainedTurnNodes: deepRetained,
      deepDroppedNodes: deep ? deepOriginal - deepRetained : 0, historyBlocked: true,
    };
  }
  function installTurboFetch() {
    if (!turboEnabled() || window.fetch?.__cgptRecentMessagesTurbo) return;
    const original = window.fetch.bind(window);
    const wrapped = async (...incoming) => {
      const info = conversationFetchInfo(incoming[0], incoming[1]);
      if (info?.kind === 'flat-history') {
        if (incoming[1]?.[HISTORY_MANUAL_FLAG]) {
          const cleanInit = { ...incoming[1] };
          delete cleanInit[HISTORY_MANUAL_FLAG];
          return original(incoming[0], cleanInit);
        }
        window.__cgptRecentMessagesBlockedHistory = (window.__cgptRecentMessagesBlockedHistory || 0) + 1;
        if (window.__cgptRecentMessagesTrimStats) window.__cgptRecentMessagesTrimStats.blockedHistoryPages = window.__cgptRecentMessagesBlockedHistory;
        return emptyFlatHistoryResponse();
      }

      let args = incoming, requestStats = null;
      if (info?.kind === 'flat-main') {
        const capped = capFlatRequest(incoming, info);
        args = capped.args;
        requestStats = { requestedTurns: capped.requestedTurns, networkTurns: capped.networkTurns };
        window.__cgptRecentMessagesTrimStats = null;
        window.__cgptRecentMessagesBlockedHistory = 0;
      } else if (info?.kind === 'legacy') {
        window.__cgptRecentMessagesTrimStats = null;
      }

      const response = await original(...args);
      if (!info || !response.ok) return response;
      try {
        const text = await response.clone().text();
        if (info.kind === 'legacy' && text.length < TURBO_MIN_RESPONSE) return response;
        const data = JSON.parse(text);
        if (info.kind === 'flat-main') captureFlatHistory(data, info);
        const stats = info.kind === 'legacy' ? trimConversation(data) : trimFlatConversation(data);
        if (!stats) {
          if (info.kind === 'flat-main') {
            const count = Array.isArray(data.messages) ? data.messages.length : 0;
            window.__cgptRecentMessagesTrimStats = { originalNodes: count, retainedNodes: count, userTurns: 0, flat: true,
              ...requestStats, beforeChars: text.length, afterChars: text.length, blockedHistoryPages: 0, version: VERSION };
          }
          return response;
        }
        const body = JSON.stringify(data), headers = new Headers(response.headers);
        headers.delete('content-length'); headers.delete('content-encoding');
        window.__cgptRecentMessagesTrimStats = { ...stats, ...requestStats, beforeChars: text.length, afterChars: body.length,
          blockedHistoryPages: window.__cgptRecentMessagesBlockedHistory || 0, version: VERSION };
        return new Response(body, { status: response.status, statusText: response.statusText, headers });
      } catch (error) { console.debug('[ChatGPT Recent Messages] Turbo trim skipped:', error); return response; }
    };
    Object.defineProperty(wrapped, '__cgptRecentMessagesTurbo', { value: true });
    window.fetch = wrapped;
  }
  installTurboFetch();

  const icons = {
    older: '<svg viewBox="0 0 24 24"><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg>',
    all: '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    recent: '<svg viewBox="0 0 24 24"><path d="M4 8h16M7 12h10M10 16h4"/></svg>',
    reset: '<svg viewBox="0 0 24 24"><path d="M4 4v6h6"/><path d="M5.5 15a7 7 0 1 0 .8-7.8L4 10"/></svg>',
    turbo: '<svg viewBox="0 0 24 24"><path d="M13 2 5 13h6l-1 9 8-12h-6l1-8Z"/></svg>',
    tools: '<svg viewBox="0 0 24 24"><path d="M4 7h4M16 7h4M8 4v6M4 17h7M15 17h5M15 14v6"/></svg>',
    panel: '<svg viewBox="0 0 24 24"><path d="M5 7h14M5 12h14M5 17h14"/></svg>',
    collapse: '<svg viewBox="0 0 24 24"><path d="M5 5h14v14H5z"/><path d="m14 9-3 3 3 3"/></svg>',
    grip: '<svg viewBox="0 0 24 24"><circle cx="9" cy="7" r="1"/><circle cx="15" cy="7" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="17" r="1"/><circle cx="15" cy="17" r="1"/></svg>',
  };

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style'); s.id = STYLE_ID; s.textContent = `
      [${HIDDEN}="true"],[${TOOL_HIDDEN}="true"]{display:none!important}
      .${TOOL_BUNDLE}{display:inline-flex;align-items:center;gap:6px;width:max-content;padding:5px 9px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:9px;background:transparent;color:var(--text-secondary,currentColor);cursor:pointer;font:inherit;font-size:.875em;opacity:.82}
      .${TOOL_BUNDLE}:hover{opacity:1}.cgpt-tool-bundle-chevron{transition:transform .12s ease}.${TOOL_BUNDLE}[data-expanded="true"] .cgpt-tool-bundle-chevron{transform:rotate(180deg)}
      #${PANEL_ID}{position:fixed;right:14px;bottom:88px;z-index:2147483647;display:flex;flex-direction:column;align-items:center;gap:6px;padding:6px;border:1px solid color-mix(in srgb,CanvasText 16%,transparent);border-radius:12px;background:color-mix(in srgb,Canvas 94%,transparent);color:CanvasText;box-shadow:0 4px 18px rgba(0,0,0,.14);backdrop-filter:blur(10px);font:11px/1.2 system-ui,sans-serif;transition:transform .16s ease;touch-action:none}
      #${PANEL_ID} .cgpt-rm-grip{display:grid;place-items:center;width:30px;height:16px;opacity:.45;cursor:grab;touch-action:none}#${PANEL_ID} .cgpt-rm-grip:active{cursor:grabbing}#${PANEL_ID} .cgpt-rm-grip svg{width:16px;height:16px}#${PANEL_ID} .cgpt-rm-status{min-width:30px;padding:2px 3px;text-align:center;opacity:.68;white-space:nowrap}#${PANEL_ID} button{position:relative;display:grid;place-items:center;width:32px;height:32px;padding:0;border:1px solid color-mix(in srgb,CanvasText 16%,transparent);border-radius:9px;background:Canvas;color:CanvasText;cursor:pointer}#${PANEL_ID} button[data-active="true"]{box-shadow:inset 0 0 0 1px currentColor}#${PANEL_ID} svg,.${TOOL_BUNDLE} svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
      #${PANEL_ID}[data-collapsed="true"]{gap:0;padding:4px;border-radius:999px;cursor:grab}#${PANEL_ID}[data-collapsed="true"]>:not([data-action="panel"]){display:none!important}#${PANEL_ID}[data-collapsed="true"] [data-action="panel"]{display:grid;width:34px;height:34px;border-radius:999px;cursor:grab;touch-action:none}#${PANEL_ID}[data-dragging="true"]{transition:none!important;transform:none!important;cursor:grabbing}#${PANEL_ID}[data-dragging="true"] [data-action="panel"]{cursor:grabbing}#${PANEL_ID}[data-edge="left"][data-peek="true"]{transform:translateX(-55%)}#${PANEL_ID}[data-edge="right"][data-peek="true"]{transform:translateX(55%)}
      #${PANEL_ID} button::after{content:attr(data-tooltip);position:absolute;right:calc(100% + 9px);top:50%;transform:translateY(-50%) translateX(4px);padding:6px 8px;border-radius:7px;background:#111;color:#fff;font:12px/1.2 system-ui,sans-serif;white-space:nowrap;opacity:0;visibility:hidden;pointer-events:none}#${PANEL_ID} button:hover::after,#${PANEL_ID} button:focus-visible::after{opacity:1;visibility:visible;transform:translateY(-50%)}#${PANEL_ID}[data-edge="left"] button::after{left:calc(100% + 9px);right:auto;transform:translateY(-50%) translateX(-4px)}#${PANEL_ID}[data-edge="left"] button:hover::after,#${PANEL_ID}[data-edge="left"] button:focus-visible::after{transform:translateY(-50%) translateX(0)}
      #${HISTORY_ARCHIVE_ID}{position:fixed;top:72px;right:64px;z-index:2147483646;width:min(720px,calc(100vw - 96px));max-height:calc(100vh - 112px);overflow:auto;border:1px solid color-mix(in srgb,CanvasText 16%,transparent);border-radius:14px;background:color-mix(in srgb,Canvas 97%,transparent);color:CanvasText;box-shadow:0 12px 40px rgba(0,0,0,.22);backdrop-filter:blur(14px);font:14px/1.55 system-ui,sans-serif}
      #${HISTORY_ARCHIVE_ID} .cgpt-rh-head{position:sticky;top:0;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border-bottom:1px solid color-mix(in srgb,CanvasText 12%,transparent);background:color-mix(in srgb,Canvas 96%,transparent)}#${HISTORY_ARCHIVE_ID} .cgpt-rh-close{display:grid;place-items:center;width:30px;height:30px;border:0;border-radius:8px;background:transparent;color:inherit;font:22px/1 system-ui;cursor:pointer}#${HISTORY_ARCHIVE_ID} .cgpt-rh-close:hover{background:color-mix(in srgb,CanvasText 8%,transparent)}
      #${HISTORY_ARCHIVE_ID} .cgpt-rh-body{padding:4px 14px 14px}#${HISTORY_ARCHIVE_ID} .cgpt-rh-turn{padding:14px 0;border-bottom:1px solid color-mix(in srgb,CanvasText 10%,transparent)}#${HISTORY_ARCHIVE_ID} .cgpt-rh-turn:last-child{border-bottom:0}#${HISTORY_ARCHIVE_ID} .cgpt-rh-label{margin:8px 0 4px;font-size:11px;font-weight:600;opacity:.58;text-transform:uppercase;letter-spacing:.04em}#${HISTORY_ARCHIVE_ID} .cgpt-rh-user,#${HISTORY_ARCHIVE_ID} .cgpt-rh-assistant{white-space:pre-wrap;overflow-wrap:anywhere}#${HISTORY_ARCHIVE_ID} .cgpt-rh-user{margin-left:auto;max-width:88%;padding:8px 10px;border-radius:12px;background:color-mix(in srgb,CanvasText 7%,Canvas)}#${HISTORY_ARCHIVE_ID} .cgpt-rh-tools{margin-top:8px;font-size:12px;opacity:.55}
    `; (document.head || document.documentElement).appendChild(s);
  }

  const messages = () => [...document.querySelectorAll(TURN_SELECTOR)];
  function hidden(node, attr, value) { const old = node.getAttribute(attr) === 'true'; if (old === value) return; value ? node.setAttribute(attr, 'true') : node.removeAttribute(attr); }
  function spacer(node) { return node?.nodeType === 1 && node.tagName === 'DIV' && node.classList.contains('empty:hidden') && !(node.textContent || '').trim(); }

  function restoreTools(container) { container.querySelectorAll(`:scope>.${TOOL_BUNDLE}`).forEach(x => x.remove()); container.querySelectorAll(`:scope>${TOOL_SELECTOR}`).forEach(x => hidden(x, TOOL_HIDDEN, false)); }
  function setBundle(button, tools, expanded) { button.__members = tools; button.dataset.expanded = String(expanded); const label = t.bundle(tools.length, expanded); button.setAttribute('aria-label', label); button.querySelector('span').textContent = label; tools.forEach(x => hidden(x, TOOL_HIDDEN, !expanded)); }
  function makeBundle(container, anchor) { const b = document.createElement('button'); b.type='button'; b.className=TOOL_BUNDLE; b.__anchor=anchor; b.innerHTML=`${icons.tools}<span></span><svg class="cgpt-tool-bundle-chevron" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg>`; b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); const list=(b.__members||[]).filter(x=>x.isConnected&&x.parentElement===container); setBundle(b,list,b.dataset.expanded!=='true'); }); return b; }
  function compact(container) {
    if (!container?.isConnected) return; const observer=toolObservers.get(container); observer?.disconnect();
    try { if (!toolEnabled()) return restoreTools(container); const existing=[...container.querySelectorAll(`:scope>.${TOOL_BUNDLE}`)], byAnchor=new Map(existing.map(x=>[x.__anchor,x])), claimed=new Set(); let group=[];
      const flush=()=>{ if(!group.length)return; if(group.length<2){group.forEach(x=>hidden(x,TOOL_HIDDEN,false));group=[];return} const anchor=group[0]; let b=byAnchor.get(anchor); if(!b){b=makeBundle(container,anchor);container.insertBefore(b,anchor)} claimed.add(b);setBundle(b,group,b.dataset.expanded==='true');group=[] };
      [...container.children].forEach(child=>{ if(child.classList?.contains(TOOL_BUNDLE))return; if(child.matches?.(TOOL_SELECTOR)){group.push(child);return} if(group.length&&spacer(child))return;flush() }); flush(); existing.forEach(x=>{if(!claimed.has(x))x.remove()});
    } finally { if(observer&&container.isConnected) observer.observe(container,{childList:true}); }
  }
  function toolContainers(list){const set=new Set();list.forEach(m=>m.querySelectorAll('[class~="agent-turn"] div.flex.flex-col.grow').forEach(x=>set.add(x)));return set}
  function syncTools(list){const set=toolContainers(list);if(!toolEnabled()){stopTools();set.forEach(restoreTools);return}for(const [c,o] of toolObservers){if(c.isConnected&&set.has(c))continue;o.disconnect();toolObservers.delete(c)}for(const c of set){if(!toolObservers.has(c)){const o=new MutationObserver(()=>{clearTimeout(toolTimers.get(c));toolTimers.set(c,setTimeout(()=>{compact(c);updatePanel(messages().length)},180))});o.observe(c,{childList:true});toolObservers.set(c,o)}compact(c)}}
  function stopTools(){toolObservers.forEach(o=>o.disconnect());toolObservers.clear();toolTimers.forEach(clearTimeout);toolTimers.clear();clearTimeout(toolUiTimer)}

  function findRoot(list){if(!list.length)return null;let r=list[0].parentElement;while(r&&!list.every(x=>r.contains(x)))r=r.parentElement;return r}
  function bindList(list){const next=findRoot(list);if(!next||(next===listRoot&&listObserver))return;listObserver?.disconnect();discoveryObserver?.disconnect();listRoot=next;listObserver=new MutationObserver(()=>scheduleUpdate(40));listObserver.observe(next,{childList:true})}
  function discover(){if(!document.body||listObserver)return;discoveryObserver?.disconnect();discoveryObserver=new MutationObserver(rs=>{if(rs.some(r=>[...r.addedNodes].some(n=>n?.nodeType===1&&(n.matches?.(TURN_SELECTOR)||n.querySelector?.(TURN_SELECTOR))))){discoveryObserver.disconnect();scheduleUpdate(0)}});discoveryObserver.observe(document.body,{childList:true,subtree:true})}
  function setScroll(next){if(next===scrollRoot)return;scrollRoot?.removeEventListener('scroll',onScroll);scrollRoot=next;scrollRoot?.addEventListener('scroll',onScroll,{passive:true})}
  function apply(){const list=messages();if(!list.length){removePanel();listObserver?.disconnect();listObserver=null;stopTools();discover();return}const first=showAll?0:Math.max(0,list.length-visibleCount);list.forEach((x,i)=>hidden(x,HIDDEN,i<first));syncTools(list);ensurePanel();updatePanel(list.length);setScroll(document.querySelector(SCROLL_SELECTOR)||document.scrollingElement);bindList(list)}
  async function revealOlder(allowRemote=false){const list=messages();if(!list.length)return;const first=showAll?0:Math.max(0,list.length-visibleCount);if(first){visibleCount=Math.min(list.length,visibleCount+LOAD_STEP);apply();return}if(!allowRemote||!turboEnabled())return;if(historyState.turns.length&&!document.getElementById(HISTORY_ARCHIVE_ID)){renderHistoryArchive();updatePanel(list.length);return}if(historyState.hasPrevious)await loadOlderHistory()}
  function onScroll(){if(!scrollRoot||showAll)return;const top=scrollRoot.scrollTop;if(top>TOP_THRESHOLD_PX*2){topLoadArmed=true;return}if(topLoadArmed&&top<=TOP_THRESHOLD_PX){topLoadArmed=false;apply();revealOlder(false)}}

  function clearCollapse(){clearTimeout(collapseTimer);collapseTimer=null}
  function clearPeek(){clearTimeout(peekTimer);peekTimer=null}
  function label(b,text){if(!b)return;b.dataset.tooltip=text;b.setAttribute('aria-label',text)}
  function setPeek(value){const p=document.getElementById(PANEL_ID);if(!p)return;clearPeek();p.dataset.peek=String(Boolean(value&&p.dataset.edge))}
  function schedulePeek(delay=PANEL_EDGE_PEEK_MS){clearPeek();const p=document.getElementById(PANEL_ID);if(!p||!p.dataset.edge||p.dataset.collapsed!=='true'||p.dataset.dragging==='true')return;peekTimer=setTimeout(()=>{peekTimer=null;if(!p.isConnected||p.dataset.dragging==='true'||p.dataset.collapsed!=='true')return;if(p.matches(':hover')||p.contains(document.activeElement))return schedulePeek();p.dataset.peek='true'},delay)}
  function scheduleCollapse(){clearCollapse();const p=document.getElementById(PANEL_ID);if(!p||p.dataset.collapsed==='true')return;collapseTimer=setTimeout(()=>{collapseTimer=null;if(!p.isConnected)return;if(p.contains(document.activeElement))return scheduleCollapse();collapse(true)},PANEL_AUTO_COLLAPSE_MS)}
  function syncPanelToggle(p){const b=p?.querySelector('[data-action="panel"]');if(!b)return;const isCollapsed=p.dataset.collapsed==='true';b.innerHTML=isCollapsed?icons.panel:icons.collapse;label(b,isCollapsed?t.open:t.close)}
  function readPanelPosition(){try{const v=JSON.parse(localStorage.getItem(PANEL_POSITION_KEY)||'null');return v&&Number.isFinite(v.x)&&Number.isFinite(v.y)?v:null}catch{return null}}
  function savePanelPosition(p){const x=Number.parseFloat(p.style.left),y=Number.parseFloat(p.style.top);if(!Number.isFinite(x)||!Number.isFinite(y))return;localStorage.setItem(PANEL_POSITION_KEY,JSON.stringify({x,y,edge:p.dataset.edge||''}))}
  function clampPanel(p,persist=false){if(!p?.isConnected)return;setPeek(false);const w=p.offsetWidth,h=p.offsetHeight,r=p.getBoundingClientRect();let x=Number.parseFloat(p.style.left),y=Number.parseFloat(p.style.top);if(!Number.isFinite(x))x=r.left;if(!Number.isFinite(y))y=r.top;const maxX=Math.max(0,innerWidth-w),maxY=Math.max(0,innerHeight-h),edge=p.dataset.edge||'';x=edge==='left'?0:edge==='right'?maxX:Math.min(Math.max(4,x),Math.max(4,maxX-4));y=Math.min(Math.max(4,y),Math.max(4,maxY-4));p.style.left=`${Math.round(x)}px`;p.style.top=`${Math.round(y)}px`;p.style.right='auto';p.style.bottom='auto';if(persist)savePanelPosition(p)}
  function parkEdge(p,persist=true){clearCollapse();setPeek(false);p.dataset.collapsed='true';syncPanelToggle(p);requestAnimationFrame(()=>{clampPanel(p,persist);schedulePeek()})}
  function restorePanelPosition(p){const pos=readPanelPosition();if(!pos)return;p.dataset.edge=pos.edge==='left'||pos.edge==='right'?pos.edge:'';p.style.left=`${pos.x}px`;p.style.top=`${pos.y}px`;p.style.right='auto';p.style.bottom='auto';if(p.dataset.edge){p.dataset.collapsed='true';syncPanelToggle(p)}requestAnimationFrame(()=>{clampPanel(p,false);if(p.dataset.edge)schedulePeek()})}
  function collapse(value){const p=document.getElementById(PANEL_ID);if(!p)return;clearCollapse();setPeek(false);p.dataset.collapsed=String(value);syncPanelToggle(p);requestAnimationFrame(()=>{clampPanel(p,false);if(value&&p.dataset.edge)schedulePeek()});if(!value)scheduleCollapse()}
  function startPanelDrag(p,e){const collapsed=p.dataset.collapsed==='true',handle=e.target.closest('.cgpt-rm-grip')||(collapsed?e.target.closest('[data-action="panel"]'):null);if(e.button!==0||!handle)return;clearCollapse();const r=p.getBoundingClientRect(),storedLeft=Number.parseFloat(p.style.left),storedTop=Number.parseFloat(p.style.top);dragState={pointerId:e.pointerId,startX:e.clientX,startY:e.clientY,left:Number.isFinite(storedLeft)?storedLeft:r.left,top:Number.isFinite(storedTop)?storedTop:r.top,moved:false,collapsed};}
  function movePanelDrag(p,e){if(!dragState||e.pointerId!==dragState.pointerId)return;const dx=e.clientX-dragState.startX,dy=e.clientY-dragState.startY;if(!dragState.moved){if(Math.hypot(dx,dy)<PANEL_DRAG_THRESHOLD_PX)return;dragState.moved=true;setPeek(false);p.dataset.dragging='true';p.dataset.edge='';p.style.left=`${dragState.left}px`;p.style.top=`${dragState.top}px`;p.style.right='auto';p.style.bottom='auto';try{p.setPointerCapture(e.pointerId)}catch{}}e.preventDefault();const x=Math.min(Math.max(0,dragState.left+dx),Math.max(0,innerWidth-p.offsetWidth));const y=Math.min(Math.max(0,dragState.top+dy),Math.max(0,innerHeight-p.offsetHeight));p.style.left=`${Math.round(x)}px`;p.style.top=`${Math.round(y)}px`}
  function endPanelDrag(p,e){if(!dragState||e.pointerId!==dragState.pointerId)return;const moved=dragState.moved,wasCollapsed=dragState.collapsed;if(!moved){dragState=null;p.dataset.dragging='false';if(wasCollapsed){suppressPanelClickUntil=performance.now()+350;collapse(false);return}if(p.dataset.collapsed==='true'&&p.dataset.edge)schedulePeek();return}try{p.releasePointerCapture(e.pointerId)}catch{}p.dataset.dragging='false';const x=Number.parseFloat(p.style.left)||0,w=p.offsetWidth,rightGap=innerWidth-(x+w);p.dataset.edge=x<=PANEL_SNAP_PX?'left':rightGap<=PANEL_SNAP_PX?'right':'';dragState=null;suppressPanelClickUntil=performance.now()+350;if(p.dataset.edge)parkEdge(p,true);else{clampPanel(p,true);if(p.dataset.collapsed!=='true')scheduleCollapse()}}
  function ensurePanel(){if(document.getElementById(PANEL_ID)||!document.body)return;const p=document.createElement('div');p.id=PANEL_ID;p.dataset.collapsed='false';p.dataset.peek='false';p.dataset.edge='';p.dataset.dragging='false';p.innerHTML=`<span class="cgpt-rm-grip" title="${t.drag}" aria-label="${t.drag}">${icons.grip}</span><span class="cgpt-rm-status"></span><button data-action="older">${icons.older}</button><button data-action="toggle">${icons.all}</button><button data-action="reset">${icons.reset}</button><button data-action="turbo">${icons.turbo}</button><button data-action="tools">${icons.tools}</button><button data-action="panel">${icons.collapse}</button>`;p.addEventListener('click',e=>{const b=e.target.closest('button'),a=b?.dataset.action;if(a==='panel'){if(performance.now()<suppressPanelClickUntil){e.preventDefault();e.stopPropagation();b.blur();return}b.blur();return collapse(p.dataset.collapsed!=='true')}if(a==='older')revealOlder(true);else if(a==='toggle'){showAll=!showAll;if(!showAll)visibleCount=INITIAL_MESSAGES;apply()}else if(a==='reset'){showAll=false;visibleCount=INITIAL_MESSAGES;resetHistoryArchive();apply()}else if(a==='turbo'){setTurbo(!turboEnabled());location.reload();return}else if(a==='tools'){setTools(!toolEnabled());syncTools(messages());updatePanel(messages().length)}b?.blur();scheduleCollapse()});p.addEventListener('pointerdown',e=>startPanelDrag(p,e));p.addEventListener('pointermove',e=>{if(dragState)movePanelDrag(p,e);else{setPeek(false);scheduleCollapse();if(p.dataset.collapsed==='true'&&p.dataset.edge)schedulePeek()}});p.addEventListener('pointerup',e=>endPanelDrag(p,e));p.addEventListener('pointercancel',e=>endPanelDrag(p,e));p.addEventListener('pointerenter',()=>{setPeek(false);scheduleCollapse();if(p.dataset.collapsed==='true'&&p.dataset.edge)schedulePeek()});p.addEventListener('pointerleave',()=>{scheduleCollapse();schedulePeek()});p.addEventListener('focusin',()=>{setPeek(false);scheduleCollapse()});p.addEventListener('focusout',()=>{scheduleCollapse();schedulePeek()});p.addEventListener('keydown',scheduleCollapse);document.body.appendChild(p);restorePanelPosition(p);syncPanelToggle(p);scheduleCollapse()}
  function updatePanel(total){const p=document.getElementById(PANEL_ID);if(!p)return;syncPanelToggle(p);const visible=showAll?total:Math.min(total,visibleCount);p.querySelector('.cgpt-rm-status').textContent=t.status(visible,total);const old=p.querySelector('[data-action="older"]'),nativeOlder=!showAll&&visible<total,archiveClosed=historyState.turns.length>0&&!document.getElementById(HISTORY_ARCHIVE_ID),remoteOlder=turboEnabled()&&(historyState.hasPrevious||archiveClosed);old.disabled=historyState.loading||(!nativeOlder&&!remoteOlder);label(old,historyState.loading?t.olderLoading:(archiveClosed?t.olderReopen:(!nativeOlder&&!remoteOlder?t.olderNone:t.older)));const toggle=p.querySelector('[data-action="toggle"]');label(toggle,showAll?t.recent:t.all);toggle.innerHTML=showAll?icons.recent:icons.all;label(p.querySelector('[data-action="reset"]'),t.reset);const turbo=p.querySelector('[data-action="turbo"]'),enabled=turboEnabled(),stats=window.__cgptRecentMessagesTrimStats;let tl=enabled?t.turboOn:t.turboOff;if(enabled&&stats?.beforeChars&&stats?.afterChars){tl+=` (${(stats.beforeChars/1e6).toFixed(2)} MB → ${(stats.afterChars/1e6).toFixed(2)} MB) · ${stats.retainedNodes} ${stats.flat?'messages':'nodes'}`;if(stats.flat&&stats.requestedTurns&&stats.networkTurns)tl+=` · API ${stats.requestedTurns}→${stats.networkTurns} turns`;if(stats.historyBlocked)tl+=` · auto history blocked`;if(stats.deep)tl+=` · deep ${stats.deepOriginalTurnNodes}→${stats.deepRetainedTurnNodes}`}label(turbo,tl);turbo.dataset.active=String(enabled);const tools=p.querySelector('[data-action="tools"]');label(tools,toolEnabled()?t.toolsOn:t.toolsOff);tools.dataset.active=String(toolEnabled())}
  function removePanel(){clearCollapse();clearPeek();dragState=null;document.getElementById(PANEL_ID)?.remove()}
  function scheduleUpdate(delay=60){clearTimeout(updateTimer);updateTimer=setTimeout(apply,delay)}

  function routeChange(){if(location.href===lastUrl)return;lastUrl=location.href;installTurboFetch();showAll=false;visibleCount=INITIAL_MESSAGES;resetHistoryState();listObserver?.disconnect();listObserver=null;listRoot=null;stopTools();setScroll(null);discover();scheduleUpdate(0)}
  function installRoutes(){for(const method of ['pushState','replaceState']){const original=history[method];if(original.__cgptRecentMessagesWrapped)continue;const wrapped=function(...args){installTurboFetch();const result=original.apply(this,args);queueMicrotask(routeChange);return result};Object.defineProperty(wrapped,'__cgptRecentMessagesWrapped',{value:true});history[method]=wrapped}document.addEventListener('click',e=>{const a=e.target.closest?.('a[href]');if(!a)return;try{if(new URL(a.href,location.href).origin===location.origin&&/\/c\/[0-9a-f-]+$/i.test(new URL(a.href,location.href).pathname))installTurboFetch()}catch{}},true);window.addEventListener('popstate',()=>{installTurboFetch();queueMicrotask(routeChange)})}
  function init(){ensureStyle();installRoutes();installTurboFetch();window.addEventListener('resize',()=>{const p=document.getElementById(PANEL_ID);if(!p)return;setPeek(false);requestAnimationFrame(()=>{clampPanel(p,true);if(p.dataset.edge)schedulePeek()})},{passive:true});discover();scheduleUpdate(0)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
