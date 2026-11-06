// Web Push: phone notifications for the installed web app (iOS 16.4+ once added
// to the Home Screen, Android/desktop Chrome, Firefox, Safari).
import * as webpush from 'web-push';
import type { Db } from './db.ts';
import type { AppConfig } from './config.ts';
import { bus } from './service.ts';

export function pushEnabled(cfg: AppConfig) {
  return Boolean(cfg.vapidPublicKey && cfg.vapidPrivateKey);
}

/**
 * Use VAPID keys from the environment, or create a pair once and keep it in the
 * database, so phone alerts work on a fresh deploy with no setup.
 */
export function ensureVapidKeys(db: Db, cfg: AppConfig) {
  if (pushEnabled(cfg) || process.env.DISABLE_PUSH === 'true') return;
  const get = (k: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined)?.value;
  let pub = get('vapid_public');
  let priv = get('vapid_private');
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('vapid_public', keys.publicKey);
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('vapid_private', keys.privateKey);
    pub = keys.publicKey;
    priv = keys.privateKey;
    console.log('[stall] generated Web Push keys and saved them in the database');
  }
  cfg.vapidPublicKey = pub;
  cfg.vapidPrivateKey = priv;
}

export function startPush(db: Db, cfg: AppConfig) {
  if (!pushEnabled(cfg)) {
    console.log('[stall] Web Push disabled');
    return;
  }
  webpush.setVapidDetails(cfg.vapidSubject, cfg.vapidPublicKey, cfg.vapidPrivateKey);
  const subs = db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?');
  const drop = db.prepare('DELETE FROM push_subscriptions WHERE id = ?');
  const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL');

  bus.on('notify', async ({ userId, requestId, body }: { userId: number; requestId: number | null; body: string }) => {
    const badge = (unread.get(userId) as { n: number }).n;
    const payload = JSON.stringify({
      title: 'Stall',
      body,
      url: requestId ? `/#/requests/${requestId}` : '/#/notifications',
      tag: requestId ? `request-${requestId}` : undefined,
      badge,
    });
    for (const s of subs.all(userId) as { id: number; endpoint: string; p256dh: string; auth: string }[]) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 24 * 3600 });
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) drop.run(s.id); // subscription expired / revoked
        else console.warn('[stall] push failed', code ?? e);
      }
    }
  });
}

export function saveSubscription(db: Db, userId: number, sub: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }) {
  if (!sub?.endpoint?.startsWith('https://') || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('Bad subscription');
  db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
  ).run(userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth);
}

export function removeSubscription(db: Db, userId: number, endpoint: string) {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
}
