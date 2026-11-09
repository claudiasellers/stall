// Events: the Partiful core. Invite cards, honest RSVPs (changes are announced),
// location drop, plus-one vetting on core ballots, bring list, rolling stages,
// spontaneous mode, guest links, and the post-event archive.
//
// Visibility and expiry are decided at read time (location reveal, spontaneous
// expiry, plus-one timers), so nothing depends on a timer firing on a server that
// sleeps. tick() only sends the pushes and hard-deletes expired spontaneous events.
import { randomBytes } from 'node:crypto';
import { type Db, tx, now } from '../../db.ts';
import { HttpError, consensus } from '../../service.ts';
import type { ModuleCtx as ModuleContext } from '../types.ts';

export const RSVP = {
  in: { label: 'In', emoji: '🙋' },
  maybe: { label: 'Maybe (lying)', emoji: '🤥' },
  late: { label: 'Coming late', emoji: '🐢' },
  afters: { label: 'Afters only', emoji: '🌙' },
  save_drink: { label: 'Save me a drink', emoji: '🥂' },
  out: { label: 'Out', emoji: '🫡' },
} as const;
export type RsvpStatus = keyof typeof RSVP;
const isRsvp = (s: unknown): s is RsvpStatus => typeof s === 'string' && s in RSVP;

export const KINDS = ['party', 'dinner', 'birthday', 'game', 'trip', 'spontaneous'] as const;
export type EventKind = (typeof KINDS)[number] | 'stage';

const POSTER_EMOJI: Record<string, string[]> = {
  party: ['🪩', '🍸', '🕺', '💃', '🎉', '🍾'],
  dinner: ['🍝', '🦪', '🍷', '🥂', '🍣', '🕯️'],
  birthday: ['🎂', '🎈', '👑', '🥳'],
  game: ['🏈', '📺', '🍺', '🏟️'],
  trip: ['✈️', '🏝️', '🚐', '🗺️'],
  spontaneous: ['📍', '⚡', '🏃', '🚨'],
  stage: ['➡️'],
};

const DEFAULT_REAL_START_MIN = 90;
const MAX_STAGES = 8;

type EventRow = {
  id: number;
  host_id: number;
  host_name: string;
  host_emoji: string | null;
  parent_id: number | null;
  stage_order: number;
  kind: EventKind;
  title: string;
  vibe: string | null;
  details: string | null;
  cover_emoji: string | null;
  cover_key: string | null;
  starts_at: string;
  real_starts_at: string;
  ends_at: string | null;
  location: string | null;
  location_reveal_at: string | null;
  expires_at: string | null;
  current_stage_id: number | null;
  recurrence: string | null;
  guest_token: string | null;
  plus_one_minutes: number;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
};

type Viewer = { id: number; is_admin: number };

const SELECT_EVENT = `
  SELECT e.*, COALESCE(u.display_name, u.username) AS host_name, u.emoji AS host_emoji
  FROM events e JOIN users u ON u.id = e.host_id`;

const NAME = `COALESCE(u.display_name, u.username)`;

export class EventsService {
  db: Db;
  ctx: ModuleContext;
  constructor(ctx: ModuleContext) {
    this.ctx = ctx;
    this.db = ctx.db;
  }

  // ------------------------------------------------------------ helpers

  /** Admin house settings, with the plan's defaults if a key is missing. */
  private house() {
    const h = (typeof this.ctx.house === 'function' ? this.ctx.house() : {}) as Record<string, unknown>;
    const num = (k: string, d: number) => (typeof h[k] === 'number' && Number.isFinite(h[k]) ? (h[k] as number) : d);
    return {
      locationRevealHours: num('locationRevealHours', 2),
      spontaneousHours: num('spontaneousHours', 4),
      plusOneVoteMinutes: num('plusOneVoteMinutes', 60),
      plusOneMinYes: num('plusOneMinYes', 2),
      plusOneRatio: num('plusOneRatio', 0.5),
    };
  }

  private plusOneRule() {
    const h = this.house();
    return { voteMinUpvotes: h.plusOneMinYes, consensusRatio: h.plusOneRatio, rejectMinDownvotes: 0 };
  }

  private name(userId: number): string {
    const r = this.db.prepare(`SELECT ${NAME} AS n FROM users u WHERE u.id = ?`).get(userId) as { n: string } | undefined;
    return r?.n ?? 'Someone';
  }

  private members(): number[] {
    return (this.db.prepare('SELECT id FROM users WHERE removed_at IS NULL').all() as { id: number }[]).map((r) => r.id);
  }

  private feed(eventId: number, actorId: number | null, kind: string, body: string, subject?: { type: string; id: number }) {
    this.db
      .prepare('INSERT INTO feed_items (kind, actor_id, event_id, subject_type, subject_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(kind, actorId, eventId, subject?.type ?? 'event', subject?.id ?? eventId, body, now());
    queueMicrotask(() => {
      this.ctx.bus.emit(`event:${eventId}`);
      this.ctx.bus.emit('feed');
      this.ctx.bus.emit('board');
    });
  }

  private touch(eventId: number) {
    this.db.prepare('UPDATE events SET updated_at = ? WHERE id = ?').run(now(), eventId);
    queueMicrotask(() => {
      this.ctx.bus.emit(`event:${eventId}`);
      this.ctx.bus.emit('board');
    });
  }

  private row(id: number): EventRow | undefined {
    return this.db.prepare(`${SELECT_EVENT} WHERE e.id = ?`).get(id) as EventRow | undefined;
  }

  /** Loads a live event (not expired). Stages resolve to themselves; callers decide. */
  mustGet(id: number): EventRow {
    const e = this.row(id);
    if (!e || isExpired(e)) throw new HttpError(404, 'That event is gone');
    return e;
  }

  private mustBeHost(e: EventRow, v: Viewer) {
    if (e.host_id !== v.id && !v.is_admin) throw new HttpError(403, 'Only the host can do that');
  }

  private root(e: EventRow): EventRow {
    return e.parent_id ? this.mustGet(e.parent_id) : e;
  }

  // ------------------------------------------------------------ create / edit

  create(hostId: number, input: Record<string, unknown>): number {
    const kind = (KINDS as readonly string[]).includes(String(input.kind)) ? (String(input.kind) as EventKind) : 'party';
    const title = text(input.title, 'Title', 2, 120);
    const vibe = optText(input.vibe, 200);
    const details = optText(input.details, 4000);
    const location = optText(input.location, 300);
    const spontaneous = kind === 'spontaneous';
    const t = Date.parse(now());
    const house = this.house();

    const startsAt = spontaneous ? new Date(t) : date(input.startsAt, 'Start time');
    const realStart =
      spontaneous ? startsAt
      : input.realStartsAt ? date(input.realStartsAt, 'Real start time')
      : new Date(startsAt.getTime() + DEFAULT_REAL_START_MIN * 60_000);
    if (realStart < startsAt) throw new HttpError(400, 'The real start can’t be before the invite time');
    const endsAt = spontaneous
      ? new Date(t + house.spontaneousHours * 3600_000)
      : input.endsAt ? date(input.endsAt, 'End time') : null;
    if (endsAt && endsAt < startsAt) throw new HttpError(400, 'The night can’t end before it starts');

    // Location drop: either an absolute time or "N hours before".
    let reveal: Date | null = null;
    if (!spontaneous && location) {
      if (input.locationRevealAt) reveal = date(input.locationRevealAt, 'Address drop time');
      else if (input.revealHoursBefore !== undefined && input.revealHoursBefore !== '' && input.revealHoursBefore !== null) {
        const hrs = Number(input.revealHoursBefore);
        if (!(hrs >= 0 && hrs <= 168)) throw new HttpError(400, 'Address drop must be 0–168 hours before');
        if (hrs > 0) reveal = new Date(startsAt.getTime() - hrs * 3600_000);
      } else if (house.locationRevealHours > 0) {
        reveal = new Date(startsAt.getTime() - house.locationRevealHours * 3600_000);
      }
    }
    const plusOneMinutes = clampInt(input.plusOneMinutes, 5, 24 * 60, house.plusOneVoteMinutes);
    const recurrence = ['weekly', 'biweekly', 'monthly'].includes(String(input.recurrence)) ? String(input.recurrence) : null;
    const stages = Array.isArray(input.stages)
      ? input.stages.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean).slice(0, MAX_STAGES)
      : [];
    const bring = Array.isArray(input.bring)
      ? input.bring.map((s) => (typeof s === 'string' ? s.trim().slice(0, 80) : '')).filter(Boolean).slice(0, 30)
      : [];

    const id = tx(this.db, () => {
      const res = this.db
        .prepare(
          `INSERT INTO events (host_id, kind, title, vibe, details, starts_at, real_starts_at, ends_at, location,
             location_reveal_at, expires_at, recurrence, plus_one_minutes, cover_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          hostId, kind, title, vibe, details, startsAt.toISOString(), realStart.toISOString(), endsAt?.toISOString() ?? null,
          location, reveal?.toISOString() ?? null, spontaneous ? endsAt!.toISOString() : null, recurrence, plusOneMinutes,
          optText(input.coverKey, 300),
        );
      const id = Number(res.lastInsertRowid);
      const pool = POSTER_EMOJI[kind] ?? POSTER_EMOJI.party;
      const cover = optText(input.coverEmoji, 16) ?? pool[id % pool.length];
      this.db.prepare('UPDATE events SET cover_emoji = ? WHERE id = ?').run(cover, id);
      stages.forEach((label, i) => {
        this.db
          .prepare(
            `INSERT INTO events (host_id, parent_id, stage_order, kind, title, starts_at, real_starts_at, cover_emoji)
             VALUES (?, ?, ?, 'stage', ?, ?, ?, ?)`,
          )
          .run(hostId, id, i, label.slice(0, 60), startsAt.toISOString(), realStart.toISOString(), '➡️');
      });
      for (const label of bring) this.db.prepare('INSERT INTO bring_items (event_id, label, added_by) VALUES (?, ?, ?)').run(id, label, hostId);
      // The host is in, obviously.
      this.db.prepare(`INSERT INTO rsvps (event_id, user_id, status) VALUES (?, ?, 'in')`).run(id, hostId);
      const host = this.name(hostId);
      this.feed(
        id, hostId, spontaneous ? 'event.spontaneous' : 'event.created',
        spontaneous ? `📍 ${host} is out right now${location ? ` at ${location}` : ''}. Come through.` : `💌 ${host} is hosting ${title}`,
      );
      return id;
    });

    const host = this.name(hostId);
    const link = `/events/${id}`;
    if (spontaneous) this.ctx.svc.notifyMembers(`📍 ${host}: out right now${location ? ` at ${location}` : ''}. Come through. “${title}”`, link, hostId);
    else this.ctx.svc.notifyMembers(`💌 ${host} invited you to ${title}`, link, hostId);
    this.ctx.bus.emit('feed');
    return id;
  }

  update(eventId: number, v: Viewer, input: Record<string, unknown>) {
    const e = this.mustGet(eventId);
    this.mustBeHost(e, v);
    if (e.parent_id) throw new HttpError(400, 'Edit the main event instead');
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    const set = (col: string, val: string | number | null) => {
      sets.push(`${col} = ?`);
      vals.push(val);
    };
    if (input.title !== undefined) set('title', text(input.title, 'Title', 2, 120));
    if (input.vibe !== undefined) set('vibe', optText(input.vibe, 200));
    if (input.details !== undefined) set('details', optText(input.details, 4000));
    if (input.coverEmoji !== undefined) set('cover_emoji', optText(input.coverEmoji, 16));
    if (input.coverKey !== undefined) set('cover_key', optText(input.coverKey, 300));
    if (input.startsAt !== undefined) set('starts_at', date(input.startsAt, 'Start time').toISOString());
    if (input.realStartsAt !== undefined) set('real_starts_at', date(input.realStartsAt, 'Real start time').toISOString());
    if (input.endsAt !== undefined) set('ends_at', input.endsAt ? date(input.endsAt, 'End time').toISOString() : null);
    if (input.location !== undefined) set('location', optText(input.location, 300));
    if (input.locationRevealAt !== undefined)
      set('location_reveal_at', input.locationRevealAt ? date(input.locationRevealAt, 'Address drop time').toISOString() : null);
    if (input.plusOneMinutes !== undefined) set('plus_one_minutes', clampInt(input.plusOneMinutes, 5, 24 * 60, 60));
    if (!sets.length) return;
    set('updated_at', now());
    tx(this.db, () => {
      this.db.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`).run(...vals, eventId);
      const changed = Object.keys(input).filter((k) => ['startsAt', 'realStartsAt', 'location', 'locationRevealAt'].includes(k));
      if (changed.length) this.feed(eventId, v.id, 'event.updated', `✏️ ${this.name(v.id)} changed the ${changed.map(humanField).join(' and ')} for ${e.title}`);
    });
    if (input.startsAt !== undefined || input.location !== undefined) {
      for (const uid of this.going(eventId)) if (uid !== v.id) this.ctx.svc.notify(uid, null, `✏️ ${e.title} changed. Check the details.`, `/events/${eventId}`);
    }
    this.touch(eventId);
  }

  cancel(eventId: number, v: Viewer) {
    const e = this.mustGet(eventId);
    this.mustBeHost(e, v);
    tx(this.db, () => {
      this.db.prepare('UPDATE events SET cancelled_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), eventId);
      this.feed(eventId, v.id, 'event.cancelled', `🪦 ${e.title} is cancelled. Pour one out.`);
    });
    for (const uid of this.going(eventId)) if (uid !== v.id) this.ctx.svc.notify(uid, null, `🪦 ${e.title} is cancelled.`, `/events/${eventId}`);
  }

  /** Spontaneous events can be ended early; deleted means deleted. */
  remove(eventId: number, v: Viewer) {
    const e = this.mustGet(eventId);
    this.mustBeHost(e, v);
    this.hardDelete(eventId);
  }

  private hardDelete(eventId: number) {
    tx(this.db, () => {
      // ballots/feed_items/reactions are polymorphic, so clear them by hand.
      const ids = [eventId, ...(this.db.prepare('SELECT id FROM events WHERE parent_id = ?').all(eventId) as { id: number }[]).map((r) => r.id)];
      const po = (this.db.prepare('SELECT id FROM plus_ones WHERE event_id = ?').all(eventId) as { id: number }[]).map((r) => r.id);
      for (const p of po) this.db.prepare(`DELETE FROM ballots WHERE subject_type = 'plus_one' AND subject_id = ?`).run(p);
      for (const id of ids) this.db.prepare('DELETE FROM feed_items WHERE event_id = ?').run(id);
      this.db.prepare(`DELETE FROM reactions WHERE target_type = 'event' AND target_id = ?`).run(eventId);
      this.db.prepare('DELETE FROM events WHERE id = ?').run(eventId);
    });
    this.ctx.bus.emit('feed');
  }

  // ------------------------------------------------------------ RSVPs

  rsvp(eventId: number, userId: number, status: unknown, note?: unknown) {
    if (!isRsvp(status)) throw new HttpError(400, 'Pick an RSVP');
    const e = this.mustGet(eventId);
    if (e.cancelled_at) throw new HttpError(409, 'This one got cancelled');
    const root = this.root(e);
    if (phase(root) === 'archived') throw new HttpError(409, 'This night is over. It lives in the archive now.');
    const n = optText(note, 140);
    tx(this.db, () => {
      const prev = this.db.prepare('SELECT status FROM rsvps WHERE event_id = ? AND user_id = ?').get(eventId, userId) as
        | { status: RsvpStatus }
        | undefined;
      this.db
        .prepare(
          `INSERT INTO rsvps (event_id, user_id, status, note, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (event_id, user_id) DO UPDATE SET status = excluded.status, note = excluded.note, updated_at = excluded.updated_at`,
        )
        .run(eventId, userId, status, n, now());
      if (prev?.status === status) return;
      const who = this.name(userId);
      const where = e.parent_id ? ` for ${e.title}` : '';
      const body = prev
        ? `${who} went from ${RSVP[prev.status].label} → ${RSVP[status].label}${where}`
        : `${RSVP[status].emoji} ${who} is ${RSVP[status].label}${where}`;
      this.feed(root.id, userId, 'rsvp_change', body, { type: 'event', id: eventId });
      // Flip-flops get announced to the host. The group sees it in the feed.
      if (prev && root.host_id !== userId) this.ctx.svc.notify(root.host_id, null, `🔁 ${body} (${root.title})`, `/events/${root.id}`);
    });
    this.touch(root.id);
  }

  guestRsvp(token: string, name: unknown, status: unknown, editToken?: unknown) {
    if (!isRsvp(status)) throw new HttpError(400, 'Pick an RSVP');
    const e = this.byGuestToken(token);
    if (e.cancelled_at || phase(e) === 'archived') throw new HttpError(409, 'RSVPs are closed');
    const nm = text(name, 'Name', 1, 40);
    return tx(this.db, () => {
      if (typeof editToken === 'string' && editToken) {
        const g = this.db.prepare('SELECT id, status FROM guest_rsvps WHERE edit_token = ? AND event_id = ?').get(editToken, e.id) as
          | { id: number; status: RsvpStatus }
          | undefined;
        if (g) {
          this.db.prepare('UPDATE guest_rsvps SET name = ?, status = ?, updated_at = ? WHERE id = ?').run(nm, status, now(), g.id);
          if (g.status !== status) this.feed(e.id, null, 'rsvp.guest', `${nm} (guest) went from ${RSVP[g.status].label} → ${RSVP[status].label}`);
          return { editToken };
        }
      }
      const tok = randomBytes(18).toString('base64url');
      this.db.prepare('INSERT INTO guest_rsvps (event_id, name, status, edit_token) VALUES (?, ?, ?, ?)').run(e.id, nm, status, tok);
      this.feed(e.id, null, 'rsvp.guest', `${RSVP[status].emoji} ${nm} (guest link) is ${RSVP[status].label}`);
      this.ctx.svc.notify(e.host_id, null, `👀 ${nm} RSVP’d ${RSVP[status].label} through your guest link for ${e.title}`, `/events/${e.id}`);
      return { editToken: tok };
    });
  }

  private going(eventId: number): number[] {
    return (
      this.db.prepare(`SELECT user_id FROM rsvps WHERE event_id = ? AND status != 'out'`).all(eventId) as { user_id: number }[]
    ).map((r) => r.user_id);
  }

  // ------------------------------------------------------------ stages

  addStage(eventId: number, v: Viewer, label: unknown) {
    const e = this.mustGet(eventId);
    this.mustBeHost(e, v);
    if (e.parent_id) throw new HttpError(400, 'Stages go on the main event');
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE parent_id = ?').get(eventId) as { n: number }).n;
    if (n >= MAX_STAGES) throw new HttpError(400, `That’s ${MAX_STAGES} stages. Go home.`);
    this.db
      .prepare(`INSERT INTO events (host_id, parent_id, stage_order, kind, title, starts_at, real_starts_at, cover_emoji) VALUES (?, ?, ?, 'stage', ?, ?, ?, '➡️')`)
      .run(e.host_id, eventId, n, text(label, 'Stage', 1, 60), e.starts_at, e.real_starts_at);
    this.touch(eventId);
  }

  /** Anyone going can move the group to the next stage. That's how nights work. */
  moveStage(eventId: number, userId: number, stageId: number) {
    const e = this.mustGet(eventId);
    const stage = this.mustGet(stageId);
    if (stage.parent_id !== e.id) throw new HttpError(400, 'Not a stage of this event');
    if (e.current_stage_id === stageId) return;
    tx(this.db, () => {
      this.db.prepare('UPDATE events SET current_stage_id = ?, updated_at = ? WHERE id = ?').run(stageId, now(), eventId);
      this.feed(eventId, userId, 'stage.moved', `➡️ The group moved on to ${stage.title} (${this.name(userId)} called it)`);
    });
    for (const uid of this.going(stageId).concat(this.going(eventId)))
      if (uid !== userId) this.ctx.svc.notify(uid, null, `➡️ ${e.title}: everyone’s moving to ${stage.title}`, `/events/${eventId}`);
    this.touch(eventId);
  }

  // ------------------------------------------------------------ bring list

  addBring(eventId: number, userId: number, label: unknown) {
    const e = this.root(this.mustGet(eventId));
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM bring_items WHERE event_id = ?').get(e.id) as { n: number }).n;
    if (n >= 40) throw new HttpError(400, 'The bring list is full');
    this.db.prepare('INSERT INTO bring_items (event_id, label, added_by) VALUES (?, ?, ?)').run(e.id, text(label, 'Item', 1, 80), userId);
    this.touch(e.id);
  }

  claimBring(itemId: number, userId: number, claim: boolean) {
    const item = this.db.prepare('SELECT * FROM bring_items WHERE id = ?').get(itemId) as
      | { id: number; event_id: number; label: string; claimed_by: number | null; added_by: number | null }
      | undefined;
    if (!item) throw new HttpError(404, 'Item not found');
    const e = this.mustGet(item.event_id);
    tx(this.db, () => {
      if (claim) {
        const res = this.db
          .prepare('UPDATE bring_items SET claimed_by = ?, claimed_at = ? WHERE id = ? AND (claimed_by IS NULL OR claimed_by = ?)')
          .run(userId, now(), itemId, userId);
        if (!res.changes) throw new HttpError(409, `${this.name(item.claimed_by!)} already has it`);
        if (item.claimed_by !== userId) this.feed(e.id, userId, 'bring.claimed', `🧊 ${this.name(userId)} is bringing ${item.label}`);
      } else {
        const res = this.db.prepare('UPDATE bring_items SET claimed_by = NULL, claimed_at = NULL WHERE id = ? AND claimed_by = ?').run(itemId, userId);
        if (res.changes) this.feed(e.id, userId, 'bring.dropped', `😬 ${this.name(userId)} is no longer bringing ${item.label}`);
      }
    });
    this.touch(e.id);
  }

  removeBring(itemId: number, v: Viewer) {
    const item = this.db.prepare('SELECT * FROM bring_items WHERE id = ?').get(itemId) as { event_id: number; added_by: number | null } | undefined;
    if (!item) throw new HttpError(404, 'Item not found');
    const e = this.mustGet(item.event_id);
    if (item.added_by !== v.id && e.host_id !== v.id && !v.is_admin) throw new HttpError(403, 'Not yours to remove');
    this.db.prepare('DELETE FROM bring_items WHERE id = ?').run(itemId);
    this.touch(e.id);
  }

  // ------------------------------------------------------------ plus-ones

  requestPlusOne(eventId: number, userId: number, input: Record<string, unknown>) {
    const e = this.root(this.mustGet(eventId));
    if (e.cancelled_at || phase(e) === 'archived') throw new HttpError(409, 'Too late for that');
    const pending = this.db
      .prepare(`SELECT 1 FROM plus_ones WHERE event_id = ? AND requester_id = ? AND status IN ('pending','approved')`)
      .get(e.id, userId);
    if (pending) throw new HttpError(409, 'You already have a plus-one in the works');
    const guestName = optText(input.name, 60);
    const ig = optText(input.instagram, 60)?.replace(/^@/, '') ?? null;
    if (ig && !/^[A-Za-z0-9._]{1,30}$/.test(ig)) throw new HttpError(400, 'That doesn’t look like an Instagram handle');
    const pitch = optText(input.pitch, 200);
    const decides = new Date(Date.parse(now()) + e.plus_one_minutes * 60_000).toISOString();
    const id = tx(this.db, () => {
      const res = this.db
        .prepare('INSERT INTO plus_ones (event_id, requester_id, guest_name, guest_instagram, pitch, decides_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(e.id, userId, guestName, ig, pitch, decides);
      const id = Number(res.lastInsertRowid);
      // Requester backs their own guest.
      this.db.prepare(`INSERT INTO ballots (subject_type, subject_id, user_id, value) VALUES ('plus_one', ?, ?, 1)`).run(id, userId);
      this.feed(e.id, userId, 'plus_one.requested', `🕵️ ${this.name(userId)} wants to bring ${guestName ?? 'someone'}. Who is this? Vote within ${humanMinutes(e.plus_one_minutes)}.`, { type: 'plus_one', id });
      return id;
    });
    this.ctx.svc.notifyMembers(`🕵️ ${this.name(userId)} wants to bring ${guestName ?? 'a mystery guest'} to ${e.title}. Who is this?`, `/events/${e.id}`, userId);
    this.touch(e.id);
    return id;
  }

  votePlusOne(plusOneId: number, userId: number, value: number) {
    if (![1, -1, 0].includes(value)) throw new HttpError(400, 'Bad vote');
    const p = this.plusOne(plusOneId);
    this.resolvePlusOnes(p.event_id);
    const fresh = this.plusOne(plusOneId);
    if (fresh.status !== 'pending') throw new HttpError(409, 'Voting closed');
    if (value === 0) this.db.prepare(`DELETE FROM ballots WHERE subject_type = 'plus_one' AND subject_id = ? AND user_id = ?`).run(plusOneId, userId);
    else
      this.db
        .prepare(
          `INSERT INTO ballots (subject_type, subject_id, user_id, value) VALUES ('plus_one', ?, ?, ?)
           ON CONFLICT (subject_type, subject_id, user_id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`,
        )
        .run(plusOneId, userId, value);
    // Decide early when the consensus rule already approves, a majority of members
    // said no, or everyone has voted. Otherwise the timer decides.
    const t = this.tally(plusOneId);
    const m = this.members().length;
    if (consensus({ upvotes: t.yes, downvotes: t.no }, this.plusOneRule()) === 'approve' || t.no > m / 2 || t.yes + t.no >= m)
      this.decidePlusOne(plusOneId);
    this.touch(p.event_id);
  }

  withdrawPlusOne(plusOneId: number, v: Viewer) {
    const p = this.plusOne(plusOneId);
    if (p.requester_id !== v.id && !v.is_admin) throw new HttpError(403, 'Not your plus-one');
    this.db.prepare(`UPDATE plus_ones SET status = 'withdrawn', decided_at = ? WHERE id = ? AND status IN ('pending','approved')`).run(now(), plusOneId);
    this.touch(p.event_id);
  }

  private plusOne(id: number) {
    const p = this.db.prepare('SELECT * FROM plus_ones WHERE id = ?').get(id) as
      | { id: number; event_id: number; requester_id: number; guest_name: string | null; status: string; decides_at: string }
      | undefined;
    if (!p) throw new HttpError(404, 'Plus-one not found');
    return p;
  }

  private tally(plusOneId: number) {
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(value = 1), 0) AS yes, COALESCE(SUM(value = -1), 0) AS no
         FROM ballots WHERE subject_type = 'plus_one' AND subject_id = ?`,
      )
      .get(plusOneId) as { yes: number; no: number };
    return { yes: Number(r.yes), no: Number(r.no) };
  }

  /** Read-time timer: any pending request past its deadline is decided now. */
  resolvePlusOnes(eventId?: number) {
    const rows = this.db
      .prepare(
        `SELECT id FROM plus_ones WHERE status = 'pending' AND decides_at <= ? ${eventId ? 'AND event_id = ?' : ''}`,
      )
      .all(...(eventId ? [now(), eventId] : [now()])) as { id: number }[];
    for (const r of rows) this.decidePlusOne(r.id);
  }

  private decidePlusOne(id: number) {
    const decided = tx(this.db, () => {
      const p = this.plusOne(id);
      if (p.status !== 'pending') return null;
      const t = this.tally(id);
      // Same consensus rule as the Suggestion Box, with the house's plus-one thresholds.
      const ok = consensus({ upvotes: t.yes, downvotes: t.no }, this.plusOneRule()) === 'approve';
      this.db.prepare('UPDATE plus_ones SET status = ?, decided_at = ? WHERE id = ?').run(ok ? 'approved' : 'rejected', now(), id);
      const who = p.guest_name ?? 'the mystery guest';
      this.feed(p.event_id, null, 'plus_one.decided', ok ? `✅ The group let ${who} in (${t.yes}–${t.no})` : `🚫 ${who} has been vetted out (${t.yes}–${t.no})`, { type: 'plus_one', id });
      return { p, ok, who };
    });
    if (decided)
      this.ctx.svc.notify(
        decided.p.requester_id, null,
        decided.ok ? `✅ ${decided.who} is approved. Bring them.` : `🚫 The group said no to ${decided.who}. Sorry.`,
        `/events/${decided.p.event_id}`,
      );
  }

  // ------------------------------------------------------------ ratings (post-event)

  rate(eventId: number, userId: number, score: unknown) {
    const e = this.root(this.mustGet(eventId));
    if (phase(e) !== 'archived') throw new HttpError(409, 'Rate it once the night is over');
    const s = Number(score);
    if (!Number.isInteger(s) || s < 1 || s > 10) throw new HttpError(400, 'Score is 1 to 10');
    this.db
      .prepare(
        `INSERT INTO event_ratings (event_id, user_id, score) VALUES (?, ?, ?)
         ON CONFLICT (event_id, user_id) DO UPDATE SET score = excluded.score, created_at = excluded.created_at`,
      )
      .run(e.id, userId, s);
    this.touch(e.id);
  }

  // ------------------------------------------------------------ guest link

  setGuestLink(eventId: number, v: Viewer, on: boolean): string | null {
    const e = this.mustGet(eventId);
    this.mustBeHost(e, v);
    const tok = on ? (e.guest_token ?? randomBytes(16).toString('base64url')) : null;
    this.db.prepare('UPDATE events SET guest_token = ?, updated_at = ? WHERE id = ?').run(tok, now(), eventId);
    return tok;
  }

  byGuestToken(token: string): EventRow {
    if (!token || token.length < 16) throw new HttpError(404, 'This link doesn’t work');
    const e = this.db.prepare(`${SELECT_EVENT} WHERE e.guest_token = ? AND e.parent_id IS NULL`).get(token) as EventRow | undefined;
    if (!e || isExpired(e)) throw new HttpError(404, 'This link doesn’t work');
    return e;
  }

  /** What a guest sees: the card and an RSVP form. No member list, no archive, no feed. */
  guestView(token: string) {
    const e = this.byGuestToken(token);
    const counts = this.counts(e.id);
    return {
      event: {
        title: e.title,
        vibe: e.vibe,
        kind: e.kind,
        coverEmoji: e.cover_emoji,
        poster: poster(e),
        host: e.host_name,
        startsAt: e.starts_at,
        realStartsAt: e.real_starts_at,
        location: locationFor(e, null),
        locationRevealAt: e.location_reveal_at,
        cancelled: !!e.cancelled_at,
        phase: phase(e),
        going: counts.in + counts.late + counts.afters,
      },
    };
  }

  // ------------------------------------------------------------ reads

  private counts(eventId: number) {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM rsvps WHERE event_id = ? GROUP BY status').all(eventId) as { status: RsvpStatus; n: number }[];
    const g = this.db.prepare('SELECT status, COUNT(*) AS n FROM guest_rsvps WHERE event_id = ? GROUP BY status').all(eventId) as { status: RsvpStatus; n: number }[];
    const c: Record<RsvpStatus, number> = { in: 0, maybe: 0, late: 0, afters: 0, save_drink: 0, out: 0 };
    for (const r of [...rows, ...g]) c[r.status] += Number(r.n);
    return c;
  }

  list(v: Viewer, scope: string) {
    this.sweep();
    const t = now();
    const where =
      scope === 'past'
        ? `AND COALESCE(e.ends_at, strftime('%Y-%m-%dT%H:%M:%fZ', e.real_starts_at, '+8 hours')) < ?`
        : `AND COALESCE(e.ends_at, strftime('%Y-%m-%dT%H:%M:%fZ', e.real_starts_at, '+8 hours')) >= ?`;
    const order = scope === 'past' ? 'e.starts_at DESC LIMIT 100' : 'e.starts_at ASC LIMIT 100';
    const rows = this.db
      .prepare(`${SELECT_EVENT} WHERE e.parent_id IS NULL AND (e.expires_at IS NULL OR e.expires_at > ?) ${where} ORDER BY ${order}`)
      .all(t, t) as EventRow[];
    const mine = new Map(
      (this.db.prepare('SELECT event_id, status FROM rsvps WHERE user_id = ?').all(v.id) as { event_id: number; status: RsvpStatus }[]).map((r) => [r.event_id, r.status]),
    );
    return rows.map((e) => this.card(e, v, mine.get(e.id) ?? null));
  }

  private card(e: EventRow, v: Viewer, myRsvp: RsvpStatus | null) {
    const c = this.counts(e.id);
    const faces = this.db
      .prepare(
        `SELECT ${NAME} AS name, u.emoji, r.status FROM rsvps r JOIN users u ON u.id = r.user_id
         WHERE r.event_id = ? AND r.status != 'out' AND u.removed_at IS NULL ORDER BY r.updated_at LIMIT 8`,
      )
      .all(e.id) as { name: string; emoji: string | null; status: RsvpStatus }[];
    return {
      id: e.id,
      kind: e.kind,
      title: e.title,
      vibe: e.vibe,
      coverEmoji: e.cover_emoji,
      coverKey: e.cover_key,
      poster: poster(e),
      host: { id: e.host_id, name: e.host_name, emoji: e.host_emoji },
      mine: e.host_id === v.id,
      startsAt: e.starts_at,
      realStartsAt: e.real_starts_at,
      endsAt: e.ends_at,
      expiresAt: e.expires_at,
      location: locationFor(e, v),
      locationRevealAt: e.location_reveal_at,
      locationHidden: !!e.location && locationFor(e, v) === null,
      cancelled: !!e.cancelled_at,
      phase: phase(e),
      recurrence: e.recurrence,
      counts: c,
      going: c.in + c.late + c.afters,
      faces,
      myRsvp,
    };
  }

  detail(eventId: number, v: Viewer) {
    this.resolvePlusOnes(eventId);
    let e = this.mustGet(eventId);
    if (e.parent_id) e = this.mustGet(e.parent_id);
    const myRsvp = (this.db.prepare('SELECT status FROM rsvps WHERE event_id = ? AND user_id = ?').get(e.id, v.id) as { status: RsvpStatus } | undefined)?.status ?? null;

    const rsvps = this.db
      .prepare(
        `SELECT r.user_id AS userId, ${NAME} AS name, u.emoji, r.status, r.note, r.updated_at AS updatedAt
         FROM rsvps r JOIN users u ON u.id = r.user_id WHERE r.event_id = ? AND u.removed_at IS NULL ORDER BY r.updated_at`,
      )
      .all(e.id);
    const guests = this.db.prepare('SELECT id, name, status FROM guest_rsvps WHERE event_id = ? ORDER BY id').all(e.id);

    const stages = (this.db.prepare(`${SELECT_EVENT} WHERE e.parent_id = ? ORDER BY e.stage_order, e.id`).all(e.id) as EventRow[]).map((s) => {
      const people = this.db
        .prepare(
          `SELECT r.user_id AS userId, ${NAME} AS name, u.emoji, r.status FROM rsvps r JOIN users u ON u.id = r.user_id
           WHERE r.event_id = ? AND r.status != 'out' AND u.removed_at IS NULL`,
        )
        .all(s.id) as { userId: number; status: string }[];
      return {
        id: s.id,
        title: s.title,
        order: s.stage_order,
        current: e.current_stage_id === s.id,
        people,
        myRsvp: (people.find((p) => p.userId === v.id)?.status as RsvpStatus | undefined) ?? null,
      };
    });

    const bring = this.db
      .prepare(
        `SELECT b.id, b.label, b.claimed_by AS claimedBy, ${NAME} AS claimedName, b.added_by AS addedBy
         FROM bring_items b LEFT JOIN users u ON u.id = b.claimed_by WHERE b.event_id = ? ORDER BY b.id`,
      )
      .all(e.id) as { id: number; label: string; claimedBy: number | null; claimedName: string | null; addedBy: number | null }[];

    const plusOnes = (
      this.db
        .prepare(
          `SELECT p.*, ${NAME} AS requester FROM plus_ones p JOIN users u ON u.id = p.requester_id
           WHERE p.event_id = ? AND p.status != 'withdrawn' ORDER BY p.id DESC`,
        )
        .all(e.id) as { id: number; requester_id: number; requester: string; guest_name: string | null; guest_instagram: string | null; pitch: string | null; status: string; decides_at: string }[]
    ).map((p) => {
      const t = this.tally(p.id);
      const mine = this.db.prepare(`SELECT value FROM ballots WHERE subject_type = 'plus_one' AND subject_id = ? AND user_id = ?`).get(p.id, v.id) as { value: number } | undefined;
      return {
        id: p.id,
        requester: p.requester,
        mine: p.requester_id === v.id,
        name: p.guest_name,
        instagram: p.guest_instagram,
        pitch: p.pitch,
        status: p.status,
        decidesAt: p.decides_at,
        yes: t.yes,
        no: t.no,
        myVote: mine?.value ?? 0,
      };
    });

    const activity = this.db
      .prepare(
        `SELECT f.id, f.kind, f.body, f.created_at AS createdAt, f.actor_id AS actorId, u.emoji
         FROM feed_items f LEFT JOIN users u ON u.id = f.actor_id WHERE f.event_id = ? ORDER BY f.id DESC LIMIT 60`,
      )
      .all(e.id);

    const isHost = e.host_id === v.id || !!v.is_admin;
    const ph = phase(e);
    return {
      event: {
        ...this.card(e, v, myRsvp),
        details: e.details,
        plusOneMinutes: e.plus_one_minutes,
        guestLink: isHost && e.guest_token ? `/#/guest/${e.guest_token}` : null,
        currentStageId: e.current_stage_id,
      },
      rsvps,
      guests,
      stages,
      bring,
      plusOnes,
      activity,
      archive: ph === 'archived' ? this.archive(e, v) : null,
      can: {
        edit: isHost,
        cancel: isHost && !e.cancelled_at && ph !== 'archived',
        delete: isHost,
        rsvp: !e.cancelled_at && ph !== 'archived',
        plusOne: !e.cancelled_at && ph !== 'archived',
        moveStage: stages.length > 0 && ph !== 'archived' && (isHost || (myRsvp !== null && myRsvp !== 'out')),
        rate: ph === 'archived' && !e.cancelled_at,
      },
    };
  }

  /**
   * The post-event page. Ratings and the RSVP record live here; photos, quotes,
   * regrets, Irish goodbyes and the tab belong to other modules, which share the
   * event id. Counts are read only from tables that exist, so this works before
   * those modules merge.
   */
  private archive(e: EventRow, v: Viewer) {
    const r = this.db.prepare('SELECT AVG(score) AS avg, COUNT(*) AS n FROM event_ratings WHERE event_id = ?').get(e.id) as { avg: number | null; n: number };
    const mine = this.db.prepare('SELECT score FROM event_ratings WHERE event_id = ? AND user_id = ?').get(e.id, v.id) as { score: number } | undefined;
    const tables = new Set((this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name));
    const count = (table: string, where = '') =>
      tables.has(table) ? Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE event_id = ? ${where}`).get(e.id) as { n: number }).n) : null;
    const showedUp = this.db
      .prepare(
        `SELECT ${NAME} AS name, u.emoji, r.status FROM rsvps r JOIN users u ON u.id = r.user_id
         WHERE r.event_id = ? AND r.status IN ('in','late','afters') ORDER BY r.updated_at`,
      )
      .all(e.id);
    // The liars: said Maybe (lying) and never upgraded.
    const liars = this.db
      .prepare(`SELECT ${NAME} AS name, u.emoji FROM rsvps r JOIN users u ON u.id = r.user_id WHERE r.event_id = ? AND r.status = 'maybe'`)
      .all(e.id);
    const flipFlops = this.db
      .prepare(
        `SELECT ${NAME} AS name, COUNT(*) AS n FROM feed_items f JOIN users u ON u.id = f.actor_id
         WHERE f.event_id = ? AND f.kind = 'rsvp_change' AND f.body LIKE '%→%' GROUP BY f.actor_id ORDER BY n DESC LIMIT 1`,
      )
      .get(e.id) as { name: string; n: number } | undefined;
    // Who left without saying bye (posts lane, kind 'irish_goodbye').
    const leftEarly = tables.has('posts')
      ? (this.db
          .prepare(
            `SELECT COALESCE(CASE WHEN u.removed_at IS NULL THEN ${NAME} END, p.subject_label, 'Someone') AS name, u.emoji, p.created_at AS at
             FROM posts p LEFT JOIN users u ON u.id = p.subject_id
             WHERE p.event_id = ? AND p.kind = 'irish_goodbye' ORDER BY p.created_at LIMIT 20`,
          )
          .all(e.id) as { name: string; emoji: string | null; at: string }[])
      : null;
    // The night's best line: the quote with the most reactions.
    const topQuote = tables.has('posts') && tables.has('reactions')
      ? ((this.db
          .prepare(
            `SELECT p.id, p.body, COALESCE(CASE WHEN u.removed_at IS NULL THEN ${NAME} END, p.subject_label, 'Unknown') AS speaker,
               (SELECT COUNT(*) FROM reactions x WHERE x.target_type = 'post' AND x.target_id = p.id) AS reactions
             FROM posts p LEFT JOIN users u ON u.id = p.subject_id
             WHERE p.event_id = ? AND p.kind = 'quote' ORDER BY reactions DESC, p.id ASC LIMIT 1`,
          )
          .get(e.id) as { id: number; body: string; speaker: string; reactions: number } | undefined) ?? null)
      : null;
    const tabTotalCents = tables.has('tab_expenses')
      ? Number((this.db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS c FROM tab_expenses WHERE event_id = ?').get(e.id) as { c: number }).c)
      : null;
    return {
      leftEarly,
      topQuote,
      tabTotalCents,
      rating: r.n ? Math.round(Number(r.avg) * 10) / 10 : null,
      ratings: Number(r.n),
      myRating: mine?.score ?? null,
      showedUp,
      liars,
      flipFlopper: flipFlops && flipFlops.n >= 2 ? flipFlops : null,
      // Other modules' contributions, by event id. null = that module isn't installed.
      photos: count('photos', `AND status = 'ready'`),
      quotes: count('posts', `AND kind = 'quote'`),
      regrets: count('posts', `AND kind = 'regret' AND (expires_at IS NULL OR expires_at > '${now()}')`),
      irishGoodbyesPosts: count('posts', `AND kind = 'irish_goodbye'`),
      irishGoodbyes: count('irish_goodbyes') ?? null,
      tab: count('tab_expenses'),
      checkins: count('night_checkins'),
    };
  }

  // ------------------------------------------------------------ member removal

  /**
   * Runs inside core's removal transaction. Removed members already drop out of
   * every list (removed_at). keep: nothing else. anonymize: their RSVP history and
   * claims stay but lose the link to them. delete: their RSVPs, ratings, plus-ones,
   * claims and the upcoming events they host are hard-deleted; past nights they
   * hosted stay, because those archives belong to everyone who was there.
   */
  onMemberRemoved(userId: number, policy: 'keep' | 'anonymize' | 'delete') {
    if (policy === 'keep') return;
    this.db.prepare('UPDATE bring_items SET claimed_by = NULL, claimed_at = NULL WHERE claimed_by = ?').run(userId);
    this.db.prepare(`UPDATE plus_ones SET status = 'withdrawn', decided_at = ? WHERE requester_id = ? AND status = 'pending'`).run(now(), userId);
    if (policy === 'anonymize') {
      this.db.prepare('UPDATE bring_items SET added_by = NULL WHERE added_by = ?').run(userId);
      return;
    }
    this.db.prepare('DELETE FROM rsvps WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM event_ratings WHERE user_id = ?').run(userId);
    const po = (this.db.prepare('SELECT id FROM plus_ones WHERE requester_id = ?').all(userId) as { id: number }[]).map((r) => r.id);
    for (const id of po) this.db.prepare(`DELETE FROM ballots WHERE subject_type = 'plus_one' AND subject_id = ?`).run(id);
    this.db.prepare('DELETE FROM plus_ones WHERE requester_id = ?').run(userId);
    const upcoming = this.db
      .prepare('SELECT id FROM events WHERE host_id = ? AND parent_id IS NULL AND starts_at > ?')
      .all(userId, now()) as { id: number }[];
    for (const e of upcoming) this.hardDelete(e.id);
  }

  // ------------------------------------------------------------ housekeeping

  /** Hard-delete spontaneous events past their 4-hour life. */
  sweep() {
    const dead = this.db.prepare('SELECT id FROM events WHERE expires_at IS NOT NULL AND expires_at <= ? AND parent_id IS NULL').all(now()) as { id: number }[];
    for (const d of dead) this.hardDelete(d.id);
  }

  /**
   * Called by the core /tick (cron pinger). Sends the time-based pushes once each,
   * keyed in jobs_sent so a retried tick never double-sends.
   */
  tick() {
    this.sweep();
    this.resolvePlusOnes();
    const t = Date.parse(now());
    const once = (key: string) => {
      const res = this.db.prepare('INSERT OR IGNORE INTO jobs_sent (key, sent_at) VALUES (?, ?)').run(key, now());
      return res.changes === 1;
    };
    // Location drops that just happened.
    const drops = this.db
      .prepare(
        `${SELECT_EVENT} WHERE e.parent_id IS NULL AND e.cancelled_at IS NULL AND e.location_reveal_at IS NOT NULL
         AND e.location_reveal_at <= ? AND e.location_reveal_at > ?`,
      )
      .all(new Date(t).toISOString(), new Date(t - 6 * 3600_000).toISOString()) as EventRow[];
    for (const e of drops)
      if (once(`events:drop:${e.id}`))
        for (const uid of this.going(e.id)) this.ctx.svc.notify(uid, null, `📍 The address for ${e.title} just dropped.`, `/events/${e.id}`);
    // Two-hour heads-up for people who are in.
    const soon = this.db
      .prepare(
        `${SELECT_EVENT} WHERE e.parent_id IS NULL AND e.cancelled_at IS NULL AND e.kind != 'spontaneous'
         AND e.real_starts_at <= ? AND e.real_starts_at > ?`,
      )
      .all(new Date(t + 2 * 3600_000).toISOString(), new Date(t).toISOString()) as EventRow[];
    for (const e of soon)
      if (once(`events:soon:${e.id}`))
        for (const uid of this.going(e.id)) this.ctx.svc.notify(uid, null, `⏰ ${e.title} actually starts soon. Start getting ready (you won’t).`, `/events/${e.id}`);
    // The morning after: ask everyone to rate the night.
    const over = this.db
      .prepare(
        `${SELECT_EVENT} WHERE e.parent_id IS NULL AND e.cancelled_at IS NULL AND e.kind != 'spontaneous'
         AND COALESCE(e.ends_at, strftime('%Y-%m-%dT%H:%M:%fZ', e.real_starts_at, '+8 hours')) <= ?
         AND COALESCE(e.ends_at, strftime('%Y-%m-%dT%H:%M:%fZ', e.real_starts_at, '+8 hours')) > ?`,
      )
      .all(new Date(t).toISOString(), new Date(t - 24 * 3600_000).toISOString()) as EventRow[];
    for (const e of over)
      if (once(`events:over:${e.id}`))
        for (const uid of this.going(e.id)) this.ctx.svc.notify(uid, null, `🗂️ ${e.title} is in the archive. Rate the night out of 10.`, `/events/${e.id}`);
    // Recurring events: when one ends, schedule the next instance.
    for (const e of over) if (e.recurrence && once(`events:recur:${e.id}`)) this.spawnNext(e);
  }

  private spawnNext(e: EventRow) {
    const shift = (iso: string | null) => {
      if (!iso) return null;
      const d = new Date(iso);
      if (e.recurrence === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
      else if (e.recurrence === 'biweekly') d.setUTCDate(d.getUTCDate() + 14);
      else d.setUTCMonth(d.getUTCMonth() + 1);
      return d.toISOString();
    };
    const res = this.db
      .prepare(
        `INSERT INTO events (host_id, kind, title, vibe, details, cover_emoji, cover_key, starts_at, real_starts_at, ends_at, location,
           location_reveal_at, recurrence, plus_one_minutes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.host_id, e.kind, e.title, e.vibe, e.details, e.cover_emoji, e.cover_key, shift(e.starts_at), shift(e.real_starts_at), shift(e.ends_at),
        e.location, shift(e.location_reveal_at), e.recurrence, e.plus_one_minutes,
      );
    const id = Number(res.lastInsertRowid);
    for (const s of this.db.prepare('SELECT title, stage_order FROM events WHERE parent_id = ? ORDER BY stage_order').all(e.id) as { title: string; stage_order: number }[])
      this.db
        .prepare(`INSERT INTO events (host_id, parent_id, stage_order, kind, title, starts_at, real_starts_at, cover_emoji) VALUES (?, ?, ?, 'stage', ?, ?, ?, '➡️')`)
        .run(e.host_id, id, s.stage_order, s.title, shift(e.starts_at), shift(e.real_starts_at));
    this.db.prepare(`INSERT INTO rsvps (event_id, user_id, status) VALUES (?, ?, 'in')`).run(id, e.host_id);
    this.feed(id, e.host_id, 'event.created', `🔁 ${e.title} is on again`);
    this.ctx.svc.notifyMembers(`🔁 ${e.title} is on again. RSVP honestly.`, `/events/${id}`, e.host_id);
  }
}

// ------------------------------------------------------------ pure rules

export function phase(e: Pick<EventRow, 'starts_at' | 'real_starts_at' | 'ends_at' | 'cancelled_at' | 'kind' | 'expires_at'>, at = Date.parse(now())) {
  if (e.cancelled_at) return 'cancelled' as const;
  const start = Date.parse(e.starts_at);
  const end = e.ends_at ? Date.parse(e.ends_at) : Date.parse(e.real_starts_at) + 8 * 3600_000;
  if (at < start) return 'upcoming' as const;
  if (at < end) return 'live' as const;
  return e.kind === 'spontaneous' ? ('live' as const) : ('archived' as const);
}

function isExpired(e: Pick<EventRow, 'expires_at'>, at = Date.parse(now())) {
  return !!e.expires_at && Date.parse(e.expires_at) <= at;
}

/** Location drop, decided at read time. The host (and admins) always see it. */
export function locationFor(e: Pick<EventRow, 'location' | 'location_reveal_at' | 'host_id'>, v: Viewer | null, at = Date.parse(now())) {
  if (!e.location) return null;
  if (v && (v.id === e.host_id || v.is_admin)) return e.location;
  if (e.location_reveal_at && Date.parse(e.location_reveal_at) > at) return null;
  return e.location;
}

const PALETTES = [
  ['#ff4fa3', '#ff8a3d'], ['#9b6bff', '#6fd3ff'], ['#ffd23f', '#ff6b6b'], ['#b6f36a', '#3dffc5'],
  ['#120a1f', '#ff4fa3'], ['#6fd3ff', '#b6f36a'], ['#ff8a3d', '#9b6bff'], ['#3dffc5', '#9b6bff'],
];
/** Generated poster when there's no cover photo: two colors and an angle from the id. */
function poster(e: Pick<EventRow, 'id' | 'kind'>) {
  const [a, b] = PALETTES[(e.id * 7) % PALETTES.length];
  return { from: a, to: b, angle: (e.id * 47) % 360 };
}

function text(v: unknown, name: string, min: number, max: number): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min || s.length > max) throw new HttpError(400, `${name} must be ${min}–${max} characters`);
  return s;
}
function optText(v: unknown, max: number): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}
function date(v: unknown, name: string): Date {
  const d = new Date(String(v ?? ''));
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `${name} is missing or not a date`);
  return d;
}
function clampInt(v: unknown, min: number, max: number, def: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n)));
}
function humanMinutes(m: number) {
  return m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} minutes`;
}
function humanField(k: string) {
  return { startsAt: 'time', realStartsAt: 'real start', location: 'address', locationRevealAt: 'address drop' }[k] ?? k;
}
