// Feed (#/feed): The Morning After, Lost & Found, Irish Goodbyes, and everything else
// the night left behind. Also exports the shared post card, reaction bar and
// eventPosts(event) for the event page.
import { api, h, icon, toast, route, go, shell, state, empty, ago, head, mount, setRefresh } from '../core.js';

// Styles live next to the views so the shared stylesheet stays conflict-free.
if (!document.querySelector('link[data-posts-css]')) {
  document.head.append(h('link', { rel: 'stylesheet', href: '/css/posts.css', 'data-posts-css': '1' }));
}

// ------------------------------------------------------------------ shared data
let metaCache = null;
export async function postsMeta(force = false) {
  if (!metaCache || force) metaCache = await api('/posts/meta');
  return metaCache;
}

const fill = (el, ...nodes) => el.replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
const query = () => new URLSearchParams(location.hash.split('?')[1] || '');
const avatar = (p) => h('span', { class: 'pv-av', 'aria-hidden': 'true' }, p?.emoji || (p?.name ? p.name[0].toUpperCase() : '🫥'));

function timeLeft(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'gone';
  const hrs = Math.floor(ms / 3600_000);
  return hrs >= 1 ? `${hrs}h left` : `${Math.max(1, Math.round(ms / 60000))}m left`;
}

// ------------------------------------------------------------------ reactions
/**
 * Emoji reaction row for any target. Posts go through /posts/:id/react so absolution runs;
 * everything else (photos, events) through /reactions.
 */
export function reactionBar(targetType, targetId, reactions = [], { onChange, emoji } = {}) {
  const set = emoji || metaCache?.reactions || ['😂', '💀', '🔥', '😭', '🙏', '👀', '❤️', '🫠', '🚩', '🐐'];
  const bar = h('div', { class: 'pv-rx', role: 'group', 'aria-label': 'Reactions' });
  let open = false;
  const draw = (list) => {
    const byEmoji = new Map(list.map((r) => [r.emoji, r]));
    const shown = open ? set : set.filter((e) => byEmoji.has(e));
    fill(
      bar,
      shown.map((e) => {
        const r = byEmoji.get(e);
        return h(
          'button',
          { class: `pv-chip ${r?.mine ? 'on' : ''}`, 'aria-pressed': String(!!r?.mine), 'aria-label': `${e} ${r?.count || 0}`, onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); react(e); } },
          e,
          r?.count ? h('b', {}, r.count) : null,
        );
      }),
      h('button', { class: 'pv-chip add', 'aria-label': open ? 'Fewer reactions' : 'Add reaction', onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); open = !open; draw(list); } }, open ? '×' : '＋'),
    );
  };
  const react = async (e) => {
    try {
      if (targetType === 'post') {
        const out = await api(`/posts/${targetId}/react`, { method: 'POST', body: { emoji: e } });
        if (out.forgiven) toast('🙏 Forgiven. The group has spoken.');
        open = false;
        onChange?.(out.post);
        draw(out.post.reactions);
      } else {
        const out = await api('/reactions', { method: 'POST', body: { targetType, targetId, emoji: e } });
        open = false;
        draw(out.reactions);
        onChange?.(out.reactions);
      }
    } catch (err) {
      toast(err.message);
    }
  };
  draw(reactions);
  return bar;
}

// ------------------------------------------------------------------ post card
const KIND_LABEL = { quote: '🗣️ Overheard', regret: '🌅 The Morning After', lost_item: '🧥 Lost & Found', irish_goodbye: '👻 Irish Goodbye' };

function isOoc() {
  try { return localStorage.getItem('stall:ooc') === '1'; } catch { return false; }
}
export function setOoc(on) {
  try { localStorage.setItem('stall:ooc', on ? '1' : '0'); } catch {}
}

export function postCard(p, { onChange, onRemove, showKind = true } = {}) {
  const card = h('article', { class: `card pv pv-${p.kind} ${p.status !== 'open' ? `is-${p.status}` : ''}`, id: `post-${p.id}` });
  const redraw = (np) => {
    const fresh = postCard(np, { onChange, onRemove, showKind });
    card.replaceWith(fresh);
    onChange?.(np);
  };
  const act = async (path, body, msg) => {
    try {
      const out = await api(`/posts/${p.id}/${path}`, { method: 'POST', body: body || {} });
      if (msg) toast(msg);
      if (out.revealed) toast('🎭 Unmasked.');
      redraw(out.post);
    } catch (e) {
      toast(e.message);
    }
  };
  const del = async () => {
    if (!confirm(p.kind === 'regret' ? 'Delete this regret for good?' : 'Delete this for good?')) return;
    try {
      await api(`/posts/${p.id}`, { method: 'DELETE' });
      card.remove();
      onRemove?.(p);
      toast('Gone. Like it never happened.');
    } catch (e) {
      toast(e.message);
    }
  };

  const top = h('div', { class: 'pv-top' },
    showKind ? h('span', { class: 'pv-kind' }, KIND_LABEL[p.kind] || p.kind) : null,
    p.event ? h('a', { class: 'pv-event', href: `#/events/${p.event.id}` }, `📍 ${p.event.title || 'that night'}`) : null,
    h('span', { class: 'pv-time' }, ago(p.createdAt)),
  );

  let main;
  if (p.kind === 'quote') {
    const ctx = p.context ? h('p', { class: 'pv-ctx' }, p.context) : null;
    const ooc = isOoc();
    main = [
      h('blockquote', { class: 'pv-quote' }, `“${p.body}”`),
      h('div', { class: 'pv-by' }, '— ', avatar(p.subject), h('strong', {}, p.subject?.name || 'someone'),
        p.stance === 'claimed' ? h('span', { class: 'pv-stance ok' }, '💅 stands by it') : null,
        p.stance === 'disputed' ? h('span', { class: 'pv-stance no' }, '🙅 disputes this') : null),
      p.stanceNote ? h('p', { class: 'pv-note' }, `“${p.stanceNote}”`) : null,
      ctx && ooc ? h('button', { class: 'pv-reveal', onclick: (e) => { e.currentTarget.replaceWith(ctx); } }, 'Out of context. Tap for context') : ctx,
      p.author ? h('p', { class: 'pv-meta' }, `heard by ${p.mine ? 'you' : p.author.name}`) : null,
    ];
  } else if (p.kind === 'regret') {
    main = [
      p.severity ? h('div', { class: `pv-sev s${p.severity.level}` }, `${p.severity.emoji} ${p.severity.label}`) : null,
      h('p', { class: 'pv-body' }, p.body),
      h('div', { class: 'pv-by' },
        p.author ? [avatar(p.author), h('strong', {}, p.mine ? 'You' : p.author.name), p.unmasked ? h('span', { class: 'pv-stance no' }, '🎭 unmasked') : null]
          : [avatar(null), h('strong', {}, p.mine ? 'You (anonymously)' : 'Anonymous')]),
      p.status === 'forgiven' ? h('div', { class: 'pv-forgiven' }, '🙏 Forgiven') :
        p.forgiveness ? h('p', { class: 'pv-meta' }, `🙏 ${p.forgiveness.count}/${p.forgiveness.needed} to forgive`) : null,
      p.expiresAt ? h('p', { class: 'pv-meta pv-fuse' }, `💣 self-destructs · ${timeLeft(p.expiresAt)}`) : null,
      p.unmask && p.unmask.available && p.can.unmask
        ? h('button', { class: `btn sm ghost pv-unmask ${p.unmask.mine ? 'on' : ''}`, onclick: () => act('unmask') },
            p.unmask.mine ? `🎭 You voted to unmask · ${p.unmask.votes}/${p.unmask.needed}` : `🎭 Vote to unmask · ${p.unmask.votes}/${p.unmask.needed}`)
        : null,
    ];
  } else if (p.kind === 'lost_item') {
    main = [
      h('p', { class: 'pv-body big' }, p.body),
      p.context ? h('p', { class: 'pv-ctx' }, `Last seen: ${p.context}`) : null,
      h('div', { class: 'pv-by' }, avatar(p.author), h('strong', {}, p.mine ? 'You' : p.author?.name), ' lost it'),
      p.status === 'found'
        ? h('div', { class: 'pv-forgiven' }, `🙌 ${p.resolvedBy?.id === state.user?.id ? 'You have' : `${p.resolvedBy?.name || 'Someone'} has`} it`)
        : null,
      h('div', { class: 'pv-actions' },
        p.can.found ? h('button', { class: 'btn sm hot', onclick: () => act('found', null, 'Nice. They’ve been told.') }, '🙋 I have it') : null,
        p.can.reopen ? h('button', { class: 'btn sm ghost', onclick: () => act('reopen') }, 'Still missing') : null),
    ];
  } else if (p.kind === 'irish_goodbye') {
    main = [
      h('div', { class: 'pv-by big' }, avatar(p.subject), h('strong', {}, p.subject?.name || 'Someone'), ' 👻'),
      h('p', { class: 'pv-body' }, p.body),
      p.context ? h('p', { class: 'pv-ctx' }, p.context) : null,
      p.stance === 'claimed' ? h('span', { class: 'pv-stance ok' }, '💅 owns it') : null,
      p.stance === 'disputed' ? h('span', { class: 'pv-stance no' }, `🙅 “I said bye”${p.stanceNote ? `: ${p.stanceNote}` : ''}`) : null,
      p.author ? h('p', { class: 'pv-meta' }, `logged by ${p.mine ? 'you' : p.author.name}`) : null,
    ];
  }

  const stance = p.can.stance
    ? h('div', { class: 'pv-actions' },
        h('button', { class: `btn sm ghost ${p.stance === 'claimed' ? 'on' : ''}`, onclick: () => act('stance', { stance: p.stance === 'claimed' ? null : 'claimed' }) }, p.kind === 'quote' ? '💅 I stand by it' : '💅 Guilty'),
        h('button', {
          class: `btn sm ghost ${p.stance === 'disputed' ? 'on' : ''}`,
          onclick: () => {
            if (p.stance === 'disputed') return act('stance', { stance: null });
            const note = prompt(p.kind === 'quote' ? 'I have never said this. Anything to add?' : 'You said bye to who?') ?? '';
            act('stance', { stance: 'disputed', note });
          },
        }, p.kind === 'quote' ? '🙅 Never said this' : '🙅 I said bye'))
    : null;

  fill(card,
    top,
    main,
    stance,
    h('div', { class: 'pv-foot' },
      reactionBar('post', p.id, p.reactions, { onChange: (np) => { if (np && np.status !== p.status) redraw(np); } }),
      p.can.delete ? h('button', { class: 'pv-del', 'aria-label': 'Delete', onclick: del }, '🗑') : null),
  );
  return card;
}

// ------------------------------------------------------------------ composer
const COMPOSER = {
  quote: { title: 'Overheard', cta: 'Put it on the wall' },
  regret: { title: 'The Morning After', cta: 'Confess' },
  lost_item: { title: 'Lost & Found', cta: 'Post it' },
  irish_goodbye: { title: 'Irish Goodbye', cta: 'Log it' },
};

/** Inline composer for a kind. eventId pre-links it to a night. */
export function composer(kind, { eventId, onDone } = {}) {
  const meta = metaCache;
  const err = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { class: 'btn block hot', type: 'submit' }, COMPOSER[kind].cta);
  const members = meta?.members || [];
  const whoPicker = (label) => {
    const custom = h('input', { type: 'text', name: 'subjectLabel', maxlength: 60, placeholder: 'the bouncer, the cab driver, some guy named Theo', hidden: true });
    const sel = h('select', {
      name: 'subjectId',
      onchange: (e) => { custom.hidden = e.target.value !== 'other'; if (!custom.hidden) custom.focus(); },
    },
      h('option', { value: '' }, 'Pick someone…'),
      members.map((m) => h('option', { value: m.id }, `${m.emoji ? `${m.emoji} ` : ''}${m.name}`)),
      h('option', { value: 'other' }, 'Someone else…'));
    return h('label', { class: 'field' }, label, sel, custom);
  };

  const fields = {
    quote: [
      h('label', { class: 'field' }, 'The line', h('textarea', { name: 'body', required: true, maxlength: 500, rows: 3, placeholder: 'I’m not drunk, I’m European' })),
      whoPicker('Who said it'),
      h('label', { class: 'field' }, 'Context', h('small', {}, 'Optional. Hidden in Out of Context mode.'), h('input', { type: 'text', name: 'context', maxlength: 280, placeholder: 'to the bouncer, at 2am, holding a pizza' })),
    ],
    regret: [
      h('label', { class: 'field' }, 'What happened', h('textarea', { name: 'body', required: true, maxlength: 500, rows: 4, placeholder: 'I told the DJ I was his manager' })),
      h('fieldset', { class: 'pv-sevpick' }, h('legend', {}, 'How bad'),
        (meta?.severities || []).map((s, i) => h('label', {}, h('input', { type: 'radio', name: 'severity', value: s.level, checked: i === 0 }), h('span', {}, s.emoji), h('small', {}, s.label)))),
      h('label', { class: 'pv-toggle' }, h('input', { type: 'checkbox', name: 'anonymous' }), h('span', {}, '🥸 Post anonymously'), h('small', {}, 'The group gets one unmask vote a month.')),
      h('label', { class: 'pv-toggle' }, h('input', { type: 'checkbox', name: 'selfDestruct', checked: true }), h('span', {}, `💣 Self-destruct in ${meta?.regretTtlHours ?? 24}h`), h('small', {}, 'Actually deleted, not hidden.')),
    ],
    lost_item: [
      h('label', { class: 'field' }, 'What’s missing', h('input', { type: 'text', name: 'body', required: true, maxlength: 500, placeholder: 'black Acne jacket / my AmEx / my dignity' })),
      h('label', { class: 'field' }, 'Last seen', h('input', { type: 'text', name: 'context', maxlength: 280, placeholder: 'coat check at Le Bain, ~1am' })),
    ],
    irish_goodbye: [
      whoPicker('Who vanished'),
      h('label', { class: 'field' }, 'Details', h('small', {}, 'Optional'), h('input', { type: 'text', name: 'body', maxlength: 500, placeholder: 'went to the bathroom at 12:40, never came back' })),
    ],
  }[kind];

  const form = h('form', {
    class: 'stack pv-compose',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      const fd = new FormData(form);
      const sid = fd.get('subjectId');
      const body = {
        kind,
        body: fd.get('body') || '',
        context: fd.get('context') || '',
        subjectId: sid && sid !== 'other' ? Number(sid) : null,
        subjectLabel: sid === 'other' ? fd.get('subjectLabel') : '',
        severity: Number(fd.get('severity') || 1),
        anonymous: fd.get('anonymous') === 'on',
        selfDestruct: fd.get('selfDestruct') === 'on',
        eventId: eventId ?? (fd.get('eventId') ? Number(fd.get('eventId')) : null),
      };
      try {
        const { post } = await api('/posts', { method: 'POST', body });
        toast({ quote: 'On the wall 🗣️', regret: 'Confessed. 🙏', lost_item: 'Posted. Fingers crossed.', irish_goodbye: 'Logged 👻' }[kind]);
        onDone?.(post);
      } catch (e2) {
        err.textContent = e2.message;
        submit.disabled = false;
      }
    },
  }, fields, err, submit);
  return form;
}

route('/post/new(?:\\?.*)?', async () => {
  await postsMeta();
  const kind = COMPOSER[query().get('kind')] ? query().get('kind') : 'regret';
  const eventId = query().get('event') ? Number(query().get('event')) : undefined;
  const back = kind === 'quote' ? '/lore' : '/feed';
  mount(shell({ title: COMPOSER[kind].title, back, tab: kind === 'quote' ? 'lore' : 'feed', fab: false },
    composer(kind, { eventId, onDone: () => go(eventId ? `/events/${eventId}` : back) })));
});


// ------------------------------------------------------------------ feed view
const TABS = [
  ['all', '✨ Everything'],
  ['regret', '🌅 Morning After'],
  ['lost_item', '🧥 Lost & Found'],
  ['irish_goodbye', '👻 Irish Goodbyes'],
];
let feedTab = 'all';

function feedItemCard(f) {
  return h('div', { class: 'card pv pv-item' },
    h('div', { class: 'pv-by' }, avatar(f.actor), h('span', {}, f.body)),
    h('div', { class: 'pv-top' }, f.eventId ? h('a', { class: 'pv-event', href: `#/events/${f.eventId}` }, '📍 event') : null, h('span', { class: 'pv-time' }, ago(f.createdAt))));
}

function leaderboard(rows) {
  if (!rows.length) return null;
  return h('section', { class: 'card pv-board' },
    h('h3', {}, '👻 Disappearing Act leaderboard'),
    h('ol', {}, rows.map((r, i) => h('li', {},
      h('span', { class: 'rank' }, ['🥇', '🥈', '🥉'][i] || `${i + 1}`),
      avatar(r), h('strong', {}, r.name),
      h('span', { class: 'n' }, `${r.count}${r.disputed ? ` (${r.disputed} disputed)` : ''}`)))));
}

// Regret of the Year bracket (December). Shown atop the Morning After tab while it runs.
function rotyCard(b, reload) {
  if (!b || (b.status !== 'voting' && b.status !== 'crowned')) return null;
  const vote = async (match, postId) => {
    try {
      await api('/posts/regret-of-the-year/vote', { method: 'POST', body: { match, postId } });
      reload();
    } catch (e) {
      toast(e.message);
    }
  };
  const side = (m, p, n, key) => p
    ? h('button', { class: `pv-roty-side ${m.myPick === p.id ? 'on' : ''} ${m.winner === p.id ? 'win' : ''}`, disabled: !key, onclick: () => key && vote(key, p.id) },
        h('span', {}, p.severity ? `${p.severity.emoji} ` : '', p.body), h('b', {}, n))
    : h('div', { class: 'pv-roty-side bye' }, 'bye');
  return h('section', { class: 'card pv-roty' },
    h('h3', {}, `🏆 Regret of the Year ${b.year}`),
    b.champion ? [h('div', { class: 'kicker' }, '👑 Champion'), postCard(b.champion, { showKind: false })] : null,
    b.rounds.filter((r) => r.matches.length).map((r) => h('div', { class: 'pv-roty-round' },
      h('div', { class: 'kicker' }, `${r.name}${r.open ? ' · voting now' : ''}`),
      r.matches.map((m) => h('div', { class: 'pv-roty-match' },
        side(m, m.a, m.votes.a, r.open && m.a && m.b ? m.key : null),
        h('span', { class: 'vs' }, 'vs'),
        side(m, m.b, m.votes.b, r.open && m.a && m.b ? m.key : null))))));
}

route('/feed(?:\\?.*)?', async (_p, alive) => {
  await postsMeta();
  const focus = query().get('post');
  const listEl = h('div', { class: 'list' });
  const more = h('button', { class: 'btn ghost sm pv-more', hidden: true }, 'Older');
  let cursor = null;
  const newKind = feedTab === 'all' ? 'regret' : feedTab;

  const load = async (append = false) => {
    let rows = [];
    let extra = null;
    if (feedTab === 'all') {
      const { feed, next } = await api(`/feed${append && cursor ? `?before=${encodeURIComponent(cursor)}` : ''}`);
      cursor = next;
      rows = feed.map((x) => (x.type === 'post' ? postCard(x.post) : feedItemCard(x.item)));
    } else {
      const qs = new URLSearchParams({ kind: feedTab });
      if (append && cursor) qs.set('before', cursor);
      const [{ posts, next }, lb] = await Promise.all([
        api(`/posts?${qs}`),
        feedTab === 'irish_goodbye' && !append ? api('/posts/irish-goodbyes/leaderboard') : null,
        feedTab === 'regret' && !append ? api('/posts/regret-of-the-year').catch(() => null) : null,
      ]).then(([a, b, c]) => [a, b ?? c]);
      cursor = posts.length >= 30 ? next : null;
      rows = posts.map((p) => postCard(p));
      if (lb && feedTab === 'irish_goodbye') extra = leaderboard(lb.leaderboard);
      if (lb && feedTab === 'regret') extra = rotyCard(lb, () => load());
    }
    if (!alive()) return;
    more.hidden = !cursor;
    if (append) listEl.append(...rows);
    else fill(listEl, extra, rows.length ? rows : emptyFor(feedTab));
    if (focus) document.getElementById(`post-${focus}`)?.scrollIntoView({ block: 'center' });
  };
  more.onclick = () => load(true);
  await load();
  if (!alive()) return;

  const seg = h('div', { class: 'seg', role: 'tablist' },
    TABS.map(([k, label]) => h('button', { role: 'tab', class: feedTab === k ? 'on' : '', 'aria-selected': String(feedTab === k), onclick: () => { feedTab = k; go('/feed'); } }, label)));
  const quick = h('div', { class: 'pv-quick' },
    [['regret', '🌅 Confess'], ['quote', '🗣️ Overheard'], ['lost_item', '🧥 Lost something'], ['irish_goodbye', '👻 Irish goodbye']]
      .map(([k, l]) => h('a', { class: `btn sm ${k === newKind ? 'hot' : 'ghost'}`, href: `#/post/new?kind=${k}` }, l)));
  mount(shell({ tab: 'feed', fab: false }, head('Feed', 'What happened last night', null), quick, seg, listEl, more));
  liveRefresh(alive, () => load());
});

function emptyFor(tab) {
  return {
    all: empty('🌙', 'Quiet so far', 'Confess something. Somebody has to go first.'),
    regret: empty('🌅', 'No regrets', 'Either a quiet week or everyone’s lying.'),
    lost_item: empty('🧥', 'Nothing lost', 'Miraculous.'),
    irish_goodbye: empty('👻', 'Nobody ghosted', 'Everyone said bye. Suspicious.'),
  }[tab];
}

/** Re-load on live feed events while this view is on screen (core calls the current view's refresh). */
export function liveRefresh(alive, load) {
  setRefresh(() => { if (alive()) return load(); });
}

// ------------------------------------------------------------------ event page embed
/**
 * That night's quotes, regrets, goodbyes and lost items, for the event detail page.
 * Returns an element immediately and fills it in when loaded.
 */
export function eventPosts(event) {
  const id = typeof event === 'object' ? event.id : event;
  const box = h('section', { class: 'pv-event-posts' }, h('p', { class: 'muted small' }, 'Loading the damage…'));
  (async () => {
    try {
      await postsMeta();
      const { posts } = await api(`/posts?event=${id}&limit=100`);
      const group = (k, title) => {
        const list = posts.filter((p) => p.kind === k);
        return h('div', { class: 'pv-group' },
          h('div', { class: 'pv-group-head' }, h('h3', {}, `${title}${list.length ? ` · ${list.length}` : ''}`),
            h('a', { class: 'btn sm ghost', href: `#/post/new?kind=${k}&event=${id}` }, '＋')),
          list.map((p) => postCard(p, { showKind: false })));
      };
      fill(box,
        group('quote', '🗣️ Overheard'),
        group('regret', '🌅 The Morning After'),
        group('irish_goodbye', '👻 Left without saying bye'),
        group('lost_item', '🧥 Lost & Found'));
    } catch (e) {
      fill(box, h('p', { class: 'muted small' }, e.message));
    }
  })();
  return box;
}

export { KIND_LABEL, icon };
