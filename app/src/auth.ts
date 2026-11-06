import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { Request, Response, NextFunction } from 'express';
import { type Db, tx } from './db.ts';
import { HttpError } from './service.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const COOKIE = 'stall_session';

export type User = { id: number; username: string; is_admin: number };

declare module 'express-serve-static-core' {
  interface Request {
    user?: User;
    csrf?: string;
    /** 'cookie' for the browser app, 'bearer' for native/API clients (no CSRF needed). */
    authVia?: 'cookie' | 'bearer';
  }
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, key] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return timingSafeEqual(expected, got);
}

// A real hash to compare against when the username doesn't exist, so timing doesn't leak it.
let dummyHash: Promise<string> | undefined;

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export function validateCredentials(username: string, password: string) {
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username))
    throw new HttpError(400, 'Username must be 3–32 characters: letters, numbers, _ . -');
  if (password.length < 8 || password.length > 200) throw new HttpError(400, 'Password must be at least 8 characters');
}

export async function signup(db: Db, username: string, password: string): Promise<User> {
  validateCredentials(username, password);
  const hash = await hashPassword(password);
  return tx(db, () => {
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is taken');
    const isFirst = !(db.prepare('SELECT 1 FROM users LIMIT 1').get());
    const res = db
      .prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)')
      .run(username, hash, isFirst ? 1 : 0);
    return { id: Number(res.lastInsertRowid), username, is_admin: isFirst ? 1 : 0 };
  });
}

export async function login(db: Db, username: string, password: string): Promise<User | null> {
  const row = db.prepare('SELECT id, username, is_admin, password_hash FROM users WHERE username = ?').get(username) as
    | (User & { password_hash: string })
    | undefined;
  if (!row) {
    dummyHash ??= hashPassword('not-a-real-password');
    await verifyPassword(password, await dummyHash);
    return null;
  }
  if (!(await verifyPassword(password, row.password_hash))) return null;
  return { id: row.id, username: row.username, is_admin: row.is_admin };
}

export function createSession(db: Db, userId: number): { token: string; csrf: string } {
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO sessions (id, user_id, csrf, expires_at) VALUES (?, ?, ?, ?)').run(
    hashToken(token),
    userId,
    csrf,
    Date.now() + SESSION_TTL_MS,
  );
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  return { token, csrf };
}

export function destroySession(db: Db, token: string | undefined) {
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(hashToken(token));
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function setSessionCookie(res: Response, token: string, secure: boolean) {
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, maxAge: SESSION_TTL_MS, path: '/' });
}

/** Attaches req.user / req.csrf when a valid session cookie is present. */
export function sessionMiddleware(db: Db) {
  const stmt = db.prepare(
    `SELECT u.id, u.username, u.is_admin, s.csrf FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ?`,
  );
  return (req: Request, _res: Response, next: NextFunction) => {
    const auth = req.headers.authorization;
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
    const token = bearer ?? readCookie(req, COOKIE);
    if (token) {
      const row = stmt.get(hashToken(token), Date.now()) as (User & { csrf: string }) | undefined;
      if (row) {
        req.user = { id: row.id, username: row.username, is_admin: row.is_admin };
        req.csrf = row.csrf;
        req.authVia = bearer ? 'bearer' : 'cookie';
      }
    }
    next();
  };
}

export function requireUser(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) throw new HttpError(401, 'Sign in first');
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user?.is_admin) throw new HttpError(403, 'Admins only');
  next();
}

/** Every state-changing cookie-authenticated request must echo the session's CSRF token. */
export function checkCsrf(req: Request, _res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.authVia !== 'cookie') return next();
  const given = req.headers['x-csrf-token'] as string | undefined;
  if (!req.csrf || !given || given.length !== req.csrf.length || !timingSafeEqual(Buffer.from(given), Buffer.from(req.csrf)))
    throw new HttpError(403, 'Your session expired. Reload the page and try again.');
  next();
}

/** Small in-memory limiter for login/signup attempts. */
export function rateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string) => {
    const t = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < t) {
      hits.set(key, { n: 1, reset: t + windowMs });
      if (hits.size > 10000) for (const [k, v] of hits) if (v.reset < t) hits.delete(k);
      return true;
    }
    h.n++;
    return h.n <= limit;
  };
}
