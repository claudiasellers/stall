// Photo storage. Cloudflare R2 (S3 API) in production: the phone uploads straight to
// R2 with a presigned PUT, and photos are read through presigned GETs that expire in
// 10 minutes, so image bytes never pass through the app server. Without R2 settings,
// files go to local disk behind HMAC-signed app URLs (development and tests).
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AppConfig } from './config.ts';
import { clock } from './clock.ts';

export const READ_TTL_SEC = 600;
const UPLOAD_TTL_SEC = 900;
export const MAX_PHOTO_BYTES = 12 * 1024 * 1024;

export interface Storage {
  kind: 'r2' | 'local';
  uploadTarget(key: string, mime: string): { url: string; method: 'PUT'; headers: Record<string, string> };
  readUrl(key: string): string;
  size(key: string): Promise<number | null>;
  delete(key: string): Promise<void>;
}

// ---------------- AWS Signature V4 presigning (query-string auth)

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

export function presign(o: {
  method: string; host: string; path: string; region: string; service?: string;
  accessKeyId: string; secretAccessKey: string; expiresSec: number; at?: Date; scheme?: string;
}): string {
  const service = o.service ?? 's3';
  const at = o.at ?? new Date(clock.now());
  const amzDate = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${o.region}/${service}/aws4_request`;
  const q: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${o.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(o.expiresSec),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(q).sort().map((k) => `${enc(k)}=${enc(q[k])}`).join('&');
  const canonicalPath = o.path.split('/').map(enc).join('/');
  const canonical = [o.method, canonicalPath, canonicalQuery, `host:${o.host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  let k = hmac(`AWS4${o.secretAccessKey}`, date);
  k = hmac(k, o.region);
  k = hmac(k, service);
  k = hmac(k, 'aws4_request');
  const sig = createHmac('sha256', k).update(toSign).digest('hex');
  return `${o.scheme ?? 'https'}://${o.host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${sig}`;
}

function r2Storage(cfg: AppConfig): Storage {
  const r2 = cfg.r2;
  const endpoint = new URL(r2.endpoint || `https://${r2.accountId}.r2.cloudflarestorage.com`);
  const sign = (method: string, key: string, expiresSec: number) =>
    presign({
      method, host: endpoint.host, path: `/${r2.bucket}/${key}`, region: 'auto', scheme: endpoint.protocol.replace(':', ''),
      accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey, expiresSec,
    });
  return {
    kind: 'r2',
    uploadTarget: (key, mime) => ({ url: sign('PUT', key, UPLOAD_TTL_SEC), method: 'PUT', headers: { 'Content-Type': mime } }),
    readUrl: (key) => sign('GET', key, READ_TTL_SEC),
    async size(key) {
      const res = await fetch(sign('HEAD', key, 60), { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`R2 HEAD ${res.status}`);
      return Number(res.headers.get('content-length') ?? 0);
    },
    async delete(key) {
      const res = await fetch(sign('DELETE', key, 60), { method: 'DELETE', signal: AbortSignal.timeout(10_000) });
      if (!res.ok && res.status !== 404) throw new Error(`R2 DELETE ${res.status}`);
    },
  };
}

// ---------------- local disk

export function localSig(secret: string, method: string, key: string, exp: number) {
  return createHmac('sha256', secret).update(`${method}\n${key}\n${exp}`).digest('base64url');
}

export function checkLocalSig(secret: string, method: string, key: string, exp: string, sig: string): boolean {
  if (!/^\d+$/.test(exp) || Number(exp) * 1000 < clock.now()) return false;
  const want = Buffer.from(localSig(secret, method, key, Number(exp)));
  const got = Buffer.from(String(sig));
  return want.length === got.length && timingSafeEqual(want, got);
}

export function localPath(cfg: AppConfig, key: string): string {
  if (!/^m\/[a-f0-9]{32}\.(jpg|png|webp|heic)$/.test(key)) throw new Error('bad key');
  const root = resolve(cfg.mediaDir);
  const p = resolve(join(root, key));
  if (!p.startsWith(root + '/')) throw new Error('bad key');
  return p;
}

function localStorage(cfg: AppConfig): Storage {
  const secret = cfg.mediaSecret || (cfg.mediaSecret = randomBytes(32).toString('hex'));
  const url = (method: string, key: string, ttl: number) => {
    const exp = Math.floor(clock.now() / 1000) + ttl;
    return `/api/v1/blob/${key}?exp=${exp}&sig=${localSig(secret, method, key, exp)}`;
  };
  return {
    kind: 'local',
    uploadTarget: (key, mime) => {
      mkdirSync(dirname(localPath(cfg, key)), { recursive: true });
      return { url: url('PUT', key, UPLOAD_TTL_SEC), method: 'PUT', headers: { 'Content-Type': mime } };
    },
    readUrl: (key) => url('GET', key, READ_TTL_SEC),
    async size(key) {
      try {
        return statSync(localPath(cfg, key)).size;
      } catch {
        return null;
      }
    },
    async delete(key) {
      try {
        unlinkSync(localPath(cfg, key));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    },
  };
}

export function createStorage(cfg: AppConfig): Storage {
  const r2 = cfg.r2;
  if (r2.accessKeyId && r2.secretAccessKey && r2.bucket && (r2.accountId || r2.endpoint)) return r2Storage(cfg);
  return localStorage(cfg);
}

/** Queue a stored file for deletion; the tick retries until it's gone. Call inside your transaction. */
export function queueStorageDelete(db: import('./db.ts').Db, key: string) {
  db.prepare('INSERT OR IGNORE INTO storage_deletes (storage_key) VALUES (?)').run(key);
}

/** Drain the delete queue (called from the tick). */
export async function drainStorageDeletes(db: import('./db.ts').Db, storage: Storage) {
  const rows = db.prepare('SELECT storage_key FROM storage_deletes WHERE attempts < 50 LIMIT 100').all() as { storage_key: string }[];
  for (const r of rows) {
    try {
      await storage.delete(r.storage_key);
      db.prepare('DELETE FROM storage_deletes WHERE storage_key = ?').run(r.storage_key);
    } catch (e) {
      db.prepare('UPDATE storage_deletes SET attempts = attempts + 1, last_error = ? WHERE storage_key = ?').run(String((e as Error).message ?? e), r.storage_key);
    }
  }
}
