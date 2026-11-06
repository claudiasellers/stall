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
    throw new ApiError(0, 'You appear to be offline.');
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
  proposed: 'Voting',
  queued: 'Queued',
  in_progress: 'Building',
  needs_info: 'Needs your answer',
  integrating: 'Integrating',
  done: 'Shipped',
  failed: 'Failed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};
const pill = (status) => h('span', { class: `pill ${status}` }, STATUS_LABEL[status] || status);

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
      mount(shell({ title: 'Stall', tab: null }, h('div', { class: 'empty' }, h('p', {}, e.message || 'Something went wrong'), h('button', { class: 'btn ghost sm', onclick: render }, 'Try again'))));
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
    h('div', { class: 'title' }, title),
    h(
      'a',
      { class: 'iconbtn', href: '#/notifications', 'aria-label': `Notifications${state.unread ? `, ${state.unread} unread` : ''}` },
      icon('bell'),
      state.unread ? h('span', { class: 'dot', id: 'bell-dot' }, state.unread > 99 ? '99+' : state.unread) : null,
    ),
  );
  const tabs = [
    ['/', 'vote', 'Vote'],
    ['/board', 'board', 'Build'],
    ['/mine', 'mine', 'Mine'],
    ['/account', 'account', 'Account'],
  ];
  const bar = h(
    'nav',
    { class: 'tabbar', 'aria-label': 'Main' },
    tabs.map(([href, ic, label]) => h('a', { href: `#${href}`, class: tab === ic ? 'on' : '', 'aria-current': tab === ic ? 'page' : null }, icon(ic), label)),
  );
  const nodes = [top, h('main', {}, ...content), bar];
  if (fab) nodes.push(h('button', { class: 'fab', onclick: () => go('/new') }, icon('plus'), 'Request'));
  return h('div', { class: 'shell' }, nodes);
}
window.addEventListener('scroll', () => document.querySelector('.topbar')?.classList.toggle('scrolled', window.scrollY > 4), { passive: true });

function updateBell() {
  const btn = document.querySelector('.topbar a.iconbtn');
  if (!btn) return;
  btn.querySelector('.dot')?.remove();
  if (state.unread) btn.append(h('span', { class: 'dot' }, state.unread > 99 ? '99+' : state.unread));
  if ('setAppBadge' in navigator) (state.unread ? navigator.setAppBadge(state.unread) : navigator.clearAppBadge()).catch(() => {});
}

// ---------------------------------------------------------------- components
function voteControl(r, onChange) {
  const cast = async (value) => {
    const next = r.myVote === value ? 0 : value;
    try {
      const { request } = await api(`/requests/${r.id}/vote`, { method: 'POST', body: { value: next } });
      if (request.status === 'queued' && r.status === 'proposed') toast('Consensus reached. It is in the build queue.');
      onChange?.(request);
    } catch (e) {
      toast(e.message);
    }
  };
  const disabled = !r.canVote;
  return h(
    'div',
    { class: 'votes', onclick: (e) => e.preventDefault() },
    h('button', { class: `up ${r.myVote === 1 ? 'on' : ''}`, 'aria-label': 'Upvote', 'aria-pressed': String(r.myVote === 1), disabled, onclick: () => cast(1) }, icon('up')),
    h('span', { class: 'n', 'aria-label': `${r.score} net votes` }, r.score),
    h('button', { class: `down ${r.myVote === -1 ? 'on' : ''}`, 'aria-label': 'Downvote', 'aria-pressed': String(r.myVote === -1), disabled, onclick: () => cast(-1) }, icon('down')),
  );
}

function consensusBar(r) {
  const c = state.config?.consensus;
  if (!c || r.status !== 'proposed' || c.minUpvotes <= 0) return null;
  const total = r.upvotes + r.downvotes;
  const yes = total ? r.upvotes / total : 0;
  const pct = Math.min(1, r.upvotes / c.minUpvotes) * Math.min(1, yes / c.ratio);
  return h('div', { class: 'stack', style: null }, h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': Math.round(pct * 100), 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: `width:${Math.round(pct * 100)}%` })));
}

function requestCard(r, { onChange, showVotes = true, prefix } = {}) {
  return h(
    'a',
    { class: 'card req', href: `#/requests/${r.id}`, style: showVotes || prefix ? null : 'grid-template-columns:1fr' },
    prefix ?? (showVotes ? voteControl(r, onChange) : null),
    h(
      'div',
      { class: 'body' },
      h('div', { class: 't' }, r.title),
      h('div', { class: 'd' }, r.description),
      consensusBar(r),
      h(
        'div',
        { class: 'meta' },
        pill(r.status),
        r.lane ? h('span', {}, r.lane === 'integration' ? 'Integration lane' : `Lane ${r.lane}`) : null,
        r.consensus ? h('span', {}, r.consensus) : null,
        h('span', {}, `${r.mine ? 'You' : r.submitter} · ${ago(r.createdAt)}`),
      ),
    ),
  );
}

const empty = (text, sub) => h('div', { class: 'empty' }, icon('inbox'), h('strong', {}, text), sub ? h('p', { class: 'small' }, sub) : null);

// Kept for call sites; styles are applied through CSSOM in h().
const applyStyles = (node) => node;

// ---------------------------------------------------------------- views: auth
function authView(mode) {
  return async () => {
    const isLogin = mode === 'login';
    const err = h('p', { class: 'error', role: 'alert' });
    const submit = h('button', { class: 'btn block', type: 'submit' }, isLogin ? 'Sign in' : 'Create account');
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
      h('label', { class: 'field' }, 'Username', h('input', { type: 'text', name: 'username', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', required: true, minlength: 3, maxlength: 32 })),
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
    mount(
      h(
        'div',
        { class: 'auth' },
        h(
          'div',
          { class: 'box' },
          h('div', { class: 'brand' }, h('img', { src: '/icons/icon-192.png', alt: '' }), h('h1', {}, 'Stall'), h('p', {}, 'Vote on features. Watch Claude build them.')),
          form,
          isLogin
            ? canSignup
              ? h('p', { class: 'switch' }, 'New here? ', h('a', { href: '#/signup' }, 'Create an account'))
              : null
            : h('p', { class: 'switch' }, 'Have an account? ', h('a', { href: '#/login' }, 'Sign in')),
          installHint(),
        ),
      ),
    );
  };
}
route('/login(?:\\?.*)?', authView('login'), { public: true });
route('/signup(?:\\?.*)?', authView('signup'), { public: true });

// ---------------------------------------------------------------- views: vote
let voteScope = 'proposed';
route('/', async (_p, alive) => {
  const scopes = [
    ['proposed', 'Open for votes'],
    ['active', 'Approved'],
    ['done', 'Shipped'],
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
    fill(listEl, 
      ...(requests.length
        ? requests.map((r) => applyStyles(requestCard(r, { onChange: load, showVotes: voteScope !== 'done' })))
        : [empty(voteScope === 'proposed' ? 'Nothing to vote on yet' : 'Nothing here yet', voteScope === 'proposed' ? 'Tap Request to suggest a feature.' : null)]),
    );
    if (voteScope === 'proposed' && c?.minUpvotes > 0 && requests.length)
      listEl.prepend(h('p', { class: 'muted small' }, `A request is built once it has ${c.minUpvotes}+ upvotes with ${Math.round(c.ratio * 100)}% yes, or an admin approves it.`));
  };
  await load();
  if (!alive()) return;
  currentRefresh = load;
  mount(shell({ title: 'Stall', tab: 'vote' }, h('div', { class: 'page-head' }, h('h1', {}, 'Requests')), seg, listEl));
});

// ---------------------------------------------------------------- views: new
route('/new', async () => {
  const err = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { class: 'btn block', type: 'submit' }, 'Submit for votes');
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
          toast(request.status === 'queued' ? 'Submitted to the build queue' : 'Submitted for votes');
          go(`/requests/${request.id}`);
        } catch (e2) {
          err.textContent = e2.message;
          submit.disabled = false;
        }
      },
    },
    h('label', { class: 'field' }, 'Title', h('small', {}, 'One line people can vote on'), h('input', { type: 'text', name: 'title', required: true, minlength: 3, maxlength: 140, value: draft.title || '', placeholder: 'Dark mode for the dashboard' })),
    h(
      'label',
      { class: 'field' },
      'What should it do?',
      h('small', {}, 'Claude reads this to build it. Say who it is for, what done looks like, and anything it must not break.'),
      h('textarea', { name: 'description', required: true, minlength: 10, maxlength: 10000, rows: 8 }, draft.description || ''),
    ),
    err,
    submit,
  );
  mount(shell({ title: 'New request', tab: 'vote', back: '/', fab: false }, h('div', { class: 'page-head' }, h('h1', {}, 'Suggest a feature')), form));
  form.querySelector('input').focus();
});

// ---------------------------------------------------------------- views: board
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
        const st = b.orchestrator === 'offline' ? 'offline' : r || rep?.state === 'working' ? 'working' : 'idle';
        const inner = [
          h('div', { class: 'h' }, id === 'integration' ? 'Integration' : `Lane ${id}`, h('span', { class: 's', 'aria-label': st })),
          r ? h('div', { class: 'w' }, r.title) : h('div', { class: 'w idle' }, st === 'offline' ? 'Offline' : rep?.detail || 'Idle'),
        ];
        return r ? h('a', { class: `card lane ${st} ${id === 'integration' ? 'integration' : ''}`, href: `#/requests/${r.id}` }, inner) : h('div', { class: `card lane ${st} ${id === 'integration' ? 'integration' : ''}` }, inner);
      }),
    );
    const waiting = b.working.filter((r) => r.status === 'needs_info' || (r.status === 'integrating' && r.lane !== 'integration'));
    fill(wrap, 
      b.orchestrator !== 'online'
        ? h('div', { class: 'callout' }, h('strong', {}, b.orchestrator === 'offline' ? 'The builder is offline' : 'Builder status unknown'), h('p', { class: 'small' }, 'Approved requests stay queued and will be picked up when it reconnects.'))
        : null,
      lanes,
      waiting.length ? h('div', { class: 'section-h' }, h('h2', {}, 'Waiting')) : null,
      waiting.length ? h('div', { class: 'list' }, waiting.map((r) => requestCard(r, { showVotes: false }))) : null,
      h('div', { class: 'section-h' }, h('h2', {}, 'Up next'), h('span', { class: 'muted small' }, `${b.queue.length} queued`)),
      b.queue.length
        ? h('div', { class: 'list' }, b.queue.map((r, i) => requestCard(r, { prefix: h('div', { class: 'qpos' }, i + 1) })))
        : empty('The queue is empty', 'Approved requests show up here.'),
    );
    applyStyles(wrap);
  };
  await load();
  if (!alive()) return;
  currentRefresh = load;
  mount(shell({ title: 'Build', tab: 'board' }, h('div', { class: 'page-head' }, h('h1', {}, 'Build board'), h('p', {}, 'Four lanes build in parallel. The integration lane tests and merges.')), wrap));
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
      ...ask.map((r) =>
        h('a', { class: 'callout', href: `#/requests/${r.id}` }, h('strong', {}, 'Claude has a question'), h('span', {}, r.title), h('span', { class: 'small' }, 'Tap to answer')),
      ),
      ...(rest.length || ask.length ? rest.map((r) => applyStyles(requestCard(r, { onChange: load }))) : [empty('You have not requested anything yet')]),
    );
  };
  await load();
  if (!alive()) return;
  currentRefresh = load;
  mount(shell({ title: 'Mine', tab: 'mine' }, h('div', { class: 'page-head' }, h('h1', {}, 'My requests')), listEl));
});

// ---------------------------------------------------------------- views: detail
route('/requests/:id', async ({ id }, alive) => {
  const wrap = h('div', { class: 'detail' });
  let draft = '';
  const load = async () => {
    const focused = document.activeElement?.tagName === 'TEXTAREA';
    if (focused) return; // don't yank the composer out from under someone typing
    const { request: r, messages, can } = await api(`/requests/${id}`);
    if (!alive()) return;
    state.unread = (await api('/me')).unread ?? state.unread;
    updateBell();

    const act = (label, path, cls = 'ghost', confirmText) =>
      h('button', {
        class: `btn sm ${cls}`,
        onclick: async () => {
          if (confirmText && !confirm(confirmText)) return;
          try {
            await api(`/requests/${r.id}/${path}`, { method: 'POST', body: {} });
            load();
          } catch (e) {
            toast(e.message);
          }
        },
      }, label);

    const facts = h(
      'dl',
      { class: 'facts' },
      h('dt', {}, 'Status'), h('dd', {}, pill(r.status)),
      h('dt', {}, 'By'), h('dd', {}, r.mine ? 'You' : r.submitter),
      r.queuePosition ? [h('dt', {}, 'Queue'), h('dd', {}, `#${r.queuePosition}`)] : null,
      r.lane ? [h('dt', {}, 'Lane'), h('dd', {}, r.lane === 'integration' ? 'Integration' : r.lane)] : null,
      r.branch ? [h('dt', {}, 'Branch'), h('dd', {}, h('code', {}, r.branch))] : null,
      r.commit ? [h('dt', {}, 'Commit'), h('dd', {}, r.commitUrl ? h('a', { href: r.commitUrl, target: '_blank', rel: 'noopener' }, h('code', {}, r.commit.slice(0, 10))) : h('code', {}, r.commit.slice(0, 10)))] : null,
      h('dt', {}, 'Votes'), h('dd', {}, `${r.upvotes} for · ${r.downvotes} against${r.consensus ? ` · ${r.consensus}` : ''}`),
    );

    const timeline = h(
      'div',
      { class: 'timeline' },
      messages.map((m) =>
        h(
          'div',
          { class: `msg ${m.author} ${m.kind}` },
          m.author !== 'system' ? h('div', { class: 'who' }, m.author === 'claude' ? (m.kind === 'question' ? 'Claude asks' : 'Claude') : m.username || 'You', ' · ', ago(m.createdAt)) : null,
          h('div', { class: 'bubble' }, m.body),
        ),
      ),
    );

    let composer = null;
    if (can.reply || can.comment) {
      const ta = h('textarea', { rows: 2, placeholder: can.reply ? 'Answer Claude…' : 'Add a comment…', 'aria-label': can.reply ? 'Your answer' : 'Comment', oninput: (e) => (draft = e.target.value) }, draft);
      const send = h('button', { class: 'btn sm', type: 'submit' }, can.reply ? 'Send answer' : 'Comment');
      composer = h(
        'form',
        {
          class: 'composer',
          onsubmit: async (e) => {
            e.preventDefault();
            if (!ta.value.trim()) return;
            send.disabled = true;
            try {
              await api(`/requests/${r.id}/${can.reply ? 'reply' : 'comment'}`, { method: 'POST', body: { body: ta.value } });
              draft = '';
              ta.blur();
              if (can.reply) toast('Sent. Claude will pick this back up next.');
              load();
            } catch (e2) {
              toast(e2.message);
              send.disabled = false;
            }
          },
        },
        ta,
        h('div', { class: 'row' }, h('span', { class: 'hint' }, can.reply ? 'Your answer resumes the build' : 'Visible to admins and Claude'), send),
      );
    }

    fill(wrap, 
      h('div', { class: 'card stack' },
        h('div', { class: 'req', style: r.canVote ? null : 'grid-template-columns:1fr' }, r.canVote ? voteControl(r, load) : null, h('div', { class: 'body' }, h('h2', {}, r.title), consensusBar(r))),
        h('p', { class: 'desc' }, r.description),
        facts,
      ),
      r.status === 'needs_info' && r.mine ? h('div', { class: 'callout' }, h('strong', {}, 'Claude needs your answer to keep going'), h('p', { class: 'small' }, 'Reply below. Your request goes to the front of the queue as soon as you answer.')) : null,
      r.summary ? h('div', { class: 'callout info' }, h('strong', {}, 'What shipped'), h('p', {}, r.summary)) : null,
      can.approve || can.reject || can.cancel || can.retry
        ? h('div', { class: 'actions' },
            can.approve ? act('Approve and queue', 'approve', '') : null,
            can.retry ? act('Retry', 'retry', '') : null,
            can.reject ? act('Reject', 'reject', 'danger', 'Reject this request?') : null,
            can.cancel ? act('Cancel request', 'cancel', 'danger', 'Cancel this request? Any work in progress is stopped.') : null)
        : null,
      h('div', { class: 'section-h' }, h('h2', {}, 'Activity')),
      timeline,
      composer,
    );
    applyStyles(wrap);
    if (r.status === 'needs_info' && can.reply) wrap.querySelector('.composer textarea')?.scrollIntoView({ block: 'center' });
  };
  await load();
  if (!alive()) return;
  currentRefresh = load;
  mount(shell({ title: `Request #${id}`, tab: null, back: '/', fab: false }, wrap));
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
        : [empty('No notifications yet', 'You will hear here when Claude asks a question or ships something.')]),
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
  }, 'Mark all read');
  mount(shell({ title: 'Notifications', tab: null, back: '/' }, h('div', { class: 'page-head row-between' }, h('h1', {}, 'Notifications'), markAll), listEl));
});

// ---------------------------------------------------------------- views: account
route('/account', async () => {
  const pushBox = h('div', { class: 'stack' });
  const renderPush = async () => {
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    if (!state.config?.pushPublicKey) return fill(pushBox, h('p', { class: 'muted small' }, 'Phone notifications are not set up on this server yet.'));
    if (!supported) {
      return fill(pushBox, 
        h('p', { class: 'muted small' }, isIos() && !isStandalone() ? 'On iPhone, add Stall to your Home Screen first, then open it from there to turn on notifications.' : 'This browser does not support notifications.'),
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
            toast('Notifications off');
          } else {
            const perm = await Notification.requestPermission();
            if (perm !== 'granted') throw new Error('Notifications were not allowed');
            const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(state.config.pushPublicKey) });
            await api('/push/subscribe', { method: 'POST', body: { subscription: s.toJSON() } });
            toast('Notifications on');
          }
        } catch (e) {
          toast(e.message);
        }
        renderPush();
      },
    }, sub ? 'Turn off' : 'Turn on');
    fill(pushBox, h('div', { class: 'row-between' }, h('div', {}, h('strong', {}, 'Phone notifications'), h('p', { class: 'muted small' }, 'Questions from Claude and shipped features.')), btn));
  };

  const adminBox = state.user.isAdmin ? h('div', { class: 'card stack' }, h('h2', {}, 'People'), h('p', { class: 'muted small' }, 'Admins can approve requests without a vote.')) : null;
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
          }, u.is_admin ? 'Admin ✓' : 'Make admin')),
      );
    }
  }

  mount(
    shell(
      { title: 'Account', tab: 'account', fab: false },
      h('div', { class: 'page-head' }, h('h1', {}, state.user.username), h('p', {}, state.user.isAdmin ? 'Admin' : 'Member')),
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
  const title = h('strong', {}, 'Put Stall on your phone');
  if (isIos()) {
    box.append(
      title,
      h('ol', { class: 'steps small' },
        h('li', {}, 'Open this page in Safari.'),
        h('li', {}, 'Tap the Share button ', icon('share', 'share-glyph'), '.'),
        h('li', {}, 'Choose ', h('strong', {}, 'Add to Home Screen'), ', then Add.')),
    );
  } else if (state.installPrompt) {
    box.append(title, h('p', { class: 'small muted' }, 'Install it like an app, with its own icon and notifications.'),
      h('button', { class: 'btn sm', onclick: async () => { state.installPrompt.prompt(); await state.installPrompt.userChoice; state.installPrompt = null; render(); } }, 'Install app'));
  } else {
    box.append(title, h('p', { class: 'small muted' }, 'In your browser menu, choose Install app or Add to Home screen.'));
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
