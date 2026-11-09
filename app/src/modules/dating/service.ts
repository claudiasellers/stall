// Dating domain logic. Owner checks live here; routes only assume "is a member".
import { type Db, tx, now } from '../../db.ts';
import { HttpError } from '../../service.ts';
import { clock } from '../../clock.ts';
import type { ModuleCtx } from '../types.ts';

const NAME = `COALESCE(NULLIF(u.display_name, ''), u.username)`;
const STATUSES = ['talking', 'dating', 'situationship', 'benched', 'over'] as const;
const VERDICTS = ['again', 'never', 'tbd'] as const;
const VET_HOURS = 24;

const clean = (v: unknown, name: string, max: number, required = true): string => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s && required) throw new HttpError(400, `${name} is required`);
  if (s.length > max) throw new HttpError(400, `${name} is too long (max ${max})`);
  return s;
};
const optId = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Bad id');
  return n;
};
const marks = (n: number) => Array.from({ length: n }, () => '?').join(',');
type Page = { before?: string; limit?: number };
const lim = (p: Page, def = 30) => Math.min(Math.max(p.limit ?? def, 1), 50);

export class DatingService {
  ctx: ModuleCtx;
  db: Db;
  constructor(ctx: ModuleCtx) {
    this.ctx = ctx;
    this.db = ctx.db;
  }
  private live() {
    queueMicrotask(() => this.ctx.bus.emit('live', { topic: 'dating' }));
  }
  private nameOf(id: number) {
    return (this.db.prepare(`SELECT ${NAME} AS name FROM users u WHERE u.id = ?`).get(id) as { name: string } | undefined)?.name ?? 'Someone';
  }
  private ownRoster(rosterId: number | null, userId: number) {
    if (rosterId === null) return null;
    const r = this.db.prepare('SELECT * FROM dating_roster WHERE id = ? AND user_id = ?').get(rosterId, userId) as { id: number; alias: string } | undefined;
    if (!r) throw new HttpError(404, 'Not on your roster');
    return r;
  }

  // ======================================================== Roster

  addToRoster(userId: number, b: { alias?: unknown; metAt?: unknown; status?: unknown; note?: unknown }) {
    const status = (b.status ?? 'talking') as string;
    if (!STATUSES.includes(status as (typeof STATUSES)[number])) throw new HttpError(400, 'Bad status');
    const id = Number(
      this.db
        .prepare('INSERT INTO dating_roster (user_id, alias, met_at, status, note) VALUES (?, ?, ?, ?, ?)')
        .run(userId, clean(b.alias, 'alias', 40), clean(b.metAt, 'metAt', 60, false) || null, status, clean(b.note, 'note', 200, false) || null).lastInsertRowid,
    );
    this.live();
    return { id };
  }

  updateRoster(id: number, userId: number, b: { alias?: unknown; metAt?: unknown; status?: unknown; note?: unknown }) {
    const r = this.db.prepare('SELECT * FROM dating_roster WHERE id = ? AND user_id = ?').get(id, userId) as Record<string, string | null> | undefined;
    if (!r) throw new HttpError(404, 'Not on your roster');
    const status = b.status === undefined ? r.status : String(b.status);
    if (!STATUSES.includes(status as (typeof STATUSES)[number])) throw new HttpError(400, 'Bad status');
    this.db
      .prepare('UPDATE dating_roster SET alias = ?, met_at = ?, status = ?, note = ?, updated_at = ? WHERE id = ?')
      .run(
        b.alias === undefined ? r.alias : clean(b.alias, 'alias', 40),
        b.metAt === undefined ? r.met_at : clean(b.metAt, 'metAt', 60, false) || null,
        status,
        b.note === undefined ? r.note : clean(b.note, 'note', 200, false) || null,
        now(),
        id,
      );
    this.live();
    return { ok: true };
  }

  removeFromRoster(id: number, userId: number) {
    if (!this.db.prepare('DELETE FROM dating_roster WHERE id = ? AND user_id = ?').run(id, userId).changes) throw new HttpError(404, 'Not on your roster');
    this.live();
    return { ok: true };
  }

  /** Every member's roster, grouped by member, freshest first. One query. */
  rosters() {
    const rows = this.db
      .prepare(
        `SELECT r.*, ${NAME} AS name, u.emoji FROM dating_roster r JOIN users u ON u.id = r.user_id
         WHERE u.removed_at IS NULL ORDER BY r.updated_at DESC LIMIT 300`,
      )
      .all() as { id: number; user_id: number; name: string; emoji: string | null; alias: string; met_at: string | null; status: string; note: string | null; updated_at: string }[];
    const by = new Map<number, { userId: number; name: string; emoji: string | null; entries: object[] }>();
    for (const r of rows) {
      if (!by.has(r.user_id)) by.set(r.user_id, { userId: r.user_id, name: r.name, emoji: r.emoji, entries: [] });
      by.get(r.user_id)!.entries.push({ id: r.id, alias: r.alias, metAt: r.met_at, status: r.status, note: r.note, updatedAt: r.updated_at });
    }
    return [...by.values()];
  }

  // ======================================================== Vetting

  openVet(userId: number, b: { alias?: unknown; context?: unknown; rosterId?: unknown; hours?: unknown }) {
    const roster = this.ownRoster(optId(b.rosterId), userId);
    const alias = roster?.alias ?? clean(b.alias, 'alias', 40);
    const hours = b.hours === undefined ? VET_HOURS : Number(b.hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 72) throw new HttpError(400, 'Vote runs 1–72 hours');
    const closesAt = new Date(clock.now() + hours * 3600_000).toISOString();
    const id = Number(
      this.db
        .prepare('INSERT INTO dating_vets (user_id, roster_id, alias, context, closes_at) VALUES (?, ?, ?, ?, ?)')
        .run(userId, roster?.id ?? null, alias, clean(b.context, 'context', 300, false) || null, closesAt).lastInsertRowid,
    );
    this.ctx.svc.notifyMembers(`💘 ${this.nameOf(userId)} wants the group’s read on “${alias}”. Has anyone met them?`, `/dating/vet/${id}`, userId);
    this.live();
    return this.vet(id, userId);
  }

  voteVet(id: number, userId: number, value: unknown) {
    const v = Number(value);
    if (v !== 1 && v !== -1 && v !== 0) throw new HttpError(400, 'Vote is 1 (go), -1 (run) or 0 (clear)');
    const row = this.db.prepare('SELECT user_id, closes_at FROM dating_vets WHERE id = ?').get(id) as { user_id: number; closes_at: string } | undefined;
    if (!row) throw new HttpError(404, 'Not found');
    if (Date.parse(row.closes_at) <= clock.now()) throw new HttpError(409, 'Voting closed');
    if (v === 0) this.db.prepare(`DELETE FROM ballots WHERE subject_type = 'date_vet' AND subject_id = ? AND user_id = ?`).run(id, userId);
    else
      this.db
        .prepare(`INSERT INTO ballots (subject_type, subject_id, user_id, value) VALUES ('date_vet', ?, ?, ?) ON CONFLICT (subject_type, subject_id, user_id) DO UPDATE SET value = excluded.value`)
        .run(id, userId, v);
    this.live();
    return this.vet(id, userId);
  }

  commentVet(id: number, userId: number, b: { body?: unknown; metThem?: unknown }) {
    const row = this.db.prepare('SELECT user_id, alias FROM dating_vets WHERE id = ?').get(id) as { user_id: number; alias: string } | undefined;
    if (!row) throw new HttpError(404, 'Not found');
    const met = b.metThem ? 1 : 0;
    this.db.prepare('INSERT INTO dating_vet_comments (vet_id, user_id, met_them, body) VALUES (?, ?, ?, ?)').run(id, userId, met, clean(b.body, 'body', 500));
    if (row.user_id !== userId)
      this.ctx.svc.notify(row.user_id, null, met ? `👀 ${this.nameOf(userId)} has met “${row.alias}”. Read this.` : `💬 ${this.nameOf(userId)} weighed in on “${row.alias}”.`, `/dating/vet/${id}`);
    this.live();
    return this.vet(id, userId);
  }

  deleteVet(id: number, userId: number, isAdmin: boolean) {
    const row = this.db.prepare('SELECT user_id FROM dating_vets WHERE id = ?').get(id) as { user_id: number } | undefined;
    if (!row) throw new HttpError(404, 'Not found');
    if (row.user_id !== userId && !isAdmin) throw new HttpError(403, 'Not yours');
    tx(this.db, () => {
      this.db.prepare(`DELETE FROM ballots WHERE subject_type = 'date_vet' AND subject_id = ?`).run(id);
      this.db.prepare('DELETE FROM dating_vets WHERE id = ?').run(id);
    });
    this.live();
    return { ok: true };
  }

  /** Vets with tallies and comments: three queries per page. */
  vets(viewerId: number, p: Page & { ids?: number[] } = {}) {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (p.ids?.length) (where.push(`v.id IN (${marks(p.ids.length)})`), params.push(...p.ids));
    if (p.before) (where.push('v.created_at < ?'), params.push(p.before));
    const rows = this.db
      .prepare(`SELECT v.*, ${NAME} AS name FROM dating_vets v JOIN users u ON u.id = v.user_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY v.created_at DESC LIMIT ?`)
      .all(...params, lim(p)) as { id: number; user_id: number; name: string; alias: string; context: string | null; closes_at: string; created_at: string; roster_id: number | null }[];
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const ballots = this.db
      .prepare(`SELECT subject_id, user_id, value FROM ballots WHERE subject_type = 'date_vet' AND subject_id IN (${marks(ids.length)})`)
      .all(...ids) as { subject_id: number; user_id: number; value: number }[];
    const comments = this.db
      .prepare(`SELECT c.*, ${NAME} AS name FROM dating_vet_comments c JOIN users u ON u.id = c.user_id WHERE c.vet_id IN (${marks(ids.length)}) ORDER BY c.created_at`)
      .all(...ids) as { id: number; vet_id: number; user_id: number; name: string; met_them: number; body: string; created_at: string }[];
    const nowMs = clock.now();
    return rows.map((r) => {
      const bs = ballots.filter((b) => b.subject_id === r.id);
      const cs = comments.filter((c) => c.vet_id === r.id);
      const go = bs.filter((b) => b.value === 1).length;
      const run = bs.filter((b) => b.value === -1).length;
      const closed = Date.parse(r.closes_at) <= nowMs;
      return {
        id: r.id,
        by: r.name,
        mine: r.user_id === viewerId,
        alias: r.alias,
        context: r.context,
        closesAt: r.closes_at,
        closed,
        go,
        run,
        myVote: bs.find((b) => b.user_id === viewerId)?.value ?? 0,
        verdict: closed ? (go > run ? 'go' : run > go ? 'run' : 'split') : null,
        metCount: new Set(cs.filter((c) => c.met_them).map((c) => c.user_id)).size,
        comments: cs.map((c) => ({ id: c.id, name: c.name, metThem: !!c.met_them, body: c.body, createdAt: c.created_at, mine: c.user_id === viewerId })),
        createdAt: r.created_at,
      };
    });
  }

  vet(id: number, viewerId: number) {
    const v = this.vets(viewerId, { ids: [id] })[0];
    if (!v) throw new HttpError(404, 'Not found');
    return v;
  }

  // ======================================================== Debriefs

  addDebrief(userId: number, b: { alias?: unknown; rosterId?: unknown; rating?: unknown; greenFlags?: unknown; redFlags?: unknown; verdict?: unknown }) {
    const roster = this.ownRoster(optId(b.rosterId), userId);
    const rating = Number(b.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 10) throw new HttpError(400, 'Rating is 1–10');
    const verdict = String(b.verdict ?? 'tbd');
    if (!VERDICTS.includes(verdict as (typeof VERDICTS)[number])) throw new HttpError(400, 'Verdict is again, never or tbd');
    const alias = roster?.alias ?? clean(b.alias, 'alias', 40);
    const id = Number(
      this.db
        .prepare('INSERT INTO dating_debriefs (user_id, roster_id, alias, rating, green_flags, red_flags, verdict) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(userId, roster?.id ?? null, alias, rating, clean(b.greenFlags, 'greenFlags', 300, false) || null, clean(b.redFlags, 'redFlags', 300, false) || null, verdict).lastInsertRowid,
    );
    // A debrief moves the roster along: "never" benches them for good.
    if (roster && verdict === 'never') this.db.prepare(`UPDATE dating_roster SET status = 'over', updated_at = ? WHERE id = ?`).run(now(), roster.id);
    this.ctx.svc.notifyMembers(`📝 ${this.nameOf(userId)} posted a date debrief: “${alias}”, ${rating}/10.`, '/dating', userId);
    this.live();
    return { id };
  }

  deleteDebrief(id: number, userId: number, isAdmin: boolean) {
    const row = this.db.prepare('SELECT user_id FROM dating_debriefs WHERE id = ?').get(id) as { user_id: number } | undefined;
    if (!row) throw new HttpError(404, 'Not found');
    if (row.user_id !== userId && !isAdmin) throw new HttpError(403, 'Not yours');
    tx(this.db, () => {
      this.db.prepare(`DELETE FROM reactions WHERE target_type = 'debrief' AND target_id = ?`).run(id);
      this.db.prepare('DELETE FROM dating_debriefs WHERE id = ?').run(id);
    });
    this.live();
    return { ok: true };
  }

  debriefs(viewerId: number, p: Page = {}) {
    const rows = this.db
      .prepare(
        `SELECT d.*, ${NAME} AS name FROM dating_debriefs d JOIN users u ON u.id = d.user_id ${p.before ? 'WHERE d.created_at < ?' : ''} ORDER BY d.created_at DESC LIMIT ?`,
      )
      .all(...(p.before ? [p.before] : []), lim(p)) as { id: number; user_id: number; name: string; alias: string; rating: number; green_flags: string | null; red_flags: string | null; verdict: string; created_at: string }[];
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const reacts = this.db
      .prepare(`SELECT target_id, emoji, COUNT(*) AS n, MAX(user_id = ?) AS mine FROM reactions WHERE target_type = 'debrief' AND target_id IN (${marks(ids.length)}) GROUP BY target_id, emoji`)
      .all(viewerId, ...ids) as { target_id: number; emoji: string; n: number; mine: number }[];
    return rows.map((r) => ({
      id: r.id,
      by: r.name,
      mine: r.user_id === viewerId,
      alias: r.alias,
      rating: r.rating,
      greenFlags: r.green_flags,
      redFlags: r.red_flags,
      verdict: r.verdict,
      reactions: reacts.filter((x) => x.target_id === r.id).map((x) => ({ emoji: x.emoji, count: x.n, mine: !!x.mine })),
      createdAt: r.created_at,
    }));
  }

  /** Dating content is sensitive: whatever the removal policy, it goes. */
  onMemberRemoved(userId: number) {
    const vets = this.db.prepare('SELECT id FROM dating_vets WHERE user_id = ?').all(userId) as { id: number }[];
    for (const v of vets) this.db.prepare(`DELETE FROM ballots WHERE subject_type = 'date_vet' AND subject_id = ?`).run(v.id);
    const debriefs = this.db.prepare('SELECT id FROM dating_debriefs WHERE user_id = ?').all(userId) as { id: number }[];
    for (const d of debriefs) this.db.prepare(`DELETE FROM reactions WHERE target_type = 'debrief' AND target_id = ?`).run(d.id);
    this.db.prepare('DELETE FROM dating_vets WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM dating_debriefs WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM dating_roster WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM dating_vet_comments WHERE user_id = ?').run(userId);
  }
}
