// Events: the Partiful core. Owns #/events, #/events/new, #/events/:id and the
// public #/guest/:token card. Exports eventCard(e) for Tonight.
import { api, h, toast, route, go, shell, state, empty, ago, head, fill, mount as coreMount, setRefresh } from '../core.js';
import { photoSection } from './photos.js';
import { eventPosts } from './feed.js';
import { nightPanel } from './night.js';
import { seasonLinks } from './season.js';

// Styles live next to the view; CSP allows same-origin stylesheets.
if (!document.querySelector('link[data-events-css]')) {
  document.head.append(h('link', { rel: 'stylesheet', href: '/css/events.css', 'data-events-css': '1' }));
}

export const RSVP = [
  ['in', '🙋', 'In'],
  ['maybe', '🤥', 'Maybe (lying)'],
  ['late', '🐢', 'Coming late'],
  ['afters', '🌙', 'Afters only'],
  ['save_drink', '🥂', 'Save me a drink'],
  ['out', '🫡', 'Out'],
];
const RSVP_LABEL = Object.fromEntries(RSVP.map(([k, e, l]) => [k, `${e} ${l}`]));
const KINDS = [
  ['party', '🪩 Party'],
  ['dinner', '🍝 Dinner'],
  ['birthday', '🎂 Birthday'],
  ['game', '🏈 Game'],
  ['trip', '✈️ Trip'],
];
const VIBES = [
  'dress code: expensive but tired',
  'dress code: divorced dad at the Hamptons',
  'bring your worst ex story',
  'phones face down, mostly',
  'we are not going to Bushwick',
  'black tie optional, chaos mandatory',
];

// ---------------------------------------------------------------- time helpers
const fmtDay = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fmtTime = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
function until(iso) {
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  if (s <= 0) return 'now';
  if (s < 3600) return `in ${Math.ceil(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}
const localInput = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const toIso = (v) => (v ? new Date(v).toISOString() : undefined);

// ---------------------------------------------------------------- pieces
function posterEl(e, big) {
  const p = e.poster || { from: '#ff4fa3', to: '#ff8a3d', angle: 135 };
  return h(
    'div',
    { class: `ev-poster ${big ? 'big' : ''}`, style: `background:linear-gradient(${p.angle}deg, ${p.from}, ${p.to})`, 'aria-hidden': 'true' },
    h('span', { class: 'ev-emoji' }, e.coverEmoji || '🪩'),
    big && e.vibe ? h('span', { class: 'ev-vibe-stamp' }, e.vibe) : null,
  );
}

const phaseTag = (e) =>
  e.cancelled ? h('span', { class: 'ev-tag dead' }, '🪦 Cancelled')
  : e.kind === 'spontaneous' ? h('span', { class: 'ev-tag hot' }, `📍 Out now · ends ${until(e.expiresAt)}`)
  : e.phase === 'live' ? h('span', { class: 'ev-tag live' }, '🔴 Happening')
  : e.phase === 'archived' ? h('span', { class: 'ev-tag' }, '🗂️ Archive')
  : h('span', { class: 'ev-tag' }, until(e.startsAt));

function faces(list, max = 6) {
  if (!list?.length) return null;
  return h(
    'div',
    { class: 'ev-faces' },
    list.slice(0, max).map((f) => h('span', { class: 'ev-face', title: `${f.name}: ${RSVP_LABEL[f.status] || ''}` }, f.emoji || (f.name || '?')[0].toUpperCase())),
    list.length > max ? h('span', { class: 'ev-face more' }, `+${list.length - max}`) : null,
  );
}

/** Compact invite card. Tonight and the Events list both use it. */
export function eventCard(e) {
  return h(
    'a',
    { class: `card ev-card ${e.cancelled ? 'cancelled' : ''} ${e.kind === 'spontaneous' ? 'spont' : ''}`, href: `#/events/${e.id}` },
    posterEl(e),
    h(
      'div',
      { class: 'ev-body' },
      h('div', { class: 'ev-title' }, e.title),
      e.vibe ? h('div', { class: 'ev-vibe' }, e.vibe) : null,
      h(
        'div',
        { class: 'meta' },
        phaseTag(e),
        e.kind !== 'spontaneous' ? h('span', {}, `${fmtDay(e.startsAt)} · ${fmtTime(e.startsAt)}`) : null,
        h('span', {}, `${e.host?.emoji ? e.host.emoji + ' ' : ''}${e.mine ? 'You' : e.host?.name}`),
      ),
      h('div', { class: 'ev-foot' }, faces(e.faces, 5), h('span', { class: 'small muted' }, `${e.going} going`), e.myRsvp ? h('span', { class: `ev-mine s-${e.myRsvp}` }, RSVP_LABEL[e.myRsvp]) : null),
    ),
  );
}

function rsvpPicker(current, onPick, { compact = false } = {}) {
  return h(
    'div',
    { class: `ev-rsvp ${compact ? 'compact' : ''}`, role: 'radiogroup', 'aria-label': 'Your RSVP' },
    RSVP.map(([k, emo, label]) =>
      h('button', {
        type: 'button',
        role: 'radio',
        'aria-checked': String(current === k),
        class: `s-${k} ${current === k ? 'on' : ''}`,
        onclick: () => onPick(k),
      }, h('span', { class: 'e' }, emo), compact ? null : h('span', { class: 'l' }, label)),
    ),
  );
}

async function act(path, body, method = 'POST') {
  try {
    return await api(path, { method, body: body ?? {} });
  } catch (e) {
    toast(e.message);
    throw e;
  }
}

// ---------------------------------------------------------------- list
let listScope = 'upcoming';
route('/events', async (_p, alive) => {
  const listEl = h('div', { class: 'list' });
  const load = async () => {
    const { events } = await api(`/events?scope=${listScope}`);
    if (!alive()) return;
    const spont = events.filter((e) => e.kind === 'spontaneous');
    const rest = events.filter((e) => e.kind !== 'spontaneous');
    fill(
      listEl,
      spont.length ? h('div', { class: 'section-h' }, h('h2', {}, '📍 Out right now')) : null,
      spont.map(eventCard),
      spont.length && rest.length ? h('div', { class: 'section-h' }, h('h2', {}, listScope === 'past' ? 'The archive' : 'Coming up')) : null,
      rest.length || spont.length
        ? rest.map(eventCard)
        : listScope === 'past'
          ? empty('🗂️', 'No nights in the archive yet', 'Every event turns into its own archive when the night ends.')
          : empty('🛋️', 'Nothing planned', 'Somebody host something. Or hit Out now and see who bites.'),
    );
  };
  const seg = h(
    'div',
    { class: 'seg', role: 'tablist' },
    [['upcoming', '🗓️ Upcoming'], ['past', '🗂️ Archive']].map(([k, l]) =>
      h('button', { role: 'tab', class: listScope === k ? 'on' : '', 'aria-selected': String(listScope === k), onclick: () => { listScope = k; go('/events'); load(); } }, l),
    ),
  );
  await load();
  if (!alive()) return;
  mount(
    shell(
      { title: 'Events', tab: 'events', fab: false },
      h('div', { class: 'page-head row-between' }, h('div', {}, h('div', { class: 'kicker' }, 'Meet me in the Stall'), h('h1', {}, 'Events')),
        h('div', { class: 'ev-actions' },
          h('button', { class: 'btn sm ghost', onclick: () => go('/season') }, '🏈 Season'),
          h('button', { class: 'btn sm ghost', onclick: () => go('/events/new?kind=spontaneous') }, '📍 Out now'),
          h('button', { class: 'btn sm hot', onclick: () => go('/events/new') }, '💌 Host'))),
      seg,
      listEl,
    ),
    load,
  );
});

// ---------------------------------------------------------------- create
route('/events/new(?:\\?.*)?', async () => {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const spontaneous = q.get('kind') === 'spontaneous';
  const err = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { class: 'btn block hot', type: 'submit' }, spontaneous ? '📍 Send it to everyone' : '💌 Send the invite');

  if (spontaneous) {
    const form = h(
      'form',
      {
        class: 'stack',
        onsubmit: async (ev) => {
          ev.preventDefault();
          submit.disabled = true;
          err.textContent = '';
          const fd = new FormData(form);
          try {
            const res = await api('/events', { method: 'POST', body: { kind: 'spontaneous', title: fd.get('title') || `Out at ${fd.get('location')}`, location: fd.get('location'), vibe: fd.get('vibe') } });
            toast('Sent. Now we wait 📍');
            go(`/events/${res.event.id}`);
          } catch (e) {
            err.textContent = e.message;
            submit.disabled = false;
          }
        },
      },
      h('label', { class: 'field' }, 'Where are you?', h('input', { name: 'location', required: true, maxlength: 300, placeholder: 'Le Bain, the roof' })),
      h('label', { class: 'field' }, 'Say something', h('small', {}, 'Optional'), h('input', { name: 'title', maxlength: 120, placeholder: 'Out right now, come through' })),
      h('label', { class: 'field' }, 'Vibe', h('small', {}, 'Optional'), h('input', { name: 'vibe', maxlength: 200, placeholder: 'one drink (lie)' })),
      h('p', { class: 'small muted' }, 'Everyone gets a buzz. It disappears for good after 4 hours.'),
      err,
      submit,
    );
    mount(shell({ title: 'Out now', tab: 'events', back: '/events', fab: false }, head('Spontaneous', 'Out right now?'), form));
    form.querySelector('input').focus();
    return;
  }

  const start = new Date();
  start.setDate(start.getDate() + (start.getHours() >= 18 ? 1 : 0));
  start.setHours(21, 0, 0, 0);
  const stagesBox = h('div', { class: 'ev-chips-edit' });
  const stageList = [];
  const bringBox = h('div', { class: 'ev-chips-edit' });
  const bringList = ['Ice', 'Mixers', 'The aux cable', 'Someone with a car'];
  const chipEditor = (box, list, placeholder) => {
    const input = h('input', { type: 'text', maxlength: 80, placeholder, onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } } });
    const add = () => {
      const v = input.value.trim();
      if (v && !list.includes(v)) list.push(v);
      input.value = '';
      draw();
    };
    const draw = () =>
      fill(box,
        list.map((v, i) => h('span', { class: 'ev-chip' }, v, h('button', { type: 'button', 'aria-label': `Remove ${v}`, onclick: () => { list.splice(i, 1); draw(); } }, '×'))),
        h('div', { class: 'ev-chip-add' }, input, h('button', { type: 'button', class: 'btn sm ghost', onclick: add }, 'Add')));
    draw();
  };
  chipEditor(stagesBox, stageList, 'Dinner, Bar, Club, Afters…');
  chipEditor(bringBox, bringList, 'Wine, a speaker…');

  const startInput = h('input', { type: 'datetime-local', name: 'startsAt', required: true, value: localInput(start) });
  const realInput = h('input', { type: 'datetime-local', name: 'realStartsAt', value: localInput(new Date(start.getTime() + 90 * 60000)) });
  startInput.addEventListener('change', () => {
    const d = new Date(startInput.value);
    if (!Number.isNaN(d.getTime())) realInput.value = localInput(new Date(d.getTime() + 90 * 60000));
  });

  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (ev) => {
        ev.preventDefault();
        submit.disabled = true;
        err.textContent = '';
        const fd = new FormData(form);
        try {
          const res = await api('/events', {
            method: 'POST',
            body: {
              kind: fd.get('kind'),
              title: fd.get('title'),
              vibe: fd.get('vibe'),
              details: fd.get('details'),
              startsAt: toIso(fd.get('startsAt')),
              realStartsAt: toIso(fd.get('realStartsAt')),
              endsAt: toIso(fd.get('endsAt')),
              location: fd.get('location'),
              revealHoursBefore: fd.get('reveal'),
              recurrence: fd.get('recurrence') || null,
              stages: stageList,
              bring: bringList,
            },
          });
          toast('Invite sent 💌');
          go(`/events/${res.event.id}`);
        } catch (e) {
          err.textContent = e.message;
          submit.disabled = false;
        }
      },
    },
    h('div', { class: 'seg ev-kind', role: 'radiogroup' },
      KINDS.map(([k, l], i) => h('label', { class: 'ev-kind-opt' }, h('input', { type: 'radio', name: 'kind', value: k, checked: i === 0 }), h('span', {}, l)))),
    h('label', { class: 'field' }, 'What is it', h('input', { name: 'title', required: true, minlength: 2, maxlength: 120, placeholder: 'Jess turns 30 (again)' })),
    h('label', { class: 'field' }, 'Vibe', h('small', {}, 'One line. Make it a threat.'), h('input', { name: 'vibe', maxlength: 200, placeholder: VIBES[Math.floor(Math.random() * VIBES.length)] })),
    h('label', { class: 'field' }, 'Time on the invite', startInput),
    h('label', { class: 'field' }, 'Real start time', h('small', {}, 'When people will actually show up. Defaults to 90 minutes later.'), realInput),
    h('label', { class: 'field' }, 'Night ends', h('small', {}, 'Optional. After this it turns into the archive (default: 8 hours after the real start).'), h('input', { type: 'datetime-local', name: 'endsAt' })),
    h('label', { class: 'field' }, 'Address', h('small', {}, 'Hidden until the drop, so it can’t get forwarded around.'), h('input', { name: 'location', maxlength: 300, placeholder: '123 Orchard St, buzz 4R' })),
    h('label', { class: 'field' }, 'Address drops',
      h('select', { name: 'reveal' },
        h('option', { value: '' }, `House default (${state.config?.house?.locationRevealHours ?? 2}h before)`),
        h('option', { value: '0' }, 'Show it now'),
        h('option', { value: '1' }, '1 hour before'),
        h('option', { value: '2' }, '2 hours before'),
        h('option', { value: '6' }, '6 hours before'),
        h('option', { value: '24' }, 'The day before'))),
    h('div', { class: 'field' }, 'Stages', h('small', {}, 'Optional. Rolling night? People RSVP per stage and see where the group is now.'), stagesBox),
    h('div', { class: 'field' }, 'Bring list', h('small', {}, 'People claim these.'), bringBox),
    h('label', { class: 'field' }, 'Repeats',
      h('select', { name: 'recurrence' },
        h('option', { value: '' }, 'Just this once'),
        h('option', { value: 'weekly' }, 'Every week (Sunday football)'),
        h('option', { value: 'biweekly' }, 'Every two weeks'),
        h('option', { value: 'monthly' }, 'Every month (family meal)'))),
    h('label', { class: 'field' }, 'Details', h('small', {}, 'Optional'), h('textarea', { name: 'details', rows: 3, maxlength: 4000, placeholder: 'Dinner at 9, we are NOT splitting the bill evenly this time.' })),
    err,
    submit,
  );
  // Templates (admin-managed): one tap fills the form.
  const tplBox = h('div', { class: 'seg' });
  api('/season/templates').then(({ templates }) => {
    fill(tplBox, templates.map((t) => h('button', { type: 'button', onclick: () => applyTemplate(t) }, t.name)));
  }).catch(() => tplBox.remove());
  const applyTemplate = (t) => {
    const set = (n, v) => { const el = form.elements[n]; if (el && v != null) el.value = v; };
    const radio = form.querySelector(`input[name=kind][value="${t.kind}"]`);
    if (radio) radio.checked = true;
    set('title', t.title);
    set('vibe', t.vibe);
    set('details', t.details);
    set('recurrence', t.recurrence || '');
    const d = new Date();
    if (t.weekday != null) d.setDate(d.getDate() + ((t.weekday - d.getDay() + 7) % 7 || 7));
    else d.setDate(d.getDate() + 1);
    d.setHours(t.start_hour ?? 21, 0, 0, 0);
    startInput.value = localInput(d);
    realInput.value = localInput(new Date(d.getTime() + (t.kind === 'game' ? 0 : 90 * 60000)));
    stageList.splice(0, stageList.length, ...(t.stages || []));
    bringList.splice(0, bringList.length, ...(t.bring || []));
    chipEditor(stagesBox, stageList, 'Dinner, Bar, Club, Afters…');
    chipEditor(bringBox, bringList, 'Wine, a speaker…');
    toast(`${t.name} template loaded`);
  };
  mount(shell({ title: 'Host', tab: 'events', back: '/events', fab: false }, head('New event', 'Throw something'), h('p', { class: 'small muted' }, 'Start from a template'), tplBox, form));
});

// ---------------------------------------------------------------- detail
route('/events/:id', async ({ id }, alive) => {
  const wrap = h('div', { class: 'ev-detail' });
  // Other modules' sections are mounted once and survive refreshes of this page.
  let extras = null;
  const load = async () => {
    if (['TEXTAREA', 'INPUT'].includes(document.activeElement?.tagName)) return;
    const d = await api(`/events/${id}`);
    if (!alive()) return;
    const e = d.event;
    const reload = () => load().catch(() => {});

    const hero = h(
      'div',
      { class: 'ev-hero' },
      posterEl(e, true),
      h('div', { class: 'meta' }, phaseTag(e), e.recurrence ? h('span', { class: 'ev-tag' }, `🔁 ${e.recurrence}`) : null),
      h('h1', {}, e.title),
      h('div', { class: 'ev-host' }, 'Hosted by ', h('strong', {}, `${e.host.emoji ? e.host.emoji + ' ' : ''}${e.mine ? 'you' : e.host.name}`)),
      e.kind !== 'spontaneous'
        ? h('dl', { class: 'ev-facts' },
            h('dt', {}, 'Invite says'), h('dd', {}, `${fmtDay(e.startsAt)} · ${fmtTime(e.startsAt)}`),
            e.realStartsAt !== e.startsAt ? [h('dt', {}, 'Real start'), h('dd', {}, h('strong', {}, fmtTime(e.realStartsAt)), h('span', { class: 'muted small' }, ' (be honest)'))] : null,
            h('dt', {}, 'Where'),
            h('dd', {}, e.location ? e.location : e.locationHidden ? h('span', { class: 'ev-locked' }, `🔒 Address drops ${until(e.locationRevealAt)} (${fmtDay(e.locationRevealAt)} ${fmtTime(e.locationRevealAt)})`) : h('span', { class: 'muted' }, 'TBD')))
        : h('dl', { class: 'ev-facts' }, h('dt', {}, 'Where'), h('dd', {}, e.location || '?'), h('dt', {}, 'Vanishes'), h('dd', {}, until(e.expiresAt))),
      e.mine && e.location && e.locationRevealAt && new Date(e.locationRevealAt) > new Date() ? h('p', { class: 'small muted' }, '🔒 Only you can see the address until it drops.') : null,
      e.details ? h('p', { class: 'desc' }, e.details) : null,
    );

    // RSVP
    const rsvpBox = d.can.rsvp
      ? h('div', { class: 'card ev-rsvp-card' },
          h('h2', {}, e.myRsvp ? 'Your RSVP' : 'Are you coming? Be honest.'),
          rsvpPicker(e.myRsvp, async (k) => { await act(`/events/${e.id}/rsvp`, { status: k }); toast(`${RSVP_LABEL[k]}. Everyone will know if you change it.`); reload(); }),
          h('p', { class: 'small muted' }, 'Changing your RSVP gets announced to the group.'))
      : null;

    // Stages
    const stages = d.stages.length
      ? h('div', { class: 'card ev-stages' },
          h('h2', {}, 'The route'),
          h('ol', { class: 'ev-stage-list' },
            d.stages.map((s) =>
              h('li', { class: s.current ? 'now' : '' },
                h('div', { class: 'row-between' },
                  h('div', {}, h('strong', {}, s.title), s.current ? h('span', { class: 'ev-tag live' }, '📍 We’re here') : null),
                  d.can.moveStage && !s.current ? h('button', { class: 'btn sm ghost', onclick: async () => { await act(`/events/${e.id}/stage`, { stageId: s.id }); reload(); } }, 'Move here') : null),
                h('div', { class: 'row-between' },
                  faces(s.people, 8) || h('span', { class: 'small muted' }, 'Nobody yet'),
                  d.can.rsvp ? rsvpPicker(s.myRsvp, async (k) => { await act(`/events/${s.id}/rsvp`, { status: k }); reload(); }, { compact: true }) : null)))))
      : null;

    // Who's coming
    const groups = RSVP.map(([k]) => [k, d.rsvps.filter((r) => r.status === k), d.guests.filter((g) => g.status === k)]).filter(([, a, b]) => a.length || b.length);
    const people = h('div', { class: 'card ev-people' },
      h('div', { class: 'row-between' }, h('h2', {}, 'The list'), h('span', { class: 'small muted' }, `${e.going} going`)),
      groups.length
        ? groups.map(([k, ms, gs]) =>
            h('div', { class: 'ev-group' },
              h('div', { class: `ev-group-h s-${k}` }, RSVP_LABEL[k], h('span', { class: 'n' }, ms.length + gs.length)),
              h('div', { class: 'ev-names' },
                ms.map((m) => h('span', { class: 'ev-name' }, `${m.emoji ? m.emoji + ' ' : ''}${m.name}`, m.note ? h('em', {}, ` “${m.note}”`) : null)),
                gs.map((g) => h('span', { class: 'ev-name guest' }, `${g.name} (guest)`)))))
        : h('p', { class: 'small muted' }, 'Nobody has answered yet.'));

    // Plus-ones
    const plusOnes = h('div', { class: 'card ev-plusones' },
      h('div', { class: 'row-between' }, h('h2', {}, 'Plus-ones'), d.can.plusOne ? h('button', { class: 'btn sm ghost', onclick: () => plusOneForm(e, reload) }, '🕵️ Bring someone') : null),
      d.plusOnes.length
        ? d.plusOnes.map((p) =>
            h('div', { class: `ev-po ${p.status}` },
              h('div', { class: 'ev-po-h' }, h('strong', {}, 'Who is this?'), h('span', { class: `ev-tag ${p.status === 'approved' ? 'live' : p.status === 'rejected' ? 'dead' : ''}` },
                p.status === 'pending' ? `⏳ ${until(p.decidesAt)}` : p.status === 'approved' ? '✅ Let in' : '🚫 Vetted out')),
              h('p', {}, `${p.mine ? 'You want' : `${p.requester} wants`} to bring `, h('strong', {}, p.name || 'someone'),
                p.instagram ? [' · ', h('a', { href: `https://instagram.com/${encodeURIComponent(p.instagram)}`, target: '_blank', rel: 'noopener' }, `@${p.instagram}`)] : null),
              p.pitch ? h('p', { class: 'small muted' }, `“${p.pitch}”`) : null,
              h('div', { class: 'row-between' },
                h('span', { class: 'small' }, `👍 ${p.yes} · 👎 ${p.no}`),
                p.status === 'pending'
                  ? h('div', { class: 'ev-actions' },
                      h('button', { class: `btn sm ${p.myVote === 1 ? 'hot' : 'ghost'}`, onclick: async () => { await act(`/events/plus-ones/${p.id}/vote`, { value: p.myVote === 1 ? 0 : 1 }); reload(); } }, 'Let them in'),
                      h('button', { class: `btn sm ${p.myVote === -1 ? 'danger' : 'ghost'}`, onclick: async () => { await act(`/events/plus-ones/${p.id}/vote`, { value: p.myVote === -1 ? 0 : -1 }); reload(); } }, 'Absolutely not'),
                      p.mine ? h('button', { class: 'btn sm ghost', onclick: async () => { await act(`/events/plus-ones/${p.id}/withdraw`); reload(); } }, 'Withdraw') : null)
                  : null)))
        : h('p', { class: 'small muted' }, `Want to bring someone? The group votes, and the timer is ${e.plusOneMinutes} minutes.`));

    // Bring list
    const me = state.user?.id;
    const bringInput = h('input', { type: 'text', maxlength: 80, placeholder: 'Add something…' });
    const bring = h('div', { class: 'card ev-bring' },
      h('h2', {}, 'Bring list'),
      d.bring.length
        ? h('ul', { class: 'ev-bring-list' },
            d.bring.map((b) =>
              h('li', { class: b.claimedBy ? 'claimed' : '' },
                h('span', {}, b.label),
                b.claimedBy
                  ? b.claimedBy === me
                    ? h('button', { class: 'btn sm ghost', onclick: async () => { await act(`/events/bring/${b.id}/claim`, { claim: false }); reload(); } }, '✓ You (drop it)')
                    : h('span', { class: 'small muted' }, `✓ ${b.claimedName}`)
                  : h('button', { class: 'btn sm', onclick: async () => { await act(`/events/bring/${b.id}/claim`, { claim: true }); reload(); } }, 'I got it'))))
        : h('p', { class: 'small muted' }, 'Nothing on the list yet.'),
      d.can.rsvp
        ? h('form', { class: 'ev-chip-add', onsubmit: async (ev) => { ev.preventDefault(); if (!bringInput.value.trim()) return; await act(`/events/${e.id}/bring`, { label: bringInput.value }); bringInput.value = ''; bringInput.blur(); reload(); } },
            bringInput, h('button', { class: 'btn sm ghost', type: 'submit' }, 'Add'))
        : null);

    // Archive (post-event page)
    const a = d.archive;
    const archive = a
      ? h('div', { class: 'card ev-archive' },
          h('div', { class: 'kicker' }, 'The archive'),
          h('h2', {}, a.rating ? `${a.rating}/10` : 'Rate the night'),
          h('p', { class: 'small muted' }, a.ratings ? `${a.ratings} ${a.ratings === 1 ? 'rating' : 'ratings'}` : 'Nobody has rated it yet.'),
          d.can.rate
            ? h('div', { class: 'ev-rate', role: 'radiogroup', 'aria-label': 'Rate out of 10' },
                Array.from({ length: 10 }, (_, i) => i + 1).map((n) =>
                  h('button', { class: a.myRating === n ? 'on' : '', 'aria-checked': String(a.myRating === n), role: 'radio', onclick: async () => { await act(`/events/${e.id}/rate`, { score: n }); reload(); } }, n)))
            : null,
          h('div', { class: 'ev-stats' },
            stat('🙋', a.showedUp.length, 'showed up'),
            stat('🤥', a.liars.length, 'stayed Maybe (lying)'),
            a.photos !== null ? stat('📸', a.photos, 'photos') : null,
            a.quotes !== null ? stat('💬', a.quotes, 'quotes') : null,
            a.regrets !== null ? stat('🫠', a.regrets, 'regrets') : null,
            (a.irishGoodbyes ?? a.irishGoodbyesPosts) != null ? stat('👻', a.irishGoodbyes ?? a.irishGoodbyesPosts, 'Irish goodbyes') : null,
            a.tab !== null ? stat('💸', a.tab, 'on the tab') : null,
            a.checkins !== null && a.checkins !== undefined ? stat('📍', a.checkins, 'check-ins') : null),
          a.topQuote ? h('blockquote', { class: 'ev-topquote' }, `“${a.topQuote.body}”`, h('cite', {}, `— ${a.topQuote.speaker}`)) : null,
          a.tabTotalCents ? h('p', { class: 'small' }, `💸 The night cost $${(a.tabTotalCents / 100).toFixed(2)} on the Tab`) : null,
          a.leftEarly?.length ? h('p', { class: 'small' }, '👻 Left without saying bye: ', a.leftEarly.map((l) => `${l.emoji ? l.emoji + ' ' : ''}${l.name}`).join(', ')) : null,
          a.liars.length ? h('p', { class: 'small' }, '🤥 Said maybe, meant no: ', a.liars.map((l) => l.name).join(', ')) : null,
          a.flipFlopper ? h('p', { class: 'small' }, `🔁 Flip-flopper of the night: ${a.flipFlopper.name} (${a.flipFlopper.n} changes)`) : null)
      : null;

    // Activity
    const activity = d.activity.length
      ? h('div', { class: 'card ev-activity' },
          h('h2', {}, 'What’s happened'),
          h('ul', {}, d.activity.map((x) => h('li', {}, h('span', {}, x.body), h('span', { class: 'when' }, ago(x.createdAt))))))
      : null;

    // Host tools
    const hostBox = d.can.edit
      ? h('details', { class: 'card ev-host-tools' },
          h('summary', {}, '🎛️ Host tools'),
          h('div', { class: 'stack' },
            e.kind !== 'spontaneous'
              ? h('div', { class: 'row-between' },
                  h('div', {}, h('strong', {}, 'Guest link'), h('p', { class: 'small muted' }, 'For outsiders. They see this card and can RSVP. Nothing else.')),
                  e.guestLink
                    ? h('div', { class: 'ev-actions' },
                        h('button', { class: 'btn sm', onclick: () => copy(location.origin + e.guestLink) }, 'Copy'),
                        h('button', { class: 'btn sm ghost', onclick: async () => { await act(`/events/${e.id}/guest-link`, { on: false }); reload(); } }, 'Turn off'))
                    : h('button', { class: 'btn sm ghost', onclick: async () => { const r = await act(`/events/${e.id}/guest-link`, { on: true }); copy(`${location.origin}/#/guest/${r.token}`); reload(); } }, 'Make one'))
              : null,
            e.kind !== 'spontaneous' && d.can.cancel ? stageAdder(e, reload) : null,
            h('div', { class: 'ev-actions' },
              d.can.cancel ? h('button', { class: 'btn sm danger', onclick: async () => { if (!confirm('Cancel this? Everyone going gets told.')) return; await act(`/events/${e.id}/cancel`); reload(); } }, 'Cancel event') : null,
              h('button', { class: 'btn sm danger', onclick: async () => { if (!confirm('Delete it for good? This can’t be undone.')) return; await act(`/events/${e.id}`, {}, 'DELETE'); go('/events'); } }, 'Delete for good'))))
      : null;

    if (!extras) {
      const safe = (fn) => { try { return fn?.(e) ?? null; } catch (err) { console.warn(err); return null; } };
      extras = { night: safe(nightPanel), photos: safe(photoSection), posts: safe(eventPosts) };
    }
    fill(wrap,
      hero,
      e.cancelled ? h('div', { class: 'callout quiet' }, h('strong', {}, '🪦 Cancelled'), h('p', { class: 'small muted' }, 'This one isn’t happening.')) : null,
      archive,
      rsvpBox,
      seasonLinks(e),
      e.phase === 'live' ? extras.night : null,
      stages,
      people,
      e.kind !== 'spontaneous' ? plusOnes : null,
      e.kind !== 'spontaneous' ? bring : null,
      extras.photos,
      extras.posts,
      e.phase !== 'live' ? extras.night : null,
      activity,
      hostBox,
    );
  };
  await load();
  if (!alive()) return;
  mount(shell({ title: 'Event', tab: 'events', back: '/events', fab: false }, wrap), load);
});

function stat(emoji, n, label) {
  return h('div', { class: 'ev-stat' }, h('span', { class: 'e' }, emoji), h('strong', {}, n), h('span', { class: 'small muted' }, label));
}

function stageAdder(e, reload) {
  const input = h('input', { type: 'text', maxlength: 60, placeholder: 'Add a stage: Bar, Club, Afters…' });
  return h('form', { class: 'ev-chip-add', onsubmit: async (ev) => { ev.preventDefault(); if (!input.value.trim()) return; await act(`/events/${e.id}/stages`, { label: input.value }); input.value = ''; reload(); } },
    input, h('button', { class: 'btn sm ghost', type: 'submit' }, 'Add stage'));
}

function plusOneForm(e, reload) {
  const dlg = h('dialog', { class: 'ev-dialog' });
  const err = h('p', { class: 'error', role: 'alert' });
  const form = h('form', {
    class: 'stack',
    onsubmit: async (ev) => {
      ev.preventDefault();
      const fd = new FormData(form);
      try {
        await api(`/events/${e.id}/plus-ones`, { method: 'POST', body: { name: fd.get('name'), instagram: fd.get('instagram'), pitch: fd.get('pitch') } });
        dlg.close();
        dlg.remove();
        toast('The group is deliberating 🕵️');
        reload();
      } catch (e2) {
        err.textContent = e2.message;
      }
    },
  },
  h('h2', {}, 'Who is this?'),
  h('p', { class: 'small muted' }, `The group gets ${e.plusOneMinutes} minutes to vote. Name and Instagram are optional.`),
  h('label', { class: 'field' }, 'Name', h('input', { name: 'name', maxlength: 60, placeholder: 'Theo' })),
  h('label', { class: 'field' }, 'Instagram', h('input', { name: 'instagram', maxlength: 60, placeholder: '@', autocapitalize: 'none' })),
  h('label', { class: 'field' }, 'Make the case', h('input', { name: 'pitch', maxlength: 200, placeholder: 'He has a car' })),
  err,
  h('div', { class: 'ev-actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => { dlg.close(); dlg.remove(); } }, 'Never mind'), h('button', { class: 'btn hot', type: 'submit' }, 'Put it to a vote')));
  dlg.append(form);
  document.body.append(dlg);
  dlg.showModal();
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link copied');
  } catch {
    prompt('Copy this link', text);
  }
}

// ---------------------------------------------------------------- guest link (public)
route('/guest/:token', async ({ token }) => {
  const box = h('div', { class: 'ev-guest' });
  const key = `stall:guest:${token}`;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(key) || '{}'); } catch {}
  const draw = async () => {
    let data;
    try {
      data = await fetch(`/api/v1/public/guest/${encodeURIComponent(token)}`).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || 'This link doesn’t work'); return j; });
    } catch (e) {
      fill(box, empty('🚪', e.message, 'Ask whoever sent it for a new one.'));
      return;
    }
    const e = data.event;
    const nameInput = h('input', { name: 'name', required: true, maxlength: 40, value: saved.name || '', placeholder: 'Your name' });
    const err = h('p', { class: 'error', role: 'alert' });
    const send = async (status) => {
      err.textContent = '';
      if (!nameInput.value.trim()) { err.textContent = 'Tell them who you are'; nameInput.focus(); return; }
      try {
        const r = await fetch(`/api/v1/public/guest/${encodeURIComponent(token)}/rsvp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: nameInput.value, status, editToken: saved.editToken }),
        }).then(async (x) => { const j = await x.json(); if (!x.ok) throw new Error(j.error || 'Didn’t work'); return j; });
        saved = { name: nameInput.value, status, editToken: r.editToken };
        try { localStorage.setItem(key, JSON.stringify(saved)); } catch {}
        draw();
      } catch (e2) {
        err.textContent = e2.message;
      }
    };
    fill(box,
      h('div', { class: 'ev-hero' },
        posterEl(e, true),
        h('div', { class: 'kicker' }, 'You’re invited'),
        h('h1', {}, e.title),
        h('div', { class: 'ev-host' }, 'Hosted by ', h('strong', {}, e.host)),
        h('dl', { class: 'ev-facts' },
          h('dt', {}, 'When'), h('dd', {}, `${fmtDay(e.startsAt)} · ${fmtTime(e.startsAt)}`),
          h('dt', {}, 'Where'), h('dd', {}, e.location || (e.locationRevealAt ? `🔒 Address drops ${until(e.locationRevealAt)}` : 'TBD')),
          h('dt', {}, 'Going'), h('dd', {}, String(e.going)))),
      e.cancelled ? h('div', { class: 'callout quiet' }, h('strong', {}, 'This one got cancelled.'))
      : e.phase === 'archived' ? h('div', { class: 'callout quiet' }, h('strong', {}, 'This night is over.'))
      : h('div', { class: 'card stack' },
          h('h2', {}, saved.status ? `You said: ${RSVP_LABEL[saved.status]}` : 'Coming?'),
          h('label', { class: 'field' }, 'Name', nameInput),
          rsvpPicker(saved.status, send),
          err),
      h('p', { class: 'small muted' }, 'Private event. Please don’t forward this link.'),
    );
  };
  await draw();
  coreMount(h('div', { class: 'shell guest' }, h('main', {}, box)));
}, { public: true });

// ---------------------------------------------------------------- local helpers
/** Mount a page and register its live-refresh hook. */
function mount(node, refresh) {
  coreMount(node);
  if (refresh) setRefresh(refresh);
}
