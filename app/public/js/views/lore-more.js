// Lore sub-tabs: Group Court, Hot Takes, The Canon, Prophecies, the 86'd List,
// Superlatives and On This Day. Each renderer returns a node and loads itself.
import { api, h, toast, empty, ago } from '../core.js';
import { reactionBar, postsMeta } from './feed.js';

const fill = (el, ...nodes) => el.replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
const av = (p) => h('span', { class: 'pv-av', 'aria-hidden': 'true' }, p?.emoji || (p?.name ? p.name[0].toUpperCase() : '?'));
const memberOptions = (members, placeholder = 'Pick someone…') => [h('option', { value: '' }, placeholder), members.map((m) => h('option', { value: m.id }, `${m.emoji ? `${m.emoji} ` : ''}${m.name}`))];
const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function hoursLeft(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'closed';
  const hrs = Math.floor(ms / 3600_000);
  return hrs ? `${hrs}h left` : `${Math.ceil(ms / 60000)}m left`;
}

async function call(path, body, method = 'POST') {
  try {
    return await api(path, { method, body });
  } catch (e) {
    toast(e.message);
    throw e;
  }
}

/** A collapsible "add" form; onSubmit(fd) returns a promise. */
function addForm(label, fields, onSubmit) {
  const err = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { class: 'btn block hot', type: 'submit' }, label);
  const form = h('form', {
    class: 'stack pv-compose',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      try {
        await onSubmit(new FormData(form));
        form.reset();
        details.open = false;
      } catch (e2) {
        err.textContent = e2.message;
      }
      submit.disabled = false;
    },
  }, fields, err, submit);
  const details = h('details', { class: 'card lr-add' }, h('summary', {}, `＋ ${label}`), form);
  return details;
}

// ------------------------------------------------------------------ Group Court
export function courtTab(focusId) {
  const box = h('div', { class: 'list' });
  const load = async () => {
    const [{ cases }, meta, pm] = await Promise.all([api('/lore/court'), api('/lore/meta'), postsMeta()]);
    const form = addForm('File a case', [
      h('label', { class: 'field' }, 'Defendant', h('select', { name: 'defendantId', required: true }, memberOptions(pm.members.filter((m) => m.id !== pm.me)))),
      h('label', { class: 'field' }, 'The charge', h('textarea', { name: 'charge', required: true, maxlength: 400, rows: 3, placeholder: 'Danny left my birthday at 11:40 for a Hinge date' })),
      h('label', { class: 'field' }, 'Sentence if guilty', h('select', { name: 'sentence' }, meta.sentences.map((s) => h('option', { value: s }, s)))),
    ], async (fd) => {
      await api('/lore/court', { method: 'POST', body: { defendantId: Number(fd.get('defendantId')), charge: fd.get('charge'), sentence: fd.get('sentence') } });
      toast('⚖️ Court is in session');
      load();
    });
    fill(box, form, cases.length ? cases.map((c) => caseCard(c, load)) : empty('⚖️', 'No cases on the docket', 'Someone wronged you. You know who.'));
    if (focusId) document.getElementById(`case-${focusId}`)?.scrollIntoView({ block: 'center' });
  };
  load();
  return { node: box, load };
}

function caseCard(c, reload) {
  const vote = (v) => call(`/lore/court/${c.id}/vote`, { value: c.votes.mine === v ? 0 : v }).then(reload, () => {});
  const verdict = { open: `🗳️ Voting · ${hoursLeft(c.closesAt)}`, guilty: '🔨 GUILTY', not_guilty: '🕊️ Not guilty', dismissed: '🫥 Dismissed' }[c.status];
  return h('article', { class: `card pv lr-case is-${c.status}`, id: `case-${c.id}` },
    h('div', { class: 'pv-top' }, h('span', { class: 'pv-kind' }, '⚖️ Group Court'), c.event ? h('a', { class: 'pv-event', href: `#/events/${c.event.id}` }, `📍 ${c.event.title}`) : null, h('span', { class: 'pv-time' }, ago(c.createdAt))),
    h('div', { class: 'pv-by big' }, av(c.plaintiff), h('strong', {}, c.plaintiff.name), h('span', { class: 'muted' }, ' v. '), av(c.defendant), h('strong', {}, c.defendant.name)),
    h('p', { class: 'pv-body' }, c.charge),
    c.rebuttal ? h('p', { class: 'pv-ctx' }, `Rebuttal: “${c.rebuttal}”`) : null,
    h('p', { class: 'pv-meta' }, `Sentence on the table: ${c.sentence}`),
    h('div', { class: `lr-verdict ${c.status}` }, verdict, ` · ${c.votes.guilty} guilty, ${c.votes.notGuilty} not guilty`),
    h('div', { class: 'pv-actions' },
      c.can.vote ? [
        h('button', { class: `btn sm ${c.votes.mine === 1 ? 'hot' : 'ghost'}`, onclick: () => vote(1) }, '🔨 Guilty'),
        h('button', { class: `btn sm ${c.votes.mine === -1 ? 'hot' : 'ghost'}`, onclick: () => vote(-1) }, '🕊️ Not guilty'),
      ] : null,
      c.can.rebut ? h('button', { class: 'btn sm ghost', onclick: () => { const b = prompt('Your one rebuttal. Make it count.'); if (b) call(`/lore/court/${c.id}/rebut`, { body: b }).then(reload, () => {}); } }, '🗣️ Rebut') : null,
      c.can.dismiss ? h('button', { class: 'btn sm danger', onclick: () => confirm('Drop the case?') && call(`/lore/court/${c.id}/dismiss`).then(reload, () => {}) }, 'Drop it') : null));
}

// ------------------------------------------------------------------ Hot Takes
export function takesTab() {
  const box = h('div', { class: 'list' });
  const load = async () => {
    const { takes, worst } = await api('/lore/takes');
    const form = addForm('Post a hot take', [h('label', { class: 'field' }, 'Your take', h('textarea', { name: 'body', required: true, maxlength: 280, rows: 2, placeholder: 'Brunch is just breakfast for people who hate themselves' }))], async (fd) => {
      await api('/lore/takes', { method: 'POST', body: { body: fd.get('body') } });
      load();
    });
    fill(box,
      worst ? h('section', { class: 'card pv lr-worst' }, h('div', { class: 'kicker' }, '🗑️ Worst Take of the Month (so far)'), h('p', { class: 'pv-quote' }, worst.body), h('p', { class: 'pv-meta' }, `${worst.author_name} · ${worst.disagree} disagree`)) : null,
      form,
      takes.length ? takes.map((t) => {
        const vote = (v) => call(`/lore/takes/${t.id}/vote`, { value: t.votes.mine === v ? 0 : v }).then(load, () => {});
        return h('article', { class: 'card pv' },
          h('p', { class: 'pv-quote' }, t.body),
          h('div', { class: 'pv-by' }, av(t.author), h('strong', {}, t.mine ? 'You' : t.author.name), h('span', { class: 'pv-time' }, ago(t.createdAt))),
          h('div', { class: 'pv-actions' },
            h('button', { class: `btn sm ${t.votes.mine === 1 ? 'hot' : 'ghost'}`, onclick: () => vote(1) }, `🔥 Agree ${t.votes.agree}`),
            h('button', { class: `btn sm ${t.votes.mine === -1 ? 'hot' : 'ghost'}`, onclick: () => vote(-1) }, `🗑️ Terrible ${t.votes.disagree}`),
            t.can.delete ? h('button', { class: 'pv-del', 'aria-label': 'Delete', onclick: () => confirm('Delete this take?') && call(`/lore/takes/${t.id}`, undefined, 'DELETE').then(load, () => {}) }, '🗑') : null));
      }) : empty('🌶️', 'No hot takes', 'Say something you’ll regret.'));
  };
  load();
  return { node: box, load };
}

// ------------------------------------------------------------------ The Canon
export function canonTab() {
  const box = h('div', { class: 'list' });
  let q = '';
  const listEl = h('div', { class: 'list' });
  const search = h('input', { type: 'search', class: 'lr-search', placeholder: 'Search the canon', oninput: (e) => { q = e.target.value; clearTimeout(search._t); search._t = setTimeout(loadList, 250); } });
  const loadList = async () => {
    const { entries } = await api(`/lore/canon${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    fill(listEl, entries.length ? entries.map((c) => h('article', { class: 'card pv lr-canon' },
      h('h3', {}, c.term),
      h('p', { class: 'pv-body' }, c.origin),
      h('p', { class: 'pv-meta' }, `Canon since ${c.canonSince}${c.event ? ` · ${c.event.title}` : ''} · added by ${c.author.name}`),
      h('div', { class: 'pv-foot' }, reactionBar('canon', c.id, c.reactions),
        c.can.delete ? h('button', { class: 'pv-del', 'aria-label': 'Delete', onclick: () => confirm('Strike this from the canon?') && call(`/lore/canon/${c.id}`, undefined, 'DELETE').then(loadList, () => {}) }, '🗑') : null)))
      : empty('📖', q ? 'Nothing matches' : 'The canon is empty', q ? '' : 'Every inside joke started somewhere. Write it down.'));
  };
  const form = addForm('Add to the canon', [
    h('label', { class: 'field' }, 'Term', h('input', { name: 'term', required: true, maxlength: 80, placeholder: 'the Ray’s incident' })),
    h('label', { class: 'field' }, 'Origin story', h('textarea', { name: 'origin', required: true, maxlength: 1000, rows: 4 })),
    h('label', { class: 'field' }, 'Canon since', h('input', { type: 'date', name: 'canonSince' })),
  ], async (fd) => {
    await api('/lore/canon', { method: 'POST', body: { term: fd.get('term'), origin: fd.get('origin'), canonSince: fd.get('canonSince') || undefined } });
    loadList();
  });
  fill(box, h('div', { class: 'pv-quick' }, search, h('button', { class: 'btn sm ghost', onclick: () => quiz(box) }, '🎓 Lore 101 quiz')), form, listEl);
  loadList();
  return { node: box, load: loadList };
}

async function quiz(box) {
  const { questions } = await api('/lore/quiz');
  if (!questions.length) return toast('Need at least 4 canon entries for a quiz.');
  let score = 0;
  let i = 0;
  const dlg = h('dialog', { class: 'lr-quiz' });
  const step = () => {
    if (i >= questions.length) {
      fill(dlg, h('h2', {}, `${score}/${questions.length}`), h('p', {}, score === questions.length ? 'Fully initiated. Welcome to the Stall.' : 'Study up. There will be a test (there won’t).'), h('button', { class: 'btn block hot', onclick: () => dlg.close() }, 'Done'));
      return;
    }
    const qn = questions[i];
    fill(dlg, h('div', { class: 'kicker' }, `Lore 101 · ${i + 1}/${questions.length}`), h('h2', {}, `What is “${qn.term}”?`),
      h('div', { class: 'stack' }, qn.options.map((o) => h('button', { class: 'btn ghost lr-opt', onclick: () => { if (o.id === qn.answer) { score++; toast('✅'); } else toast('❌'); i++; step(); } }, o.origin))));
  };
  box.append(dlg);
  step();
  dlg.showModal();
  dlg.addEventListener('close', () => dlg.remove());
}

// ------------------------------------------------------------------ Prophecies
export function propheciesTab() {
  const box = h('div', { class: 'list' });
  const load = async () => {
    const { prophecies } = await api('/lore/prophecies');
    const form = addForm('Seal a prophecy', [
      h('label', { class: 'field' }, 'The prophecy', h('textarea', { name: 'body', required: true, maxlength: 400, rows: 3, placeholder: 'Sam and Rae are getting back together by Christmas' })),
      h('label', { class: 'field' }, 'Unseal on', h('input', { type: 'date', name: 'revealAt', required: true })),
    ], async (fd) => {
      const d = fd.get('revealAt');
      await api('/lore/prophecies', { method: 'POST', body: { body: fd.get('body'), revealAt: new Date(`${d}T12:00:00`).toISOString() } });
      toast('🔮 Sealed');
      load();
    });
    fill(box, form, prophecies.length ? prophecies.map((p) => {
      const vote = (v) => call(`/lore/prophecies/${p.id}/vote`, { value: p.votes.mine === v ? 0 : v }).then(load, () => {});
      return h('article', { class: `card pv lr-prophecy ${p.sealed ? 'sealed' : ''}` },
        h('div', { class: 'pv-top' }, h('span', { class: 'pv-kind' }, p.sealed ? '🔒 Sealed' : p.outcome === true ? '✅ Came true' : p.outcome === false ? '❌ Didn’t happen' : '🔮 Unsealed'), h('span', { class: 'pv-time' }, `${p.sealed ? 'opens' : 'opened'} ${fmtDate(p.revealAt)}`)),
        h('p', { class: 'pv-quote' }, p.body ?? '🔒 Sealed until the reveal'),
        p.sealed && p.mine ? h('p', { class: 'pv-meta' }, 'Only you can read this until it opens.') : null,
        h('div', { class: 'pv-by' }, av(p.author), h('strong', {}, p.mine ? 'You' : p.author.name), ' prophesied'),
        p.can.vote ? h('div', { class: 'pv-actions' },
          h('button', { class: `btn sm ${p.votes.mine === 1 ? 'hot' : 'ghost'}`, onclick: () => vote(1) }, `✅ Came true ${p.votes.trueVotes}`),
          h('button', { class: `btn sm ${p.votes.mine === -1 ? 'hot' : 'ghost'}`, onclick: () => vote(-1) }, `❌ Nope ${p.votes.falseVotes}`),
          h('span', { class: 'pv-meta' }, `${p.votes.quorum} votes to call it`)) : null,
        p.can.delete ? h('button', { class: 'pv-del', 'aria-label': 'Delete', onclick: () => confirm('Delete this prophecy?') && call(`/lore/prophecies/${p.id}`, undefined, 'DELETE').then(load, () => {}) }, '🗑') : null);
    }) : empty('🔮', 'No prophecies', 'Predict something. Get it right. Be insufferable.'));
  };
  load();
  return { node: box, load };
}

// ------------------------------------------------------------------ 86'd List
export function list86Tab() {
  const box = h('div', { class: 'list' });
  const load = async () => {
    const [{ entries }, pm] = await Promise.all([api('/lore/86'), postsMeta()]);
    const form = addForm('86 someone or somewhere', [
      h('label', { class: 'field' }, 'What', h('select', { name: 'kind' }, h('option', { value: 'place' }, '📍 A place'), h('option', { value: 'person' }, '🚫 A person'))),
      h('label', { class: 'field' }, 'Name', h('input', { name: 'name', required: true, maxlength: 80, placeholder: 'the finance guy who kept saying “let’s circle back”' })),
      h('label', { class: 'field' }, 'Who’s banned there', h('small', {}, 'Places only. Leave blank for the whole group.'), h('select', { name: 'memberId' }, memberOptions(pm.members, 'The whole group'))),
      h('label', { class: 'field' }, 'Reason', h('input', { name: 'reason', required: true, maxlength: 400 })),
    ], async (fd) => {
      await api('/lore/86', { method: 'POST', body: { kind: fd.get('kind'), name: fd.get('name'), reason: fd.get('reason'), memberId: fd.get('memberId') ? Number(fd.get('memberId')) : null } });
      load();
    });
    const section = (kind, title) => {
      const list = entries.filter((e) => e.kind === kind);
      return list.length ? h('section', { class: 'card lr-86' }, h('h3', {}, title), list.map((e) => h('div', { class: 'lr-86-row' },
        h('div', {}, h('strong', {}, e.name), e.member ? h('span', { class: 'muted' }, ` · ${e.member.name}`) : null, h('p', { class: 'pv-meta' }, `${e.reason} · since ${e.since}`)),
        e.can.delete ? h('button', { class: 'pv-del', 'aria-label': 'Pardon', onclick: () => confirm('Pardon?') && call(`/lore/86/${e.id}`, undefined, 'DELETE').then(load, () => {}) }, '🕊️') : null))) : null;
    };
    fill(box, form, entries.length ? [section('place', '📍 Places'), section('person', '🚫 People')] : empty('🚫', 'Nobody’s 86’d', 'Yet.'));
  };
  load();
  return { node: box, load };
}

// ------------------------------------------------------------------ Superlatives
export function superlativesTab() {
  const box = h('div', { class: 'list' });
  const load = async () => {
    const [data, pm] = await Promise.all([api('/lore/superlatives'), postsMeta()]);
    fill(box,
      h('p', { class: 'muted small' }, `Voting for ${data.month}. One pick per category, change it any time this month.`),
      data.categories.map((c) => h('section', { class: 'card pv lr-sup' },
        h('h3', {}, c.label),
        c.leaders.length ? h('ol', { class: 'lr-leaders' }, c.leaders.map((l, i) => h('li', {}, ['🥇', '🥈', '🥉'][i], ' ', av(l), h('strong', {}, l.name), h('span', { class: 'muted' }, ` ${l.votes}`)))) : h('p', { class: 'pv-meta' }, 'No votes yet'),
        data.open ? h('select', {
          'aria-label': `Vote for ${c.label}`,
          onchange: (e) => e.target.value && call('/lore/superlatives', { category: c.key, nomineeId: Number(e.target.value) }).then(load, () => {}),
        }, h('option', { value: '' }, c.myPick ? 'Change your pick…' : 'Your pick…'), pm.members.map((m) => h('option', { value: m.id, selected: m.id === c.myPick }, `${m.emoji ? `${m.emoji} ` : ''}${m.name}`))) : null)));
  };
  load();
  return { node: box, load };
}

// ------------------------------------------------------------------ On This Day
export function onThisDayTab() {
  const box = h('div', { class: 'list' });
  const load = async () => {
    const { memories } = await api('/lore/on-this-day');
    fill(box, memories.length ? memories.map((m) => h('section', { class: 'card pv' },
      h('div', { class: 'kicker' }, `${m.yearsAgo === 1 ? 'One year' : `${m.yearsAgo} years`} ago tonight · ${m.year}`),
      m.quotes.map((q) => h('a', { href: `#/lore?post=${q.id}`, class: 'lr-otd-q' }, h('p', { class: 'pv-quote' }, `“${q.body}”`), h('p', { class: 'pv-meta' }, `— ${q.speaker || 'someone'}`))),
      m.canon.length ? h('p', { class: 'pv-meta' }, `Became canon: ${m.canon.map((c) => c.term).join(', ')}`) : null))
      : empty('📅', 'Nothing from this day yet', 'Give it a year.'));
  };
  load();
  return { node: box, load };
}
