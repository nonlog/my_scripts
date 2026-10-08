// ==UserScript==
// @name         ChatGPT Project Labels
// @namespace    https://github.com/nonlog/my_scripts
// @version      1.0.0
// @description  Show project names beside project chats in ChatGPT Recents without modifying conversation titles.
// @homepage     https://github.com/nonlog/my_scripts
// @supportURL   https://github.com/nonlog/my_scripts/issues
// @updateURL    https://raw.githubusercontent.com/nonlog/my_scripts/master/chatgpt-project-labels.meta.js
// @downloadURL  https://raw.githubusercontent.com/nonlog/my_scripts/master/chatgpt-project-labels.user.js
// @match        https://chatgpt.com/*
// @run-at       document-start
// @inject-into  content
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const STYLE_ID = 'cgpt-project-labels-style';
  const SIDEBAR_SELECTOR = '#app-shell-sidebar';
  const PROJECT_ROW_SELECTOR = '[data-app-action-sidebar-project-id]';
  const RECENT_ROW_SELECTOR = '[data-sidebar-chatgpt-conversation-key]';
  const PROJECT_NAME_ATTRIBUTE = 'data-cgpt-project-name';
  const PROJECT_ROUTE = /^\/g\/(g-p-[0-9a-f]{32})(?:-[^/]*)?\/(?:c\/|project(?:\/|$))/i;
  const CHAT_ID = /\/c\/([0-9a-f-]{36})(?:\/|$)/i;

  const nameCache = new Map();
  let sidebar = null;
  let sidebarObserver = null;
  let discoveryObserver = null;
  let syncTimer = null;

  function pathname(href) {
    try { return new URL(href, location.origin).pathname; }
    catch { return ''; }
  }

  function projectId(href) {
    return pathname(href).match(PROJECT_ROUTE)?.[1] || '';
  }

  function conversationId(href) {
    return pathname(href).match(CHAT_ID)?.[1] || '';
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      // The label is CSS generated content, not a React-owned child. React may replace
      // a row during streaming, but cannot remove a child that this script never adds.
      '#app-shell-sidebar a[' + PROJECT_NAME_ATTRIBUTE + ']{display:flex;align-items:center;min-width:0}',
      '#app-shell-sidebar a[' + PROJECT_NAME_ATTRIBUTE + '] > :first-child{flex:1 1 auto;min-width:0}',
      '#app-shell-sidebar a[' + PROJECT_NAME_ATTRIBUTE + ']::after{',
      'content:attr(' + PROJECT_NAME_ATTRIBUTE + ');display:block;flex:0 0 auto;',
      'max-width:46%;min-width:0;margin-inline-start:6px;overflow:hidden;',
      'white-space:nowrap;text-overflow:ellipsis;font-size:11px;line-height:16px;',
      'color:var(--text-secondary,currentColor);opacity:.7;pointer-events:none}',
      // If an older combined userscript remains installed temporarily, avoid two labels.
      '#app-shell-sidebar .cgpt-sidebar-project-label{display:none!important}',
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  function collectProjectNames(root) {
    root.querySelectorAll(PROJECT_ROW_SELECTOR).forEach(row => {
      const id = row.getAttribute('data-app-action-sidebar-project-id') || '';
      const name = (row.getAttribute('data-app-action-sidebar-project-label') || '').trim();
      if (id && name) nameCache.set(id, name);
    });

    // A breadcrumb also provides the name when the project list has not rendered.
    const breadcrumb = document.querySelector('nav[aria-label="Breadcrumb"] a[href*="/project"]');
    const currentId = projectId(location.href);
    const currentName = (breadcrumb?.textContent || '').trim();
    if (currentId && currentName) nameCache.set(currentId, currentName);
  }

  function conversationProjects(root) {
    const projects = new Map();
    // Some versions of the sidebar render a plain /c/ link in Recents while
    // the same conversation also appears with a project route in its project list.
    root.querySelectorAll('a[href*="/c/"]').forEach(link => {
      const id = projectId(link.getAttribute('href') || '');
      const chat = conversationId(link.getAttribute('href') || '');
      if (id && chat) projects.set(chat, id);
    });
    return projects;
  }

  function syncLabels() {
    if (!sidebar?.isConnected) { attachSidebar(); return; }
    collectProjectNames(sidebar);
    const projectsByChat = conversationProjects(sidebar);
    sidebar.querySelectorAll(RECENT_ROW_SELECTOR).forEach(row => {
      const link = row.querySelector('a[data-interactive-row-link][href]') ||
                   row.querySelector('a[href*="/c/"]');
      if (!link) return;
      const href = link.getAttribute('href') || '';
      const id = projectId(href) || projectsByChat.get(conversationId(href)) || '';
      const name = nameCache.get(id) || '';
      if (name) {
        if (link.getAttribute(PROJECT_NAME_ATTRIBUTE) !== name)
          link.setAttribute(PROJECT_NAME_ATTRIBUTE, name);
      } else if (link.hasAttribute(PROJECT_NAME_ATTRIBUTE)) {
        link.removeAttribute(PROJECT_NAME_ATTRIBUTE);
      }
    });
  }

  function scheduleSync(delay = 70) {
    if (syncTimer !== null) return;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      syncLabels();
    }, delay);
  }

  function relevantMutation(records) {
    return records.some(record => {
      if (record.type === 'attributes') return (
        record.target.matches?.(PROJECT_ROW_SELECTOR) ||
        record.target.matches?.('a[href*="/c/"]')
      );
      if (record.target.closest?.(PROJECT_ROW_SELECTOR + ',' + RECENT_ROW_SELECTOR))
        return true;
      return [...record.addedNodes, ...record.removedNodes].some(node =>
        node.nodeType === 1 &&
        (node.matches?.(PROJECT_ROW_SELECTOR + ',' + RECENT_ROW_SELECTOR) ||
         node.querySelector?.(PROJECT_ROW_SELECTOR + ',' + RECENT_ROW_SELECTOR))
      );
    });
  }

  function attachSidebar() {
    const next = document.querySelector(SIDEBAR_SELECTOR);
    if (!next) return;
    if (next !== sidebar) {
      sidebarObserver?.disconnect();
      sidebar = next;
      sidebarObserver = new MutationObserver(records => {
        if (relevantMutation(records)) scheduleSync();
      });
      // The script's own attribute is intentionally absent from attributeFilter:
      // re-labelling must never trigger a MutationObserver feedback loop.
      sidebarObserver.observe(sidebar, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['href', 'data-app-action-sidebar-project-id', 'data-app-action-sidebar-project-label'],
      });
    }
    scheduleSync(0);
  }

  function init() {
    ensureStyle();
    attachSidebar();
    if (!discoveryObserver) {
      discoveryObserver = new MutationObserver(records => {
        if (sidebar?.isConnected && !records.some(record =>
          [...record.addedNodes].some(node =>
            node.nodeType === 1 &&
            (node.id === 'app-shell-sidebar' || node.querySelector?.(SIDEBAR_SELECTOR))
          ))) return;
        attachSidebar();
      });
      discoveryObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) attachSidebar();
    });
    window.addEventListener('pageshow', attachSidebar);
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
