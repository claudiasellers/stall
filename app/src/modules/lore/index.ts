// Lore module (phase 4): Group Court, Hot Takes, The Canon, Superlatives, the 86'd List,
// Prophecies and On This Day. Votes live in core `ballots` (subject_type 'court', 'hot_take',
// 'prophecy'); superlatives need a nominee per vote, so they get their own small table.
// Every verdict, winner and reveal is derived at read time; tick only sends pushes.
import express from 'express';
import { type Db, tx, now } from '../../db.ts';
import { HttpError } from '../../service.ts';
import { zonedParts, zonedToUtc } from '../../time.ts';
import type { ModuleCtx, StallModule, RemovalPolicy } from '../types.ts';
import { reactionsFor, deleteReactionsFor } from '../posts/reactions.ts';

type Viewer = { id: number; username: string; is_admin: number };

export const migrations = [
  {
    id: 'lore-001',
    sql: `
  CREATE TABLE canon_entries (
    id INTEGER PRIMARY KEY,
    term TEXT NOT NULL,
    origin TEXT NOT NULL,
    event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
    author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    canon_since TEXT NOT NULL,               -- YYYY-MM-DD, house calendar
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX canon_term ON canon_entries(term COLLATE NOCASE);
  CREATE INDEX canon_event ON canon_entries(event_id) WHERE event_id IS NOT NULL;
  CREATE INDEX canon_author ON canon_entries(author_id);
  CREATE INDEX canon_created ON canon_entries(created_at);

  CREATE TABLE eighty_sixed (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('place','person')),
    name TEXT NOT NULL,
    reason TEXT NOT NULL,
    -- for places: which member is banned there (NULL = the whole group)
    member_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    since TEXT NOT NULL,                     -- YYYY-MM-DD
    created_at TEXT NOT NULL
  );
  CREATE INDEX eighty_sixed_kind ON eighty_sixed(kind, created_at DESC);
  CREATE INDEX eighty_sixed_member ON eighty_sixed(member_id) WHERE member_id IS NOT NULL;
  CREATE INDEX eighty_sixed_author ON eighty_sixed(author_id);

  CREATE TABLE prophecies (
    id INTEGER PRIMARY KEY,
    author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    reveal_at TEXT NOT NULL,
    -- NULL until the group calls it after reveal_at: 1 came true, 0 did not
    outcome INTEGER CHECK (outcome IN (0, 1)),
    decided_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX prophecies_reveal ON prophecies(reveal_at);
  CREATE INDEX prophecies_author ON prophecies(author_id);
  CREATE INDEX prophecies_created ON prophecies(created_at);

  CREATE TABLE hot_takes (
    id INTEGER PRIMARY KEY,
    author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX hot_takes_created ON hot_takes(created_at DESC);
  CREATE INDEX hot_takes_author ON hot_takes(author_id);

  CREATE TABLE court_cases (
    id INTEGER PRIMARY KEY,
    plaintiff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    defendant_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
    charge TEXT NOT NULL,
    sentence TEXT NOT NULL,
    rebuttal TEXT,
    rebuttal_at TEXT,
    closes_at TEXT NOT NULL,
    dismissed_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX court_closes ON court_cases(closes_at);
  CREATE INDEX court_defendant ON court_cases(defendant_id);
  CREATE INDEX court_plaintiff ON court_cases(plaintiff_id);
  CREATE INDEX court_event ON court_cases(event_id) WHERE event_id IS NOT NULL;
  CREATE INDEX court_created ON court_cases(created_at DESC);

  CREATE TABLE superlative_votes (
    month TEXT NOT NULL,                     -- YYYY-MM, house calendar
    category TEXT NOT NULL,
    voter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nominee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (month, category, voter_id)
  );
  CREATE INDEX superlative_votes_nominee ON superlative_votes(nominee_id);
  CREATE INDEX superlative_votes_voter ON superlative_votes(voter_id);
  CREATE INDEX superlative_votes_month ON superlative_votes(month, category);
  `,
  },
];

export const SENTENCES = [
  'Buy a round',
  'Plan the next dinner',
  'Wear something the group picks',
  '48 hours of silence in the chat',
  'Host the next pregame',
  'Public apology in the group chat',
];

export const SUPERLATIVES = [
  { key: 'mvp', label: '🏆 MVP' },
  { key: 'liability', label: '🧨 Liability' },
  { key: 'disappearing_act', label: '👻 Disappearing Act' },
  { key: 'main_character', label: '🎬 Main Character' },
  { key: 'text_their_ex', label: '📱 Most Likely to Text Their Ex' },
  { key: 'best_recovery', label: '🧃 Best Recovery' },
  { key: 'brunch_hero', label: '🥞 Brunch Hero' },
] as const;

const COURT_HOURS = 24;
const nameSql = (a: string) => `COALESCE(NULLIF(${a}.display_name, ''), ${a}.username)`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function text(v: unknown, max: number, name: string, required = true): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw new HttpError(400, `${name} is required`);
  if (s.length > max) throw new HttpError(400, `${name} is too long (max ${max})`);
  return s;
}
function pid(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Bad id');
  return n;
}

export class LoreService {
  ctx: ModuleCtx;
  db: Db;
  constructor(ctx: ModuleCtx) {
    this.ctx = ctx;
    this.db = ctx.db;
  }
  get tz() {
    return this.ctx.cfg.houseTz || 'America/New_York';
  }
  today(): string {
    const p = zonedParts(Date.parse(now()), this.tz);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  }
  month(): string {
    return this.today().slice(0, 7);
  }
  monthRange(key: string): [string, string] {
    const [y, m] = key.split('-').map(Number);
    return [new Date(zonedToUtc(y, m, 1, 0, 0, this.tz)).toISOString(), new Date(zonedToUtc(y, m + 1, 1, 0, 0, this.tz)).toISOString()];
  }
  memberCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users WHERE removed_at IS NULL').get() as { n: number }).n;
  }
  isMember(id: number) {
    return !!this.db.prepare('SELECT 1 FROM users WHERE id = ? AND removed_at IS NULL').get(id);
  }
  name(id: number) {
    return (this.db.prepare(`SELECT ${nameSql('u')} AS n FROM users u WHERE u.id = ?`).get(id) as { n: string } | undefined)?.n ?? 'Someone';
  }
  eventOrNull(v: unknown): number | null {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isInteger(n) && this.db.prepare('SELECT 1 FROM events WHERE id = ?').get(n) ? n : null;
  }
  changed() {
    queueMicrotask(() => this.ctx.bus.emit('live', { topic: 'lore' }));
  }

  /** Ballot tallies for many subjects in one query. */
  tallies(type: string, ids: number[], viewerId: number) {
    const out = new Map<number, { yes: number; no: number; mine: number }>();
    if (!ids.length) return out;
    const rows = this.db
      .prepare(
        `SELECT subject_id, SUM(value = 1) AS yes, SUM(value = -1) AS no, MAX(CASE WHEN user_id = ? THEN value END) AS mine
         FROM ballots WHERE subject_type = ? AND subject_id IN (${ids.map(() => '?').join(',')}) GROUP BY subject_id`,
      )
      .all(viewerId, type, ...ids) as { subject_id: number; yes: number; no: number; mine: number | null }[];
    for (const r of rows) out.set(r.subject_id, { yes: r.yes, no: r.no, mine: r.mine ?? 0 });
    return out;
  }
  castBallot(type: string, id: number, userId: number, value: number) {
    if (value === 0) this.db.prepare('DELETE FROM ballots WHERE subject_type = ? AND subject_id = ? AND user_id = ?').run(type, id, userId);
    else if (value === 1 || value === -1)
      this.db
        .prepare(
          `INSERT INTO ballots (subject_type, subject_id, user_id, value) VALUES (?, ?, ?, ?)
           ON CONFLICT (subject_type, subject_id, user_id) DO UPDATE SET value = excluded.value`,
        )
        .run(type, id, userId, value);
    else throw new HttpError(400, 'Bad vote');
  }
  dropBallots(type: string, ids: number[]) {
    if (ids.length) this.db.prepare(`DELETE FROM ballots WHERE subject_type = ? AND subject_id IN (${ids.map(() => '?').join(',')})`).run(type, ...ids);
  }

  // ---------------------------------------------------------------- Group Court
  /** Verdict rule: at close, guilty needs a majority of votes cast and at least a quorum of guilty votes. */
  quorum() {
    return Math.max(2, Math.ceil(this.memberCount() * 0.3));
  }
  verdict(c: { closes_at: string; dismissed_at: string | null }, t: { yes: number; no: number }) {
    if (c.dismissed_at) return 'dismissed';
    if (now() < c.closes_at) return 'open';
    return t.yes > t.no && t.yes >= this.quorum() ? 'guilty' : 'not_guilty';
  }
  fileCase(v: Viewer, b: Record<string, unknown>) {
    const defendant = pid(b.defendantId);
    if (!this.isMember(defendant)) throw new HttpError(400, 'Pick a defendant from the group');
    if (defendant === v.id) throw new HttpError(400, 'You can’t sue yourself. Confess in The Morning After.');
    const charge = text(b.charge, 400, 'The charge');
    const sentence = SENTENCES.includes(String(b.sentence)) ? String(b.sentence) : text(b.sentence, 120, 'Sentence');
    const t = now();
    const closes = new Date(Date.parse(t) + COURT_HOURS * 3600_000).toISOString();
    const id = tx(this.db, () => {
      const r = this.db
        .prepare('INSERT INTO court_cases (plaintiff_id, defendant_id, event_id, charge, sentence, closes_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(v.id, defendant, this.eventOrNull(b.eventId), charge, sentence, closes, t);
      const cid = Number(r.lastInsertRowid);
      this.ctx.svc.notify(defendant, null, `⚖️ ${this.name(v.id)} filed a case against you. You get one rebuttal.`, `/lore?tab=court&case=${cid}`);
      this.ctx.svc.notifyMembers(`⚖️ Court is in session: ${this.name(v.id)} v. ${this.name(defendant)}. Vote within ${COURT_HOURS}h.`, `/lore?tab=court&case=${cid}`, v.id);
      return cid;
    });
    this.changed();
    return id;
  }
  getCase(id: number) {
    const c = this.db.prepare('SELECT * FROM court_cases WHERE id = ?').get(id) as CaseRow | undefined;
    if (!c) throw new HttpError(404, 'Case not found');
    return c;
  }
  rebut(v: Viewer, id: number, body: unknown) {
    const c = this.getCase(id);
    if (c.defendant_id !== v.id) throw new HttpError(403, 'Only the defendant can rebut');
    if (c.rebuttal) throw new HttpError(409, 'You already had your one rebuttal');
    if (now() >= c.closes_at || c.dismissed_at) throw new HttpError(409, 'Court is adjourned');
    this.db.prepare('UPDATE court_cases SET rebuttal = ?, rebuttal_at = ? WHERE id = ?').run(text(body, 400, 'Rebuttal'), now(), id);
    this.changed();
  }
  voteCase(v: Viewer, id: number, value: number) {
    const c = this.getCase(id);
    if (now() >= c.closes_at || c.dismissed_at) throw new HttpError(409, 'Voting is closed');
    if (v.id === c.defendant_id || v.id === c.plaintiff_id) throw new HttpError(400, 'Parties to the case don’t vote');
    this.castBallot('court', id, v.id, value);
    this.changed();
  }
  dismiss(v: Viewer, id: number) {
    const c = this.getCase(id);
    if (c.plaintiff_id !== v.id && !v.is_admin) throw new HttpError(403, 'Only the plaintiff or an admin can drop a case');
    if (now() >= c.closes_at) throw new HttpError(409, 'The verdict is in');
    this.db.prepare('UPDATE court_cases SET dismissed_at = ? WHERE id = ?').run(now(), id);
    this.changed();
  }
  cases(v: Viewer, before?: string, defendantId?: number) {
    const where = ['1=1'];
    const p: (string | number)[] = [];
    if (before) { where.push('c.created_at < ?'); p.push(before); }
    if (defendantId) { where.push('c.defendant_id = ?'); p.push(defendantId); }
    const rows = this.db
      .prepare(
        `SELECT c.*, ${nameSql('pl')} AS plaintiff_name, pl.emoji AS plaintiff_emoji, ${nameSql('d')} AS defendant_name, d.emoji AS defendant_emoji, e.title AS event_title
         FROM court_cases c JOIN users pl ON pl.id = c.plaintiff_id JOIN users d ON d.id = c.defendant_id LEFT JOIN events e ON e.id = c.event_id
         WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC LIMIT 30`,
      )
      .all(...p) as (CaseRow & { plaintiff_name: string; plaintiff_emoji: string | null; defendant_name: string; defendant_emoji: string | null; event_title: string | null })[];
    const t = this.tallies('court', rows.map((r) => r.id), v.id);
    return rows.map((c) => {
      const tally = t.get(c.id) ?? { yes: 0, no: 0, mine: 0 };
      const status = this.verdict(c, tally);
      return {
        id: c.id,
        plaintiff: { id: c.plaintiff_id, name: c.plaintiff_name, emoji: c.plaintiff_emoji },
        defendant: { id: c.defendant_id, name: c.defendant_name, emoji: c.defendant_emoji },
        event: c.event_id ? { id: c.event_id, title: c.event_title } : null,
        charge: c.charge, sentence: c.sentence, rebuttal: c.rebuttal,
        closesAt: c.closes_at, createdAt: c.created_at, status,
        votes: { guilty: tally.yes, notGuilty: tally.no, mine: tally.mine, quorum: this.quorum() },
        can: {
          vote: status === 'open' && v.id !== c.defendant_id && v.id !== c.plaintiff_id,
          rebut: status === 'open' && v.id === c.defendant_id && !c.rebuttal,
          dismiss: status === 'open' && (v.id === c.plaintiff_id || !!v.is_admin),
        },
      };
    });
  }
  /** Permanent record: guilty verdicts per member (for profiles and Wrapped). */
  record(userId: number) {
    const rows = this.db.prepare('SELECT * FROM court_cases WHERE defendant_id = ? AND dismissed_at IS NULL AND closes_at <= ?').all(userId, now()) as CaseRow[];
    const t = this.tallies('court', rows.map((r) => r.id), -1);
    const guilty = rows.filter((r) => this.verdict(r, t.get(r.id) ?? { yes: 0, no: 0 }) === 'guilty');
    return { cases: rows.length, guilty: guilty.length, sentences: guilty.map((g) => ({ id: g.id, charge: g.charge, sentence: g.sentence, at: g.closes_at })) };
  }

  // ---------------------------------------------------------------- Hot Takes
  postTake(v: Viewer, body: unknown) {
    const r = this.db.prepare('INSERT INTO hot_takes (author_id, body, created_at) VALUES (?, ?, ?)').run(v.id, text(body, 280, 'Your take'), now());
    this.changed();
    return Number(r.lastInsertRowid);
  }
  takes(v: Viewer, before?: string) {
    const rows = this.db
      .prepare(
        `SELECT h.*, ${nameSql('u')} AS author_name, u.emoji AS author_emoji FROM hot_takes h JOIN users u ON u.id = h.author_id
         ${before ? 'WHERE h.created_at < ?' : ''} ORDER BY h.created_at DESC LIMIT 30`,
      )
      .all(...(before ? [before] : [])) as { id: number; author_id: number; body: string; created_at: string; author_name: string; author_emoji: string | null }[];
    const t = this.tallies('hot_take', rows.map((r) => r.id), v.id);
    return rows.map((r) => {
      const x = t.get(r.id) ?? { yes: 0, no: 0, mine: 0 };
      return { id: r.id, body: r.body, createdAt: r.created_at, author: { id: r.author_id, name: r.author_name, emoji: r.author_emoji }, mine: r.author_id === v.id, votes: { agree: x.yes, disagree: x.no, mine: x.mine }, can: { delete: r.author_id === v.id || !!v.is_admin } };
    });
  }
  voteTake(v: Viewer, id: number, value: number) {
    if (!this.db.prepare('SELECT 1 FROM hot_takes WHERE id = ?').get(id)) throw new HttpError(404, 'Take not found');
    this.castBallot('hot_take', id, v.id, value);
    this.changed();
  }
  deleteTake(v: Viewer, id: number) {
    const r = this.db.prepare('SELECT author_id FROM hot_takes WHERE id = ?').get(id) as { author_id: number } | undefined;
    if (!r) throw new HttpError(404, 'Take not found');
    if (r.author_id !== v.id && !v.is_admin) throw new HttpError(403, 'Not your take');
    tx(this.db, () => {
      this.dropBallots('hot_take', [id]);
      this.db.prepare('DELETE FROM hot_takes WHERE id = ?').run(id);
    });
    this.changed();
  }
  /** Worst Take of the Month: most disagreements (net), min 3 disagree votes. */
  worstTake(month: string) {
    const [from, to] = this.monthRange(month);
    return this.db
      .prepare(
        `SELECT h.id, h.body, ${nameSql('u')} AS author_name, SUM(b.value = -1) AS disagree, SUM(b.value = 1) AS agree
         FROM hot_takes h JOIN users u ON u.id = h.author_id JOIN ballots b ON b.subject_type = 'hot_take' AND b.subject_id = h.id
         WHERE h.created_at >= ? AND h.created_at < ? GROUP BY h.id HAVING disagree >= 3
         ORDER BY disagree - agree DESC, disagree DESC LIMIT 1`,
      )
      .get(from, to) as { id: number; body: string; author_name: string; disagree: number; agree: number } | undefined ?? null;
  }

  // ---------------------------------------------------------------- The Canon
  addCanon(v: Viewer, b: Record<string, unknown>) {
    const term = text(b.term, 80, 'The term');
    const origin = text(b.origin, 1000, 'The origin story');
    const since = typeof b.canonSince === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.canonSince) ? b.canonSince : this.today();
    if (this.db.prepare('SELECT 1 FROM canon_entries WHERE term = ? COLLATE NOCASE').get(term)) throw new HttpError(409, 'That’s already canon');
    const r = this.db
      .prepare('INSERT INTO canon_entries (term, origin, event_id, author_id, canon_since, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(term, origin, this.eventOrNull(b.eventId), v.id, since, now());
    this.changed();
    return Number(r.lastInsertRowid);
  }
  canon(v: Viewer, q?: string) {
    const rows = this.db
      .prepare(
        `SELECT c.*, ${nameSql('u')} AS author_name, e.title AS event_title FROM canon_entries c JOIN users u ON u.id = c.author_id
         LEFT JOIN events e ON e.id = c.event_id ${q ? 'WHERE c.term LIKE ? OR c.origin LIKE ?' : ''} ORDER BY c.term COLLATE NOCASE LIMIT 500`,
      )
      .all(...(q ? [`%${q}%`, `%${q}%`] : [])) as { id: number; term: string; origin: string; event_id: number | null; event_title: string | null; author_id: number; author_name: string; canon_since: string; created_at: string }[];
    const rx = reactionsFor(this.db, 'canon', rows.map((r) => r.id), v.id);
    return rows.map((r) => ({
      id: r.id, term: r.term, origin: r.origin, canonSince: r.canon_since, createdAt: r.created_at,
      event: r.event_id ? { id: r.event_id, title: r.event_title } : null,
      author: { id: r.author_id, name: r.author_name }, reactions: rx.get(r.id) ?? [],
      can: { delete: r.author_id === v.id || !!v.is_admin },
    }));
  }
  deleteCanon(v: Viewer, id: number) {
    const r = this.db.prepare('SELECT author_id FROM canon_entries WHERE id = ?').get(id) as { author_id: number } | undefined;
    if (!r) throw new HttpError(404, 'Not in the canon');
    if (r.author_id !== v.id && !v.is_admin) throw new HttpError(403, 'Not yours');
    tx(this.db, () => {
      deleteReactionsFor(this.db, 'canon', [id]);
      this.db.prepare('DELETE FROM canon_entries WHERE id = ?').run(id);
    });
    this.changed();
  }
  /** Lore 101: four multiple-choice questions built from the canon (term → origin). */
  quiz() {
    const rows = this.db.prepare('SELECT id, term, origin FROM canon_entries ORDER BY RANDOM() LIMIT 16').all() as { id: number; term: string; origin: string }[];
    if (rows.length < 4) return [];
    return rows.slice(0, Math.min(4, Math.floor(rows.length / 1))).map((r) => {
      const wrong = rows.filter((x) => x.id !== r.id).sort(() => Math.random() - 0.5).slice(0, 3);
      const options = [r, ...wrong].sort(() => Math.random() - 0.5).map((x) => ({ id: x.id, origin: clip(x.origin, 160) }));
      return { term: r.term, options, answer: r.id };
    });
  }

  // ---------------------------------------------------------------- 86'd List
  add86(v: Viewer, b: Record<string, unknown>) {
    const kind = b.kind === 'person' ? 'person' : 'place';
    const memberId = kind === 'place' && b.memberId ? pid(b.memberId) : null;
    if (memberId && !this.isMember(memberId)) throw new HttpError(400, 'Pick someone from the group');
    const since = typeof b.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.since) ? b.since : this.today();
    const r = this.db
      .prepare('INSERT INTO eighty_sixed (kind, name, reason, member_id, author_id, since, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(kind, text(b.name, 80, 'Name'), text(b.reason, 400, 'Reason'), memberId, v.id, since, now());
    this.changed();
    return Number(r.lastInsertRowid);
  }
  list86(v: Viewer) {
    return (
      this.db
        .prepare(
          `SELECT x.*, ${nameSql('m')} AS member_name, ${nameSql('a')} AS author_name FROM eighty_sixed x
           JOIN users a ON a.id = x.author_id LEFT JOIN users m ON m.id = x.member_id ORDER BY x.since DESC, x.id DESC LIMIT 500`,
        )
        .all() as { id: number; kind: string; name: string; reason: string; member_id: number | null; member_name: string | null; author_id: number; author_name: string; since: string }[]
    ).map((r) => ({
      id: r.id, kind: r.kind, name: r.name, reason: r.reason, since: r.since,
      member: r.member_id ? { id: r.member_id, name: r.member_name } : null,
      author: { id: r.author_id, name: r.author_name },
      can: { delete: r.author_id === v.id || !!v.is_admin },
    }));
  }
  delete86(v: Viewer, id: number) {
    const r = this.db.prepare('SELECT author_id FROM eighty_sixed WHERE id = ?').get(id) as { author_id: number } | undefined;
    if (!r) throw new HttpError(404, 'Not on the list');
    if (r.author_id !== v.id && !v.is_admin) throw new HttpError(403, 'Not yours to pardon');
    this.db.prepare('DELETE FROM eighty_sixed WHERE id = ?').run(id);
    this.changed();
  }

  // ---------------------------------------------------------------- Prophecies
  prophesy(v: Viewer, b: Record<string, unknown>) {
    const body = text(b.body, 400, 'The prophecy');
    const at = Date.parse(String(b.revealAt ?? ''));
    if (!Number.isFinite(at)) throw new HttpError(400, 'Pick a reveal date');
    if (at <= Date.parse(now()) + 3600_000) throw new HttpError(400, 'The reveal has to be at least an hour away');
    if (at > Date.parse(now()) + 5 * 365 * 86400_000) throw new HttpError(400, 'Five years out, max');
    const r = this.db.prepare('INSERT INTO prophecies (author_id, body, reveal_at, created_at) VALUES (?, ?, ?, ?)').run(v.id, body, new Date(at).toISOString(), now());
    this.ctx.svc.notifyMembers(`🔮 ${this.name(v.id)} sealed a prophecy. It opens ${new Date(at).toLocaleDateString('en-US', { timeZone: this.tz, month: 'short', day: 'numeric', year: 'numeric' })}.`, '/lore?tab=prophecies', v.id);
    this.changed();
    return Number(r.lastInsertRowid);
  }
  /** After reveal, the group calls it: came true (+1) or didn't (-1). Decided once a quorum agrees. */
  voteProphecy(v: Viewer, id: number, value: number) {
    const p = this.db.prepare('SELECT * FROM prophecies WHERE id = ?').get(id) as ProphecyRow | undefined;
    if (!p) throw new HttpError(404, 'No such prophecy');
    if (now() < p.reveal_at) throw new HttpError(409, 'Still sealed');
    if (p.outcome !== null) throw new HttpError(409, 'Already called');
    tx(this.db, () => {
      this.castBallot('prophecy', id, v.id, value);
      const t = this.tallies('prophecy', [id], v.id).get(id) ?? { yes: 0, no: 0, mine: 0 };
      const q = this.quorum();
      const outcome = t.yes >= q && t.yes > t.no ? 1 : t.no >= q && t.no > t.yes ? 0 : null;
      if (outcome !== null) {
        this.db.prepare('UPDATE prophecies SET outcome = ?, decided_at = ? WHERE id = ?').run(outcome, now(), id);
        this.ctx.svc.notifyMembers(outcome ? `🔮 It came true. ${this.name(p.author_id)} called it.` : `🔮 ${this.name(p.author_id)}’s prophecy did not come true.`, '/lore?tab=prophecies');
      }
    });
    this.changed();
  }
  prophecies(v: Viewer) {
    const rows = this.db
      .prepare(`SELECT p.*, ${nameSql('u')} AS author_name, u.emoji AS author_emoji FROM prophecies p JOIN users u ON u.id = p.author_id ORDER BY p.reveal_at DESC LIMIT 200`)
      .all() as (ProphecyRow & { author_name: string; author_emoji: string | null })[];
    const t = this.tallies('prophecy', rows.map((r) => r.id), v.id);
    const n = now();
    return rows.map((r) => {
      const sealed = n < r.reveal_at;
      const x = t.get(r.id) ?? { yes: 0, no: 0, mine: 0 };
      return {
        id: r.id,
        // Sealed prophecies are hidden from everyone but the prophet.
        body: sealed && r.author_id !== v.id ? null : r.body,
        sealed, revealAt: r.reveal_at, createdAt: r.created_at,
        outcome: r.outcome === null ? null : !!r.outcome,
        author: { id: r.author_id, name: r.author_name, emoji: r.author_emoji }, mine: r.author_id === v.id,
        votes: sealed ? null : { trueVotes: x.yes, falseVotes: x.no, mine: x.mine, quorum: this.quorum() },
        can: { vote: !sealed && r.outcome === null, delete: (r.author_id === v.id && sealed) || !!v.is_admin },
      };
    });
  }
  deleteProphecy(v: Viewer, id: number) {
    const p = this.db.prepare('SELECT * FROM prophecies WHERE id = ?').get(id) as ProphecyRow | undefined;
    if (!p) throw new HttpError(404, 'No such prophecy');
    if (!v.is_admin && !(p.author_id === v.id && now() < p.reveal_at)) throw new HttpError(403, 'A revealed prophecy belongs to history');
    tx(this.db, () => {
      this.dropBallots('prophecy', [id]);
      this.db.prepare('DELETE FROM prophecies WHERE id = ?').run(id);
    });
    this.changed();
  }

  // ---------------------------------------------------------------- Superlatives
  voteSuperlative(v: Viewer, category: string, nomineeId: number) {
    if (!SUPERLATIVES.some((s) => s.key === category)) throw new HttpError(400, 'Unknown superlative');
    if (!this.isMember(nomineeId)) throw new HttpError(400, 'Pick someone from the group');
    this.db
      .prepare(
        `INSERT INTO superlative_votes (month, category, voter_id, nominee_id, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (month, category, voter_id) DO UPDATE SET nominee_id = excluded.nominee_id, created_at = excluded.created_at`,
      )
      .run(this.month(), category, v.id, nomineeId, now());
    this.changed();
  }
  superlatives(v: Viewer, month?: string) {
    const m = month && /^\d{4}-\d{2}$/.test(month) ? month : this.month();
    const rows = this.db
      .prepare(
        `SELECT s.category, s.nominee_id, ${nameSql('u')} AS name, u.emoji, COUNT(*) AS n, MAX(s.voter_id = ?) AS mine
         FROM superlative_votes s JOIN users u ON u.id = s.nominee_id WHERE s.month = ? GROUP BY s.category, s.nominee_id ORDER BY n DESC`,
      )
      .all(v.id, m) as { category: string; nominee_id: number; name: string; emoji: string | null; n: number; mine: number }[];
    return {
      month: m,
      open: m === this.month(),
      categories: SUPERLATIVES.map((s) => {
        const list = rows.filter((r) => r.category === s.key);
        return {
          ...s,
          leaders: list.slice(0, 3).map((r) => ({ id: r.nominee_id, name: r.name, emoji: r.emoji, votes: r.n })),
          myPick: list.find((r) => r.mine)?.nominee_id ?? null,
        };
      }),
    };
  }

  // ---------------------------------------------------------------- On This Day
  /** Quotes, canon born, prophecies and court verdicts from this calendar day in earlier years. */
  onThisDay() {
    const p = zonedParts(Date.parse(now()), this.tz);
    const out: { year: number; yearsAgo: number; quotes: unknown[]; canon: unknown[] }[] = [];
    for (let back = 1; back <= 10; back++) {
      const y = p.year - back;
      const from = new Date(zonedToUtc(y, p.month, p.day, 0, 0, this.tz)).toISOString();
      const to = new Date(zonedToUtc(y, p.month, p.day + 1, 0, 0, this.tz)).toISOString();
      // The night runs past midnight: include until 6am the next day.
      const toNight = new Date(Date.parse(to) + 6 * 3600_000).toISOString();
      const quotes = this.db
        .prepare(
          `SELECT p.id, p.body, COALESCE(${nameSql('s')}, p.subject_label) AS speaker FROM posts p LEFT JOIN users s ON s.id = p.subject_id
           WHERE p.kind = 'quote' AND p.created_at >= ? AND p.created_at < ? AND (p.expires_at IS NULL OR p.expires_at > ?) ORDER BY p.created_at LIMIT 10`,
        )
        .all(from, toNight, now());
      const canon = this.db.prepare('SELECT id, term FROM canon_entries WHERE canon_since = ?').all(`${y}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`);
      if (quotes.length || canon.length) out.push({ year: y, yearsAgo: back, quotes, canon });
    }
    return out;
  }

  // ---------------------------------------------------------------- tick
  tick() {
    const n = now();
    const claim = (key: string) => this.db.prepare('INSERT OR IGNORE INTO jobs_sent (key, sent_at) VALUES (?, ?)').run(key, n).changes > 0;
    // Verdicts: announce once each case closes.
    const closed = this.db.prepare('SELECT * FROM court_cases WHERE closes_at <= ? AND dismissed_at IS NULL AND closes_at > ?').all(n, new Date(Date.parse(n) - 7 * 86400_000).toISOString()) as CaseRow[];
    const t = this.tallies('court', closed.map((c) => c.id), -1);
    for (const c of closed) {
      if (!claim(`lore:verdict:${c.id}`)) continue;
      const v = this.verdict(c, t.get(c.id) ?? { yes: 0, no: 0 });
      const d = this.name(c.defendant_id);
      this.ctx.svc.notifyMembers(v === 'guilty' ? `⚖️ GUILTY. ${d}’s sentence: ${c.sentence}.` : `⚖️ Not guilty. ${d} walks.`, `/lore?tab=court&case=${c.id}`);
    }
    // Prophecy reveals.
    const opened = this.db.prepare('SELECT * FROM prophecies WHERE reveal_at <= ? AND reveal_at > ?').all(n, new Date(Date.parse(n) - 7 * 86400_000).toISOString()) as ProphecyRow[];
    for (const p of opened) {
      if (!claim(`lore:prophecy:${p.id}`)) continue;
      this.ctx.svc.notifyMembers(`🔮 A prophecy from ${this.name(p.author_id)} just unsealed. Did it come true?`, '/lore?tab=prophecies');
    }
    // On This Day, once a day at noon house time.
    const hp = zonedParts(Date.parse(n), this.tz);
    if (hp.hour >= 12) {
      const memories = this.onThisDay();
      if (memories.length && claim(`lore:otd:${this.today()}`)) {
        const m = memories[0];
        this.ctx.svc.notifyMembers(`📸 ${m.yearsAgo === 1 ? 'One year' : `${m.yearsAgo} years`} ago tonight… tap for the memories.`, '/lore?tab=otd');
      }
    }
  }
}

type CaseRow = { id: number; plaintiff_id: number; defendant_id: number; event_id: number | null; charge: string; sentence: string; rebuttal: string | null; closes_at: string; dismissed_at: string | null; created_at: string };
type ProphecyRow = { id: number; author_id: number; body: string; reveal_at: string; outcome: number | null; decided_at: string | null; created_at: string };

export function routes(ctx: ModuleCtx) {
  const s = new LoreService(ctx);
  const r = express.Router();
  const me = (req: express.Request) => req.user as Viewer;
  const before = (req: express.Request) => (typeof req.query.before === 'string' ? req.query.before : undefined);

  r.get('/lore/meta', (_req, res) => res.json({ sentences: SENTENCES, superlatives: SUPERLATIVES, courtHours: COURT_HOURS, quorum: s.quorum(), month: s.month() }));

  r.get('/lore/court', (req, res) => res.json({ cases: s.cases(me(req), before(req), req.query.defendant ? pid(req.query.defendant) : undefined) }));
  r.post('/lore/court', (req, res) => res.status(201).json({ id: s.fileCase(me(req), req.body ?? {}) }));
  r.post('/lore/court/:id/vote', (req, res) => { s.voteCase(me(req), pid(req.params.id), Number(req.body?.value)); res.json({ ok: true }); });
  r.post('/lore/court/:id/rebut', (req, res) => { s.rebut(me(req), pid(req.params.id), req.body?.body); res.json({ ok: true }); });
  r.post('/lore/court/:id/dismiss', (req, res) => { s.dismiss(me(req), pid(req.params.id)); res.json({ ok: true }); });
  r.get('/lore/record/:id', (req, res) => res.json(s.record(pid(req.params.id))));

  r.get('/lore/takes', (req, res) => res.json({ takes: s.takes(me(req), before(req)), worst: s.worstTake(s.month()) }));
  r.post('/lore/takes', (req, res) => res.status(201).json({ id: s.postTake(me(req), req.body?.body) }));
  r.post('/lore/takes/:id/vote', (req, res) => { s.voteTake(me(req), pid(req.params.id), Number(req.body?.value)); res.json({ ok: true }); });
  r.delete('/lore/takes/:id', (req, res) => { s.deleteTake(me(req), pid(req.params.id)); res.json({ ok: true }); });

  r.get('/lore/canon', (req, res) => res.json({ entries: s.canon(me(req), typeof req.query.q === 'string' ? req.query.q.slice(0, 60) : undefined) }));
  r.post('/lore/canon', (req, res) => res.status(201).json({ id: s.addCanon(me(req), req.body ?? {}) }));
  r.delete('/lore/canon/:id', (req, res) => { s.deleteCanon(me(req), pid(req.params.id)); res.json({ ok: true }); });
  r.get('/lore/quiz', (_req, res) => res.json({ questions: s.quiz() }));

  r.get('/lore/86', (req, res) => res.json({ entries: s.list86(me(req)) }));
  r.post('/lore/86', (req, res) => res.status(201).json({ id: s.add86(me(req), req.body ?? {}) }));
  r.delete('/lore/86/:id', (req, res) => { s.delete86(me(req), pid(req.params.id)); res.json({ ok: true }); });

  r.get('/lore/prophecies', (req, res) => res.json({ prophecies: s.prophecies(me(req)) }));
  r.post('/lore/prophecies', (req, res) => res.status(201).json({ id: s.prophesy(me(req), req.body ?? {}) }));
  r.post('/lore/prophecies/:id/vote', (req, res) => { s.voteProphecy(me(req), pid(req.params.id), Number(req.body?.value)); res.json({ ok: true }); });
  r.delete('/lore/prophecies/:id', (req, res) => { s.deleteProphecy(me(req), pid(req.params.id)); res.json({ ok: true }); });

  r.get('/lore/superlatives', (req, res) => res.json(s.superlatives(me(req), typeof req.query.month === 'string' ? req.query.month : undefined)));
  r.post('/lore/superlatives', (req, res) => { s.voteSuperlative(me(req), String(req.body?.category ?? ''), pid(req.body?.nomineeId)); res.json({ ok: true }); });

  r.get('/lore/on-this-day', (_req, res) => res.json({ memories: s.onThisDay() }));
  return r;
}

export function tick(ctx: ModuleCtx) {
  new LoreService(ctx).tick();
}

/** keep: nothing. anonymize/delete: their lore authorship goes (rows cascade on hard user delete only). */
export function onMemberRemoved(ctx: ModuleCtx, userId: number, policy: RemovalPolicy) {
  const db = ctx.db;
  db.prepare('DELETE FROM superlative_votes WHERE voter_id = ? OR nominee_id = ?').run(userId, userId);
  if (policy !== 'delete') return;
  const takes = (db.prepare('SELECT id FROM hot_takes WHERE author_id = ?').all(userId) as { id: number }[]).map((r) => r.id);
  const proph = (db.prepare('SELECT id FROM prophecies WHERE author_id = ?').all(userId) as { id: number }[]).map((r) => r.id);
  const cases = (db.prepare('SELECT id FROM court_cases WHERE plaintiff_id = ? OR defendant_id = ?').all(userId, userId) as { id: number }[]).map((r) => r.id);
  const canon = (db.prepare('SELECT id FROM canon_entries WHERE author_id = ?').all(userId) as { id: number }[]).map((r) => r.id);
  const drop = (type: string, ids: number[]) => ids.length && db.prepare(`DELETE FROM ballots WHERE subject_type = ? AND subject_id IN (${ids.map(() => '?').join(',')})`).run(type, ...ids);
  drop('hot_take', takes);
  drop('prophecy', proph);
  drop('court', cases);
  deleteReactionsFor(db, 'canon', canon);
  db.prepare('DELETE FROM hot_takes WHERE author_id = ?').run(userId);
  db.prepare('DELETE FROM prophecies WHERE author_id = ?').run(userId);
  db.prepare('DELETE FROM court_cases WHERE plaintiff_id = ? OR defendant_id = ?').run(userId, userId);
  db.prepare('DELETE FROM canon_entries WHERE author_id = ?').run(userId);
  db.prepare('DELETE FROM eighty_sixed WHERE author_id = ? OR member_id = ?').run(userId, userId);
  db.prepare("DELETE FROM ballots WHERE user_id = ? AND subject_type IN ('hot_take','prophecy','court')").run(userId);
}

export const module: StallModule = { name: 'lore', migrations, routes, tick, onMemberRemoved };
export default module;
