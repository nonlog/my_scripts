// ==UserScript==
// @name         ChatGPT Recent Turns
// @namespace    https://github.com/nonlog/my_scripts
// @version      0.1.0
// @description  Keep long ChatGPT conversations responsive by showing only recent turns and revealing older turns on demand.
// @match        https://chatgpt.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const INITIAL_TURNS = 10;
  const LOAD_STEP = 10;
  const TOP_THRESHOLD_PX = 240;
  const HIDDEN_ATTR = 'data-cgpt-recent-turns-hidden';
  const PANEL_ID = 'cgpt-recent-turns-panel';

  let visibleUserTurns = INITIAL_TURNS;
  let showAll = false;
  let updateTimer = null;
  let scrollContainer = null;
  let lastUrl = location.href;
  let lastUserTurnCount = -1;

  const style = document.createElement('style');
  style.textContent = `
    [${HIDDEN_ATTR}="true"] {
      display: none !important;
    }

    #${PANEL_ID} {
      position: fixed;
      right: 16px;
      bottom: 82px;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px;
      border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
      border-radius: 10px;
      background: color-mix(in srgb, Canvas 94%, transparent);
      color: CanvasText;
      box-shadow: 0 4px 16px rgba(0, 0, 0, .14);
      backdrop-filter: blur(8px);
      font: 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    #${PANEL_ID} button {
      appearance: none;
      border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
      border-radius: 7px;
      padding: 5px 8px;
      background: Canvas;
      color: CanvasText;
      cursor: pointer;
      font: inherit;
    }

    #${PANEL_ID} button:hover {
      background: color-mix(in srgb, CanvasText 7%, Canvas);
    }

    #${PANEL_ID} .cgpt-rt-status {
      min-width: 62px;
      padding: 0 3px;
      text-align: center;
      opacity: .8;
      white-space: nowrap;
    }
  `;
  document.documentElement.appendChild(style);

  function getTurnElements() {
    const preferred = [...document.querySelectorAll('article[data-testid^="conversation-turn-"]')];
    if (preferred.length) return preferred;

    const testIdTurns = [...document.querySelectorAll('[data-testid^="conversation-turn-"]')];
    if (testIdTurns.length) return testIdTurns;

    // Fallback: promote role-bearing nodes to the nearest stable message container.
    const roleNodes = [...document.querySelectorAll('[data-message-author-role]')];
    return [...new Set(roleNodes.map((node) => {
      return node.closest('article') || node.closest('[data-testid^="conversation-turn-"]') || node.parentElement;
    }).filter(Boolean))];
  }

  function getRole(turn) {
    const roleNode = turn.matches?.('[data-message-author-role]')
      ? turn
      : turn.querySelector?.('[data-message-author-role]');
    return roleNode?.getAttribute('data-message-author-role') || null;
  }

  function buildUserTurnGroups(turns) {
    const groups = [];
    let current = null;

    for (const turn of turns) {
      if (getRole(turn) === 'user') {
        current = [];
        groups.push(current);
      }

      // Ignore leading non-user UI/message nodes. Once a user group starts,
      // assistant/tool turns belong to that user turn until the next user turn.
      if (current) current.push(turn);
    }

    return groups;
  }

  function findScrollParent(element) {
    let node = element?.parentElement;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      const overflowY = style.overflowY;
      if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 8) {
        return node;
      }
      node = node.parentElement;
    }

    return document.scrollingElement || document.documentElement;
  }

  function getFirstVisibleGroup(groups) {
    if (!groups.length) return null;
    const firstIndex = showAll ? 0 : Math.max(0, groups.length - visibleUserTurns);
    return groups[firstIndex] || null;
  }

  function syncScrollListener(groups) {
    const firstGroup = getFirstVisibleGroup(groups);
    const firstElement = firstGroup?.[0];
    const nextContainer = findScrollParent(firstElement);

    if (nextContainer === scrollContainer) return;

    if (scrollContainer) {
      scrollContainer.removeEventListener('scroll', onScroll);
    }

    scrollContainer = nextContainer;
    scrollContainer?.addEventListener('scroll', onScroll, { passive: true });
  }

  function setGroupHidden(group, hidden) {
    for (const turn of group) {
      if (hidden) turn.setAttribute(HIDDEN_ATTR, 'true');
      else turn.removeAttribute(HIDDEN_ATTR);
    }
  }

  function applyWindow({ force = false } = {}) {
    if (!location.pathname.startsWith('/c/') && !document.querySelector('[data-message-author-role]')) {
      removePanel();
      return;
    }

    const turns = getTurnElements();
    const groups = buildUserTurnGroups(turns);
    if (!groups.length) return;

    if (!force && groups.length === lastUserTurnCount) {
      syncScrollListener(groups);
      updatePanel(groups.length);
      return;
    }
    lastUserTurnCount = groups.length;

    const firstVisibleIndex = showAll ? 0 : Math.max(0, groups.length - visibleUserTurns);

    groups.forEach((group, index) => {
      setGroupHidden(group, index < firstVisibleIndex);
    });

    ensurePanel();
    updatePanel(groups.length);
    syncScrollListener(groups);
  }

  function revealOlder(count = LOAD_STEP) {
    const turns = getTurnElements();
    const groups = buildUserTurnGroups(turns);
    if (!groups.length) return;

    const oldFirstIndex = showAll ? 0 : Math.max(0, groups.length - visibleUserTurns);
    if (oldFirstIndex <= 0) return;

    const anchor = groups[oldFirstIndex]?.[0];
    const beforeTop = anchor?.getBoundingClientRect().top ?? 0;

    visibleUserTurns = Math.min(groups.length, visibleUserTurns + count);
    lastUserTurnCount = -1;
    applyWindow({ force: true });

    // Revealing older turns increases content above the current viewport.
    // Keep the user's current message visually anchored instead of jumping upward.
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
    if (showAll || !scrollContainer) return;
    if (scrollContainer.scrollTop <= TOP_THRESHOLD_PX) {
      revealOlder();
    }
  }

  function resetWindow() {
    showAll = false;
    visibleUserTurns = INITIAL_TURNS;
    lastUserTurnCount = -1;
    applyWindow({ force: true });
  }

  function toggleAll() {
    showAll = !showAll;
    lastUserTurnCount = -1;
    applyWindow({ force: true });
  }

  function ensurePanel() {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <span class="cgpt-rt-status"></span>
      <button type="button" data-action="older">旧消息 +10</button>
      <button type="button" data-action="toggle">显示全部</button>
      <button type="button" data-action="reset">重置</button>
    `;

    panel.addEventListener('click', (event) => {
      const action = event.target.closest('button')?.dataset.action;
      if (action === 'older') revealOlder();
      if (action === 'toggle') toggleAll();
      if (action === 'reset') resetWindow();
    });

    document.body.appendChild(panel);
  }

  function removePanel() {
    document.getElementById(PANEL_ID)?.remove();
  }

  function updatePanel(totalGroups) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    const visible = showAll ? totalGroups : Math.min(totalGroups, visibleUserTurns);
    panel.querySelector('.cgpt-rt-status').textContent = `${visible}/${totalGroups} 轮`;
    panel.querySelector('[data-action="toggle"]').textContent = showAll ? '只看最近' : '显示全部';
    panel.querySelector('[data-action="older"]').disabled = showAll || visible >= totalGroups;
  }

  function scheduleUpdate() {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(() => applyWindow(), 180);
  }

  // ChatGPT is an SPA. Reset the visible window when navigating to another chat.
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    showAll = false;
    visibleUserTurns = INITIAL_TURNS;
    lastUserTurnCount = -1;
    scheduleUpdate();
  }, 500);

  const observer = new MutationObserver(scheduleUpdate);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  applyWindow({ force: true });
})();
