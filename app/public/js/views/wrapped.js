// Stall Wrapped (#/wrapped, #/wrapped/:year) and the Hall of Fame / Shame (#/halls).
import { api, h, fill, mount, shell, route, go, toast, empty } from '../core.js';

if (!document.querySelector('link[data-wrapped-css]')) {
  const l = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/css/wrapped.css' });
  l.setAttribute('data-wrapped-css', '');
  document.head.append(l);
}

// ------------------------------------------------------------------ Wrapped: story cards
function story(data, onClose) {
  const cards = data.cards;
  let i = 0;
  const bars = h('div', { class: 'wr-bars' }, cards.map(() => h('i', {}, h('b', {}))));
  const stage = h('div', { class: 'wr-stage' });
  let timer;
  const show = (k) => {
    i = Math.max(0, Math.min(cards.length - 1, k));
    const c = cards[i];
    [...bars.children].forEach((b, j) => b.className = j < i ? 'done' : j === i ? 'on' : '');
    stage.className = `wr-stage tone-${c.tone}`;
    fill(stage,
      h('div', { class: 'wr-card', key: c.id },
        h('div', { class: 'wr-kicker' }, c.kicker),
        h('div', { class: `wr-big ${c.big.length > 18 ? 'long' : ''}` }, c.big),
        h('div', { class: 'wr-line' }, c.line),
      ),
    );
    clearTimeout(timer);
    timer = setTimeout(() => (i < cards.length - 1 ? show(i + 1) : null), 7000);
  };
  const root = h('div', { class: 'wr-story', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Stall Wrapped ${data.year}` },
    bars,
    h('button', { class: 'wr-close', type: 'button', 'aria-label': 'Close', onclick: () => { clearTimeout(timer); onClose(); } }, '✕'),
    stage,
    h('button', { class: 'wr-tap prev', type: 'button', 'aria-label': 'Previous', onclick: () => show(i - 1) }),
    h('button', { class: 'wr-tap next', type: 'button', 'aria-label': 'Next', onclick: () => (i === cards.length - 1 ? (clearTimeout(timer), onClose()) : show(i + 1)) }),
  );
  const onKey = (e) => {
    if (!root.isConnected) return document.removeEventListener('keydown', onKey);
    if (e.key === 'ArrowRight') show(i + 1);
    else if (e.key === 'ArrowLeft') show(i - 1);
    else if (e.key === 'Escape') onClose();
  };
  document.addEventListener('keydown', onKey);
  show(0);
  return root;
}

async function wrappedView({ year }) {
  const y = year ? Number(year) : undefined;
  const data = await api(`/wrapped${y ? `?year=${y}` : ''}`);
  const open = () => {
    if (!data.cards.length) return toast('Nothing to wrap yet. Go out.');
    const s = story(data, () => s.remove());
    document.body.append(s);
  };
  const thisYear = new Date().getFullYear();
  mount(shell({ title: `Wrapped ${data.year}`, back: '/' },
    h('div', { class: 'wr-cover' },
      h('div', { class: 'wr-cover-kicker' }, data.preview ? 'Sneak preview · drops in December' : 'Stall Wrapped'),
      h('h1', {}, String(data.year)),
      h('p', {}, data.cards.length ? `${data.cards.length} cards. Some of them are about you. Most of them are bad.` : 'Nothing to wrap yet. Go out.'),
      h('button', { class: 'btn hot block', type: 'button', onclick: open, disabled: !data.cards.length }, '▶ Play my year'),
    ),
    h('div', { class: 'wr-years' }, [thisYear, thisYear - 1, thisYear - 2].map((yy) =>
      h('a', { class: `btn ghost sm ${yy === data.year ? 'on' : ''}`, href: `#/wrapped/${yy}` }, String(yy)))),
    h('a', { class: 'btn ghost block', href: '#/halls' }, '🏆 Hall of Fame · Hall of Shame'),
  ));
  if (sessionStorage.getItem(`wr-played-${data.year}`) !== '1' && data.cards.length) {
    try { sessionStorage.setItem(`wr-played-${data.year}`, '1'); } catch {}
    open();
  }
}
route('/wrapped', () => wrappedView({}));
route('/wrapped/:year', (p) => {
  if (!/^\d{4}$/.test(p.year)) return go('/wrapped');
  return wrappedView(p);
});

// ------------------------------------------------------------------ Halls
const MEDAL = ['🥇', '🥈', '🥉'];
function hallCard(board, shame) {
  return h('div', { class: `wr-hall ${shame ? 'shame' : 'fame'}` },
    h('div', { class: 'wr-hall-title' }, board.title),
    h('ol', {}, board.leaders.map((l, k) =>
      h('li', {}, h('span', { class: 'wr-medal' }, shame ? ['💀', '🤡', '🫠'][k] : MEDAL[k]),
        h('span', { class: 'wr-who' }, `${l.emoji || ''} ${l.name}`.trim()),
        h('span', { class: 'wr-n' }, `${l.n} ${board.unit}`)))),
  );
}

route('/halls', async () => {
  const { fame, shame } = await api('/halls');
  const body = h('div', {});
  let tab = 'fame';
  const draw = () => fill(body,
    h('div', { class: 'seg' },
      h('button', { class: tab === 'fame' ? 'on' : '', type: 'button', onclick: () => { tab = 'fame'; draw(); } }, '🏆 Hall of Fame'),
      h('button', { class: tab === 'shame' ? 'on' : '', type: 'button', onclick: () => { tab = 'shame'; draw(); } }, '🪦 Hall of Shame')),
    (tab === 'fame' ? fame : shame).length
      ? h('div', { class: 'wr-halls' }, (tab === 'fame' ? fame : shame).map((b) => hallCard(b, tab === 'shame')))
      : empty(tab === 'fame' ? '🏆' : '🪦', 'Nobody’s earned a spot yet', 'Give it a weekend.'),
  );
  draw();
  mount(shell({ title: 'The Halls', back: '/' }, body, h('a', { class: 'btn ghost block', href: '#/wrapped' }, '🎁 Your Wrapped')));
});
