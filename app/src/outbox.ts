// Delivers queued events to the orchestrator webhook, with exponential backoff.
// If no webhook URL is configured, events are marked delivered immediately:
// the orchestrator also polls GET /api/orch/queue, so nothing depends on push.
import type { Db } from './db.ts';
import type { AppConfig } from './config.ts';
import { bus } from './service.ts';
import { sign, SIGNATURE_HEADER, TIMESTAMP_HEADER, EVENT_HEADER, DELIVERY_HEADER } from '../../shared/signing.ts';

const MAX_ATTEMPTS = 25;

export function startOutbox(db: Db, cfg: AppConfig) {
  let running = false;
  let timer: NodeJS.Timeout | undefined;

  const due = db.prepare(
    'SELECT id, event, payload, attempts FROM webhook_outbox WHERE delivered_at IS NULL AND attempts < ? AND next_attempt_at <= ? ORDER BY id LIMIT 20',
  );
  const ok = db.prepare(`UPDATE webhook_outbox SET delivered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), attempts = attempts + 1, last_error = NULL WHERE id = ?`);
  const bad = db.prepare('UPDATE webhook_outbox SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE id = ?');

  async function drain() {
    if (running) return;
    running = true;
    try {
      for (;;) {
        const rows = due.all(MAX_ATTEMPTS, Date.now()) as { id: number; event: string; payload: string; attempts: number }[];
        if (!rows.length) break;
        for (const row of rows) {
          if (!cfg.webhookUrl) {
            ok.run(row.id);
            continue;
          }
          try {
            const ts = String(Math.floor(Date.now() / 1000));
            const res = await fetch(cfg.webhookUrl, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                [EVENT_HEADER]: row.event,
                [DELIVERY_HEADER]: String(row.id),
                [TIMESTAMP_HEADER]: ts,
                [SIGNATURE_HEADER]: sign(cfg.webhookSecret, ts, row.payload),
              },
              body: row.payload,
              signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            ok.run(row.id);
          } catch (e) {
            const delay = Math.min(60 * 60_000, 1000 * 2 ** row.attempts);
            bad.run(Date.now() + delay, String((e as Error).message ?? e), row.id);
          }
        }
      }
    } finally {
      running = false;
    }
  }

  bus.on('outbox', () => void drain());
  timer = setInterval(() => void drain(), 5000);
  timer.unref();
  void drain();
  return { drain, stop: () => clearInterval(timer) };
}
