// Disposable-camera photo drop.
// photoSection(event) is mounted by the event detail page. registerPhotoRoutes(route)
// adds the night-roll, camera-roll and memories pages if the shell wants them.
//
// Rules the UI mirrors (the server enforces them):
//  - before the roll develops you can shoot but not look, not even at your own shots;
//  - anyone can veto a developed photo, instantly and forever;
//  - viewers get a resized copy drawn on a canvas with their own name across it;
//    only the uploader can fetch the original file.
import * as core from '../core.js';

const api = core.api;
const h = core.h;
const toast = core.toast || ((m) => console.log(m));
const userName = () => core.state?.user?.name || core.state?.user?.username || 'you';

// Our stylesheet, loaded once (CSP allows same-origin styles).
if (!document.querySelector('link[data-photos-css]')) {
  document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/css/photos.css' }));
  document.head.lastElementChild.setAttribute('data-photos-css', '');
}

const fill = (el, ...nodes) => el.replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));

// ------------------------------------------------------------------ time copy
function untilText(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'any second now';
  const m = Math.ceil(ms / 60000);
  if (m < 60) return `in ${m} min`;
  const hrs = Math.floor(m / 60);
  return `in ${hrs}h ${m % 60}m`;
}
function developsAt(iso) {
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86400000);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `${time} today`;
  if (d.toDateString() === tomorrow.toDateString()) return `${time} tomorrow`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
}
const nightLabel = (night) => new Date(`${night}T12:00:00`).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });

// ------------------------------------------------------------------ resize + upload
const ORIGINAL_OK = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const ORIGINAL_MAX = 25 * 1024 * 1024;

async function decode(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch { /* Safari HEIC etc.: fall back to <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function toBlob(canvas, quality) {
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not process that photo'))), 'image/jpeg', quality));
}

async function scaled(src, max, quality) {
  const w0 = src.naturalWidth || src.width;
  const h0 = src.naturalHeight || src.height;
  const k = Math.min(1, max / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w0 * k));
  c.height = Math.max(1, Math.round(h0 * k));
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height);
  return { blob: await toBlob(c, quality), width: c.width, height: c.height };
}

/** Phone file -> { original, display (1600px), thumb (480px) }, all resized in the browser. */
async function prepare(file) {
  const src = await decode(file);
  const display = await scaled(src, 1600, 0.82);
  const thumb = await scaled(src, 480, 0.72);
  let original = { blob: file, mime: (file.type || '').toLowerCase() };
  if (!ORIGINAL_OK.includes(original.mime) || file.size > ORIGINAL_MAX) {
    const big = await scaled(src, 3200, 0.9);
    original = { blob: big.blob, mime: 'image/jpeg' };
  }
  src.close?.();
  const w = src.naturalWidth || src.width || display.width;
  const hgt = src.naturalHeight || src.height || display.height;
  return { original, display, thumb, width: w, height: hgt };
}

async function putTo(target, blob, mime) {
  const t = typeof target === 'string' ? { url: target } : target;
  const headers = { ...(t.headers || {}) };
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = mime;
  const res = await fetch(t.url, { method: t.method || 'PUT', headers, body: blob, credentials: t.url.startsWith('/') ? 'same-origin' : 'omit' });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
}

/** Upload one file into a roll. Returns the commit result ({ developed, unlockAt }). */
async function uploadOne(file, eventId) {
  const p = await prepare(file);
  const reserved = await api('/photos', {
    method: 'POST',
    body: {
      eventId: eventId ?? null,
      takenAt: file.lastModified ? new Date(file.lastModified).toISOString() : undefined,
      mime: p.original.mime === 'image/heif' ? 'image/heic' : p.original.mime,
      derivedMime: 'image/jpeg',
      width: p.width,
      height: p.height,
      sizes: { original: p.original.blob.size, display: p.display.blob.size, thumb: p.thumb.blob.size },
    },
  });
  await Promise.all([
    putTo(reserved.uploads.original, p.original.blob, p.original.mime),
    putTo(reserved.uploads.display, p.display.blob, 'image/jpeg'),
    putTo(reserved.uploads.thumb, p.thumb.blob, 'image/jpeg'),
  ]);
  return api(`/photos/${reserved.id}/commit`, { method: 'POST', body: {} });
}


// ------------------------------------------------------------------ offline film
// Basements have no signal. A shot that fails to upload waits in IndexedDB and
// goes up the next time the app is online, keeping its capture time.
const DB_NAME = 'stall-photos';
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction('queue', mode);
    const out = fn(t.objectStore('queue'));
    t.oncomplete = () => res(out?.result ?? out);
    t.onerror = () => rej(t.error);
  });
}
async function enqueue(file, eventId) {
  try {
    await idbDo('readwrite', (s) => s.add({ blob: file, type: file.type, lastModified: file.lastModified || Date.now(), eventId: eventId ?? null }));
    return true;
  } catch {
    return false;
  }
}
async function queued() {
  try {
    return await idbDo('readonly', (s) => s.getAll());
  } catch {
    return [];
  }
}
let flushing = false;
/** Upload whatever is waiting. Returns how many went up. */
export async function flushQueue() {
  if (flushing || !navigator.onLine) return 0;
  flushing = true;
  let sent = 0;
  try {
    for (const item of await queued()) {
      const file = new File([item.blob], 'photo', { type: item.type, lastModified: item.lastModified });
      try {
        await uploadOne(file, item.eventId);
        await idbDo('readwrite', (s) => s.delete(item.id));
        sent++;
      } catch (e) {
        // 4xx other than timeouts/rate limits means it will never succeed: drop it.
        if (e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) await idbDo('readwrite', (s) => s.delete(item.id));
        else break;
      }
    }
  } finally {
    flushing = false;
  }
  if (sent) toast(`${sent} photo${sent === 1 ? '' : 's'} from earlier made it onto the roll`);
  return sent;
}
window.addEventListener('online', () => flushQueue());

/** Upload a batch, two at a time, with a live counter on the button. */
async function uploadMany(files, eventId, onProgress) {
  const list = [...files];
  let done = 0;
  let failed = 0;
  let last = null;
  let queuedCount = 0;
  const worker = async () => {
    while (list.length) {
      const f = list.shift();
      try {
        last = await uploadOne(f, eventId);
      } catch (e) {
        // Offline / network / server hiccup: keep the film and retry later.
        if ((!e.status || e.status >= 500 || e.status === 408) && (await enqueue(f, eventId))) queuedCount++;
        else toast(e.message || 'One photo didn’t upload');
        failed++;
      }
      done++;
      onProgress?.(done, done + list.length);
    }
  };
  await Promise.all([worker(), worker()]);
  if (queuedCount) toast(`No signal. ${queuedCount} shot${queuedCount === 1 ? '' : 's'} saved on your phone, will upload when you’re back online.`);
  return { done: done - failed, failed, queued: queuedCount, last };
}

// ------------------------------------------------------------------ watermark
/** Draw an image onto a canvas with the viewer's name tiled faintly across it. */
function watermarked(url, w, hgt, label) {
  const canvas = h('canvas', { class: 'ph-canvas', role: 'img', 'aria-label': 'Photo' });
  canvas.width = w;
  canvas.height = hgt;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.min(img.naturalWidth, Math.round(Math.max(canvas.clientWidth, 360) * dpr));
    const ch = Math.round(cw * (img.naturalHeight / img.naturalWidth));
    canvas.width = cw;
    canvas.height = ch;
    const g = canvas.getContext('2d');
    g.drawImage(img, 0, 0, cw, ch);
    const size = Math.max(14, Math.round(cw / 26));
    g.save();
    g.translate(cw / 2, ch / 2);
    g.rotate(-Math.PI / 7);
    g.font = `700 ${size}px Inter, system-ui, sans-serif`;
    g.textAlign = 'center';
    g.fillStyle = 'rgba(255,255,255,0.13)';
    g.strokeStyle = 'rgba(0,0,0,0.10)';
    g.lineWidth = 1;
    const step = size * 4.2;
    const diag = Math.hypot(cw, ch);
    for (let y = -diag; y < diag; y += step) {
      for (let x = -diag; x < diag; x += label.length * size * 0.75) {
        const off = (Math.round(y / step) % 2) * (label.length * size * 0.37);
        g.strokeText(label, x + off, y);
        g.fillText(label, x + off, y);
      }
    }
    g.restore();
    canvas.classList.add('ready');
  };
  img.onerror = () => canvas.classList.add('broken');
  img.src = url;
  return canvas;
}
const markLabel = () => `${userName()} · ${new Date().toLocaleDateString([], { month: 'short', day: 'numeric' })}`;

// ------------------------------------------------------------------ camera controls
function cameraControls(eventId, onUploaded) {
  const shoot = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  const pick = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  const status = h('span', { class: 'ph-status' });
  const shutter = h('button', { class: 'ph-shutter', type: 'button', 'aria-label': 'Take a photo', onclick: () => shoot.click() }, h('span', {}));
  const roll = h('button', { class: 'btn ghost sm', type: 'button', onclick: () => pick.click() }, 'Add from camera roll');
  const run = async (input) => {
    if (!input.files?.length) return;
    const files = [...input.files];
    input.value = '';
    shutter.disabled = roll.disabled = true;
    status.textContent = `Developing… 0/${files.length}`;
    try {
      const r = await uploadMany(files, eventId, (d, t) => (status.textContent = `Loading film… ${d}/${t}`));
      if (r.done) {
        flash();
        toast(r.last?.developed ? `${r.done} added to the album` : `${r.done} on the roll. No peeking till ${developsAt(r.last.unlockAt)}.`);
      }
      onUploaded?.(r);
    } finally {
      shutter.disabled = roll.disabled = false;
      status.textContent = '';
    }
  };
  shoot.addEventListener('change', () => run(shoot));
  pick.addEventListener('change', () => run(pick));
  return h('div', { class: 'ph-controls' }, shutter, h('div', { class: 'ph-controls-side' }, roll, status), shoot, pick);
}

function flash() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const f = h('div', { class: 'ph-flash', 'aria-hidden': 'true' });
  document.body.append(f);
  setTimeout(() => f.remove(), 450);
}

// ------------------------------------------------------------------ roll views
function lockedRoll(roll, eventId, reload) {
  const count = h('div', { class: 'ph-count' }, String(roll.count).padStart(2, '0'));
  const left = h('div', { class: 'ph-until' }, `Develops ${developsAt(roll.unlockAt)} · ${untilText(roll.unlockAt)}`);
  const timer = setInterval(() => {
    if (!left.isConnected) return clearInterval(timer);
    if (Date.now() >= new Date(roll.unlockAt).getTime()) {
      clearInterval(timer);
      reload();
    } else left.textContent = `Develops ${developsAt(roll.unlockAt)} · ${untilText(roll.unlockAt)}`;
  }, 30000);
  return h(
    'div',
    { class: 'ph-camera' },
    h('div', { class: 'ph-body' },
      h('div', { class: 'ph-window' }, count, h('small', {}, 'exp.')),
      h('div', { class: 'ph-copy' },
        h('strong', {}, roll.count ? `${roll.count} shot${roll.count === 1 ? '' : 's'} on the roll` : 'Fresh roll, nobody’s shot yet'),
        h('p', {}, roll.count
          ? `${roll.shooters} ${roll.shooters === 1 ? 'person' : 'people'} shooting${roll.mine ? `, ${roll.mine} of them yours` : ''}. Nobody sees anything until it develops.`
          : 'Shoot all night. Nobody sees a thing until the morning, including you.'),
        left,
      ),
    ),
    cameraControls(eventId, reload),
  );
}

function grid(photos, open) {
  return h(
    'div',
    { class: 'ph-grid' },
    photos.map((p, i) =>
      h(
        'button',
        { class: 'ph-tile', type: 'button', onclick: () => open(p.id), 'aria-label': p.title ? `Photo: ${p.title}` : `Photo ${i + 1} by ${p.uploader}`, style: `--r:${(((p.id * 37) % 7) - 3) * 0.6}deg` },
        h('img', { src: p.thumbUrl, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' }),
        p.title ? h('span', { class: 'ph-tile-cap' }, p.title) : null,
      ),
    ),
  );
}

function developedRoll(data, eventId, reload) {
  const { roll, photos } = data;
  return h(
    'div',
    { class: 'ph-album' },
    h('div', { class: 'ph-album-head' },
      h('strong', {}, photos.length ? `${photos.length} photo${photos.length === 1 ? '' : 's'}` : 'The roll is empty'),
      h('span', { class: 'ph-muted' }, photos.length ? `shot by ${roll.shooters} · developed ${developsAt(roll.unlockAt)}` : 'Everything got vetoed, or nobody took any.'),
    ),
    photos.length ? grid(photos, (id) => openViewer(id, reload)) : null,
    h('details', { class: 'ph-late' }, h('summary', {}, 'Late to the darkroom? Add yours'), cameraControls(eventId, reload)),
  );
}

/** The photo block on an event page. */
export function photoSection(event) {
  const box = h('section', { class: 'ph-section', 'aria-label': 'Photos' }, h('h2', {}, '📸 The roll'), h('div', { class: 'ph-loading' }, 'Loading film…'));
  const load = async () => {
    try {
      await flushQueue();
      const data = await api(`/photos/roll?event=${event.id}`);
      fill(box, h('h2', {}, '📸 The roll'), data.roll.developed ? developedRoll(data, event.id, load) : lockedRoll(data.roll, event.id, load));
    } catch (e) {
      fill(box, h('h2', {}, '📸 The roll'), h('p', { class: 'ph-muted' }, e.message));
    }
  };
  load();
  liveReload(box, load);
  return box;
}

/** Re-run load() on 'stall:photos' live events while box is on screen. */
function liveReload(box, load) {
  let t;
  const on = () => {
    if (!box.isConnected) return window.removeEventListener('stall:photos', on);
    if (document.querySelector('.ph-viewer')) return; // don't yank the album out from under the viewer
    clearTimeout(t);
    t = setTimeout(load, 400);
  };
  window.addEventListener('stall:photos', on);
}

/** A no-event night's roll (spontaneous nights, or an event that was deleted). */
export function nightSection(night) {
  const box = h('section', { class: 'ph-section' }, h('div', { class: 'ph-loading' }, 'Loading film…'));
  const load = async () => {
    try {
      const data = await api(`/photos/roll?night=${night}`);
      fill(box, h('h2', {}, `📸 ${nightLabel(night)}`), data.roll.developed ? developedRoll(data, null, load) : lockedRoll(data.roll, null, load));
    } catch (e) {
      fill(box, h('p', { class: 'ph-muted' }, e.message));
    }
  };
  load();
  liveReload(box, load);
  return box;
}

/** Every recent roll: developed ones with a cover, tonight's as a sealed camera. */
export function rollsSection() {
  const box = h('section', { class: 'ph-section' }, h('div', { class: 'ph-loading' }, 'Loading film…'));
  (async () => {
    try {
      const [{ rolls }, current] = await Promise.all([api('/photos/rolls'), api('/photos/current')]);
      const reload = () => fill(box, rollsSection());
      const tonight = rolls.find((r) => !r.developed && !r.eventId && r.night === current.night);
      fill(
        box,
        tonight || current.developed ? null : lockedRoll({ ...current, count: 0, shooters: 0, mine: current.mine }, null, reload),
        rolls.length
          ? h('div', { class: 'ph-rolls' }, rolls.map((r) => {
              const href = r.eventId ? `#/events/${r.eventId}` : `#/photos/night/${r.night}`;
              return h('a', { class: `ph-roll ${r.developed ? '' : 'sealed'}`, href },
                r.developed && r.coverUrl ? h('img', { src: r.coverUrl, alt: '', loading: 'lazy' }) : h('div', { class: 'ph-roll-sealed' }, '🎞️'),
                h('div', { class: 'ph-roll-meta' },
                  h('strong', {}, r.eventTitle || nightLabel(r.night)),
                  h('span', {}, r.developed ? `${r.count} photos` : `${r.count} shots · develops ${developsAt(r.unlockAt)}`),
                ),
              );
            }))
          : h('p', { class: 'ph-muted' }, 'No rolls yet. Go out.'),
      );
    } catch (e) {
      fill(box, h('p', { class: 'ph-muted' }, e.message));
    }
  })();
  return box;
}

/** "N years ago tonight." */
export function memoriesSection() {
  const box = h('section', { class: 'ph-section' }, h('div', { class: 'ph-loading' }, 'Rewinding…'));
  (async () => {
    try {
      const { memories } = await api('/photos/memories');
      fill(
        box,
        memories.length
          ? memories.map((m) =>
              h('div', { class: 'ph-memory' },
                h('h2', {}, `${m.yearsAgo} year${m.yearsAgo === 1 ? '' : 's'} ago tonight`),
                h('p', { class: 'ph-muted' }, m.eventTitle || nightLabel(m.night)),
                grid(m.photos, (id) => openViewer(id)),
              ))
          : h('p', { class: 'ph-muted' }, 'Nothing from this night in years past. Make some history.'),
      );
    } catch (e) {
      fill(box, h('p', { class: 'ph-muted' }, e.message));
    }
  })();
  return box;
}

// ------------------------------------------------------------------ viewer
let viewerEl = null;
function closeViewer() {
  viewerEl?.remove();
  viewerEl = null;
  document.body.classList.remove('ph-noscroll');
  document.removeEventListener('keydown', onKey);
}
let keyNav = {};
function onKey(e) {
  if (e.key === 'Escape') closeViewer();
  else if (e.key === 'ArrowLeft') keyNav.prev?.();
  else if (e.key === 'ArrowRight') keyNav.next?.();
}

/** Full-screen photo with its caption battle. onChange runs after a veto/delete so the roll reloads. */
export async function openViewer(id, onChange) {
  let data;
  try {
    data = await api(`/photos/${id}`);
  } catch (e) {
    toast(e.message);
    return;
  }
  const { photo, captions, neighbors, can } = data;
  if (!viewerEl) {
    viewerEl = h('div', { class: 'ph-viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Photo' });
    document.body.append(viewerEl);
    document.body.classList.add('ph-noscroll');
    document.addEventListener('keydown', onKey);
  }
  keyNav = {
    prev: neighbors.prev ? () => openViewer(neighbors.prev, onChange) : null,
    next: neighbors.next ? () => openViewer(neighbors.next, onChange) : null,
  };

  const veto = async () => {
    if (!confirm('Kill this photo for everyone? No vote, no undo.')) return;
    try {
      await api(`/photos/${id}/veto`, { method: 'POST', body: {} });
      toast('Gone. Nobody will ever know.');
      const next = neighbors.next || neighbors.prev;
      onChange?.();
      if (next) openViewer(next, onChange);
      else closeViewer();
    } catch (e) {
      toast(e.message);
    }
  };
  const remove = async () => {
    if (!confirm('Delete your photo?')) return;
    try {
      await api(`/photos/${id}`, { method: 'DELETE' });
      onChange?.();
      closeViewer();
    } catch (e) {
      toast(e.message);
    }
  };
  const original = async () => {
    try {
      const { url } = await api(`/photos/${id}/original`);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      toast(e.message);
    }
  };

  // Swipe left/right on the photo.
  const stage = h('div', { class: 'ph-stage' }, watermarked(photo.displayUrl, photo.width, photo.height, markLabel()));
  let x0 = null;
  stage.addEventListener('touchstart', (e) => (x0 = e.touches[0].clientX), { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    x0 = null;
    if (dx > 60) keyNav.prev?.();
    else if (dx < -60) keyNav.next?.();
  });

  fill(
    viewerEl,
    h('div', { class: 'ph-viewer-top' },
      h('button', { class: 'ph-x', type: 'button', 'aria-label': 'Close', onclick: closeViewer }, '✕'),
      h('div', { class: 'ph-viewer-by' }, `by ${photo.mine ? 'you' : photo.uploader}`),
      can.original ? h('button', { class: 'btn ghost sm', type: 'button', onclick: original }, 'Original') : null,
      can.delete ? h('button', { class: 'btn ghost sm', type: 'button', onclick: remove }, 'Delete') : null,
      h('button', { class: 'btn danger sm', type: 'button', onclick: veto, title: 'Anyone in it can kill it' }, 'Veto'),
    ),
    h('div', { class: 'ph-viewer-main' },
      neighbors.prev ? h('button', { class: 'ph-nav prev', type: 'button', 'aria-label': 'Previous', onclick: keyNav.prev }, '‹') : null,
      stage,
      neighbors.next ? h('button', { class: 'ph-nav next', type: 'button', 'aria-label': 'Next', onclick: keyNav.next }, '›') : null,
    ),
    h('div', { class: 'ph-title' }, photo.title ? `“${photo.title}”` : h('span', { class: 'ph-muted' }, 'Untitled. Fix that.')),
    captionBattle(id, captions, () => openViewer(id, onChange)),
  );
}

function captionBattle(photoId, captions, refresh) {
  const input = h('input', { type: 'text', maxlength: '140', placeholder: 'Caption this…', 'aria-label': 'Your caption', enterkeyhint: 'send' });
  const submit = async (e) => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    try {
      await api(`/photos/${photoId}/captions`, { method: 'POST', body: { body } });
      refresh();
    } catch (err) {
      toast(err.message);
    }
  };
  const vote = async (c) => {
    try {
      await api(`/photos/captions/${c.id}/vote`, { method: 'POST', body: { on: !c.voted } });
      refresh();
    } catch (err) {
      toast(err.message);
    }
  };
  const del = async (c) => {
    try {
      await api(`/photos/captions/${c.id}`, { method: 'DELETE' });
      refresh();
    } catch (err) {
      toast(err.message);
    }
  };
  return h(
    'div',
    { class: 'ph-captions' },
    h('div', { class: 'ph-captions-head' }, 'Caption battle', h('span', { class: 'ph-muted' }, ' · top vote becomes the title')),
    captions.map((c, i) =>
      h('div', { class: `ph-caption ${i === 0 && c.votes > 0 ? 'lead' : ''}` },
        h('button', { class: `ph-vote ${c.voted ? 'on' : ''}`, type: 'button', 'aria-pressed': String(c.voted), 'aria-label': `Vote, ${c.votes} votes`, onclick: () => vote(c) }, '▲', h('b', {}, c.votes)),
        h('div', { class: 'ph-caption-body' }, h('span', {}, c.body), h('small', {}, c.mine ? 'you' : c.author)),
        c.mine ? h('button', { class: 'ph-caption-del', type: 'button', 'aria-label': 'Delete caption', onclick: () => del(c) }, '✕') : null,
      ),
    ),
    h('form', { class: 'ph-caption-form', onsubmit: submit }, input, h('button', { class: 'btn hot sm', type: 'submit' }, 'Post')),
  );
}

// ------------------------------------------------------------------ routes
const page = (title, node) => core.mount(core.shell({ title, back: '/' }, node));
core.route('/photos', async () => page('Camera roll', [rollsSection(), h('a', { class: 'btn ghost sm', href: '#/photos/memories' }, '🕰️ Years ago tonight')]));
core.route('/photos/night/:night', async ({ night }) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(night)) return core.go('/photos');
  page(nightLabel(night), nightSection(night));
});
core.route('/photos/memories', async () => page('Years ago tonight', memoriesSection()));
