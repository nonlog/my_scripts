// ==UserScript==
// @name         ChatGPT Recent Messages
// @namespace    https://github.com/nonlog/my_scripts
// @version      0.2.1
// @description  Keep long ChatGPT conversations responsive by showing only recent messages and revealing older messages on demand.
// @match        https://chatgpt.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const INITIAL_MESSAGES = 5;
  const LOAD_STEP = 5;
  const TOP_THRESHOLD_PX = 220;
  const HIDDEN_ATTR = 'data-cgpt-recent-hidden';
  const PANEL_ID = 'cgpt-recent-messages-panel';

  const isZh = /^zh\b/i.test(navigator.language || '');
  const t = isZh
    ? {
        older: `加载前 ${LOAD_STEP} 条消息`,
        showAll: '显示全部消息',
        recent: `只显示最近 ${INITIAL_MESSAGES} 条消息`,
        reset: `重置为最近 ${INITIAL_MESSAGES} 条消息`,
        status: (visible, total) => `${visible}/${total} 条`,
      }
    : {
        older: `Load ${LOAD_STEP} older messages`,
        showAll: 'Show all messages',
        recent: `Show only the latest ${INITIAL_MESSAGES} messages`,
        reset: `Reset to the latest ${INITIAL_MESSAGES} messages`,
        status: (visible, total) => `${visible}/${total}`,
      };

  let visibleCount = INITIAL_MESSAGES;
  let showAll = false;
  let updateTimer = null;
  let scrollContainer = null;
  let lastUrl = location.href;

  const style = document.createElement('style');
  style.textContent = `
    [${HIDDEN_ATTR}="true"] { display: none !important; }

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
  document.documentElement.appendChild(style);

  function getMessages() {
    const turns = [...document.querySelectorAll('article[data-testid^="conversation-turn-"]')];
    if (turns.length) return turns;

    const fallbackTurns = [...document.querySelectorAll('[data-testid^="conversation-turn-"]')];
    if (fallbackTurns.length) return fallbackTurns;

    const roleNodes = [...document.querySelectorAll('[data-message-author-role]')];
    return [...new Set(roleNodes.map((node) =>
      node.closest('article') || node.closest('[data-testid^="conversation-turn-"]') || node.parentElement
    ).filter(Boolean))];
  }

  function findScrollParent(element) {
    let node = element?.parentElement;
    while (node && node !== document.body) {
      const s = getComputedStyle(node);
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 8) {
        return node;
      }
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function syncScrollListener(messages) {
    const firstVisibleIndex = showAll ? 0 : Math.max(0, messages.length - visibleCount);
    const next = findScrollParent(messages[firstVisibleIndex]);
    if (next === scrollContainer) return;
    scrollContainer?.removeEventListener('scroll', onScroll);
    scrollContainer = next;
    scrollContainer?.addEventListener('scroll', onScroll, { passive: true });
  }

  function applyWindow() {
    const messages = getMessages();
    if (!messages.length) {
      removePanel();
      return;
    }

    const firstVisibleIndex = showAll ? 0 : Math.max(0, messages.length - visibleCount);
    messages.forEach((message, index) => {
      if (index < firstVisibleIndex) message.setAttribute(HIDDEN_ATTR, 'true');
      else message.removeAttribute(HIDDEN_ATTR);
    });

    ensurePanel();
    updatePanel(messages.length);
    syncScrollListener(messages);
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
    if (!showAll && scrollContainer && scrollContainer.scrollTop <= TOP_THRESHOLD_PX) {
      revealOlder();
    }
  }

  function resetWindow() {
    showAll = false;
    visibleCount = INITIAL_MESSAGES;
    applyWindow();
  }

  function toggleAll() {
    showAll = !showAll;
    if (!showAll) visibleCount = INITIAL_MESSAGES;
    applyWindow();
  }

  const icons = {
    older: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg>',
    all: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    recent: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h16M7 12h10M10 16h4"/></svg>',
    reset: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4v6h6"/><path d="M5.5 15a7 7 0 1 0 .8-7.8L4 10"/></svg>',
  };

  function ensurePanel() {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <span class="cgpt-rm-status"></span>
      <button type="button" data-action="older" aria-label="${t.older}" data-tooltip="${t.older}">${icons.older}</button>
      <button type="button" data-action="toggle" aria-label="${t.showAll}" data-tooltip="${t.showAll}">${icons.all}</button>
      <button type="button" data-action="reset" aria-label="${t.reset}" data-tooltip="${t.reset}">${icons.reset}</button>
    `;

    panel.addEventListener('click', (event) => {
      const action = event.target.closest('button')?.dataset.action;
      if (action === 'older') revealOlder();
      else if (action === 'toggle') toggleAll();
      else if (action === 'reset') resetWindow();
    });

    document.body.appendChild(panel);
  }

  function updatePanel(total) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    const visible = showAll ? total : Math.min(total, visibleCount);
    panel.querySelector('.cgpt-rm-status').textContent = t.status(visible, total);

    const older = panel.querySelector('[data-action="older"]');
    older.disabled = showAll || visible >= total;

    const toggle = panel.querySelector('[data-action="toggle"]');
    const toggleText = showAll ? t.recent : t.showAll;
    toggle.dataset.tooltip = toggleText;
    toggle.setAttribute('aria-label', toggleText);
    toggle.innerHTML = showAll ? icons.recent : icons.all;
  }

  function removePanel() {
    document.getElementById(PANEL_ID)?.remove();
  }

  function scheduleUpdate() {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(applyWindow, 160);
  }

  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    showAll = false;
    visibleCount = INITIAL_MESSAGES;
    scheduleUpdate();
  }, 500);

  const observer = new MutationObserver(scheduleUpdate);
  observer.observe(document.body, { childList: true, subtree: true });

  applyWindow();
})();
