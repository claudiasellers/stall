// Photo drop domain logic. One rule decides visibility, and it is applied here
// at read time: a roll's photos are visible to members only once
// now >= unlockAt(roll night). Before that the API returns counts and nothing
// else, not even the uploader's own shots: it is a disposable camera.
import { randomBytes } from 'node:crypto';
import { tx, now } from '../../db.ts';
import { clock } from '../../clock.ts';
import { MAX_PHOTO_BYTES, queueStorageDelete } from '../../storage.ts';
import { HttpError } from '../../service.ts';
import { nightOf, unlockAt, monthDay, localDate } from './clock.ts';
import type { ModuleCtx } from '../types.ts';

export const LIMITS = {
  originalBytes: MAX_PHOTO_BYTES,
  displayBytes: 4 * 1024 * 1024,
  thumbBytes: 600 * 1024,
  perUserPerNight: 300,
  captionChars: 140,
  pendingTtlMs: 2 * 3600_000,
};
const ORIGINAL_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heic' };
const DERIVED_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const VOTE = '👍';

type PhotoRow = {
  id: number; event_id: number | null; night: string; uploader_id: number; status: 'pending' | 'ready';
  original_key: string; display_key: string; thumb_key: string; mime: string; width: number; height: number;
  bytes: number; taken_at: string; created_at: string; ready_at: string | null;
};
type CardRow = PhotoRow & { uploader_name: string; title: string | null };

/** Photos plus uploader name and winning caption, in one statement (no N+1). Bind VOTE first. */
const SELECT_CARD = `
  SELECT p.*, COALESCE(u.display_name, u.username) AS uploader_name,
    (SELECT c.body FROM photo_captions c
       JOIN reactions r ON r.target_type = 'caption' AND r.target_id = c.id AND r.emoji = ?
     WHERE c.photo_id = p.id GROUP BY c.id ORDER BY COUNT(*) DESC, c.id ASC LIMIT 1) AS title
  FROM photos p JOIN users u ON u.id = p.uploader_id`;
export type Roll = { eventId: number | null; night: string };

const newKey = (ext: string) => `m/${randomBytes(16).toString('hex')}.${ext}`;

export class Photos {
  private ctx: ModuleCtx;
  constructor(ctx: ModuleCtx) {
    this.ctx = ctx;
  }
  private get db() { return this.ctx.db; }
  private get tz(): string { return this.ctx.cfg.houseTz || 'America/New_York'; }
  private get unlockHour(): number { return this.ctx.house().photoUnlockHour; }

  // ------------------------------------------------------------- rolls & time
  /** The night a roll belongs to: the event's start night, else the stored night. */
  private eventNight(eventId: number): string {
    const e = this.event(eventId);
    if (!e) throw new HttpError(404, 'That event is gone');
    return nightOf(Date.parse(e.starts_at), this.tz);
  }

  private event(eventId: number): { id: number; title: string; starts_at: string } | undefined {
    return this.db.prepare('SELECT id, title, starts_at FROM events WHERE id = ?').get(eventId) as
      | { id: number; title: string; starts_at: string } | undefined;
  }

  rollNight(r: Roll): string {
    return r.eventId ? this.eventNight(r.eventId) : r.night;
  }

  unlockAt(r: Roll): number {
    return unlockAt(this.rollNight(r), this.tz, this.unlockHour);
  }

  isDeveloped(r: Roll, t = clock.now()): boolean {
    return t >= this.unlockAt(r);
  }

  private rollOf(p: PhotoRow): Roll {
    return { eventId: p.event_id, night: p.night };
  }

  private rollWhere(r: Roll): [string, (string | number)[]] {
    return r.eventId ? ['p.event_id = ?', [r.eventId]] : ['p.event_id IS NULL AND p.night = ?', [r.night]];
  }

  /** Which roll an upload made right now lands in. */
  currentRoll(eventId: number | null, takenAtMs: number): Roll {
    if (eventId) return { eventId, night: this.eventNight(eventId) };
    return { eventId: null, night: nightOf(takenAtMs, this.tz) };
  }

  // ------------------------------------------------------------- reads
  async roll(r: Roll, viewerId: number) {
    const [where, args] = this.rollWhere(r);
    const counts = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COUNT(DISTINCT uploader_id) AS shooters,
                COALESCE(SUM(uploader_id = ?), 0) AS mine
         FROM photos p WHERE ${where} AND p.status = 'ready'`,
      )
      .get(viewerId, ...args) as { n: number; shooters: number; mine: number };
    const unlock = this.unlockAt(r);
    const developed = clock.now() >= unlock;
    const ev = r.eventId ? this.event(r.eventId) : undefined;
    const roll = {
      eventId: r.eventId,
      eventTitle: ev?.title ?? null,
      night: this.rollNight(r),
      unlockAt: new Date(unlock).toISOString(),
      developed,
      count: counts.n,
      shooters: counts.shooters,
      mine: counts.mine,
    };
    if (!developed) return { roll, photos: [] };
    const rows = this.db
      .prepare(`${SELECT_CARD} WHERE ${where} AND p.status = 'ready' ORDER BY p.taken_at, p.id LIMIT 500`)
      .all(VOTE, ...args) as CardRow[];
    return { roll, photos: await Promise.all(rows.map((p) => this.card(p, viewerId))) };
  }

  /** Summary card: thumb only; the display image is fetched on open. */
  private async card(p: CardRow, viewerId: number) {
    return {
      id: p.id,
      width: p.width,
      height: p.height,
      thumbUrl: await this.ctx.storage.readUrl(p.thumb_key),
      title: p.title,
      uploader: p.uploader_name,
      mine: p.uploader_id === viewerId,
      takenAt: p.taken_at,
    };
  }

  /** A photo the viewer may see: ready, and its roll developed. 404 otherwise, so locked photos don't leak. */
  private visible(id: number): CardRow {
    const p = this.db.prepare(`${SELECT_CARD} WHERE p.id = ? AND p.status = 'ready'`).get(VOTE, id) as CardRow | undefined;
    if (!p || !this.isDeveloped(this.rollOf(p))) throw new HttpError(404, 'Photo not found');
    return p;
  }

  async detail(id: number, viewerId: number) {
    const p = this.visible(id);
    const captions = this.db
      .prepare(
        `SELECT c.id, c.body, c.user_id, c.created_at, COALESCE(u.display_name, u.username) AS author,
                (SELECT COUNT(*) FROM reactions r WHERE r.target_type = 'caption' AND r.target_id = c.id AND r.emoji = ?) AS votes,
                EXISTS (SELECT 1 FROM reactions r WHERE r.target_type = 'caption' AND r.target_id = c.id AND r.emoji = ? AND r.user_id = ?) AS voted
         FROM photo_captions c JOIN users u ON u.id = c.user_id WHERE c.photo_id = ? ORDER BY votes DESC, c.id ASC LIMIT 200`,
      )
      .all(VOTE, VOTE, viewerId, id) as { id: number; body: string; user_id: number; author: string; created_at: string; votes: number; voted: number }[];
    const top = captions.find((c) => c.votes > 0);
    return {
      photo: {
        ...(await this.card(p, viewerId)),
        displayUrl: await this.ctx.storage.readUrl(p.display_key),
        eventId: p.event_id,
        night: this.rollNight(this.rollOf(p)),
        title: top?.body ?? null,
        titleCaptionId: top?.id ?? null,
      },
      captions: captions.map((c) => ({
        id: c.id, body: c.body, author: c.author, mine: c.user_id === viewerId, votes: c.votes, voted: !!c.voted, createdAt: c.created_at,
      })),
      neighbors: this.neighbors(p),
      can: { veto: true, delete: p.uploader_id === viewerId, original: p.uploader_id === viewerId },
    };
  }

  /** Previous/next photo ids in the same roll, for swiping. */
  private neighbors(p: PhotoRow) {
    const [where, args] = this.rollWhere(this.rollOf(p));
    const q = (cmp: string, dir: string) =>
      (this.db
        .prepare(
          `SELECT p.id FROM photos p WHERE ${where} AND p.status = 'ready'
           AND (p.taken_at ${cmp} ? OR (p.taken_at = ? AND p.id ${cmp} ?)) ORDER BY p.taken_at ${dir}, p.id ${dir} LIMIT 1`,
        )
        .get(...args, p.taken_at, p.taken_at, p.id) as { id: number } | undefined)?.id ?? null;
    return { prev: q('<', 'DESC'), next: q('>', 'ASC') };
  }

  /** The untouched original, for the person who took it and nobody else. */
  async originalUrl(id: number, viewerId: number) {
    const p = this.db.prepare(`SELECT * FROM photos WHERE id = ? AND status = 'ready'`).get(id) as PhotoRow | undefined;
    if (!p || p.uploader_id !== viewerId) throw new HttpError(404, 'Photo not found');
    return { url: await this.ctx.storage.readUrl(p.original_key), mime: p.mime };
  }

  /** Recent rolls, newest first: developed ones with a cover, locked ones as counts only. */
  async rolls(viewerId: number, limit = 40) {
    const rows = this.db
      .prepare(
        `SELECT p.event_id, CASE WHEN p.event_id IS NULL THEN p.night END AS night,
                COUNT(*) AS n, COUNT(DISTINCT p.uploader_id) AS shooters, COALESCE(SUM(p.uploader_id = ?), 0) AS mine,
                MAX(p.taken_at) AS last_at, MIN(p.id) AS first_id
         FROM photos p WHERE p.status = 'ready'
         GROUP BY p.event_id, CASE WHEN p.event_id IS NULL THEN p.night END
         ORDER BY last_at DESC LIMIT ?`,
      )
      .all(viewerId, limit) as { event_id: number | null; night: string | null; n: number; shooters: number; mine: number; first_id: number }[];
    const out = [];
    for (const r of rows) {
      const roll: Roll = { eventId: r.event_id, night: r.night ?? '' };
      let unlock: number;
      try {
        unlock = this.unlockAt(roll);
      } catch {
        continue; // event deleted between query and lookup
      }
      const developed = clock.now() >= unlock;
      let coverUrl: string | null = null;
      if (developed) {
        const cover = this.db.prepare('SELECT thumb_key FROM photos WHERE id = ?').get(r.first_id) as { thumb_key: string } | undefined;
        if (cover) coverUrl = await this.ctx.storage.readUrl(cover.thumb_key);
      }
      out.push({
        eventId: r.event_id,
        eventTitle: r.event_id ? this.event(r.event_id)?.title ?? null : null,
        night: this.rollNight(roll),
        unlockAt: new Date(unlock).toISOString(),
        developed,
        count: r.n,
        shooters: r.shooters,
        mine: r.mine,
        coverUrl,
      });
    }
    return out;
  }

  /** "N years ago tonight": developed photos from today's month-day in earlier years. */
  async memories(viewerId: number) {
    const today = nightOf(clock.now(), this.tz);
    const md = monthDay(today);
    const year = today.slice(0, 4);
    // Event photos take their night from the event; compare on both stored and event nights.
    const rows = this.db
      .prepare(
        `${SELECT_CARD} WHERE p.status = 'ready' AND substr(p.night, 6) = ? AND substr(p.night, 1, 4) < ?
         ORDER BY p.night DESC, p.taken_at LIMIT 60`,
      )
      .all(VOTE, md, year) as CardRow[];
    const groups = new Map<string, { night: string; yearsAgo: number; eventId: number | null; eventTitle: string | null; photos: unknown[] }>();
    for (const p of rows) {
      const night = this.rollNight(this.rollOf(p));
      if (monthDay(night) !== md || night >= today) continue;
      const k = `${p.event_id ?? ''}|${night}`;
      if (!groups.has(k))
        groups.set(k, {
          night, yearsAgo: Number(year) - Number(night.slice(0, 4)), eventId: p.event_id,
          eventTitle: p.event_id ? this.event(p.event_id)?.title ?? null : null, photos: [],
        });
      groups.get(k)!.photos.push(await this.card(p, viewerId));
    }
    return [...groups.values()];
  }

  // ------------------------------------------------------------- writes
  /**
   * Reserve three storage keys and hand back presigned upload targets. The row
   * stays 'pending' (invisible everywhere) until commit() verifies the objects.
   */
  async create(userId: number, input: {
    eventId?: unknown; takenAt?: unknown; mime?: unknown; derivedMime?: unknown; width?: unknown; height?: unknown;
    sizes?: { original?: unknown; display?: unknown; thumb?: unknown };
  }) {
    const mime = String(input.mime ?? '').toLowerCase();
    const derived = String(input.derivedMime ?? 'image/jpeg').toLowerCase();
    if (!ORIGINAL_TYPES[mime]) throw new HttpError(400, 'Photos only: JPEG, PNG, WebP or HEIC');
    if (!DERIVED_TYPES[derived]) throw new HttpError(400, 'Resized copies must be JPEG or WebP');
    const width = int(input.width, 1, 20000, 'width');
    const height = int(input.height, 1, 20000, 'height');
    const sizes = {
      original: int(input.sizes?.original, 1, LIMITS.originalBytes, `That photo is too big (${MAX_PHOTO_BYTES >> 20} MB max)`),
      display: int(input.sizes?.display, 1, LIMITS.displayBytes, 'display size'),
      thumb: int(input.sizes?.thumb, 1, LIMITS.thumbBytes, 'thumb size'),
    };
    const eventId = input.eventId === undefined || input.eventId === null || input.eventId === '' ? null : int(input.eventId, 1, Number.MAX_SAFE_INTEGER, 'eventId');
    // Trust the phone's capture time only if it is recent; otherwise it's "now".
    const t = clock.now();
    const claimed = typeof input.takenAt === 'string' ? Date.parse(input.takenAt) : NaN;
    const takenMs = Number.isFinite(claimed) && claimed <= t + 5 * 60_000 && claimed >= t - 72 * 3600_000 ? Math.min(claimed, t) : t;
    const roll = this.currentRoll(eventId, takenMs);

    const keys = { original: newKey(ORIGINAL_TYPES[mime]), display: newKey(DERIVED_TYPES[derived]), thumb: newKey(DERIVED_TYPES[derived]) };
    const id = tx(this.db, () => {
      const used = (this.db.prepare('SELECT COUNT(*) AS n FROM photos WHERE uploader_id = ? AND night = ?').get(userId, roll.night) as { n: number }).n;
      if (used >= LIMITS.perUserPerNight) throw new HttpError(429, 'That’s a full roll. Put the camera down.');
      return Number(
        this.db
          .prepare(
            `INSERT INTO photos (event_id, night, uploader_id, original_key, display_key, thumb_key, mime, width, height, bytes, taken_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(roll.eventId, roll.night, userId, keys.original, keys.display, keys.thumb, mime, width, height,
            sizes.original + sizes.display + sizes.thumb, new Date(takenMs).toISOString()).lastInsertRowid,
      );
    });
    const s = this.ctx.storage;
    return {
      id,
      uploads: {
        original: await s.uploadTarget(keys.original, mime === 'image/heif' ? 'image/heic' : mime),
        display: await s.uploadTarget(keys.display, derived),
        thumb: await s.uploadTarget(keys.thumb, derived),
      },
      sizes,
      unlockAt: new Date(this.unlockAt(roll)).toISOString(),
    };
  }

  /** Verify the three objects landed (and aren't bigger than allowed), then make the photo real. */
  async commit(id: number, userId: number) {
    const p = this.db.prepare('SELECT * FROM photos WHERE id = ? AND uploader_id = ?').get(id, userId) as PhotoRow | undefined;
    if (!p) throw new HttpError(404, 'Photo not found');
    if (p.status === 'ready') return this.commitResult(p);
    const s = this.ctx.storage;
    const [o, d, th] = await Promise.all([s.size(p.original_key), s.size(p.display_key), s.size(p.thumb_key)]);
    if (o == null || d == null || th == null) throw new HttpError(409, 'The upload didn’t finish. Try again.');
    if (o > LIMITS.originalBytes || d > LIMITS.displayBytes || th > LIMITS.thumbBytes) {
      this.purge(p);
      throw new HttpError(413, 'That photo is too big');
    }
    this.db.prepare(`UPDATE photos SET status = 'ready', bytes = ?, ready_at = ? WHERE id = ?`).run(o + d + th, now(), id);
    this.ctx.bus.emit('live', { topic: 'photos' });
    return this.commitResult(p);
  }

  private commitResult(p: PhotoRow) {
    const roll = this.rollOf(p);
    const unlock = this.unlockAt(roll);
    return { id: p.id, developed: clock.now() >= unlock, unlockAt: new Date(unlock).toISOString() };
  }

  /** Delete the row and queue its objects for deletion, in one transaction. */
  private purge(p: PhotoRow) {
    tx(this.db, () => {
      for (const k of [p.original_key, p.display_key, p.thumb_key]) queueStorageDelete(this.db, k);
      this.db
        .prepare(`DELETE FROM reactions WHERE target_type = 'caption' AND target_id IN (SELECT id FROM photo_captions WHERE photo_id = ?)`)
        .run(p.id);
      this.db.prepare(`DELETE FROM reactions WHERE target_type = 'photo' AND target_id = ?`).run(p.id);
      this.db.prepare('DELETE FROM photos WHERE id = ?').run(p.id);
    });
  }

  /** Anyone can kill a developed photo. No vote, no questions, no undo. */
  veto(id: number, userId: number) {
    const p = this.visible(id);
    tx(this.db, () => {
      this.purge(p);
      this.db.prepare('INSERT INTO vetoes (user_id, event_id, night) VALUES (?, ?, ?)').run(userId, p.event_id, p.night);
    });
    this.ctx.bus.emit('live', { topic: 'photos' });
    return { ok: true };
  }

  /** The uploader can take back their own shot at any time, developed or not. */
  remove(id: number, userId: number) {
    const p = this.db.prepare('SELECT * FROM photos WHERE id = ? AND uploader_id = ?').get(id, userId) as PhotoRow | undefined;
    if (!p) throw new HttpError(404, 'Photo not found');
    this.purge(p);
    this.ctx.bus.emit('live', { topic: 'photos' });
    return { ok: true };
  }

  /** Undeveloped shots the viewer took tonight, as counts only: "you've shot 7". */
  myLockedCount(userId: number, r: Roll) {
    const [where, args] = this.rollWhere(r);
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM photos p WHERE ${where} AND p.status = 'ready' AND p.uploader_id = ?`).get(...args, userId) as { n: number }).n;
  }

  addCaption(photoId: number, userId: number, body: unknown) {
    this.visible(photoId);
    const text = String(body ?? '').trim().replace(/\s+/g, ' ');
    if (!text) throw new HttpError(400, 'Write a caption first');
    if (text.length > LIMITS.captionChars) throw new HttpError(400, `Captions max out at ${LIMITS.captionChars} characters`);
    const id = Number(this.db.prepare('INSERT INTO photo_captions (photo_id, user_id, body) VALUES (?, ?, ?)').run(photoId, userId, text).lastInsertRowid);
    // Your own caption starts with your own vote, like Reddit.
    this.db.prepare(`INSERT OR IGNORE INTO reactions (target_type, target_id, user_id, emoji) VALUES ('caption', ?, ?, ?)`).run(id, userId, VOTE);
    return { id };
  }

  voteCaption(captionId: number, userId: number, on: boolean) {
    const c = this.db.prepare('SELECT photo_id FROM photo_captions WHERE id = ?').get(captionId) as { photo_id: number } | undefined;
    if (!c) throw new HttpError(404, 'Caption not found');
    this.visible(c.photo_id);
    if (on) this.db.prepare(`INSERT OR IGNORE INTO reactions (target_type, target_id, user_id, emoji) VALUES ('caption', ?, ?, ?)`).run(captionId, userId, VOTE);
    else this.db.prepare(`DELETE FROM reactions WHERE target_type = 'caption' AND target_id = ? AND user_id = ? AND emoji = ?`).run(captionId, userId, VOTE);
    return { ok: true };
  }

  deleteCaption(captionId: number, userId: number) {
    const c = this.db.prepare('SELECT user_id FROM photo_captions WHERE id = ?').get(captionId) as { user_id: number } | undefined;
    if (!c || c.user_id !== userId) throw new HttpError(404, 'Caption not found');
    tx(this.db, () => {
      this.db.prepare(`DELETE FROM reactions WHERE target_type = 'caption' AND target_id = ?`).run(captionId);
      this.db.prepare('DELETE FROM photo_captions WHERE id = ?').run(captionId);
    });
    return { ok: true };
  }

  /** Wrapped hook: photos shot and vetoed by a member in a year. */
  stats(userId: number, year: string) {
    const shot = (this.db.prepare(`SELECT COUNT(*) AS n FROM photos WHERE uploader_id = ? AND status = 'ready' AND substr(night, 1, 4) = ?`).get(userId, year) as { n: number }).n;
    const vetoed = (this.db.prepare(`SELECT COUNT(*) AS n FROM vetoes WHERE user_id = ? AND substr(night, 1, 4) = ?`).get(userId, year) as { n: number }).n;
    return { shot, vetoed };
  }

  /**
   * Member removal. keep: their photos stay, credited. anonymize: photos stay, and
   * their captions go (captions are words, photos are the group's). delete: everything.
   */
  memberRemoved(userId: number, policy: 'keep' | 'anonymize' | 'delete') {
    if (policy === 'keep') return;
    const caps = this.db.prepare('SELECT id FROM photo_captions WHERE user_id = ?').all(userId) as { id: number }[];
    for (const c of caps) this.db.prepare(`DELETE FROM reactions WHERE target_type = 'caption' AND target_id = ?`).run(c.id);
    this.db.prepare('DELETE FROM photo_captions WHERE user_id = ?').run(userId);
    if (policy === 'delete') {
      for (const p of this.db.prepare('SELECT * FROM photos WHERE uploader_id = ?').all(userId) as PhotoRow[]) this.purge(p);
    }
  }

  // ------------------------------------------------------------- tick
  /**
   * Idempotent (keys in core jobs_sent), safe to run every minute from any
   * number of processes:
   *  - announce each roll that developed in the last 24h ("Brace yourself"),
   *  - once a day at the unlock hour, nudge "N years ago tonight" memories,
   *  - drop pending uploads abandoned for over 2h.
   */
  tick() {
    const t = clock.now();
    const recent = new Date(t - 4 * 86400_000).toISOString();
    const rolls = this.db
      .prepare(
        `SELECT p.event_id, CASE WHEN p.event_id IS NULL THEN p.night END AS night, COUNT(*) AS n
         FROM photos p WHERE p.status = 'ready' AND p.taken_at >= ?
         GROUP BY p.event_id, CASE WHEN p.event_id IS NULL THEN p.night END`,
      )
      .all(recent) as { event_id: number | null; night: string | null; n: number }[];
    for (const r of rolls) {
      const roll: Roll = { eventId: r.event_id, night: r.night ?? '' };
      let unlock: number;
      try {
        unlock = this.unlockAt(roll);
      } catch {
        continue;
      }
      if (unlock > t || unlock < t - 86400_000) continue;
      const night = this.rollNight(roll);
      const key = r.event_id ? `photos:drop:e${r.event_id}:${night}` : `photos:drop:n${night}`;
      if (!this.claimJob(key)) continue;
      const title = r.event_id ? this.event(r.event_id)?.title : null;
      const body = `📸 ${title ? `The roll from ${title}` : 'Last night’s roll'} is developed. ${r.n} photo${r.n === 1 ? '' : 's'}. Brace yourself.`;
      const link = r.event_id ? `/events/${r.event_id}` : `/photos/night/${night}`;
      this.feed('photo_drop', r.event_id, body);
      this.ctx.svc.notifyMembers(body, link);
    }

    // Memories: once a day, after the unlock hour.
    const today = localDate(t, this.tz);
    if (t >= unlockAt(nightOf(t - 86400_000, this.tz), this.tz, this.unlockHour) && this.claimJob(`photos:memories:${today}`)) {
      const md = today.slice(5);
      const old = this.db
        .prepare(`SELECT MIN(night) AS night, COUNT(*) AS n FROM photos WHERE status = 'ready' AND substr(night, 6) = ? AND substr(night, 1, 4) < ?`)
        .get(md, today.slice(0, 4)) as { night: string | null; n: number };
      if (old.n > 0 && old.night) {
        const years = Number(today.slice(0, 4)) - Number(old.night.slice(0, 4));
        this.ctx.svc.notifyMembers(`🕰️ ${years} year${years === 1 ? '' : 's'} ago tonight. ${old.n} photo${old.n === 1 ? '' : 's'} you may not remember taking.`, '/photos/memories');
      }
    }

    const stale = this.db
      .prepare(`SELECT * FROM photos WHERE status = 'pending' AND created_at < ?`)
      .all(new Date(t - LIMITS.pendingTtlMs).toISOString()) as PhotoRow[];
    for (const p of stale) this.purge(p);
  }

  private claimJob(key: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO jobs_sent (key, sent_at) VALUES (?, ?)').run(key, now()).changes === 1;
  }

  private feed(kind: string, eventId: number | null, body: string) {
    this.db
      .prepare(`INSERT INTO feed_items (kind, actor_id, event_id, subject_type, subject_id, body, created_at) VALUES (?, NULL, ?, 'photo_roll', ?, ?, ?)`)
      .run(kind, eventId, eventId, body, now());
  }
}

function int(v: unknown, min: number, max: number, what: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, what.includes(' ') ? what : `Bad ${what}`);
  return n;
}
