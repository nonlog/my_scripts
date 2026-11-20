// ==UserScript==
// @name         Gemini Usage & Timeline
// @namespace    https://github.com/nonlog/my_scripts
// @version      1.2.2
// @description  Show 5-hour and weekly usage quotas beside the Gemini Web sidebar profile, plus a Codex-style right-side turn timeline.
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

  // Clean up any older DOM nodes if hot-reloaded in ScriptCat / Tampermonkey
  for (const staleId of [
    'gxu-usage-timeline-style',
    'gxu-avatar-quota',
    'gxu-quota-popover',
    'gxu-timeline-rail',
    'gxu-timeline-card',
  ]) {
    document.getElementById(staleId)?.remove?.();
  }

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
  const MODEL_RESPONSE_SELECTOR = 'model-response, .model-response, response-container, [data-message-author-role="model"]';
  const EXCLUDED_RESPONSE_SELECTOR = [
    'model-thoughts',
    '.thoughts-container',
    '.thoughts-wrapper',
    '.thinking-process',
    '[data-test-id="model-thoughts"]',
    '[data-test-id*="thought"]',
    '[data-test-id*="tool"]',
    '[data-test-id*="code-execution"]',
    '.tool-call',
    '.tool-calls-container',
    '.tool-use',
    '.code-execution',
    '.execution-status',
    '.chip-container',
    'mat-expansion-panel',
    'expansion-panel',
    '.response-container-header',
    '.model-response-header',
    'message-actions',
    '.response-footer',
    '.feedback-buttons',
    'tts-control',
    '.copy-button',
    'button',
    'mat-icon',
    'svg',
    'script',
    'style',
    '[aria-hidden="true"]',
  ].join(', ');
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
    if (!Number.isFinite(resetAt)) return 'Reset time unavailable';
    const diffMs = resetAt - nowMs;
    if (diffMs <= 0) return 'Refreshing soon';

    const totalMinutes = Math.max(1, Math.ceil(diffMs / 60000));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const mins = totalMinutes % 60;

    const dt = new Date(resetAt);
    const hh = String(dt.getHours()).padStart(2, '0');
    const mm = String(dt.getMinutes()).padStart(2, '0');

    if (kind === 'weekly' || days >= 1) {
      const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const dayLabel = weekdays[dt.getDay()];
      const rel = days > 0 ? `${days}d ${hours}h` : `${hours}h ${mins}m`;
      return `Resets in ${rel} · ${dayLabel} ${hh}:${mm}`;
    }

    const rel = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    return `Resets in ${rel} · ${hh}:${mm}`;
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
    if (typeof rawText !== 'string') return { title: '[Attachment]', body: '' };
    const stripped = rawText
      .replace(/^\s*(?:You said|你说|你說)\s*[:：]?\s*/i, '')
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    if (stripped.length === 0) {
      return { title: '[Attachment]', body: '' };
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
    if (!turnEl) return { title: '[Attachment]', body: '', raw: '' };
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
  // Stylesheet (Material 3 / Gemini Web + Right-Side Codex Timeline)
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

      /* Flat, flush badge in the sidebar footer gap (isolated on body to prevent Angular hover/reflow loops) */
      .gxu-avatar-quota {
        position: fixed;
        z-index: 950;
        display: inline-flex;
        flex-direction: column;
        justify-content: center;
        gap: 4px;
        padding: 6px 8px;
        margin: 0;
        min-height: 34px;
        border-radius: 8px;
        background: transparent;
        border: none;
        box-shadow: none;
        font-family: var(--gxu-font);
        font-variant-numeric: tabular-nums;
        cursor: pointer;
        user-select: none;
        -webkit-user-select: none;
        touch-action: manipulation;
        width: 98px;
        box-sizing: border-box;
        transition: background-color 120ms ease;
      }

      .gxu-avatar-quota * {
        pointer-events: none;
      }

      .gxu-avatar-quota:hover,
      .gxu-avatar-quota[data-open="true"] {
        background: var(--gxu-surface-hover);
      }

      .gxu-avatar-quota[data-hidden="true"] {
        display: none !important;
      }

      .gxu-quota-mini-row {
        display: grid;
        grid-template-columns: 16px 1fr auto;
        align-items: center;
        gap: 5px;
        line-height: 1;
      }

      .gxu-quota-mini-label {
        font-size: 10.5px;
        font-weight: 500;
        color: var(--gxu-text-secondary);
        letter-spacing: 0.01em;
      }

      .gxu-quota-mini-track {
        height: 3.5px;
        min-width: 26px;
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
        font-weight: 500;
        color: var(--gxu-text-secondary);
        text-align: right;
        min-width: 24px;
      }

      .gxu-avatar-quota:hover .gxu-quota-mini-val,
      .gxu-avatar-quota[data-open="true"] .gxu-quota-mini-val {
        color: var(--gxu-text-primary);
      }

      .gxu-avatar-quota[data-loading="true"] .gxu-quota-mini-val {
        opacity: 0.6;
      }

      .gxu-quota-popover {
        position: fixed;
        z-index: 2200;
        width: 272px;
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

      /* Right-Side Codex Desktop-Style Turn Timeline Rail */
      .gxu-timeline-rail {
        position: fixed;
        top: 50%;
        right: 18px;
        left: auto;
        transform: translateY(-50%);
        z-index: 940;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        max-height: 64vh;
        overflow-y: auto;
        overflow-x: visible;
        scrollbar-width: none;
        padding: 6px 4px;
        user-select: none;
        transition: right 180ms cubic-bezier(0.2, 0, 0, 1), opacity 160ms ease;
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
        justify-content: flex-end;
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

      /* Codex Hover Preview Card (opens to the left of the right-side rail) */
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
        transform: translateX(4px) scale(0.985);
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

      .gxu-menu-export-item--fallback {
        display: flex;
        align-items: center;
        gap: 16px;
        width: 100%;
        min-height: 48px;
        padding: 0 12px;
        border: none;
        background: transparent;
        color: var(--gxu-text-primary);
        font-family: var(--gxu-font);
        font-size: 14px;
        font-weight: 400;
        line-height: 20px;
        text-align: left;
        cursor: pointer;
        box-sizing: border-box;
      }

      .gxu-menu-export-item--fallback:hover {
        background: var(--gxu-surface-hover);
      }

      .gxu-icon-btn[data-exported="true"] {
        color: var(--gxu-accent-5h);
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
        'aria-label': 'View 5-hour and weekly usage limits',
        'aria-expanded': 'false',
        'data-slot': 'fixed-gap',
        'data-hidden': 'true',
      },
      [
        h('div', { className: 'gxu-quota-mini-row', 'data-window': '5h' }, [
          h('span', { className: 'gxu-quota-mini-label', textContent: '5h' }),
          h('div', { className: 'gxu-quota-mini-track' }, [mini5hFill]),
          mini5hVal,
        ]),
        h('div', { className: 'gxu-quota-mini-row', 'data-window': 'weekly' }, [
          h('span', { className: 'gxu-quota-mini-label', textContent: '7d' }),
          h('div', { className: 'gxu-quota-mini-track' }, [miniWkFill]),
          miniWkVal,
        ]),
      ]
    );

    const modeBtn = h('button', {
      type: 'button',
      className: 'gxu-icon-btn',
      id: 'gxu-mode-btn',
      title: 'Switch between Used % and Left %',
      textContent: 'Used',
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
        title: 'Refresh usage limits',
      },
      [refreshIcon]
    );

    const usageLink = h('a', {
      className: 'gxu-icon-btn',
      id: 'gxu-usage-link',
      target: '_blank',
      rel: 'noopener noreferrer',
      title: 'Open Usage limits page',
      textContent: '↗',
    });

    const exportIcon = svg(
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
        svg('path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }),
        svg('polyline', { points: '7 10 12 15 17 10' }),
        svg('line', { x1: '12', y1: '15', x2: '12', y2: '3' }),
      ]
    );

    const exportBtn = h(
      'button',
      {
        type: 'button',
        className: 'gxu-icon-btn',
        id: 'gxu-export-btn',
        title: 'Export conversation as Markdown',
      },
      [exportIcon]
    );

    const pop5hPct = h('span', { className: 'gxu-pop-pct', id: 'gxu-pop-5h-pct', textContent: '--%' });
    const pop5hFill = h('div', { className: 'gxu-pop-fill', id: 'gxu-pop-5h-fill' });
    const pop5hSub = h('span', { id: 'gxu-pop-5h-sub', textContent: 'Loading…' });
    const pop5hRem = h('span', { id: 'gxu-pop-5h-rem', textContent: '' });

    const popWkPct = h('span', { className: 'gxu-pop-pct', id: 'gxu-pop-wk-pct', textContent: '--%' });
    const popWkFill = h('div', { className: 'gxu-pop-fill', id: 'gxu-pop-wk-fill' });
    const popWkSub = h('span', { id: 'gxu-pop-wk-sub', textContent: 'Loading…' });
    const popWkRem = h('span', { id: 'gxu-pop-wk-rem', textContent: '' });

    const popUpdated = h('span', { id: 'gxu-pop-updated', textContent: 'Syncing…' });

    popoverEl = h('div', { className: 'gxu-quota-popover', id: 'gxu-quota-popover' }, [
      h('div', { className: 'gxu-pop-header' }, [
        h('div', { className: 'gxu-pop-title', textContent: 'Usage limits' }),
        h('div', { className: 'gxu-pop-actions' }, [exportBtn, modeBtn, refreshBtn, usageLink]),
      ]),
      h('div', { className: 'gxu-pop-section', 'data-window': '5h' }, [
        h('div', { className: 'gxu-pop-row' }, [
          h('span', { className: 'gxu-pop-label', textContent: '5-hour limit' }),
          pop5hPct,
        ]),
        h('div', { className: 'gxu-pop-track' }, [pop5hFill]),
        h('div', { className: 'gxu-pop-meta' }, [pop5hSub, pop5hRem]),
      ]),
      h('div', { className: 'gxu-pop-section', 'data-window': 'weekly' }, [
        h('div', { className: 'gxu-pop-row' }, [
          h('span', { className: 'gxu-pop-label', textContent: 'Weekly limit' }),
          popWkPct,
        ]),
        h('div', { className: 'gxu-pop-track' }, [popWkFill]),
        h('div', { className: 'gxu-pop-meta' }, [popWkSub, popWkRem]),
      ]),
      h('div', { className: 'gxu-pop-footer' }, [
        popUpdated,
        h('span', { textContent: 'Auto-refreshes after replies' }),
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
      exportBtn,
    };

    const swallowPress = (e) => {
      e.stopPropagation();
    };
    badgeEl.addEventListener('pointerdown', swallowPress);
    badgeEl.addEventListener('mousedown', swallowPress);
    badgeEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePopover();
    });
    badgeEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        togglePopover();
      } else if (e.key === 'Escape' && popoverOpen) {
        e.preventDefault();
        e.stopPropagation();
        togglePopover(false);
      }
    });

    popoverEl.addEventListener('pointerdown', swallowPress);
    popoverEl.addEventListener('mousedown', swallowPress);
    popoverEl.addEventListener('click', swallowPress);

    modeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      displayMode = displayMode === 'used' ? 'remaining' : 'used';
      safeSetStorage(STORAGE_KEYS.mode, displayMode);
      renderQuotaUI();
    });

    refreshBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      refreshQuota({ force: true });
    });

    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      exportConversationMarkdown();
    });

    const closeOnOutsidePress = (e) => {
      if (!popoverOpen) return;
      const target = e?.target;
      if (target && (badgeEl?.contains?.(target) || popoverEl?.contains?.(target))) {
        return;
      }
      togglePopover(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePress, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && popoverOpen) {
        togglePopover(false);
      }
    });
  }

  function setAttrIfChanged(el, name, value) {
    if (!el) return;
    const str = String(value);
    if (el.getAttribute(name) !== str) {
      el.setAttribute(name, str);
    }
  }

  function setQuotaLoading(loading) {
    if (!badgeEl || !uiRefs.refreshBtn) return;
    const flag = loading ? 'true' : 'false';
    setAttrIfChanged(badgeEl, 'data-loading', flag);
    setAttrIfChanged(uiRefs.refreshBtn, 'data-spinning', flag);
  }

  function positionPopover() {
    if (!badgeEl || !popoverEl || !popoverOpen) return;
    const rect = badgeEl.getBoundingClientRect();
    const popW = 272;
    const popH = popoverEl.offsetHeight || 205;
    const left = Math.round(Math.max(12, Math.min(rect.left, window.innerWidth - popW - 12)));
    let top = Math.round(rect.top - popH - 10);
    if (top < 12) {
      top = Math.round(Math.min(window.innerHeight - popH - 12, rect.bottom + 10));
    }
    const leftPx = `${left}px`;
    const topPx = `${top}px`;
    if (popoverEl.style.left !== leftPx) popoverEl.style.left = leftPx;
    if (popoverEl.style.top !== topPx) popoverEl.style.top = topPx;
  }

  function togglePopover(force) {
    const nextOpen = typeof force === 'boolean' ? force : !popoverOpen;
    popoverOpen = nextOpen;
    if (!badgeEl || !popoverEl) return;
    const flag = popoverOpen ? 'true' : 'false';
    setAttrIfChanged(badgeEl, 'data-open', flag);
    setAttrIfChanged(badgeEl, 'aria-expanded', flag);
    setAttrIfChanged(popoverEl, 'data-open', flag);
    if (popoverOpen) {
      const prefix = getAccountPrefix(getAccountIndex());
      setAttrIfChanged(uiRefs.usageLink, 'href', `${ORIGIN}${prefix}/usage`);
      renderQuotaUI();
      positionPopover();
      refreshQuota({ force: false });
    }
  }

  function findSettingsGearButton() {
    const scope = document.querySelector(SIDENAV_SELECTOR) || document;
    const buttons = Array.from(scope.querySelectorAll('button, [role="button"]'));
    const minBottomTop = (window.innerHeight || 800) * 0.5;
    let best = null;
    let bestScore = -1;
    let bestBottom = -1;

    for (const btn of buttons) {
      if (btn.closest?.('conversations-list, .conversations-container, [data-test-id="all-conversations"]')) {
        continue;
      }

      const testId = (btn.getAttribute('data-test-id') || '').toLowerCase();
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      const hasSettingsIconAttr = Boolean(
        btn.querySelector?.('mat-icon[fonticon="settings"], [data-mat-icon-name="settings"]')
      );
      const iconEl = !hasSettingsIconAttr
        ? btn.querySelector?.('mat-icon, .google-symbols, .luminous-symbols, .material-symbols-rounded')
        : null;
      const hasSettingsIconText = Boolean(iconEl && (iconEl.textContent || '').trim() === 'settings');
      const matchesAttr = testId.includes('settings') || /settings|设置|設定/.test(aria);

      if (!hasSettingsIconAttr && !hasSettingsIconText && !matchesAttr) continue;

      let rect = { left: 224, top: 850, bottom: 882, width: 32, height: 32 };
      if (btn.getBoundingClientRect) {
        const r = btn.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0 || r.left > 440 || r.height > 64 || r.width > 280) continue;
        if (r.top < minBottomTop) continue;
        rect = r;
      }

      const isNativeButton = String(btn.tagName || '').toUpperCase() === 'BUTTON';
      const score =
        (isNativeButton ? 4 : 0) +
        (hasSettingsIconAttr || hasSettingsIconText ? 2 : 0) +
        (matchesAttr ? 1 : 0);

      if (score > bestScore || (score === bestScore && rect.bottom > bestBottom)) {
        best = btn;
        bestScore = score;
        bestBottom = rect.bottom;
      }
    }
    return best;
  }

  let lastBadgeLayout = { hidden: true, left: -9999, top: -9999, width: -9999 };

  function hideQuotaBadge() {
    if (!badgeEl) return;
    if (!lastBadgeLayout.hidden || badgeEl.getAttribute('data-hidden') !== 'true') {
      badgeEl.setAttribute('data-hidden', 'true');
      lastBadgeLayout.hidden = true;
    }
    if (popoverOpen) togglePopover(false);
  }

  function findFooterScope(gear, sidenav) {
    let scope = gear.parentElement || sidenav || document.body;
    let cur = gear.parentElement;
    for (let depth = 0; depth < 5 && cur && cur !== sidenav && cur !== document.body; depth++) {
      const r = cur.getBoundingClientRect?.();
      if (r && r.height > 108) break;
      scope = cur;
      cur = cur.parentElement;
    }
    return scope;
  }

  function computeProfileRightEdge(gear, sidenav, gearRect) {
    // Measure only within the footer row horizontally aligned with the Settings gear so conversation list items never interfere
    let maxRight = 84;
    const scope = findFooterScope(gear, sidenav);
    if (!scope) return maxRight;
    const gearCenterY = gearRect.top + gearRect.height / 2;
    const inRowBand = (r) =>
      r &&
      r.width > 0 &&
      r.height > 0 &&
      r.height <= 72 &&
      Math.abs(r.top + r.height / 2 - gearCenterY) <= 22 &&
      r.right < gearRect.left - 8;

    if (scope.querySelectorAll) {
      for (const media of scope.querySelectorAll('img, svg')) {
        if (gear.contains?.(media)) continue;
        const r = media.getBoundingClientRect?.();
        if (inRowBand(r) && r.right > maxRight) {
          maxRight = r.right;
        }
      }
    }

    if (typeof document.createTreeWalker === 'function' && typeof document.createRange === 'function') {
      const walker = document.createTreeWalker(scope, 4 /* NodeFilter.SHOW_TEXT */);
      const range = document.createRange();
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent || !node.textContent.trim()) continue;
        const parent = node.parentElement;
        if (!parent || gear.contains?.(parent)) continue;
        range.selectNodeContents(node);
        const r = range.getBoundingClientRect?.();
        if (inRowBand(r) && r.right > maxRight) {
          maxRight = r.right;
        }
      }
    } else if (Array.isArray(scope.children)) {
      for (const child of scope.children) {
        if (child === gear || child === badgeEl || child.contains?.(gear)) continue;
        const r = child.getBoundingClientRect?.();
        if (inRowBand(r) && r.right > maxRight) {
          maxRight = r.right;
        }
      }
    }

    return maxRight;
  }

  function mountQuotaWidget() {
    createQuotaDOM();
    if (document.body && badgeEl.parentElement !== document.body) {
      document.body.appendChild(badgeEl);
    }
    if (document.body && popoverEl.parentElement !== document.body) {
      document.body.appendChild(popoverEl);
    }

    const gear = findSettingsGearButton();
    if (!gear) {
      hideQuotaBadge();
      return;
    }

    // Use real rendered gear <button> geometry (immune to 0x0 <bard-sidenav> custom-element host rect)
    const gearRect = gear.getBoundingClientRect?.() || { left: 224, right: 256, top: 850, bottom: 882, width: 32, height: 32 };
    const isSidebarExpanded = gearRect.width > 0 && gearRect.right >= 165 && gearRect.top >= (window.innerHeight || 800) * 0.5;
    if (!isSidebarExpanded) {
      hideQuotaBadge();
      return;
    }

    const sidenav = document.querySelector(SIDENAV_SELECTOR);
    const profileRight = computeProfileRightEdge(gear, sidenav, gearRect);
    const availableGap = gearRect.left - profileRight - 14;
    if (availableGap < 74) {
      hideQuotaBadge();
      return;
    }

    const badgeWidth = Math.max(82, Math.min(102, Math.floor(availableGap)));
    const minLeft = Math.round(profileRight + 8);
    const maxLeft = Math.round(gearRect.left - badgeWidth - 6);
    if (maxLeft < 68) {
      hideQuotaBadge();
      return;
    }

    const left = Math.min(maxLeft, Math.max(72, minLeft));
    const top = Math.round(gearRect.top + gearRect.height / 2 - 17);

    // 1px hysteresis prevents subpixel layout jitter and avoids unnecessary style mutations while hovered
    if (lastBadgeLayout.hidden || badgeEl.hasAttribute('data-hidden')) {
      badgeEl.removeAttribute('data-hidden');
      lastBadgeLayout.hidden = false;
    }
    if (Math.abs(badgeWidth - lastBadgeLayout.width) > 1) {
      badgeEl.style.width = `${badgeWidth}px`;
      lastBadgeLayout.width = badgeWidth;
    }
    if (Math.abs(left - lastBadgeLayout.left) > 1) {
      badgeEl.style.left = `${left}px`;
      lastBadgeLayout.left = left;
    }
    if (Math.abs(top - lastBadgeLayout.top) > 1) {
      badgeEl.style.top = `${top}px`;
      lastBadgeLayout.top = top;
    }
    badgeEl._rect = { left, top, right: left + badgeWidth, bottom: top + 34, width: badgeWidth, height: 34 };
  }

  function renderWindowMetric(win, refs, kind) {
    if (!win) {
      refs.miniVal.textContent = '--%';
      refs.miniFill.style.width = '0%';
      refs.popPct.textContent = 'Unavailable';
      refs.popFill.style.width = '0%';
      refs.popSub.textContent = 'No quota data reported';
      refs.popRem.textContent = '';
      return;
    }

    const shownPct = displayMode === 'remaining' ? win.remainingPct : win.usedPct;
    const level = severityLevel(win.usedPct);

    refs.miniVal.textContent = `${shownPct}%`;
    refs.miniFill.style.width = `${shownPct}%`;
    refs.miniFill.setAttribute('data-level', level);

    refs.popPct.textContent = displayMode === 'remaining'
      ? `${win.remainingPct}% left`
      : `${win.usedPct}% used`;
    refs.popFill.style.width = `${shownPct}%`;
    refs.popFill.setAttribute('data-level', level);
    refs.popSub.textContent = formatResetTime(win.resetAt, Date.now(), kind);
    refs.popRem.textContent = displayMode === 'remaining'
      ? `${win.usedPct}% used`
      : `${win.remainingPct}% left`;
  }

  function renderQuotaUI() {
    if (!badgeEl || !popoverEl) return;
    uiRefs.modeBtn.textContent = displayMode === 'remaining' ? 'Left %' : 'Used %';

    if (!currentQuota || !currentQuota.ok) {
      const isSignedOut = currentQuota?.reason === 'signed_out';
      const label = isSignedOut ? 'Auth' : '--%';
      const sub = isSignedOut ? 'Please sign in to Gemini' : 'Click refresh or open Usage limits';
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
      uiRefs.popUpdated.textContent = `Updated ${hh}:${mm}`;
    }
  }

  // ---------------------------------------------------------------------------
  // Right-Side Codex Desktop-Style Turn Timeline
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
      'aria-label': 'Conversation timeline',
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
        title: 'Bookmark turn',
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
    const cardW = cardEl.offsetWidth || 292;
    const cardH = cardEl.offsetHeight || 96;
    const left = Math.max(14, Math.min(window.innerWidth - cardW - 14, Math.round(itemRect.left - cardW - 10)));
    const rawTop = itemRect.top + itemRect.height / 2 - cardH / 2;
    const top = Math.max(14, Math.min(window.innerHeight - cardH - 14, Math.round(rawTop)));

    cardEl.style.left = `${left}px`;
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
    let rightOffset = 18;
    if (boundScroller?.getBoundingClientRect) {
      const r = boundScroller.getBoundingClientRect();
      if (r.width > 200 && r.right > 0 && r.right <= window.innerWidth) {
        const rightPaneGap = Math.max(0, window.innerWidth - r.right);
        rightOffset = Math.round(rightPaneGap + 16);
      }
    }
    railEl.style.right = `${Math.max(14, rightOffset)}px`;
    railEl.style.left = 'auto';
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
            h('span', { className: 'gxu-timeline-dot' }),
            h('span', { className: 'gxu-timeline-tick' }),
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
  // Conversation Markdown Export (User & Assistant messages, excluding commands)
  // ---------------------------------------------------------------------------

  function deduplicateElements(elements) {
    return elements.filter((el) => !elements.some((other) => other !== el && other.contains?.(el)));
  }

  function isExcludedResponseNode(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.matches?.(EXCLUDED_RESPONSE_SELECTOR)) return true;
    const tag = String(el.tagName || '').toUpperCase();
    if (tag === 'MODEL-THOUGHTS' || tag === 'BUTTON' || tag === 'SVG' || tag === 'MAT-ICON' || tag === 'SCRIPT' || tag === 'STYLE') {
      return true;
    }
    if (el.getAttribute?.('aria-hidden') === 'true') return true;
    return false;
  }

  function detectCodeBlockLanguage(preEl) {
    const codeEl = preEl.querySelector?.('code');
    const cls = `${preEl.className || ''} ${codeEl?.className || ''}`;
    const m = cls.match(/language-([A-Za-z0-9_+#.-]+)/i);
    if (m) return m[1];
    const parent = preEl.parentElement;
    const header = parent?.querySelector?.('.code-block-decoration, .language-label, [data-test-id="code-language"]');
    const langText = (header?.textContent || '').trim().split(/\s+/)[0] || '';
    return /^[A-Za-z0-9_+#.-]{1,20}$/.test(langText) ? langText.toLowerCase() : '';
  }

  function serializeChildren(node, ctx) {
    let out = '';
    for (const child of Array.from(node.childNodes || node.children || [])) {
      out += serializeNodeToMarkdown(child, ctx);
    }
    return out;
  }

  function serializeList(listEl, ordered, ctx) {
    const items = Array.from(listEl.children || []).filter(
      (c) => String(c.tagName || '').toUpperCase() === 'LI' && !isExcludedResponseNode(c)
    );
    const indent = '  '.repeat(ctx.listDepth || 0);
    const lines = [];
    items.forEach((li, idx) => {
      const prefix = ordered ? `${idx + 1}. ` : '- ';
      const raw = serializeChildren(li, { ...ctx, listDepth: (ctx.listDepth || 0) + 1 }).trim();
      if (!raw) return;
      const parts = raw.split('\n');
      lines.push(`${indent}${prefix}${parts[0]}`);
      for (let i = 1; i < parts.length; i++) {
        lines.push(parts[i] ? `${indent}  ${parts[i]}` : '');
      }
    });
    return lines.length > 0 ? `\n${lines.join('\n')}\n\n` : '';
  }

  function serializeTable(tableEl, ctx) {
    const rows = Array.from(tableEl.querySelectorAll?.('tr') || []);
    if (rows.length === 0) return '';
    const matrix = rows.map((tr) =>
      Array.from(tr.children || [])
        .filter((c) => /^(TD|TH)$/i.test(c.tagName || ''))
        .map((cell) => serializeChildren(cell, ctx).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|'))
    ).filter((r) => r.length > 0);
    if (matrix.length === 0) return '';
    const colCount = Math.max(...matrix.map((r) => r.length));
    const padRow = (r) => Array.from({ length: colCount }, (_, i) => r[i] || '');
    const header = padRow(matrix[0]);
    const sep = Array.from({ length: colCount }, () => '---');
    const bodyRows = matrix.slice(1).map(padRow);
    const lines = [
      `| ${header.join(' | ')} |`,
      `| ${sep.join(' | ')} |`,
      ...bodyRows.map((r) => `| ${r.join(' | ')} |`),
    ];
    return `\n${lines.join('\n')}\n\n`;
  }

  function serializeNodeToMarkdown(node, ctx = { listDepth: 0, inPre: false }) {
    if (!node) return '';
    if (node.nodeType === 3) {
      const txt = node.textContent || '';
      return ctx.inPre ? txt : txt.replace(/\s+/g, ' ');
    }
    if (node.nodeType !== 1) return '';
    if (isExcludedResponseNode(node)) return '';

    const tag = String(node.tagName || '').toUpperCase();
    if (tag === 'BR') return '\n';
    if (tag === 'HR') return '\n\n---\n\n';

    if (/^H[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      const inner = serializeChildren(node, ctx).trim();
      return inner ? `\n\n${'#'.repeat(level)} ${inner}\n\n` : '';
    }

    if (tag === 'PRE') {
      const lang = detectCodeBlockLanguage(node);
      const codeNode = node.querySelector?.('code') || node;
      const codeText = (codeNode.textContent || '').replace(/^\n+|\n+$/g, '');
      const fence = codeText.includes('```') ? '````' : '```';
      return `\n\n${fence}${lang}\n${codeText}\n${fence}\n\n`;
    }

    if (tag === 'CODE') {
      if (ctx.inPre) return node.textContent || '';
      const raw = (node.textContent || '').trim();
      if (!raw) return '';
      return raw.includes('`') ? `\`\` ${raw} \`\`` : `\`${raw}\``;
    }

    if (tag === 'STRONG' || tag === 'B') {
      const inner = serializeChildren(node, ctx).trim();
      return inner ? `**${inner}**` : '';
    }

    if (tag === 'EM' || tag === 'I') {
      const inner = serializeChildren(node, ctx).trim();
      return inner ? `*${inner}*` : '';
    }

    if (tag === 'DEL' || tag === 'S') {
      const inner = serializeChildren(node, ctx).trim();
      return inner ? `~~${inner}~~` : '';
    }

    if (tag === 'A') {
      const inner = serializeChildren(node, ctx).trim();
      const href = node.getAttribute?.('href') || '';
      if (!inner) return '';
      return href ? `[${inner}](${href})` : inner;
    }

    if (tag === 'BLOCKQUOTE') {
      const inner = serializeChildren(node, ctx).trim();
      if (!inner) return '';
      const quoted = inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
      return `\n\n${quoted}\n\n`;
    }

    if (tag === 'UL') return serializeList(node, false, ctx);
    if (tag === 'OL') return serializeList(node, true, ctx);
    if (tag === 'TABLE') return serializeTable(node, ctx);

    const inner = serializeChildren(node, ctx);
    if (/^(P|DIV|SECTION|ARTICLE|MESSAGE-CONTENT)$/.test(tag)) {
      const trimmed = inner.trim();
      return trimmed ? `\n\n${trimmed}\n\n` : '';
    }
    return inner;
  }

  function extractAssistantMarkdown(respEl) {
    if (!respEl) return '';
    const contentNodes = deduplicateElements(
      Array.from(
        respEl.querySelectorAll?.('message-content, .markdown-main-panel, [data-test-id="model-response-text"]') || []
      ).filter((el) => !el.closest?.(EXCLUDED_RESPONSE_SELECTOR))
    );
    const targets = contentNodes.length > 0 ? contentNodes : [respEl];
    const md = targets
      .map((t) => serializeNodeToMarkdown(t))
      .join('\n\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return md;
  }

  function compareDomOrder(a, b) {
    if (a === b) return 0;
    if (typeof a?.compareDocumentPosition === 'function') {
      const pos = a.compareDocumentPosition(b);
      if (pos & 4) return -1; // DOCUMENT_POSITION_FOLLOWING
      if (pos & 2) return 1;  // DOCUMENT_POSITION_PRECEDING
    }
    return 0;
  }

  function collectConversationMessages() {
    const userEls = collectDeduplicatedUserTurns();
    const modelEls = deduplicateElements(
      Array.from(document.querySelectorAll(MODEL_RESPONSE_SELECTOR)).filter(isTurnVisible)
    );

    const entries = [];
    userEls.forEach((el, idx) => {
      const prompt = extractTurnPrompt(el);
      const text = (prompt.raw || '').trim();
      if (text) entries.push({ role: 'user', el, order: idx * 2, text });
    });
    modelEls.forEach((el, idx) => {
      const text = extractAssistantMarkdown(el);
      if (text) entries.push({ role: 'assistant', el, order: idx * 2 + 1, text });
    });

    entries.sort((a, b) => {
      const domCmp = compareDomOrder(a.el, b.el);
      return domCmp !== 0 ? domCmp : a.order - b.order;
    });

    return entries.map(({ role, text }) => ({ role, text }));
  }

  function getConversationTitle() {
    const title = (document.title || '').replace(/\s*-\s*Gemini\s*$/i, '').trim();
    if (title && !/^Gemini$/i.test(title)) return title;
    const firstTurn = timelineTurns[0]?.title;
    return firstTurn || 'Gemini Conversation';
  }

  function buildConversationMarkdown() {
    const messages = collectConversationMessages();
    const title = getConversationTitle();
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const exportedAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    const lines = [
      `# ${title}`,
      '',
      `- URL: ${location.href}`,
      `- Exported: ${exportedAt}`,
      '',
    ];

    for (const msg of messages) {
      lines.push(msg.role === 'user' ? '## User' : '## Gemini');
      lines.push('');
      lines.push(msg.text);
      lines.push('');
    }

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }

  function buildExportFilename(title) {
    const safeTitle = (title || 'gemini-conversation')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'gemini-conversation';
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    return `${safeTitle}-${stamp}.md`;
  }

  function exportConversationMarkdown() {
    const md = buildConversationMarkdown();
    const filename = buildExportFilename(getConversationTitle());
    if (typeof Blob === 'function' && typeof URL?.createObjectURL === 'function') {
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: filename, style: 'display:none' });
      (document.body || document.documentElement).appendChild(a);
      a.click?.();
      a.remove?.();
      setTimeout(() => URL.revokeObjectURL?.(url), 1500);
    }
    if (uiRefs.exportBtn) {
      uiRefs.exportBtn.setAttribute('data-exported', 'true');
      setTimeout(() => uiRefs.exportBtn?.removeAttribute('data-exported'), 1600);
    }
    return { filename, markdown: md };
  }

  function closeActiveMenuOverlay() {
    const backdrop = document.querySelector?.('.cdk-overlay-backdrop');
    if (backdrop?.click) {
      backdrop.click();
      return;
    }
    if (typeof KeyboardEvent === 'function') {
      document.dispatchEvent?.(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
  }

  function isTopRightConversationMenu(menuEl) {
    if (!menuEl) return false;
    const items = Array.from(menuEl.querySelectorAll?.('button, [role="menuitem"], a') || []);
    if (items.length === 0) return false;
    const labels = items.map((el) => (el.textContent || '').trim());
    const hasExportOrPdf = labels.some((t) => /download\s*pdf|export\s*to\s*docs|下载\s*pdf|导出到/i.test(t));
    if (hasExportOrPdf) return true;

    const hasChatActions =
      labels.some((t) => /pin|置顶|固定/i.test(t)) &&
      labels.some((t) => /delete|删除/i.test(t));
    if (!hasChatActions) return false;

    if (menuEl.getBoundingClientRect) {
      const r = menuEl.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        return r.top <= 240 && r.left >= (window.innerWidth || 1200) * 0.5;
      }
    }
    return false;
  }

  function syncMenuExportItem() {
    if (!extractConversationKey()) return;
    const menus = Array.from(
      document.querySelectorAll?.('[role="menu"], .mat-mdc-menu-panel, .mat-menu-panel') || []
    );
    for (const menu of menus) {
      const container = menu.querySelector?.('.mat-mdc-menu-content, .mat-menu-content') || menu;
      if (container.querySelector?.('#gxu-menu-export-md')) continue;
      if (!isTopRightConversationMenu(menu)) continue;

      const existingItems = Array.from(container.children || []);
      const downloadPdfItem = existingItems.find((el) => /download\s*pdf|下载\s*pdf/i.test((el.textContent || '').trim()));
      const exportDocsItem = existingItems.find((el) => /export\s*to\s*docs|导出到/i.test((el.textContent || '').trim()));
      const templateItem = downloadPdfItem || exportDocsItem || existingItems[0];

      let itemBtn;
      if (templateItem && typeof templateItem.cloneNode === 'function') {
        itemBtn = templateItem.cloneNode(true);
        itemBtn.id = 'gxu-menu-export-md';
        itemBtn.removeAttribute?.('data-test-id');
        itemBtn.removeAttribute?.('jslog');
        itemBtn.removeAttribute?.('aria-describedby');
        const labelEl = itemBtn.querySelector?.('.mat-mdc-menu-item-text, .mdc-list-item__primary-text');
        if (labelEl) {
          labelEl.textContent = 'Export Markdown';
        } else {
          const walker = typeof document.createTreeWalker === 'function' ? document.createTreeWalker(itemBtn, 4) : null;
          let replaced = false;
          while (walker?.nextNode?.()) {
            const n = walker.currentNode;
            if (!n.parentElement?.closest?.('mat-icon') && (n.textContent || '').trim()) {
              n.textContent = 'Export Markdown';
              replaced = true;
              break;
            }
          }
          if (!replaced) itemBtn.textContent = 'Export Markdown';
        }
      } else {
        const icon = svg(
          'svg',
          {
            viewBox: '0 0 24 24',
            width: '20',
            height: '20',
            fill: 'none',
            stroke: 'currentColor',
            'stroke-width': '1.5',
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
          },
          [
            svg('path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }),
            svg('polyline', { points: '7 10 12 15 17 10' }),
            svg('line', { x1: '12', y1: '15', x2: '12', y2: '3' }),
          ]
        );
        itemBtn = h(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            className: 'mat-mdc-menu-item mat-focus-indicator gxu-menu-export-item--fallback',
            id: 'gxu-menu-export-md',
          },
          [icon, h('span', { className: 'mat-mdc-menu-item-text', textContent: 'Export Markdown' })]
        );
      }

      itemBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        exportConversationMarkdown();
        closeActiveMenuOverlay();
      });

      const deleteItem = existingItems.find((el) => /delete|删除/i.test((el.textContent || '').trim()));
      if (exportDocsItem && exportDocsItem.nextElementSibling) {
        container.insertBefore(itemBtn, exportDocsItem.nextElementSibling);
      } else if (deleteItem) {
        container.insertBefore(itemBtn, deleteItem);
      } else {
        container.appendChild(itemBtn);
      }
    }
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

  function isOwnNode(node) {
    if (!node) return false;
    if (
      node === badgeEl ||
      node === popoverEl ||
      node === railEl ||
      node === cardEl ||
      node.id === 'gxu-menu-export-md' ||
      node.id === STYLE_ID
    ) {
      return true;
    }
    return Boolean(
      badgeEl?.contains?.(node) ||
      popoverEl?.contains?.(node) ||
      railEl?.contains?.(node) ||
      cardEl?.contains?.(node)
    );
  }

  function hasExternalMutation(mutations) {
    if (!Array.isArray(mutations) || mutations.length === 0) return true;
    for (const m of mutations) {
      if (isOwnNode(m.target)) continue;
      if (
        m.type === 'childList' &&
        (m.target === document.body || m.target === document.head || m.target === document.documentElement)
      ) {
        const touched = [
          ...Array.from(m.addedNodes || []),
          ...Array.from(m.removedNodes || []),
        ];
        if (touched.length > 0 && touched.every(isOwnNode)) {
          continue;
        }
      }
      return true;
    }
    return false;
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
      syncMenuExportItem();
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

    const observer = new MutationObserver((mutations) => {
      if (!hasExternalMutation(mutations)) return;
      syncMenuExportItem();
      scheduleUISync();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'aria-expanded', 'href'],
    });

    document.addEventListener(
      'transitionend',
      (e) => {
        const t = e?.target;
        if (t && (t.matches?.(SIDENAV_SELECTOR) || t.closest?.(SIDENAV_SELECTOR))) {
          mountQuotaWidget();
          if (popoverOpen) positionPopover();
        }
      },
      true
    );

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
      hasExternalMutation,
      togglePopover,
      collectConversationMessages,
      buildConversationMarkdown,
      exportConversationMarkdown,
      syncMenuExportItem,
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
