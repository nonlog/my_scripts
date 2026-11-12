'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const repository = path.join(__dirname, '..');
const scriptSource = readFileSync(path.join(repository, 'gemini-usage-timeline.user.js'), 'utf8');
const metaSource = readFileSync(path.join(repository, 'gemini-usage-timeline.meta.js'), 'utf8');

function createMiniDOM({
  href = 'https://gemini.google.com/u/1/app/2bbfca266bd7c135',
  theme = 'light-theme',
  turns = [],
  fetchImpl = async () => ({ ok: false, status: 500, text: async () => '' }),
} = {}) {
  const storage = new Map();
  const listeners = new Map();

  class MiniElement {
    constructor(tagName, namespaceURI = null) {
      this.tagName = String(tagName).toUpperCase();
      this.namespaceURI = namespaceURI;
      this.nodeType = 1;
      this.id = '';
      this.className = '';
      this.textContent = '';
      this.children = [];
      this.parentElement = null;
      this.attributes = new Map();
      this.eventListeners = new Map();
      this._rect = { left: 0, top: 0, right: 260, bottom: 48, width: 260, height: 48 };
      const self = this;
      this.style = {
        _props: new Map(),
        setProperty(k, v) { self.style._props.set(k, String(v)); },
        removeProperty(k) { self.style._props.delete(k); },
      };
      this.classList = {
        contains: (cls) => self.className.split(/\s+/).filter(Boolean).includes(cls),
        add: (cls) => {
          if (!self.classList.contains(cls)) {
            self.className = (self.className + ' ' + cls).trim();
          }
        },
        remove: (cls) => {
          self.className = self.className
            .split(/\s+/)
            .filter((c) => c && c !== cls)
            .join(' ');
        },
      };
    }

    get isConnected() {
      return true;
    }

    get firstChild() {
      return this.children[0] || null;
    }

    get nextElementSibling() {
      if (!this.parentElement) return null;
      const idx = this.parentElement.children.indexOf(this);
      return idx >= 0 ? this.parentElement.children[idx + 1] || null : null;
    }

    setAttribute(name, value) {
      const v = String(value);
      this.attributes.set(name, v);
      if (name === 'id') this.id = v;
      if (name === 'class') this.className = v;
    }

    getAttribute(name) {
      if (name === 'id' && this.id) return this.id;
      if (name === 'class' && this.className) return this.className;
      return this.attributes.get(name) ?? null;
    }

    hasAttribute(name) {
      return this.getAttribute(name) !== null;
    }

    removeAttribute(name) {
      this.attributes.delete(name);
      if (name === 'id') this.id = '';
    }

    appendChild(child) {
      if (child && typeof child === 'object') {
        if (child.parentElement) {
          const i = child.parentElement.children.indexOf(child);
          if (i >= 0) child.parentElement.children.splice(i, 1);
        }
        child.parentElement = this;
        this.children.push(child);
      }
      return child;
    }

    insertBefore(newNode, refNode) {
      if (!refNode) return this.appendChild(newNode);
      if (newNode.parentElement) {
        const oldIdx = newNode.parentElement.children.indexOf(newNode);
        if (oldIdx >= 0) newNode.parentElement.children.splice(oldIdx, 1);
      }
      const idx = this.children.indexOf(refNode);
      newNode.parentElement = this;
      if (idx >= 0) this.children.splice(idx, 0, newNode);
      else this.children.push(newNode);
      return newNode;
    }

    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) {
        this.children.splice(idx, 1);
        child.parentElement = null;
      }
      return child;
    }

    replaceChildren(...nodes) {
      for (const c of this.children) c.parentElement = null;
      this.children = [];
      for (const n of nodes) this.appendChild(n);
    }

    contains(other) {
      if (other === this) return true;
      return this.children.some((c) => c.contains?.(other));
    }

    addEventListener(type, fn) {
      if (!this.eventListeners.has(type)) this.eventListeners.set(type, []);
      this.eventListeners.get(type).push(fn);
    }

    removeEventListener() {}

    dispatch(type, event = {}) {
      const fns = this.eventListeners.get(type) || [];
      const evt = {
        stopPropagation() {},
        preventDefault() {},
        target: this,
        ...event,
      };
      for (const fn of fns) fn(evt);
    }

    getBoundingClientRect() {
      return this._rect;
    }

    matchesSimple(sel) {
      const s = sel.trim();
      if (!s) return false;
      if (s.startsWith('#')) return this.id === s.slice(1);
      if (s.startsWith('.')) {
        return s
          .slice(1)
          .split('.')
          .every((c) => this.classList.contains(c));
      }
      if (s === 'button') return this.tagName === 'BUTTON';
      if (s === '[role="button"]') return this.getAttribute('role') === 'button';
      if (s === 'bard-sidenav' || s === 'side-navigation-v2' || s === 'mat-sidenav') {
        return this.tagName === s.toUpperCase();
      }
      if (s === 'user-query') return this.tagName === 'USER-QUERY';
      if (s === '[data-message-author-role="user"]') {
        return this.getAttribute('data-message-author-role') === 'user';
      }
      if (s === 'script[type="importmap"]' || s === 'script') {
        return this.tagName === 'SCRIPT';
      }
      if (s === '.gxu-timeline-item[data-hovered="true"]') {
        return this.classList.contains('gxu-timeline-item') && this.getAttribute('data-hovered') === 'true';
      }
      return false;
    }

    querySelectorAll(selector) {
      const parts = selector.split(',').map((p) => p.trim());
      const out = [];
      const visit = (node) => {
        for (const child of node.children || []) {
          if (parts.some((p) => child.matchesSimple?.(p))) {
            out.push(child);
          }
          visit(child);
        }
      };
      visit(this);
      return out;
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
  }

  const documentElement = new MiniElement('html');
  const head = new MiniElement('head');
  const body = new MiniElement('body');
  documentElement.appendChild(head);
  documentElement.appendChild(body);

  const themeHost = new MiniElement('div');
  themeHost.className = `theme-host ${theme}`;
  body.appendChild(themeHost);

  const sidenav = new MiniElement('bard-sidenav');
  sidenav._rect = { left: 0, top: 0, right: 268, bottom: 900, width: 268, height: 900 };

  const footerRow = new MiniElement('div');
  footerRow.className = 'sidenav-footer-row';
  footerRow._display = 'flex';

  const profileBlock = new MiniElement('div');
  profileBlock.className = 'user-profile-block';
  profileBlock.textContent = 'log Ultra';
  profileBlock._rect = { left: 12, top: 848, right: 108, bottom: 888, width: 96, height: 40 };

  const gearBtn = new MiniElement('button');
  gearBtn.setAttribute('aria-label', 'Settings and help');
  gearBtn._rect = { left: 224, top: 850, right: 256, bottom: 882, width: 32, height: 32 };

  footerRow.appendChild(profileBlock);
  footerRow.appendChild(gearBtn);
  sidenav.appendChild(footerRow);
  themeHost.appendChild(sidenav);

  const scroller = new MiniElement('div');
  scroller.id = 'chat-history';
  scroller._rect = { left: 268, top: 0, right: 1440, bottom: 900, width: 1172, height: 900 };

  turns.forEach((t, idx) => {
    const turnEl = new MiniElement('user-query');
    turnEl.id = t.id || `turn-${idx}`;
    turnEl._rect = {
      left: 420,
      top: t.top ?? idx * 240 + 80,
      right: 1120,
      bottom: (t.top ?? idx * 240 + 80) + 64,
      width: 700,
      height: 64,
    };
    turnEl.scrollIntoView = () => {
      turnEl._scrolled = true;
    };
    for (const line of t.lines || [t.text || '']) {
      const lineEl = new MiniElement('p');
      lineEl.className = 'query-text-line';
      lineEl.textContent = line;
      turnEl.appendChild(lineEl);
    }
    scroller.appendChild(turnEl);
  });
  themeHost.appendChild(scroller);

  const document = {
    readyState: 'complete',
    hidden: false,
    documentElement,
    head,
    body,
    createElement: (tag) => new MiniElement(tag),
    createElementNS: (ns, tag) => new MiniElement(tag, ns),
    createTextNode: (txt) => ({ nodeType: 3, textContent: String(txt) }),
    getElementById(id) {
      const findId = (node) => {
        if (node.id === id) return node;
        for (const c of node.children || []) {
          const hit = findId(c);
          if (hit) return hit;
        }
        return null;
      };
      return findId(documentElement);
    },
    querySelectorAll: (sel) => documentElement.querySelectorAll(sel),
    querySelector: (sel) => documentElement.querySelector(sel),
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
  };

  let hookApi = null;
  const parsedUrl = new URL(href);
  const location = {
    href: parsedUrl.href,
    origin: parsedUrl.origin,
    pathname: parsedUrl.pathname,
    search: parsedUrl.search,
  };

  const windowObj = {
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener() {},
    matchMedia: () => ({ matches: false }),
    __GXU_TEST_HOOK__(api) {
      hookApi = api;
    },
  };
  windowObj.top = windowObj;
  windowObj.self = windowObj;

  class FakeMutationObserver {
    constructor(cb) { this.cb = cb; }
    observe() {}
    disconnect() {}
  }

  const context = {
    window: windowObj,
    document,
    location,
    localStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, String(v)),
    },
    fetch: fetchImpl,
    getComputedStyle: (el) => ({
      display: el?._display || 'block',
      flexDirection: 'row',
      overflowY: el?.id === 'chat-history' ? 'auto' : 'visible',
      backgroundColor: theme === 'dark-theme' ? 'rgb(19, 19, 20)' : 'rgb(255, 255, 255)',
    }),
    MutationObserver: FakeMutationObserver,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    URL,
    URLSearchParams,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Set,
    Map,
    JSON,
    Promise,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
  };

  vm.runInNewContext(scriptSource, context, { filename: 'gemini-usage-timeline.user.js' });
  return { hookApi, document, footerRow, profileBlock, gearBtn, scroller, storage, sidenav };
}

test('metadata matches userscript header and avoids innerHTML for Trusted Types safety', () => {
  assert.match(scriptSource, /@name\s+Gemini Usage & Timeline/);
  assert.match(metaSource, /@name\s+Gemini Usage & Timeline/);
  assert.match(scriptSource, /@updateURL\s+https:\/\/raw\.githubusercontent\.com\/nonlog\/my_scripts\/master\/gemini-usage-timeline\.meta\.js/);
  assert.match(scriptSource, /@downloadURL\s+https:\/\/raw\.githubusercontent\.com\/nonlog\/my_scripts\/master\/gemini-usage-timeline\.user\.js/);
  assert.doesNotMatch(scriptSource, /\.innerHTML\s*=/, 'must not assign innerHTML under Gemini Trusted Types CSP');
});

test('resolves multi-account /u/1/ executeQuery URL and parses 5-hour & weekly pools', () => {
  const { hookApi } = createMiniDOM();
  assert.equal(hookApi.getAccountIndex('https://gemini.google.com/u/1/app/2bbfca266bd7c135'), '1');
  assert.equal(hookApi.getAccountIndex('https://gemini.google.com/app/abc'), '0');

  const url = hookApi.buildExecuteQueryUrl('1', '2/sig=', { g1Request: {} });
  assert.match(url, /^https:\/\/gemini\.google\.com\/u\/1\/_\/BardChatUi\/graphql\/schemas\/GEMINI_WEB_GRAPHQL\/executeQuery\?/);

  const sampleReply = `)]}'\n` + JSON.stringify([
    {
      data: {
        viewer: {
          rpcs: {
            getUsageInfo: {
              subscriptionTier: 'TIER_ULTRA',
              pools: [
                {
                  poolType: 'GXU_FIVE_HOURLY',
                  percentageUsed: 0.34,
                  gxu: { windowRefreshesAt: '2026-11-12T10:00:00Z' },
                },
                {
                  poolType: 'GXU_WEEKLY',
                  percentageUsed: 0.12,
                  gxu: { windowRefreshesAt: '2026-11-17T00:00:00Z' },
                },
              ],
            },
          },
        },
      },
    },
  ]);

  const parsed = hookApi.parseGraphqlUsageResponse(sampleReply);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.fiveHour.usedPct, 34);
  assert.equal(parsed.fiveHour.remainingPct, 66);
  assert.equal(parsed.weekly.usedPct, 12);
  assert.equal(parsed.weekly.remainingPct, 88);
});

test('mounts quota widget between sidebar profile avatar and settings gear & auto-recovers rotated query signature', async () => {
  const calls = [];
  const rotatedSig = '2/RotatedNewUsageSig1234567890abcdef=';

  const env = createMiniDOM({
    href: 'https://gemini.google.com/u/1/app/2bbfca266bd7c135',
    fetchImpl: async (url, init) => {
      const u = String(url);
      calls.push({ url: u, headers: init?.headers || {} });
      if (u.includes('executeQuery') && !u.includes(encodeURIComponent(rotatedSig))) {
        return {
          ok: true,
          status: 200,
          text: async () => `)]}'\n[{"errors":[{"message":"PersistedQueryNotFound"}]}]`,
        };
      }
      if (u === 'https://gemini.google.com/u/1/usage') {
        return {
          ok: true,
          status: 200,
          text: async () => `<script type="importmap">{"imports":{"@messages/assets/UsagePageLoading-abc99.js":"https://www.gstatic.com/bg3/boq-bard-web/islands/assets/UsagePageLoading-abc99.js"}}</script>`,
        };
      }
      if (u.includes('UsagePageLoading-abc99.js')) {
        return {
          ok: true,
          status: 200,
          text: async () => `const q={id:\`${rotatedSig}\`,metadata:{},name:\`UsagePageQuery\`};`,
        };
      }
      if (u.includes(encodeURIComponent(rotatedSig))) {
        return {
          ok: true,
          status: 200,
          text: async () => `)]}'\n` + JSON.stringify([
            {
              data: {
                viewer: {
                  rpcs: {
                    getUsageInfo: {
                      subscriptionTier: 'TIER1',
                      pools: [
                        { poolType: 'GXU_FIVE_HOURLY', percentageUsed: 0.45, gxu: { windowRefreshesAt: '2026-11-12T12:00:00Z' } },
                        { poolType: 'GXU_WEEKLY', percentageUsed: 0.09, gxu: { windowRefreshesAt: '2026-11-18T00:00:00Z' } },
                      ],
                    },
                  },
                },
              },
            },
          ]),
        };
      }
      return { ok: false, status: 404, text: async () => '' };
    },
  });

  await new Promise((r) => setTimeout(r, 30));

  const badge = env.document.getElementById('gxu-avatar-quota');
  assert.ok(badge, 'quota badge is mounted');
  assert.equal(badge.parentElement, env.footerRow, 'mounted directly inside sidebar profile+settings row');
  assert.equal(env.footerRow.children[0], env.profileBlock, 'profile avatar/name remains first');
  assert.equal(env.footerRow.children[1], badge, 'quota badge sits right next to profile avatar');
  assert.equal(env.footerRow.children[2], env.gearBtn, 'settings gear remains at the right end');

  assert.equal(env.document.getElementById('gxu-mini-5h-val').textContent, '45%');
  assert.equal(env.document.getElementById('gxu-mini-wk-val').textContent, '9%');

  const authHeaders = calls.filter((c) => c.url.includes('executeQuery')).map((c) => c.headers['X-Goog-AuthUser']);
  assert.ok(authHeaders.every((h) => h === '1'), 'sends X-Goog-AuthUser: 1 for /u/1/ multi-account');

  env.document.getElementById('gxu-mode-btn').dispatch('click');
  assert.equal(env.document.getElementById('gxu-mini-5h-val').textContent, '55%');
  assert.equal(env.document.getElementById('gxu-mini-wk-val').textContent, '91%');
});

test('renders Codex Desktop-style timeline ticks, hover preview card, jump-to-turn, and bookmarks', () => {
  const env = createMiniDOM({
    href: 'https://gemini.google.com/u/1/app/2bbfca266bd7c135',
    turns: [
      {
        id: 'q1',
        top: 120,
        lines: [
          '然后帮我给 www bucket 添加 https://github.com/Ray-lea/Argus 并安装',
          '使用 agent-reach 的 GitHub 开发通道读取仓库和发布信息',
        ],
      },
      {
        id: 'q2',
        top: 520,
        lines: ['继续配置 Executor 并写入油猴脚本'],
      },
    ],
  });

  const rail = env.document.getElementById('gxu-timeline-rail');
  assert.ok(rail, 'timeline rail exists');
  assert.equal(rail.getAttribute('data-hidden'), 'false');
  assert.equal(rail.children.length, 2, 'renders one tick per user turn');
  assert.equal(rail.children[0].getAttribute('data-active'), 'true', 'highlights turn in viewport');

  rail.children[0].dispatch('mouseenter');
  const card = env.document.getElementById('gxu-timeline-card');
  assert.equal(card.getAttribute('data-open'), 'true');
  assert.match(env.document.getElementById('gxu-tc-title').textContent, /Ray-lea\/Argus/);
  assert.match(env.document.getElementById('gxu-tc-body').textContent, /agent-reach/);

  env.document.getElementById('gxu-tc-bookmark').dispatch('click');
  assert.equal(rail.children[0].getAttribute('data-bookmarked'), 'true');

  rail.children[1].dispatch('click');
  assert.equal(env.scroller.children[1]._scrolled, true);
  assert.equal(rail.children[1].getAttribute('data-active'), 'true');
});
