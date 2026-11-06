// Orchestrator-local state: which worktree/branch/session belongs to which request.
// The app owns the queue; this owns everything needed to resume work after a pause or crash.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type Phase = 'working' | 'waiting_reply' | 'rework' | 'ready' | 'integrating' | 'done' | 'failed' | 'cancelled';

export type Job = {
  request_id: number;
  title: string;
  branch: string;
  worktree: string;
  session_id: string | null;
  phase: Phase;
  lane: string | null;
  summary: string | null;
  rework_note: string | null;
  rework_count: number;
  created_at: string;
  updated_at: string;
};

export class Store {
  db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'orchestrator.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS jobs (
        request_id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        branch TEXT NOT NULL,
        worktree TEXT NOT NULL,
        session_id TEXT,
        phase TEXT NOT NULL,
        lane TEXT,
        summary TEXT,
        rework_note TEXT,
        rework_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
    `);
  }

  get(id: number): Job | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE request_id = ?').get(id) as Job | undefined;
  }

  create(j: Pick<Job, 'request_id' | 'title' | 'branch' | 'worktree'>): Job {
    this.db
      .prepare(`INSERT INTO jobs (request_id, title, branch, worktree, phase) VALUES (?, ?, ?, ?, 'working')`)
      .run(j.request_id, j.title, j.branch, j.worktree);
    return this.get(j.request_id)!;
  }

  update(id: number, patch: Partial<Omit<Job, 'request_id' | 'created_at' | 'updated_at'>>) {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.db
      .prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE request_id = ?`)
      .run(...keys.map((k) => (patch as Record<string, string | number | null>)[k]), id);
  }

  byPhase(...phases: Phase[]): Job[] {
    return this.db
      .prepare(`SELECT * FROM jobs WHERE phase IN (${phases.map(() => '?').join(',')}) ORDER BY updated_at`)
      .all(...phases) as Job[];
  }

  /** Returns false if this webhook delivery was already processed. */
  firstDelivery(id: string): boolean {
    const res = this.db.prepare('INSERT OR IGNORE INTO deliveries (id, at) VALUES (?, ?)').run(id, Date.now());
    this.db.prepare('DELETE FROM deliveries WHERE at < ?').run(Date.now() - 7 * 24 * 3600 * 1000);
    return res.changes === 1;
  }
}
