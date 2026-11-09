// Season module: trips (date poll, trip bible, room draft, shared kitty → the Tab,
// trip awards, per-day archive), football (watch-party allegiance, pick'em with a
// season leaderboard, Super Bowl squares, trash talk that locks picks at kickoff,
// bar tracker) and admin event templates. Routes under /api/v1/season.
import express, { type Request } from 'express';
import { randomInt } from 'node:crypto';
import { tx, now } from '../../db.ts';
import { HttpError } from '../../service.ts';
import type { ModuleCtx, StallModule } from '../types.ts';
import { SEASON_MIGRATIONS } from './schema.ts';

// Every name read goes through this, so the 'anonymize' removal policy holds everywhere.
const NAME = `CASE WHEN u.id IN (SELECT user_id FROM season_anonymized) THEN 'Former member' ELSE COALESCE(u.display_name, u.username) END`;
export const AWARDS = ['Best outfit', 'Worst decision', 'Most sleep', 'Most fun', 'MVP', 'Liability'];

const me = (req: Request) => {
  if (!req.user) throw new HttpError(401, 'Sign in first');
  return req.user;
};
const id = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Bad id');
  return n;
};
const txt = (v: unknown, name: string, max: number, min = 1) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min || s.length > max) throw new HttpError(400, `${name} must be ${min}–${max} characters`);
  return s;
};
const opt = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const day = (v: unknown, name: string) => {
  const s = String(v ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new HttpError(400, `${name} must be a date`);
  return s;
};
const iso = (v: unknown, name: string) => {
  const d = new Date(String(v ?? ''));
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `${name} must be a date and time`);
  return d.toISOString();
};
const shuffle = <T>(a: T[]) => {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
};

function routes(ctx: ModuleCtx) {
  const { db } = ctx;
  const r = express.Router();
  const name = (uid: number) => (db.prepare(`SELECT ${NAME} AS n FROM users u WHERE id = ?`).get(uid) as { n: string } | undefined)?.n ?? 'Someone';
  const tableExists = (t: string) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
  const feed = (kind: string, actor: number | null, eventId: number | null, body: string, subject?: [string, number]) => {
    db.prepare('INSERT INTO feed_items (kind, actor_id, event_id, subject_type, subject_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(kind, actor, eventId, subject?.[0] ?? null, subject?.[1] ?? null, body, now());
    queueMicrotask(() => ctx.bus.emit('board'));
  };
  const event = (eid: number) => {
    const e = db.prepare('SELECT id, title, kind, host_id, starts_at, ends_at, real_starts_at, expires_at FROM events WHERE id = ? AND parent_id IS NULL').get(eid) as
      | { id: number; title: string; kind: string; host_id: number; starts_at: string; ends_at: string | null; real_starts_at: string; expires_at: string | null }
      | undefined;
    if (!e || (e.expires_at && e.expires_at <= now())) throw new HttpError(404, 'Event not found');
    return e;
  };
  const crew = (eid: number) =>
    db.prepare(
      `SELECT r.user_id AS id, ${NAME} AS name, u.emoji FROM rsvps r JOIN users u ON u.id = r.user_id
       WHERE r.event_id = ? AND r.status != 'out' AND u.removed_at IS NULL ORDER BY r.updated_at`,
    ).all(eid) as { id: number; name: string; emoji: string | null }[];
  const hostOrAdmin = (e: { host_id: number }, u: { id: number; is_admin: number }) => {
    if (e.host_id !== u.id && !u.is_admin) throw new HttpError(403, 'Only the host can do that');
  };

  // ------------------------------------------------------------ templates
  r.get('/season/templates', (_req, res) => {
    const rows = db.prepare('SELECT * FROM event_templates ORDER BY id').all() as Record<string, unknown>[];
    res.json({ templates: rows.map((t) => ({ ...t, stages: JSON.parse(String(t.stages)), bring: JSON.parse(String(t.bring)) })) });
  });
  r.post('/season/templates', (req, res) => {
    const u = me(req);
    if (!u.is_admin) throw new HttpError(403, 'Admins only');
    const b = req.body ?? {};
    const list = (v: unknown) => JSON.stringify(Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x: string) => x.trim().slice(0, 80)).slice(0, 30) : []);
    const hour = Number.isInteger(b.startHour) && b.startHour >= 0 && b.startHour <= 23 ? b.startHour : 21;
    const wd = Number.isInteger(b.weekday) && b.weekday >= 0 && b.weekday <= 6 ? b.weekday : null;
    const res2 = db.prepare(
      `INSERT INTO event_templates (name, kind, title, vibe, details, stages, bring, weekday, start_hour, recurrence, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(txt(b.name, 'Name', 60), opt(b.kind, 20) ?? 'party', txt(b.title, 'Title', 120), opt(b.vibe, 200), opt(b.details, 4000), list(b.stages), list(b.bring), wd, hour,
      ['weekly', 'biweekly', 'monthly'].includes(b.recurrence) ? b.recurrence : null, u.id);
    res.status(201).json({ id: Number(res2.lastInsertRowid) });
  });
  r.delete('/season/templates/:id', (req, res) => {
    if (!me(req).is_admin) throw new HttpError(403, 'Admins only');
    db.prepare('DELETE FROM event_templates WHERE id = ?').run(id(req.params.id));
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ date polls
  const pollView = (pid: number, uid: number) => {
    const p = db.prepare(`SELECT p.*, ${NAME} AS creator FROM date_polls p JOIN users u ON u.id = p.created_by WHERE p.id = ?`).get(pid) as
      | { id: number; event_id: number | null; title: string; creator: string; created_by: number; closes_at: string | null; chosen_option_id: number | null; created_at: string }
      | undefined;
    if (!p) throw new HttpError(404, 'Poll not found');
    const options = (db.prepare('SELECT * FROM date_poll_options WHERE poll_id = ? ORDER BY starts_on').all(pid) as { id: number; starts_on: string; ends_on: string; label: string | null }[]).map((o) => {
      const who = db.prepare(`SELECT m.user_id AS id, ${NAME} AS name, u.emoji FROM date_poll_marks m JOIN users u ON u.id = m.user_id WHERE m.option_id = ? AND u.removed_at IS NULL`).all(o.id) as { id: number; name: string; emoji: string | null }[];
      return { id: o.id, startsOn: o.starts_on, endsOn: o.ends_on, label: o.label, count: who.length, who, mine: who.some((w) => w.id === uid) };
    });
    const best = Math.max(0, ...options.map((o) => o.count));
    const closed = !!p.chosen_option_id || (!!p.closes_at && p.closes_at <= now());
    return {
      id: p.id, eventId: p.event_id, title: p.title, creator: p.creator, mine: p.created_by === uid, closesAt: p.closes_at, closed,
      chosenOptionId: p.chosen_option_id ?? (closed && best ? options.find((o) => o.count === best)?.id ?? null : null),
      options: options.map((o) => ({ ...o, leading: best > 0 && o.count === best })),
    };
  };
  r.get('/season/polls', (req, res) => {
    const rows = db.prepare('SELECT id FROM date_polls ORDER BY id DESC LIMIT 30').all() as { id: number }[];
    res.json({ polls: rows.map((p) => pollView(p.id, me(req).id)) });
  });
  r.post('/season/polls', (req, res) => {
    const u = me(req);
    const b = req.body ?? {};
    const opts = Array.isArray(b.options) ? b.options.slice(0, 12) : [];
    if (opts.length < 2) throw new HttpError(400, 'Give at least two weekends to pick from');
    const pid = tx(db, () => {
      const res2 = db.prepare('INSERT INTO date_polls (event_id, title, created_by, closes_at) VALUES (?, ?, ?, ?)')
        .run(b.eventId ? event(id(b.eventId)).id : null, txt(b.title, 'Title', 120), u.id, b.closesAt ? iso(b.closesAt, 'Close time') : null);
      const pid = Number(res2.lastInsertRowid);
      for (const o of opts) {
        const s = day(o?.startsOn, 'Start'), e = day(o?.endsOn ?? o?.startsOn, 'End');
        if (e < s) throw new HttpError(400, 'A window can’t end before it starts');
        db.prepare('INSERT INTO date_poll_options (poll_id, starts_on, ends_on, label) VALUES (?, ?, ?, ?)').run(pid, s, e, opt(o?.label, 60));
      }
      feed('date_poll.created', u.id, b.eventId ? Number(b.eventId) : null, `🗓️ ${name(u.id)} wants to know which weekends work for ${b.title}`, ['date_poll', pid]);
      return pid;
    });
    ctx.svc.notifyMembers(`🗓️ ${name(u.id)}: which weekends work for “${String(b.title).slice(0, 80)}”?`, `/season/polls/${pid}`, u.id);
    res.status(201).json({ poll: pollView(pid, u.id) });
  });
  r.get('/season/polls/:id', (req, res) => res.json({ poll: pollView(id(req.params.id), me(req).id) }));
  r.post('/season/polls/:id/mark', (req, res) => {
    const u = me(req);
    const p = pollView(id(req.params.id), u.id);
    if (p.closed) throw new HttpError(409, 'This poll is closed');
    const oid = id(req.body?.optionId);
    if (!p.options.some((o) => o.id === oid)) throw new HttpError(400, 'Not an option on this poll');
    if (req.body?.on === false) db.prepare('DELETE FROM date_poll_marks WHERE option_id = ? AND user_id = ?').run(oid, u.id);
    else db.prepare('INSERT OR IGNORE INTO date_poll_marks (option_id, user_id) VALUES (?, ?)').run(oid, u.id);
    ctx.bus.emit('board');
    res.json({ poll: pollView(p.id, u.id) });
  });
  r.post('/season/polls/:id/close', (req, res) => {
    const u = me(req);
    const p = pollView(id(req.params.id), u.id);
    if (!p.mine && !u.is_admin) throw new HttpError(403, 'Only whoever started it can close it');
    const best = [...p.options].sort((a, b) => b.count - a.count)[0];
    const chosen = req.body?.optionId ? id(req.body.optionId) : best?.id;
    db.prepare('UPDATE date_polls SET chosen_option_id = ? WHERE id = ?').run(chosen ?? null, p.id);
    const o = p.options.find((x) => x.id === chosen);
    if (o) {
      feed('date_poll.decided', u.id, p.eventId, `🗓️ It’s decided: ${p.title} is ${o.startsOn} to ${o.endsOn} (${o.count} can make it)`, ['date_poll', p.id]);
      ctx.svc.notifyMembers(`🗓️ ${p.title}: ${o.startsOn} to ${o.endsOn}. Book it.`, `/season/polls/${p.id}`);
    }
    res.json({ poll: pollView(p.id, u.id) });
  });

  // ------------------------------------------------------------ trips
  const tripView = (eid: number, uid: number) => {
    const e = event(eid);
    const people = crew(eid);
    const bible = db.prepare(`SELECT b.*, ${NAME} AS editor FROM trip_bibles b LEFT JOIN users u ON u.id = b.updated_by WHERE b.event_id = ?`).get(eid) ?? null;
    const rooms = db.prepare('SELECT id, label, beds FROM trip_rooms WHERE event_id = ? ORDER BY id').all(eid) as { id: number; label: string; beds: number }[];
    const picks = db.prepare(`SELECT p.room_id AS roomId, p.user_id AS userId, ${NAME} AS name, u.emoji FROM trip_room_picks p JOIN users u ON u.id = p.user_id WHERE p.event_id = ? ORDER BY p.picked_at`).all(eid) as { roomId: number; userId: number; name: string; emoji: string | null }[];
    const draft = db.prepare('SELECT * FROM trip_drafts WHERE event_id = ?').get(eid) as { mode: string; draft_order: string; started_at: string; done_at: string | null } | undefined;
    let onClock: number | null = null;
    if (draft && !draft.done_at) {
      // Skip anyone removed since the draft started, so one departure can't stall it.
      const active = new Set(people.map((p) => p.id));
      const order = (JSON.parse(draft.draft_order) as number[]).filter((u) => active.has(u));
      onClock = order.find((u) => !picks.some((p) => p.userId === u)) ?? null;
    }
    const kitty = db.prepare(`SELECT k.id, k.amount_cents AS amountCents, k.memo, k.created_at AS createdAt, k.tab_expense_id AS tabExpenseId, ${NAME} AS payer FROM trip_kitty k JOIN users u ON u.id = k.payer_id WHERE k.event_id = ? ORDER BY k.id DESC`).all(eid) as { amountCents: number }[];
    const votes = db.prepare('SELECT category, nominee_id AS nominee, COUNT(*) AS n FROM trip_award_votes WHERE event_id = ? GROUP BY category, nominee_id ORDER BY n DESC').all(eid) as { category: string; nominee: number; n: number }[];
    const myVotes = Object.fromEntries((db.prepare('SELECT category, nominee_id FROM trip_award_votes WHERE event_id = ? AND voter_id = ?').all(eid, uid) as { category: string; nominee_id: number }[]).map((v) => [v.category, v.nominee_id]));
    const awards = AWARDS.map((c) => {
      const top = votes.find((v) => v.category === c);
      return { category: c, leader: top ? { id: top.nominee, name: name(top.nominee), votes: Number(top.n) } : null, myVote: myVotes[c] ?? null };
    });
    // Per-day archive: one row per day of the trip with counts from other modules.
    const start = new Date(e.starts_at);
    const end = new Date(e.ends_at ?? e.real_starts_at);
    const days: { date: string; photos: number | null; quotes: number | null; regrets: number | null }[] = [];
    const count = (t: string, col: string, d: string, extra = '') =>
      tableExists(t) ? Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE event_id = ? AND substr(${col}, 1, 10) = ? ${extra}`).get(eid, d) as { n: number }).n) : null;
    for (let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())); d <= end && days.length < 21; d.setUTCDate(d.getUTCDate() + 1)) {
      const k = d.toISOString().slice(0, 10);
      days.push({ date: k, photos: count('photos', 'created_at', k, `AND status = 'ready'`), quotes: count('posts', 'created_at', k, `AND kind = 'quote'`), regrets: count('posts', 'created_at', k, `AND kind = 'regret' AND (expires_at IS NULL OR expires_at > '${now()}')`) });
    }
    return {
      event: { id: e.id, title: e.title, kind: e.kind, startsAt: e.starts_at, endsAt: e.ends_at, mine: e.host_id === uid },
      crew: people,
      bible,
      rooms: rooms.map((rm) => ({ ...rm, people: picks.filter((p) => p.roomId === rm.id) })),
      draft: draft ? { mode: draft.mode, order: (JSON.parse(draft.draft_order) as number[]).map((u) => ({ id: u, name: name(u) })), done: !!draft.done_at, onClock, myTurn: onClock === uid } : null,
      myRoom: picks.find((p) => p.userId === uid)?.roomId ?? null,
      kitty,
      kittyTotalCents: kitty.reduce((s, k) => s + k.amountCents, 0),
      tabConnected: tableExists('tab_expenses') && tableExists('tab_shares'),
      awards,
      days,
    };
  };
  r.get('/season/trips/:id', (req, res) => res.json(tripView(id(req.params.id), me(req).id)));
  r.put('/season/trips/:id/bible', (req, res) => {
    const u = me(req);
    const eid = event(id(req.params.id)).id;
    const b = req.body ?? {};
    const limits: Record<string, number> = { flights: 4000, house: 2000, packing: 4000, itinerary: 8000, reservations: 4000 };
    for (const [k, max] of Object.entries(limits))
      if (typeof b[k] === 'string' && b[k].trim().length > max) throw new HttpError(400, `${k} is too long (max ${max} characters)`);
    db.prepare(
      `INSERT INTO trip_bibles (event_id, flights, house, packing, itinerary, reservations, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (event_id) DO UPDATE SET flights = excluded.flights, house = excluded.house, packing = excluded.packing,
         itinerary = excluded.itinerary, reservations = excluded.reservations, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).run(eid, opt(b.flights, 4000), opt(b.house, 2000), opt(b.packing, 4000), opt(b.itinerary, 8000), opt(b.reservations, 4000), u.id, now());
    ctx.bus.emit('board');
    res.json(tripView(eid, u.id));
  });
  r.post('/season/trips/:id/rooms', (req, res) => {
    const u = me(req);
    const e = event(id(req.params.id));
    hostOrAdmin(e, u);
    if (db.prepare('SELECT 1 FROM trip_drafts WHERE event_id = ?').get(e.id)) throw new HttpError(409, 'The draft already started');
    const beds = Math.max(1, Math.min(8, Number(req.body?.beds) || 1));
    db.prepare('INSERT INTO trip_rooms (event_id, label, beds) VALUES (?, ?, ?)').run(e.id, txt(req.body?.label, 'Room', 60), beds);
    res.json(tripView(e.id, u.id));
  });
  r.post('/season/trips/:id/draft', (req, res) => {
    const u = me(req);
    const e = event(id(req.params.id));
    hostOrAdmin(e, u);
    const mode = req.body?.mode === 'random' ? 'random' : 'draft';
    const rooms = db.prepare('SELECT id, beds FROM trip_rooms WHERE event_id = ?').all(e.id) as { id: number; beds: number }[];
    const people = crew(e.id).map((p) => p.id);
    if (!rooms.length) throw new HttpError(400, 'Add the rooms first');
    if (rooms.reduce((s, r2) => s + r2.beds, 0) < people.length) throw new HttpError(400, 'Not enough beds for everyone who’s in. Add a couch.');
    const order = shuffle(people);
    tx(db, () => {
      db.prepare('DELETE FROM trip_room_picks WHERE event_id = ?').run(e.id);
      db.prepare('INSERT OR REPLACE INTO trip_drafts (event_id, mode, draft_order, started_at, done_at) VALUES (?, ?, ?, ?, NULL)').run(e.id, mode, JSON.stringify(order), now());
      if (mode === 'random') {
        // Random draw: nobody claims the primary suite before it's assigned.
        const slots = shuffle(rooms.flatMap((r2) => Array.from({ length: r2.beds }, () => r2.id)));
        order.forEach((uid, i) => db.prepare('INSERT INTO trip_room_picks (event_id, user_id, room_id, picked_at) VALUES (?, ?, ?, ?)').run(e.id, uid, slots[i], now()));
        db.prepare('UPDATE trip_drafts SET done_at = ? WHERE event_id = ?').run(now(), e.id);
        feed('trip.rooms', u.id, e.id, `🎲 Rooms for ${e.title} were drawn at random. Complaints go to Group Court.`);
      } else {
        feed('trip.draft', u.id, e.id, `🛏️ The room draft for ${e.title} is on. ${name(order[0])} picks first.`);
      }
    });
    for (const uid of people) ctx.svc.notify(uid, null, mode === 'random' ? `🎲 Rooms for ${e.title} are assigned.` : `🛏️ The room draft for ${e.title} started.`, `/season/trips/${e.id}`);
    res.json(tripView(e.id, u.id));
  });
  r.post('/season/trips/:id/pick', (req, res) => {
    const u = me(req);
    const e = event(id(req.params.id));
    const v = tripView(e.id, u.id);
    if (!v.draft || v.draft.done) throw new HttpError(409, 'No draft running');
    if (!v.draft.myTurn) throw new HttpError(409, `Not your pick. ${v.draft.onClock ? name(v.draft.onClock) : 'Someone'} is on the clock.`);
    const room = v.rooms.find((r2) => r2.id === id(req.body?.roomId));
    if (!room) throw new HttpError(400, 'Not a room on this trip');
    if (room.people.length >= room.beds) throw new HttpError(409, 'That room is full');
    tx(db, () => {
      db.prepare('INSERT INTO trip_room_picks (event_id, user_id, room_id, picked_at) VALUES (?, ?, ?, ?)').run(e.id, u.id, room.id, now());
      feed('trip.pick', u.id, e.id, `🛏️ ${name(u.id)} took ${room.label}`);
      const after = tripView(e.id, u.id);
      if (after.draft && after.draft.onClock === null) db.prepare('UPDATE trip_drafts SET done_at = ? WHERE event_id = ?').run(now(), e.id);
      else if (after.draft?.onClock) ctx.svc.notify(after.draft.onClock, null, `🛏️ You’re on the clock in the ${e.title} room draft.`, `/season/trips/${e.id}`);
    });
    res.json(tripView(e.id, u.id));
  });
  r.post('/season/trips/:id/kitty', (req, res) => {
    const u = me(req);
    const e = event(id(req.params.id));
    const cents = Math.round(Number(req.body?.amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0 || cents > 10_000_000) throw new HttpError(400, 'Amount must be a positive number');
    const memo = txt(req.body?.memo, 'What it was for', 120);
    tx(db, () => {
      const res2 = db.prepare('INSERT INTO trip_kitty (event_id, payer_id, amount_cents, memo, created_at) VALUES (?, ?, ?, ?, ?)').run(e.id, u.id, cents, memo, now());
      const kid = Number(res2.lastInsertRowid);
      // Split evenly to the Tab across everyone on the trip, if the Tab is installed.
      const people = crew(e.id).map((p) => p.id);
      if (people.length && tableExists('tab_expenses') && tableExists('tab_shares')) {
        const ex = db.prepare('INSERT INTO tab_expenses (event_id, payer_id, created_by, description, amount_cents, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(e.id, u.id, u.id, `Kitty: ${memo}`, cents, now());
        const exId = Number(ex.lastInsertRowid);
        const base = Math.floor(cents / people.length);
        let rem = cents - base * people.length;
        for (const pid of people) {
          db.prepare('INSERT INTO tab_shares (expense_id, user_id, amount_cents) VALUES (?, ?, ?)').run(exId, pid, base + (rem-- > 0 ? 1 : 0));
        }
        db.prepare('UPDATE trip_kitty SET tab_expense_id = ? WHERE id = ?').run(exId, kid);
      }
      feed('trip.kitty', u.id, e.id, `💸 ${name(u.id)} put $${(cents / 100).toFixed(2)} on the kitty for ${memo}`);
    });
    res.json(tripView(e.id, u.id));
  });
  r.post('/season/trips/:id/awards', (req, res) => {
    const u = me(req);
    const e = event(id(req.params.id));
    const category = String(req.body?.category ?? '');
    if (!AWARDS.includes(category)) throw new HttpError(400, 'Not an award');
    const nominee = id(req.body?.nomineeId);
    if (!crew(e.id).some((p) => p.id === nominee)) throw new HttpError(400, 'They weren’t on the trip');
    db.prepare(
      `INSERT INTO trip_award_votes (event_id, category, voter_id, nominee_id) VALUES (?, ?, ?, ?)
       ON CONFLICT (event_id, category, voter_id) DO UPDATE SET nominee_id = excluded.nominee_id`,
    ).run(e.id, category, u.id, nominee);
    ctx.bus.emit('board');
    res.json(tripView(e.id, u.id));
  });

  // ------------------------------------------------------------ football
  const gameView = (g: Record<string, unknown>, uid: number) => {
    const gid = Number(g.id);
    const picks = db.prepare(`SELECT p.team, p.user_id AS userId, ${NAME} AS name, u.emoji FROM game_picks p JOIN users u ON u.id = p.user_id WHERE p.game_id = ?`).all(gid) as { team: string; userId: number }[];
    const locked = String(g.kickoff_at) <= now();
    const final = g.home_score !== null && g.home_score !== undefined;
    const winner = final ? (Number(g.home_score) > Number(g.away_score) ? g.home : Number(g.away_score) > Number(g.home_score) ? g.away : null) : null;
    return {
      id: gid, eventId: g.event_id, season: g.season, week: g.week, home: g.home, away: g.away, kickoffAt: g.kickoff_at,
      homeScore: g.home_score, awayScore: g.away_score, final, winner, locked,
      // Picks stay secret until kickoff, so nobody copies.
      picks: locked ? picks : picks.filter((p) => p.userId === uid),
      pickCount: picks.length,
      myPick: picks.find((p) => p.userId === uid)?.team ?? null,
    };
  };
  r.get('/season/games', (req, res) => {
    const season = String(req.query.season ?? new Date(now()).getUTCFullYear());
    const rows = db.prepare('SELECT * FROM games WHERE season = ? ORDER BY kickoff_at DESC LIMIT 200').all(season) as Record<string, unknown>[];
    const board = db.prepare(
      `SELECT p.user_id AS userId, ${NAME} AS name, u.emoji,
         SUM(CASE WHEN g.home_score IS NOT NULL AND ((g.home_score > g.away_score AND p.team = g.home) OR (g.away_score > g.home_score AND p.team = g.away)) THEN 1 ELSE 0 END) AS wins,
         SUM(CASE WHEN g.home_score IS NOT NULL THEN 1 ELSE 0 END) AS played
       FROM game_picks p JOIN games g ON g.id = p.game_id JOIN users u ON u.id = p.user_id
       WHERE g.season = ? AND u.removed_at IS NULL GROUP BY p.user_id ORDER BY wins DESC, played ASC`,
    ).all(season) as { wins: number; played: number }[];
    const fans = db.prepare(`SELECT f.user_id AS userId, f.team, ${NAME} AS name FROM fan_teams f JOIN users u ON u.id = f.user_id WHERE u.removed_at IS NULL`).all();
    res.json({
      season,
      games: rows.map((g) => gameView(g, me(req).id)),
      leaderboard: board,
      // Loser hosts the Super Bowl party.
      hostsSuperBowl: board.length > 1 && board[board.length - 1].played > 0 ? board[board.length - 1] : null,
      fans,
      myTeam: (db.prepare('SELECT team FROM fan_teams WHERE user_id = ?').get(me(req).id) as { team: string } | undefined)?.team ?? null,
    });
  });
  r.post('/season/games', (req, res) => {
    const u = me(req);
    const b = req.body ?? {};
    const kickoff = iso(b.kickoffAt, 'Kickoff');
    const res2 = db.prepare('INSERT INTO games (event_id, season, week, home, away, kickoff_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      b.eventId ? event(id(b.eventId)).id : null, String(b.season ?? new Date(kickoff).getUTCFullYear()).slice(0, 10),
      Math.max(1, Math.min(30, Number(b.week) || 1)), txt(b.home, 'Home team', 40), txt(b.away, 'Away team', 40), kickoff, u.id,
    );
    ctx.bus.emit('board');
    res.status(201).json({ id: Number(res2.lastInsertRowid) });
  });
  const game = (gid: number) => {
    const g = db.prepare('SELECT * FROM games WHERE id = ?').get(gid) as Record<string, unknown> | undefined;
    if (!g) throw new HttpError(404, 'Game not found');
    return g;
  };
  r.get('/season/games/:id', (req, res) => {
    const u = me(req);
    const g = game(id(req.params.id));
    const talk = db.prepare(`SELECT t.id, t.body, t.created_at AS createdAt, ${NAME} AS name, u.emoji, f.team FROM game_talk t JOIN users u ON u.id = t.user_id LEFT JOIN fan_teams f ON f.user_id = t.user_id WHERE t.game_id = ? ORDER BY t.id DESC LIMIT 200`).all(g.id as number);
    const board = db.prepare('SELECT * FROM squares_boards WHERE game_id = ? ORDER BY id DESC LIMIT 1').get(g.id as number) as { id: number; row_digits: string | null; col_digits: string | null; locked_at: string | null } | undefined;
    let squares = null;
    if (board) {
      const cells = db.prepare(`SELECT s.r, s.c, s.user_id AS userId, ${NAME} AS name, u.emoji FROM squares s JOIN users u ON u.id = s.user_id WHERE s.board_id = ?`).all(board.id) as { r: number; c: number; userId: number; name: string }[];
      const rows = board.row_digits ? (JSON.parse(board.row_digits) as number[]) : null;
      const cols = board.col_digits ? (JSON.parse(board.col_digits) as number[]) : null;
      let winner = null;
      if (rows && cols && g.home_score !== null) {
        const r2 = rows.indexOf(Number(g.home_score) % 10), c2 = cols.indexOf(Number(g.away_score) % 10);
        winner = cells.find((x) => x.r === r2 && x.c === c2) ?? null;
      }
      squares = { id: board.id, locked: !!board.locked_at, rows, cols, cells, mine: cells.filter((x) => x.userId === u.id).length, winner };
    }
    res.json({ game: gameView(g, u.id), talk, squares });
  });
  r.post('/season/games/:id/pick', (req, res) => {
    const u = me(req);
    const g = game(id(req.params.id));
    if (String(g.kickoff_at) <= now()) throw new HttpError(409, 'Picks locked at kickoff. Gloat in the thread instead.');
    const team = String(req.body?.team ?? '');
    if (team !== g.home && team !== g.away) throw new HttpError(400, 'Pick one of the two teams');
    db.prepare(`INSERT INTO game_picks (game_id, user_id, team, picked_at) VALUES (?, ?, ?, ?) ON CONFLICT (game_id, user_id) DO UPDATE SET team = excluded.team, picked_at = excluded.picked_at`).run(g.id as number, u.id, team, now());
    res.json({ ok: true });
  });
  r.post('/season/games/:id/score', (req, res) => {
    const u = me(req);
    const g = game(id(req.params.id));
    if (g.created_by !== u.id && !u.is_admin) throw new HttpError(403, 'Only whoever added the game (or an admin) can enter the score');
    const hs = Number(req.body?.homeScore), as = Number(req.body?.awayScore);
    if (![hs, as].every((n) => Number.isInteger(n) && n >= 0 && n < 200)) throw new HttpError(400, 'Scores are whole numbers');
    db.prepare('UPDATE games SET home_score = ?, away_score = ?, final_at = ? WHERE id = ?').run(hs, as, now(), g.id as number);
    feed('game.final', u.id, (g.event_id as number) ?? null, `🏈 Final: ${g.home} ${hs}, ${g.away} ${as}. Pick'em standings updated.`, ['game', Number(g.id)]);
    res.json({ ok: true });
  });
  r.post('/season/games/:id/talk', (req, res) => {
    const u = me(req);
    const g = game(id(req.params.id));
    db.prepare('INSERT INTO game_talk (game_id, user_id, body, created_at) VALUES (?, ?, ?, ?)').run(g.id as number, u.id, txt(req.body?.body, 'Trash talk', 500), now());
    ctx.bus.emit('board');
    res.json({ ok: true });
  });
  r.post('/season/team', (req, res) => {
    const u = me(req);
    const team = opt(req.body?.team, 40);
    if (team) db.prepare('INSERT INTO fan_teams (user_id, team) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET team = excluded.team').run(u.id, team);
    else db.prepare('DELETE FROM fan_teams WHERE user_id = ?').run(u.id);
    res.json({ ok: true });
  });
  r.post('/season/games/:id/squares', (req, res) => {
    const u = me(req);
    const g = game(id(req.params.id));
    if (db.prepare('SELECT 1 FROM squares_boards WHERE game_id = ?').get(g.id as number)) throw new HttpError(409, 'This game already has a board');
    db.prepare('INSERT INTO squares_boards (game_id, created_at) VALUES (?, ?)').run(g.id as number, now());
    feed('squares.open', u.id, (g.event_id as number) ?? null, `🔢 Squares are open for ${g.away} at ${g.home}. Claim yours.`, ['game', Number(g.id)]);
    res.json({ ok: true });
  });
  r.post('/season/squares/:boardId/claim', (req, res) => {
    const u = me(req);
    const b = db.prepare('SELECT * FROM squares_boards WHERE id = ?').get(id(req.params.boardId)) as { id: number; locked_at: string | null } | undefined;
    if (!b) throw new HttpError(404, 'Board not found');
    if (b.locked_at) throw new HttpError(409, 'The board is locked');
    const rr = Number(req.body?.r), cc = Number(req.body?.c);
    if (![rr, cc].every((n) => Number.isInteger(n) && n >= 0 && n <= 9)) throw new HttpError(400, 'Bad square');
    const cur = db.prepare('SELECT user_id FROM squares WHERE board_id = ? AND r = ? AND c = ?').get(b.id, rr, cc) as { user_id: number } | undefined;
    if (cur && cur.user_id !== u.id) throw new HttpError(409, 'Taken');
    if (cur) db.prepare('DELETE FROM squares WHERE board_id = ? AND r = ? AND c = ?').run(b.id, rr, cc);
    else db.prepare('INSERT INTO squares (board_id, r, c, user_id) VALUES (?, ?, ?, ?)').run(b.id, rr, cc, u.id);
    ctx.bus.emit('board');
    res.json({ ok: true });
  });
  r.post('/season/squares/:boardId/lock', (req, res) => {
    if (!me(req).is_admin) throw new HttpError(403, 'Admins lock the board');
    const digits = () => JSON.stringify(shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    db.prepare('UPDATE squares_boards SET row_digits = ?, col_digits = ?, locked_at = ? WHERE id = ? AND locked_at IS NULL').run(digits(), digits(), now(), id(req.params.boardId));
    ctx.bus.emit('board');
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ bar tracker
  r.get('/season/bars', (_req, res) => {
    res.json({
      bars: db.prepare(
        `SELECT b.id, b.name, b.neighborhood, b.teams, ROUND(AVG(r.sound), 1) AS sound, ROUND(AVG(r.wings), 1) AS wings,
           ROUND(AVG(r.lines), 1) AS lines, COUNT(r.user_id) AS ratings
         FROM bars b LEFT JOIN bar_ratings r ON r.bar_id = b.id GROUP BY b.id ORDER BY (COALESCE(AVG(r.sound),0) + COALESCE(AVG(r.wings),0) + COALESCE(AVG(r.lines),0)) DESC, b.name`,
      ).all(),
    });
  });
  r.post('/season/bars', (req, res) => {
    const u = me(req);
    const res2 = db.prepare('INSERT INTO bars (name, neighborhood, teams, added_by, created_at) VALUES (?, ?, ?, ?, ?)').run(txt(req.body?.name, 'Bar', 80), opt(req.body?.neighborhood, 60), opt(req.body?.teams, 200), u.id, now());
    res.status(201).json({ id: Number(res2.lastInsertRowid) });
  });
  r.post('/season/bars/:id/rate', (req, res) => {
    const u = me(req);
    const bid = id(req.params.id);
    if (!db.prepare('SELECT 1 FROM bars WHERE id = ?').get(bid)) throw new HttpError(404, 'Bar not found');
    const s = (v: unknown) => (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 5 ? Number(v) : null);
    db.prepare(
      `INSERT INTO bar_ratings (bar_id, user_id, sound, wings, lines, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (bar_id, user_id) DO UPDATE SET sound = COALESCE(excluded.sound, bar_ratings.sound), wings = COALESCE(excluded.wings, bar_ratings.wings),
         lines = COALESCE(excluded.lines, bar_ratings.lines), note = COALESCE(excluded.note, bar_ratings.note), updated_at = excluded.updated_at`,
    ).run(bid, u.id, s(req.body?.sound), s(req.body?.wings), s(req.body?.lines), opt(req.body?.note, 200), now());
    res.json({ ok: true });
  });

  return r;
}

export const module: StallModule = {
  name: 'season',
  migrations: SEASON_MIGRATIONS,
  routes,
  onMemberRemoved: (ctx, userId, policy) => {
    if (policy === 'keep') return;
    if (policy === 'anonymize') {
      ctx.db.prepare('INSERT OR IGNORE INTO season_anonymized (user_id) VALUES (?)').run(userId);
      return;
    }
    for (const t of ['game_picks', 'game_talk', 'fan_teams', 'squares', 'bar_ratings', 'date_poll_marks', 'trip_room_picks'])
      ctx.db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId);
    ctx.db.prepare('DELETE FROM trip_award_votes WHERE voter_id = ? OR nominee_id = ?').run(userId, userId);
  },
};
