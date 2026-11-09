// SQLite through libsql: a local file in development, or a hosted Turso database
// (free tier) when TURSO_DATABASE_URL is set, so data survives restarts on hosts
// with throwaway disks such as Render's free plan.
import Database from 'libsql';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { clock } from './clock.ts';

type Params = (string | number | null | bigint | Uint8Array)[];
export interface Db {
  prepare(sql: string): {
    run(...p: Params): { changes: number; lastInsertRowid: number | bigint };
    get(...p: Params): unknown;
    all(...p: Params): unknown[];
  };
  exec(sql: string): unknown;
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,             -- sha256(token); the raw token only lives in the cookie
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE requests (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0, -- >0 jumps the queue (replies, rework)
    lane TEXT,
    branch TEXT,
    commit_sha TEXT,
    summary TEXT,
    failure_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    approved_at TEXT,
    completed_at TEXT
  );
  CREATE INDEX requests_status ON requests(status);
  CREATE INDEX requests_user ON requests(user_id);
  CREATE TABLE votes (
    request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    value INTEGER NOT NULL CHECK (value IN (-1, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (request_id, user_id)
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    author TEXT NOT NULL,           -- user | claude | system
    user_id INTEGER REFERENCES users(id),
    kind TEXT NOT NULL,             -- question | reply | note
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX messages_request ON messages(request_id);
  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id INTEGER REFERENCES requests(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX notifications_user ON notifications(user_id, read_at);
  -- Durable outbox: every queue event is written here in the same transaction as
  -- the state change, then delivered to the orchestrator webhook with retries.
  CREATE TABLE webhook_outbox (
    id INTEGER PRIMARY KEY,
    event TEXT NOT NULL,
    payload TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    delivered_at TEXT,
    last_error TEXT
  );
  CREATE INDEX outbox_pending ON webhook_outbox(delivered_at, next_attempt_at);
  `,
  `
  CREATE TABLE push_subscriptions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  `,
  `
  -- Technical notes (test output, conflict lists) only admins see.
  ALTER TABLE messages ADD COLUMN admin_only INTEGER NOT NULL DEFAULT 0;
  `,
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  // ---- Foundation (core): invite-only membership, profiles, and the shared tables every
  // module builds on. Module tables live in app/src/modules/<name> (see docs/ARCHITECTURE.md).
  `
  ALTER TABLE users ADD COLUMN display_name TEXT;
  ALTER TABLE users ADD COLUMN emoji TEXT;
  ALTER TABLE users ADD COLUMN removed_at TEXT;
  CREATE TABLE invites (
    id INTEGER PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,      -- sha256(code); the code is shown once, to the admin who made it
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    note TEXT,
    expires_at TEXT NOT NULL,
    used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    used_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  ALTER TABLE notifications ADD COLUMN link TEXT;
  -- General yes/no group votes (plus-ones, court, hot takes, unmask...). Same consensus rule as the feature board.
  CREATE TABLE ballots (
    subject_type TEXT NOT NULL,
    subject_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    value INTEGER NOT NULL CHECK (value IN (-1, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (subject_type, subject_id, user_id)
  );
  CREATE INDEX ballots_user ON ballots(user_id);
  -- Emoji reactions on anything (post, photo, caption...).
  CREATE TABLE reactions (
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (target_type, target_id, user_id, emoji)
  );
  CREATE INDEX reactions_user ON reactions(user_id);
  -- Announcements for the Feed ("Jess went from In → Maybe (lying)", "the roll is developed").
  CREATE TABLE feed_items (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    actor_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    event_id INTEGER,                    -- no FK: events is a module table
    subject_type TEXT,
    subject_id INTEGER,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX feed_items_created ON feed_items(created_at);
  CREATE INDEX feed_items_event ON feed_items(event_id);
  CREATE INDEX feed_items_actor ON feed_items(actor_id);
  -- Idempotency for scheduled pushes sent from /api/v1/tick.
  CREATE TABLE jobs_sent (key TEXT PRIMARY KEY, sent_at TEXT NOT NULL);
  -- Stored files waiting to be deleted (veto, expiry, removal). Retried by the tick until gone.
  CREATE TABLE storage_deletes (
    storage_key TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  );
  CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
  `,
];

export function openDb(path: string, remote?: { url: string; authToken?: string }): Db {
  let db: Db;
  if (remote?.url) {
    db = new Database(remote.url, { authToken: remote.authToken } as ConstructorParameters<typeof Database>[1]) as unknown as Db;
    db.exec('PRAGMA foreign_keys = ON;');
  } else {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    db = new Database(path) as unknown as Db;
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  }
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  while (version < MIGRATIONS.length) {
    tx(db, () => {
      db.exec(MIGRATIONS[version]);
      db.prepare('UPDATE schema_version SET version = ?').run(version + 1);
    });
    version++;
  }
  return db;
}

/**
 * Apply module migrations (app/src/modules/<name>/index.ts) once each, by id, in
 * registry order. Ids are strings like 'events-001', so lanes never collide on numbers.
 */
export function applyModuleMigrations(db: Db, migrations: { id: string; sql: string }[]) {
  const seen = new Set<string>();
  for (const m of migrations) {
    if (seen.has(m.id)) throw new Error(`Duplicate migration id ${m.id}`);
    seen.add(m.id);
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(m.id)) continue;
    tx(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(m.id, now());
    });
  }
}

/** Run fn inside a transaction (nested calls join the outer one). */
let depth = 0;
export function tx<T>(db: Db, fn: () => T): T {
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth--;
  }
}

/** Current server time as an ISO string (goes through the testable clock). */
export const now = () => clock.iso();
