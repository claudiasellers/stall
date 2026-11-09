// Posts module: the Quote Wall ("Overheard"), The Morning After (regrets), Lost & Found
// and the Irish Goodbye Tracker, plus the reactions API and the unified Feed.
//
// One `posts` table with a kind column keeps the feed to a single query. Visibility is
// decided at read time (expired rows are never returned) and purgeExpired() really
// deletes them, reactions and ballots included, so "self-destruct" means gone.
import express from 'express';
import { type Db, tx, now } from '../../db.ts';
import { HttpError } from '../../service.ts';
import type { ModuleCtx, StallModule, RemovalPolicy } from '../types.ts';
import { toggleReaction, reactionsFor, countReactions, deleteReactionsFor, REACTION_EMOJI, type ReactionSummary } from './reactions.ts';

// ------------------------------------------------------------------ constants

export const POST_KINDS = ['quote', 'regret', 'lost_item', 'irish_goodbye'] as const;
export type PostKind = (typeof POST_KINDS)[number];

export const SEVERITY = [
  { level: 1, emoji: '🫠', label: 'mild' },
  { level: 2, emoji: '😬', label: 'awkward' },
  { level: 3, emoji: '💀', label: 'social death' },
  { level: 4, emoji: '🚨', label: 'needs a lawyer' },
  { level: 5, emoji: '🪦', label: "we don't talk about it" },
] as const;

const LIMITS = { body: 500, context: 280, label: 60, stanceNote: 200 };

// ------------------------------------------------------------------ migrations

export const migrations = [
  {
    id: 'posts-001',
    sql: `
  CREATE TABLE posts (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('quote','regret','lost_item','irish_goodbye','hot_take','canon','prophecy')),
    author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    context TEXT,
    -- quote: who said it; irish_goodbye: who left. A member, or a label ("the bouncer").
    subject_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    subject_label TEXT,
    severity INTEGER CHECK (severity BETWEEN 1 AND 5),
    anonymous INTEGER NOT NULL DEFAULT 0 CHECK (anonymous IN (0, 1)),
    -- subject's answer: 'claimed' (I stand by it) | 'disputed' (I have never said this)
    stance TEXT CHECK (stance IN ('claimed','disputed')),
    stance_note TEXT,
    stance_at TEXT,
    -- open | forgiven (regret) | found (lost item)
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','forgiven','found')),
    resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    resolved_at TEXT,
    unmasked_at TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX posts_created ON posts(created_at DESC);
  CREATE INDEX posts_kind_created ON posts(kind, created_at DESC);
  CREATE INDEX posts_author ON posts(author_id);
  CREATE INDEX posts_event ON posts(event_id) WHERE event_id IS NOT NULL;
  CREATE INDEX posts_subject ON posts(subject_id, kind) WHERE subject_id IS NOT NULL;
  CREATE INDEX posts_resolved_by ON posts(resolved_by) WHERE resolved_by IS NOT NULL;
  CREATE INDEX posts_expires ON posts(expires_at) WHERE expires_at IS NOT NULL;
  CREATE INDEX posts_unmasked ON posts(unmasked_at) WHERE unmasked_at IS NOT NULL;
  `,
  },
  {
    id: 'posts-002',
    sql: `
  -- Admin moderation: a locked post takes no new reactions, votes, stances or claims.
  ALTER TABLE posts ADD COLUMN locked_at TEXT;
  `,
  },
];

// ------------------------------------------------------------------ types

type Ctx = ModuleCtx;

type Viewer = { id: number; username: string; is_admin: number };

export type PostRow = {
  id: number;
  kind: PostKind;
  author_id: number;
  author_name: string;
  author_emoji: string | null;
  event_id: number | null;
  event_title: string | null;
  body: string;
  context: string | null;
  subject_id: number | null;
  subject_name: string | null;
  subject_emoji: string | null;
  subject_label: string | null;
  severity: number | null;
  anonymous: number;
  stance: 'claimed' | 'disputed' | null;
  stance_note: string | null;
  status: 'open' | 'forgiven' | 'found';
  resolved_by: number | null;
  resolver_name: string | null;
  resolved_at: string | null;
  unmasked_at: string | null;
  locked_at: string | null;
  expires_at: string | null;
  created_at: string;
};

// ------------------------------------------------------------------ time helpers

/** Offset of tz from UTC at the given instant, in minutes. */
function tzOffset(at: Date, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** House-local calendar parts for an instant. */
function houseParts(at: Date, tz: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at).map((x) => [x.type, x.value]),
  );
  return { y: +p.year, m: +p.month, d: +p.day };
}

/** UTC ISO instant of house-local midnight on y-m-d (m is 1-based, may overflow). */
function houseMidnight(y: number, m: number, d: number, tz: string): string {
  const guess = new Date(Date.UTC(y, m - 1, d));
  const off = tzOffset(guess, tz);
  const t = new Date(guess.getTime() - off * 60000);
  // Correct across a DST change between guess and result.
  const off2 = tzOffset(t, tz);
  return new Date(guess.getTime() - off2 * 60000).toISOString();
}

export function monthKey(at: Date, tz: string): string {
  const { y, m } = houseParts(at, tz);
  return `${y}-${String(m).padStart(2, '0')}`;
}

function monthRange(key: string, tz: string): [string, string] {
  const [y, m] = key.split('-').map(Number);
  return [houseMidnight(y, m, 1, tz), houseMidnight(y, m + 1, 1, tz)];
}

function prevMonthKey(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ service

const nameSql = (alias: string) => `COALESCE(NULLIF(${alias}.display_name, ''), ${alias}.username)`;

const SELECT_POST = `
  SELECT p.*,
    ${nameSql('a')} AS author_name, a.emoji AS author_emoji,
    ${nameSql('s')} AS subject_name, s.emoji AS subject_emoji,
    ${nameSql('r')} AS resolver_name,
    e.title AS event_title
  FROM posts p
  JOIN users a ON a.id = p.author_id
  LEFT JOIN users s ON s.id = p.subject_id
  LEFT JOIN users r ON r.id = p.resolved_by
  LEFT JOIN events e ON e.id = p.event_id`;

const VISIBLE = `(p.expires_at IS NULL OR p.expires_at > ?)`;

export class PostsService {
  ctx: Ctx;
  db: Db;
  private lastPurge = 0;
  constructor(ctx: Ctx) {
    this.ctx = ctx;
    this.db = ctx.db;
  }

  get tz() {
    return (this.ctx.cfg as { houseTz?: string }).houseTz || 'America/New_York';
  }
  get regretTtlHours() {
    return this.ctx.house().regretTtlHours;
  }
  get forgiveThreshold() {
    return Math.max(1, this.ctx.house().forgiveThreshold);
  }

  memberCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users WHERE removed_at IS NULL').get() as { n: number }).n;
  }

  members() {
    return this.db
      .prepare(`SELECT u.id, ${nameSql('u')} AS name, u.emoji FROM users u WHERE u.removed_at IS NULL ORDER BY name COLLATE NOCASE`)
      .all() as { id: number; name: string; emoji: string | null }[];
  }

  isMember(userId: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM users WHERE id = ? AND removed_at IS NULL').get(userId);
  }

  /** Hard-delete expired posts plus everything hanging off them. Throttled on read paths. */
  purgeExpired(force = false): number {
    const t = Date.now();
    if (!force && t - this.lastPurge < 30_000) return 0;
    this.lastPurge = t;
    return tx(this.db, () => {
      const ids = (this.db.prepare('SELECT id FROM posts WHERE expires_at IS NOT NULL AND expires_at <= ?').all(now()) as { id: number }[]).map((r) => r.id);
      if (!ids.length) return 0;
      this.hardDelete(ids);
      return ids.length;
    });
  }

  /** Real deletion: the post, its reactions, its unmask ballots, and any feed announcements about it. */
  private hardDelete(ids: number[]) {
    const ph = ids.map(() => '?').join(',');
    deleteReactionsFor(this.db, 'post', ids);
    this.db.prepare(`DELETE FROM ballots WHERE (subject_type = 'unmask' OR subject_type LIKE 'roty:%') AND subject_id IN (${ph})`).run(...ids);
    this.db.prepare(`DELETE FROM feed_items WHERE subject_type = 'post' AND subject_id IN (${ph})`).run(...ids);
    this.db.prepare(`DELETE FROM posts WHERE id IN (${ph})`).run(...ids);
  }

  get(id: number): PostRow | undefined {
    return this.db.prepare(`${SELECT_POST} WHERE p.id = ? AND ${VISIBLE}`).get(id, now()) as PostRow | undefined;
  }

  mustGet(id: number): PostRow {
    const p = this.get(id);
    if (!p) throw new HttpError(404, 'That post is gone');
    return p;
  }

  /** For actions that change a post's state: refuses locked posts. */
  mustGetOpen(id: number): PostRow {
    const p = this.mustGet(id);
    if (p.locked_at) throw new HttpError(423, 'An admin locked this post');
    return p;
  }

  setLocked(viewer: Viewer, id: number, locked: boolean) {
    if (!viewer.is_admin) throw new HttpError(403, 'Admins only');
    this.mustGet(id);
    this.db.prepare('UPDATE posts SET locked_at = ?, updated_at = ? WHERE id = ?').run(locked ? now() : null, now(), id);
    this.changed();
  }

  list(opts: { kinds?: PostKind[]; eventId?: number; subjectId?: number; status?: string; before?: string; limit?: number }): PostRow[] {
    this.purgeExpired();
    const where = [VISIBLE];
    const params: (string | number)[] = [now()];
    if (opts.kinds?.length) {
      where.push(`p.kind IN (${opts.kinds.map(() => '?').join(',')})`);
      params.push(...opts.kinds);
    }
    if (opts.eventId) {
      where.push('p.event_id = ?');
      params.push(opts.eventId);
    }
    if (opts.subjectId) {
      where.push('p.subject_id = ?');
      params.push(opts.subjectId);
    }
    if (opts.status) {
      where.push('p.status = ?');
      params.push(opts.status);
    }
    if (opts.before) {
      where.push('p.created_at < ?');
      params.push(opts.before);
    }
    const limit = Math.min(100, Math.max(1, opts.limit ?? 30));
    return this.db
      .prepare(`${SELECT_POST} WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC, p.id DESC LIMIT ?`)
      .all(...params, limit) as PostRow[];
  }

  create(author: Viewer, input: Record<string, unknown>): PostRow {
    const kind = String(input.kind ?? '') as PostKind;
    if (!POST_KINDS.includes(kind)) throw new HttpError(400, 'Unknown post type');
    const text = (v: unknown, max: number, name: string, required = false) => {
      const s = typeof v === 'string' ? v.trim() : '';
      if (required && !s) throw new HttpError(400, `${name} is required`);
      if (s.length > max) throw new HttpError(400, `${name} is too long (max ${max})`);
      return s || null;
    };
    let body = text(input.body, LIMITS.body, kind === 'lost_item' ? 'What you lost' : 'The line', kind !== 'irish_goodbye');
    const context = text(input.context, LIMITS.context, kind === 'lost_item' ? 'Last seen' : 'Context');
    let subjectId = input.subjectId == null || input.subjectId === '' ? null : Number(input.subjectId);
    const subjectLabel = text(input.subjectLabel, LIMITS.label, 'Name');
    if (subjectId !== null) {
      if (!Number.isInteger(subjectId) || !this.isMember(subjectId)) throw new HttpError(400, 'Pick someone from the group');
    }
    let eventId = input.eventId == null || input.eventId === '' ? null : Number(input.eventId);
    if (eventId !== null) {
      if (!Number.isInteger(eventId) || !this.db.prepare('SELECT 1 FROM events WHERE id = ?').get(eventId)) eventId = null;
    }

    let severity: number | null = null;
    let anonymous = 0;
    let expiresAt: string | null = null;
    if (kind === 'quote') {
      if (subjectId === null && !subjectLabel) throw new HttpError(400, 'Who said it?');
    } else if (kind === 'regret') {
      severity = Number(input.severity ?? 1);
      if (!Number.isInteger(severity) || severity < 1 || severity > 5) throw new HttpError(400, 'Pick a severity');
      anonymous = input.anonymous ? 1 : 0;
      // Ephemeral by default: regrets self-destruct unless the poster chooses to keep them.
      const selfDestruct = input.selfDestruct === undefined ? true : !!input.selfDestruct;
      if (selfDestruct) expiresAt = new Date(Date.parse(now()) + this.regretTtlHours * 3600_000).toISOString();
      subjectId = null;
    } else if (kind === 'irish_goodbye') {
      if (subjectId === null && !subjectLabel) throw new HttpError(400, 'Who left without saying bye?');
      body ??= 'left without saying bye';
    } else if (kind === 'lost_item') {
      subjectId = null;
    }

    const id = tx(this.db, () => {
      const res = this.db
        .prepare(
          `INSERT INTO posts (kind, author_id, event_id, body, context, subject_id, subject_label, severity, anonymous, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(kind, author.id, eventId, body!, context, subjectId, subjectId ? null : subjectLabel, severity, anonymous, expiresAt, now(), now());
      const pid = Number(res.lastInsertRowid);
      const who = this.displayName(author.id);
      if (kind === 'quote' && subjectId && subjectId !== author.id) {
        this.ctx.svc.notify(subjectId, null, `🗣️ ${who} put you on the Quote Wall: “${clip(body!, 80)}”`, `/lore?post=${pid}`);
      }
      if (kind === 'irish_goodbye' && subjectId && subjectId !== author.id) {
        this.ctx.svc.notify(subjectId, null, `👻 ${who} logged you for an Irish goodbye. Claim it or dispute it.`, `/feed?post=${pid}`);
      }
      if (kind === 'lost_item') {
        this.ctx.svc.notifyMembers(`🧥 ${who} lost: ${clip(body!, 60)}. Got it?`, `/feed?post=${pid}`, author.id);
      }
      return pid;
    });
    this.changed();
    return this.mustGet(id);
  }

  remove(viewer: Viewer, id: number) {
    const p = this.mustGet(id);
    if (p.author_id !== viewer.id && !viewer.is_admin) throw new HttpError(403, 'Only whoever posted it (or an admin) can delete it');
    tx(this.db, () => this.hardDelete([id]));
    this.changed();
  }

  react(viewer: Viewer, id: number, emoji: string): { added: boolean; forgiven: boolean } {
    const p = this.mustGetOpen(id);
    let forgiven = false;
    const added = tx(this.db, () => {
      const on = toggleReaction(this.db, 'post', id, viewer.id, emoji);
      // Absolution: enough 🙏 from people other than the confessor marks a regret forgiven. Sticky.
      if (on && emoji === '🙏' && p.kind === 'regret' && p.status === 'open') {
        const n = countReactions(this.db, 'post', id, '🙏', p.author_id);
        if (n >= this.forgiveThreshold) {
          this.db.prepare(`UPDATE posts SET status = 'forgiven', resolved_at = ?, updated_at = ? WHERE id = ?`).run(now(), now(), id);
          this.ctx.svc.notify(p.author_id, null, `🙏 The group forgave one of your regrets. Go in peace.`, `/feed?post=${id}`);
          forgiven = true;
        }
      }
      return on;
    });
    this.changed();
    return { added, forgiven };
  }

  setStance(viewer: Viewer, id: number, stance: unknown, note: unknown) {
    const p = this.mustGetOpen(id);
    if (p.kind !== 'quote' && p.kind !== 'irish_goodbye') throw new HttpError(400, 'Nothing to claim here');
    if (p.subject_id !== viewer.id) throw new HttpError(403, 'Only the person named can claim or dispute it');
    const s = stance === 'claimed' || stance === 'disputed' ? stance : null;
    const n = typeof note === 'string' && note.trim() ? note.trim().slice(0, LIMITS.stanceNote) : null;
    this.db.prepare('UPDATE posts SET stance = ?, stance_note = ?, stance_at = ?, updated_at = ? WHERE id = ?').run(s, s ? n : null, s ? now() : null, now(), id);
    if (s && p.author_id !== viewer.id) {
      const who = this.displayName(viewer.id);
      const msg = s === 'claimed' ? `💅 ${who} stands by it: “${clip(p.body, 60)}”` : `🙅 ${who} says they never said “${clip(p.body, 60)}”`;
      this.ctx.svc.notify(p.author_id, null, msg, `/lore?post=${id}`);
    }
    this.changed();
  }

  /** Lost & Found: "I have it". Auto-closes the post and pings the owner. */
  markFound(viewer: Viewer, id: number) {
    const p = this.mustGetOpen(id);
    if (p.kind !== 'lost_item') throw new HttpError(400, 'Not a lost item');
    if (p.status === 'found') throw new HttpError(409, 'Someone already has it');
    this.db.prepare(`UPDATE posts SET status = 'found', resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ?`).run(viewer.id, now(), now(), id);
    if (p.author_id !== viewer.id) {
      this.ctx.svc.notify(p.author_id, null, `🙌 ${this.displayName(viewer.id)} has your ${clip(p.body, 50)}`, `/feed?post=${id}`);
    }
    this.changed();
  }

  reopen(viewer: Viewer, id: number) {
    const p = this.mustGetOpen(id);
    if (p.kind !== 'lost_item') throw new HttpError(400, 'Not a lost item');
    if (p.author_id !== viewer.id && p.resolved_by !== viewer.id && !viewer.is_admin) throw new HttpError(403, 'Not yours to reopen');
    this.db.prepare(`UPDATE posts SET status = 'open', resolved_by = NULL, resolved_at = NULL, updated_at = ? WHERE id = ?`).run(now(), id);
    this.changed();
  }

  // ---------- unmask vote: the group gets one reveal of one anonymous regret per month ----------

  unmaskState() {
    const month = monthKey(new Date(now()), this.tz);
    const [from, to] = monthRange(month, this.tz);
    const used = this.db.prepare('SELECT id FROM posts WHERE unmasked_at >= ? AND unmasked_at < ? LIMIT 1').get(from, to) as { id: number } | undefined;
    const needed = Math.max(3, Math.ceil(this.memberCount() / 2));
    return { month, usedOn: used?.id ?? null, needed };
  }

  unmaskVotes(ids: number[], viewerId: number): Map<number, { votes: number; mine: boolean }> {
    const out = new Map<number, { votes: number; mine: boolean }>();
    if (!ids.length) return out;
    const rows = this.db
      .prepare(
        `SELECT subject_id, COUNT(*) AS n, MAX(user_id = ?) AS mine FROM ballots
         WHERE subject_type = 'unmask' AND value = 1 AND subject_id IN (${ids.map(() => '?').join(',')}) GROUP BY subject_id`,
      )
      .all(viewerId, ...ids) as { subject_id: number; n: number; mine: number }[];
    for (const r of rows) out.set(r.subject_id, { votes: r.n, mine: !!r.mine });
    return out;
  }

  voteUnmask(viewer: Viewer, id: number): { revealed: boolean; votes: number } {
    const p = this.mustGetOpen(id);
    if (p.kind !== 'regret' || !p.anonymous) throw new HttpError(400, 'Only anonymous regrets can be unmasked');
    if (p.unmasked_at) throw new HttpError(409, 'Already unmasked');
    if (p.author_id === viewer.id) throw new HttpError(400, 'Nice try');
    const state = this.unmaskState();
    if (state.usedOn) throw new HttpError(409, 'The group already used this month’s unmask');
    let revealed = false;
    const votes = tx(this.db, () => {
      const had = this.db.prepare(`SELECT 1 FROM ballots WHERE subject_type = 'unmask' AND subject_id = ? AND user_id = ?`).get(id, viewer.id);
      if (had) {
        this.db.prepare(`DELETE FROM ballots WHERE subject_type = 'unmask' AND subject_id = ? AND user_id = ?`).run(id, viewer.id);
      } else {
        // One live unmask ballot per person: backing a new regret moves your vote.
        this.db
          .prepare(
            `DELETE FROM ballots WHERE subject_type = 'unmask' AND user_id = ?
             AND subject_id IN (SELECT id FROM posts WHERE kind = 'regret' AND unmasked_at IS NULL)`,
          )
          .run(viewer.id);
        this.db.prepare(`INSERT INTO ballots (subject_type, subject_id, user_id, value) VALUES ('unmask', ?, ?, 1)`).run(id, viewer.id);
      }
      const n = (this.db.prepare(`SELECT COUNT(*) AS n FROM ballots WHERE subject_type = 'unmask' AND subject_id = ? AND value = 1`).get(id) as { n: number }).n;
      if (n >= state.needed) {
        this.db.prepare('UPDATE posts SET unmasked_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id);
        this.ctx.svc.notify(p.author_id, null, `🎭 The group voted. Your anonymous regret is unmasked. Sorry.`, `/feed?post=${id}`);
        this.ctx.svc.notifyMembers(`🎭 The group voted to unmask an anonymous regret. Go look.`, `/feed?post=${id}`, p.author_id);
        revealed = true;
      }
      return n;
    });
    this.changed();
    return { revealed, votes };
  }

  // ---------- Quote of the Month: the most-reacted quote said in that house month ----------

  quoteOfMonth(month: string): PostRow | null {
    const [from, to] = monthRange(month, this.tz);
    const row = this.db
      .prepare(
        `${SELECT_POST}
         LEFT JOIN (SELECT target_id, COUNT(*) AS n FROM reactions WHERE target_type = 'post' GROUP BY target_id) rx ON rx.target_id = p.id
         WHERE p.kind = 'quote' AND p.created_at >= ? AND p.created_at < ? AND ${VISIBLE} AND COALESCE(rx.n, 0) > 0
         ORDER BY rx.n DESC, p.created_at ASC LIMIT 1`,
      )
      .get(from, to, now()) as PostRow | undefined;
    return row ?? null;
  }

  // ---------- Irish Goodbye leaderboard ----------

  goodbyeLeaderboard(year?: number) {
    const y = year ?? houseParts(new Date(now()), this.tz).y;
    const from = houseMidnight(y, 1, 1, this.tz);
    const to = houseMidnight(y + 1, 1, 1, this.tz);
    return this.db
      .prepare(
        `SELECT p.subject_id AS id, COALESCE(${nameSql('s')}, p.subject_label) AS name, s.emoji AS emoji,
           COUNT(*) AS count, SUM(p.stance = 'disputed') AS disputed, MAX(p.created_at) AS last_at
         FROM posts p LEFT JOIN users s ON s.id = p.subject_id
         WHERE p.kind = 'irish_goodbye' AND p.created_at >= ? AND p.created_at < ?
         GROUP BY COALESCE(CAST(p.subject_id AS TEXT), 'label:' || LOWER(p.subject_label))
         ORDER BY count DESC, last_at DESC LIMIT 25`,
      )
      .all(from, to) as { id: number | null; name: string; emoji: string | null; count: number; disputed: number; last_at: string }[];
  }

  // ---------- Stats for profiles and Stall Wrapped ----------

  /** Per-member numbers for a house year. Anonymous regrets count toward the poster's total but are never itemised. */
  stats(userId: number, year?: number) {
    const y = year ?? houseParts(new Date(now()), this.tz).y;
    const from = houseMidnight(y, 1, 1, this.tz);
    const to = houseMidnight(y + 1, 1, 1, this.tz);
    const n = (sql: string, ...p: (string | number)[]) => (this.db.prepare(sql).get(...p) as { n: number }).n;
    const topQuote = this.db
      .prepare(
        `${SELECT_POST}
         LEFT JOIN (SELECT target_id, COUNT(*) AS n FROM reactions WHERE target_type = 'post' GROUP BY target_id) rx ON rx.target_id = p.id
         WHERE p.kind = 'quote' AND p.subject_id = ? AND p.created_at >= ? AND p.created_at < ?
         ORDER BY COALESCE(rx.n, 0) DESC, p.created_at ASC LIMIT 1`,
      )
      .get(userId, from, to) as PostRow | undefined;
    return {
      year: y,
      timesQuoted: n(`SELECT COUNT(*) AS n FROM posts WHERE kind = 'quote' AND subject_id = ? AND created_at >= ? AND created_at < ?`, userId, from, to),
      quotesHeard: n(`SELECT COUNT(*) AS n FROM posts WHERE kind = 'quote' AND author_id = ? AND created_at >= ? AND created_at < ?`, userId, from, to),
      regrets: n(`SELECT COUNT(*) AS n FROM posts WHERE kind = 'regret' AND author_id = ? AND created_at >= ? AND created_at < ?`, userId, from, to),
      irishGoodbyes: n(`SELECT COUNT(*) AS n FROM posts WHERE kind = 'irish_goodbye' AND subject_id = ? AND created_at >= ? AND created_at < ?`, userId, from, to),
      itemsLost: n(`SELECT COUNT(*) AS n FROM posts WHERE kind = 'lost_item' AND author_id = ? AND created_at >= ? AND created_at < ?`, userId, from, to),
      itemsReturned: n(`SELECT COUNT(*) AS n FROM posts WHERE kind = 'lost_item' AND resolved_by = ? AND resolved_by != author_id AND created_at >= ? AND created_at < ?`, userId, from, to),
      topQuote: topQuote ? { id: topQuote.id, body: topQuote.body } : null,
    };
  }

  /** Group-wide year numbers: most-quoted member, total regrets, worst ghost. */
  yearStats(year?: number) {
    const y = year ?? houseParts(new Date(now()), this.tz).y;
    const from = houseMidnight(y, 1, 1, this.tz);
    const to = houseMidnight(y + 1, 1, 1, this.tz);
    const mostQuoted = this.db
      .prepare(
        `SELECT p.subject_id AS id, ${nameSql('s')} AS name, s.emoji, COUNT(*) AS count FROM posts p JOIN users s ON s.id = p.subject_id
         WHERE p.kind = 'quote' AND p.created_at >= ? AND p.created_at < ? GROUP BY p.subject_id ORDER BY count DESC LIMIT 3`,
      )
      .all(from, to);
    const totalRegrets = (this.db.prepare(`SELECT COUNT(*) AS n FROM posts WHERE kind = 'regret' AND created_at >= ? AND created_at < ?`).get(from, to) as { n: number }).n;
    return { year: y, mostQuoted, totalRegrets, disappearingAct: this.goodbyeLeaderboard(y).slice(0, 3) };
  }

  // ---------- Regret of the Year: an 8-seed elimination bracket in December ----------
  // Seeds are the year's kept (non-self-destructing) regrets ranked by reactions given before
  // Dec 1, so the bracket is frozen once it starts. Rounds run by house calendar:
  // quarterfinals Dec 1–7, semis Dec 8–14, final Dec 15–21, champion crowned Dec 22.
  // Every state is derived at read time from ballots, so no job is needed.

  private rotyRounds(y: number) {
    const tz = this.tz;
    return [
      { name: 'Quarterfinals', from: houseMidnight(y, 12, 1, tz), to: houseMidnight(y, 12, 8, tz) },
      { name: 'Semifinals', from: houseMidnight(y, 12, 8, tz), to: houseMidnight(y, 12, 15, tz) },
      { name: 'Final', from: houseMidnight(y, 12, 15, tz), to: houseMidnight(y, 12, 22, tz) },
    ];
  }

  private rotySeeds(y: number): PostRow[] {
    const from = houseMidnight(y, 1, 1, this.tz);
    const freeze = houseMidnight(y, 12, 1, this.tz);
    return this.db
      .prepare(
        `${SELECT_POST}
         LEFT JOIN (SELECT target_id, COUNT(*) AS n FROM reactions WHERE target_type = 'post' AND created_at < ? GROUP BY target_id) rx ON rx.target_id = p.id
         WHERE p.kind = 'regret' AND p.expires_at IS NULL AND p.created_at >= ? AND p.created_at < ?
         ORDER BY COALESCE(rx.n, 0) DESC, p.created_at ASC LIMIT 8`,
      )
      .all(freeze, from, freeze) as PostRow[];
  }

  private rotyTally(subject: string, a: number, b: number, viewerId: number) {
    const rows = this.db
      .prepare(`SELECT subject_id, COUNT(*) AS n, MAX(user_id = ?) AS mine FROM ballots WHERE subject_type = ? AND subject_id IN (?, ?) GROUP BY subject_id`)
      .all(viewerId, subject, a, b) as { subject_id: number; n: number; mine: number }[];
    const get = (id: number) => rows.find((r) => r.subject_id === id);
    return { a: get(a)?.n ?? 0, b: get(b)?.n ?? 0, myPick: get(a)?.mine ? a : get(b)?.mine ? b : null };
  }

  /** The whole bracket for a year, with winners resolved for finished rounds. */
  regretOfTheYear(year: number | undefined, viewer: Viewer) {
    const y = year ?? houseParts(new Date(now()), this.tz).y;
    const t = now();
    const rounds = this.rotyRounds(y);
    const seeds = this.rotySeeds(y);
    if (t < rounds[0].from) return { year: y, status: 'upcoming' as const, startsAt: rounds[0].from, seeds: seeds.length, rounds: [], champion: null };
    if (seeds.length < 2) return { year: y, status: 'cancelled' as const, startsAt: rounds[0].from, seeds: seeds.length, rounds: [], champion: null };
    // Standard 8-seed order: 1v8, 4v5, 2v7, 3v6 (byes when fewer than 8).
    const order = [0, 7, 3, 4, 1, 6, 2, 5];
    let entrants: (PostRow | null)[] = order.map((i) => seeds[i] ?? null);
    const out: { name: string; from: string; to: string; open: boolean; matches: unknown[] }[] = [];
    let champion: PostRow | null = null;
    for (let ri = 0; ri < rounds.length; ri++) {
      const round = rounds[ri];
      const open = t >= round.from && t < round.to;
      const done = t >= round.to;
      if (t < round.from) {
        out.push({ ...round, open: false, matches: [] });
        continue;
      }
      const next: (PostRow | null)[] = [];
      const matches = [];
      for (let mi = 0; mi < entrants.length; mi += 2) {
        const a = entrants[mi];
        const b = entrants[mi + 1];
        const subject = `roty:${y}:${ri}:${mi / 2}`;
        let winner: PostRow | null;
        let tally = { a: 0, b: 0, myPick: null as number | null };
        if (!a || !b) winner = a ?? b; // bye
        else {
          tally = this.rotyTally(subject, a.id, b.id, viewer.id);
          // Ties go to the higher seed (earlier in the seed list).
          winner = tally.a > tally.b ? a : tally.b > tally.a ? b : seeds.indexOf(a) <= seeds.indexOf(b) ? a : b;
        }
        next.push(done ? winner : null);
        matches.push({
          key: subject,
          a: a ? this.views([a], viewer)[0] : null,
          b: b ? this.views([b], viewer)[0] : null,
          votes: { a: tally.a, b: tally.b },
          myPick: tally.myPick,
          winner: done && winner ? winner.id : null,
        });
      }
      out.push({ ...round, open, matches });
      if (!done) break;
      entrants = next;
      if (entrants.length === 1) champion = entrants[0];
    }
    if (rounds.every((r) => t >= r.to) && entrants.length === 1) champion = entrants[0];
    return {
      year: y,
      status: champion ? ('crowned' as const) : ('voting' as const),
      startsAt: rounds[0].from,
      seeds: seeds.length,
      rounds: out,
      champion: champion ? this.views([champion], viewer)[0] : null,
    };
  }

  voteRoty(viewer: Viewer, key: string, postId: number) {
    const m = /^roty:(\d{4}):(\d):(\d)$/.exec(key);
    if (!m) throw new HttpError(400, 'Bad match');
    const bracket = this.regretOfTheYear(Number(m[1]), viewer);
    const round = bracket.rounds[Number(m[2])];
    if (!round?.open) throw new HttpError(409, 'Voting for that round is closed');
    const match = (round.matches as { key: string; a: { id: number } | null; b: { id: number } | null }[]).find((x) => x.key === key);
    if (!match?.a || !match.b) throw new HttpError(400, 'Nothing to vote on');
    if (postId !== match.a.id && postId !== match.b.id) throw new HttpError(400, 'Pick one of the two');
    tx(this.db, () => {
      this.db.prepare('DELETE FROM ballots WHERE subject_type = ? AND user_id = ?').run(key, viewer.id);
      this.db.prepare('INSERT INTO ballots (subject_type, subject_id, user_id, value) VALUES (?, ?, ?, 1)').run(key, postId, viewer.id);
    });
    this.changed();
  }

  // ---------- Quote of the Month announcement (from tick) ----------

  /** On the 1st after noon house time, crown last month's most-reacted quote and ping the group (and the speaker). */
  quoteOfMonthAnnouncement() {
    const t = new Date(now());
    const p = houseParts(t, this.tz);
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: this.tz, hour: 'numeric', hourCycle: 'h23' }).format(t));
    if (p.d !== 1 || hour < 12) return;
    const last = prevMonthKey(monthKey(t, this.tz));
    const q = this.quoteOfMonth(last);
    if (!q) return;
    const claimed = this.db.prepare('INSERT OR IGNORE INTO jobs_sent (key, sent_at) VALUES (?, ?)').run(`posts:qotm:${last}`, now());
    if (!claimed.changes) return;
    const speaker = q.subject_name ?? q.subject_label ?? 'someone';
    const month = new Date(Date.UTC(+last.slice(0, 4), +last.slice(5) - 1, 15)).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
    this.ctx.svc.notifyMembers(`🏆 Quote of ${month}: “${clip(q.body, 90)}” — ${speaker}`, `/lore?post=${q.id}`, q.subject_id ?? undefined);
    if (q.subject_id) this.ctx.svc.notify(q.subject_id, null, `🏆 You won Quote of ${month}: “${clip(q.body, 80)}”. Iconic or tragic, you decide.`, `/lore?post=${q.id}`);
  }

  // ---------- Daily Quote (from tick) ----------

  dailyQuote() {
    const today = (() => {
      const { y, m, d } = houseParts(new Date(now()), this.tz);
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    })();
    const key = `posts:daily-quote:${today}`;
    // Only after 11am house time, once per day (jobs_sent dedupes across restarts and instances).
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: this.tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(now())));
    if (hour < 11) return;
    const claimed = this.db.prepare('INSERT OR IGNORE INTO jobs_sent (key, sent_at) VALUES (?, ?)').run(key, now());
    if (!claimed.changes) return;
    const weekAgo = new Date(Date.parse(now()) - 7 * 86400_000).toISOString();
    const q =
      (this.db.prepare(`${SELECT_POST} WHERE p.kind = 'quote' AND p.created_at < ? AND ${VISIBLE} ORDER BY RANDOM() LIMIT 1`).get(weekAgo, now()) as PostRow | undefined) ??
      (this.db.prepare(`${SELECT_POST} WHERE p.kind = 'quote' AND ${VISIBLE} ORDER BY RANDOM() LIMIT 1`).get(now()) as PostRow | undefined);
    if (!q) return;
    this.ctx.svc.notifyMembers(`🗣️ “${clip(q.body, 100)}” — ${q.subject_name ?? q.subject_label ?? 'someone'}`, `/lore?post=${q.id}`);
  }

  // ---------- view ----------

  displayName(userId: number): string {
    const r = this.db.prepare(`SELECT ${nameSql('u')} AS name FROM users u WHERE u.id = ?`).get(userId) as { name: string } | undefined;
    return r?.name ?? 'Someone';
  }

  views(rows: PostRow[], viewer: Viewer) {
    const ids = rows.map((r) => r.id);
    const rx = reactionsFor(this.db, 'post', ids, viewer.id);
    const anonIds = rows.filter((r) => r.kind === 'regret' && !!r.anonymous && !r.unmasked_at).map((r) => r.id);
    const unmask = this.unmaskVotes(anonIds, viewer.id);
    const us = anonIds.length ? this.unmaskState() : null;
    return rows.map((r) => this.view(r, viewer, rx.get(r.id) ?? [], unmask, us));
  }

  private view(
    r: PostRow,
    viewer: Viewer,
    reactions: ReactionSummary[],
    unmask: Map<number, { votes: number; mine: boolean }>,
    us: ReturnType<PostsService['unmaskState']> | null,
  ) {
    const mine = r.author_id === viewer.id;
    const open = !r.locked_at;
    // Anonymous author identity never leaves the server unless the group unmasked it.
    const hidden = !!r.anonymous && !r.unmasked_at;
    const sev = r.severity ? SEVERITY[r.severity - 1] : null;
    const forgive = reactions.find((x) => x.emoji === '🙏');
    return {
      id: r.id,
      kind: r.kind,
      body: r.body,
      context: r.context,
      author: hidden ? null : { id: r.author_id, name: r.author_name, emoji: r.author_emoji },
      mine,
      anonymous: !!r.anonymous,
      unmasked: !!r.unmasked_at,
      subject: r.subject_id ? { id: r.subject_id, name: r.subject_name, emoji: r.subject_emoji, member: true } : r.subject_label ? { id: null, name: r.subject_label, emoji: null, member: false } : null,
      event: r.event_id ? { id: r.event_id, title: r.event_title } : null,
      severity: sev ? { ...sev } : null,
      stance: r.stance,
      stanceNote: r.stance_note,
      status: r.status,
      resolvedBy: r.resolved_by ? { id: r.resolved_by, name: r.resolver_name } : null,
      resolvedAt: r.resolved_at,
      locked: !!r.locked_at,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
      reactions,
      forgiveness: r.kind === 'regret' ? { count: forgive ? forgive.count - (forgive.mine && mine ? 1 : 0) : 0, needed: this.forgiveThreshold } : null,
      unmask: hidden && r.kind === 'regret' && us ? { votes: unmask.get(r.id)?.votes ?? 0, mine: unmask.get(r.id)?.mine ?? false, needed: us.needed, available: !us.usedOn } : null,
      can: {
        delete: mine || !!viewer.is_admin,
        stance: open && (r.kind === 'quote' || r.kind === 'irish_goodbye') && r.subject_id === viewer.id,
        found: open && r.kind === 'lost_item' && r.status === 'open',
        reopen: open && r.kind === 'lost_item' && r.status === 'found' && (mine || r.resolved_by === viewer.id || !!viewer.is_admin),
        unmask: open && hidden && r.kind === 'regret' && !mine && !!us && !us.usedOn,
        lock: !!viewer.is_admin,
      },
    };
  }

  changed() {
    queueMicrotask(() => this.ctx.bus.emit('feed'));
  }
}

function clip(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// ------------------------------------------------------------------ routes

function pid(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Bad id');
  return n;
}

function parseKinds(v: unknown): PostKind[] | undefined {
  if (!v || v === 'all') return undefined;
  const ks = String(v).split(',').filter((k): k is PostKind => (POST_KINDS as readonly string[]).includes(k));
  if (!ks.length) throw new HttpError(400, 'Unknown post type');
  return ks;
}

type FeedItemRow = { id: number; kind: string; actor_id: number | null; actor_name: string | null; actor_emoji: string | null; event_id: number | null; subject_type: string | null; subject_id: number | null; body: string; created_at: string };

export function routes(ctx: Ctx) {
  const svc = new PostsService(ctx);
  const r = express.Router();
  const me = (req: express.Request) => req.user as Viewer;

  r.get('/posts/meta', (req, res) => {
    const us = svc.unmaskState();
    res.json({
      kinds: POST_KINDS,
      severities: SEVERITY,
      reactions: REACTION_EMOJI,
      members: svc.members(),
      forgiveThreshold: svc.forgiveThreshold,
      regretTtlHours: svc.regretTtlHours,
      unmask: { available: !us.usedOn, needed: us.needed, month: us.month },
      me: me(req).id,
    });
  });

  r.get('/posts', (req, res) => {
    const rows = svc.list({
      kinds: parseKinds(req.query.kind),
      eventId: req.query.event ? pid(req.query.event) : undefined,
      subjectId: req.query.subject ? pid(req.query.subject) : undefined,
      status: typeof req.query.status === 'string' && ['open', 'forgiven', 'found'].includes(req.query.status) ? req.query.status : undefined,
      before: typeof req.query.before === 'string' ? req.query.before : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.json({ posts: svc.views(rows, me(req)), next: rows.length ? rows[rows.length - 1].created_at : null });
  });

  r.post('/posts', (req, res) => {
    const p = svc.create(me(req), req.body ?? {});
    res.status(201).json({ post: svc.views([p], me(req))[0] });
  });

  r.get('/posts/quote-of-the-month', (req, res) => {
    const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : monthKey(new Date(now()), svc.tz);
    const cur = svc.quoteOfMonth(month);
    const prev = svc.quoteOfMonth(prevMonthKey(month));
    const [c, p] = svc.views([cur, prev].filter((x): x is PostRow => !!x), me(req)).reduce<[unknown, unknown]>(
      (acc, v) => (cur && v.id === cur.id ? [v, acc[1]] : [acc[0], v]),
      [null, null],
    );
    res.json({ month, current: c, previous: p, previousMonth: prevMonthKey(month) });
  });

  r.get('/posts/irish-goodbyes/leaderboard', (req, res) => {
    const year = req.query.year ? Number(req.query.year) : undefined;
    res.json({ leaderboard: svc.goodbyeLeaderboard(Number.isInteger(year) ? year : undefined) });
  });

  r.get('/posts/stats', (req, res) => {
    const year = req.query.year ? Number(req.query.year) : undefined;
    const y = Number.isInteger(year) ? year : undefined;
    const user = req.query.user ? pid(req.query.user) : me(req).id;
    res.json({ member: svc.stats(user, y), group: svc.yearStats(y) });
  });

  r.get('/posts/regret-of-the-year', (req, res) => {
    const year = req.query.year ? Number(req.query.year) : undefined;
    res.json(svc.regretOfTheYear(Number.isInteger(year) ? year : undefined, me(req)));
  });
  r.post('/posts/regret-of-the-year/vote', (req, res) => {
    svc.voteRoty(me(req), String(req.body?.match ?? ''), pid(req.body?.postId));
    res.json({ ok: true });
  });

  r.get('/posts/:id', (req, res) => {
    res.json({ post: svc.views([svc.mustGet(pid(req.params.id))], me(req))[0] });
  });
  r.delete('/posts/:id', (req, res) => {
    svc.remove(me(req), pid(req.params.id));
    res.json({ ok: true });
  });
  r.post('/posts/:id/react', (req, res) => {
    const out = svc.react(me(req), pid(req.params.id), String(req.body?.emoji ?? ''));
    res.json({ ...out, post: svc.views([svc.mustGet(pid(req.params.id))], me(req))[0] });
  });
  r.post('/posts/:id/stance', (req, res) => {
    svc.setStance(me(req), pid(req.params.id), req.body?.stance, req.body?.note);
    res.json({ post: svc.views([svc.mustGet(pid(req.params.id))], me(req))[0] });
  });
  r.post('/posts/:id/found', (req, res) => {
    svc.markFound(me(req), pid(req.params.id));
    res.json({ post: svc.views([svc.mustGet(pid(req.params.id))], me(req))[0] });
  });
  r.post('/posts/:id/reopen', (req, res) => {
    svc.reopen(me(req), pid(req.params.id));
    res.json({ post: svc.views([svc.mustGet(pid(req.params.id))], me(req))[0] });
  });
  r.post('/posts/:id/lock', (req, res) => {
    svc.setLocked(me(req), pid(req.params.id), req.body?.locked !== false);
    res.json({ post: svc.views([svc.mustGet(pid(req.params.id))], me(req))[0] });
  });
  r.post('/posts/:id/unmask', (req, res) => {
    const out = svc.voteUnmask(me(req), pid(req.params.id));
    res.json({ ...out, post: svc.views([svc.mustGet(pid(req.params.id))], me(req))[0] });
  });

  // Generic reactions for other modules' targets (photos, events...). Posts use /posts/:id/react
  // so absolution runs. The owning module is responsible for visibility of its targets.
  const REACTABLE = new Set(['photo', 'caption', 'event', 'feed_item', 'canon']);
  r.post('/reactions', (req, res) => {
    const type = String(req.body?.targetType ?? '');
    const targetId = pid(req.body?.targetId);
    if (type === 'post') {
      const out = svc.react(me(req), targetId, String(req.body?.emoji ?? ''));
      return res.json({ added: out.added, reactions: reactionsFor(ctx.db, 'post', [targetId], me(req).id).get(targetId) ?? [] });
    }
    if (!REACTABLE.has(type)) throw new HttpError(400, 'Cannot react to that');
    const added = toggleReaction(ctx.db, type, targetId, me(req).id, String(req.body?.emoji ?? ''));
    ctx.bus.emit('feed');
    res.json({ added, reactions: reactionsFor(ctx.db, type, [targetId], me(req).id).get(targetId) ?? [] });
  });
  r.get('/reactions', (req, res) => {
    const type = String(req.query.targetType ?? '');
    const ids = String(req.query.ids ?? '')
      .split(',')
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 200);
    const map = reactionsFor(ctx.db, type, ids, me(req).id);
    res.json({ reactions: Object.fromEntries(ids.map((i) => [i, map.get(i) ?? []])) });
  });

  // Unified Feed: posts plus core feed_items (RSVP changes, check-ins, announcements),
  // newest first, cursor-paged on created_at.
  r.get('/feed', (req, res) => {
    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 30));
    const eventId = req.query.event ? pid(req.query.event) : undefined;
    const posts = svc.list({ before, limit, eventId });
    const where = ['1=1'];
    const params: (string | number)[] = [];
    if (before) {
      where.push('f.created_at < ?');
      params.push(before);
    }
    if (eventId) {
      where.push('f.event_id = ?');
      params.push(eventId);
    }
    const items = ctx.db
      .prepare(
        `SELECT f.*, ${nameSql('u')} AS actor_name, u.emoji AS actor_emoji FROM feed_items f LEFT JOIN users u ON u.id = f.actor_id
         WHERE ${where.join(' AND ')} ORDER BY f.created_at DESC, f.id DESC LIMIT ?`,
      )
      .all(...params, limit) as FeedItemRow[];
    const merged = [
      ...svc.views(posts, me(req)).map((p) => ({ type: 'post' as const, at: p.createdAt, post: p })),
      ...items.map((f) => ({
        type: 'item' as const,
        at: f.created_at,
        item: {
          id: f.id, kind: f.kind, body: f.body, eventId: f.event_id, subjectType: f.subject_type, subjectId: f.subject_id,
          actor: f.actor_id ? { id: f.actor_id, name: f.actor_name, emoji: f.actor_emoji } : null, createdAt: f.created_at,
        },
      })),
    ]
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, limit);
    res.json({ feed: merged, next: merged.length === limit ? merged[merged.length - 1].at : null });
  });

  return r;
}

export function tick(ctx: Ctx) {
  const svc = new PostsService(ctx);
  svc.purgeExpired(true);
  svc.dailyQuote();
  svc.quoteOfMonthAnnouncement();
}

/**
 * Member removal. keep: posts stay credited. anonymize: their posts lose the byline (and
 * quotes/goodbyes naming them fall back to "a former member"). delete: everything they
 * posted, plus their reactions and ballots, is hard-deleted.
 */
export function onMemberRemoved(ctx: Ctx, userId: number, policy: RemovalPolicy) {
  if (policy === 'keep') return;
  if (policy === 'anonymize') {
    ctx.db.prepare('UPDATE posts SET anonymous = 1, unmasked_at = NULL, updated_at = ? WHERE author_id = ?').run(now(), userId);
    ctx.db.prepare(`UPDATE posts SET subject_id = NULL, subject_label = 'a former member', updated_at = ? WHERE subject_id = ?`).run(now(), userId);
    return;
  }
  const ids = (ctx.db.prepare('SELECT id FROM posts WHERE author_id = ? OR (subject_id = ? AND kind IN (\'quote\', \'irish_goodbye\'))').all(userId, userId) as { id: number }[]).map((r) => r.id);
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    deleteReactionsFor(ctx.db, 'post', ids);
    ctx.db.prepare(`DELETE FROM ballots WHERE (subject_type = 'unmask' OR subject_type LIKE 'roty:%') AND subject_id IN (${ph})`).run(...ids);
    ctx.db.prepare(`DELETE FROM feed_items WHERE subject_type = 'post' AND subject_id IN (${ph})`).run(...ids);
    ctx.db.prepare(`DELETE FROM posts WHERE id IN (${ph})`).run(...ids);
  }
  ctx.db.prepare('DELETE FROM reactions WHERE user_id = ?').run(userId);
  ctx.db.prepare(`DELETE FROM ballots WHERE user_id = ? AND (subject_type = 'unmask' OR subject_type LIKE 'roty:%')`).run(userId);
}

export const module: StallModule = { name: 'posts', migrations, routes, tick, onMemberRemoved };
export default module;
