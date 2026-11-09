// Lore Map (#/lore/map): every place the group has been, on a stylized NYC map,
// pinned with incidents. Never GPS: places are a name + neighborhood, nudged by hand.
import { api, h, fill, mount, shell, route, toast } from '../core.js';

if (!document.querySelector('link[data-loremap-css]')) {
  const l = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/css/loremap.css' });
  l.setAttribute('data-loremap-css', '');
  document.head.append(l);
}

const SVG = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
  for (const c of kids.flat()) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
};

// Stylized, not surveyed: sticker-shaped boroughs on a 1000x1000 grid.
const LAND = [
  ['nj', 'New Jersey', '0,0 240,0 262,300 236,700 190,1000 0,1000'],
  ['bx', 'Bronx', '420,120 470,30 660,20 720,140 540,185 465,172'],
  ['mn', 'Manhattan', '300,100 360,60 450,140 470,300 440,450 452,560 432,640 380,722 338,732 300,642 290,520 280,380 290,240'],
  ['qn', 'Queens', '482,520 502,420 472,332 512,240 622,200 905,262 955,500 822,562 642,502 542,502'],
  ['bk', 'Brooklyn', '444,662 474,562 522,522 602,504 762,544 802,702 762,902 602,962 482,902 442,802'],
];
const monthLabel = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return `${new Date(y, m - 1, 1).toLocaleString([], { month: 'long' })} ’${String(y).slice(2)}`;
};

route('/lore/map', async (_p, alive = () => true) => {
  let data = await api('/lore-map');
  if (!alive()) return;
  let moving = null; // place id waiting for a tap
  const sheet = h('div', { class: 'lm-sheet' });
  const svg = s('svg', { viewBox: '0 0 1000 1000', class: 'lm-map', role: 'img', 'aria-label': 'Map of the group’s places in New York' });

  const draw = () => {
    svg.replaceChildren(
      s('rect', { x: 0, y: 0, width: 1000, height: 1000, class: 'lm-water' }),
      ...LAND.map(([id, name, pts]) => s('polygon', { points: pts, class: `lm-land lm-${id}` }, s('title', {}, name))),
      ...LAND.filter(([id]) => id !== 'nj').map(([id, name, pts]) => {
        const xy = pts.split(' ').map((p) => p.split(',').map(Number));
        const cx = xy.reduce((a, p) => a + p[0], 0) / xy.length;
        const cy = xy.reduce((a, p) => a + p[1], 0) / xy.length;
        return s('text', { x: cx, y: id === 'mn' ? 180 : cy, class: 'lm-boro' }, name.toUpperCase());
      }),
      ...data.places.map((p) => {
        const r = 14 + Math.min(16, p.incidents * 4);
        const g = s('g', { class: `lm-pin ${p.incidents ? 'hot' : ''}`, transform: `translate(${p.x} ${p.y})`, tabindex: '0', role: 'button', 'aria-label': `${p.name}, ${p.incidents} incidents` },
          s('circle', { r }),
          p.incidents ? s('text', { class: 'lm-pin-n', 'text-anchor': 'middle', dy: '0.35em' }, p.incidents) : null,
          s('text', { class: 'lm-pin-label', y: -r - 8, 'text-anchor': 'middle' }, p.name));
        const open = (e) => { e.stopPropagation(); openPlace(p.id); };
        g.addEventListener('click', open);
        g.addEventListener('keydown', (e) => e.key === 'Enter' && open(e));
        return g;
      }),
    );
    svg.classList.toggle('moving', !!moving);
  };

  svg.addEventListener('click', async (e) => {
    if (!moving) return;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
    try {
      await api(`/lore-map/places/${moving}/move`, { method: 'POST', body: { x: Math.round(pt.x), y: Math.round(pt.y) } });
      moving = null;
      await reload();
      toast('Pin moved');
    } catch (err) { toast(err.message); }
  });

  const reload = async () => {
    data = await api('/lore-map');
    draw();
  };

  async function openPlace(id) {
    const { place, incidents } = await api(`/lore-map/places/${id}`);
    const title = h('input', { type: 'text', maxlength: '80', placeholder: 'What happened (“the Ray’s incident”)', required: true });
    const body = h('textarea', { maxlength: '600', rows: '3', placeholder: 'The story, for the record' });
    const month = h('input', { type: 'month', value: new Date().toISOString().slice(0, 7), required: true });
    fill(sheet,
      h('div', { class: 'lm-sheet-head' },
        h('div', {}, h('h2', {}, place.name), h('p', { class: 'lm-muted' }, `${place.hood}${place.visits ? ` · ${place.visits} night${place.visits === 1 ? '' : 's'} here` : ''}`)),
        h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { moving = place.id; draw(); toast('Tap the map where it really is'); } }, 'Move pin'),
        h('button', { class: 'lm-x', type: 'button', 'aria-label': 'Close', onclick: () => fill(sheet) }, '✕')),
      incidents.length
        ? h('ol', { class: 'lm-incidents' }, incidents.map((i) => h('li', {},
            h('div', { class: 'lm-inc-when' }, monthLabel(i.happenedOn)),
            h('strong', {}, i.title),
            i.body ? h('p', {}, i.body) : null,
            h('div', { class: 'lm-muted small' }, `filed by ${i.author || 'a former member'}`, i.eventId ? [' · ', h('a', { href: `#/events/${i.eventId}` }, 'that night')] : null,
              i.mine ? h('button', { class: 'lm-del', type: 'button', onclick: async () => { await api(`/lore-map/incidents/${i.id}`, { method: 'DELETE' }); openPlace(id); reload(); } }, 'delete') : null))))
        : h('p', { class: 'lm-muted' }, 'No incidents on file. Yet.'),
      h('form', { class: 'lm-form', onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api(`/lore-map/places/${id}/incidents`, { method: 'POST', body: { title: title.value, body: body.value, happenedOn: month.value } });
          await reload();
          openPlace(id);
        } catch (err) { toast(err.message); }
      } }, h('strong', {}, '📍 File an incident'), title, body, month, h('button', { class: 'btn hot sm', type: 'submit' }, 'Pin it')),
    );
    sheet.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Add a place
  const name = h('input', { type: 'text', maxlength: '80', placeholder: 'Bar, apartment, bodega…', list: 'lm-unpinned', required: true });
  const hood = h('select', { required: true }, h('option', { value: '' }, 'Neighborhood'), Object.keys(data.hoods).map((k) => h('option', { value: k }, k)));
  const addForm = h('form', { class: 'lm-add', onsubmit: async (e) => {
    e.preventDefault();
    try {
      const r = await api('/lore-map/places', { method: 'POST', body: { name: name.value, hood: hood.value } });
      name.value = '';
      await reload();
      openPlace(r.id);
    } catch (err) { toast(err.message); }
  } },
  name, h('datalist', { id: 'lm-unpinned' }, data.unpinned.map((v) => h('option', { value: v }))), hood, h('button', { class: 'btn hot sm', type: 'submit' }, 'Add place'));

  draw();
  window.addEventListener('stall:loremap', function on() {
    if (!svg.isConnected) return window.removeEventListener('stall:loremap', on);
    if (!moving) reload();
  });
  mount(shell({ title: 'Lore Map', back: '/lore' },
    h('p', { class: 'lm-muted' }, data.places.length ? `${data.places.length} places. Tap a pin for the lore.` : 'Pin the first place. Every incident needs an address.'),
    h('div', { class: 'lm-wrap' }, svg),
    data.unpinned.length ? h('p', { class: 'lm-muted small' }, `Checked in but not on the map: ${data.unpinned.slice(0, 5).join(', ')}`) : null,
    addForm,
    sheet,
  ));
});
