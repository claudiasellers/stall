// Night-of tools domain logic. Routes stay thin; everything time-based is
// decided from database state so the tick (and lazy reads) are idempotent.
import { type Db, tx, now } from '../../db.ts';
import { HttpError } from '../../service.ts';

/** The slice of the module context this file needs. */
export type NightCtx = {
  db: Db;
  svc: {
    notify(userId: number, requestId: number | null, body: string, link?: string): void;
    notifyMembers(body: string, link?: string, exceptId?: number): void;
  };
  bus: { emit(event: string, ...args: unknown[]): boolean };
};

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Home Safe ladder, measured from the cutoff. */
export const BUDDY_PING_AFTER = 60 * MIN;
export const GROUP_PING_AFTER = 90 * MIN;
/** Sessions close themselves this long after the cutoff, home or not. */
const SESSION_MAX_AFTER_CUTOFF = 12 * HOUR;
const POLL_MINUTES_DEFAULT = 10;
const COOKED_WINDOW = 12 * HOUR;
export const COOKED_BUDDY_LEVEL = 9;
/** "You've owed Max $340 for 19 days": first nudge after this many days, then weekly. */
const NUDGE_AFTER_DAYS = 7;
const NUDGE_EVERY_DAYS = 7;

export const COOKED_LABELS: Record<number, string> = {
  1: 'one glass of natural wine',
  2: 'pleasantly warm',
  3: 'chatty',
  4: 'texting in full paragraphs',
  5: 'ordering another round "for the table"',
  6: 'dancing to songs I hate',
  7: 'telling everyone I love them',
  8: 'lost my card, found someone else’s',
  9: 'needs a buddy, assigning one',
  10: 'speaking only French',
};

const NAME = `COALESCE(NULLIF(u.display_name, ''), u.username)`;
const MEMBER = `u.removed_at IS NULL`;

type Session = { id: number; event_id: number | null; title: string; started_by: number; cutoff_at: string; status: string; closed_at: string | null; created_at: string };
type Member = { session_id: number; user_id: number; name: string; buddy_id: number | null; home_at: string | null; escalation: number; share_location: number; lat: number | null; lng: number | null; location_at: string | null };

const clean = (v: unknown, name: string, max: number, required = true): string => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s && required) throw new HttpError(400, `${name} is required`);
  if (s.length > max) throw new HttpError(400, `${name} is too long (max ${max})`);
  return s;
};
const optInt = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Bad id');
  return n;
};
const isoOrThrow = (v: unknown, name: string): string => {
  const t = Date.parse(String(v ?? ''));
  if (!Number.isFinite(t)) throw new HttpError(400, `${name} must be a date/time`);
  return new Date(t).toISOString();
};
export const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

export class NightService {
  ctx: NightCtx;
  db: Db;
  constructor(ctx: NightCtx) {
    this.ctx = ctx;
    this.db = ctx.db;
  }

  private refresh(scope = 'night') {
    queueMicrotask(() => this.ctx.bus.emit('board', { scope }));
  }

  memberIds(): number[] {
    return (this.db.prepare(`SELECT id FROM users u WHERE ${MEMBER}`).all() as { id: number }[]).map((r) => r.id);
  }
  private assertMember(userId: number) {
    if (!this.db.prepare(`SELECT 1 FROM users u WHERE u.id = ? AND ${MEMBER}`).get(userId)) throw new HttpError(400, 'Not a member');
  }
  private nameOf(userId: number): string {
    return (this.db.prepare(`SELECT ${NAME} AS name FROM users u WHERE u.id = ?`).get(userId) as { name: string } | undefined)?.name ?? 'Someone';
  }
  private feed(kind: string, actorId: number | null, eventId: number | null, subjectType: string, subjectId: number, body: string) {
    // feed_items is foundation-owned; tolerate its absence so night tools never break on it.
    try {
      this.db
        .prepare('INSERT INTO feed_items (kind, actor_id, event_id, subject_type, subject_id, body) VALUES (?, ?, ?, ?, ?, ?)')
        .run(kind, actorId, eventId, subjectType, subjectId, body);
    } catch {}
  }
  /** Idempotency key for a push the tick must send at most once. */
  private once(key: string): boolean {
    try {
      return this.db.prepare('INSERT OR IGNORE INTO jobs_sent (key) VALUES (?)').run(key).changes === 1;
    } catch {
      return true;
    }
  }

  // ======================================================== Home Safe

  activeSessions(): Session[] {
    return this.db.prepare(`SELECT * FROM night_sessions WHERE status = 'active' ORDER BY cutoff_at`).all() as Session[];
  }

  private members(sessionId: number): Member[] {
    return this.db
      .prepare(
        `SELECT m.*, ${NAME} AS name FROM night_members m JOIN users u ON u.id = m.user_id
         WHERE m.session_id = ? ORDER BY ${NAME} COLLATE NOCASE`,
      )
      .all(sessionId) as Member[];
  }

  private mustSession(id: number): Session {
    const s = this.db.prepare('SELECT * FROM night_sessions WHERE id = ?').get(id) as Session | undefined;
    if (!s) throw new HttpError(404, 'Night not found');
    return s;
  }

  /** Buddies responsible for userId: whoever they point at, and whoever points at them (trios happen with odd counts). */
  private buddiesOf(sessionId: number, userId: number): number[] {
    const rows = this.db
      .prepare(
        `SELECT buddy_id AS id FROM night_members WHERE session_id = ? AND user_id = ? AND buddy_id IS NOT NULL
         UNION SELECT user_id AS id FROM night_members WHERE session_id = ? AND buddy_id = ?`,
      )
      .all(sessionId, userId, sessionId, userId) as { id: number }[];
    return rows.map((r) => r.id).filter((id) => id !== userId);
  }

  startSession(userId: number, body: { title?: unknown; cutoffAt?: unknown; eventId?: unknown; memberIds?: unknown; pairing?: unknown; pairs?: unknown }) {
    const cutoffAt = isoOrThrow(body.cutoffAt, 'cutoffAt');
    const eventId = optInt(body.eventId);
    const title = clean(body.title, 'title', 80, false) || 'Tonight';
    const all = new Set(this.memberIds());
    let ids = Array.isArray(body.memberIds) ? [...new Set(body.memberIds.map(Number))].filter((id) => all.has(id)) : [];
    // From an event with no roster given: everyone whose RSVP isn't Out.
    if (!ids.length && eventId) {
      try {
        ids = (this.db.prepare(`SELECT user_id FROM rsvps WHERE event_id = ? AND status != 'out'`).all(eventId) as { user_id: number }[])
          .map((r) => r.user_id)
          .filter((id) => all.has(id));
      } catch {}
    }
    if (!ids.includes(userId)) ids.push(userId);
    if (ids.length < 1) throw new HttpError(400, 'Pick who’s out tonight');
    const id = tx(this.db, () => {
      if (eventId && this.db.prepare(`SELECT 1 FROM night_sessions WHERE event_id = ? AND status = 'active'`).get(eventId))
        throw new HttpError(409, 'This event already has a roll call running');
      const sid = Number(
        this.db.prepare('INSERT INTO night_sessions (event_id, title, started_by, cutoff_at) VALUES (?, ?, ?, ?)').run(eventId, title, userId, cutoffAt)
          .lastInsertRowid,
      );
      const ins = this.db.prepare('INSERT INTO night_members (session_id, user_id) VALUES (?, ?)');
      for (const uid of ids) ins.run(sid, uid);
      const manual = Array.isArray(body.pairs) ? (body.pairs as unknown[]) : [];
      if (body.pairing === 'manual' && manual.length) this.setPairs(sid, manual);
      else this.pairRandom(sid);
      return sid;
    });
    const starter = this.nameOf(userId);
    for (const uid of ids)
      if (uid !== userId) this.ctx.svc.notify(uid, null, `🏠 ${starter} started Home Safe for “${title}”. Check who your buddy is.`, `/#/tonight`);
    this.feed('home_safe_started', userId, eventId, 'night_session', id, `${starter} started Home Safe roll call`);
    this.refresh();
    return this.sessionView(id, userId);
  }

  joinSession(sessionId: number, userId: number) {
    const s = this.mustSession(sessionId);
    if (s.status !== 'active') throw new HttpError(409, 'This night is over');
    tx(this.db, () => {
      const r = this.db.prepare('INSERT OR IGNORE INTO night_members (session_id, user_id) VALUES (?, ?)').run(sessionId, userId);
      if (r.changes) this.assignBuddy(sessionId, userId);
    });
    this.refresh();
    return this.sessionView(sessionId, userId);
  }

  /** Shuffle everyone not yet home into pairs; an odd one out joins a pair as a trio. */
  pairRandom(sessionId: number) {
    const ids = (this.db.prepare('SELECT user_id FROM night_members WHERE session_id = ? AND home_at IS NULL').all(sessionId) as { user_id: number }[]).map((r) => r.user_id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const set = this.db.prepare('UPDATE night_members SET buddy_id = ? WHERE session_id = ? AND user_id = ?');
    this.db.prepare('UPDATE night_members SET buddy_id = NULL WHERE session_id = ? AND home_at IS NULL').run(sessionId);
    for (let i = 0; i + 1 < ids.length; i += 2) {
      set.run(ids[i + 1], sessionId, ids[i]);
      set.run(ids[i], sessionId, ids[i + 1]);
    }
    if (ids.length % 2 === 1 && ids.length > 1) set.run(ids[0], sessionId, ids[ids.length - 1]);
  }

  /** Manual pairs: [[a, b], ...]. Anyone left over is paired randomly afterwards. */
  setPairs(sessionId: number, pairs: unknown[]) {
    const inSession = new Set((this.db.prepare('SELECT user_id FROM night_members WHERE session_id = ?').all(sessionId) as { user_id: number }[]).map((r) => r.user_id));
    const set = this.db.prepare('UPDATE night_members SET buddy_id = ? WHERE session_id = ? AND user_id = ?');
    this.db.prepare('UPDATE night_members SET buddy_id = NULL WHERE session_id = ?').run(sessionId);
    const used = new Set<number>();
    for (const p of pairs) {
      if (!Array.isArray(p) || p.length !== 2) throw new HttpError(400, 'Pairs must be [a, b]');
      const [a, b] = p.map(Number);
      if (a === b || !inSession.has(a) || !inSession.has(b) || used.has(a) || used.has(b)) throw new HttpError(400, 'Bad pair');
      set.run(b, sessionId, a);
      set.run(a, sessionId, b);
      used.add(a).add(b);
    }
    for (const uid of inSession) if (!used.has(uid)) this.assignBuddy(sessionId, uid);
  }

  /**
   * Give one person a buddy: prefer someone still out, unpaired, and least cooked;
   * otherwise attach them to the least-cooked pair as a trio.
   */
  assignBuddy(sessionId: number, userId: number): number | null {
    const candidates = this.db
      .prepare(
        `SELECT m.user_id, m.buddy_id,
           COALESCE((SELECT level FROM cooked_reports c WHERE c.user_id = m.user_id AND c.created_at >= ? ORDER BY c.id DESC LIMIT 1), 0) AS cooked
         FROM night_members m WHERE m.session_id = ? AND m.user_id != ? AND m.home_at IS NULL
         ORDER BY (m.buddy_id IS NOT NULL), cooked, RANDOM()`,
      )
      .all(new Date(Date.now() - COOKED_WINDOW).toISOString(), sessionId, userId) as { user_id: number; buddy_id: number | null; cooked: number }[];
    const pick = candidates.find((c) => c.cooked < COOKED_BUDDY_LEVEL) ?? candidates[0];
    if (!pick) return null;
    this.db.prepare('UPDATE night_members SET buddy_id = ? WHERE session_id = ? AND user_id = ?').run(pick.user_id, sessionId, userId);
    if (pick.buddy_id === null) this.db.prepare('UPDATE night_members SET buddy_id = ? WHERE session_id = ? AND user_id = ?').run(userId, sessionId, pick.user_id);
    return pick.user_id;
  }

  reshuffle(sessionId: number, userId: number) {
    const s = this.mustSession(sessionId);
    if (s.started_by !== userId) throw new HttpError(403, 'Only whoever started the night can reshuffle');
    tx(this.db, () => this.pairRandom(sessionId));
    for (const m of this.members(sessionId)) if (!m.home_at && m.buddy_id) this.ctx.svc.notify(m.user_id, null, `🔀 Buddies reshuffled. You’re with ${this.nameOf(m.buddy_id)} now.`, '/#/tonight');
    this.refresh();
    return this.sessionView(sessionId, userId);
  }

  pickBuddy(sessionId: number, userId: number, buddyId: number) {
    tx(this.db, () => {
      const me = this.db.prepare('SELECT * FROM night_members WHERE session_id = ? AND user_id = ?').get(sessionId, userId);
      const them = this.db.prepare('SELECT * FROM night_members WHERE session_id = ? AND user_id = ?').get(sessionId, buddyId);
      if (!me || !them || userId === buddyId) throw new HttpError(400, 'You can only buddy up with someone out tonight');
      // Unhook both from old partners, then pair.
      this.db.prepare('UPDATE night_members SET buddy_id = NULL WHERE session_id = ? AND buddy_id IN (?, ?)').run(sessionId, userId, buddyId);
      this.db.prepare('UPDATE night_members SET buddy_id = ? WHERE session_id = ? AND user_id = ?').run(buddyId, sessionId, userId);
      this.db.prepare('UPDATE night_members SET buddy_id = ? WHERE session_id = ? AND user_id = ?').run(userId, sessionId, buddyId);
      // Anyone orphaned by this gets re-homed.
      const orphans = this.db.prepare('SELECT user_id FROM night_members WHERE session_id = ? AND buddy_id IS NULL AND home_at IS NULL').all(sessionId) as { user_id: number }[];
      for (const o of orphans) this.assignBuddy(sessionId, o.user_id);
    });
    this.ctx.svc.notify(buddyId, null, `🤝 ${this.nameOf(userId)} picked you as their buddy tonight.`, '/#/tonight');
    this.refresh();
    return this.sessionView(sessionId, userId);
  }

  tapHome(sessionId: number, userId: number) {
    const s = this.mustSession(sessionId);
    const m = this.db.prepare('SELECT * FROM night_members WHERE session_id = ? AND user_id = ?').get(sessionId, userId) as Member | undefined;
    if (!m) throw new HttpError(404, 'You’re not on tonight’s roll call');
    if (m.home_at) return this.sessionView(sessionId, userId);
    const name = this.nameOf(userId);
    const lateLevel = m.escalation;
    let allHome = false;
    tx(this.db, () => {
      this.db
        .prepare('UPDATE night_members SET home_at = ?, share_location = 0, lat = NULL, lng = NULL, location_at = NULL WHERE session_id = ? AND user_id = ?')
        .run(now(), sessionId, userId);
      const left = (this.db.prepare('SELECT COUNT(*) AS n FROM night_members WHERE session_id = ? AND home_at IS NULL').get(sessionId) as { n: number }).n;
      if (left === 0 && s.status === 'active') {
        this.db.prepare(`UPDATE night_sessions SET status = 'closed', closed_at = ? WHERE id = ?`).run(now(), sessionId);
        allHome = true;
      }
    });
    if (lateLevel >= 3) {
      // The group was told they were missing; tell the group they're fine.
      this.ctx.svc.notifyMembers(`🏠 Panic over: ${name} is home safe.`, '/#/tonight', userId);
    } else {
      for (const b of this.buddiesOf(sessionId, userId)) this.ctx.svc.notify(b, null, `🏠 ${name} is home safe.`, '/#/tonight');
    }
    if (allHome) {
      for (const mm of this.members(sessionId)) this.ctx.svc.notify(mm.user_id, null, `✅ Everyone from “${s.title}” is home. Roll call closed.`, '/#/tonight');
      this.feed('home_safe_closed', null, s.event_id, 'night_session', sessionId, `Everyone made it home from “${s.title}”`);
    }
    this.refresh();
    return this.sessionView(sessionId, userId);
  }

  /** Optional live location, shared with buddies only, wiped on 🏠. */
  shareLocation(sessionId: number, userId: number, body: { lat?: unknown; lng?: unknown; stop?: unknown }) {
    const m = this.db.prepare('SELECT home_at FROM night_members WHERE session_id = ? AND user_id = ?').get(sessionId, userId) as { home_at: string | null } | undefined;
    if (!m) throw new HttpError(404, 'You’re not on tonight’s roll call');
    if (body.stop || m.home_at) {
      this.db.prepare('UPDATE night_members SET share_location = 0, lat = NULL, lng = NULL, location_at = NULL WHERE session_id = ? AND user_id = ?').run(sessionId, userId);
    } else {
      const lat = Number(body.lat), lng = Number(body.lng);
      if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) throw new HttpError(400, 'Bad location');
      this.db.prepare('UPDATE night_members SET share_location = 1, lat = ?, lng = ?, location_at = ? WHERE session_id = ? AND user_id = ?').run(lat, lng, now(), sessionId, userId);
    }
    this.refresh();
    return { ok: true };
  }

  extendCutoff(sessionId: number, userId: number, cutoffAt: unknown) {
    const s = this.mustSession(sessionId);
    const inIt = this.db.prepare('SELECT 1 FROM night_members WHERE session_id = ? AND user_id = ?').get(sessionId, userId);
    if (!inIt) throw new HttpError(403, 'Only people out tonight can move the cutoff');
    if (s.status !== 'active') throw new HttpError(409, 'This night is over');
    const at = isoOrThrow(cutoffAt, 'cutoffAt');
    tx(this.db, () => {
      this.db.prepare('UPDATE night_sessions SET cutoff_at = ? WHERE id = ?').run(at, sessionId);
      // Moving the cutoff restarts the ladder for anyone still out.
      this.db.prepare('UPDATE night_members SET escalation = 0 WHERE session_id = ? AND home_at IS NULL').run(sessionId);
    });
    this.refresh();
    return this.sessionView(sessionId, userId);
  }

  endSession(sessionId: number, userId: number) {
    const s = this.mustSession(sessionId);
    if (s.started_by !== userId) throw new HttpError(403, 'Only whoever started the night can end it');
    this.db.prepare(`UPDATE night_sessions SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'active'`).run(now(), sessionId);
    this.db.prepare('UPDATE night_members SET share_location = 0, lat = NULL, lng = NULL, location_at = NULL WHERE session_id = ?').run(sessionId);
    this.refresh();
    return { ok: true };
  }

  sessionView(sessionId: number, viewerId: number) {
    const s = this.mustSession(sessionId);
    const members = this.members(sessionId);
    const myBuddies = new Set(this.buddiesOf(sessionId, viewerId));
    const cutoff = Date.parse(s.cutoff_at);
    const nowMs = Date.now();
    const me = members.find((m) => m.user_id === viewerId);
    return {
      id: s.id,
      eventId: s.event_id,
      title: s.title,
      startedBy: s.started_by,
      cutoffAt: s.cutoff_at,
      status: s.status,
      closedAt: s.closed_at,
      phase: s.status !== 'active' ? 'closed' : nowMs < cutoff ? 'out' : nowMs < cutoff + BUDDY_PING_AFTER ? 'rollcall' : 'missing',
      joined: !!me,
      me: me ? { home: !!me.home_at, sharingLocation: !!me.share_location, buddyIds: [...myBuddies] } : null,
      members: members.map((m) => {
        const isBuddy = myBuddies.has(m.user_id);
        return {
          userId: m.user_id,
          name: m.name,
          buddyId: m.buddy_id,
          buddyName: m.buddy_id ? (members.find((x) => x.user_id === m.buddy_id)?.name ?? null) : null,
          home: !!m.home_at,
          homeAt: m.home_at,
          // Missing = past cutoff and not home. Escalation level is shown to everyone so the group can act.
          missing: !m.home_at && nowMs >= cutoff,
          escalation: m.escalation,
          isMyBuddy: isBuddy,
          // Live location only ever leaves the server for the person's own buddies.
          location: isBuddy && m.share_location && m.lat !== null ? { lat: m.lat, lng: m.lng, at: m.location_at } : null,
        };
      }),
    };
  }

  /** Active nights the viewer is in, or could join. */
  tonight(viewerId: number) {
    const sessions = this.activeSessions().map((s) => this.sessionView(s.id, viewerId));
    return sessions;
  }

  /** Tick: walk the Home Safe ladder. Each step is recorded on the member row, so re-running is a no-op. */
  tickHomeSafe(nowMs: number) {
    let sent = 0;
    for (const s of this.activeSessions()) {
      const cutoff = Date.parse(s.cutoff_at);
      if (nowMs >= cutoff + SESSION_MAX_AFTER_CUTOFF) {
        this.db.prepare(`UPDATE night_sessions SET status = 'closed', closed_at = ? WHERE id = ?`).run(new Date(nowMs).toISOString(), s.id);
        this.db.prepare('UPDATE night_members SET share_location = 0, lat = NULL, lng = NULL, location_at = NULL WHERE session_id = ?').run(s.id);
        continue;
      }
      if (nowMs < cutoff) continue;
      const out = this.members(s.id).filter((m) => !m.home_at);
      for (const m of out) {
        const target = nowMs >= cutoff + GROUP_PING_AFTER ? 3 : nowMs >= cutoff + BUDDY_PING_AFTER ? 2 : 1;
        if (m.escalation >= target) continue;
        // Claim the step first so a concurrent tick can't double-send.
        const claimed = this.db
          .prepare('UPDATE night_members SET escalation = ? WHERE session_id = ? AND user_id = ? AND escalation < ? AND home_at IS NULL')
          .run(target, s.id, m.user_id, target).changes;
        if (!claimed) continue;
        if (target >= 1 && m.escalation < 1) {
          this.ctx.svc.notify(m.user_id, null, `🏠 Roll call for “${s.title}”. Tap home when you’re in.`, '/#/tonight');
          sent++;
        }
        if (target >= 2 && m.escalation < 2) {
          const buddies = this.buddiesOf(s.id, m.user_id);
          for (const b of buddies) {
            this.ctx.svc.notify(b, null, `⚠️ ${m.name} hasn’t tapped home an hour after cutoff. You’re their buddy: check on them.`, '/#/tonight');
            sent++;
          }
        }
        if (target >= 3) {
          this.ctx.svc.notifyMembers(`🚨 ${m.name} still hasn’t tapped home from “${s.title}”. Has anyone heard from them?`, '/#/tonight', m.user_id);
          this.feed('home_safe_missing', m.user_id, s.event_id, 'night_session', s.id, `${m.name} is unaccounted for`);
          sent++;
        }
      }
      if (out.length) this.refresh();
    }
    return { sent };
  }

  // ======================================================== Where We At

  checkIn(userId: number, body: { venue?: unknown; nextVenue?: unknown; nextAt?: unknown; note?: unknown; eventId?: unknown }) {
    const venue = clean(body.venue, 'venue', 80);
    const nextVenue = clean(body.nextVenue, 'nextVenue', 80, false) || null;
    const nextAt = body.nextAt ? isoOrThrow(body.nextAt, 'nextAt') : null;
    const note = clean(body.note, 'note', 140, false) || null;
    const eventId = optInt(body.eventId);
    const id = Number(
      this.db.prepare('INSERT INTO night_checkins (event_id, user_id, venue, next_venue, next_at, note) VALUES (?, ?, ?, ?, ?, ?)').run(eventId, userId, venue, nextVenue, nextAt, note)
        .lastInsertRowid,
    );
    const name = this.nameOf(userId);
    const line = nextVenue ? `${name} is at ${venue} → moving to ${nextVenue}` : `${name} is at ${venue}`;
    this.feed('checkin', userId, eventId, 'night_checkin', id, line);
    this.refresh();
    return { id };
  }

  deleteCheckIn(id: number, userId: number) {
    const r = this.db.prepare('DELETE FROM night_checkins WHERE id = ? AND user_id = ?').run(id, userId);
    if (!r.changes) throw new HttpError(404, 'Not your check-in');
    this.refresh();
    return { ok: true };
  }

  /** The live trail: an event's check-ins, or everything in the last 12 hours. */
  trail(eventId: number | null) {
    const rows = (
      eventId
        ? this.db.prepare(`SELECT c.*, ${NAME} AS name FROM night_checkins c JOIN users u ON u.id = c.user_id WHERE c.event_id = ? ORDER BY c.created_at`).all(eventId)
        : this.db
            .prepare(`SELECT c.*, ${NAME} AS name FROM night_checkins c JOIN users u ON u.id = c.user_id WHERE c.created_at >= ? ORDER BY c.created_at`)
            .all(new Date(Date.now() - COOKED_WINDOW).toISOString())
    ) as { id: number; user_id: number; name: string; venue: string; next_venue: string | null; next_at: string | null; note: string | null; created_at: string; event_id: number | null }[];
    // Where is each person now (their latest check-in), and the group's stops in order.
    const latest = new Map<number, (typeof rows)[number]>();
    for (const r of rows) latest.set(r.user_id, r);
    const stops: { venue: string; firstAt: string; people: string[] }[] = [];
    for (const r of rows) {
      const last = stops[stops.length - 1];
      if (last && last.venue.toLowerCase() === r.venue.toLowerCase()) {
        if (!last.people.includes(r.name)) last.people.push(r.name);
      } else stops.push({ venue: r.venue, firstAt: r.created_at, people: [r.name] });
    }
    return {
      checkins: rows.map((r) => ({ id: r.id, userId: r.user_id, name: r.name, venue: r.venue, nextVenue: r.next_venue, nextAt: r.next_at, note: r.note, createdAt: r.created_at, eventId: r.event_id })),
      stops,
      whereIsEveryone: [...latest.values()].map((r) => ({ userId: r.user_id, name: r.name, venue: r.venue, since: r.created_at, nextVenue: r.next_venue })),
    };
  }

  // ======================================================== Next Move polls

  createPoll(userId: number, body: { question?: unknown; options?: unknown; minutes?: unknown; eventId?: unknown }) {
    const question = clean(body.question, 'question', 100, false) || 'Where next?';
    const options = (Array.isArray(body.options) ? body.options : []).map((o) => clean(o, 'option', 60, false)).filter(Boolean);
    if (options.length < 2 || options.length > 3) throw new HttpError(400, 'Give 2 or 3 options');
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) throw new HttpError(400, 'Options must be different');
    const minutes = body.minutes === undefined ? POLL_MINUTES_DEFAULT : Number(body.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new HttpError(400, 'Timer must be 1–60 minutes');
    const eventId = optInt(body.eventId);
    const closesAt = new Date(Date.now() + minutes * MIN).toISOString();
    const id = tx(this.db, () => {
      const pid = Number(this.db.prepare('INSERT INTO night_polls (event_id, user_id, question, closes_at) VALUES (?, ?, ?, ?)').run(eventId, userId, question, closesAt).lastInsertRowid);
      const ins = this.db.prepare('INSERT INTO night_poll_options (poll_id, position, label) VALUES (?, ?, ?)');
      options.forEach((label, i) => ins.run(pid, i, label));
      return pid;
    });
    const name = this.nameOf(userId);
    this.ctx.svc.notifyMembers(`🗳️ ${name}: “${question}” ${options.join(' / ')}. ${minutes} min to vote.`, `/#/tonight/poll/${id}`, userId);
    this.refresh();
    return this.pollView(id, userId);
  }

  vote(pollId: number, userId: number, optionId: number) {
    this.closeDuePolls(Date.now());
    const p = this.db.prepare('SELECT * FROM night_polls WHERE id = ?').get(pollId) as { closed_at: string | null } | undefined;
    if (!p) throw new HttpError(404, 'Poll not found');
    if (p.closed_at) throw new HttpError(409, 'Voting closed');
    if (!this.db.prepare('SELECT 1 FROM night_poll_options WHERE id = ? AND poll_id = ?').get(optionId, pollId)) throw new HttpError(400, 'Bad option');
    this.db
      .prepare('INSERT INTO night_poll_votes (poll_id, user_id, option_id) VALUES (?, ?, ?) ON CONFLICT (poll_id, user_id) DO UPDATE SET option_id = excluded.option_id, created_at = excluded.created_at')
      .run(pollId, userId, optionId);
    this.maybeCloseEarly(pollId);
    this.refresh();
    return this.pollView(pollId, userId);
  }

  /** Close early once every member has voted, or an option holds an outright majority of members. */
  private maybeCloseEarly(pollId: number) {
    const members = this.memberIds().length;
    const counts = this.db.prepare('SELECT option_id, COUNT(*) AS n FROM night_poll_votes WHERE poll_id = ? GROUP BY option_id').all(pollId) as { option_id: number; n: number }[];
    const total = counts.reduce((a, c) => a + c.n, 0);
    if (total >= members || counts.some((c) => c.n * 2 > members)) this.closePoll(pollId, Date.now());
  }

  private closePoll(pollId: number, nowMs: number) {
    const opts = this.db
      .prepare(
        `SELECT o.id, o.label, o.position, (SELECT COUNT(*) FROM night_poll_votes v WHERE v.option_id = o.id) AS n
         FROM night_poll_options o WHERE o.poll_id = ? ORDER BY n DESC, o.position`,
      )
      .all(pollId) as { id: number; label: string; n: number }[];
    const winner = opts[0]?.n ? opts[0] : null;
    const claimed = this.db
      .prepare('UPDATE night_polls SET closed_at = ?, winner_option_id = ? WHERE id = ? AND closed_at IS NULL')
      .run(new Date(nowMs).toISOString(), winner?.id ?? null, pollId).changes;
    if (!claimed) return;
    const p = this.db.prepare('SELECT * FROM night_polls WHERE id = ?').get(pollId) as { question: string; event_id: number | null; user_id: number };
    const tie = winner && opts[1] && opts[1].n === winner.n;
    const body = winner
      ? `📍 The group has spoken: ${winner.label}${tie ? ' (won the tiebreak)' : ''}. Move.`
      : `🦗 Nobody voted on “${p.question}”. Stay put, apparently.`;
    this.ctx.svc.notifyMembers(body, `/#/tonight/poll/${pollId}`);
    if (winner) this.feed('next_move', null, p.event_id, 'night_poll', pollId, `Next move: ${winner.label}`);
    this.refresh();
  }

  closeDuePolls(nowMs: number) {
    const due = this.db.prepare('SELECT id FROM night_polls WHERE closed_at IS NULL AND closes_at <= ?').all(new Date(nowMs).toISOString()) as { id: number }[];
    for (const d of due) this.closePoll(d.id, nowMs);
    return { closed: due.length };
  }

  pollView(pollId: number, viewerId: number) {
    const p = this.db.prepare(`SELECT p.*, ${NAME} AS name FROM night_polls p JOIN users u ON u.id = p.user_id WHERE p.id = ?`).get(pollId) as
      | { id: number; event_id: number | null; user_id: number; name: string; question: string; closes_at: string; closed_at: string | null; winner_option_id: number | null; created_at: string }
      | undefined;
    if (!p) throw new HttpError(404, 'Poll not found');
    const opts = this.db
      .prepare(
        `SELECT o.id, o.label, (SELECT COUNT(*) FROM night_poll_votes v WHERE v.option_id = o.id) AS votes FROM night_poll_options o WHERE o.poll_id = ? ORDER BY o.position`,
      )
      .all(pollId) as { id: number; label: string; votes: number }[];
    const mine = this.db.prepare('SELECT option_id FROM night_poll_votes WHERE poll_id = ? AND user_id = ?').get(pollId, viewerId) as { option_id: number } | undefined;
    const voters = this.db
      .prepare(`SELECT v.option_id, ${NAME} AS name FROM night_poll_votes v JOIN users u ON u.id = v.user_id WHERE v.poll_id = ?`)
      .all(pollId) as { option_id: number; name: string }[];
    return {
      id: p.id,
      eventId: p.event_id,
      by: p.name,
      question: p.question,
      closesAt: p.closes_at,
      closed: !!p.closed_at,
      winnerOptionId: p.winner_option_id,
      myOptionId: mine?.option_id ?? null,
      options: opts.map((o) => ({ ...o, voters: voters.filter((v) => v.option_id === o.id).map((v) => v.name) })),
      createdAt: p.created_at,
    };
  }

  polls(viewerId: number, eventId: number | null) {
    this.closeDuePolls(Date.now());
    const since = new Date(Date.now() - COOKED_WINDOW).toISOString();
    const ids = (
      eventId
        ? this.db.prepare('SELECT id FROM night_polls WHERE event_id = ? ORDER BY id DESC LIMIT 20').all(eventId)
        : this.db.prepare('SELECT id FROM night_polls WHERE created_at >= ? ORDER BY id DESC LIMIT 20').all(since)
    ) as { id: number }[];
    return ids.map((r) => this.pollView(r.id, viewerId));
  }

  // ======================================================== Cooked Meter

  reportCooked(userId: number, body: { level?: unknown; eventId?: unknown }) {
    const level = Number(body.level);
    if (!Number.isInteger(level) || level < 1 || level > 10) throw new HttpError(400, 'Level is 1–10');
    const eventId = optInt(body.eventId);
    this.db.prepare('INSERT INTO cooked_reports (user_id, event_id, level) VALUES (?, ?, ?)').run(userId, eventId, level);
    let buddy: { id: number; name: string } | null = null;
    if (level >= COOKED_BUDDY_LEVEL) {
      // At 9+ you get a buddy, automatically, in every active night you're in (joining one if needed).
      let sessions = this.db
        .prepare(`SELECT s.id FROM night_sessions s JOIN night_members m ON m.session_id = s.id WHERE s.status = 'active' AND m.user_id = ? AND m.home_at IS NULL`)
        .all(userId) as { id: number }[];
      if (!sessions.length) {
        const active = this.activeSessions().filter((s) => !eventId || s.event_id === eventId);
        if (active.length) {
          this.db.prepare('INSERT OR IGNORE INTO night_members (session_id, user_id) VALUES (?, ?)').run(active[0].id, userId);
          sessions = [{ id: active[0].id }];
        }
      }
      for (const s of sessions) {
        let current = this.buddiesOf(s.id, userId);
        if (!current.length) {
          const b = this.assignBuddy(s.id, userId);
          current = b ? [b] : [];
        }
        for (const b of current) this.ctx.svc.notify(b, null, `🥴 ${this.nameOf(userId)} just hit ${level}/10 on the Cooked Meter. You’re their buddy. Godspeed.`, '/#/tonight');
        if (current[0]) buddy = { id: current[0], name: this.nameOf(current[0]) };
      }
    }
    this.refresh();
    return { level, label: COOKED_LABELS[level], buddy };
  }

  cookedBoard() {
    const since = new Date(Date.now() - COOKED_WINDOW).toISOString();
    const rows = this.db
      .prepare(
        `SELECT c.user_id, ${NAME} AS name, c.level, c.created_at FROM cooked_reports c JOIN users u ON u.id = c.user_id
         WHERE c.id IN (SELECT MAX(id) FROM cooked_reports WHERE created_at >= ? GROUP BY user_id) ORDER BY c.level DESC, c.created_at DESC`,
      )
      .all(since) as { user_id: number; name: string; level: number; created_at: string }[];
    return rows.map((r) => ({ userId: r.user_id, name: r.name, level: r.level, label: COOKED_LABELS[r.level], at: r.created_at }));
  }

  /** For Stall Wrapped: lifetime per-member averages and peaks. */
  cookedStats(userId?: number) {
    const rows = this.db
      .prepare(
        `SELECT c.user_id, ${NAME} AS name, ROUND(AVG(c.level), 1) AS avg, MAX(c.level) AS peak, COUNT(*) AS reports,
           SUM(CASE WHEN c.level >= ${COOKED_BUDDY_LEVEL} THEN 1 ELSE 0 END) AS needed_buddy
         FROM cooked_reports c JOIN users u ON u.id = c.user_id ${userId ? 'WHERE c.user_id = ?' : ''} GROUP BY c.user_id ORDER BY avg DESC`,
      )
      .all(...(userId ? [userId] : [])) as { user_id: number; name: string; avg: number; peak: number; reports: number; needed_buddy: number }[];
    return rows;
  }

  // ======================================================== The Tab

  setVenmo(userId: number, handle: unknown) {
    const h = clean(handle, 'venmo', 40, false).replace(/^@/, '');
    if (h && !/^[A-Za-z0-9_-]{2,40}$/.test(h)) throw new HttpError(400, 'That doesn’t look like a Venmo username');
    this.db.prepare('INSERT INTO tab_handles (user_id, venmo) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET venmo = excluded.venmo').run(userId, h || null);
    return { venmo: h || null };
  }

  private venmoOf(userId: number): string | null {
    return (this.db.prepare('SELECT venmo FROM tab_handles WHERE user_id = ?').get(userId) as { venmo: string | null } | undefined)?.venmo ?? null;
  }

  /** https link opens the Venmo app on phones and the website elsewhere. */
  venmoLink(toUserId: number, cents: number, note: string, txn: 'pay' | 'charge' = 'pay'): string | null {
    const handle = this.venmoOf(toUserId);
    if (!handle) return null;
    const q = new URLSearchParams({ txn, amount: (cents / 100).toFixed(2), note });
    return `https://venmo.com/${encodeURIComponent(handle)}?${q}`;
  }

  /**
   * shares: omitted → equal split among splitWith (default: everyone out tonight or all members);
   * { userId: cents } → exact amounts that must add up.
   */
  addExpense(userId: number, body: { description?: unknown; amount?: unknown; amountCents?: unknown; payerId?: unknown; splitWith?: unknown; shares?: unknown; eventId?: unknown }) {
    const description = clean(body.description, 'description', 80);
    const amountCents = body.amountCents !== undefined ? Number(body.amountCents) : Math.round(Number(body.amount) * 100);
    if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 10_000_000) throw new HttpError(400, 'Amount must be more than $0');
    const payerId = optInt(body.payerId) ?? userId;
    this.assertMember(payerId);
    const eventId = optInt(body.eventId);
    const members = new Set(this.memberIds());
    let shares: [number, number][];
    if (body.shares && typeof body.shares === 'object' && !Array.isArray(body.shares)) {
      shares = Object.entries(body.shares as Record<string, unknown>).map(([k, v]) => [Number(k), Math.round(Number(v))]);
      if (shares.some(([u, c]) => !members.has(u) || !Number.isInteger(c) || c < 0)) throw new HttpError(400, 'Bad shares');
      if (shares.reduce((a, [, c]) => a + c, 0) !== amountCents) throw new HttpError(400, `Shares must add up to ${money(amountCents)}`);
    } else {
      const who = Array.isArray(body.splitWith) ? [...new Set(body.splitWith.map(Number))].filter((u) => members.has(u)) : [...members];
      if (!who.length) throw new HttpError(400, 'Split it with at least one person');
      // Equal split; leftover cents go one each to the first few (shuffled so nobody always eats the penny).
      const base = Math.floor(amountCents / who.length);
      let extra = amountCents - base * who.length;
      const order = [...who].sort(() => Math.random() - 0.5);
      shares = order.map((u) => [u, base + (extra-- > 0 ? 1 : 0)]);
    }
    const id = tx(this.db, () => {
      const eid = Number(
        this.db.prepare('INSERT INTO tab_expenses (event_id, payer_id, created_by, description, amount_cents) VALUES (?, ?, ?, ?, ?)').run(eventId, payerId, userId, description, amountCents)
          .lastInsertRowid,
      );
      const ins = this.db.prepare('INSERT INTO tab_shares (expense_id, user_id, amount_cents) VALUES (?, ?, ?)');
      for (const [u, c] of shares) if (c > 0) ins.run(eid, u, c);
      return eid;
    });
    const payer = this.nameOf(payerId);
    for (const [u, c] of shares)
      if (u !== payerId && c > 0) this.ctx.svc.notify(u, null, `💸 ${payer} covered “${description}”. Your share: ${money(c)}.`, '/#/tab');
    this.feed('tab_expense', payerId, eventId, 'tab_expense', id, `${payer} covered ${description} (${money(amountCents)})`);
    this.refresh('tab');
    return { id };
  }

  deleteExpense(id: number, userId: number, isAdmin: boolean) {
    const e = this.db.prepare('SELECT * FROM tab_expenses WHERE id = ? AND deleted_at IS NULL').get(id) as { created_by: number; payer_id: number } | undefined;
    if (!e) throw new HttpError(404, 'Expense not found');
    if (e.created_by !== userId && e.payer_id !== userId && !isAdmin) throw new HttpError(403, 'Only whoever logged it can delete it');
    this.db.prepare('UPDATE tab_expenses SET deleted_at = ? WHERE id = ?').run(now(), id);
    this.refresh('tab');
    return { ok: true };
  }

  /** Record money that moved outside the app (after tapping the Venmo link, or cash). */
  settle(userId: number, body: { fromId?: unknown; toId?: unknown; amountCents?: unknown; amount?: unknown }) {
    const fromId = optInt(body.fromId) ?? userId;
    const toId = optInt(body.toId);
    if (!toId || toId === fromId) throw new HttpError(400, 'Who did you pay?');
    // Either side can record it; nobody can record a payment between two other people.
    if (userId !== fromId && userId !== toId) throw new HttpError(403, 'You can only record payments you made or got');
    this.assertMember(fromId);
    this.assertMember(toId);
    const cents = body.amountCents !== undefined ? Number(body.amountCents) : Math.round(Number(body.amount) * 100);
    if (!Number.isInteger(cents) || cents <= 0) throw new HttpError(400, 'Amount must be more than $0');
    const id = Number(this.db.prepare('INSERT INTO tab_settlements (from_id, to_id, amount_cents, recorded_by) VALUES (?, ?, ?, ?)').run(fromId, toId, cents, userId).lastInsertRowid);
    const other = userId === fromId ? toId : fromId;
    this.ctx.svc.notify(other, null, `✅ ${this.nameOf(fromId)} paid ${this.nameOf(toId)} ${money(cents)}. Logged on the Tab.`, '/#/tab');
    this.refresh('tab');
    return { id };
  }

  /**
   * Pairwise debts, replayed in time order so we also know how long each debt
   * has been open (since the pair's balance last sat at zero).
   */
  debts(): { fromId: number; toId: number; cents: number; since: string }[] {
    type Ev = { a: number; b: number; cents: number; at: string }; // a owes b `cents` more (negative = less)
    const evs: Ev[] = [];
    for (const r of this.db
      .prepare(
        `SELECT s.user_id AS debtor, e.payer_id AS creditor, s.amount_cents AS cents, e.created_at AS at
         FROM tab_shares s JOIN tab_expenses e ON e.id = s.expense_id WHERE e.deleted_at IS NULL AND s.user_id != e.payer_id`,
      )
      .all() as { debtor: number; creditor: number; cents: number; at: string }[])
      evs.push({ a: r.debtor, b: r.creditor, cents: r.cents, at: r.at });
    for (const r of this.db.prepare('SELECT from_id, to_id, amount_cents, created_at FROM tab_settlements').all() as { from_id: number; to_id: number; amount_cents: number; created_at: string }[])
      evs.push({ a: r.from_id, b: r.to_id, cents: -r.amount_cents, at: r.created_at });
    evs.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
    // Keyed by (low, high): positive balance means low owes high.
    const pairs = new Map<string, { bal: number; since: string }>();
    for (const e of evs) {
      const lo = Math.min(e.a, e.b), hi = Math.max(e.a, e.b);
      const signed = e.a === lo ? e.cents : -e.cents;
      const key = `${lo}:${hi}`;
      const p = pairs.get(key) ?? { bal: 0, since: e.at };
      const before = p.bal;
      p.bal += signed;
      // Restart the clock when the balance crosses or leaves zero.
      if (before === 0 || Math.sign(before) !== Math.sign(p.bal)) p.since = e.at;
      pairs.set(key, p);
    }
    const out: { fromId: number; toId: number; cents: number; since: string }[] = [];
    for (const [key, p] of pairs) {
      if (p.bal === 0) continue;
      const [lo, hi] = key.split(':').map(Number);
      out.push(p.bal > 0 ? { fromId: lo, toId: hi, cents: p.bal, since: p.since } : { fromId: hi, toId: lo, cents: -p.bal, since: p.since });
    }
    return out;
  }

  tab(viewerId: number, eventId: number | null) {
    const names = new Map((this.db.prepare(`SELECT u.id, ${NAME} AS name FROM users u`).all() as { id: number; name: string }[]).map((r) => [r.id, r.name]));
    const nameOf = (id: number) => names.get(id) ?? 'Someone';
    const nowMs = Date.now();
    const days = (iso: string) => Math.floor((nowMs - Date.parse(iso)) / (24 * HOUR));
    const debts = this.debts().map((d) => ({
      ...d,
      from: nameOf(d.fromId),
      to: nameOf(d.toId),
      days: days(d.since),
      venmoUrl: this.venmoLink(d.toId, d.cents, 'Stall tab 🧾'),
    }));
    const net = new Map<number, number>();
    for (const d of debts) {
      net.set(d.fromId, (net.get(d.fromId) ?? 0) - d.cents);
      net.set(d.toId, (net.get(d.toId) ?? 0) + d.cents);
    }
    const expenses = (
      eventId
        ? this.db.prepare(`SELECT * FROM tab_expenses WHERE deleted_at IS NULL AND event_id = ? ORDER BY id DESC LIMIT 100`).all(eventId)
        : this.db.prepare(`SELECT * FROM tab_expenses WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 50`).all()
    ) as { id: number; event_id: number | null; payer_id: number; created_by: number; description: string; amount_cents: number; created_at: string }[];
    const sharesFor = this.db.prepare('SELECT user_id, amount_cents FROM tab_shares WHERE expense_id = ?');
    return {
      myVenmo: this.venmoOf(viewerId),
      iOwe: debts.filter((d) => d.fromId === viewerId),
      owedToMe: debts.filter((d) => d.toId === viewerId).map((d) => ({ ...d, venmoUrl: undefined, requestUrl: this.venmoLink(d.fromId, d.cents, 'Stall tab 🧾', 'charge') })),
      // Debt Wall of Shame: every open debt, biggest × oldest first.
      wallOfShame: [...debts].sort((a, b) => b.cents * (b.days + 1) - a.cents * (a.days + 1)).slice(0, 20),
      balances: [...net.entries()].map(([userId, cents]) => ({ userId, name: nameOf(userId), cents })).sort((a, b) => a.cents - b.cents),
      expenses: expenses.map((e) => ({
        id: e.id,
        eventId: e.event_id,
        description: e.description,
        amountCents: e.amount_cents,
        payerId: e.payer_id,
        payer: nameOf(e.payer_id),
        createdAt: e.created_at,
        canDelete: e.created_by === viewerId || e.payer_id === viewerId,
        shares: (sharesFor.all(e.id) as { user_id: number; amount_cents: number }[]).map((s) => ({ userId: s.user_id, name: nameOf(s.user_id), cents: s.amount_cents })),
      })),
    };
  }

  /** Tick: "you've owed Max $340 for 19 days", at most once a week per pair. */
  tickTabNudges(nowMs: number) {
    let sent = 0;
    const week = Math.floor(nowMs / (NUDGE_EVERY_DAYS * 24 * HOUR));
    for (const d of this.debts()) {
      const days = Math.floor((nowMs - Date.parse(d.since)) / (24 * HOUR));
      if (days < NUDGE_AFTER_DAYS || d.cents < 500) continue;
      if (!this.once(`tab-nudge:${d.fromId}:${d.toId}:${week}`)) continue;
      this.ctx.svc.notify(d.fromId, null, `🧾 You’ve owed ${this.nameOf(d.toId)} ${money(d.cents)} for ${days} days. The Wall of Shame sees you.`, '/#/tab');
      sent++;
    }
    return { sent };
  }
}
