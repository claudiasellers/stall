// Lore (#/lore): the Quote Wall ("Overheard"). Quote of the Month up top, an Out of
// Context toggle, then every line the group has said, newest first.
import { api, h, route, go, shell, empty, head, mount } from '../core.js';
import { postCard, postsMeta, setOoc, liveRefresh } from './feed.js';
import { courtTab, takesTab, canonTab, propheciesTab, list86Tab, superlativesTab, onThisDayTab } from './lore-more.js';

const LORE_TABS = [
  ['quotes', '🗣️ Overheard'], ['court', '⚖️ Court'], ['takes', '🌶️ Hot Takes'], ['canon', '📖 Canon'],
  ['prophecies', '🔮 Prophecies'], ['superlatives', '🏆 Superlatives'], ['86', '🚫 86’d'], ['otd', '📅 On This Day'],
];
const RENDER = { court: () => courtTab(query().get('case')), takes: takesTab, canon: canonTab, prophecies: propheciesTab, superlatives: superlativesTab, '86': list86Tab, otd: onThisDayTab };
const loreSeg = (tab) => [
  // Pages built by the photo lane that live under Lore.
  h('div', { class: 'pv-quick' }, h('a', { class: 'btn sm ghost', href: '#/lore/map' }, '📍 Lore Map'), h('a', { class: 'btn sm ghost', href: '#/halls' }, '🏆 The Halls'), h('a', { class: 'btn sm ghost', href: '#/wrapped' }, '🎁 Wrapped')),
  h('div', { class: 'seg', role: 'tablist' },
    LORE_TABS.map(([k, label]) => h('a', { role: 'tab', class: `segbtn ${tab === k ? 'on' : ''}`, 'aria-selected': String(tab === k), href: k === 'quotes' ? '#/lore' : `#/lore?tab=${k}` }, label))),
];

const fill = (el, ...nodes) => el.replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
const query = () => new URLSearchParams(location.hash.split('?')[1] || '');
const monthName = (key) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString(undefined, { month: 'long', timeZone: 'UTC' });
};

let ooc = (() => { try { return localStorage.getItem('stall:ooc') === '1'; } catch { return false; } })();
let whoFilter = '';

function qotm(data) {
  const cur = data.current;
  const prev = data.previous;
  if (!cur && !prev) return null;
  return h('section', { class: 'pv-qotm' },
    cur ? [h('div', { class: 'kicker' }, `🏆 Quote of ${monthName(data.month)} (so far)`), postCard(cur, { showKind: false })] : null,
    prev ? h('details', { class: 'pv-prev' }, h('summary', {}, `${monthName(data.previousMonth)}’s winner`), postCard(prev, { showKind: false })) : null);
}

route('/lore(?:\\?.*)?', async (_p, alive) => {
  const tab = query().get('tab') || 'quotes';
  if (RENDER[tab]) {
    await postsMeta();
    const { node, load } = RENDER[tab]();
    mount(shell({ tab: 'lore', fab: false }, head('Lore', LORE_TABS.find(([k]) => k === tab)[1], null), loreSeg(tab), node));
    liveRefresh(alive, load);
    return;
  }
  const meta = await postsMeta();
  const focus = query().get('post');
  const listEl = h('div', { class: 'list' });
  const topEl = h('div');
  const more = h('button', { class: 'btn ghost sm pv-more', hidden: true }, 'Older');
  let cursor = null;

  const load = async (append = false) => {
    const qs = new URLSearchParams({ kind: 'quote' });
    if (whoFilter) qs.set('subject', whoFilter);
    if (append && cursor) qs.set('before', cursor);
    const [{ posts, next }, month] = await Promise.all([api(`/posts?${qs}`), append ? null : api('/posts/quote-of-the-month')]);
    if (!alive()) return;
    cursor = posts.length >= 30 ? next : null;
    more.hidden = !cursor;
    const cards = posts.map((p) => postCard(p, { showKind: false }));
    if (append) listEl.append(...cards);
    else {
      fill(topEl, whoFilter ? null : qotm(month));
      fill(listEl, cards.length ? cards : empty('🗣️', 'The wall is empty', 'Somebody said something unhinged last night. Write it down.'));
    }
    if (focus) document.getElementById(`post-${focus}`)?.scrollIntoView({ block: 'center' });
  };
  more.onclick = () => load(true);
  await load();
  if (!alive()) return;

  const toggle = h('label', { class: 'pv-toggle pv-ooc' },
    h('input', { type: 'checkbox', checked: ooc, onchange: (e) => { ooc = e.target.checked; setOoc(ooc); load(); } }),
    h('span', {}, '🙈 Out of context'), h('small', {}, 'Hide the context. Funnier.'));
  const who = h('select', { 'aria-label': 'Filter by who said it', onchange: (e) => { whoFilter = e.target.value; load(); } },
    h('option', { value: '' }, 'Everyone'),
    meta.members.map((m) => h('option', { value: m.id, selected: String(m.id) === whoFilter }, `${m.emoji ? `${m.emoji} ` : ''}${m.name}`)));

  mount(
    shell({ tab: 'lore', fab: false },
      head('Lore', 'Overheard', 'Said out loud, written down forever.'),
      loreSeg('quotes'),
      h('div', { class: 'pv-quick' }, h('a', { class: 'btn sm hot', href: '#/post/new?kind=quote' }, '🗣️ Add a quote'), who),
      toggle, topEl, listEl, more));
  liveRefresh(alive, () => load());
});

export { go };
