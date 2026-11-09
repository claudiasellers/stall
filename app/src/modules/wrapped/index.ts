// Stall Wrapped (yearly recap cards) and the Hall of Fame / Hall of Shame.
// Read-only over other modules' tables (events/rsvps, posts, photos/vetoes,
// night_checkins, cooked_reports, tab_expenses). It owns no tables. Each stat
// is computed by one query and degrades to null if a module isn't installed,
// so it merges in any order. Register it last in app/src/modules/index.ts.
//
// Privacy: anonymous regrets are counted for their author's own Wrapped only;
// group-facing numbers (halls, Liability of the Year) count a regret only if it
// was posted openly or later unmasked. No substances, no amounts in the halls.
import express from 'express';
import { HttpError } from '../../service.ts';
import { clock } from '../../clock.ts';
import { zonedParts, zonedToUtc } from '../../time.ts';
import type { ModuleCtx, StallModule } from '../types.ts';

type Db = ModuleCtx['db'];
const ATTENDING = `('in','afters','late','save_drink')`;
/** Authorship the group may see (anonymous posts and anonymized ex-members hide the author on every kind). */
const PUBLIC_AUTHOR = `(p.anonymous = 0 OR p.unmasked_at IS NOT NULL)`;
const PUBLIC_REGRET = PUBLIC_AUTHOR;
/** Read-time visibility for posts: self-destructed rows don't count before the purge runs. */
const VISIBLE = () => `(p.expires_at IS NULL OR p.expires_at > '${new Date(clock.now()).toISOString()}')`;

/** Run one stat query; a missing module (no such table/column) yields undefined. */
function one<T>(db: Db, sql: string, ...args: (string | number | null)[]): T | undefined {
  try {
    return db.prepare(sql).get(...args) as T | undefined;
  } catch (e) {
    if (/no such (table|column)/i.test(String((e as Error).message))) return undefined;
    throw e;
  }
}
function all<T>(db: Db, sql: string, ...args: (string | number | null)[]): T[] {
  try {
    return db.prepare(sql).all(...args) as T[];
  } catch (e) {
    if (/no such (table|column)/i.test(String((e as Error).message))) return [];
    throw e;
  }
}
const n = (r: { n: number | null } | undefined) => (r ? Number(r.n ?? 0) : null);

const NAME = `COALESCE(u.display_name, u.username)`;

function yearRange(year: number, tz: string): [string, string] {
  return [new Date(zonedToUtc(year, 1, 1, 0, 0, tz)).toISOString(), new Date(zonedToUtc(year + 1, 1, 1, 0, 0, tz)).toISOString()];
}

type Card = { id: string; kicker: string; big: string; line: string; tone: 'hot' | 'cool' | 'gold' | 'shame' | 'night' };

export function wrappedFor(ctx: ModuleCtx, userId: number, year: number) {
  const db = ctx.db;
  const tz = ctx.cfg.houseTz;
  const [from, to] = yearRange(year, tz);
  const nowIso = new Date(clock.now()).toISOString();
  const end = to < nowIso ? to : nowIso;
  const cards: Card[] = [];
  const push = (c: Card | null) => c && cards.push(c);

  // 1. Nights out: events you said you'd be at, plus nights you checked in somewhere.
  const nights = n(one(db,
    `SELECT COUNT(*) AS n FROM (
       SELECT e.id FROM rsvps r JOIN events e ON e.id = r.event_id
       WHERE r.user_id = ? AND r.status IN ${ATTENDING} AND e.starts_at >= ? AND e.starts_at < ? AND e.cancelled_at IS NULL
       UNION
       SELECT c.event_id FROM night_checkins c WHERE c.user_id = ? AND c.event_id IS NOT NULL AND c.created_at >= ? AND c.created_at < ?
     )`, userId, from, end, userId, from, end));
  const groupNights = n(one(db, `SELECT COUNT(*) AS n FROM events e WHERE e.starts_at >= ? AND e.starts_at < ? AND e.cancelled_at IS NULL`, from, end));
  if (nights !== null)
    push({ id: 'nights', kicker: `${year}, a year in the Stall`, big: String(nights), line: nights === 1 ? 'night out. Just the one. Respect.' : `nights out${groupNights ? ` out of ${groupNights} the group put on` : ''}.`, tone: 'hot' });

  // 2. Sesh Soulmate: the member you went out with most.
  const soul = one<{ name: string; n: number }>(db,
    `SELECT ${NAME} AS name, COUNT(*) AS n FROM rsvps a
     JOIN rsvps b ON b.event_id = a.event_id AND b.user_id <> a.user_id AND b.status IN ${ATTENDING}
     JOIN events e ON e.id = a.event_id JOIN users u ON u.id = b.user_id
     WHERE a.user_id = ? AND a.status IN ${ATTENDING} AND e.starts_at >= ? AND e.starts_at < ? AND u.removed_at IS NULL
     GROUP BY b.user_id ORDER BY n DESC LIMIT 1`, userId, from, end);
  if (soul?.n) push({ id: 'soulmate', kicker: 'Your Sesh Soulmate', big: soul.name, line: `${soul.n} nights side by side. Someone should tell their partner.`, tone: 'cool' });

  // 3. The bar you closed down most: your last check-in of each night.
  const closer = one<{ venue: string; n: number }>(db,
    `SELECT venue, COUNT(*) AS n FROM night_checkins c
     WHERE c.user_id = ? AND c.created_at >= ? AND c.created_at < ?
       AND c.id = (SELECT c2.id FROM night_checkins c2 WHERE c2.user_id = c.user_id
                   AND COALESCE(c2.event_id, -1) = COALESCE(c.event_id, -1) AND substr(c2.created_at, 1, 10) BETWEEN date(c.created_at, '-1 day') AND date(c.created_at, '+1 day')
                   ORDER BY c2.created_at DESC LIMIT 1)
     GROUP BY lower(venue) ORDER BY n DESC LIMIT 1`, userId, from, end);
  if (closer?.n) push({ id: 'closer', kicker: 'The bar you closed down most', big: closer.venue, line: `Last stop ${closer.n} time${closer.n === 1 ? '' : 's'}. They know your order.`, tone: 'night' });

  // 4. Quotes: most-reacted line said by you, and how often you were quoted.
  const quoted = n(one(db, `SELECT COUNT(*) AS n FROM posts p WHERE ${VISIBLE()} AND p.kind = 'quote' AND p.subject_id = ? AND p.created_at >= ? AND p.created_at < ?`, userId, from, end));
  const topQuote = one<{ body: string; n: number }>(db,
    `SELECT p.body, COUNT(r.user_id) AS n FROM posts p
     LEFT JOIN reactions r ON r.target_type = 'post' AND r.target_id = p.id
     WHERE ${VISIBLE()} AND p.kind = 'quote' AND p.subject_id = ? AND p.created_at >= ? AND p.created_at < ?
     GROUP BY p.id ORDER BY n DESC, p.id DESC LIMIT 1`, userId, from, end);
  if (topQuote) push({ id: 'quote', kicker: `Your most-quoted line (quoted ${quoted} time${quoted === 1 ? '' : 's'})`, big: `“${topQuote.body}”`, line: topQuote.n ? `${topQuote.n} reactions. You said that out loud.` : 'You said that out loud.', tone: 'gold' });
  else if (quoted === 0) push({ id: 'quote', kicker: 'Quote Wall', big: '0', line: 'times quoted. Say something unhinged next year.', tone: 'gold' });

  // 5. Cooked Meter average.
  const cooked = one<{ avg: number | null; n: number; peak: number | null }>(db,
    `SELECT AVG(level) AS avg, COUNT(*) AS n, MAX(level) AS peak FROM cooked_reports WHERE user_id = ? AND created_at >= ? AND created_at < ?`, userId, from, end);
  if (cooked?.n && cooked.avg != null)
    push({ id: 'cooked', kicker: 'Cooked Meter average', big: cooked.avg.toFixed(1), line: cooked.avg >= 8 ? 'Speaking fluent French, on average.' : cooked.avg >= 5 ? 'Solidly, reliably medium-rare.' : 'One glass of natural wine energy. Suspicious.', tone: 'hot' });

  // 6. Regrets (your own count includes anonymous ones; only you see this).
  const regrets = one<{ n: number; worst: number | null; forgiven: number }>(db,
    `SELECT COUNT(*) AS n, MAX(severity) AS worst, COALESCE(SUM(status = 'forgiven'), 0) AS forgiven FROM posts p
     WHERE ${VISIBLE()} AND p.kind = 'regret' AND p.author_id = ? AND p.created_at >= ? AND p.created_at < ?`, userId, from, end);
  const SEV = ['', '🫠', '😬', '💀', '🚨', '🪦'];
  if (regrets)
    push({ id: 'regrets', kicker: 'The Morning After', big: String(regrets.n), line: regrets.n ? `regret${regrets.n === 1 ? '' : 's'} confessed. Worst: ${SEV[regrets.worst ?? 0] || '🫠'}. ${regrets.forgiven} forgiven.` : 'regrets. Either a saint or a liar.', tone: 'shame' });

  // 7. Irish goodbyes.
  const goodbyes = n(one(db, `SELECT COUNT(*) AS n FROM posts p WHERE ${VISIBLE()} AND p.kind = 'irish_goodbye' AND p.subject_id = ? AND p.created_at >= ? AND p.created_at < ?`, userId, from, end));
  if (goodbyes !== null)
    push({ id: 'goodbyes', kicker: 'Irish Goodbyes', big: String(goodbyes), line: goodbyes ? `time${goodbyes === 1 ? '' : 's'} you vanished without a word.` : 'You said bye every time. Weird, but okay.', tone: 'night' });

  // 8. Photos shot and vetoed.
  const shot = n(one(db, `SELECT COUNT(*) AS n FROM photos WHERE uploader_id = ? AND status = 'ready' AND created_at >= ? AND created_at < ?`, userId, from, end));
  const vetoed = n(one(db, `SELECT COUNT(*) AS n FROM vetoes WHERE user_id = ? AND created_at >= ? AND created_at < ?`, userId, from, end));
  if (shot !== null)
    push({ id: 'photos', kicker: 'The disposable camera', big: String(shot), line: `photos shot. ${vetoed ? `${vetoed} photo${vetoed === 1 ? '' : 's'} of you killed on sight.` : 'You vetoed nothing. Brave.'}`, tone: 'cool' });

  // 9. Group: Liability of the Year (public regrets + Irish goodbyes + cooked 9+ nights).
  const liability = one<{ name: string; score: number; id: number }>(db,
    `SELECT u.id, ${NAME} AS name,
       (SELECT COUNT(*) FROM posts p WHERE ${VISIBLE()} AND p.kind = 'regret' AND p.author_id = u.id AND ${PUBLIC_REGRET} AND p.created_at >= ? AND p.created_at < ?)
     + (SELECT COUNT(*) FROM posts p WHERE ${VISIBLE()} AND p.kind = 'irish_goodbye' AND p.subject_id = u.id AND p.created_at >= ? AND p.created_at < ?) AS score
     FROM users u WHERE u.removed_at IS NULL ORDER BY score DESC, u.id LIMIT 1`, from, end, from, end);
  if (liability?.score)
    push({ id: 'liability', kicker: `${year} Liability of the Year`, big: liability.id === userId ? 'You.' : liability.name, line: liability.id === userId ? 'Congratulations, and also: are you okay?' : 'The group has spoken. Drinks are on them.', tone: 'shame' });

  // 10. Group: quote of the year.
  const qoty = one<{ body: string; who: string | null; n: number }>(db,
    `SELECT p.body, COALESCE(${NAME}, p.subject_label) AS who, COUNT(r.user_id) AS n FROM posts p
     LEFT JOIN users u ON u.id = p.subject_id
     JOIN reactions r ON r.target_type = 'post' AND r.target_id = p.id
     WHERE ${VISIBLE()} AND p.kind = 'quote' AND p.created_at >= ? AND p.created_at < ?
     GROUP BY p.id ORDER BY n DESC, p.id LIMIT 1`, from, end);
  if (qoty) push({ id: 'qoty', kicker: 'Quote of the Year', big: `“${qoty.body}”`, line: `${qoty.who ?? 'Someone'}, ${qoty.n} reactions.`, tone: 'gold' });

  const p = zonedParts(clock.now(), tz);
  return { year, preview: p.year === year && p.month < 12, cards };
}

type Entry = { userId: number; name: string; emoji: string | null; n: number };
type Hall = { id: string; title: string; unit: string; leaders: Entry[] };

/** All-time leaderboards, top 3 each. Group-facing, so only public facts. */
export function halls(ctx: ModuleCtx) {
  const db = ctx.db;
  const board = (id: string, title: string, unit: string, sql: string): Hall | null => {
    const rows = all<Entry>(db, `SELECT u.id AS userId, ${NAME} AS name, u.emoji AS emoji, x.n AS n FROM (${sql}) x
      JOIN users u ON u.id = x.uid WHERE u.removed_at IS NULL AND x.n > 0 ORDER BY x.n DESC, u.id LIMIT 3`);
    return rows.length ? { id, title, unit, leaders: rows.map((r) => ({ ...r, n: Math.round(Number(r.n) * 10) / 10 })) } : null;
  };
  const fame = [
    board('nights', 'Most nights out', 'nights', `SELECT r.user_id AS uid, COUNT(*) AS n FROM rsvps r JOIN events e ON e.id = r.event_id WHERE r.status IN ${ATTENDING} AND e.cancelled_at IS NULL GROUP BY r.user_id`),
    board('quoted', 'Most quoted', 'quotes', `SELECT subject_id AS uid, COUNT(*) AS n FROM posts p WHERE ${VISIBLE()} AND kind = 'quote' AND subject_id IS NOT NULL GROUP BY subject_id`),
    board('photog', 'House photographer', 'photos', `SELECT uploader_id AS uid, COUNT(*) AS n FROM photos WHERE status = 'ready' GROUP BY uploader_id`),
    board('captions', 'Caption champion', 'winning votes', `SELECT c.user_id AS uid, COUNT(*) AS n FROM photo_captions c JOIN reactions r ON r.target_type = 'caption' AND r.target_id = c.id AND r.user_id <> c.user_id GROUP BY c.user_id`),
    board('host', 'Host with the most', 'events', `SELECT host_id AS uid, COUNT(*) AS n FROM events WHERE cancelled_at IS NULL GROUP BY host_id`),
    board('generous', 'Covered the bottle', 'tabs picked up', `SELECT payer_id AS uid, COUNT(*) AS n FROM tab_expenses GROUP BY payer_id`),
    board('finder', 'Lost & Found hero', 'items returned', `SELECT resolved_by AS uid, COUNT(*) AS n FROM posts p WHERE ${VISIBLE()} AND kind = 'lost_item' AND status = 'found' AND resolved_by IS NOT NULL GROUP BY resolved_by`),
  ].filter(Boolean);
  const shame = [
    board('goodbyes', 'Disappearing Act', 'Irish goodbyes', `SELECT subject_id AS uid, COUNT(*) AS n FROM posts p WHERE ${VISIBLE()} AND kind = 'irish_goodbye' AND subject_id IS NOT NULL GROUP BY subject_id`),
    board('regrets', 'Most public regrets', 'regrets', `SELECT p.author_id AS uid, COUNT(*) AS n FROM posts p WHERE ${VISIBLE()} AND p.kind = 'regret' AND ${PUBLIC_REGRET} GROUP BY p.author_id`),
    board('lawyer', 'Needs a lawyer', '🚨+ regrets', `SELECT p.author_id AS uid, COUNT(*) AS n FROM posts p WHERE ${VISIBLE()} AND p.kind = 'regret' AND p.severity >= 4 AND ${PUBLIC_REGRET} GROUP BY p.author_id`),
    board('cooked', 'Most cooked (avg)', '/ 10', `SELECT user_id AS uid, AVG(level) AS n FROM cooked_reports GROUP BY user_id HAVING COUNT(*) >= 3`),
    board('lost', 'Loses everything', 'items lost', `SELECT p.author_id AS uid, COUNT(*) AS n FROM posts p WHERE ${VISIBLE()} AND p.kind = 'lost_item' AND ${PUBLIC_AUTHOR} GROUP BY p.author_id`),
    board('disputed', 'Denies everything', 'disputed quotes', `SELECT subject_id AS uid, COUNT(*) AS n FROM posts p WHERE ${VISIBLE()} AND kind = 'quote' AND stance = 'disputed' GROUP BY subject_id`),
    board('vetoes', 'Camera shy', 'photos vetoed', `SELECT user_id AS uid, COUNT(*) AS n FROM vetoes GROUP BY user_id`),
  ].filter(Boolean);
  return { fame, shame };
}

function routes(ctx: ModuleCtx) {
  const r = express.Router();
  r.get('/wrapped', (req, res) => {
    const nowYear = zonedParts(clock.now(), ctx.cfg.houseTz).year;
    const year = req.query.year === undefined ? nowYear : Number(req.query.year);
    if (!Number.isInteger(year) || year < 2020 || year > nowYear) throw new HttpError(400, 'Bad year');
    res.json(wrappedFor(ctx, req.user!.id, year));
  });
  r.get('/halls', (_req, res) => res.json(halls(ctx)));
  return r;
}

export const module: StallModule = { name: 'wrapped', migrations: [], routes };
