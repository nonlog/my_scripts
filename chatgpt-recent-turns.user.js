// ==UserScript==
// @name         ChatGPT Recent Messages
// @namespace    https://github.com/nonlog/my_scripts
// @version      0.4.0
// @description  Reduce long-chat rendering, tool-call layout, and client-state overhead in ChatGPT Web.
// @match        https://chatgpt.com/*
// @run-at       document-start
// @early-start
// @inject-into  page
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.4.0';
  const INITIAL_MESSAGES = 5;
  const LOAD_STEP = 5;
  const TOP_THRESHOLD_PX = 220;

  // Heavy conversations can contain hundreds of hidden assistant/tool nodes even
  // when ChatGPT itself only materializes a few visible turns. Turbo mode trims
  // the conversation mapping before ChatGPT parses it into its long-lived state.
  const TURBO_STORAGE_KEY = 'cgpt-recent-messages-turbo-v1';
  const TURBO_MAX_USER_TURNS = 3;
  const TURBO_MAX_RETAINED_NODES = 450;
  const TURBO_MAX_RETAINED_MESSAGE_CHARS = 700_000;
  const TURBO_MIN_RESPONSE_CHARS = 1_000_000;

  // Tool Compactor keeps React's nodes intact for compatibility, but removes
  // collapsed tool rows from layout/paint and replaces each run with one button.
  const TOOL_COMPACT_STORAGE_KEY = 'cgpt-recent-messages-tool-compact-v1';
  const TOOL_SELECTOR = 'span.group\\/tool-message';
  const TOOL_HIDDEN_ATTR = 'data-cgpt-tool-compacted';
  const TOOL_BUNDLE_CLASS = 'cgpt-tool-bundle';
  const TOOL_COMPACT_MIN_GROUP = 2;

  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const SCROLL_ROOT_SELECTOR = '[class~="group/scroll-root"]';
  const HIDDEN_ATTR = 'data-cgpt-recent-hidden';
  const PANEL_ID = 'cgpt-recent-messages-panel';
  const STYLE_ID = 'cgpt-recent-messages-style';

  const preferredLanguage = navigator.languages?.[0] || navigator.language || '';
  const isZh = /^zh\b/i.test(preferredLanguage);

  const t = isZh
    ? {
        older: `加载前 ${LOAD_STEP} 条消息`,
        showAll: '显示全部已加载消息',
        recent: `只显示最近 ${INITIAL_MESSAGES} 条消息`,
        reset: `重置为最近 ${INITIAL_MESSAGES} 条消息`,
        turboOn: `Turbo 已开启：重型会话自适应保留最多 ${TURBO_MAX_USER_TURNS} 个完整用户回合；点击关闭并重新加载完整历史`,
        turboOff: 'Turbo 已关闭：点击开启并重新加载；仅对重型会话裁剪客户端历史',
        toolCompactOn: 'Tool Compactor 已开启：连续工具调用合并为一个按钮；点击关闭',
        toolCompactOff: 'Tool Compactor 已关闭：点击合并连续工具调用',
        toolBundle: (count, expanded) => expanded ? `${count} 个 tool calls · 收起` : `${count} 个 tool calls`,
        status: (visible, total) => `${visible}/${total}`,
      }
    : {
        older: `Load ${LOAD_STEP} older messages`,
        showAll: 'Show all currently loaded messages',
        recent: `Show only the latest ${INITIAL_MESSAGES} messages`,
        reset: `Reset to the latest ${INITIAL_MESSAGES} messages`,
        turboOn: `Turbo is ON: heavy chats adaptively keep up to ${TURBO_MAX_USER_TURNS} complete user turns; click to disable and reload full history`,
        turboOff: 'Turbo is OFF: click to enable and reload; only heavy chats are trimmed',
        toolCompactOn: 'Tool Compactor is ON: consecutive tool calls are collapsed into one button; click to disable',
        toolCompactOff: 'Tool Compactor is OFF: click to collapse consecutive tool calls',
        toolBundle: (count, expanded) => expanded ? `${count} tool calls · collapse` : `${count} tool calls`,
        status: (visible, total) => `${visible}/${total}`,
      };

  let visibleCount = INITIAL_MESSAGES;
  let showAll = false;
  let updateTimer = null;
  let scrollContainer = null;
  let listObserver = null;
  let listRoot = null;
  let discoveryObserver = null;
  const toolObservers = new Map();
  const toolCompactTimers = new Map();
  let topLoadArmed = true;
  let lastUrl = location.href;

  function turboEnabled() {
    return localStorage.getItem(TURBO_STORAGE_KEY) !== '0';
  }

  function setTurboEnabled(enabled) {
    localStorage.setItem(TURBO_STORAGE_KEY, enabled ? '1' : '0');
  }

  function toolCompactorEnabled() {
    return localStorage.getItem(TOOL_COMPACT_STORAGE_KEY) !== '0';
  }

  function setToolCompactorEnabled(enabled) {
    localStorage.setItem(TOOL_COMPACT_STORAGE_KEY, enabled ? '1' : '0');
  }

  function getRequestUrl(input) {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    return input?.url || '';
  }

  function getRequestMethod(input, init) {
    return String(init?.method || input?.method || 'GET').toUpperCase();
  }

  function isConversationFetch(input, init) {
    if (getRequestMethod(input, init) !== 'GET') return false;

    try {
      const url = new URL(getRequestUrl(input), location.origin);
      return /^\/backend-api\/conversation\/[0-9a-f-]+$/i.test(url.pathname);
    } catch {
      return false;
    }
  }

  function trimConversationMapping(data) {
    const mapping = data?.mapping;
    const currentNode = data?.current_node;
    if (!mapping || typeof mapping !== 'object' || !currentNode) return null;

    const path = [];
    const seen = new Set();
    let id = currentNode;

    while (id && mapping[id] && !seen.has(id)) {
      seen.add(id);
      path.push(id);
      id = mapping[id].parent;
    }

    path.reverse();
    if (path.length < 2) return null;

    const userIndexes = [];
    for (let index = 0; index < path.length; index += 1) {
      const node = mapping[path[index]];
      if (node?.message?.author?.role === 'user') userIndexes.push(index);
    }

    // Never cut through the only user turn. Tool Compactor handles the visual
    // overhead in that case; Turbo only drops whole, older user-turn segments.
    if (userIndexes.length < 2) return null;

    const segments = userIndexes.map((startIndex, segmentIndex) => {
      const endIndex = segmentIndex + 1 < userIndexes.length
        ? userIndexes[segmentIndex + 1]
        : path.length;

      let messageChars = 0;
      for (let index = startIndex; index < endIndex; index += 1) {
        const message = mapping[path[index]]?.message;
        if (message) messageChars += JSON.stringify(message).length;
      }

      return {
        startIndex,
        endIndex,
        nodeCount: endIndex - startIndex,
        messageChars,
      };
    });

    // Always keep the latest complete user turn. Add older complete turns only
    // while they fit both the node and serialized-message budgets.
    let firstKeptSegment = segments.length - 1;
    let keptTurns = 1;
    let retainedPathNodes = segments[firstKeptSegment].nodeCount;
    let retainedMessageChars = segments[firstKeptSegment].messageChars;

    while (firstKeptSegment > 0 && keptTurns < TURBO_MAX_USER_TURNS) {
      const candidate = segments[firstKeptSegment - 1];
      const candidateNodes = retainedPathNodes + candidate.nodeCount;
      const candidateChars = retainedMessageChars + candidate.messageChars;

      if (
        candidateNodes > TURBO_MAX_RETAINED_NODES ||
        candidateChars > TURBO_MAX_RETAINED_MESSAGE_CHARS
      ) {
        break;
      }

      firstKeptSegment -= 1;
      keptTurns += 1;
      retainedPathNodes = candidateNodes;
      retainedMessageChars = candidateChars;
    }

    // If the whole conversation already fits within the configured turn count
    // and budgets, leave ChatGPT's original mapping untouched.
    if (keptTurns === userIndexes.length && userIndexes.length <= TURBO_MAX_USER_TURNS) {
      return null;
    }

    const startIndex = segments[firstKeptSegment].startIndex;
    const rootId = path[0];
    const retainedPath = path.slice(startIndex);
    const firstRetainedId = retainedPath[0];

    if (!rootId || !mapping[rootId] || !firstRetainedId) return null;

    const retainedIds = firstRetainedId === rootId
      ? retainedPath
      : [rootId, ...retainedPath];
    const retainedSet = new Set(retainedIds);
    const trimmed = {};

    for (const nodeId of retainedIds) {
      const source = mapping[nodeId];
      if (!source) continue;

      const copy = { ...source };

      if (nodeId === rootId) {
        copy.parent = null;
        copy.children = firstRetainedId === rootId
          ? (Array.isArray(source.children)
              ? source.children.filter(childId => retainedSet.has(childId))
              : [])
          : [firstRetainedId];
      } else {
        copy.parent = nodeId === firstRetainedId
          ? rootId
          : (retainedSet.has(source.parent) ? source.parent : rootId);
        copy.children = Array.isArray(source.children)
          ? source.children.filter(childId => retainedSet.has(childId))
          : [];
      }

      trimmed[nodeId] = copy;
    }

    data.mapping = trimmed;

    return {
      originalNodes: Object.keys(mapping).length,
      retainedNodes: Object.keys(trimmed).length,
      userTurns: keptTurns,
      retainedMessageChars,
      adaptive: true,
    };
  }

  function installTurboFetch() {
    if (!turboEnabled()) return;
    if (window.fetch?.__cgptRecentMessagesTurbo) return;

    const originalFetch = window.fetch.bind(window);

    const wrappedFetch = async (...args) => {
      const conversationRequest = isConversationFetch(args[0], args[1]);
      if (conversationRequest) window.__cgptRecentMessagesTrimStats = null;

      const response = await originalFetch(...args);

      if (!conversationRequest || !response.ok) {
        return response;
      }

      try {
        const text = await response.clone().text();
        if (text.length < TURBO_MIN_RESPONSE_CHARS) return response;

        const data = JSON.parse(text);
        const stats = trimConversationMapping(data);
        if (!stats) return response;

        const body = JSON.stringify(data);
        const headers = new Headers(response.headers);
        headers.delete('content-length');
        headers.delete('content-encoding');

        window.__cgptRecentMessagesTrimStats = {
          ...stats,
          beforeChars: text.length,
          afterChars: body.length,
          version: VERSION,
        };

        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch (error) {
        console.debug('[ChatGPT Recent Messages] Turbo trim skipped:', error);
        return response;
      }
    };

    Object.defineProperty(wrappedFetch, '__cgptRecentMessagesTurbo', {
      value: true,
      configurable: false,
      enumerable: false,
    });

    window.fetch = wrappedFetch;
  }

  // Install as early as possible so the initial conversation request can be trimmed.
  installTurboFetch();

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      [${HIDDEN_ATTR}="true"] {
        display: none !important;
      }

      [${TOOL_HIDDEN_ATTR}="true"] {
        display: none !important;
      }

      .${TOOL_BUNDLE_CLASS} {
        display: inline-flex;
        align-items: center;
        align-self: flex-start;
        gap: 6px;
        width: max-content;
        max-width: 100%;
        padding: 5px 9px;
        border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
        border-radius: 9px;
        background: transparent;
        color: var(--text-secondary, currentColor);
        cursor: pointer;
        font: inherit;
        font-size: .875em;
        line-height: 1.25;
        opacity: .82;
      }

      .${TOOL_BUNDLE_CLASS}:hover,
      .${TOOL_BUNDLE_CLASS}:focus-visible {
        opacity: 1;
        background: color-mix(in srgb, currentColor 7%, transparent);
        outline: none;
      }

      .${TOOL_BUNDLE_CLASS} svg {
        width: 15px;
        height: 15px;
        flex: 0 0 auto;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.8;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      .${TOOL_BUNDLE_CLASS} .cgpt-tool-bundle-chevron {
        transition: transform .12s ease;
      }

      .${TOOL_BUNDLE_CLASS}[data-expanded="true"] .cgpt-tool-bundle-chevron {
        transform: rotate(180deg);
      }

      #${PANEL_ID} {
        position: fixed;
        right: 14px;
        bottom: 88px;
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        padding: 6px;
        border: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
        border-radius: 12px;
        background: color-mix(in srgb, Canvas 94%, transparent);
        color: CanvasText;
        box-shadow: 0 4px 18px rgba(0,0,0,.14);
        backdrop-filter: blur(10px);
        font: 11px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      #${PANEL_ID} .cgpt-rm-status {
        min-width: 30px;
        padding: 2px 3px;
        text-align: center;
        opacity: .68;
        white-space: nowrap;
        user-select: none;
      }

      #${PANEL_ID} button {
        position: relative;
        display: grid;
        place-items: center;
        width: 32px;
        height: 32px;
        padding: 0;
        border: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
        border-radius: 9px;
        background: Canvas;
        color: CanvasText;
        cursor: pointer;
      }

      #${PANEL_ID} button:hover,
      #${PANEL_ID} button:focus-visible {
        background: color-mix(in srgb, CanvasText 7%, Canvas);
        outline: none;
      }

      #${PANEL_ID} button:disabled {
        opacity: .35;
        cursor: default;
      }

      #${PANEL_ID} button[data-active="true"] {
        box-shadow: inset 0 0 0 1px currentColor;
      }

      #${PANEL_ID} svg {
        width: 17px;
        height: 17px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.8;
        stroke-linecap: round;
        stroke-linejoin: round;
        pointer-events: none;
      }

      #${PANEL_ID} button[data-action="turbo"][data-active="true"] svg {
        fill: currentColor;
      }

      #${PANEL_ID} button::after {
        content: attr(data-tooltip);
        position: absolute;
        right: calc(100% + 9px);
        top: 50%;
        transform: translateY(-50%) translateX(4px);
        padding: 6px 8px;
        border-radius: 7px;
        background: #111;
        color: #fff;
        font: 12px/1.2 system-ui, sans-serif;
        white-space: nowrap;
        opacity: 0;
        visibility: hidden;
        pointer-events: none;
        transition: opacity .12s ease, transform .12s ease, visibility .12s ease;
        box-shadow: 0 3px 12px rgba(0,0,0,.22);
      }

      #${PANEL_ID} button:hover::after,
      #${PANEL_ID} button:focus-visible::after {
        opacity: 1;
        visibility: visible;
        transform: translateY(-50%) translateX(0);
      }
    `;

    (document.head || document.documentElement).appendChild(style);
  }

  function getMessages() {
    return [...document.querySelectorAll(TURN_SELECTOR)];
  }

  function setMessageHidden(message, hidden) {
    const currentlyHidden = message.getAttribute(HIDDEN_ATTR) === 'true';
    if (currentlyHidden === hidden) return;

    if (hidden) message.setAttribute(HIDDEN_ATTR, 'true');
    else message.removeAttribute(HIDDEN_ATTR);
  }

  function isToolSpacer(node) {
    return node?.nodeType === Node.ELEMENT_NODE
      && node.tagName === 'DIV'
      && node.classList.contains('empty:hidden')
      && !(node.textContent || '').trim();
  }

  function restoreToolContainer(container) {
    container.querySelectorAll(`:scope > .${TOOL_BUNDLE_CLASS}`).forEach(bundle => bundle.remove());
    container.querySelectorAll(`:scope > ${TOOL_SELECTOR}`).forEach(tool => {
      tool.removeAttribute(TOOL_HIDDEN_ATTR);
    });
  }

  function refreshToolCompactStats(messages = getMessages()) {
    let tools = 0;
    let hidden = 0;
    let bundles = 0;

    for (const message of messages) {
      tools += message.querySelectorAll(TOOL_SELECTOR).length;
      hidden += message.querySelectorAll(`${TOOL_SELECTOR}[${TOOL_HIDDEN_ATTR}="true"]`).length;
      bundles += message.querySelectorAll(`.${TOOL_BUNDLE_CLASS}`).length;
    }

    window.__cgptRecentMessagesToolStats = {
      enabled: toolCompactorEnabled(),
      tools,
      hidden,
      bundles,
      version: VERSION,
    };
  }

  function compactToolsInContainer(container) {
    if (!container?.isConnected) return;

    const observer = toolObservers.get(container);
    observer?.disconnect();

    try {
      restoreToolContainer(container);
      if (!toolCompactorEnabled()) return;

      const expandedGroups = container.__cgptExpandedToolGroups
        || (container.__cgptExpandedToolGroups = new Set());
      const children = [...container.children];
      let group = [];
      let groupIndex = 0;

      const flushGroup = () => {
        if (!group.length) return;

        const currentGroupIndex = groupIndex;
        groupIndex += 1;

        if (group.length < TOOL_COMPACT_MIN_GROUP) {
          group = [];
          return;
        }

        const expanded = expandedGroups.has(currentGroupIndex);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = TOOL_BUNDLE_CLASS;
        button.dataset.expanded = String(expanded);
        button.dataset.groupIndex = String(currentGroupIndex);

        const label = t.toolBundle(group.length, expanded);
        button.setAttribute('aria-label', label);
        button.innerHTML = `
          ${icons.tools}
          <span>${label}</span>
          <svg class="cgpt-tool-bundle-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>
        `;

        button.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();

          if (expandedGroups.has(currentGroupIndex)) expandedGroups.delete(currentGroupIndex);
          else expandedGroups.add(currentGroupIndex);

          compactToolsInContainer(container);
          refreshToolCompactStats();
          updatePanel(getMessages().length);
        });

        container.insertBefore(button, group[0]);

        for (const tool of group) {
          if (expanded) tool.removeAttribute(TOOL_HIDDEN_ATTR);
          else tool.setAttribute(TOOL_HIDDEN_ATTR, 'true');
        }

        group = [];
      };

      for (const child of children) {
        if (child.matches?.(TOOL_SELECTOR)) {
          group.push(child);
          continue;
        }

        if (group.length && isToolSpacer(child)) continue;
        flushGroup();
      }

      flushGroup();
    } finally {
      if (observer && container.isConnected) {
        observer.observe(container, { childList: true });
      }
    }
  }

  function scheduleToolCompact(container, delay = 100) {
    const previous = toolCompactTimers.get(container);
    if (previous) clearTimeout(previous);

    const timer = setTimeout(() => {
      toolCompactTimers.delete(container);

      if (!container.isConnected) {
        toolObservers.get(container)?.disconnect();
        toolObservers.delete(container);
        return;
      }

      compactToolsInContainer(container);
      refreshToolCompactStats();
      updatePanel(getMessages().length);
    }, delay);

    toolCompactTimers.set(container, timer);
  }

  function stopToolObservers() {
    for (const observer of toolObservers.values()) observer.disconnect();
    toolObservers.clear();

    for (const timer of toolCompactTimers.values()) clearTimeout(timer);
    toolCompactTimers.clear();
  }

  function getToolContainers(messages) {
    const containers = new Set();

    for (const message of messages) {
      message.querySelectorAll('[class~="agent-turn"] div.flex.flex-col.grow').forEach(container => {
        containers.add(container);
      });
    }

    return containers;
  }

  function syncToolCompaction(messages) {
    const containers = getToolContainers(messages);

    if (!toolCompactorEnabled()) {
      stopToolObservers();
      for (const container of containers) restoreToolContainer(container);
      refreshToolCompactStats(messages);
      return;
    }

    for (const [container, observer] of toolObservers) {
      if (container.isConnected && containers.has(container)) continue;
      observer.disconnect();
      toolObservers.delete(container);
      const timer = toolCompactTimers.get(container);
      if (timer) clearTimeout(timer);
      toolCompactTimers.delete(container);
    }

    for (const container of containers) {
      if (!toolObservers.has(container)) {
        const observer = new MutationObserver(() => scheduleToolCompact(container));
        observer.observe(container, { childList: true });
        toolObservers.set(container, observer);
      }

      compactToolsInContainer(container);
    }

    refreshToolCompactStats(messages);
  }

  function findListRoot(messages) {
    if (!messages.length) return null;

    let root = messages[0].parentElement;
    while (root && !messages.every(message => root.contains(message))) {
      root = root.parentElement;
    }

    return root;
  }

  function stopListObserver() {
    listObserver?.disconnect();
    listObserver = null;
    listRoot = null;
  }

  function bindListObserver(messages) {
    const nextRoot = findListRoot(messages);
    if (!nextRoot) return;
    if (listRoot === nextRoot && listObserver && nextRoot.isConnected) return;

    stopListObserver();
    discoveryObserver?.disconnect();

    listRoot = nextRoot;
    listObserver = new MutationObserver(() => scheduleUpdate(40));

    // ChatGPT's own virtualizer replaces direct children with placeholders/turns.
    // Watching only this level avoids observing streaming Markdown/tool mutations.
    listObserver.observe(listRoot, { childList: true });
  }

  function nodeContainsTurn(node) {
    return node?.nodeType === Node.ELEMENT_NODE && (
      node.matches?.(TURN_SELECTOR) ||
      node.querySelector?.(TURN_SELECTOR)
    );
  }

  function startDiscoveryObserver() {
    if (!document.body || listObserver) return;

    discoveryObserver?.disconnect();
    discoveryObserver = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (nodeContainsTurn(node)) {
            discoveryObserver.disconnect();
            scheduleUpdate(0);
            return;
          }
        }
      }
    });

    discoveryObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function setScrollContainer(next) {
    if (next === scrollContainer) return;

    scrollContainer?.removeEventListener('scroll', onScroll);
    scrollContainer = next;
    scrollContainer?.addEventListener('scroll', onScroll, { passive: true });
  }

  function syncScrollContainer() {
    const next = document.querySelector(SCROLL_ROOT_SELECTOR)
      || document.scrollingElement
      || document.documentElement;

    setScrollContainer(next);
  }

  function applyWindow() {
    const messages = getMessages();

    if (!messages.length) {
      removePanel();
      stopListObserver();
      stopToolObservers();
      startDiscoveryObserver();
      return;
    }

    const firstVisibleIndex = showAll
      ? 0
      : Math.max(0, messages.length - visibleCount);

    messages.forEach((message, index) => {
      setMessageHidden(message, index < firstVisibleIndex);
    });

    syncToolCompaction(messages);
    ensurePanel();
    updatePanel(messages.length);
    syncScrollContainer();
    bindListObserver(messages);
  }

  function revealOlder(count = LOAD_STEP) {
    const messages = getMessages();
    if (!messages.length || showAll) return;

    const oldFirst = Math.max(0, messages.length - visibleCount);
    if (oldFirst === 0) return;

    const anchor = messages[oldFirst];
    const beforeTop = anchor?.getBoundingClientRect().top ?? 0;

    visibleCount = Math.min(messages.length, visibleCount + count);
    applyWindow();

    requestAnimationFrame(() => {
      if (!anchor || !scrollContainer) return;

      const afterTop = anchor.getBoundingClientRect().top;
      const delta = afterTop - beforeTop;

      if (Number.isFinite(delta) && Math.abs(delta) > 1) {
        scrollContainer.scrollTop += delta;
      }
    });
  }

  function onScroll() {
    if (!scrollContainer || showAll) return;

    const top = scrollContainer.scrollTop;

    if (top > TOP_THRESHOLD_PX * 2) {
      topLoadArmed = true;
      return;
    }

    if (topLoadArmed && top <= TOP_THRESHOLD_PX) {
      topLoadArmed = false;
      // Rescan first because ChatGPT may have just materialized older placeholders.
      applyWindow();
      revealOlder();
    }
  }

  function resetWindow() {
    showAll = false;
    visibleCount = INITIAL_MESSAGES;
    topLoadArmed = true;
    applyWindow();
  }

  function toggleAll() {
    showAll = !showAll;
    if (!showAll) visibleCount = INITIAL_MESSAGES;
    topLoadArmed = true;
    applyWindow();
  }

  const icons = {
    older: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg>',
    all: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    recent: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h16M7 12h10M10 16h4"/></svg>',
    reset: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4v6h6"/><path d="M5.5 15a7 7 0 1 0 .8-7.8L4 10"/></svg>',
    turbo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 5 13h6l-1 9 8-12h-6l1-8Z"/></svg>',
    tools: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h4M16 7h4M8 4v6M4 17h7M15 17h5M15 14v6"/></svg>',
  };

  function ensurePanel() {
    if (document.getElementById(PANEL_ID) || !document.body) return;

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <span class="cgpt-rm-status"></span>
      <button type="button" data-action="older">${icons.older}</button>
      <button type="button" data-action="toggle">${icons.all}</button>
      <button type="button" data-action="reset">${icons.reset}</button>
      <button type="button" data-action="turbo">${icons.turbo}</button>
      <button type="button" data-action="tools">${icons.tools}</button>
    `;

    panel.addEventListener('click', event => {
      const button = event.target.closest('button');
      const action = button?.dataset.action;

      if (action === 'older') revealOlder();
      else if (action === 'toggle') toggleAll();
      else if (action === 'reset') resetWindow();
      else if (action === 'turbo') {
        setTurboEnabled(!turboEnabled());
        location.reload();
      } else if (action === 'tools') {
        setToolCompactorEnabled(!toolCompactorEnabled());
        syncToolCompaction(getMessages());
        updatePanel(getMessages().length);
      }
    });

    document.body.appendChild(panel);
  }

  function setButtonLabel(button, label) {
    if (!button) return;
    if (button.dataset.tooltip !== label) button.dataset.tooltip = label;
    if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
  }

  function updatePanel(total) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    const visible = showAll ? total : Math.min(total, visibleCount);
    const status = panel.querySelector('.cgpt-rm-status');
    const statusText = t.status(visible, total);
    if (status.textContent !== statusText) status.textContent = statusText;

    const older = panel.querySelector('[data-action="older"]');
    const olderDisabled = showAll || visible >= total;
    if (older.disabled !== olderDisabled) older.disabled = olderDisabled;
    setButtonLabel(older, t.older);

    const toggle = panel.querySelector('[data-action="toggle"]');
    const toggleState = showAll ? 'recent' : 'all';
    const toggleLabel = showAll ? t.recent : t.showAll;
    setButtonLabel(toggle, toggleLabel);
    if (toggle.dataset.iconState !== toggleState) {
      toggle.dataset.iconState = toggleState;
      toggle.innerHTML = showAll ? icons.recent : icons.all;
    }

    const reset = panel.querySelector('[data-action="reset"]');
    setButtonLabel(reset, t.reset);

    const turbo = panel.querySelector('[data-action="turbo"]');
    const enabled = turboEnabled();
    const trimStats = window.__cgptRecentMessagesTrimStats;
    let turboLabel = enabled ? t.turboOn : t.turboOff;

    if (enabled && trimStats?.beforeChars && trimStats?.afterChars) {
      const before = (trimStats.beforeChars / 1_000_000).toFixed(2);
      const after = (trimStats.afterChars / 1_000_000).toFixed(2);
      turboLabel += ` (${before} MB → ${after} MB)`;

      if (trimStats.userTurns && trimStats.retainedNodes) {
        turboLabel += ` · ${trimStats.userTurns} turn${trimStats.userTurns === 1 ? '' : 's'}, ${trimStats.retainedNodes} nodes`;
      }
    }

    setButtonLabel(turbo, turboLabel);
    if (turbo.dataset.active !== String(enabled)) {
      turbo.dataset.active = String(enabled);
    }

    const tools = panel.querySelector('[data-action="tools"]');
    const toolsEnabled = toolCompactorEnabled();
    const toolStats = window.__cgptRecentMessagesToolStats;
    let toolsLabel = toolsEnabled ? t.toolCompactOn : t.toolCompactOff;

    if (toolsEnabled && toolStats?.hidden) {
      toolsLabel += ` (${toolStats.hidden} hidden / ${toolStats.bundles} bundles)`;
    }

    setButtonLabel(tools, toolsLabel);
    if (tools.dataset.active !== String(toolsEnabled)) {
      tools.dataset.active = String(toolsEnabled);
    }
  }

  function removePanel() {
    document.getElementById(PANEL_ID)?.remove();
  }

  function scheduleUpdate(delay = 60) {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(applyWindow, delay);
  }

  function handleRouteChange() {
    if (location.href === lastUrl) return;

    lastUrl = location.href;

    // ChatGPT may replace window.fetch during application boot. Restore the
    // lightweight Turbo wrapper before the new conversation request begins.
    installTurboFetch();

    showAll = false;
    visibleCount = INITIAL_MESSAGES;
    topLoadArmed = true;

    stopListObserver();
    stopToolObservers();
    setScrollContainer(null);
    startDiscoveryObserver();
    scheduleUpdate(0);
  }

  function isConversationLink(anchor) {
    if (!anchor?.href) return false;

    try {
      const url = new URL(anchor.href, location.href);
      return url.origin === location.origin && /\/c\/[0-9a-f-]+$/i.test(url.pathname);
    } catch {
      return false;
    }
  }

  function installRouteHooks() {
    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      if (original.__cgptRecentMessagesWrapped) continue;

      const wrapped = function (...args) {
        // Re-install before the application reacts to the route mutation.
        installTurboFetch();
        const result = original.apply(this, args);
        queueMicrotask(handleRouteChange);
        return result;
      };

      Object.defineProperty(wrapped, '__cgptRecentMessagesWrapped', { value: true });
      history[method] = wrapped;
    }

    // Capture conversation-link clicks before React's navigation handler so
    // Turbo is restored even if ChatGPT replaced window.fetch after startup.
    document.addEventListener('click', event => {
      const anchor = event.target.closest?.('a[href]');
      if (isConversationLink(anchor)) installTurboFetch();
    }, true);

    window.addEventListener('popstate', () => {
      installTurboFetch();
      queueMicrotask(handleRouteChange);
    });
  }

  function initDom() {
    ensureStyle();
    installRouteHooks();

    // Re-wrap if the application replaced window.fetch during boot.
    installTurboFetch();

    startDiscoveryObserver();
    scheduleUpdate(0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDom, { once: true });
  } else {
    initDom();
  }
})();
