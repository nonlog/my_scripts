// ==UserScript==
// @name         Gemini Usage & Timeline
// @namespace    https://github.com/nonlog/my_scripts
// @version      1.0.0
// @description  在 Gemini Web 头像旁显示 5 小时限额与周限额，并提供 Codex Desktop 风格的侧边栏对话时间线导航。
// @homepage     https://github.com/nonlog/my_scripts
// @supportURL   https://github.com/nonlog/my_scripts/issues
// @updateURL    https://raw.githubusercontent.com/nonlog/my_scripts/master/gemini-usage-timeline.meta.js
// @downloadURL  https://raw.githubusercontent.com/nonlog/my_scripts/master/gemini-usage-timeline.user.js
// @match        https://gemini.google.com/*
// @run-at       document-idle
// @inject-into  content
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  if (window.top !== window.self) return;
  if (document.documentElement?.hasAttribute('data-gxu-ut-mounted')) return;
  document.documentElement?.setAttribute('data-gxu-ut-mounted', '1');

  const ORIGIN = 'https://gemini.google.com';
  const GRAPHQL_PATH = '/_/BardChatUi/graphql/schemas/GEMINI_WEB_GRAPHQL/executeQuery';
  const ASSET_BASE = 'https://www.gstatic.com/bg3/boq-bard-web/islands/assets/';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const DEFAULT_SIGNATURES = [
    '2/dWbCvkVB0X16r9NPnxifeOAAqdCqMf0xeWvau9yPy7g=',
    '2/eV2urSc0npZclHCYNGf6nOVD14WHCs52VfsJoHiZgEs=',
  ];

  const QUERY_VARIANTS = [
    {
      g1Request: {
        entrypoints: [
          'GEMINI_USAGE_SETTINGS_UPGRADE_BANNER',
          'GEMINI_USAGE_SETTINGS_AI_CREDITS_UPSELL_CARD',
          'GEMINI_USAGE_SETTINGS_UPGRADE_AND_CREDITS_BANNER',
        ],
      },
      workspaceRequest: {
        recommendationsForSurfaceRequests: [
          {
            recommendationSurface: { rpOnramp: 'GEMINI_CHAT_USAGE_LIMITS_UPSELL', version: '1' },
            maxRecommendationCount: 1,
          },
        ],
      },
    },
    {
      g1Request: { entrypoints: ['GEMINI_USAGE_SETTINGS_UPGRADE_BANNER'] },
      workspaceRequest: { recommendationsForSurfaceRequests: [] },
    },
  ];

  const STORAGE_KEYS = {
    sig: 'gxu_ut_query_sig_v1',
    mode: 'gxu_ut_display_mode_v1', // 'used' | 'remaining'
    cachePrefix: 'gxu_ut_quota_cache_v1_',
    bookmarksPrefix: 'gxu_ut_bookmarks_v1_',
  };

  const REFRESH_TTL_MS = 45 * 1000;
  const POLL_INTERVAL_MS = 3 * 60 * 1000;
  const STYLE_ID = 'gxu-usage-timeline-style';

  const USER_TURN_SELECTOR = 'user-query, .user-query-container, [data-message-author-role="user"]';
  const SCROLLER_SELECTOR = '#chat-history, infinite-scroller.chat-history, .chat-history-scroll-container';
  const SIDENAV_SELECTOR = 'bard-sidenav, side-navigation-v2, mat-sidenav';
  const NON_CHAT_PATH_RE = /^\/(?:u\/\d+\/)?(?:usage|mystuff|library|scheduled|gems\/view|saved-info|extensions|updates)(?:\/|$)/i;

  // ---------------------------------------------------------------------------
  // Trusted-Types-safe DOM helpers (no innerHTML anywhere)
  // ---------------------------------------------------------------------------

  function h(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined) continue;
      if (k === 'className') node.className = v;
      else if (k === 'textContent') node.textContent = v;
      else node.setAttribute(k, String(v));
    }
    for (const child of children) {
      if (child === null || child === undefined) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function svg(tag, attrs = {}, children = []) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== null && v !== undefined) node.setAttribute(k, String(v));
    }
    for (const child of children) {
      if (child) node.appendChild(child);
    }
    return node;
  }

  function clearChildren(node) {
    if (!node) return;
    if (typeof node.replaceChildren === 'function') {
      node.replaceChildren();
    } else {
      while (node.firstChild) node.removeChild(node.firstChild);
    }
  }

  // ---------------------------------------------------------------------------
  // Pure parsing & formatting helpers
  // ---------------------------------------------------------------------------

  function getAccountIndex(href = location.href) {
    try {
      const url = new URL(href, ORIGIN);
      const pathMatch = url.pathname.match(/^\/u\/(\d+)(?:\/|$)/);
      const queryIndex = url.searchParams.get('authuser');
      if (pathMatch) return pathMatch[1];
      if (queryIndex && /^\d+$/.test(queryIndex)) return queryIndex;
      return '0';
    } catch {
      return '0';
    }
  }

  function getAccountPrefix(accountIndex) {
    return accountIndex && accountIndex !== '0' ? `/u/${accountIndex}` : '';
  }

  function buildExecuteQueryUrl(accountIndex, signature, variablesObj) {
    const prefix = getAccountPrefix(accountIndex);
    const url = new URL(`${prefix}${GRAPHQL_PATH}`, ORIGIN);
    url.searchParams.set('query_signature', signature);
    url.searchParams.set('variables', JSON.stringify(variablesObj));
    return url.toString();
  }

  function parseGraphqlUsageResponse(rawText) {
    if (typeof rawText !== 'string') return { ok: false, reason: 'empty' };
    const trimmed = rawText.trimStart().replace(/^\)\]\}'\s*/, '').trimStart();
    if (!trimmed) return { ok: false, reason: 'empty' };
    if (trimmed.startsWith('<')) return { ok: false, reason: 'auth_html' };

    const bracketStart = trimmed.indexOf('[');
    const jsonText = bracketStart >= 0 ? trimmed.slice(bracketStart) : trimmed;
    let payloads;
    try {
      payloads = JSON.parse(jsonText);
    } catch {
      return { ok: false, reason: 'invalid_json' };
    }
    if (!Array.isArray(payloads)) payloads = [payloads];

    for (const item of payloads) {
      if (item && item.data && item.data.viewer === null) {
        return { ok: false, reason: 'signed_out' };
      }
      const info = item?.data?.viewer?.rpcs?.getUsageInfo;
      if (info && Array.isArray(info.pools)) {
        const parsePool = (poolType) => {
          const pool = info.pools.find((p) => p && p.poolType === poolType);
          if (!pool || typeof pool.percentageUsed !== 'number' || !Number.isFinite(pool.percentageUsed) || pool.percentageUsed < 0) {
            return null;
          }
          const usedPct = Math.min(100, Math.max(0, Math.round(pool.percentageUsed * 100)));
          const resetRaw = pool.gxu?.windowRefreshesAt || null;
          const resetMs = typeof resetRaw === 'string' ? Date.parse(resetRaw) : NaN;
          return {
            usedPct,
            remainingPct: Math.max(0, 100 - usedPct),
            resetAt: Number.isFinite(resetMs) ? resetMs : null,
            resetIso: typeof resetRaw === 'string' ? resetRaw : null,
          };
        };

        const fiveHour = parsePool('GXU_FIVE_HOURLY');
        const weekly = parsePool('GXU_WEEKLY');
        if (!fiveHour && !weekly) {
          return { ok: false, reason: 'no_pools' };
        }
        return {
          ok: true,
          tier: typeof info.subscriptionTier === 'string' ? info.subscriptionTier : '',
          fiveHour,
          weekly,
          fetchedAt: Date.now(),
        };
      }
    }

    const gqlError = payloads.find((p) => Array.isArray(p?.errors) && p.errors.length > 0)?.errors?.[0]?.message || '';
    return { ok: false, reason: 'graphql_error', message: gqlError };
  }

  function extractBundleUrlFromHtml(html) {
    if (typeof html !== 'string' || !html) return '';
    const fullMatch = html.match(/https:\/\/www\.gstatic\.com\/[^\s"'`<>]*UsagePageLoading-[\w-]+\.js/);
    if (fullMatch) return fullMatch[0];
    const relMatch = html.match(/@messages\/assets\/(UsagePageLoading-[\w-]+\.js)/) ||
      html.match(/(UsagePageLoading-[\w-]+\.js)/);
    return relMatch ? `${ASSET_BASE}${relMatch[1]}` : '';
  }

  function extractQuerySignatureFromBundle(jsText) {
    if (typeof jsText !== 'string' || !jsText) return '';
    const patterns = [
      /id:\s*[`"']([^`"']+)[`"']\s*,\s*metadata:\s*\{\}\s*,\s*name:\s*[`"']UsagePageQuery[`"']/,
      /name:\s*[`"']UsagePageQuery[`"'][^{}]{0,120}?id:\s*[`"']([^`"']+)[`"']/,
      /id:\s*[`"'](2\/[A-Za-z0-9+/=_-]{20,})[`"'][^{}]{0,160}?UsagePageQuery/,
    ];
    for (const re of patterns) {
      const match = re.exec(jsText);
      if (match && match[1]) return match[1];
    }
    return '';
  }

  function formatResetTime(resetAt, nowMs = Date.now(), kind = '5h') {
    if (!Number.isFinite(resetAt)) return '重置时间未知';
    const diffMs = resetAt - nowMs;
    if (diffMs <= 0) return '即将刷新';

    const totalMinutes = Math.max(1, Math.ceil(diffMs / 60000));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const mins = totalMinutes % 60;

    const dt = new Date(resetAt);
    const hh = String(dt.getHours()).padStart(2, '0');
    const mm = String(dt.getMinutes()).padStart(2, '0');

    if (kind === 'weekly' || days >= 1) {
      const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      const dayLabel = weekdays[dt.getDay()];
      const rel = days > 0 ? `${days}d ${hours}h` : `${hours}h ${mins}m`;
      return `${rel} 后重置 · ${dayLabel} ${hh}:${mm}`;
    }

    const rel = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    return `${rel} 后重置 · ${hh}:${mm}`;
  }

  function extractConversationKey(pathname = location.pathname) {
    if (typeof pathname !== 'string' || NON_CHAT_PATH_RE.test(pathname)) return '';
    const clean = pathname.replace(/^\/u\/\d+/, '') || '/';
    const appMatch = clean.match(/^\/app\/([A-Za-z0-9_-]+)/);
    if (appMatch) return `app:${appMatch[1]}`;
    const gemMatch = clean.match(/^\/gem\/([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_-]+))?/);
    if (gemMatch) return gemMatch[2] ? `gem:${gemMatch[1]}:${gemMatch[2]}` : `gem:${gemMatch[1]}:draft`;
    const shareMatch = clean.match(/^\/share\/([A-Za-z0-9_-]+)/);
    if (shareMatch) return `share:${shareMatch[1]}`;
    if (clean === '/' || clean === '/app' || clean === '/app/') return 'app:draft';
    return '';
  }

  function cleanPromptLines(rawText) {
    if (typeof rawText !== 'string') return { title: '[图片或附件]', body: '' };
    const stripped = rawText
      .replace(/^\s*(?:You said|你说|你說)\s*[:：]?\s*/i, '')
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    if (stripped.length === 0) {
      return { title: '[图片或附件]', body: '' };
    }

    const first = stripped[0];
    const rest = stripped.slice(1).join(' ').trim();
    if (rest) {
      return { title: first, body: rest };
    }

    if (first.length > 54) {
      return {
        title: first.slice(0, 52).trim() + '…',
        body: first.slice(52).trim(),
      };
    }
    return { title: first, body: '' };
  }

  function extractTurnPrompt(turnEl) {
    if (!turnEl) return { title: '[图片或附件]', body: '', raw: '' };
    const queryLines = turnEl.querySelectorAll ? turnEl.querySelectorAll('.query-text-line') : [];
    if (queryLines && queryLines.length > 0) {
      const lines = Array.from(queryLines)
        .map((line) => (line.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      const joined = lines.join('\n');
      if (joined) {
        return { ...cleanPromptLines(joined), raw: joined };
      }
    }

    const bubble = turnEl.querySelector?.('.user-query-bubble-with-background, .query-text, .user-query-text') || turnEl;
    const cloneText = (bubble.innerText || bubble.textContent || '').trim();
    return { ...cleanPromptLines(cloneText), raw: cloneText };
  }

  function severityLevel(usedPct) {
    if (!Number.isFinite(usedPct)) return 'normal';
    if (usedPct >= 85) return 'high';
    if (usedPct >= 60) return 'warn';
    return 'normal';
  }

  // ---------------------------------------------------------------------------
  // Storage helpers
  // ---------------------------------------------------------------------------

  function safeGetStorage(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function safeSetStorage(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Ignore private mode / quota errors
    }
  }

  function loadDisplayMode() {
    return safeGetStorage(STORAGE_KEYS.mode) === 'remaining' ? 'remaining' : 'used';
  }

  function loadCachedQuota(accountIndex) {
    const raw = safeGetStorage(STORAGE_KEYS.cachePrefix + accountIndex);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && parsed.ok ? parsed : null;
    } catch {
      return null;
    }
  }

  function saveCachedQuota(accountIndex, data) {
    if (!data || !data.ok) return;
    safeSetStorage(STORAGE_KEYS.cachePrefix + accountIndex, JSON.stringify(data));
  }

  function loadBookmarks(convKey) {
    if (!convKey) return new Set();
    const raw = safeGetStorage(STORAGE_KEYS.bookmarksPrefix + convKey);
    if (!raw) return new Set();
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? new Set(arr.map(String)) : new Set();
    } catch {
      return new Set();
    }
  }

  function saveBookmarks(convKey, set) {
    if (!convKey) return;
    safeSetStorage(STORAGE_KEYS.bookmarksPrefix + convKey, JSON.stringify(Array.from(set)));
  }

  // ---------------------------------------------------------------------------
  // Stylesheet (Material 3 / Gemini Web + Codex Desktop Unified Styling)
  // ---------------------------------------------------------------------------

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = h('style', { id: STYLE_ID });
    style.textContent = `
      :root {
        --gxu-font: 'Google Sans', 'Google Sans Text', Roboto, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        --gxu-text-primary: #1f1f1f;
        --gxu-text-secondary: #5f6368;
        --gxu-text-muted: #747775;
        --gxu-surface: rgba(255, 255, 255, 0.97);
        --gxu-surface-hover: rgba(68, 71, 70, 0.08);
        --gxu-surface-pill: rgba(68, 71, 70, 0.055);
        --gxu-border: rgba(68, 71, 70, 0.13);
        --gxu-shadow: 0 8px 28px rgba(0, 0, 0, 0.10), 0 1px 4px rgba(0, 0, 0, 0.05);
        --gxu-track: rgba(68, 71, 70, 0.14);
        --gxu-accent-5h: #0b57d0;
        --gxu-accent-wk: #4c8df6;
        --gxu-accent-warn: #d97706;
        --gxu-accent-high: #d93025;
        --gxu-tick-idle: rgba(68, 71, 70, 0.28);
        --gxu-tick-hover: rgba(31, 31, 31, 0.62);
        --gxu-tick-active: #1f1f1f;
        --gxu-highlight-ring: rgba(11, 87, 208, 0.18);
      }

      html[data-gxu-theme="dark"] {
        --gxu-text-primary: #e3e3e3;
        --gxu-text-secondary: #c4c7c5;
        --gxu-text-muted: #8e918f;
        --gxu-surface: rgba(36, 38, 41, 0.97);
        --gxu-surface-hover: rgba(196, 199, 197, 0.10);
        --gxu-surface-pill: rgba(196, 199, 197, 0.07);
        --gxu-border: rgba(255, 255, 255, 0.11);
        --gxu-shadow: 0 10px 32px rgba(0, 0, 0, 0.44), 0 2px 6px rgba(0, 0, 0, 0.24);
        --gxu-track: rgba(196, 199, 197, 0.18);
        --gxu-accent-5h: #a8c7fa;
        --gxu-accent-wk: #7cacf8;
        --gxu-accent-warn: #fdd663;
        --gxu-accent-high: #f28b82;
        --gxu-tick-idle: rgba(196, 199, 197, 0.28);
        --gxu-tick-hover: rgba(227, 227, 227, 0.68);
        --gxu-tick-active: #e3e3e3;
        --gxu-highlight-ring: rgba(168, 199, 250, 0.22);
      }

      .gxu-avatar-quota {
        display: inline-flex;
        flex-direction: column;
        justify-content: center;
        gap: 3px;
        padding: 4px 8px;
        margin-inline: auto 6px;
        border-radius: 10px;
        background: var(--gxu-surface-pill);
        border: 1px solid transparent;
        font-family: var(--gxu-font);
        font-variant-numeric: tabular-nums;
        cursor: pointer;
        user-select: none;
        flex: 0 0 auto;
        min-width: 92px;
        max-width: 120px;
        box-sizing: border-box;
        align-self: center;
        transition: background-color 150ms ease, border-color 150ms ease, opacity 150ms ease;
      }

      .gxu-avatar-quota:hover,
      .gxu-avatar-quota[data-open="true"] {
        background: var(--gxu-surface-hover);
        border-color: var(--gxu-border);
      }

      .gxu-avatar-quota[data-floating="true"] {
        position: fixed;
        bottom: 14px;
        left: 74px;
        z-index: 950;
        margin: 0;
        background: var(--gxu-surface);
        border-color: var(--gxu-border);
        box-shadow: var(--gxu-shadow);
        backdrop-filter: blur(12px);
      }

      .gxu-avatar-quota[data-hidden="true"] {
        display: none !important;
      }

      .gxu-quota-mini-row {
        display: grid;
        grid-template-columns: 18px 1fr auto;
        align-items: center;
        gap: 5px;
        line-height: 1;
      }

      .gxu-quota-mini-label {
        font-size: 10px;
        font-weight: 500;
        color: var(--gxu-text-secondary);
        letter-spacing: 0.01em;
      }

      .gxu-quota-mini-track {
        height: 4px;
        min-width: 28px;
        border-radius: 999px;
        background: var(--gxu-track);
        overflow: hidden;
        position: relative;
      }

      .gxu-quota-mini-fill {
        height: 100%;
        width: 0%;
        border-radius: 999px;
        background: var(--gxu-accent-5h);
        transition: width 260ms cubic-bezier(0.2, 0, 0, 1), background-color 200ms ease;
      }

      .gxu-quota-mini-row[data-window="weekly"] .gxu-quota-mini-fill {
        background: var(--gxu-accent-wk);
      }

      .gxu-quota-mini-fill[data-level="warn"] {
        background: var(--gxu-accent-warn) !important;
      }

      .gxu-quota-mini-fill[data-level="high"] {
        background: var(--gxu-accent-high) !important;
      }

      .gxu-quota-mini-val {
        font-size: 10.5px;
        font-weight: 600;
        color: var(--gxu-text-primary);
        text-align: right;
        min-width: 24px;
      }

      .gxu-avatar-quota[data-loading="true"] .gxu-quota-mini-val {
        opacity: 0.65;
      }

      .gxu-quota-popover {
        position: fixed;
        z-index: 2200;
        width: 268px;
        padding: 14px 15px;
        border-radius: 16px;
        background: var(--gxu-surface);
        border: 1px solid var(--gxu-border);
        box-shadow: var(--gxu-shadow);
        backdrop-filter: blur(14px);
        font-family: var(--gxu-font);
        font-variant-numeric: tabular-nums;
        color: var(--gxu-text-primary);
        opacity: 0;
        transform: translateY(6px) scale(0.98);
        pointer-events: none;
        transition: opacity 150ms ease, transform 150ms cubic-bezier(0.2, 0, 0, 1);
      }

      .gxu-quota-popover[data-open="true"] {
        opacity: 1;
        transform: translateY(0) scale(1);
        pointer-events: auto;
      }

      .gxu-pop-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 11px;
      }

      .gxu-pop-title {
        font-size: 13px;
        font-weight: 600;
        color: var(--gxu-text-primary);
      }

      .gxu-pop-actions {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .gxu-icon-btn {
        appearance: none;
        border: none;
        background: transparent;
        color: var(--gxu-text-secondary);
        border-radius: 8px;
        padding: 4px 6px;
        font-size: 11px;
        font-family: var(--gxu-font);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 3px;
        transition: background-color 140ms ease, color 140ms ease;
        text-decoration: none;
      }

      .gxu-icon-btn:hover {
        background: var(--gxu-surface-hover);
        color: var(--gxu-text-primary);
      }

      .gxu-icon-btn[data-spinning="true"] svg {
        animation: gxu-spin 0.8s linear infinite;
      }

      @keyframes gxu-spin {
        to { transform: rotate(360deg); }
      }

      .gxu-pop-section + .gxu-pop-section {
        margin-top: 11px;
        padding-top: 10px;
        border-top: 1px solid var(--gxu-border);
      }

      .gxu-pop-row {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        margin-bottom: 5px;
      }

      .gxu-pop-label {
        font-size: 12px;
        font-weight: 500;
        color: var(--gxu-text-primary);
      }

      .gxu-pop-pct {
        font-size: 12px;
        font-weight: 600;
        color: var(--gxu-text-primary);
      }

      .gxu-pop-track {
        height: 6px;
        border-radius: 999px;
        background: var(--gxu-track);
        overflow: hidden;
        margin-bottom: 5px;
      }

      .gxu-pop-fill {
        height: 100%;
        width: 0%;
        border-radius: 999px;
        background: var(--gxu-accent-5h);
        transition: width 260ms cubic-bezier(0.2, 0, 0, 1);
      }

      .gxu-pop-section[data-window="weekly"] .gxu-pop-fill {
        background: var(--gxu-accent-wk);
      }

      .gxu-pop-fill[data-level="warn"] {
        background: var(--gxu-accent-warn) !important;
      }

      .gxu-pop-fill[data-level="high"] {
        background: var(--gxu-accent-high) !important;
      }

      .gxu-pop-meta {
        font-size: 11px;
        color: var(--gxu-text-secondary);
        display: flex;
        justify-content: space-between;
        gap: 6px;
      }

      .gxu-pop-footer {
        margin-top: 11px;
        padding-top: 8px;
        border-top: 1px solid var(--gxu-border);
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 11px;
        color: var(--gxu-text-muted);
      }

      /* Codex Desktop-Style Turn Timeline Rail */
      .gxu-timeline-rail {
        position: fixed;
        top: 50%;
        left: 292px;
        transform: translateY(-50%);
        z-index: 940;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        max-height: 64vh;
        overflow-y: auto;
        overflow-x: visible;
        scrollbar-width: none;
        padding: 6px 4px;
        user-select: none;
        transition: left 180ms cubic-bezier(0.2, 0, 0, 1), opacity 160ms ease;
      }

      .gxu-timeline-rail::-webkit-scrollbar {
        display: none;
      }

      .gxu-timeline-rail[data-hidden="true"] {
        opacity: 0;
        pointer-events: none;
      }

      .gxu-timeline-item {
        display: flex;
        align-items: center;
        gap: 4px;
        width: 28px;
        height: var(--gxu-tick-row-h, 13px);
        padding: 0 2px;
        cursor: pointer;
        flex: 0 0 auto;
        box-sizing: border-box;
      }

      .gxu-timeline-tick {
        height: 2px;
        width: 10px;
        border-radius: 999px;
        background: var(--gxu-tick-idle);
        transition: width 150ms cubic-bezier(0.2, 0, 0, 1), background-color 150ms ease, height 150ms ease;
      }

      .gxu-timeline-item:hover .gxu-timeline-tick,
      .gxu-timeline-item[data-hovered="true"] .gxu-timeline-tick {
        width: 16px;
        background: var(--gxu-tick-hover);
      }

      .gxu-timeline-item[data-active="true"] .gxu-timeline-tick {
        width: 19px;
        height: 2.2px;
        background: var(--gxu-tick-active);
      }

      .gxu-timeline-item[data-bookmarked="true"] .gxu-timeline-tick {
        background: var(--gxu-accent-5h);
      }

      .gxu-timeline-dot {
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: var(--gxu-accent-5h);
        opacity: 0;
        transform: scale(0.5);
        transition: opacity 140ms ease, transform 140ms ease;
      }

      .gxu-timeline-item[data-bookmarked="true"] .gxu-timeline-dot {
        opacity: 1;
        transform: scale(1);
      }

      /* Codex Desktop Hover Preview Card */
      .gxu-timeline-card {
        position: fixed;
        z-index: 2150;
        width: 292px;
        max-width: calc(100vw - 80px);
        padding: 12px 14px;
        border-radius: 14px;
        background: var(--gxu-surface);
        border: 1px solid var(--gxu-border);
        box-shadow: var(--gxu-shadow);
        backdrop-filter: blur(14px);
        font-family: var(--gxu-font);
        color: var(--gxu-text-primary);
        cursor: pointer;
        opacity: 0;
        transform: translateX(-4px) scale(0.985);
        pointer-events: none;
        transition: opacity 130ms ease, transform 130ms cubic-bezier(0.2, 0, 0, 1);
      }

      .gxu-timeline-card[data-open="true"] {
        opacity: 1;
        transform: translateX(0) scale(1);
        pointer-events: auto;
      }

      .gxu-tc-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
      }

      .gxu-tc-title {
        font-size: 13px;
        font-weight: 600;
        line-height: 1.44;
        color: var(--gxu-text-primary);
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        word-break: break-word;
        flex: 1 1 auto;
      }

      .gxu-tc-bookmark {
        appearance: none;
        border: none;
        background: transparent;
        color: var(--gxu-text-muted);
        padding: 3px;
        margin: -2px -3px 0 0;
        border-radius: 6px;
        cursor: pointer;
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: color 140ms ease, background-color 140ms ease;
      }

      .gxu-tc-bookmark:hover {
        background: var(--gxu-surface-hover);
        color: var(--gxu-text-primary);
      }

      .gxu-tc-bookmark[data-active="true"] {
        color: var(--gxu-accent-5h);
      }

      .gxu-tc-body {
        margin-top: 6px;
        font-size: 12.2px;
        font-weight: 400;
        line-height: 1.48;
        color: var(--gxu-text-secondary);
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
        overflow: hidden;
        word-break: break-word;
      }

      .gxu-tc-body:empty {
        display: none;
      }

      @keyframes gxu-turn-pulse {
        0% { box-shadow: 0 0 0 0 var(--gxu-highlight-ring); }
        45% { box-shadow: 0 0 0 6px var(--gxu-highlight-ring); }
        100% { box-shadow: 0 0 0 0 transparent; }
      }

      .gxu-turn-flash {
        border-radius: 16px;
        animation: gxu-turn-pulse 1.2s ease-out;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // Theme Sync
  // ---------------------------------------------------------------------------

  function detectTheme() {
    const themeHost = document.querySelector('.theme-host');
    if (themeHost) {
      if (themeHost.classList.contains('dark-theme')) return 'dark';
      if (themeHost.classList.contains('light-theme')) return 'light';
    }
    if (document.body?.classList.contains('dark-theme') || document.documentElement.classList.contains('dark-theme')) {
      return 'dark';
    }
    try {
      const bg = getComputedStyle(document.body || document.documentElement).backgroundColor;
      const m = bg && bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (m) {
        const lum = (Number(m[1]) * 299 + Number(m[2]) * 587 + Number(m[3]) * 114) / 1000;
        return lum < 110 ? 'dark' : 'light';
      }
    } catch {
      // Ignore in headless test contexts
    }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function syncTheme() {
    const mode = detectTheme();
    if (document.documentElement.getAttribute('data-gxu-theme') !== mode) {
      document.documentElement.setAttribute('data-gxu-theme', mode);
    }
  }

  // ---------------------------------------------------------------------------
  // Quota Fetching & Signature Auto-Discovery
  // ---------------------------------------------------------------------------

  let currentQuota = null;
  let quotaInFlight = null;
  let displayMode = loadDisplayMode();
  let isGenerating = false;

  async function discoverLatestSignature(accountIndex) {
    const scripts = Array.from(document.querySelectorAll('script[type="importmap"], script'));
    let bundleUrl = '';
    for (const s of scripts) {
      const url = extractBundleUrlFromHtml(s.textContent || s.src || '');
      if (url) {
        bundleUrl = url;
        break;
      }
    }

    if (!bundleUrl) {
      try {
        const prefix = getAccountPrefix(accountIndex);
        const usageRes = await fetch(`${ORIGIN}${prefix}/usage`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (usageRes.ok) {
          bundleUrl = extractBundleUrlFromHtml(await usageRes.text());
        }
      } catch {
        // Ignore network errors
      }
    }

    if (!bundleUrl) return '';

    try {
      const bundleRes = await fetch(bundleUrl, {
        mode: 'cors',
        credentials: 'omit',
        cache: 'force-cache',
      });
      if (!bundleRes.ok) return '';
      const sig = extractQuerySignatureFromBundle(await bundleRes.text());
      if (sig) safeSetStorage(STORAGE_KEYS.sig, sig);
      return sig;
    } catch {
      return '';
    }
  }

  async function queryWithSignature(accountIndex, signature) {
    const prefix = getAccountPrefix(accountIndex);
    const headers = { Accept: 'application/json' };
    if (accountIndex !== '0') {
      headers['X-Goog-AuthUser'] = accountIndex;
    }

    for (const vars of QUERY_VARIANTS) {
      const url = buildExecuteQueryUrl(accountIndex, signature, vars);
      try {
        const res = await fetch(url, {
          method: 'GET',
          mode: 'same-origin',
          credentials: 'same-origin',
          redirect: 'error',
          cache: 'no-store',
          headers,
          referrer: `${ORIGIN}${prefix}/usage`,
        });
        if (res.status === 401 || res.status === 403) {
          return { ok: false, reason: 'signed_out' };
        }
        if (!res.ok) continue;
        const parsed = parseGraphqlUsageResponse(await res.text());
        if (parsed.ok || parsed.reason === 'signed_out') return parsed;
      } catch {
        // Try next query variable shape
      }
    }
    return { ok: false, reason: 'signature_failed' };
  }

  async function refreshQuota({ force = false } = {}) {
    const accountIndex = getAccountIndex();
    if (!force && currentQuota?.ok && currentQuota.accountIndex === accountIndex) {
      if (Date.now() - currentQuota.fetchedAt < REFRESH_TTL_MS) {
        return currentQuota;
      }
    }
    if (quotaInFlight) return quotaInFlight;

    setQuotaLoading(true);
    quotaInFlight = (async () => {
      try {
        const storedSig = safeGetStorage(STORAGE_KEYS.sig);
        const candidates = Array.from(new Set([storedSig, ...DEFAULT_SIGNATURES].filter(Boolean)));

        for (const sig of candidates) {
          const result = await queryWithSignature(accountIndex, sig);
          if (result.ok) {
            result.accountIndex = accountIndex;
            currentQuota = result;
            saveCachedQuota(accountIndex, result);
            safeSetStorage(STORAGE_KEYS.sig, sig);
            renderQuotaUI();
            return result;
          }
          if (result.reason === 'signed_out') {
            currentQuota = { ok: false, reason: 'signed_out', accountIndex };
            renderQuotaUI();
            return currentQuota;
          }
        }

        const discovered = await discoverLatestSignature(accountIndex);
        if (discovered && !candidates.includes(discovered)) {
          const retry = await queryWithSignature(accountIndex, discovered);
          if (retry.ok) {
            retry.accountIndex = accountIndex;
            currentQuota = retry;
            saveCachedQuota(accountIndex, retry);
            renderQuotaUI();
            return retry;
          }
        }

        if (!currentQuota) {
          currentQuota = { ok: false, reason: 'unavailable', accountIndex };
        }
        renderQuotaUI();
        return currentQuota;
      } finally {
        quotaInFlight = null;
        setQuotaLoading(false);
      }
    })();

    return quotaInFlight;
  }

  // ---------------------------------------------------------------------------
  // Sidebar Avatar Quota Widget & Popover UI
  // ---------------------------------------------------------------------------

  let badgeEl = null;
  let popoverEl = null;
  let uiRefs = {};
  let popoverOpen = false;

  function createQuotaDOM() {
    if (badgeEl && popoverEl) return;

    const mini5hFill = h('div', { className: 'gxu-quota-mini-fill', id: 'gxu-mini-5h-fill' });
    const mini5hVal = h('span', { className: 'gxu-quota-mini-val', id: 'gxu-mini-5h-val', textContent: '--%' });
    const miniWkFill = h('div', { className: 'gxu-quota-mini-fill', id: 'gxu-mini-wk-fill' });
    const miniWkVal = h('span', { className: 'gxu-quota-mini-val', id: 'gxu-mini-wk-val', textContent: '--%' });

    badgeEl = h(
      'div',
      {
        className: 'gxu-avatar-quota',
        id: 'gxu-avatar-quota',
        role: 'button',
        tabindex: '0',
        title: '查看 5 小时限额与周限额详情',
      },
      [
        h('div', { className: 'gxu-quota-mini-row', 'data-window': '5h' }, [
          h('span', { className: 'gxu-quota-mini-label', textContent: '5h' }),
          h('div', { className: 'gxu-quota-mini-track' }, [mini5hFill]),
          mini5hVal,
        ]),
        h('div', { className: 'gxu-quota-mini-row', 'data-window': 'weekly' }, [
          h('span', { className: 'gxu-quota-mini-label', textContent: '周' }),
          h('div', { className: 'gxu-quota-mini-track' }, [miniWkFill]),
          miniWkVal,
        ]),
      ]
    );

    const modeBtn = h('button', {
      type: 'button',
      className: 'gxu-icon-btn',
      id: 'gxu-mode-btn',
      title: '切换显示已用 / 剩余百分比',
      textContent: '已用%',
    });

    const refreshIcon = svg(
      'svg',
      {
        viewBox: '0 0 24 24',
        width: '13',
        height: '13',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '2',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      },
      [
        svg('path', { d: 'M21 12a9 9 0 1 1-2.64-6.36' }),
        svg('polyline', { points: '21 3 21 9 15 9' }),
      ]
    );

    const refreshBtn = h(
      'button',
      {
        type: 'button',
        className: 'gxu-icon-btn',
        id: 'gxu-refresh-btn',
        title: '立即刷新限额',
      },
      [refreshIcon]
    );

    const usageLink = h('a', {
      className: 'gxu-icon-btn',
      id: 'gxu-usage-link',
      target: '_blank',
      rel: 'noopener noreferrer',
      title: '打开官方用量页',
      textContent: '↗',
    });

    const pop5hPct = h('span', { className: 'gxu-pop-pct', id: 'gxu-pop-5h-pct', textContent: '--%' });
    const pop5hFill = h('div', { className: 'gxu-pop-fill', id: 'gxu-pop-5h-fill' });
    const pop5hSub = h('span', { id: 'gxu-pop-5h-sub', textContent: '加载中…' });
    const pop5hRem = h('span', { id: 'gxu-pop-5h-rem', textContent: '' });

    const popWkPct = h('span', { className: 'gxu-pop-pct', id: 'gxu-pop-wk-pct', textContent: '--%' });
    const popWkFill = h('div', { className: 'gxu-pop-fill', id: 'gxu-pop-wk-fill' });
    const popWkSub = h('span', { id: 'gxu-pop-wk-sub', textContent: '加载中…' });
    const popWkRem = h('span', { id: 'gxu-pop-wk-rem', textContent: '' });

    const popUpdated = h('span', { id: 'gxu-pop-updated', textContent: '等待同步' });

    popoverEl = h('div', { className: 'gxu-quota-popover', id: 'gxu-quota-popover' }, [
      h('div', { className: 'gxu-pop-header' }, [
        h('div', { className: 'gxu-pop-title', textContent: 'Gemini 用量限额' }),
        h('div', { className: 'gxu-pop-actions' }, [modeBtn, refreshBtn, usageLink]),
      ]),
      h('div', { className: 'gxu-pop-section', 'data-window': '5h' }, [
        h('div', { className: 'gxu-pop-row' }, [
          h('span', { className: 'gxu-pop-label', textContent: '5 小时限额' }),
          pop5hPct,
        ]),
        h('div', { className: 'gxu-pop-track' }, [pop5hFill]),
        h('div', { className: 'gxu-pop-meta' }, [pop5hSub, pop5hRem]),
      ]),
      h('div', { className: 'gxu-pop-section', 'data-window': 'weekly' }, [
        h('div', { className: 'gxu-pop-row' }, [
          h('span', { className: 'gxu-pop-label', textContent: '周限额 (7天)' }),
          popWkPct,
        ]),
        h('div', { className: 'gxu-pop-track' }, [popWkFill]),
        h('div', { className: 'gxu-pop-meta' }, [popWkSub, popWkRem]),
      ]),
      h('div', { className: 'gxu-pop-footer' }, [
        popUpdated,
        h('span', { textContent: '回复完成后自动刷新' }),
      ]),
    ]);

    uiRefs = {
      mini5hFill,
      mini5hVal,
      miniWkFill,
      miniWkVal,
      modeBtn,
      refreshBtn,
      usageLink,
      pop5hPct,
      pop5hFill,
      pop5hSub,
      pop5hRem,
      popWkPct,
      popWkFill,
      popWkSub,
      popWkRem,
      popUpdated,
    };

    badgeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePopover();
    });
    badgeEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        togglePopover();
      }
    });

    popoverEl.addEventListener('click', (e) => e.stopPropagation());

    modeBtn.addEventListener('click', () => {
      displayMode = displayMode === 'used' ? 'remaining' : 'used';
      safeSetStorage(STORAGE_KEYS.mode, displayMode);
      renderQuotaUI();
    });

    refreshBtn.addEventListener('click', () => {
      refreshQuota({ force: true });
    });

    document.addEventListener('click', () => {
      if (popoverOpen) togglePopover(false);
    });
  }

  function setQuotaLoading(loading) {
    if (!badgeEl || !uiRefs.refreshBtn) return;
    badgeEl.setAttribute('data-loading', loading ? 'true' : 'false');
    uiRefs.refreshBtn.setAttribute('data-spinning', loading ? 'true' : 'false');
  }

  function positionPopover() {
    if (!badgeEl || !popoverEl || !popoverOpen) return;
    const rect = badgeEl.getBoundingClientRect();
    const popW = 268;
    const popH = popoverEl.offsetHeight || 205;
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - popW - 12));
    let top = rect.top - popH - 10;
    if (top < 12) {
      top = Math.min(window.innerHeight - popH - 12, rect.bottom + 10);
    }
    popoverEl.style.left = `${Math.round(left)}px`;
    popoverEl.style.top = `${Math.round(top)}px`;
  }

  function togglePopover(force) {
    popoverOpen = typeof force === 'boolean' ? force : !popoverOpen;
    if (!badgeEl || !popoverEl) return;
    badgeEl.setAttribute('data-open', popoverOpen ? 'true' : 'false');
    popoverEl.setAttribute('data-open', popoverOpen ? 'true' : 'false');
    if (popoverOpen) {
      const prefix = getAccountPrefix(getAccountIndex());
      uiRefs.usageLink?.setAttribute('href', `${ORIGIN}${prefix}/usage`);
      renderQuotaUI();
      positionPopover();
      refreshQuota({ force: false });
    }
  }

  function findSettingsGearButton(sidenav) {
    if (!sidenav) return null;
    const buttons = Array.from(sidenav.querySelectorAll('button, [role="button"]'));
    for (const btn of buttons) {
      const testId = (btn.getAttribute('data-test-id') || '').toLowerCase();
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (
        testId.includes('settings') ||
        /settings|设置|設定/.test(aria) ||
        btn.querySelector?.('mat-icon[fonticon="settings"], [data-mat-icon-name="settings"]')
      ) {
        return btn;
      }
      const iconEl = btn.querySelector?.('mat-icon, .google-symbols, .luminous-symbols, .material-symbols-rounded');
      if (iconEl && (iconEl.textContent || '').trim() === 'settings') {
        return btn;
      }
    }
    return null;
  }

  function isHorizontalFooterRow(parent, gearBranch) {
    const siblings = Array.from(parent.children || []).filter(
      (el) => el !== badgeEl && el.tagName !== 'STYLE'
    );
    if (siblings.length < 2) return false;

    try {
      const cs = getComputedStyle(parent);
      if ((cs.display === 'flex' || cs.display === 'inline-flex') && !cs.flexDirection.startsWith('column')) {
        return true;
      }
      if (cs.display === 'grid' || cs.display === 'inline-grid') {
        return true;
      }
    } catch {
      // Fall back to bounding-box check
    }

    const other = siblings.find((el) => el !== gearBranch);
    if (other?.getBoundingClientRect && gearBranch?.getBoundingClientRect) {
      const r1 = other.getBoundingClientRect();
      const r2 = gearBranch.getBoundingClientRect();
      if (r1.width > 0 && r2.width > 0) {
        const yDiff = Math.abs((r1.top + r1.height / 2) - (r2.top + r2.height / 2));
        return yDiff < 28 && r1.left < r2.left;
      }
    }
    return false;
  }

  function findSidebarFooterAnchor(sidenav) {
    const gear = findSettingsGearButton(sidenav);
    if (!gear) return null;

    let branch = gear;
    let parent = gear.parentElement;
    for (let depth = 0; depth < 5 && parent && parent !== sidenav; depth++) {
      if (isHorizontalFooterRow(parent, branch)) {
        return { container: parent, beforeNode: branch };
      }
      branch = parent;
      parent = parent.parentElement;
    }
    return null;
  }

  function mountQuotaWidget() {
    createQuotaDOM();
    if (document.body && popoverEl.parentElement !== document.body) {
      document.body.appendChild(popoverEl);
    }

    const sidenav = document.querySelector(SIDENAV_SELECTOR);
    if (sidenav) {
      const rect = sidenav.getBoundingClientRect?.() || { width: 260, right: 260 };
      const isExpanded = rect.width >= 180 && rect.right >= 180;
      const anchor = isExpanded ? findSidebarFooterAnchor(sidenav) : null;

      if (isExpanded && anchor && anchor.container) {
        badgeEl.removeAttribute('data-floating');
        badgeEl.removeAttribute('data-hidden');
        badgeEl.style.removeProperty('left');
        if (badgeEl.parentElement !== anchor.container || badgeEl.nextElementSibling !== anchor.beforeNode) {
          anchor.container.insertBefore(badgeEl, anchor.beforeNode);
        }
        return;
      }

      badgeEl.setAttribute('data-floating', 'true');
      badgeEl.removeAttribute('data-hidden');
      const floatingLeft = isExpanded
        ? Math.max(16, Math.round(rect.right - 136))
        : rect.right > 20 && rect.width < 180
          ? Math.round(rect.right + 10)
          : 16;
      badgeEl.style.left = `${floatingLeft}px`;
      if (document.body && badgeEl.parentElement !== document.body) {
        document.body.appendChild(badgeEl);
      }
      return;
    }

    const topAvatar = document.querySelector('a[href*="SignOutOptions"][aria-label], a[aria-label*="Google Account" i]');
    const topWrapper = topAvatar?.parentElement?.parentElement || topAvatar?.parentElement;
    if (topWrapper) {
      badgeEl.removeAttribute('data-floating');
      badgeEl.removeAttribute('data-hidden');
      badgeEl.style.removeProperty('left');
      if (badgeEl.parentElement !== topWrapper) {
        topWrapper.insertBefore(badgeEl, topWrapper.firstChild);
      }
      return;
    }

    if (document.body && badgeEl.parentElement !== document.body) {
      badgeEl.setAttribute('data-floating', 'true');
      badgeEl.style.left = '16px';
      document.body.appendChild(badgeEl);
    }
  }

  function renderWindowMetric(win, refs, kind) {
    if (!win) {
      refs.miniVal.textContent = '--%';
      refs.miniFill.style.width = '0%';
      refs.popPct.textContent = '不可用';
      refs.popFill.style.width = '0%';
      refs.popSub.textContent = '暂无此窗口限额数据';
      refs.popRem.textContent = '';
      return;
    }

    const shownPct = displayMode === 'remaining' ? win.remainingPct : win.usedPct;
    const level = severityLevel(win.usedPct);

    refs.miniVal.textContent = `${shownPct}%`;
    refs.miniFill.style.width = `${shownPct}%`;
    refs.miniFill.setAttribute('data-level', level);

    refs.popPct.textContent = displayMode === 'remaining'
      ? `剩余 ${win.remainingPct}%`
      : `已用 ${win.usedPct}%`;
    refs.popFill.style.width = `${shownPct}%`;
    refs.popFill.setAttribute('data-level', level);
    refs.popSub.textContent = formatResetTime(win.resetAt, Date.now(), kind);
    refs.popRem.textContent = displayMode === 'remaining'
      ? `已用 ${win.usedPct}%`
      : `剩余 ${win.remainingPct}%`;
  }

  function renderQuotaUI() {
    if (!badgeEl || !popoverEl) return;
    uiRefs.modeBtn.textContent = displayMode === 'remaining' ? '剩余%' : '已用%';

    if (!currentQuota || !currentQuota.ok) {
      const isSignedOut = currentQuota?.reason === 'signed_out';
      const label = isSignedOut ? '未登录' : '--%';
      const sub = isSignedOut ? '请先登录 Gemini 账号' : '点击右上角刷新或打开官方用量页';
      uiRefs.mini5hVal.textContent = label;
      uiRefs.miniWkVal.textContent = label;
      uiRefs.pop5hSub.textContent = sub;
      uiRefs.popWkSub.textContent = '';
      return;
    }

    renderWindowMetric(
      currentQuota.fiveHour,
      {
        miniFill: uiRefs.mini5hFill,
        miniVal: uiRefs.mini5hVal,
        popPct: uiRefs.pop5hPct,
        popFill: uiRefs.pop5hFill,
        popSub: uiRefs.pop5hSub,
        popRem: uiRefs.pop5hRem,
      },
      '5h'
    );

    renderWindowMetric(
      currentQuota.weekly,
      {
        miniFill: uiRefs.miniWkFill,
        miniVal: uiRefs.miniWkVal,
        popPct: uiRefs.popWkPct,
        popFill: uiRefs.popWkFill,
        popSub: uiRefs.popWkSub,
        popRem: uiRefs.popWkRem,
      },
      'weekly'
    );

    if (currentQuota.fetchedAt) {
      const dt = new Date(currentQuota.fetchedAt);
      const hh = String(dt.getHours()).padStart(2, '0');
      const mm = String(dt.getMinutes()).padStart(2, '0');
      uiRefs.popUpdated.textContent = `更新于 ${hh}:${mm}`;
    }
  }

  // ---------------------------------------------------------------------------
  // Codex Desktop-Style Sidebar Turn Timeline
  // ---------------------------------------------------------------------------

  let railEl = null;
  let cardEl = null;
  let cardRefs = {};
  let timelineTurns = [];
  let activeTurnIndex = -1;
  let hoveredTurnIndex = -1;
  let hideCardTimer = null;
  let boundScroller = null;
  let scrollRafPending = false;

  function createTimelineDOM() {
    if (railEl && cardEl) return;

    railEl = h('nav', {
      className: 'gxu-timeline-rail',
      id: 'gxu-timeline-rail',
      'aria-label': '对话时间线导航',
      'data-hidden': 'true',
    });

    const bookmarkPath = svg('path', {
      d: 'M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z',
    });
    const bookmarkSvg = svg(
      'svg',
      {
        viewBox: '0 0 24 24',
        width: '15',
        height: '15',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1.9',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      },
      [bookmarkPath]
    );
    const bookmarkBtn = h(
      'button',
      {
        type: 'button',
        className: 'gxu-tc-bookmark',
        id: 'gxu-tc-bookmark',
        title: '收藏/标记此轮对话',
      },
      [bookmarkSvg]
    );
    const titleEl = h('div', { className: 'gxu-tc-title', id: 'gxu-tc-title' });
    const bodyEl = h('div', { className: 'gxu-tc-body', id: 'gxu-tc-body' });

    cardEl = h('div', { className: 'gxu-timeline-card', id: 'gxu-timeline-card' }, [
      h('div', { className: 'gxu-tc-head' }, [titleEl, bookmarkBtn]),
      bodyEl,
    ]);

    cardRefs = { titleEl, bodyEl, bookmarkBtn, bookmarkPath };

    cardEl.addEventListener('mouseenter', () => {
      if (hideCardTimer) {
        clearTimeout(hideCardTimer);
        hideCardTimer = null;
      }
    });
    cardEl.addEventListener('mouseleave', () => {
      scheduleHideCard();
    });
    cardEl.addEventListener('click', (e) => {
      if (e.target.closest?.('#gxu-tc-bookmark')) return;
      if (hoveredTurnIndex >= 0 && timelineTurns[hoveredTurnIndex]) {
        jumpToTurn(hoveredTurnIndex);
      }
    });

    bookmarkBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (hoveredTurnIndex < 0 || !timelineTurns[hoveredTurnIndex]) return;
      const convKey = extractConversationKey();
      if (!convKey) return;
      const turn = timelineTurns[hoveredTurnIndex];
      const bookmarks = loadBookmarks(convKey);
      if (bookmarks.has(turn.id)) bookmarks.delete(turn.id);
      else bookmarks.add(turn.id);
      saveBookmarks(convKey, bookmarks);
      syncBookmarkState(bookmarks);
      updateBookmarkButtonUI(bookmarks.has(turn.id));
    });

    if (document.body) {
      document.body.appendChild(railEl);
      document.body.appendChild(cardEl);
    }
  }

  function updateBookmarkButtonUI(active) {
    if (!cardRefs.bookmarkBtn || !cardRefs.bookmarkPath) return;
    cardRefs.bookmarkBtn.setAttribute('data-active', active ? 'true' : 'false');
    cardRefs.bookmarkPath.setAttribute('fill', active ? 'currentColor' : 'none');
  }

  function syncBookmarkState(bookmarks) {
    if (!railEl) return;
    const rows = railEl.querySelectorAll('.gxu-timeline-item');
    rows.forEach((row, idx) => {
      const turn = timelineTurns[idx];
      const isMarked = !!(turn && bookmarks.has(turn.id));
      row.setAttribute('data-bookmarked', isMarked ? 'true' : 'false');
    });
  }

  function scheduleHideCard() {
    if (hideCardTimer) clearTimeout(hideCardTimer);
    hideCardTimer = setTimeout(() => {
      hideCardTimer = null;
      cardEl?.setAttribute('data-open', 'false');
      railEl?.querySelectorAll('.gxu-timeline-item[data-hovered="true"]').forEach((el) => {
        el.removeAttribute('data-hovered');
      });
      hoveredTurnIndex = -1;
    }, 130);
  }

  function showPreviewCard(index, itemEl) {
    const turn = timelineTurns[index];
    if (!turn || !cardEl || !itemEl) return;
    if (hideCardTimer) {
      clearTimeout(hideCardTimer);
      hideCardTimer = null;
    }
    hoveredTurnIndex = index;

    railEl?.querySelectorAll('.gxu-timeline-item[data-hovered="true"]').forEach((el) => {
      if (el !== itemEl) el.removeAttribute('data-hovered');
    });
    itemEl.setAttribute('data-hovered', 'true');

    cardRefs.titleEl.textContent = turn.title;
    cardRefs.bodyEl.textContent = turn.body;

    const bookmarks = loadBookmarks(extractConversationKey());
    updateBookmarkButtonUI(bookmarks.has(turn.id));

    cardEl.setAttribute('data-open', 'true');

    const itemRect = itemEl.getBoundingClientRect();
    const cardH = cardEl.offsetHeight || 96;
    const left = Math.min(window.innerWidth - 308, Math.round(itemRect.right + 8));
    const rawTop = itemRect.top + itemRect.height / 2 - cardH / 2;
    const top = Math.max(14, Math.min(window.innerHeight - cardH - 14, Math.round(rawTop)));

    cardEl.style.left = `${Math.max(14, left)}px`;
    cardEl.style.top = `${top}px`;
  }

  function isTurnVisible(el) {
    if (!el.getBoundingClientRect) return true;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  function collectDeduplicatedUserTurns() {
    const candidates = Array.from(document.querySelectorAll(USER_TURN_SELECTOR)).filter(isTurnVisible);
    if (candidates.length === 0) return [];
    return candidates.filter(
      (el) => !candidates.some((other) => other !== el && other.contains(el))
    );
  }

  function computeStableTurnId(el, idx, rawText) {
    const domId = el.id || el.parentElement?.id || el.closest?.('[data-turn-id]')?.getAttribute('data-turn-id') || '';
    if (domId) return `id:${domId}`;
    const snippet = (rawText || '').slice(0, 32).replace(/\s+/g, '_');
    return `idx:${idx}:${snippet}`;
  }

  function findChatScroller(sampleTurnEl) {
    const known = document.querySelector(SCROLLER_SELECTOR);
    if (known) return known;
    for (let node = sampleTurnEl?.parentElement; node && node !== document.body; node = node.parentElement) {
      try {
        const cs = getComputedStyle(node);
        if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
          return node;
        }
      } catch {
        // Ignore
      }
    }
    return null;
  }

  function bindScroller(nextScroller) {
    if (nextScroller === boundScroller) return;
    if (boundScroller) {
      boundScroller.removeEventListener('scroll', onChatScroll);
    }
    boundScroller = nextScroller;
    if (boundScroller) {
      boundScroller.addEventListener('scroll', onChatScroll, { passive: true });
    }
  }

  function onChatScroll() {
    if (scrollRafPending) return;
    scrollRafPending = true;
    requestAnimationFrame(() => {
      scrollRafPending = false;
      updateActiveTurnFromViewport();
    });
  }

  function updateActiveTurnFromViewport() {
    if (!railEl || timelineTurns.length === 0) return;
    const scrollerRect = boundScroller?.getBoundingClientRect?.() || {
      top: 0,
      height: window.innerHeight || 800,
    };
    const anchorY = scrollerRect.top + scrollerRect.height * 0.34;

    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < timelineTurns.length; i++) {
      const el = timelineTurns[i].el;
      if (!el?.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (r.top <= anchorY) {
        bestIdx = i;
        bestDist = anchorY - r.top;
      } else if (bestDist === Infinity) {
        bestIdx = i;
        break;
      }
    }

    if (bestIdx !== activeTurnIndex) {
      activeTurnIndex = bestIdx;
      const items = railEl.querySelectorAll('.gxu-timeline-item');
      items.forEach((row, idx) => {
        if (idx === activeTurnIndex) row.setAttribute('data-active', 'true');
        else row.removeAttribute('data-active');
      });
    }
  }

  function jumpToTurn(index) {
    const turn = timelineTurns[index];
    if (!turn || !turn.el?.isConnected) return;
    activeTurnIndex = index;
    const items = railEl?.querySelectorAll('.gxu-timeline-item') || [];
    items.forEach((row, idx) => {
      if (idx === index) row.setAttribute('data-active', 'true');
      else row.removeAttribute('data-active');
    });

    turn.el.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    const highlightTarget = turn.el.querySelector?.('.user-query-bubble-with-background, .query-text') || turn.el;
    highlightTarget.classList?.remove('gxu-turn-flash');
    void highlightTarget.offsetWidth;
    highlightTarget.classList?.add('gxu-turn-flash');
    setTimeout(() => highlightTarget.classList?.remove('gxu-turn-flash'), 1300);
  }

  function updateTimelinePosition() {
    if (!railEl) return;
    const sidenav = document.querySelector(SIDENAV_SELECTOR);
    let sidebarRight = 0;
    if (sidenav?.getBoundingClientRect) {
      const r = sidenav.getBoundingClientRect();
      if (r.width > 0 && r.right > 0 && r.left < 60 && r.width < window.innerWidth * 0.55) {
        sidebarRight = r.right;
      }
    }
    const left = Math.max(12, Math.round(sidebarRight + 14));
    railEl.style.left = `${left}px`;
  }

  function syncTimeline() {
    createTimelineDOM();
    if (document.body && railEl.parentElement !== document.body) {
      document.body.appendChild(railEl);
    }
    if (document.body && cardEl.parentElement !== document.body) {
      document.body.appendChild(cardEl);
    }

    const convKey = extractConversationKey();
    const elements = convKey ? collectDeduplicatedUserTurns() : [];

    if (!convKey || elements.length === 0) {
      timelineTurns = [];
      activeTurnIndex = -1;
      railEl.setAttribute('data-hidden', 'true');
      cardEl.setAttribute('data-open', 'false');
      return;
    }

    bindScroller(findChatScroller(elements[0]));

    const nextTurns = elements.map((el, idx) => {
      const prompt = extractTurnPrompt(el);
      return {
        el,
        id: computeStableTurnId(el, idx, prompt.raw),
        title: prompt.title,
        body: prompt.body,
      };
    });

    const unchanged =
      nextTurns.length === timelineTurns.length &&
      nextTurns.every((t, i) => t.id === timelineTurns[i].id && t.title === timelineTurns[i].title && t.el === timelineTurns[i].el);

    timelineTurns = nextTurns;

    const rowH = nextTurns.length > 28 ? 8 : nextTurns.length > 16 ? 10 : 13;
    railEl.style.setProperty('--gxu-tick-row-h', `${rowH}px`);

    if (!unchanged) {
      const bookmarks = loadBookmarks(convKey);
      clearChildren(railEl);
      nextTurns.forEach((turn, idx) => {
        const item = h(
          'div',
          {
            className: 'gxu-timeline-item',
            'data-bookmarked': bookmarks.has(turn.id) ? 'true' : 'false',
          },
          [
            h('span', { className: 'gxu-timeline-tick' }),
            h('span', { className: 'gxu-timeline-dot' }),
          ]
        );
        item.addEventListener('mouseenter', () => showPreviewCard(idx, item));
        item.addEventListener('mouseleave', () => scheduleHideCard());
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          jumpToTurn(idx);
        });
        railEl.appendChild(item);
      });
      activeTurnIndex = -1;
    }

    railEl.setAttribute('data-hidden', 'false');
    updateTimelinePosition();
    updateActiveTurnFromViewport();
  }

  // ---------------------------------------------------------------------------
  // Generation Completion Watcher & Lifecycle Orchestration
  // ---------------------------------------------------------------------------

  function checkGenerationTransition() {
    const stopControl =
      document.querySelector('.send-button.stop') ||
      document.querySelector('button[aria-label*="Stop" i]') ||
      document.querySelector('button[aria-label*="停止"]') ||
      document.querySelector('mat-icon[fonticon="stop"], [data-mat-icon-name="stop"]');

    const nowGenerating = Boolean(stopControl);
    if (nowGenerating && !isGenerating) {
      isGenerating = true;
    } else if (!nowGenerating && isGenerating) {
      isGenerating = false;
      setTimeout(() => refreshQuota({ force: true }), 1200);
    }
  }

  let syncScheduled = false;
  let lastHref = location.href;

  function scheduleUISync() {
    if (syncScheduled) return;
    syncScheduled = true;
    setTimeout(() => {
      syncScheduled = false;
      syncTheme();
      mountQuotaWidget();
      syncTimeline();
      checkGenerationTransition();
      if (popoverOpen) positionPopover();

      if (location.href !== lastHref) {
        const prevAccount = getAccountIndex(lastHref);
        lastHref = location.href;
        const nextAccount = getAccountIndex(lastHref);
        if (nextAccount !== prevAccount) {
          currentQuota = loadCachedQuota(nextAccount);
          renderQuotaUI();
          refreshQuota({ force: true });
        }
      }
    }, 80);
  }

  function init() {
    ensureStyles();
    syncTheme();

    const acct = getAccountIndex();
    currentQuota = loadCachedQuota(acct);

    mountQuotaWidget();
    renderQuotaUI();
    syncTimeline();
    refreshQuota({ force: false });

    const observer = new MutationObserver(() => {
      scheduleUISync();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'aria-expanded', 'href'],
    });

    window.addEventListener('resize', () => {
      updateTimelinePosition();
      mountQuotaWidget();
      if (popoverOpen) positionPopover();
    });

    window.addEventListener('popstate', scheduleUISync);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        scheduleUISync();
        refreshQuota({ force: false });
      }
    });

    setInterval(() => {
      if (!document.hidden) {
        refreshQuota({ force: false });
      }
    }, POLL_INTERVAL_MS);
  }

  if (typeof window.__GXU_TEST_HOOK__ === 'function') {
    window.__GXU_TEST_HOOK__({
      getAccountIndex,
      getAccountPrefix,
      buildExecuteQueryUrl,
      parseGraphqlUsageResponse,
      extractBundleUrlFromHtml,
      extractQuerySignatureFromBundle,
      formatResetTime,
      extractConversationKey,
      cleanPromptLines,
      extractTurnPrompt,
      severityLevel,
      refreshQuota,
      syncTimeline,
      mountQuotaWidget,
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
