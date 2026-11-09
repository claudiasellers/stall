// Lore Map: every place the group has been, pinned on a stylized NYC map, with
// incidents ("the Ray's incident, March '26") attached. Never GPS: a place is a
// name plus a neighborhood anchor (optionally nudged by tapping the map), stored
// as x/y on the map's own 0..1000 grid. Night-of check-ins with the same name are
// counted as visits at read time.
import express from 'express';
import { HttpError } from '../../service.ts';
import { tx, now } from '../../db.ts';
import type { ModuleCtx, StallModule } from '../types.ts';

/** Neighborhood anchors on the map grid (must match views/loremap.js). */
export const HOODS: Record<string, [number, number]> = {
  'Upper West Side': [330, 250], 'Upper East Side': [420, 260], Harlem: [380, 140], Midtown: [380, 400],
  Chelsea: [320, 470], 'Flatiron': [370, 480], 'West Village': [320, 540], 'Greenwich Village': [355, 545],
  'East Village': [420, 545], SoHo: [345, 590], 'Lower East Side': [420, 600], Chinatown: [385, 620],
  Tribeca: [330, 630], 'Financial District': [350, 690], Greenpoint: [530, 470], Williamsburg: [530, 560],
  Bushwick: [640, 600], 'DUMBO': [450, 690], 'Fort Greene': [520, 700], 'Park Slope': [500, 800],
  'Bed-Stuy': [620, 700], 'Crown Heights': [610, 800], 'Long Island City': [520, 380], Astoria: [560, 270],
  Ridgewood: [700, 540], 'Somewhere else': [800, 900],
};

const migrations = [
  {
    id: 'loremap-001',
    sql: `
    CREATE TABLE lore_places (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      hood TEXT NOT NULL,
      x REAL NOT NULL CHECK (x BETWEEN 0 AND 1000),
      y REAL NOT NULL CHECK (y BETWEEN 0 AND 1000),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX lore_places_created_by ON lore_places(created_by);
    CREATE TABLE lore_incidents (
      id INTEGER PRIMARY KEY,
      place_id INTEGER NOT NULL REFERENCES lore_places(id) ON DELETE CASCADE,
      event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      body TEXT,
      happened_on TEXT NOT NULL,          -- YYYY-MM (house time); "March '26"
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX lore_incidents_place ON lore_incidents(place_id, happened_on);
    CREATE INDEX lore_incidents_event ON lore_incidents(event_id);
    CREATE INDEX lore_incidents_created_by ON lore_incidents(created_by);
    `,
  },
];

const text = (v: unknown, max: number, what: string, required = true) => {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (!s && required) throw new HttpError(400, `${what} is required`);
  if (s.length > max) throw new HttpError(400, `${what} is too long (${max} max)`);
  return s || null;
};
const coord = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? n : fallback;
};

/** Check-in counts per lowercase venue name; null-safe if night-of isn't installed. */
function visits(db: ModuleCtx['db']): Map<string, number> {
  try {
    const rows = db.prepare(`SELECT lower(venue) AS v, COUNT(DISTINCT COALESCE(event_id, substr(created_at, 1, 10))) AS n FROM night_checkins GROUP BY lower(venue)`).all() as { v: string; n: number }[];
    return new Map(rows.map((r) => [r.v, r.n]));
  } catch {
    return new Map();
  }
}

function routes(ctx: ModuleCtx) {
  const db = ctx.db;
  const r = express.Router();
  const num = (v: unknown) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Bad id');
    return n;
  };

  r.get('/lore-map', (_req, res) => {
    const places = db.prepare(
      `SELECT p.id, p.name, p.hood, p.x, p.y, COUNT(i.id) AS incidents, MAX(i.happened_on) AS last_incident
       FROM lore_places p LEFT JOIN lore_incidents i ON i.place_id = p.id GROUP BY p.id ORDER BY p.name`,
    ).all() as { id: number; name: string; hood: string; x: number; y: number; incidents: number; last_incident: string | null }[];
    const v = visits(db);
    // Venues people checked in at that nobody has pinned yet, so the map can suggest them.
    let unpinned: string[] = [];
    try {
      unpinned = (db.prepare(
        `SELECT venue FROM night_checkins WHERE lower(venue) NOT IN (SELECT lower(name) FROM lore_places)
         GROUP BY lower(venue) ORDER BY COUNT(*) DESC LIMIT 12`,
      ).all() as { venue: string }[]).map((x) => x.venue);
    } catch { /* night-of not installed */ }
    res.json({
      hoods: HOODS,
      places: places.map((p) => ({ id: p.id, name: p.name, hood: p.hood, x: p.x, y: p.y, incidents: p.incidents, lastIncident: p.last_incident, visits: v.get(p.name.toLowerCase()) ?? 0 })),
      unpinned,
    });
  });

  r.get('/lore-map/places/:id', (req, res) => {
    const id = num(req.params.id);
    const p = db.prepare('SELECT id, name, hood, x, y, created_at FROM lore_places WHERE id = ?').get(id) as { id: number; name: string } | undefined;
    if (!p) throw new HttpError(404, 'Place not found');
    const incidents = db.prepare(
      `SELECT i.id, i.title, i.body, i.happened_on AS happenedOn, i.event_id AS eventId, i.created_by AS createdBy,
              COALESCE(u.display_name, u.username) AS author
       FROM lore_incidents i LEFT JOIN users u ON u.id = i.created_by WHERE i.place_id = ? ORDER BY i.happened_on DESC, i.id DESC LIMIT 100`,
    ).all(id) as { createdBy: number | null }[];
    res.json({
      place: { ...p, visits: visits(db).get(p.name.toLowerCase()) ?? 0 },
      incidents: incidents.map((i) => ({ ...i, mine: i.createdBy === req.user!.id })),
    });
  });

  r.post('/lore-map/places', (req, res) => {
    const name = text(req.body?.name, 80, 'The place')!;
    const hood = String(req.body?.hood ?? '');
    const anchor = HOODS[hood];
    if (!anchor) throw new HttpError(400, 'Pick a neighborhood');
    // Jitter around the anchor so pins in one hood don't stack.
    const jx = anchor[0] + (Math.random() - 0.5) * 50;
    const jy = anchor[1] + (Math.random() - 0.5) * 50;
    const existing = db.prepare('SELECT id FROM lore_places WHERE name = ?').get(name) as { id: number } | undefined;
    if (existing) return res.json({ id: existing.id, existed: true });
    const id = Number(db.prepare('INSERT INTO lore_places (name, hood, x, y, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, hood, coord(req.body?.x, jx), coord(req.body?.y, jy), req.user!.id, now()).lastInsertRowid);
    ctx.bus.emit('live', { topic: 'loremap' });
    res.status(201).json({ id });
  });

  /** Move a pin (anyone; it's a shared map). */
  r.post('/lore-map/places/:id/move', (req, res) => {
    const id = num(req.params.id);
    const ch = db.prepare('UPDATE lore_places SET x = ?, y = ? WHERE id = ?').run(coord(req.body?.x, -1), coord(req.body?.y, -1), id);
    if (!ch.changes) throw new HttpError(404, 'Place not found');
    ctx.bus.emit('live', { topic: 'loremap' });
    res.json({ ok: true });
  });

  r.post('/lore-map/places/:id/incidents', (req, res) => {
    const placeId = num(req.params.id);
    const place = db.prepare('SELECT name FROM lore_places WHERE id = ?').get(placeId) as { name: string } | undefined;
    if (!place) throw new HttpError(404, 'Place not found');
    const title = text(req.body?.title, 80, 'What happened')!;
    const body = text(req.body?.body, 600, 'The story', false);
    const happenedOn = String(req.body?.happenedOn ?? '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(happenedOn)) throw new HttpError(400, 'Pick the month it happened');
    let eventId: number | null = null;
    if (req.body?.eventId) {
      eventId = num(req.body.eventId);
      if (!db.prepare('SELECT 1 FROM events WHERE id = ?').get(eventId)) throw new HttpError(404, 'That event is gone');
    }
    const id = tx(db, () => {
      const id = Number(db.prepare('INSERT INTO lore_incidents (place_id, event_id, title, body, happened_on, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(placeId, eventId, title, body, happenedOn, req.user!.id, now()).lastInsertRowid);
      db.prepare(`INSERT INTO feed_items (kind, actor_id, event_id, subject_type, subject_id, body, created_at) VALUES ('lore_pin', ?, ?, 'lore_incident', ?, ?, ?)`)
        .run(req.user!.id, eventId, id, `📍 New lore at ${place.name}: ${title}`, now());
      return id;
    });
    ctx.bus.emit('live', { topic: 'loremap' });
    res.status(201).json({ id });
  });

  r.delete('/lore-map/incidents/:id', (req, res) => {
    const id = num(req.params.id);
    const row = db.prepare('SELECT created_by FROM lore_incidents WHERE id = ?').get(id) as { created_by: number | null } | undefined;
    if (!row || (row.created_by !== req.user!.id && !req.user!.is_admin)) throw new HttpError(404, 'Not found');
    tx(db, () => {
      db.prepare(`DELETE FROM feed_items WHERE subject_type = 'lore_incident' AND subject_id = ?`).run(id);
      db.prepare(`DELETE FROM reactions WHERE target_type = 'lore_incident' AND target_id = ?`).run(id);
      db.prepare('DELETE FROM lore_incidents WHERE id = ?').run(id);
    });
    ctx.bus.emit('live', { topic: 'loremap' });
    res.json({ ok: true });
  });

  return r;
}

export const module: StallModule = {
  name: 'loremap',
  migrations,
  routes,
  onMemberRemoved: (ctx, userId, policy) => {
    if (policy === 'delete') ctx.db.prepare('DELETE FROM lore_incidents WHERE created_by = ?').run(userId);
    else if (policy === 'anonymize') {
      ctx.db.prepare('UPDATE lore_incidents SET created_by = NULL WHERE created_by = ?').run(userId);
      ctx.db.prepare('UPDATE lore_places SET created_by = NULL WHERE created_by = ?').run(userId);
    }
  },
};
