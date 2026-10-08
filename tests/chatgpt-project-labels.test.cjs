'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const repository = path.join(__dirname, '..');
const labelSource = readFileSync(path.join(repository, 'chatgpt-project-labels.user.js'), 'utf8');
const compressionSource = readFileSync(path.join(repository, 'chatgpt-recent-turns.user.js'), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function fakeLink(href) {
  const attrs = new Map([['href', href]]);
  return {
    nodeType: 1,
    children: [],
    getAttribute: name => attrs.get(name) ?? null,
    hasAttribute: name => attrs.has(name),
    setAttribute: (name, value) => attrs.set(name, String(value)),
    removeAttribute: name => attrs.delete(name),
    matches: selector => selector.includes('a[') && href.includes('/c/'),
    querySelector: () => null,
  };
}

function fakeProject(id, name) {
  const attrs = new Map([
    ['data-app-action-sidebar-project-id', id],
    ['data-app-action-sidebar-project-label', name],
  ]);
  return {
    nodeType: 1,
    getAttribute: key => attrs.get(key) ?? null,
    setAttribute: (key, value) => attrs.set(key, value),
    matches: selector => selector.includes('data-app-action-sidebar-project-id'),
    querySelector: () => null,
  };
}

function fakeRecent(link) {
  return {
    nodeType: 1,
    link,
    querySelector(selector) { return selector.includes('a[') ? this.link : null; },
    closest: selector => selector.includes('data-sidebar-chatgpt-conversation-key') ? true : null,
    matches: selector => selector.includes('data-sidebar-chatgpt-conversation-key'),
  };
}

function setup({ projectRows = [], recentRows = [], projectLinks = [] }) {
  const observers = [];
  const state = { sidebar: null, style: null };

  state.sidebar = {
    nodeType: 1,
    id: 'app-shell-sidebar',
    isConnected: true,
    projectRows,
    recentRows,
    projectLinks,
    querySelectorAll(selector) {
      if (selector === '[data-app-action-sidebar-project-id]') return this.projectRows;
      if (selector === '[data-sidebar-chatgpt-conversation-key]') return this.recentRows;
      if (selector === 'a[href*="/c/"]') return [
        ...this.recentRows.map(row => row.link),
        ...this.projectLinks,
      ];
      throw Error('Unexpected selector: ' + selector);
    },
  };

  class FakeObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(root) { this.target = root; }
    disconnect() { this.disconnected = true; }
  }

  const document = {
    readyState: 'complete',
    hidden: false,
    documentElement: { nodeType: 1 },
    head: { appendChild(element) { state.style = element; } },
    getElementById(id) { return state.style?.id === id ? state.style : null; },
    createElement(tag) {
      assert.equal(tag, 'style');
      return { id: '', textContent: '' };
    },
    querySelector(selector) {
      if (selector === '#app-shell-sidebar') return state.sidebar;
      if (selector.startsWith('nav[aria-label=')) return null;
      throw Error('Unexpected selector: ' + selector);
    },
    addEventListener() {},
  };

  const context = {
    document,
    window: { addEventListener() {} },
    location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/' },
    URL,
    Map,
    MutationObserver: FakeObserver,
    setTimeout,
  };
  vm.runInNewContext(labelSource, context, { filename: 'chatgpt-project-labels.user.js' });
  return {
    ...state,
    observers,
    sidebarObserver: () => observers.find(observer => observer.target === state.sidebar),
  };
}

test('project and regular Recents links are identified independently of compression', async () => {
  const project = 'g-p-6aaa8e6408588191bdd37b2e40e5805b';
  const c1 = fakeLink('/g/' + project + '/c/6ab62d96-836c-83ec-bbab-ad280060aa67');
  const c2 = fakeLink('/c/6ab76419-9f0c-83ec-aa11-63fca0edb9ac');
  const env = setup({
    projectRows: [fakeProject(project, 'NewAPI & CPA')],
    recentRows: [fakeRecent(c1), fakeRecent(c2)],
  });
  await sleep(15);

  assert.equal(c1.getAttribute('data-cgpt-project-name'), 'NewAPI & CPA');
  assert.equal(c2.hasAttribute('data-cgpt-project-name'), false);
  assert.equal(c1.children.length, 0, 'does not insert a React child');
  assert.match(env.style.textContent, /::after/);
  assert.match(env.style.textContent, /flex:0 0 auto/);
  assert.match(env.style.textContent, /cgpt-sidebar-project-label\{display:none!important\}/);
});

test('supports project slug and matching alternate project links', async () => {
  const project = 'g-p-6a79392d318c8191a0adbf8cc8351f32';
  const id = '6ac1f2fa-03fc-83ec-a296-b1331f1502db';
  const plain = fakeLink('/c/' + id);
  setup({
    projectRows: [fakeProject(project, 'VPS Management')],
    recentRows: [fakeRecent(plain)],
    projectLinks: [fakeLink('/g/' + project + '-vps-management/c/' + id)],
  });
  await sleep(15);
  assert.equal(plain.getAttribute('data-cgpt-project-name'), 'VPS Management');
});

test('restores labels after a React-style replacement and tracks project rename', async () => {
  const project = 'g-p-6a8852bae3888191a2b686dc01aa5e27';
  const href = '/g/' + project + '/c/6aa50f19-7c78-83ec-ac21-1f60982488d4';
  const p = fakeProject(project, 'Windows Management');
  const recent = fakeRecent(fakeLink(href));
  const env = setup({ projectRows: [p], recentRows: [recent] });
  await sleep(15);
  const replacement = fakeLink(href);
  recent.link = replacement;
  env.sidebarObserver().callback([{
    type: 'childList', target: recent, addedNodes: [replacement], removedNodes: [],
  }]);
  await sleep(90);
  assert.equal(replacement.getAttribute('data-cgpt-project-name'), 'Windows Management');

  p.setAttribute('data-app-action-sidebar-project-label', 'Windows Project');
  env.sidebarObserver().callback([{ type: 'attributes', target: p, attributeName: 'data-app-action-sidebar-project-label' }]);
  await sleep(90);
  assert.equal(replacement.getAttribute('data-cgpt-project-name'), 'Windows Project');
});

test('retains last observed project name during sidebar virtualization', async () => {
  const project = 'g-p-6a8852bae3888191a2b686dc01aa5e27';
  const row = fakeRecent(fakeLink('/g/' + project + '/c/6aa50f19-7c78-83ec-ac21-1f60982488d4'));
  const env = setup({ projectRows: [fakeProject(project, 'Windows Management')], recentRows: [row] });
  await sleep(15);
  env.sidebar.projectRows = [];
  const replacement = fakeLink(row.link.getAttribute('href'));
  row.link = replacement;
  env.sidebarObserver().callback([{ type: 'childList', target: row, addedNodes: [replacement], removedNodes: [] }]);
  await sleep(90);
  assert.equal(replacement.getAttribute('data-cgpt-project-name'), 'Windows Management');
});

test('release separation: compression source has no project label logic', () => {
  assert.match(compressionSource, /@version\s+0\.8\.7/);
  assert.doesNotMatch(compressionSource, /bindSidebarLabels|PROJECT_LABEL_CLASS|cgpt-sidebar-project-label|projectNameCache/);
  assert.match(labelSource, /@name\s+ChatGPT Project Labels/);
  assert.doesNotMatch(labelSource, /turboOriginalFetch|TURBO_SERVER_TURNS|TOOL_COMPAC/);
});
