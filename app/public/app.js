// Stall web app: a small dependency-free SPA over /api/v1.
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
    if (r.public && state.user && (path.startsWith('/login') || path.startsWith('/signup'))) return go('/');
    try {
      await r.view({ ...m.groups }, () => seq === renderSeq);
    } catch (e) {
      if (seq !== renderSeq) return;
      mount(shell({ title: 'Stall', tab: null }, h('div', { class: 'empty' }, h('div', { class: 'e' }, '🙈'), h('strong', {}, 'Something went wrong'), h('p', { class: 'small' }, e.message || ''), h('button', { class: 'btn ghost sm', onclick: render }, 'Try again'))));
    }
    return;
  }
  go('/');
}
window.addEventListener('hashchange', () => {
  window.scrollTo(0, 0);
  render();
});
const query = () => new URLSearchParams(location.hash.split('?')[1] || '');

// ---------------------------------------------------------------- chrome
function shell({ title, tab, back, fab = true }, ...content) {
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
    ['/', 'vote', 'Ideas'],
    ['/board', 'board', 'Building'],
    ['/mine', 'mine', 'Mine'],
    ['/account', 'account', 'You'],
  ];
  const bar = h(
    'nav',
    { class: 'tabbar', 'aria-label': 'Main' },
    tabs.map(([href, ic, label]) => h('a', { href: `#${href}`, class: tab === ic ? 'on' : '', 'aria-current': tab === ic ? 'page' : null }, icon(ic), label)),
  );
  const nodes = [top, h('main', {}, ...content), bar];
  if (fab) nodes.push(h('button', { class: 'fab', onclick: () => go('/new') }, icon('plus'), 'New idea'));
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

// ---------------------------------------------------------------- views: auth
function authView(mode) {
  return async () => {
    const isLogin = mode === 'login';
    const err = h('p', { class: 'error', role: 'alert' });
    const submit = h('button', { class: 'btn block hot', type: 'submit' }, isLogin ? 'Let me in' : 'Join Stall');
    const form = h(
      'form',
      {
        class: 'stack',
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          submit.disabled = true;
          const fd = new FormData(form);
          try {
            const data = await api(`/auth/${mode}`, { method: 'POST', body: { username: fd.get('username'), password: fd.get('password') } });
            state.user = data.user;
            state.csrf = data.csrf;
            await refreshMe();
            connectEvents();
            go(query().get('next') || '/');
          } catch (e2) {
            err.textContent = e2.message;
            submit.disabled = false;
          }
        },
      },
      h('label', { class: 'field' }, 'Username', h('input', { type: 'text', name: 'username', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', required: true, minlength: 3, maxlength: 32, placeholder: 'yourname' })),
      h(
        'label',
        { class: 'field' },
        'Password',
        !isLogin ? h('small', {}, 'At least 8 characters') : null,
        h('input', { type: 'password', name: 'password', autocomplete: isLogin ? 'current-password' : 'new-password', required: true, minlength: isLogin ? 1 : 8 }),
      ),
      err,
      submit,
    );
    const canSignup = state.config?.allowSignup !== false;
    const floaties = h('div', { class: 'floaties', 'aria-hidden': 'true' },
      [['💡', '64%', '5%', '0s'], ['🎉', '84%', '13%', '1s'], ['✨', '74%', '24%', '1.5s']]
        .map(([e, x, y, d]) => h('span', { style: `left:${x};top:${y};animation-delay:${d}` }, e)));
    mount(
      floaties,
      h(
        'div',
        { class: 'auth' },
        h(
          'div',
          { class: 'box' },
          h('div', { class: 'brand' },
            h('img', { src: '/icons/icon-192.png', alt: '' }),
            h('h1', {}, 'Ideas in.', h('br'), h('em', {}, 'Features out.')),
            h('p', {}, 'Share an idea, get your friends to vote, and Claude builds the winners.')),
          form,
          isLogin
            ? canSignup
              ? h('p', { class: 'switch' }, 'New here? ', h('a', { href: '#/signup' }, 'Make an account'))
              : null
            : h('p', { class: 'switch' }, 'Already have an account? ', h('a', { href: '#/login' }, 'Sign in')),
          installHint(),
        ),
      ),
    );
  };
}
route('/login(?:\\?.*)?', authView('login'), { public: true });
route('/signup(?:\\?.*)?', authView('signup'), { public: true });

// ---------------------------------------------------------------- views: ideas (vote)
let voteScope = 'proposed';
route('/', async (_p, alive) => {
  const scopes = [
    ['proposed', '🗳️ Vote now'],
    ['active', '🔨 Happening'],
    ['done', '🎉 Live'],
  ];
  const listEl = h('div', { class: 'list' });
  const seg = h(
    'div',
    { class: 'seg', role: 'tablist' },
    scopes.map(([k, label]) =>
      h('button', { role: 'tab', class: voteScope === k ? 'on' : '', 'aria-selected': String(voteScope === k), onclick: () => { voteScope = k; render(); } }, label),
    ),
  );
  const load = async () => {
    const { requests } = await api(`/requests?scope=${voteScope}`);
    if (!alive()) return;
    const c = state.config?.consensus;
    const emptyState = {
      proposed: empty('💡', 'No ideas yet', 'Tap New idea to suggest the first one.'),
      active: empty('🛋️', 'Nothing in the works', 'Ideas show up here once they get enough votes.'),
      done: empty('🌱', 'Nothing live yet', 'Finished ideas will show up here.'),
    }[voteScope];
    fill(listEl,
      voteScope === 'proposed' && c?.minUpvotes > 0 && requests.length
        ? h('p', { class: 'muted small' }, `An idea gets built once ${c.minUpvotes} people want it and most votes are yes. Admins can also give it the green light.`)
        : null,
      ...(requests.length ? requests.map((r) => requestCard(r, { onChange: load, showVotes: voteScope !== 'done' })) : [emptyState]),
    );
  };
  await load();
  if (!alive()) return;
  currentRefresh = load;
  mount(shell({ tab: 'vote' }, head('Stall', 'What should we build next?'), seg, listEl));
});

// ---------------------------------------------------------------- views: new
route('/new', async () => {
  const err = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { class: 'btn block hot', type: 'submit' }, 'Share my idea');
  const draftKey = 'stall:draft';
  let draft = {};
  try { draft = JSON.parse(localStorage.getItem(draftKey) || '{}'); } catch {}
  const form = h(
    'form',
    {
      class: 'stack',
      oninput: () => { try { localStorage.setItem(draftKey, JSON.stringify(Object.fromEntries(new FormData(form)))); } catch {} },
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        submit.disabled = true;
        const fd = new FormData(form);
        try {
          const { request } = await api('/requests', { method: 'POST', body: { title: fd.get('title'), description: fd.get('description') } });
          try { localStorage.removeItem(draftKey); } catch {}
          toast(request.status === 'queued' ? 'Shared! Claude will start on it soon.' : 'Shared! Now get people to vote 🗳️');
          go(`/requests/${request.id}`);
        } catch (e2) {
          err.textContent = e2.message;
          submit.disabled = false;
        }
      },
    },
    h('label', { class: 'field' }, 'Give it a name', h('small', {}, 'Short and catchy, like a headline'), h('input', { type: 'text', name: 'title', required: true, minlength: 3, maxlength: 140, value: draft.title || '', placeholder: 'A dark mode for night owls' })),
    h(
      'label',
      { class: 'field' },
      'Tell us about it',
      h('small', {}, 'What would you like to be able to do? Who is it for? Describe it like you would to a friend. Claude may ask you questions later.'),
      h('textarea', { name: 'description', required: true, minlength: 10, maxlength: 10000, rows: 7, placeholder: 'I use the app late at night and the bright screen hurts my eyes. It would be great if…' }, draft.description || ''),
    ),
    err,
    submit,
  );
  mount(shell({ title: 'New idea', tab: 'vote', back: '/', fab: false }, head('New idea', 'What do you wish it did?'), form));
  form.querySelector('input').focus();
});

// ---------------------------------------------------------------- views: building (board)
route('/board', async (_p, alive) => {
  const wrap = h('div');
  const load = async () => {
    const b = await api('/board');
    if (!alive()) return;
    const byLane = new Map(b.working.filter((r) => r.lane).map((r) => [String(r.lane), r]));
    const laneIds = b.lanes.length ? b.lanes.map((l) => l.id) : ['1', '2', '3', '4', 'integration'];
    const reported = new Map(b.lanes.map((l) => [l.id, l]));
    const lanes = h(
      'div',
      { class: 'lanes' },
      laneIds.map((id) => {
        const rep = reported.get(id);
        const r = byLane.get(id) || (rep?.requestId ? b.working.find((x) => x.id === rep.requestId) : null);
        const st = b.orchestrator === 'offline' ? 'offline' : r ? 'working' : 'idle';
        const cls = `card lane ${st} ${id === 'integration' ? 'integration' : ''}`;
        const inner = [
          h('div', { class: 'h' }, id === 'integration' ? '✨ Final check' : `🛠️ Builder ${id}`, h('span', { class: 's', 'aria-label': st })),
          r ? h('div', { class: 'w' }, r.title) : h('div', { class: 'w idle' }, st === 'offline' ? 'Taking a break' : id === 'integration' ? 'Nothing to check right now' : 'Free'),
        ];
        return r ? h('a', { class: cls, href: `#/requests/${r.id}` }, inner) : h('div', { class: cls }, inner);
      }),
    );
    const waiting = b.working.filter((r) => r.status === 'needs_info' || (r.status === 'integrating' && r.lane !== 'integration'));
    fill(wrap,
      b.orchestrator !== 'online'
        ? h('div', { class: 'callout quiet' }, h('strong', {}, '😴 The builders are taking a break'), h('p', { class: 'small muted' }, 'Ideas stay in line and they will pick them up as soon as they are back.'))
        : null,
      lanes,
      waiting.length ? h('div', { class: 'section-h' }, h('h2', {}, 'Waiting on something')) : null,
      waiting.length ? h('div', { class: 'list' }, waiting.map((r) => requestCard(r, { showVotes: false }))) : null,
      h('div', { class: 'section-h' }, h('h2', {}, 'Up next'), h('span', { class: 'muted small' }, b.queue.length === 1 ? '1 in line' : `${b.queue.length} in line`)),
      b.queue.length
        ? h('div', { class: 'list' }, b.queue.map((r, i) => requestCard(r, { prefix: h('div', { class: 'qpos' }, i + 1) })))
        : empty('🧘', 'Nothing in line', 'Ideas with enough votes show up here.'),
    );
  };
  await load();
  if (!alive()) return;
  currentRefresh = load;
  mount(shell({ tab: 'board' }, head('Live', 'Being built right now', 'Claude works on up to four ideas at once, and every one gets a final check before it goes live.'), wrap));
});

// ---------------------------------------------------------------- views: mine
route('/mine', async (_p, alive) => {
  const listEl = h('div', { class: 'list' });
  const load = async () => {
    const { requests } = await api('/requests?scope=mine');
    if (!alive()) return;
    const ask = requests.filter((r) => r.status === 'needs_info');
    const rest = requests.filter((r) => r.status !== 'needs_info');
    fill(listEl,
      ...ask.map((r) => h('a', { class: 'callout', href: `#/requests/${r.id}` }, h('strong', {}, '🙋 Claude has a question for you'), h('span', {}, r.title), h('span', { class: 'small' }, 'Tap to answer →'))),
      ...(rest.length || ask.length ? rest.map((r) => requestCard(r, { onChange: load })) : [empty('✏️', 'You have not shared any ideas yet', 'Tap New idea to share your first one.')]),
    );
  };
  await load();
  if (!alive()) return;
  currentRefresh = load;
  mount(shell({ tab: 'mine' }, head('Mine', 'My ideas'), listEl));
});

// ---------------------------------------------------------------- views: detail
const celebrated = new Set();
route('/requests/:id', async ({ id }, alive) => {
  const wrap = h('div', { class: 'detail' });
  let draft = '';
  const load = async () => {
    const focused = document.activeElement?.tagName === 'TEXTAREA';
    if (focused) return; // don't yank the composer out from under someone typing
    const { request: r, messages, can, admin } = await api(`/requests/${id}`);
    if (!alive()) return;
    state.unread = (await api('/me')).unread ?? state.unread;
    updateBell();
    if (r.status === 'done' && !celebrated.has(r.id)) {
      celebrated.add(r.id);
      setTimeout(confetti, 250);
    }

    const act = (label, path, cls = 'ghost', confirmText) =>
      h('button', {
        class: `btn sm ${cls}`,
        onclick: async () => {
          if (confirmText && !confirm(confirmText)) return;
          try {
            await api(`/requests/${r.id}/${path}`, { method: 'POST', body: {} });
            if (path === 'approve') confetti();
            load();
          } catch (e) {
            toast(e.message);
          }
        },
      }, label);

    const where =
      r.status === 'queued' && r.queuePosition ? `Number ${r.queuePosition} in line`
      : r.status === 'in_progress' ? 'Claude is building this right now'
      : r.status === 'integrating' ? 'Built! Getting a final check before it goes live'
      : r.status === 'proposed' ? r.consensus || 'Waiting on votes'
      : null;

    const timeline = h(
      'div',
      { class: 'timeline' },
      messages.map((m) =>
        h(
          'div',
          { class: `msg ${m.author} ${m.kind} ${m.adminOnly ? 'admin' : ''}` },
          m.author !== 'system' ? h('div', { class: 'who' }, m.adminOnly ? '🔧 Admin only · ' : '', m.author === 'claude' ? (m.kind === 'question' ? 'Claude asks' : 'Claude') : m.username || 'You', ' · ', ago(m.createdAt)) : null,
          h('div', { class: 'bubble' }, m.body),
        ),
      ),
    );

    let composer = null;
    if (can.reply || can.comment) {
      const ta = h('textarea', { rows: 2, placeholder: can.reply ? 'Type your answer…' : 'Add a note…', 'aria-label': can.reply ? 'Your answer' : 'Note', oninput: (e) => (draft = e.target.value) }, draft);
      const send = h('button', { class: `btn sm ${can.reply ? 'hot' : ''}`, type: 'submit' }, can.reply ? 'Send' : 'Add note');
      composer = h(
        'form',
        {
          class: `composer ${can.reply ? 'sticky' : ''}`,
          onsubmit: async (e) => {
            e.preventDefault();
            if (!ta.value.trim()) return;
            send.disabled = true;
            try {
              await api(`/requests/${r.id}/${can.reply ? 'reply' : 'comment'}`, { method: 'POST', body: { body: ta.value } });
              draft = '';
              ta.blur();
              if (can.reply) toast('Thanks! Claude will pick it back up 🙌');
              load();
            } catch (e2) {
              toast(e2.message);
              send.disabled = false;
            }
          },
        },
        ta,
        h('div', { class: 'row' }, h('span', { class: 'hint' }, can.reply ? 'Claude keeps going once you answer' : 'Only you, admins and Claude see notes'), send),
      );
    }

    const adminBox = admin
      ? h('details', { class: 'card adminbox' },
          h('summary', {}, '🔧 Admin details'),
          h('dl', { class: 'facts' },
            admin.branch ? [h('dt', {}, 'Branch'), h('dd', {}, h('code', {}, admin.branch))] : null,
            admin.lane ? [h('dt', {}, 'Lane'), h('dd', {}, admin.lane)] : null,
            admin.commit ? [h('dt', {}, 'Commit'), h('dd', {}, admin.commitUrl ? h('a', { href: admin.commitUrl, target: '_blank', rel: 'noopener' }, h('code', {}, admin.commit.slice(0, 10))) : h('code', {}, admin.commit.slice(0, 10)))] : null,
            admin.failureReason ? [h('dt', {}, 'Problem'), h('dd', {}, admin.failureReason)] : null,
            [h('dt', {}, 'Votes'), h('dd', {}, `${r.upvotes} yes · ${r.downvotes} no`)],
          ))
      : null;

    fill(wrap,
      h('div', { class: 'hero' },
        h('div', { class: 'row' }, sticker(r, true), r.canVote ? voteControl(r, load) : null),
        h('h1', {}, r.title),
        h('div', { class: 'meta' }, pill(r.status), h('span', {}, `${r.mine ? 'Your idea' : `${r.submitter}'s idea`} · ${ago(r.createdAt)}`)),
        consensusBar(r),
        where ? h('p', { class: 'muted small' }, where) : null,
      ),
      h('p', { class: 'desc' }, r.description),
      r.status === 'needs_info' && r.mine ? h('div', { class: 'callout' }, h('strong', {}, '🙋 Claude needs your help to keep going'), h('p', { class: 'small' }, 'Answer the question below. Your idea jumps to the front of the line as soon as you do.')) : null,
      r.summary ? h('div', { class: 'callout info' }, h('strong', {}, '🎉 What changed'), h('p', {}, r.summary)) : null,
      r.status === 'failed' ? h('div', { class: 'callout quiet' }, h('strong', {}, '😵 Claude got stuck on this one'), h('p', { class: 'small muted' }, 'An admin has been told and can try again.')) : null,
      can.approve || can.reject || can.cancel || can.retry
        ? h('div', { class: 'actions' },
            can.approve ? act('✅ Build it', 'approve', 'hot') : null,
            can.retry ? act('🔁 Try again', 'retry', '') : null,
            can.reject ? act('Pass on this', 'reject', 'danger', 'Pass on this idea? It will not be built.') : null,
            can.cancel ? act('Cancel', 'cancel', 'danger', 'Cancel this idea? If Claude is working on it, it will stop.') : null)
        : null,
      adminBox,
      h('div', { class: 'section-h' }, h('h2', {}, 'What’s happened')),
      timeline,
      composer,
    );
    if (r.status === 'needs_info' && can.reply) wrap.querySelector('.composer textarea')?.scrollIntoView({ block: 'center' });
  };
  await load();
  if (!alive()) return;
  currentRefresh = load;
  mount(shell({ title: 'Idea', tab: null, back: '/', fab: false }, wrap));
});

// ---------------------------------------------------------------- views: notifications
route('/notifications', async (_p, alive) => {
  const listEl = h('div', { class: 'list' });
  const load = async () => {
    const { notifications } = await api('/notifications');
    if (!alive()) return;
    fill(listEl, 
      ...(notifications.length
        ? notifications.map((n) =>
            h('a', { class: `card notif ${n.read_at ? '' : 'unread'}`, href: n.request_id ? `#/requests/${n.request_id}` : '#/notifications' }, h('span', { class: 'u' }), h('div', {}, h('div', {}, n.body), h('div', { class: 'when' }, ago(n.created_at)))),
          )
        : [empty('🔕', 'All quiet', 'You will hear here when Claude has a question or one of your ideas goes live.')]),
    );
  };
  await load();
  if (!alive()) return;
  currentRefresh = load;
  const markAll = h('button', {
    class: 'btn sm ghost',
    onclick: async () => {
      const { unread } = await api('/notifications/read', { method: 'POST', body: {} });
      state.unread = unread;
      updateBell();
      load();
    },
  }, 'Mark all seen');
  mount(shell({ title: 'Updates', tab: null, back: '/', fab: false }, h('div', { class: 'page-head row-between' }, h('h1', {}, 'Updates'), markAll), listEl));
});

// ---------------------------------------------------------------- views: account
route('/account', async () => {
  const pushBox = h('div', { class: 'stack' });
  const renderPush = async () => {
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    if (!state.config?.pushPublicKey) return fill(pushBox, h('p', { class: 'muted small' }, 'Phone alerts are not switched on for Stall yet.'));
    if (!supported) {
      return fill(pushBox, 
        h('p', { class: 'muted small' }, isIos() && !isStandalone() ? 'On iPhone, add Stall to your Home Screen first (see above), then open it from there to turn on alerts.' : 'This browser can’t show alerts.'),
      );
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    const btn = h('button', {
      class: `btn sm ${sub ? 'ghost' : ''}`,
      onclick: async () => {
        btn.disabled = true;
        try {
          if (sub) {
            await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
            await sub.unsubscribe();
            toast('Alerts off');
          } else {
            const perm = await Notification.requestPermission();
            if (perm !== 'granted') throw new Error('Alerts were not allowed. You can change this in your phone settings.');
            const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(state.config.pushPublicKey) });
            await api('/push/subscribe', { method: 'POST', body: { subscription: s.toJSON() } });
            toast('Alerts on 🔔');
          }
        } catch (e) {
          toast(e.message);
        }
        renderPush();
      },
    }, sub ? 'Turn off' : 'Turn on');
    fill(pushBox, h('div', { class: 'row-between' }, h('div', {}, h('strong', {}, '🔔 Phone alerts'), h('p', { class: 'muted small' }, 'Get a buzz when Claude has a question or your idea goes live.')), btn));
  };

  const adminBox = state.user.isAdmin ? h('div', { class: 'card stack' }, h('h2', {}, 'People'), h('p', { class: 'muted small' }, 'Admins can green-light ideas without waiting for votes.')) : null;
  if (adminBox) {
    const { users } = await api('/admin/users');
    for (const u of users) {
      adminBox.append(
        h('div', { class: 'row-between' }, h('span', {}, u.username, u.id === state.user.id ? h('span', { class: 'muted' }, ' (you)') : null),
          h('button', {
            class: `btn sm ${u.is_admin ? 'ghost' : ''}`,
            onclick: async () => {
              try {
                await api(`/admin/users/${u.id}/admin`, { method: 'POST', body: { isAdmin: !u.is_admin } });
                render();
              } catch (e) {
                toast(e.message);
              }
            },
          }, u.is_admin ? '👑 Admin' : 'Make admin')),
      );
    }
  }

  mount(
    shell(
      { title: 'Account', tab: 'account', fab: false },
      head(state.user.isAdmin ? '👑 Admin' : '👋 Hi', state.user.username),
      h('div', { class: 'list' },
        installHint(true),
        h('div', { class: 'card' }, pushBox),
        adminBox,
        h('button', {
          class: 'btn block ghost',
          onclick: async () => {
            await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {});
            state.user = null;
            state.csrf = null;
            state.events?.close();
            go('/login');
          },
        }, 'Sign out'),
      ),
    ),
  );
  renderPush();
});

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
  const es = new EventSource('/api/v1/events');
  es.addEventListener('notification', (e) => {
    const d = JSON.parse(e.data);
    state.unread = d.unread;
    updateBell();
    if (document.visibilityState === 'visible') toast(d.body);
    currentRefresh?.();
  });
  es.addEventListener('board', () => currentRefresh?.());
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

// ---------------------------------------------------------------- boot
(async function boot() {
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
})();
