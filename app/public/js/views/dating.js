// Dating (#/dating): opt-in Roster, date vetting ("has anyone met them?"), debrief cards.
// Aliases only. Everything you see about someone's love life, they posted themselves.
import { api, h, toast, route, go, shell, state, empty, ago, head, mount, setRefresh } from '../core.js';

const STATUS = { talking: '💬 talking', dating: '💘 dating', situationship: '🌀 situationship', benched: '🪑 benched', over: '🪦 over' };
const VERDICT = { again: '🔁 second date', never: '🚫 never again', tbd: '🤷 tbd' };

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
const left = (iso) => {
  const m = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60000));
  return m >= 60 ? `${Math.round(m / 60)}h left` : `${m} min left`;
};

function rosterSection(rosters, reload) {
  const me = state.user?.id;
  const alias = h('input', { placeholder: 'Finance Guy', maxlength: '40', required: true });
  const met = h('input', { placeholder: 'Hinge / Le Bain / a wedding', maxlength: '60' });
  const status = h('select', { 'aria-label': 'Status' }, Object.entries(STATUS).map(([k, v]) => h('option', { value: k }, v)));
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'kicker' }, '📋 The Roster'),
    h('p', { class: 'small' }, 'Opt in by adding your own. Aliases only. Nobody can add to yours.'),
    rosters.length
      ? rosters.map((r) =>
          h(
            'div',
            { class: 'roster' },
            h('strong', {}, `${r.emoji ? r.emoji + ' ' : ''}${r.name}`),
            h(
              'ul',
              { class: 'where' },
              r.entries.map((e) =>
                h(
                  'li',
                  {},
                  h('strong', {}, e.alias),
                  ` · ${STATUS[e.status]}`,
                  e.metAt ? h('span', { class: 'small' }, ` · met at ${e.metAt}`) : null,
                  r.userId === me
                    ? h(
                        'select',
                        {
                          class: 'inline',
                          'aria-label': `Update ${e.alias}`,
                          onchange: async (ev) => (await act(() => api(`/dating/roster/${e.id}`, { method: 'PATCH', body: { status: ev.target.value } }), 'Updated'), reload()),
                        },
                        Object.entries(STATUS).map(([k, v]) => h('option', { value: k, selected: k === e.status }, v)),
                      )
                    : null,
                  r.userId === me ? h('button', { class: 'btn ghost sm', onclick: async () => confirm(`Drop ${e.alias}?`) && (await act(() => api(`/dating/roster/${e.id}`, { method: 'DELETE' })), reload()) }, '✕') : null,
                ),
              ),
            ),
          ),
        )
      : h('p', { class: 'small' }, 'Nobody’s on the roster. Either very private or very single.'),
    h(
      'form',
      {
        class: 'row-wrap',
        onsubmit: async (e) => {
          e.preventDefault();
          await act(() => api('/dating/roster', { method: 'POST', body: { alias: alias.value, metAt: met.value, status: status.value } }), '📋 On the roster');
          reload();
        },
      },
      alias,
      met,
      status,
      h('button', { class: 'btn sm' }, 'Add to my roster'),
    ),
  );
}

function vetCard(v, reload) {
  const body = h('input', { placeholder: 'I know his ex. Run.', maxlength: '500', required: true });
  const met = h('input', { type: 'checkbox' });
  const vote = (value) => async () => (await act(() => api(`/dating/vets/${v.id}/vote`, { method: 'POST', body: { value: v.myVote === value ? 0 : value } })), reload());
  return h(
    'div',
    { class: 'poll' },
    h('div', { class: 'row-between' }, h('strong', {}, `${v.by}: “${v.alias}”`), h('span', { class: 'small' }, v.closed ? `verdict: ${v.verdict === 'go' ? '💚 go' : v.verdict === 'run' ? '🚩 run' : '🤷 split'}` : left(v.closesAt))),
    v.context ? h('p', { class: 'small' }, v.context) : null,
    h(
      'div',
      { class: 'row-wrap' },
      h('button', { class: `btn sm ${v.myVote === 1 ? '' : 'ghost'}`, disabled: v.closed, onclick: vote(1) }, `💚 Go ${v.go}`),
      h('button', { class: `btn sm ${v.myVote === -1 ? '' : 'ghost'}`, disabled: v.closed, onclick: vote(-1) }, `🚩 Run ${v.run}`),
      v.metCount ? h('span', { class: 'small' }, `👀 ${v.metCount} of us have met them`) : null,
      v.mine ? h('button', { class: 'btn ghost sm', onclick: async () => confirm('Delete this vetting?') && (await act(() => api(`/dating/vets/${v.id}`, { method: 'DELETE' })), reload()) }, '✕') : null,
    ),
    v.comments.length ? h('ul', { class: 'where' }, v.comments.map((c) => h('li', {}, c.metThem ? '👀 ' : '💬 ', h('strong', {}, c.name), ` ${c.body}`, h('span', { class: 'small' }, ` · ${ago(c.createdAt)}`)))) : null,
    h(
      'form',
      {
        class: 'row-wrap',
        onsubmit: async (e) => {
          e.preventDefault();
          await act(() => api(`/dating/vets/${v.id}/comments`, { method: 'POST', body: { body: body.value, metThem: met.checked } }));
          reload();
        },
      },
      body,
      h('label', { class: 'chip-check' }, met, 'I’ve met them'),
      h('button', { class: 'btn ghost sm' }, 'Say it'),
    ),
  );
}

function vetSection(vets, reload) {
  const alias = h('input', { placeholder: 'Hinge Theo', maxlength: '40', required: true });
  const context = h('input', { placeholder: '34, “in tech”, wants to go to Carbone on date one', maxlength: '300' });
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'kicker' }, '🕵️ Vetting'),
    vets.map((v) => vetCard(v, reload)),
    h(
      'form',
      {
        class: 'night-form',
        onsubmit: async (e) => {
          e.preventDefault();
          await act(() => api('/dating/vets', { method: 'POST', body: { alias: alias.value, context: context.value } }), '🕵️ The group has 24 hours');
          reload();
        },
      },
      h('p', { class: 'small' }, 'Put a date to the group: go or run, and has anyone met them?'),
      alias,
      context,
      h('button', { class: 'btn sm' }, 'Vet them'),
    ),
  );
}

function debriefSection(debriefs, reload) {
  const alias = h('input', { placeholder: 'who', maxlength: '40', required: true });
  const rating = h('input', { type: 'range', min: '1', max: '10', value: '6', 'aria-label': 'Rating' });
  const out = h('span', { class: 'cooked-label' }, '6/10');
  rating.addEventListener('input', () => (out.textContent = `${rating.value}/10`));
  const green = h('input', { placeholder: '🟢 green flags', maxlength: '300' });
  const red = h('input', { placeholder: '🚩 red flags', maxlength: '300' });
  const verdict = h('select', { 'aria-label': 'Verdict' }, Object.entries(VERDICT).map(([k, v]) => h('option', { value: k, selected: k === 'tbd' }, v)));
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'kicker' }, '📝 Debriefs'),
    debriefs.map((d) =>
      h(
        'div',
        { class: 'poll debrief' },
        h('div', { class: 'row-between' }, h('strong', {}, `${d.by} on “${d.alias}”`), h('span', { class: 'cooked-label' }, `${d.rating}/10`)),
        d.greenFlags ? h('div', {}, '🟢 ', d.greenFlags) : null,
        d.redFlags ? h('div', {}, '🚩 ', d.redFlags) : null,
        h('div', { class: 'row-wrap small' }, VERDICT[d.verdict], ` · ${ago(d.createdAt)}`, d.mine ? h('button', { class: 'btn ghost sm', onclick: async () => confirm('Delete?') && (await act(() => api(`/dating/debriefs/${d.id}`, { method: 'DELETE' })), reload()) }, '✕') : null),
      ),
    ),
    h(
      'form',
      {
        class: 'night-form',
        onsubmit: async (e) => {
          e.preventDefault();
          await act(() => api('/dating/debriefs', { method: 'POST', body: { alias: alias.value, rating: Number(rating.value), greenFlags: green.value, redFlags: red.value, verdict: verdict.value } }), '📝 Debrief posted');
          reload();
        },
      },
      h('div', { class: 'row-wrap' }, alias, out),
      rating,
      green,
      red,
      verdict,
      h('button', { class: 'btn sm' }, 'Post debrief'),
    ),
  );
}

route('/dating', async () => {
  const data = await api('/dating');
  const reload = () => go('/dating');
  setRefresh(reload);
  mount(
    shell(
      { title: 'Dating', tab: 'tonight', back: '/tonight' },
      head('For the group’s eyes only', '💘 Dating', 'The roster, the vetting, the debriefs.'),
      vetSection(data.vets, reload),
      debriefSection(data.debriefs, reload),
      rosterSection(data.rosters, reload),
    ),
  );
});

route('/dating/vet/:id', async ({ id }) => {
  const { vet } = await api(`/dating/vets/${id}`);
  const reload = () => go(`/dating/vet/${id}`);
  setRefresh(reload);
  mount(shell({ title: 'Vetting', tab: 'tonight', back: '/dating' }, h('section', { class: 'card' }, vetCard(vet, reload)), h('a', { class: 'btn ghost sm', href: '#/dating' }, 'All of dating →')));
});
void empty;
