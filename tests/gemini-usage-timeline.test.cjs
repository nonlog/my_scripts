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
  sidenavZeroRect = true,
  gearRight = 256,
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
      this._rect = { left: 112, top: 850, right: 210, bottom: 882, width: 98, height: 32 };
      const self = this;
      this.style = {
        left: '',
        right: '',
        top: '',
        _props: new Map(),
        setProperty(k, v) { self.style._props.set(k, String(v)); },
        removeProperty(k) {
          self.style._props.delete(k);
          if (k === 'left') self.style.left = '';
          if (k === 'top') self.style.top = '';
        },
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

    remove() {
      if (this.parentElement) this.parentElement.removeChild(this);
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
        if (s === '.gxu-timeline-item[data-hovered="true"]') {
          return this.classList.contains('gxu-timeline-item') && this.getAttribute('data-hovered') === 'true';
        }
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
  sidenav._rect = sidenavZeroRect
    ? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
    : { left: 0, top: 0, right: 268, bottom: 900, width: 268, height: 900 };

  const footerRow = new MiniElement('div');
  footerRow.className = 'sidenav-footer-row';
  footerRow._display = 'flex';

  const profileBlock = new MiniElement('div');
  profileBlock.className = 'user-profile-block';
  profileBlock.textContent = 'log Ultra';
  profileBlock._rect = { left: 12, top: 848, right: 94, bottom: 888, width: 82, height: 40 };

  const gearBtn = new MiniElement('button');
  gearBtn.setAttribute('aria-label', 'Settings and help');
  gearBtn._rect = { left: gearRight - 32, top: 850, right: gearRight, bottom: 882, width: 32, height: 32 };

  footerRow.appendChild(profileBlock);
  footerRow.appendChild(gearBtn);
  sidenav.appendChild(footerRow);
  themeHost.appendChild(sidenav);

  const scroller = new MiniElement('div');
  scroller.id = 'chat-history';
  scroller._rect = { left: 276, top: 0, right: 1440, bottom: 900, width: 1164, height: 900 };

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
      if (!listeners.has(type)) listeners.set(type).push(fn);
    },
  };
  document.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
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

test('v1.1.0 uses English UI labels, matches metadata, and avoids innerHTML', () => {
  assert.match(scriptSource, /@version\s+1\.1\.0/);
  assert.match(metaSource, /@version\s+1\.1\.0/);
  assert.doesNotMatch(scriptSource, /\.innerHTML\s*=/);
  assert.doesNotMatch(scriptSource, /Gemini 用量限额|5 小时限额|周限额|后重置/, 'UI labels must be English');
  assert.match(scriptSource, /Usage limits/);
  assert.match(scriptSource, /5-hour limit/);
  assert.match(scriptSource, /Weekly limit/);
});

test('mounts inline between avatar and gear even when <bard-sidenav> host rect is 0x0, and hides when sidebar is collapsed', async () => {
  const env = createMiniDOM({
    sidenavZeroRect: true,
    gearRight: 256,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => `)]}'\n` + JSON.stringify([
        {
          data: {
            viewer: {
              rpcs: {
                getUsageInfo: {
                  subscriptionTier: 'TIER_ULTRA',
                  pools: [
                    { poolType: 'GXU_FIVE_HOURLY', percentageUsed: 0.02, gxu: { windowRefreshesAt: '2026-11-12T12:00:00Z' } },
                    { poolType: 'GXU_WEEKLY', percentageUsed: 0.03, gxu: { windowRefreshesAt: '2026-11-18T00:00:00Z' } },
                  ],
                },
              },
            },
          },
        },
      ]),
    }),
  });

  await new Promise((r) => setTimeout(r, 25));

  const badge = env.document.getElementById('gxu-avatar-quota');
  assert.equal(badge.hasAttribute('data-hidden'), false, 'visible when gear button is in expanded sidebar');
  assert.equal(badge.parentElement, env.footerRow, 'inserted inline in footerRow despite 0x0 bard-sidenav host');
  assert.equal(env.footerRow.children[0], env.profileBlock);
  assert.equal(env.footerRow.children[1], badge);
  assert.equal(env.footerRow.children[2], env.gearBtn);
  assert.equal(env.document.getElementById('gxu-mini-5h-val').textContent, '2%');
  assert.equal(env.document.getElementById('gxu-mini-wk-val').textContent, '3%');

  env.gearBtn._rect = { left: 16, top: 850, right: 48, bottom: 882, width: 32, height: 32 };
  env.hookApi.mountQuotaWidget();
  assert.equal(badge.getAttribute('data-hidden'), 'true');
});

test('renders timeline on the RIGHT side and opens preview card to the LEFT of ticks', () => {
  const env = createMiniDOM({
    turns: [
      { id: 'q1', top: 120, lines: ['First user prompt', 'Additional context line'] },
      { id: 'q2', top: 520, lines: ['Second user prompt'] },
    ],
  });

  const rail = env.document.getElementById('gxu-timeline-rail');
  assert.equal(rail.getAttribute('data-hidden'), 'false');
  assert.equal(rail.style.right, '16px', 'anchored to the right edge of chat scroller');
  assert.equal(rail.style.left, 'auto', 'never placed on the left conversation list');

  rail.children[0]._rect = { left: 1396, top: 440, right: 1424, bottom: 453, width: 28, height: 13 };
  rail.children[0].dispatch('mouseenter');

  const card = env.document.getElementById('gxu-timeline-card');
  assert.equal(card.getAttribute('data-open'), 'true');
  const cardLeft = parseInt(card.style.left, 10);
  assert.ok(cardLeft < 1396 - 200, `card opens to the left of right-side rail (got left=${cardLeft})`);
});
