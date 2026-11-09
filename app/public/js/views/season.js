// Season: trips (date polls, trip bible, room draft, kitty, awards, per-day archive),
// football (pick'em, squares, trash talk, bar tracker). Owns #/season/*.
import { api, h, toast, route, go, shell, state, empty, ago, head, fill, mount, setRefresh } from '../core.js';

const money = (c) => `$${(c / 100).toFixed(2)}`;
const fmt = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
async function act(path, body, method = 'POST') {
  try {
    return await api(path, { method, body: body ?? {} });
  } catch (e) {
    toast(e.message);
    throw e;
  }
}
const card = (...c) => h('div', { class: 'card stack' }, ...c);
const sec = (t, extra) => h('div', { class: 'row-between' }, h('h2', {}, t), extra || null);
const page = (title, back, ...content) => shell({ title, tab: 'events', back, fab: false }, h('div', { class: 'ev-detail' }, ...content));

/** Links shown on an event page for trips and game nights. */
export function seasonLinks(e) {
  if (e.kind === 'trip') return h('a', { class: 'btn block ghost', href: `#/season/trips/${e.id}` }, '🧳 Trip bible, rooms, kitty & awards');
  if (e.kind === 'game') return h('a', { class: 'btn block ghost', href: '#/season' }, "🏈 Pick'em, squares & bars");
  return null;
}

// ---------------------------------------------------------------- hub
route('/season', async (_p, alive) => {
  const wrap = h('div', { class: 'ev-detail' });
  const load = async () => {
    const [g, polls, bars] = await Promise.all([api('/season/games'), api('/season/polls'), api('/season/bars')]);
    if (!alive()) return;
    const teamInput = h('input', { value: g.myTeam || '', maxlength: 40, placeholder: 'Your team' });
    fill(wrap,
      card(sec("🏈 Pick'em", h('span', { class: 'small muted' }, `Season ${g.season}`)),
        g.leaderboard.length
          ? h('ol', { class: 'ev-bring-list' }, g.leaderboard.map((r) => h('li', {}, h('span', {}, `${r.emoji ? r.emoji + ' ' : ''}${r.name}`), h('strong', {}, `${r.wins}/${r.played}`))))
          : h('p', { class: 'small muted' }, 'No picks yet.'),
        g.hostsSuperBowl ? h('p', { class: 'small' }, `🛋️ Currently hosting the Super Bowl party: ${g.hostsSuperBowl.name}`) : null,
        h('form', { class: 'ev-chip-add', onsubmit: async (ev) => { ev.preventDefault(); await act('/season/team', { team: teamInput.value }); toast('Allegiance noted'); load(); } }, teamInput, h('button', { class: 'btn sm ghost', type: 'submit' }, 'Save team'))),
      card(sec('Games', h('button', { class: 'btn sm hot', onclick: () => addGame(load) }, '+ Game')),
        g.games.length
          ? g.games.map((x) => h('a', { class: 'row-between ev-game', href: `#/season/games/${x.id}` },
              h('div', {}, h('strong', {}, `${x.away} @ ${x.home}`), h('div', { class: 'small muted' }, x.final ? `Final ${x.awayScore}–${x.homeScore}` : `${fmt(x.kickoffAt)} · wk ${x.week}`)),
              h('span', { class: 'ev-tag' }, x.myPick ? `You: ${x.myPick}` : x.locked ? '🔒' : 'Pick')))
          : h('p', { class: 'small muted' }, 'Add this week’s games.')),
      card(sec('🗓️ Date polls', h('button', { class: 'btn sm ghost', onclick: () => addPoll(load) }, '+ Poll')),
        polls.polls.length
          ? polls.polls.map((p) => h('a', { class: 'row-between ev-game', href: `#/season/polls/${p.id}` }, h('strong', {}, p.title), h('span', { class: 'ev-tag' }, p.closed ? 'Decided' : `${p.options.reduce((s, o) => Math.max(s, o.count), 0)} best`)))
          : h('p', { class: 'small muted' }, 'Planning a trip? Start with which weekends work.')),
      card(sec('🍺 Bar tracker', h('button', { class: 'btn sm ghost', onclick: () => addBar(load) }, '+ Bar')),
        bars.bars.length
          ? bars.bars.map((b) => h('div', { class: 'stack ev-po' },
              h('div', { class: 'row-between' }, h('strong', {}, b.name), h('span', { class: 'small muted' }, b.neighborhood || '')),
              b.teams ? h('div', { class: 'small' }, `📺 ${b.teams}`) : null,
              h('div', { class: 'small muted' }, `🔊 ${b.sound ?? '–'} · 🍗 ${b.wings ?? '–'} · 🚶 ${b.lines ?? '–'} (${b.ratings})`),
              h('div', { class: 'ev-actions' }, ['sound', 'wings', 'lines'].map((k) =>
                h('select', { 'aria-label': `Rate ${k}`, onchange: async (ev) => { await act(`/season/bars/${b.id}/rate`, { [k]: Number(ev.target.value) }); load(); } },
                  h('option', { value: '' }, k), [1, 2, 3, 4, 5].map((n) => h('option', { value: n }, `${k} ${n}`)))))))
          : h('p', { class: 'small muted' }, 'Which bars show which teams? Rate them.')),
    );
  };
  await load();
  if (!alive()) return;
  mount(shell({ title: 'Season', tab: 'events', back: '/events', fab: false }, head('Season', 'Trips & football'), wrap));
  setRefresh(load);
});

function dialog(title, fields, onSubmit) {
  const dlg = h('dialog', { class: 'ev-dialog' });
  const err = h('p', { class: 'error', role: 'alert' });
  const form = h('form', { class: 'stack', onsubmit: async (ev) => { ev.preventDefault(); try { await onSubmit(new FormData(form)); dlg.close(); dlg.remove(); } catch (e) { err.textContent = e.message; } } },
    h('h2', {}, title), ...fields, err,
    h('div', { class: 'ev-actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => { dlg.close(); dlg.remove(); } }, 'Cancel'), h('button', { class: 'btn hot', type: 'submit' }, 'Save')));
  dlg.append(form);
  document.body.append(dlg);
  dlg.showModal();
}
const field = (label, attrs) => h('label', { class: 'field' }, label, h('input', attrs));

function addGame(reload) {
  dialog('Add a game', [
    field('Away', { name: 'away', required: true, maxlength: 40 }), field('Home', { name: 'home', required: true, maxlength: 40 }),
    field('Kickoff', { name: 'kickoff', type: 'datetime-local', required: true }), field('Week', { name: 'week', type: 'number', min: 1, max: 30, value: 1 }),
  ], async (fd) => { await api('/season/games', { method: 'POST', body: { away: fd.get('away'), home: fd.get('home'), kickoffAt: new Date(fd.get('kickoff')).toISOString(), week: Number(fd.get('week')) } }); reload(); });
}
function addBar(reload) {
  dialog('Add a bar', [field('Name', { name: 'name', required: true, maxlength: 80 }), field('Neighborhood', { name: 'neighborhood', maxlength: 60 }), field('Shows', { name: 'teams', maxlength: 200, placeholder: 'Giants, Jets, Premier League' })],
    async (fd) => { await api('/season/bars', { method: 'POST', body: Object.fromEntries(fd) }); reload(); });
}
function addPoll(reload) {
  const rows = h('div', { class: 'stack' });
  const addRow = () => rows.append(h('div', { class: 'ev-chip-add' }, h('input', { type: 'date', name: 's', required: true }), h('input', { type: 'date', name: 'e' })));
  addRow(); addRow();
  dialog('Which weekends work?', [field('Trip', { name: 'title', required: true, maxlength: 120, placeholder: 'Montauk, again' }), h('div', { class: 'field' }, 'Options (start, end)', rows), h('button', { type: 'button', class: 'btn sm ghost', onclick: addRow }, '+ Another weekend')],
    async (fd) => {
      const s = fd.getAll('s'), e = fd.getAll('e');
      const { poll } = await api('/season/polls', { method: 'POST', body: { title: fd.get('title'), options: s.map((v, i) => ({ startsOn: v, endsOn: e[i] || v })) } });
      reload();
      go(`/season/polls/${poll.id}`);
    });
}

// ---------------------------------------------------------------- date poll
route('/season/polls/:id', async ({ id }, alive) => {
  const wrap = h('div', { class: 'ev-detail' });
  const load = async () => {
    const { poll: p } = await api(`/season/polls/${id}`);
    if (!alive()) return;
    fill(wrap,
      head('Date poll', p.title, p.closed ? 'Decided.' : 'Tap every window you can do. Best overlap wins.'),
      card(p.options.map((o) =>
        h('div', { class: `ev-po ${o.id === p.chosenOptionId ? 'approved' : ''}` },
          h('div', { class: 'row-between' },
            h('strong', {}, `${o.startsOn}${o.endsOn !== o.startsOn ? ` → ${o.endsOn}` : ''}${o.label ? ` · ${o.label}` : ''}`),
            o.id === p.chosenOptionId ? h('span', { class: 'ev-tag live' }, '✅ This one') : o.leading ? h('span', { class: 'ev-tag hot' }, 'Leading') : null),
          h('div', { class: 'row-between' },
            h('span', { class: 'small muted' }, o.who.map((w) => w.name).join(', ') || 'Nobody yet'),
            p.closed ? null : h('button', { class: `btn sm ${o.mine ? 'hot' : 'ghost'}`, onclick: async () => { await act(`/season/polls/${p.id}/mark`, { optionId: o.id, on: !o.mine }); load(); } }, o.mine ? '✓ I can' : 'I can'))))),
      p.mine && !p.closed ? h('button', { class: 'btn block', onclick: async () => { await act(`/season/polls/${p.id}/close`); load(); } }, 'Lock in the best overlap') : null,
    );
  };
  await load();
  if (!alive()) return;
  mount(page('Date poll', '/season', wrap));
  setRefresh(load);
});

// ---------------------------------------------------------------- trip
route('/season/trips/:id', async ({ id }, alive) => {
  const wrap = h('div', { class: 'ev-detail' });
  const load = async () => {
    if (['TEXTAREA', 'INPUT'].includes(document.activeElement?.tagName)) return;
    const t = await api(`/season/trips/${id}`);
    if (!alive()) return;
    const b = t.bible || {};
    const bibleForm = h('form', { class: 'stack', onsubmit: async (ev) => { ev.preventDefault(); await act(`/season/trips/${id}/bible`, Object.fromEntries(new FormData(bibleForm)), 'PUT'); toast('Bible saved'); load(); } },
      [['flights', '✈️ Flights (who lands when)'], ['house', '🏠 The house'], ['packing', '🧳 Packing list'], ['itinerary', '🗺️ Itinerary'], ['reservations', '🍽️ Reservations']].map(([k, l]) =>
        h('label', { class: 'field' }, l, h('textarea', { name: k, rows: 3, maxlength: 8000 }, b[k] || ''))),
      h('div', { class: 'row-between' }, h('span', { class: 'small muted' }, b.editor ? `Last edit: ${b.editor}, ${ago(b.updated_at)}` : ''), h('button', { class: 'btn sm hot', type: 'submit' }, 'Save')));
    const roomLabel = h('input', { maxlength: 60, placeholder: 'Primary suite' });
    const roomBeds = h('input', { type: 'number', min: 1, max: 8, value: 2, class: 'ev-num' });
    const kAmt = h('input', { type: 'number', step: '0.01', min: '0.01', placeholder: '$' , class: 'ev-num' });
    const kMemo = h('input', { maxlength: 120, placeholder: 'Groceries, liquor run, the boat' });
    fill(wrap,
      head('Trip', t.event.title, `${t.crew.length} going`),
      card(sec('🛏️ Rooms'),
        t.rooms.length ? t.rooms.map((r) => h('div', { class: `ev-po ${t.myRoom === r.id ? 'approved' : ''}` },
          h('div', { class: 'row-between' }, h('strong', {}, `${r.label} · ${r.beds} bed${r.beds > 1 ? 's' : ''}`),
            t.draft?.myTurn && r.people.length < r.beds ? h('button', { class: 'btn sm hot', onclick: async () => { await act(`/season/trips/${id}/pick`, { roomId: r.id }); load(); } }, 'Take it') : null),
          h('span', { class: 'small muted' }, r.people.map((p) => p.name).join(', ') || 'Empty'))) : h('p', { class: 'small muted' }, 'No rooms yet.'),
        t.draft && !t.draft.done ? h('p', { class: 'small' }, `On the clock: ${t.draft.order.find((o) => o.id === t.draft.onClock)?.name ?? '?'} · order: ${t.draft.order.map((o) => o.name).join(' → ')}`) : null,
        t.event.mine && !t.draft ? [
          h('form', { class: 'ev-chip-add', onsubmit: async (ev) => { ev.preventDefault(); await act(`/season/trips/${id}/rooms`, { label: roomLabel.value, beds: Number(roomBeds.value) }); roomLabel.value = ''; load(); } }, roomLabel, roomBeds, h('button', { class: 'btn sm ghost', type: 'submit' }, 'Add')),
          t.rooms.length ? h('div', { class: 'ev-actions' },
            h('button', { class: 'btn sm', onclick: async () => { await act(`/season/trips/${id}/draft`, { mode: 'draft' }); load(); } }, '🛏️ Start the draft'),
            h('button', { class: 'btn sm ghost', onclick: async () => { await act(`/season/trips/${id}/draft`, { mode: 'random' }); load(); } }, '🎲 Random draw')) : null,
        ] : null),
      card(sec('💸 Kitty', h('strong', {}, money(t.kittyTotalCents))),
        t.kitty.map((k) => h('div', { class: 'row-between small' }, h('span', {}, `${k.payer}: ${k.memo}`), h('span', {}, money(k.amountCents)))),
        h('form', { class: 'ev-chip-add', onsubmit: async (ev) => { ev.preventDefault(); await act(`/season/trips/${id}/kitty`, { amount: kAmt.value, memo: kMemo.value }); kAmt.value = ''; kMemo.value = ''; load(); } }, kAmt, kMemo, h('button', { class: 'btn sm ghost', type: 'submit' }, 'Add')),
        h('p', { class: 'small muted' }, t.tabConnected ? 'Each spend is split evenly onto the Tab.' : 'Splitting to the Tab turns on once the Tab is installed.')),
      card(sec('🏆 Trip awards'),
        t.awards.map((a) => h('div', { class: 'row-between' },
          h('div', {}, h('strong', {}, a.category), h('div', { class: 'small muted' }, a.leader ? `Leading: ${a.leader.name} (${a.leader.votes})` : 'No votes')),
          h('select', { onchange: async (ev) => { if (ev.target.value) { await act(`/season/trips/${id}/awards`, { category: a.category, nomineeId: Number(ev.target.value) }); load(); } } },
            h('option', { value: '' }, 'Vote…'), t.crew.map((c) => h('option', { value: c.id, selected: a.myVote === c.id }, c.name)))))),
      card(sec('📖 Trip bible'), bibleForm),
      t.days.length ? card(sec('🗂️ Day by day'), t.days.map((d) => h('div', { class: 'row-between small' }, h('strong', {}, new Date(d.date + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })),
        h('span', { class: 'muted' }, [d.photos != null ? `📸 ${d.photos}` : null, d.quotes != null ? `💬 ${d.quotes}` : null, d.regrets != null ? `🫠 ${d.regrets}` : null].filter(Boolean).join(' · '))))) : null,
      h('a', { class: 'btn block ghost', href: `#/events/${id}` }, 'Back to the event'),
    );
  };
  await load();
  if (!alive()) return;
  mount(page('Trip', `/events/${id}`, wrap));
  setRefresh(load);
});

// ---------------------------------------------------------------- game
route('/season/games/:id', async ({ id }, alive) => {
  const wrap = h('div', { class: 'ev-detail' });
  const load = async () => {
    if (['TEXTAREA', 'INPUT'].includes(document.activeElement?.tagName)) return;
    const { game: g, talk, squares } = await api(`/season/games/${id}`);
    if (!alive()) return;
    const talkInput = h('input', { maxlength: 500, placeholder: g.locked ? 'Gloat.' : 'Trash talk' });
    const hs = h('input', { type: 'number', min: 0, class: 'ev-num', placeholder: g.home }), as = h('input', { type: 'number', min: 0, class: 'ev-num', placeholder: g.away });
    let grid = null;
    if (squares) {
      const cell = (r, c) => squares.cells.find((x) => x.r === r && x.c === c);
      grid = h('div', { class: 'sq-grid' },
        h('span', { class: 'sq-h' }, ''), Array.from({ length: 10 }, (_, c) => h('span', { class: 'sq-h' }, squares.cols ? squares.cols[c] : '?')),
        Array.from({ length: 10 }, (_, r) => [h('span', { class: 'sq-h' }, squares.rows ? squares.rows[r] : '?'),
          Array.from({ length: 10 }, (_, c) => {
            const x = cell(r, c);
            const win = squares.winner && squares.winner.r === r && squares.winner.c === c;
            return h('button', { class: `sq ${x ? 'taken' : ''} ${x && x.userId === state.user?.id ? 'mine' : ''} ${win ? 'win' : ''}`, title: x?.name || 'Open', disabled: squares.locked,
              onclick: async () => { await act(`/season/squares/${squares.id}/claim`, { r, c }); load(); } }, x ? (x.emoji || x.name[0]) : '');
          })]));
    }
    fill(wrap,
      head(`Week ${g.week}`, `${g.away} @ ${g.home}`, g.final ? `Final: ${g.away} ${g.awayScore}, ${g.home} ${g.homeScore}` : fmt(g.kickoffAt)),
      card(sec(g.locked ? '🔒 Picks' : 'Your pick'),
        g.locked ? null : h('div', { class: 'ev-actions' }, [g.away, g.home].map((t) => h('button', { class: `btn ${g.myPick === t ? 'hot' : 'ghost'}`, onclick: async () => { await act(`/season/games/${id}/pick`, { team: t }); load(); } }, t))),
        h('p', { class: 'small muted' }, g.locked ? g.picks.map((p) => `${p.name}: ${p.team}`).join(' · ') || 'No picks.' : `${g.pickCount} picked. Picks stay hidden until kickoff.`),
        g.locked && !g.final ? h('form', { class: 'ev-chip-add', onsubmit: async (ev) => { ev.preventDefault(); await act(`/season/games/${id}/score`, { homeScore: Number(hs.value), awayScore: Number(as.value) }); load(); } }, as, hs, h('button', { class: 'btn sm ghost', type: 'submit' }, 'Final score')) : null),
      card(sec('🔢 Squares', squares ? h('span', { class: 'small muted' }, squares.locked ? 'Locked' : `You have ${squares.mine}`) : h('button', { class: 'btn sm ghost', onclick: async () => { await act(`/season/games/${id}/squares`); load(); } }, 'Open a board')),
        grid,
        squares?.winner ? h('p', {}, `🏆 Winning square: ${squares.winner.name}`) : null,
        squares && !squares.locked && state.user?.isAdmin ? h('button', { class: 'btn sm', onclick: async () => { if (confirm('Lock the board and draw the numbers?')) { await act(`/season/squares/${squares.id}/lock`); load(); } } }, 'Lock & draw numbers') : null),
      card(sec('🗣️ Trash talk'),
        h('form', { class: 'ev-chip-add', onsubmit: async (ev) => { ev.preventDefault(); if (!talkInput.value.trim()) return; await act(`/season/games/${id}/talk`, { body: talkInput.value }); talkInput.value = ''; talkInput.blur(); load(); } }, talkInput, h('button', { class: 'btn sm ghost', type: 'submit' }, 'Send')),
        talk.length ? talk.map((t) => h('div', { class: 'small' }, h('strong', {}, `${t.emoji ? t.emoji + ' ' : ''}${t.name}${t.team ? ` (${t.team})` : ''}: `), t.body, h('span', { class: 'muted' }, ` · ${ago(t.createdAt)}`))) : empty('🤐', 'Quiet', 'Say something you’ll regret.')),
    );
  };
  await load();
  if (!alive()) return;
  mount(page('Game', '/season', wrap));
  setRefresh(load);
});
