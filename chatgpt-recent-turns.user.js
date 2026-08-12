// ==UserScript==
// @name         ChatGPT Recent Messages
// @namespace    https://github.com/nonlog/my_scripts
// @version      0.3.3
// @description  Reduce long-chat rendering and client-state overhead in ChatGPT Web.
// @match        https://chatgpt.com/*
// @run-at       document-start
// @early-start
// @inject-into  page
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.3.3';
  const INITIAL_MESSAGES = 5;
  const LOAD_STEP = 5;
  const TOP_THRESHOLD_PX = 220;

  // Heavy conversations can contain hundreds of hidden assistant/tool nodes even
  // when ChatGPT itself only materializes a few visible turns. Turbo mode trims
  // the conversation mapping before ChatGPT parses it into its long-lived state.
  const TURBO_STORAGE_KEY = 'cgpt-recent-messages-turbo-v1';
  const TURBO_KEEP_USER_TURNS = 3;
  const TURBO_MIN_RESPONSE_CHARS = 1_000_000;

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
        turboOn: `Turbo 已开启：重型会话仅保留最近 ${TURBO_KEEP_USER_TURNS} 个用户回合；点击关闭并重新加载完整历史`,
        turboOff: 'Turbo 已关闭：点击开启并重新加载；仅对重型会话裁剪客户端历史',
        status: (visible, total) => `${visible}/${total}`,
      }
    : {
        older: `Load ${LOAD_STEP} older messages`,
        showAll: 'Show all currently loaded messages',
        recent: `Show only the latest ${INITIAL_MESSAGES} messages`,
        reset: `Reset to the latest ${INITIAL_MESSAGES} messages`,
        turboOn: `Turbo is ON: heavy chats keep the latest ${TURBO_KEEP_USER_TURNS} user turns; click to disable and reload full history`,
        turboOff: 'Turbo is OFF: click to enable and reload; only heavy chats are trimmed',
        status: (visible, total) => `${visible}/${total}`,
      };

  let visibleCount = INITIAL_MESSAGES;
  let showAll = false;
  let updateTimer = null;
  let scrollContainer = null;
  let listObserver = null;
  let listRoot = null;
  let discoveryObserver = null;
  let topLoadArmed = true;
  let lastUrl = location.href;

  function turboEnabled() {
    return localStorage.getItem(TURBO_STORAGE_KEY) !== '0';
  }

  function setTurboEnabled(enabled) {
    localStorage.setItem(TURBO_STORAGE_KEY, enabled ? '1' : '0');
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

    if (userIndexes.length <= TURBO_KEEP_USER_TURNS) return null;

    const startIndex = userIndexes[userIndexes.length - TURBO_KEEP_USER_TURNS];
    const rootId = path[0];
    const retainedPath = path.slice(startIndex);
    const firstRetainedId = retainedPath[0];

    if (!rootId || !mapping[rootId] || !firstRetainedId) return null;

    const retainedIds = [rootId, ...retainedPath];
    const retainedSet = new Set(retainedIds);
    const trimmed = {};

    for (const nodeId of retainedIds) {
      const source = mapping[nodeId];
      if (!source) continue;

      const copy = { ...source };

      if (nodeId === rootId) {
        copy.parent = null;
        copy.children = [firstRetainedId];
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
      userTurns: TURBO_KEEP_USER_TURNS,
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
      startDiscoveryObserver();
      return;
    }

    const firstVisibleIndex = showAll
      ? 0
      : Math.max(0, messages.length - visibleCount);

    messages.forEach((message, index) => {
      setMessageHidden(message, index < firstVisibleIndex);
    });

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
    }

    setButtonLabel(turbo, turboLabel);
    if (turbo.dataset.active !== String(enabled)) {
      turbo.dataset.active = String(enabled);
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
    window.__cgptRecentMessagesTrimStats = null;

    // ChatGPT may replace window.fetch during application boot. Restore the
    // lightweight Turbo wrapper before the new conversation request begins.
    installTurboFetch();

    showAll = false;
    visibleCount = INITIAL_MESSAGES;
    topLoadArmed = true;

    stopListObserver();
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
