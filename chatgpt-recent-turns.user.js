// ==UserScript==
// @name         ChatGPT Recent Messages
// @namespace    https://github.com/nonlog/my_scripts
// @version      0.7.0
// @description  Reduce long-chat rendering, tool-call layout, and client-state overhead in ChatGPT Web.
// @homepageURL  https://github.com/nonlog/my_scripts
// @supportURL   https://github.com/nonlog/my_scripts/issues
// @updateURL    https://raw.githubusercontent.com/nonlog/my_scripts/master/chatgpt-recent-turns.meta.js
// @downloadURL  https://raw.githubusercontent.com/nonlog/my_scripts/master/chatgpt-recent-turns.user.js
// @match        https://chatgpt.com/*
// @run-at       document-start
// @early-start
// @inject-into  page
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.7.0';
  const INITIAL_MESSAGES = 5;
  const LOAD_STEP = 5;
  const TOP_THRESHOLD_PX = 220;
  const PANEL_AUTO_COLLAPSE_MS = 4000;
  const PANEL_EDGE_PEEK_MS = 700;
  const PANEL_SNAP_PX = 48;

  const TURBO_KEY = 'cgpt-recent-messages-turbo-v1';
  const TURBO_MAX_TURNS = 3;
  const TURBO_MAX_NODES = 450;
  const TURBO_MAX_CHARS = 700000;
  const TURBO_MIN_RESPONSE = 1000000;
  const DEEP_TRIGGER_NODES = 260;
  const DEEP_TRIGGER_CHARS = 500000;
  const DEEP_TAIL_NODES = 120;

  const TOOL_KEY = 'cgpt-recent-messages-tool-compact-v1';
  const TOOL_SELECTOR = 'span.group\\/tool-message';
  const TOOL_HIDDEN = 'data-cgpt-tool-compacted';
  const TOOL_BUNDLE = 'cgpt-tool-bundle';
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const SCROLL_SELECTOR = '[class~="group/scroll-root"]';
  const HIDDEN = 'data-cgpt-recent-hidden';
  const PANEL_ID = 'cgpt-recent-messages-panel';
  const STYLE_ID = 'cgpt-recent-messages-style';
  const PANEL_POSITION_KEY = 'cgpt-recent-messages-panel-position-v1';

  const isZh = /^zh\b/i.test(navigator.languages?.[0] || navigator.language || '');
  const t = isZh ? {
    older: `加载前 ${LOAD_STEP} 条消息`, all: '显示全部已加载消息', recent: `只显示最近 ${INITIAL_MESSAGES} 条消息`,
    reset: `重置为最近 ${INITIAL_MESSAGES} 条消息`, turboOn: 'Turbo 已开启；点击关闭并重新加载完整历史',
    turboOff: 'Turbo 已关闭；点击开启并重新加载', toolsOn: 'Tool Compactor 已开启；点击关闭',
    toolsOff: 'Tool Compactor 已关闭；点击开启', open: '展开工具栏', close: '折叠工具栏', drag: '拖动工具栏',
    bundle: (n, x) => x ? `${n} 个 tool calls · 收起` : `${n} 个 tool calls`, status: (v, n) => `${v}/${n}`,
  } : {
    older: `Load ${LOAD_STEP} older messages`, all: 'Show all currently loaded messages', recent: `Show only the latest ${INITIAL_MESSAGES} messages`,
    reset: `Reset to the latest ${INITIAL_MESSAGES} messages`, turboOn: 'Turbo is ON; click to disable and reload full history',
    turboOff: 'Turbo is OFF; click to enable and reload', toolsOn: 'Tool Compactor is ON; click to disable',
    toolsOff: 'Tool Compactor is OFF; click to enable', open: 'Open toolbar', close: 'Collapse toolbar', drag: 'Drag toolbar',
    bundle: (n, x) => x ? `${n} tool calls · collapse` : `${n} tool calls`, status: (v, n) => `${v}/${n}`,
  };

  let visibleCount = INITIAL_MESSAGES, showAll = false, updateTimer = null, collapseTimer = null, peekTimer = null;
  let scrollRoot = null, listRoot = null, listObserver = null, discoveryObserver = null, topLoadArmed = true;
  let lastUrl = location.href, toolUiTimer = null, dragState = null;
  const toolObservers = new Map(), toolTimers = new Map();

  const turboEnabled = () => localStorage.getItem(TURBO_KEY) !== '0';
  const toolEnabled = () => localStorage.getItem(TOOL_KEY) !== '0';
  const setTurbo = value => localStorage.setItem(TURBO_KEY, value ? '1' : '0');
  const setTools = value => localStorage.setItem(TOOL_KEY, value ? '1' : '0');

  function isConversationFetch(input, init) {
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    if (method !== 'GET') return false;
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url || '';
    try { return /^\/backend-api\/conversation\/[0-9a-f-]+$/i.test(new URL(raw, location.origin).pathname); }
    catch { return false; }
  }

  function trimConversation(data) {
    const mapping = data?.mapping, current = data?.current_node;
    if (!mapping || !current) return null;
    const path = [], seen = new Set();
    for (let id = current; id && mapping[id] && !seen.has(id); id = mapping[id].parent) { seen.add(id); path.push(id); }
    path.reverse();
    if (path.length < 2) return null;

    const users = [];
    path.forEach((id, i) => { if (mapping[id]?.message?.author?.role === 'user') users.push(i); });
    if (!users.length) return null;
    const segments = users.map((start, i) => {
      const end = i + 1 < users.length ? users[i + 1] : path.length;
      let chars = 0;
      for (let j = start; j < end; j++) { const m = mapping[path[j]]?.message; if (m) chars += JSON.stringify(m).length; }
      return { start, end, nodes: end - start, chars };
    });

    const latest = segments.at(-1);
    const deep = latest.nodes > DEEP_TRIGGER_NODES || latest.chars > DEEP_TRIGGER_CHARS;
    let first = segments.length - 1, turns = 1, nodes = latest.nodes, chars = latest.chars;
    if (!deep) {
      while (first > 0 && turns < TURBO_MAX_TURNS) {
        const c = segments[first - 1];
        if (nodes + c.nodes > TURBO_MAX_NODES || chars + c.chars > TURBO_MAX_CHARS) break;
        first--; turns++; nodes += c.nodes; chars += c.chars;
      }
      if (turns === users.length && users.length <= TURBO_MAX_TURNS) return null;
    }

    const root = path[0];
    let keep = path.slice(segments[first].start), deepOriginal = 0, deepRetained = 0;
    if (deep) {
      deepOriginal = keep.length;
      const userId = keep[0], tail = keep.slice(Math.max(1, keep.length - DEEP_TAIL_NODES));
      keep = [userId, ...tail.filter(id => id !== userId)];
      deepRetained = keep.length;
      chars = keep.reduce((sum, id) => { const m = mapping[id]?.message; return sum + (m ? JSON.stringify(m).length : 0); }, 0);
    }
    if (!root || !mapping[root] || !keep.length) return null;
    const ids = (keep[0] === root ? keep : [root, ...keep]).filter(id => mapping[id]);
    const trimmed = {};
    ids.forEach((id, i) => trimmed[id] = { ...mapping[id], parent: i ? ids[i - 1] : null, children: i + 1 < ids.length ? [ids[i + 1]] : [] });
    data.mapping = trimmed;
    return { originalNodes: Object.keys(mapping).length, retainedNodes: ids.length, userTurns: turns, retainedMessageChars: chars,
      adaptive: true, deep, deepOriginalTurnNodes: deepOriginal, deepRetainedTurnNodes: deepRetained,
      deepDroppedNodes: deep ? deepOriginal - deepRetained : 0 };
  }

  function installTurboFetch() {
    if (!turboEnabled() || window.fetch?.__cgptRecentMessagesTurbo) return;
    const original = window.fetch.bind(window);
    const wrapped = async (...args) => {
      const target = isConversationFetch(args[0], args[1]);
      if (target) window.__cgptRecentMessagesTrimStats = null;
      const response = await original(...args);
      if (!target || !response.ok) return response;
      try {
        const text = await response.clone().text();
        if (text.length < TURBO_MIN_RESPONSE) return response;
        const data = JSON.parse(text), stats = trimConversation(data);
        if (!stats) return response;
        const body = JSON.stringify(data), headers = new Headers(response.headers);
        headers.delete('content-length'); headers.delete('content-encoding');
        window.__cgptRecentMessagesTrimStats = { ...stats, beforeChars: text.length, afterChars: body.length, version: VERSION };
        return new Response(body, { status: response.status, statusText: response.statusText, headers });
      } catch (error) { console.debug('[ChatGPT Recent Messages] Turbo trim skipped:', error); return response; }
    };
    Object.defineProperty(wrapped, '__cgptRecentMessagesTurbo', { value: true });
    window.fetch = wrapped;
  }
  installTurboFetch();

  const icons = {
    older: '<svg viewBox="0 0 24 24"><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg>',
    all: '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    recent: '<svg viewBox="0 0 24 24"><path d="M4 8h16M7 12h10M10 16h4"/></svg>',
    reset: '<svg viewBox="0 0 24 24"><path d="M4 4v6h6"/><path d="M5.5 15a7 7 0 1 0 .8-7.8L4 10"/></svg>',
    turbo: '<svg viewBox="0 0 24 24"><path d="M13 2 5 13h6l-1 9 8-12h-6l1-8Z"/></svg>',
    tools: '<svg viewBox="0 0 24 24"><path d="M4 7h4M16 7h4M8 4v6M4 17h7M15 17h5M15 14v6"/></svg>',
    panel: '<svg viewBox="0 0 24 24"><path d="M5 7h14M5 12h14M5 17h14"/></svg>',
    collapse: '<svg viewBox="0 0 24 24"><path d="M5 5h14v14H5z"/><path d="m14 9-3 3 3 3"/></svg>',
    grip: '<svg viewBox="0 0 24 24"><circle cx="9" cy="7" r="1"/><circle cx="15" cy="7" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="17" r="1"/><circle cx="15" cy="17" r="1"/></svg>',
  };

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style'); s.id = STYLE_ID; s.textContent = `
      [${HIDDEN}="true"],[${TOOL_HIDDEN}="true"]{display:none!important}
      .${TOOL_BUNDLE}{display:inline-flex;align-items:center;gap:6px;width:max-content;padding:5px 9px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:9px;background:transparent;color:var(--text-secondary,currentColor);cursor:pointer;font:inherit;font-size:.875em;opacity:.82}
      .${TOOL_BUNDLE}:hover{opacity:1}.cgpt-tool-bundle-chevron{transition:transform .12s ease}.${TOOL_BUNDLE}[data-expanded="true"] .cgpt-tool-bundle-chevron{transform:rotate(180deg)}
      #${PANEL_ID}{position:fixed;right:14px;bottom:88px;z-index:2147483647;display:flex;flex-direction:column;align-items:center;gap:6px;padding:6px;border:1px solid color-mix(in srgb,CanvasText 16%,transparent);border-radius:12px;background:color-mix(in srgb,Canvas 94%,transparent);color:CanvasText;box-shadow:0 4px 18px rgba(0,0,0,.14);backdrop-filter:blur(10px);font:11px/1.2 system-ui,sans-serif;transition:transform .16s ease;touch-action:none}
      #${PANEL_ID} .cgpt-rm-grip{display:grid;place-items:center;width:30px;height:16px;opacity:.45;cursor:grab;touch-action:none}#${PANEL_ID} .cgpt-rm-grip:active{cursor:grabbing}#${PANEL_ID} .cgpt-rm-grip svg{width:16px;height:16px}#${PANEL_ID} .cgpt-rm-status{min-width:30px;padding:2px 3px;text-align:center;opacity:.68;white-space:nowrap}#${PANEL_ID} button{position:relative;display:grid;place-items:center;width:32px;height:32px;padding:0;border:1px solid color-mix(in srgb,CanvasText 16%,transparent);border-radius:9px;background:Canvas;color:CanvasText;cursor:pointer}#${PANEL_ID} button[data-active="true"]{box-shadow:inset 0 0 0 1px currentColor}#${PANEL_ID} svg,.${TOOL_BUNDLE} svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
      #${PANEL_ID}[data-collapsed="true"]{gap:0;padding:4px;border-radius:999px}#${PANEL_ID}[data-collapsed="true"]>:not([data-action="panel"]){display:none!important}#${PANEL_ID}[data-collapsed="true"] [data-action="panel"]{display:grid;width:34px;height:34px;border-radius:999px}#${PANEL_ID}[data-dragging="true"]{transition:none!important;transform:none!important}#${PANEL_ID}[data-edge="left"][data-peek="true"]{transform:translateX(-55%)}#${PANEL_ID}[data-edge="right"][data-peek="true"]{transform:translateX(55%)}
      #${PANEL_ID} button::after{content:attr(data-tooltip);position:absolute;right:calc(100% + 9px);top:50%;transform:translateY(-50%) translateX(4px);padding:6px 8px;border-radius:7px;background:#111;color:#fff;font:12px/1.2 system-ui,sans-serif;white-space:nowrap;opacity:0;visibility:hidden;pointer-events:none}#${PANEL_ID} button:hover::after,#${PANEL_ID} button:focus-visible::after{opacity:1;visibility:visible;transform:translateY(-50%)}#${PANEL_ID}[data-edge="left"] button::after{left:calc(100% + 9px);right:auto;transform:translateY(-50%) translateX(-4px)}#${PANEL_ID}[data-edge="left"] button:hover::after,#${PANEL_ID}[data-edge="left"] button:focus-visible::after{transform:translateY(-50%) translateX(0)}
    `; (document.head || document.documentElement).appendChild(s);
  }

  const messages = () => [...document.querySelectorAll(TURN_SELECTOR)];
  function hidden(node, attr, value) { const old = node.getAttribute(attr) === 'true'; if (old === value) return; value ? node.setAttribute(attr, 'true') : node.removeAttribute(attr); }
  function spacer(node) { return node?.nodeType === 1 && node.tagName === 'DIV' && node.classList.contains('empty:hidden') && !(node.textContent || '').trim(); }

  function restoreTools(container) { container.querySelectorAll(`:scope>.${TOOL_BUNDLE}`).forEach(x => x.remove()); container.querySelectorAll(`:scope>${TOOL_SELECTOR}`).forEach(x => hidden(x, TOOL_HIDDEN, false)); }
  function setBundle(button, tools, expanded) { button.__members = tools; button.dataset.expanded = String(expanded); const label = t.bundle(tools.length, expanded); button.setAttribute('aria-label', label); button.querySelector('span').textContent = label; tools.forEach(x => hidden(x, TOOL_HIDDEN, !expanded)); }
  function makeBundle(container, anchor) { const b = document.createElement('button'); b.type='button'; b.className=TOOL_BUNDLE; b.__anchor=anchor; b.innerHTML=`${icons.tools}<span></span><svg class="cgpt-tool-bundle-chevron" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg>`; b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); const list=(b.__members||[]).filter(x=>x.isConnected&&x.parentElement===container); setBundle(b,list,b.dataset.expanded!=='true'); }); return b; }
  function compact(container) {
    if (!container?.isConnected) return; const observer=toolObservers.get(container); observer?.disconnect();
    try { if (!toolEnabled()) return restoreTools(container); const existing=[...container.querySelectorAll(`:scope>.${TOOL_BUNDLE}`)], byAnchor=new Map(existing.map(x=>[x.__anchor,x])), claimed=new Set(); let group=[];
      const flush=()=>{ if(!group.length)return; if(group.length<2){group.forEach(x=>hidden(x,TOOL_HIDDEN,false));group=[];return} const anchor=group[0]; let b=byAnchor.get(anchor); if(!b){b=makeBundle(container,anchor);container.insertBefore(b,anchor)} claimed.add(b);setBundle(b,group,b.dataset.expanded==='true');group=[] };
      [...container.children].forEach(child=>{ if(child.classList?.contains(TOOL_BUNDLE))return; if(child.matches?.(TOOL_SELECTOR)){group.push(child);return} if(group.length&&spacer(child))return;flush() }); flush(); existing.forEach(x=>{if(!claimed.has(x))x.remove()});
    } finally { if(observer&&container.isConnected) observer.observe(container,{childList:true}); }
  }
  function toolContainers(list){const set=new Set();list.forEach(m=>m.querySelectorAll('[class~="agent-turn"] div.flex.flex-col.grow').forEach(x=>set.add(x)));return set}
  function syncTools(list){const set=toolContainers(list);if(!toolEnabled()){stopTools();set.forEach(restoreTools);return}for(const [c,o] of toolObservers){if(c.isConnected&&set.has(c))continue;o.disconnect();toolObservers.delete(c)}for(const c of set){if(!toolObservers.has(c)){const o=new MutationObserver(()=>{clearTimeout(toolTimers.get(c));toolTimers.set(c,setTimeout(()=>{compact(c);updatePanel(messages().length)},180))});o.observe(c,{childList:true});toolObservers.set(c,o)}compact(c)}}
  function stopTools(){toolObservers.forEach(o=>o.disconnect());toolObservers.clear();toolTimers.forEach(clearTimeout);toolTimers.clear();clearTimeout(toolUiTimer)}

  function findRoot(list){if(!list.length)return null;let r=list[0].parentElement;while(r&&!list.every(x=>r.contains(x)))r=r.parentElement;return r}
  function bindList(list){const next=findRoot(list);if(!next||(next===listRoot&&listObserver))return;listObserver?.disconnect();discoveryObserver?.disconnect();listRoot=next;listObserver=new MutationObserver(()=>scheduleUpdate(40));listObserver.observe(next,{childList:true})}
  function discover(){if(!document.body||listObserver)return;discoveryObserver?.disconnect();discoveryObserver=new MutationObserver(rs=>{if(rs.some(r=>[...r.addedNodes].some(n=>n?.nodeType===1&&(n.matches?.(TURN_SELECTOR)||n.querySelector?.(TURN_SELECTOR))))){discoveryObserver.disconnect();scheduleUpdate(0)}});discoveryObserver.observe(document.body,{childList:true,subtree:true})}
  function setScroll(next){if(next===scrollRoot)return;scrollRoot?.removeEventListener('scroll',onScroll);scrollRoot=next;scrollRoot?.addEventListener('scroll',onScroll,{passive:true})}
  function apply(){const list=messages();if(!list.length){removePanel();listObserver?.disconnect();listObserver=null;stopTools();discover();return}const first=showAll?0:Math.max(0,list.length-visibleCount);list.forEach((x,i)=>hidden(x,HIDDEN,i<first));syncTools(list);ensurePanel();updatePanel(list.length);setScroll(document.querySelector(SCROLL_SELECTOR)||document.scrollingElement);bindList(list)}
  function revealOlder(){const list=messages();if(!list.length||showAll)return;const first=Math.max(0,list.length-visibleCount);if(!first)return;visibleCount=Math.min(list.length,visibleCount+LOAD_STEP);apply()}
  function onScroll(){if(!scrollRoot||showAll)return;const top=scrollRoot.scrollTop;if(top>TOP_THRESHOLD_PX*2){topLoadArmed=true;return}if(topLoadArmed&&top<=TOP_THRESHOLD_PX){topLoadArmed=false;apply();revealOlder()}}

  function clearCollapse(){clearTimeout(collapseTimer);collapseTimer=null}
  function clearPeek(){clearTimeout(peekTimer);peekTimer=null}
  function label(b,text){if(!b)return;b.dataset.tooltip=text;b.setAttribute('aria-label',text)}
  function setPeek(value){const p=document.getElementById(PANEL_ID);if(!p)return;clearPeek();p.dataset.peek=String(Boolean(value&&p.dataset.edge))}
  function schedulePeek(delay=PANEL_EDGE_PEEK_MS){clearPeek();const p=document.getElementById(PANEL_ID);if(!p||!p.dataset.edge||p.dataset.dragging==='true')return;peekTimer=setTimeout(()=>{peekTimer=null;if(!p.isConnected||p.dataset.dragging==='true')return;if(p.matches(':hover')||p.contains(document.activeElement))return schedulePeek();p.dataset.peek='true'},delay)}
  function scheduleCollapse(){clearCollapse();const p=document.getElementById(PANEL_ID);if(!p||p.dataset.collapsed==='true')return;collapseTimer=setTimeout(()=>{collapseTimer=null;if(!p.isConnected)return;if(p.contains(document.activeElement))return scheduleCollapse();collapse(true)},PANEL_AUTO_COLLAPSE_MS)}
  function syncPanelToggle(p){const b=p?.querySelector('[data-action="panel"]');if(!b)return;const isCollapsed=p.dataset.collapsed==='true';b.innerHTML=isCollapsed?icons.panel:icons.collapse;label(b,isCollapsed?t.open:t.close)}
  function readPanelPosition(){try{const v=JSON.parse(localStorage.getItem(PANEL_POSITION_KEY)||'null');return v&&Number.isFinite(v.x)&&Number.isFinite(v.y)?v:null}catch{return null}}
  function savePanelPosition(p){const x=Number.parseFloat(p.style.left),y=Number.parseFloat(p.style.top);if(!Number.isFinite(x)||!Number.isFinite(y))return;localStorage.setItem(PANEL_POSITION_KEY,JSON.stringify({x,y,edge:p.dataset.edge||''}))}
  function clampPanel(p,persist=false){if(!p?.isConnected)return;setPeek(false);const w=p.offsetWidth,h=p.offsetHeight,r=p.getBoundingClientRect();let x=Number.parseFloat(p.style.left),y=Number.parseFloat(p.style.top);if(!Number.isFinite(x))x=r.left;if(!Number.isFinite(y))y=r.top;const maxX=Math.max(0,innerWidth-w),maxY=Math.max(0,innerHeight-h),edge=p.dataset.edge||'';x=edge==='left'?0:edge==='right'?maxX:Math.min(Math.max(4,x),Math.max(4,maxX-4));y=Math.min(Math.max(4,y),Math.max(4,maxY-4));p.style.left=`${Math.round(x)}px`;p.style.top=`${Math.round(y)}px`;p.style.right='auto';p.style.bottom='auto';if(persist)savePanelPosition(p)}
  function restorePanelPosition(p){const pos=readPanelPosition();if(!pos)return;p.dataset.edge=pos.edge==='left'||pos.edge==='right'?pos.edge:'';p.style.left=`${pos.x}px`;p.style.top=`${pos.y}px`;p.style.right='auto';p.style.bottom='auto';requestAnimationFrame(()=>{clampPanel(p,false);if(p.dataset.edge)schedulePeek()})}
  function collapse(value){const p=document.getElementById(PANEL_ID);if(!p)return;clearCollapse();setPeek(false);p.dataset.collapsed=String(value);syncPanelToggle(p);requestAnimationFrame(()=>{clampPanel(p,false);if(p.dataset.edge)schedulePeek()});if(!value)scheduleCollapse()}
  function startPanelDrag(p,e){if(e.button!==0||!e.target.closest('.cgpt-rm-grip'))return;e.preventDefault();clearCollapse();clearPeek();setPeek(false);const r=p.getBoundingClientRect();p.dataset.dragging='true';p.dataset.edge='';p.style.left=`${r.left}px`;p.style.top=`${r.top}px`;p.style.right='auto';p.style.bottom='auto';dragState={pointerId:e.pointerId,startX:e.clientX,startY:e.clientY,left:r.left,top:r.top};try{p.setPointerCapture(e.pointerId)}catch{}}
  function movePanelDrag(p,e){if(!dragState||e.pointerId!==dragState.pointerId)return;const x=Math.min(Math.max(0,dragState.left+e.clientX-dragState.startX),Math.max(0,innerWidth-p.offsetWidth));const y=Math.min(Math.max(0,dragState.top+e.clientY-dragState.startY),Math.max(0,innerHeight-p.offsetHeight));p.style.left=`${Math.round(x)}px`;p.style.top=`${Math.round(y)}px`}
  function endPanelDrag(p,e){if(!dragState||e.pointerId!==dragState.pointerId)return;try{p.releasePointerCapture(e.pointerId)}catch{}p.dataset.dragging='false';const x=Number.parseFloat(p.style.left)||0,w=p.offsetWidth;const rightGap=innerWidth-(x+w);p.dataset.edge=x<=PANEL_SNAP_PX?'left':rightGap<=PANEL_SNAP_PX?'right':'';dragState=null;clampPanel(p,true);scheduleCollapse();if(p.dataset.edge)schedulePeek()}
  function ensurePanel(){if(document.getElementById(PANEL_ID)||!document.body)return;const p=document.createElement('div');p.id=PANEL_ID;p.dataset.collapsed='false';p.dataset.peek='false';p.dataset.edge='';p.dataset.dragging='false';p.innerHTML=`<span class="cgpt-rm-grip" title="${t.drag}" aria-label="${t.drag}">${icons.grip}</span><span class="cgpt-rm-status"></span><button data-action="older">${icons.older}</button><button data-action="toggle">${icons.all}</button><button data-action="reset">${icons.reset}</button><button data-action="turbo">${icons.turbo}</button><button data-action="tools">${icons.tools}</button><button data-action="panel">${icons.collapse}</button>`;p.addEventListener('click',e=>{const b=e.target.closest('button'),a=b?.dataset.action;if(a==='panel'){b.blur();return collapse(p.dataset.collapsed!=='true')}if(a==='older')revealOlder();else if(a==='toggle'){showAll=!showAll;if(!showAll)visibleCount=INITIAL_MESSAGES;apply()}else if(a==='reset'){showAll=false;visibleCount=INITIAL_MESSAGES;apply()}else if(a==='turbo'){setTurbo(!turboEnabled());location.reload();return}else if(a==='tools'){setTools(!toolEnabled());syncTools(messages());updatePanel(messages().length)}b?.blur();scheduleCollapse()});p.addEventListener('pointerdown',e=>startPanelDrag(p,e));p.addEventListener('pointermove',e=>{if(dragState)movePanelDrag(p,e);else{setPeek(false);scheduleCollapse()}});p.addEventListener('pointerup',e=>endPanelDrag(p,e));p.addEventListener('pointercancel',e=>endPanelDrag(p,e));p.addEventListener('pointerenter',()=>{setPeek(false);scheduleCollapse()});p.addEventListener('pointerleave',()=>{scheduleCollapse();schedulePeek()});p.addEventListener('focusin',()=>{setPeek(false);scheduleCollapse()});p.addEventListener('focusout',()=>{scheduleCollapse();schedulePeek()});p.addEventListener('keydown',scheduleCollapse);document.body.appendChild(p);restorePanelPosition(p);syncPanelToggle(p);scheduleCollapse()}
  function updatePanel(total){const p=document.getElementById(PANEL_ID);if(!p)return;syncPanelToggle(p);const visible=showAll?total:Math.min(total,visibleCount);p.querySelector('.cgpt-rm-status').textContent=t.status(visible,total);const old=p.querySelector('[data-action="older"]');old.disabled=showAll||visible>=total;label(old,t.older);const toggle=p.querySelector('[data-action="toggle"]');label(toggle,showAll?t.recent:t.all);toggle.innerHTML=showAll?icons.recent:icons.all;label(p.querySelector('[data-action="reset"]'),t.reset);const turbo=p.querySelector('[data-action="turbo"]'),enabled=turboEnabled(),stats=window.__cgptRecentMessagesTrimStats;let tl=enabled?t.turboOn:t.turboOff;if(enabled&&stats?.beforeChars&&stats?.afterChars){tl+=` (${(stats.beforeChars/1e6).toFixed(2)} MB → ${(stats.afterChars/1e6).toFixed(2)} MB) · ${stats.retainedNodes} nodes`;if(stats.deep)tl+=` · deep ${stats.deepOriginalTurnNodes}→${stats.deepRetainedTurnNodes}`}label(turbo,tl);turbo.dataset.active=String(enabled);const tools=p.querySelector('[data-action="tools"]');label(tools,toolEnabled()?t.toolsOn:t.toolsOff);tools.dataset.active=String(toolEnabled())}
  function removePanel(){clearCollapse();clearPeek();dragState=null;document.getElementById(PANEL_ID)?.remove()}
  function scheduleUpdate(delay=60){clearTimeout(updateTimer);updateTimer=setTimeout(apply,delay)}

  function routeChange(){if(location.href===lastUrl)return;lastUrl=location.href;installTurboFetch();showAll=false;visibleCount=INITIAL_MESSAGES;listObserver?.disconnect();listObserver=null;listRoot=null;stopTools();setScroll(null);discover();scheduleUpdate(0)}
  function installRoutes(){for(const method of ['pushState','replaceState']){const original=history[method];if(original.__cgptRecentMessagesWrapped)continue;const wrapped=function(...args){installTurboFetch();const result=original.apply(this,args);queueMicrotask(routeChange);return result};Object.defineProperty(wrapped,'__cgptRecentMessagesWrapped',{value:true});history[method]=wrapped}document.addEventListener('click',e=>{const a=e.target.closest?.('a[href]');if(!a)return;try{if(new URL(a.href,location.href).origin===location.origin&&/\/c\/[0-9a-f-]+$/i.test(new URL(a.href,location.href).pathname))installTurboFetch()}catch{}},true);window.addEventListener('popstate',()=>{installTurboFetch();queueMicrotask(routeChange)})}
  function init(){ensureStyle();installRoutes();installTurboFetch();window.addEventListener('resize',()=>{const p=document.getElementById(PANEL_ID);if(!p)return;setPeek(false);requestAnimationFrame(()=>{clampPanel(p,true);if(p.dataset.edge)schedulePeek()})},{passive:true});discover();scheduleUpdate(0)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
