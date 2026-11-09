// Stall web app core: API client, DOM helpers, routing, chrome. Feature screens live in
// js/views/<name>.js and register routes with route(). See docs/ARCHITECTURE.md.
// Hash routing keeps it working as an installed PWA and from any static host path.

// ---------------------------------------------------------------- state & api
const state = { user: null, csrf: null, unread: 0, config: null, events: null, installPrompt: null };

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && state.csrf) headers['X-CSRF-Token'] = state.csrf;
  let res;
  try {
    res = await fetch(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'Looks like you’re offline. Check your connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/auth/login') {
    state.user = null;
    go('/login');
  }
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  return data;
}

// ---------------------------------------------------------------- dom helpers
// replaceChildren() would stringify null/false into text nodes; drop them first.
const fill = (el, ...nodes) => el.replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));

function h(tag, attrs, ...children) {
  const el = document.createElementNS(tag === 'svg' || tag === 'path' || tag === 'circle' || tag === 'rect' || tag === 'polyline' || tag === 'line' ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml', tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.setAttribute('class', v);
    else if (k === 'style') {
      // CSP forbids style attributes; CSSOM property writes are allowed.
      for (const decl of String(v).split(';')) {
        const i = decl.indexOf(':');
        if (i > 0) el.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
      }
    }
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ICONS = {
  vote: 'M7 11l5-5 5 5M12 6v13',
  board: 'M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v6h-4z',
  mine: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5',
  account: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  bell: 'M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0',
  back: 'M15 18l-6-6 6-6',
  plus: 'M12 5v14M5 12h14',
  up: 'M6 14l6-6 6 6',
  down: 'M6 10l6 6 6-6',
  share: 'M12 3v12M8 7l4-4 4 4M5 11v8a2 2 0 002 2h10a2 2 0 002-2v-8',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v6a2 2 0 01-2 2H4a2 2 0 01-2-2v-6z',
  tonight: 'M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z',
  events: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  feed: 'M4 6h16M4 12h16M4 18h10',
  lore: 'M4 19.5A2.5 2.5 0 016.5 17H20V3H6.5A2.5 2.5 0 004 5.5zM4 19.5A2.5 2.5 0 006.5 22H20v-5',
  you: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5',
  admin: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
};
const icon = (name, cls) =>
  h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: cls, 'aria-hidden': 'true' }, h('path', { d: ICONS[name] }));

const STATUS_LABEL = {
  proposed: '🗳️ Gathering votes',
  queued: '⏳ In line',
  in_progress: '🔨 Being built',
  needs_info: '🙋 Needs your answer',
  integrating: '✨ Final checks',
  done: '🎉 Live!',
  failed: '😵 Hit a snag',
  rejected: '🙅 Not this time',
  cancelled: '🫥 Cancelled',
};
const pill = (status) => h('span', { class: `pill ${status}` }, STATUS_LABEL[status] || status);

// Every request gets a stable emoji sticker, picked from its words when we can.
const STICKER_WORDS = [
  [/dark|night|theme|colou?r|design|look|style/i, '🎨'], [/search|find|filter/i, '🔎'], [/email|mail|digest|newsletter/i, '💌'],
  [/notif|alert|remind|push/i, '🔔'], [/photo|image|picture|avatar|camera/i, '📸'], [/chat|message|comment|reply/i, '💬'],
  [/pay|money|price|checkout|tip/i, '💸'], [/calendar|date|schedule|event|time/i, '📅'], [/map|location|place|near/i, '📍'],
  [/music|song|sound|audio/i, '🎵'], [/video|stream|watch/i, '🎬'], [/export|download|csv|share/i, '📦'], [/fast|speed|slow|perf/i, '⚡'],
  [/emoji|react|like|heart/i, '💖'], [/login|account|profile|password/i, '🔑'], [/game|fun|party/i, '🎉'], [/food|recipe|menu/i, '🍜'],
];
const FALLBACK = ['🌈', '🪩', '🍓', '🦄', '🌵', '🧃', '🪐', '🍩', '🐙', '🌻', '🎈', '🧁', '🦋', '🍉', '🛼', '🌮'];
const COLORS = ['#ff4fa3', '#ff8a3d', '#ffd23f', '#b6f36a', '#6fd3ff', '#9b6bff', '#ff6b6b', '#3dffc5'];
const hash = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
function sticker(r, big) {
  const hit = STICKER_WORDS.find(([re]) => re.test(r.title));
  const n = hash(r.id + r.title);
  return h('div', { class: `sticker ${big ? 'big' : ''}`, style: `background:${COLORS[n % COLORS.length]}`, 'aria-hidden': 'true' }, hit ? hit[1] : FALLBACK[n % FALLBACK.length]);
}

function confetti(n = 90) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = h('div', { class: 'confetti', 'aria-hidden': 'true' });
  for (let i = 0; i < n; i++) {
    box.append(h('i', { style: `left:${Math.random() * 100}%;background:${COLORS[i % COLORS.length]};animation-duration:${1.6 + Math.random() * 1.6}s;animation-delay:${Math.random() * 0.4}s;transform:rotate(${Math.random() * 360}deg)` }));
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 3800);
}

function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

const root = () => document.getElementById('app');
function mount(...nodes) {
  fill(root(), ...nodes.map(applyStyles));
}

// ---------------------------------------------------------------- routing
const routes = [];
const route = (pattern, view, opts = {}) => routes.push({ re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), view, ...opts });
const go = (path) => {
  if (location.hash !== `#${path}`) location.hash = path;
  else render();
};
let renderSeq = 0;
let currentRefresh = null; // called on live "board" events for the current view

async function render() {
  const path = location.hash.replace(/^#/, '') || '/';
  const seq = ++renderSeq;
  currentRefresh = null;
  for (const r of routes) {
    const m = path.match(r.re);
    if (!m) continue;
    if (!r.public && !state.user) return go(`/login?next=${encodeURIComponent(path)}`);
    if (r.public && state.user && (path.startsWith('/login') || path.startsWith('/join'))) return go('/tonight');
    try {
      await r.view({ ...m.groups }, () => seq === renderSeq);
    } catch (e) {
      if (seq !== renderSeq) return;
      console.error(e);
      mount(shell({ title: 'Stall', tab: null }, h('div', { class: 'empty' }, h('div', { class: 'e' }, '🙈'), h('strong', {}, 'Something went wrong'), h('p', { class: 'small' }, e.message || ''), h('button', { class: 'btn ghost sm', onclick: render }, 'Try again'))));
    }
    return;
  }
  go('/tonight');
}
window.addEventListener('hashchange', () => {
  window.scrollTo(0, 0);
  render();
});
const query = () => new URLSearchParams(location.hash.split('?')[1] || '');

// ---------------------------------------------------------------- chrome
/**
 * Page chrome. tab: which tab is lit. back: fallback path for the back button.
 * fab: { label, onclick } for a floating action button, or omit for none.
 */
function shell({ title, tab, back, fab }, ...content) {
  const top = h(
    'header',
    { class: 'topbar' },
    back ? h('button', { class: 'iconbtn', 'aria-label': 'Back', onclick: () => (history.length > 1 ? history.back() : go(back)) }, icon('back')) : null,
    h('div', { class: 'title' }, back ? title : [h('img', { src: '/icons/icon-192.png', alt: '' }), 'Stall']),
    h(
      'a',
      { class: 'iconbtn', href: '#/notifications', 'aria-label': `Notifications${state.unread ? `, ${state.unread} unread` : ''}` },
      icon('bell'),
      state.unread ? h('span', { class: 'dot' }, state.unread > 99 ? '99+' : state.unread) : null,
    ),
  );
  const tabs = [
    ['/tonight', 'tonight', 'Tonight'],
    ['/events', 'events', 'Events'],
    ['/feed', 'feed', 'Feed'],
    ['/lore', 'lore', 'Lore'],
    ['/you', 'you', 'You'],
  ];
  if (state.user?.isAdmin) tabs.push(['/admin', 'admin', 'Admin']);
  const bar = h(
    'nav',
    { class: `tabbar n${tabs.length}`, 'aria-label': 'Main' },
    tabs.map(([href, ic, label]) => h('a', { href: `#${href}`, class: tab === ic ? 'on' : '', 'aria-current': tab === ic ? 'page' : null }, icon(ic), label)),
  );
  const nodes = [top, h('main', {}, ...content), bar];
  if (fab) nodes.push(h('button', { class: 'fab', onclick: fab.onclick }, icon('plus'), fab.label));
  return h('div', { class: 'shell' }, nodes);
}

function updateBell() {
  const btn = document.querySelector('.topbar a.iconbtn');
  if (!btn) return;
  btn.querySelector('.dot')?.remove();
  if (state.unread) btn.append(h('span', { class: 'dot' }, state.unread > 99 ? '99+' : state.unread));
  if ('setAppBadge' in navigator) (state.unread ? navigator.setAppBadge(state.unread) : navigator.clearAppBadge()).catch(() => {});
}

const head = (kicker, title, sub) => h('div', { class: 'page-head' }, kicker ? h('div', { class: 'kicker' }, kicker) : null, h('h1', {}, title), sub ? h('p', {}, sub) : null);

// ---------------------------------------------------------------- components
function voteControl(r, onChange) {
  const cast = async (value) => {
    const next = r.myVote === value ? 0 : value;
    try {
      const { request } = await api(`/requests/${r.id}/vote`, { method: 'POST', body: { value: next } });
      if (request.status === 'queued' && r.status === 'proposed') {
        confetti();
        toast('It got enough votes! Claude will build it 🎉');
      }
      onChange?.(request);
    } catch (e) {
      toast(e.message);
    }
  };
  const disabled = !r.canVote;
  return h(
    'div',
    { class: 'votes', onclick: (e) => e.preventDefault() },
    h('button', { class: `up ${r.myVote === 1 ? 'on' : ''}`, 'aria-label': 'I want this', 'aria-pressed': String(r.myVote === 1), disabled, onclick: () => cast(1) }, icon('up')),
    h('span', { class: 'n', 'aria-label': `${r.score} votes` }, r.score),
    h('button', { class: `down ${r.myVote === -1 ? 'on' : ''}`, 'aria-label': 'Not for me', 'aria-pressed': String(r.myVote === -1), disabled, onclick: () => cast(-1) }, icon('down')),
  );
}

function consensusBar(r) {
  const c = state.config?.consensus;
  if (!c || r.status !== 'proposed' || c.minUpvotes <= 0) return null;
  const total = r.upvotes + r.downvotes;
  const yes = total ? r.upvotes / total : 0;
  const pct = Math.min(1, r.upvotes / c.minUpvotes) * Math.min(1, yes / c.ratio);
  return h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Votes needed', 'aria-valuenow': Math.round(pct * 100), 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: `width:${Math.max(4, Math.round(pct * 100))}%` }));
}

function requestCard(r, { onChange, showVotes = true, prefix } = {}) {
  const side = prefix ?? (showVotes ? voteControl(r, onChange) : null);
  return h(
    'a',
    { class: 'card req', href: `#/requests/${r.id}`, style: side ? null : 'grid-template-columns:1fr' },
    prefix ?? null,
    h(
      'div',
      { class: 'body' },
      h('div', { class: 'top' }, sticker(r), h('div', { class: 't' }, r.title)),
      h('div', { class: 'd' }, r.description),
      consensusBar(r),
      h(
        'div',
        { class: 'meta' },
        pill(r.status),
        r.consensus ? h('span', {}, r.consensus) : null,
        h('span', {}, `${r.mine ? 'You' : r.submitter} · ${ago(r.createdAt)}`),
      ),
    ),
    !prefix && showVotes ? side : null,
  );
}

const empty = (emoji, text, sub) => h('div', { class: 'empty' }, h('div', { class: 'e' }, emoji), h('strong', {}, text), sub ? h('p', { class: 'small' }, sub) : null);

// Kept for call sites; styles are applied through CSSOM in h().
const applyStyles = (node) => node;

// ---------------------------------------------------------------- install (Add to Home Screen)
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.installPrompt = e;
});

function installHint(always = false) {
  if (isStandalone()) return null;
  let dismissed = false;
  try { dismissed = localStorage.getItem('stall:install-dismissed') === '1'; } catch {}
  if (dismissed && !always) return null;
  const box = h('div', { class: 'card stack' });
  const title = h('strong', {}, '📲 Put Stall on your phone');
  if (isIos()) {
    box.append(
      title,
      h('ol', { class: 'steps small' },
        h('li', {}, 'Open this page in Safari.'),
        h('li', {}, 'Tap the Share button ', icon('share', 'share-glyph'), '.'),
        h('li', {}, 'Choose ', h('strong', {}, 'Add to Home Screen'), ', then Add.')),
    );
  } else if (state.installPrompt) {
    box.append(title, h('p', { class: 'small muted' }, 'It works just like an app, with its own icon and alerts.'),
      h('button', { class: 'btn sm hot', onclick: async () => { state.installPrompt.prompt(); await state.installPrompt.userChoice; state.installPrompt = null; render(); } }, 'Install app'));
  } else {
    box.append(title, h('p', { class: 'small muted' }, 'Open your browser menu and choose Install app or Add to Home screen.'));
  }
  if (!always)
    box.append(h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { try { localStorage.setItem('stall:install-dismissed', '1'); } catch {} box.remove(); } }, 'Not now'));
  return box;
}

function b64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// ---------------------------------------------------------------- live updates
function connectEvents() {
  state.events?.close();
  if (!state.user || !('EventSource' in window)) return;
  const es = new EventSource('/api/v1/live');
  es.addEventListener('notification', (e) => {
    const d = JSON.parse(e.data);
    state.unread = d.unread;
    updateBell();
    if (document.visibilityState === 'visible') toast(d.body);
    currentRefresh?.();
  });
  es.addEventListener('board', () => currentRefresh?.());
  // Module topics: views can listen for window 'stall:<topic>' (e.g. 'stall:feed').
  es.addEventListener('live', (e) => {
    let topic = 'board';
    try { topic = JSON.parse(e.data).topic || 'board'; } catch {}
    window.dispatchEvent(new Event(`stall:${topic}`));
    currentRefresh?.();
  });
  state.events = es;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.user) {
    if (!state.events || state.events.readyState === 2) connectEvents();
    refreshMe().then(updateBell);
    currentRefresh?.();
  }
});

async function refreshMe() {
  const me = await api('/me');
  state.user = me.user;
  state.csrf = me.csrf || null;
  state.unread = me.unread || 0;
}


// ---------------------------------------------------------------- shared bits for feature screens
/** A member's display: "🦊 Jess". */
const who = (m) => (m ? `${m.emoji || '🙂'} ${m.name || m.username}` : 'someone');

/** A small form helper: returns { form, err, submit } with the submit button disabled while saving. */
function formOf(fields, label, onSubmit, { cls = 'stack' } = {}) {
  const err = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { class: 'btn block hot', type: 'submit' }, label);
  const form = h('form', {
    class: cls,
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      try {
        await onSubmit(new FormData(form), form);
      } catch (e2) {
        err.textContent = e2.message;
      }
      submit.disabled = false;
    },
  }, fields, err, submit);
  return { form, err, submit };
}

// ---------------------------------------------------------------- boot
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'navigate' && e.data.url) location.hash = e.data.url.replace(/^\/?#/, '');
  });
  try {
    state.config = await api('/config');
    await refreshMe();
  } catch (e) {
    mount(h('div', { class: 'auth' }, h('div', { class: 'box' }, h('div', { class: 'brand' }, h('img', { src: '/icons/icon-192.png', alt: '' }), h('h1', {}, 'Stall'), h('p', {}, e.message)), h('button', { class: 'btn block', onclick: () => location.reload() }, 'Retry'))));
    return;
  }
  connectEvents();
  render();
}

export {
  state, api, ApiError, fill, h, icon, ICONS, pill, sticker, confetti, ago, toast, mount, route, go, render, query, shell, updateBell,
  head, voteControl, consensusBar, requestCard, empty, installHint, isIos, isStandalone, b64ToBytes, connectEvents, refreshMe,
  who, formOf, boot, COLORS, hash, STATUS_LABEL,
};
const setRefresh = (fn) => { currentRefresh = fn; };
export { setRefresh };
