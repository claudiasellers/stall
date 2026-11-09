// Tonight tab (#/tonight) and the per-event night panel: Home Safe roll call +
// buddies, Where We At, Next Move polls, Cooked Meter, and The Tab (#/tab).
import { api, h, toast, route, go, shell, state, empty, ago, head } from '../core.js';
import { eventCard } from './events.js';

// Styles live next to the view; CSP allows same-origin stylesheets.
if (!document.querySelector('link[data-night]')) {
  document.head.append(h('link', { rel: 'stylesheet', href: '/css/night.css', 'data-night': '1' }));
}

const money = (c) => `$${(Math.abs(c) / 100).toFixed(Math.abs(c) % 100 === 0 ? 0 : 2)}`;
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const left = (iso) => {
  const s = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 1000));
  return s >= 60 ? `${Math.ceil(s / 60)} min left` : `${s}s left`;
};
const q = (eventId) => (eventId ? `?eventId=${eventId}` : '');
const withEvent = (eventId, body) => (eventId ? { ...body, eventId } : body);

async function act(fn, ok) {
  try {
    const out = await fn();
    if (ok) toast(ok);
    return out;
  } catch (e) {
    toast(e.message);
    throw e;
  }
}

/** The current (live) or next event, if the events module provides one. Patch here if the API differs. */
async function loadCurrentEvent() {
  try {
    const { events } = await api('/events?scope=upcoming');
    return (events || [])[0] || null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ Home Safe

function defaultCutoff() {
  // Next 2am in local time, or 2 hours from now if that's sooner than 1 hour away.
  const d = new Date();
  d.setHours(2, 0, 0, 0);
  if (d.getTime() < Date.now() + 3600_000) d.setDate(d.getDate() + (d.getTime() < Date.now() ? 1 : 0));
  if (d.getTime() < Date.now() + 3600_000) return new Date(Date.now() + 2 * 3600_000);
  return d;
}
const toLocalInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

function startHomeSafeForm(eventId, reload) {
  const title = h('input', { placeholder: 'Tonight', maxlength: '80', value: eventId ? '' : 'Tonight' });
  const cutoff = h('input', { type: 'datetime-local', value: toLocalInput(defaultCutoff()) });
  return h(
    'form',
    {
      class: 'card night-form',
      onsubmit: async (e) => {
        e.preventDefault();
        await act(() => api('/night/sessions', { method: 'POST', body: withEvent(eventId, { title: title.value, cutoffAt: new Date(cutoff.value).toISOString() }) }), '🏠 Roll call is on. Buddies assigned.');
        reload();
      },
    },
    h('strong', {}, '🏠 Start Home Safe'),
    h('p', { class: 'small' }, 'Everyone gets a buddy. At the cutoff, everyone taps home. An hour later, buddies of anyone missing get pinged, then the whole group.'),
    h('label', {}, 'Name', title),
    h('label', {}, 'Cutoff', cutoff),
    h('button', { class: 'btn' }, 'Start roll call'),
  );
}

let watchId = null;
function toggleLocation(s, reload) {
  if (s.me?.sharingLocation || watchId !== null) {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    return act(() => api(`/night/sessions/${s.id}/location`, { method: 'POST', body: { stop: true } }), 'Stopped sharing').then(reload);
  }
  if (!navigator.geolocation) return toast('This phone can’t share location');
  let last = 0;
  watchId = navigator.geolocation.watchPosition(
    (p) => {
      if (Date.now() - last < 60_000) return; // at most once a minute
      last = Date.now();
      api(`/night/sessions/${s.id}/location`, { method: 'POST', body: { lat: p.coords.latitude, lng: p.coords.longitude } }).catch(() => {});
    },
    () => toast('Location permission denied'),
    { enableHighAccuracy: false, maximumAge: 60_000 },
  );
  toast('📍 Sharing with your buddy until you tap home');
  setTimeout(reload, 1500);
}

function homeSafeCard(s, reload) {
  const me = state.user?.id;
  const out = s.members.filter((m) => !m.home);
  const home = s.members.filter((m) => m.home);
  const myBuddies = s.members.filter((m) => m.isMyBuddy);
  const phaseLine = {
    out: `Cutoff ${clock(s.cutoffAt)}`,
    rollcall: `Roll call! Cutoff was ${clock(s.cutoffAt)}`,
    missing: `⚠️ Past the hour. Checking on stragglers`,
    closed: 'Closed',
  }[s.phase];
  const others = s.members.filter((m) => m.userId !== me);
  const pick = h('select', { 'aria-label': 'Pick your buddy' }, h('option', { value: '' }, 'Pick a buddy…'), others.map((m) => h('option', { value: m.userId }, m.name)));
  pick.addEventListener('change', async () => {
    if (!pick.value) return;
    await act(() => api(`/night/sessions/${s.id}/buddy`, { method: 'POST', body: { buddyId: Number(pick.value) } }), '🤝 Buddied up');
    reload();
  });
  return h(
    'section',
    { class: `card homesafe phase-${s.phase}` },
    h('div', { class: 'row-between' }, h('div', {}, h('div', { class: 'kicker' }, '🏠 Home Safe'), h('h3', {}, s.title)), h('div', { class: 'small' }, phaseLine)),
    !s.joined
      ? h('button', { class: 'btn', onclick: async () => (await act(() => api(`/night/sessions/${s.id}/join`, { method: 'POST' }), 'You’re on the roll call'), reload()) }, 'I’m out tonight, add me')
      : s.me.home
        ? h('div', { class: 'home-done' }, '✅ You’re home. Sleep it off.')
        : h(
            'div',
            {},
            h('button', { class: 'btn big home-btn', onclick: async () => (await act(() => api(`/night/sessions/${s.id}/home`, { method: 'POST' }), '🏠 Home safe. Proud of you.'), reload()) }, '🏠 I’m home'),
            h(
              'p',
              { class: 'small' },
              myBuddies.length ? ['Your buddy: ', h('strong', {}, myBuddies.map((b) => b.name).join(' & ')), '. You’re responsible for each other.'] : 'No buddy yet.',
            ),
            h(
              'div',
              { class: 'row-wrap' },
              pick,
              h('button', { class: 'btn ghost sm', onclick: () => toggleLocation(s, reload) }, s.me.sharingLocation ? '📍 Stop sharing location' : '📍 Share location with buddy'),
            ),
          ),
    myBuddies
      .filter((b) => b.location)
      .map((b) =>
        h(
          'a',
          { class: 'callout', href: `https://maps.apple.com/?q=${encodeURIComponent(b.name)}&ll=${b.location.lat},${b.location.lng}`, target: '_blank', rel: 'noopener' },
          `📍 ${b.name}’s location, ${ago(b.location.at)}`,
        ),
      ),
    h(
      'ul',
      { class: 'rollcall' },
      out.map((m) =>
        h(
          'li',
          { class: m.missing ? (m.escalation >= 3 ? 'missing loud' : 'missing') : '' },
          h('span', {}, m.missing ? '❓' : '🌙'),
          h('span', { class: 'who' }, m.name, m.isMyBuddy ? h('em', {}, ' your buddy') : null),
          h('span', { class: 'small' }, m.buddyName ? `w/ ${m.buddyName}` : 'no buddy'),
        ),
      ),
      home.map((m) => h('li', { class: 'home' }, h('span', {}, '🏠'), h('span', { class: 'who' }, m.name), h('span', { class: 'small' }, clock(m.homeAt)))),
    ),
    s.joined && s.startedBy === me && s.status === 'active'
      ? h(
          'div',
          { class: 'row-wrap' },
          h('button', { class: 'btn ghost sm', onclick: async () => (await act(() => api(`/night/sessions/${s.id}/shuffle`, { method: 'POST' }), '🔀 Reshuffled'), reload()) }, '🔀 Reshuffle buddies'),
          h(
            'button',
            {
              class: 'btn ghost sm',
              onclick: async () => {
                const at = new Date(Date.parse(s.cutoffAt) + 3600_000).toISOString();
                await act(() => api(`/night/sessions/${s.id}/cutoff`, { method: 'POST', body: { cutoffAt: at } }), 'Cutoff pushed an hour. Classic.');
                reload();
              },
            },
            '⏰ +1 hour',
          ),
          h('button', { class: 'btn ghost sm', onclick: async () => confirm('End the roll call for everyone?') && (await act(() => api(`/night/sessions/${s.id}/end`, { method: 'POST' })), reload()) }, 'End'),
        )
      : null,
  );
}

// ------------------------------------------------------------------ Where We At

function whereWeAtCard(trail, eventId, reload) {
  const venue = h('input', { placeholder: 'Le Bain', maxlength: '80', required: true });
  const next = h('input', { placeholder: 'moving to… (optional)', maxlength: '80' });
  const at = h('input', { type: 'time', 'aria-label': 'Around what time' });
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'kicker' }, '📍 Where we at'),
    trail.whereIsEveryone.length
      ? h('ul', { class: 'where' }, trail.whereIsEveryone.map((w) => h('li', {}, h('strong', {}, w.name), ` @ ${w.venue}`, w.nextVenue ? ` → ${w.nextVenue}` : '', h('span', { class: 'small' }, ` · ${ago(w.since)}`))))
      : h('p', { class: 'small' }, 'Nobody’s checked in yet. Venue names only, never GPS.'),
    trail.stops.length > 1 ? h('div', { class: 'trail' }, trail.stops.map((s, i) => [i ? h('span', { class: 'arrow' }, '→') : null, h('span', { class: 'stop' }, s.venue, h('small', {}, clock(s.firstAt)))])) : null,
    h(
      'form',
      {
        class: 'row-wrap',
        onsubmit: async (e) => {
          e.preventDefault();
          let nextAt;
          if (at.value) {
            const d = new Date();
            const [hh, mm] = at.value.split(':').map(Number);
            d.setHours(hh, mm, 0, 0);
            if (d.getTime() < Date.now() - 3600_000) d.setDate(d.getDate() + 1);
            nextAt = d.toISOString();
          }
          await act(() => api('/night/checkins', { method: 'POST', body: withEvent(eventId, { venue: venue.value, nextVenue: next.value, nextAt }) }), '📍 Checked in');
          reload();
        },
      },
      venue,
      next,
      at,
      h('button', { class: 'btn sm' }, 'Check in'),
    ),
  );
}

// ------------------------------------------------------------------ Next Move

function pollCard(p, reload) {
  const total = p.options.reduce((a, o) => a + o.votes, 0) || 1;
  return h(
    'div',
    { class: `poll ${p.closed ? 'closed' : ''}` },
    h('div', { class: 'row-between' }, h('strong', {}, p.question), h('span', { class: 'small' }, p.closed ? 'closed' : left(p.closesAt))),
    p.options.map((o) =>
      h(
        'button',
        {
          class: `poll-opt ${p.myOptionId === o.id ? 'mine' : ''} ${p.winnerOptionId === o.id ? 'winner' : ''}`,
          disabled: p.closed,
          onclick: async () => (await act(() => api(`/night/polls/${p.id}/vote`, { method: 'POST', body: { optionId: o.id } })), reload()),
        },
        h('span', { class: 'bar', style: `width:${Math.round((o.votes / total) * 100)}%` }),
        h('span', { class: 'lbl' }, p.winnerOptionId === o.id ? '🏆 ' : '', o.label),
        h('span', { class: 'n' }, o.votes, o.voters.length ? h('small', {}, ` ${o.voters.join(', ')}`) : null),
      ),
    ),
    h('div', { class: 'small' }, `by ${p.by} · ${ago(p.createdAt)}`),
  );
}

function nextMoveCard(polls, eventId, reload) {
  const opts = [0, 1, 2].map((i) => h('input', { placeholder: ['Paul’s Baby Grand', 'Bar Pisellino', 'Bed (coward)'][i], maxlength: '60' }));
  const open = polls.filter((p) => !p.closed);
  const recent = polls.filter((p) => p.closed).slice(0, 2);
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'kicker' }, '🗳️ Next move'),
    open.map((p) => pollCard(p, reload)),
    recent.map((p) => pollCard(p, reload)),
    !open.length
      ? h(
          'form',
          {
            class: 'night-form',
            onsubmit: async (e) => {
              e.preventDefault();
              await act(() => api('/night/polls', { method: 'POST', body: withEvent(eventId, { options: opts.map((o) => o.value).filter(Boolean) }) }), '🗳️ Poll’s out. 10 minutes.');
              reload();
            },
          },
          h('p', { class: 'small' }, 'Where next? Two or three options, ten minutes, majority wins, everyone gets pinged.'),
          opts,
          h('button', { class: 'btn sm' }, 'Put it to a vote'),
        )
      : null,
  );
}

// ------------------------------------------------------------------ Cooked Meter

function cookedCard(board, labels, eventId, reload) {
  const me = board.find((b) => b.userId === state.user?.id);
  const out = h('div', { class: 'cooked-label' }, me ? `${me.level}/10 · ${me.label}` : 'How cooked are you?');
  const slider = h('input', { type: 'range', min: '1', max: '10', step: '1', value: String(me?.level ?? 1), 'aria-label': 'Cooked level' });
  slider.addEventListener('input', () => (out.textContent = `${slider.value}/10 · ${labels[slider.value]}`));
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'kicker' }, '🥴 Cooked meter'),
    out,
    slider,
    h(
      'button',
      {
        class: 'btn sm',
        onclick: async () => {
          const r = await act(() => api('/night/cooked', { method: 'POST', body: withEvent(eventId, { level: Number(slider.value) }) }));
          toast(r.buddy ? `Logged. ${r.buddy.name} is your buddy now.` : `Logged: ${r.label}`);
          reload();
        },
      },
      'Report',
    ),
    board.length
      ? h('ul', { class: 'cooked' }, board.map((b) => h('li', { class: b.level >= 9 ? 'hot' : '' }, h('span', { class: 'lvl' }, b.level), h('span', {}, h('strong', {}, b.name), h('small', {}, ` ${b.label}`)), h('span', { class: 'small' }, ago(b.at)))))
      : null,
  );
}

// ------------------------------------------------------------------ The Tab

function tabSummaryCard(tab) {
  const owe = tab.iOwe.reduce((a, d) => a + d.cents, 0);
  const owed = tab.owedToMe.reduce((a, d) => a + d.cents, 0);
  return h(
    'a',
    { class: 'card tab-summary', href: '#/tab' },
    h('div', { class: 'kicker' }, '🧾 The tab'),
    h('div', { class: 'row-between' }, h('span', {}, 'You owe ', h('strong', {}, money(owe))), h('span', {}, 'Owed to you ', h('strong', {}, money(owed)))),
    tab.wallOfShame[0] ? h('p', { class: 'small' }, `Wall of Shame leader: ${tab.wallOfShame[0].from} owes ${tab.wallOfShame[0].to} ${money(tab.wallOfShame[0].cents)} (${tab.wallOfShame[0].days}d)`) : null,
    h('span', { class: 'small' }, 'Open the tab →'),
  );
}

async function members() {
  // Foundation exposes the member list; fall back gracefully if the path differs.
  for (const path of ['/members', '/users']) {
    try {
      const r = await api(path);
      return (r.members || r.users || []).map((m) => ({ id: m.id, name: m.displayName || m.display_name || m.username }));
    } catch {}
  }
  return [];
}

function expenseForm(people, eventId, reload) {
  const desc = h('input', { placeholder: 'the bottle, dinner, the car home', maxlength: '80', required: true });
  const amount = h('input', { type: 'number', inputmode: 'decimal', step: '0.01', min: '0.01', placeholder: '340.00', required: true });
  const payer = h('select', { 'aria-label': 'Who paid' }, people.map((p) => h('option', { value: p.id, selected: p.id === state.user?.id }, p.id === state.user?.id ? `${p.name} (me)` : p.name)));
  const boxes = people.map((p) => h('label', { class: 'chip-check' }, h('input', { type: 'checkbox', value: p.id, checked: true }), p.name));
  return h(
    'form',
    {
      class: 'card night-form',
      onsubmit: async (e) => {
        e.preventDefault();
        const splitWith = boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => Number(i.value));
        await act(() => api('/tab/expenses', { method: 'POST', body: withEvent(eventId, { description: desc.value, amount: Number(amount.value), payerId: Number(payer.value), splitWith }) }), '💸 On the tab');
        reload();
      },
    },
    h('strong', {}, 'Log who paid'),
    desc,
    h('div', { class: 'row-wrap' }, amount, payer),
    h('div', { class: 'small' }, 'Split evenly between:'),
    h('div', { class: 'row-wrap chips' }, boxes),
    h('button', { class: 'btn' }, 'Add to the tab'),
  );
}

function debtRow(d, mine, reload) {
  const settle = async () => {
    const amt = prompt(`How much did you pay ${d.to}?`, (d.cents / 100).toFixed(2));
    if (!amt) return;
    await act(() => api('/tab/settlements', { method: 'POST', body: { toId: d.toId, amount: Number(amt) } }), '✅ Settled');
    reload();
  };
  const gotPaid = async () => {
    const amt = prompt(`How much did ${d.from} pay you?`, (d.cents / 100).toFixed(2));
    if (!amt) return;
    await act(() => api('/tab/settlements', { method: 'POST', body: { fromId: d.fromId, toId: d.toId, amount: Number(amt) } }), '✅ Logged');
    reload();
  };
  return h(
    'li',
    { class: d.days >= 14 ? 'shame' : '' },
    h('span', {}, mine === 'owe' ? ['You owe ', h('strong', {}, d.to)] : mine === 'owed' ? [h('strong', {}, d.from), ' owes you'] : [h('strong', {}, d.from), ' → ', d.to]),
    h('span', { class: 'amt' }, money(d.cents), h('small', {}, ` ${d.days}d`)),
    mine === 'owe'
      ? h('span', { class: 'row-wrap' }, d.venmoUrl ? h('a', { class: 'btn sm', href: d.venmoUrl, target: '_blank', rel: 'noopener' }, 'Venmo') : null, h('button', { class: 'btn ghost sm', onclick: settle }, 'I paid'))
      : mine === 'owed'
        ? h('span', { class: 'row-wrap' }, d.requestUrl ? h('a', { class: 'btn ghost sm', href: d.requestUrl, target: '_blank', rel: 'noopener' }, 'Request') : null, h('button', { class: 'btn ghost sm', onclick: gotPaid }, 'Got it'))
        : null,
  );
}

async function tabView(eventId) {
  const [tab, people] = await Promise.all([api(`/tab${q(eventId)}`), members()]);
  const reload = () => go(location.hash.replace(/^#/, '')); // re-render current route
  const venmo = h('input', { placeholder: 'your-venmo', value: tab.myVenmo || '', maxlength: '40' });
  return [
    head('The damage', '🧾 The Tab', 'Who covered what, who owes whom, and for how long.'),
    tab.iOwe.length ? h('section', { class: 'card' }, h('div', { class: 'kicker' }, 'You owe'), h('ul', { class: 'debts' }, tab.iOwe.map((d) => debtRow(d, 'owe', reload)))) : null,
    tab.owedToMe.length ? h('section', { class: 'card' }, h('div', { class: 'kicker' }, 'Owed to you'), h('ul', { class: 'debts' }, tab.owedToMe.map((d) => debtRow(d, 'owed', reload)))) : null,
    people.length ? expenseForm(people, eventId, reload) : null,
    h(
      'section',
      { class: 'card wall' },
      h('div', { class: 'kicker' }, '🪦 Debt Wall of Shame'),
      tab.wallOfShame.length ? h('ul', { class: 'debts' }, tab.wallOfShame.map((d) => debtRow(d, null, reload))) : h('p', { class: 'small' }, 'Everyone’s square. Suspicious.'),
    ),
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'kicker' }, 'Recent'),
      tab.expenses.length
        ? h(
            'ul',
            { class: 'expenses' },
            tab.expenses.map((e) =>
              h(
                'li',
                {},
                h('div', {}, h('strong', {}, e.description), h('div', { class: 'small' }, `${e.payer} paid ${money(e.amountCents)} · ${e.shares.length} way split · ${ago(e.createdAt)}`)),
                e.canDelete ? h('button', { class: 'btn ghost sm', onclick: async () => confirm('Delete this?') && (await act(() => api(`/tab/expenses/${e.id}`, { method: 'DELETE' })), reload()) }, '✕') : null,
              ),
            ),
          )
        : empty
          ? empty('🧾', 'Nothing on the tab yet')
          : h('p', { class: 'small' }, 'Nothing on the tab yet'),
    ),
    h(
      'form',
      {
        class: 'card row-wrap',
        onsubmit: async (e) => {
          e.preventDefault();
          await act(() => api('/tab/venmo', { method: 'POST', body: { venmo: venmo.value } }), 'Saved. People can pay you in one tap now.');
        },
      },
      h('span', { class: 'small' }, 'Your Venmo @'),
      venmo,
      h('button', { class: 'btn ghost sm' }, 'Save'),
    ),
  ];
}

// ------------------------------------------------------------------ composition

async function nightSections(eventId, reload, { showTab = true } = {}) {
  const [night, tab] = await Promise.all([api(`/night${q(eventId)}`), showTab ? api(`/tab${q(eventId)}`).catch(() => null) : null]);
  const sessions = night.sessions;
  return [
    sessions.length ? sessions.map((s) => homeSafeCard(s, reload)) : startHomeSafeForm(eventId, reload),
    whereWeAtCard(night.trail, eventId, reload),
    nextMoveCard(night.polls, eventId, reload),
    cookedCard(night.cooked, night.cookedLabels, eventId, reload),
    tab ? tabSummaryCard(tab) : null,
  ];
}

/** Mounted by the event detail page. Returns a node that loads itself. */
export function nightPanel(event) {
  const box = h('div', { class: 'night-panel' }, h('p', { class: 'small' }, 'Loading tonight…'));
  if (event?.phase === 'archived') {
    box.replaceChildren(h('p', { class: 'small' }, 'The night is over. See the tab for what’s still owed.'), h('a', { class: 'btn ghost sm', href: '#/tab' }, '🧾 The tab'));
    return box;
  }
  const load = async () => {
    try {
      const nodes = await nightSections(event.id, load);
      box.replaceChildren(...nodes.flat(Infinity).filter(Boolean));
    } catch (e) {
      box.replaceChildren(h('p', { class: 'small' }, e.message));
    }
  };
  load();
  return box;
}

route('/tonight', async (_p, alive) => {
  const render = async () => {
    const event = await loadCurrentEvent();
    const live = event && (event.phase === 'live' || !event.phase);
    const sections = await nightSections(live ? event.id : null, render);
    if (alive && !alive()) return;
    const main = shell(
      { title: 'Tonight', tab: 'tonight' },
      head(new Date().toLocaleDateString([], { weekday: 'long' }), 'Tonight', 'Where we at, who’s cooked, and who made it home.'),
      event ? eventCard(event) : null,
      ...sections,
    );
    document.getElementById('app').replaceChildren(main);
  };
  await render();
  // Poll timers and roll call move on their own; refresh while the tab is open.
  const t = setInterval(() => (alive && !alive() ? clearInterval(t) : document.visibilityState === 'visible' && render().catch(() => {})), 30_000);
});

route('/tonight/poll/:id', async ({ id }) => {
  const { poll } = await api(`/night/polls/${id}`);
  const reload = () => go(`/tonight/poll/${id}`);
  document.getElementById('app').replaceChildren(shell({ title: 'Next move', tab: 'tonight', back: '/tonight' }, h('section', { class: 'card' }, pollCard(poll, reload))));
});

route('/tab', async () => {
  document.getElementById('app').replaceChildren(shell({ title: 'The Tab', tab: 'tonight', back: '/tonight' }, ...(await tabView(null))));
});
