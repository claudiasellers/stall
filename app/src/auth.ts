import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { Request, Response, NextFunction } from 'express';
import { type Db, tx, now } from './db.ts';
import { HttpError } from './service.ts';
import { clock } from './clock.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const COOKIE = 'stall_session';

export type User = { id: number; username: string; is_admin: number; display_name: string | null; emoji: string | null };

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

export const INVITE_TTL_DAYS_DEFAULT = 7;
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

/** A human-typeable single-use code, e.g. STALL-7KQ2-XM9P-RT. Only its hash is stored. */
export function newInviteCode(): string {
  const bytes = randomBytes(10);
  const chars = [...bytes].map((b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join('');
  return `STALL-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

/** Normalize what people type: case, spaces, missing dashes. */
export function normalizeInviteCode(code: string): string {
  const raw = code.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^STALL/, '');
  if (raw.length !== 10) return '';
  return `STALL-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

export const hashInvite = (code: string) => hashToken(`invite:${normalizeInviteCode(code)}`);

const BAD_INVITE = 'That invite code doesn’t work. Ask whoever invited you for a fresh one.';

export type SignupInput = { username: string; password: string; code: string; displayName?: string; emoji?: string };

export function validateProfile(displayName: string | undefined, emoji: string | undefined) {
  const name = (displayName ?? '').trim();
  if (name.length > 40) throw new HttpError(400, 'Display name must be 40 characters or fewer');
  const em = (emoji ?? '').trim();
  if (em && ([...new Intl.Segmenter().segment(em)].length > 2 || em.length > 16)) throw new HttpError(400, 'Pick one emoji');
  return { name: name || null, emoji: em || null };
}

/**
 * Invite-only: every account needs a valid single-use invite code. The very first
 * account (no users yet) needs the one-time bootstrap code from the server's
 * environment instead, and becomes the admin.
 */
export async function signup(db: Db, input: SignupInput, bootstrapCode: string): Promise<User> {
  const { username, password } = input;
  validateCredentials(username, password);
  const profile = validateProfile(input.displayName, input.emoji);
  const hash = await hashPassword(password);
  return tx(db, () => {
    const isFirst = !db.prepare('SELECT 1 FROM users LIMIT 1').get();
    let inviteId: number | null = null;
    if (isFirst) {
      const given = input.code.trim();
      if (!bootstrapCode || given.length !== bootstrapCode.length || !timingSafeEqual(Buffer.from(given), Buffer.from(bootstrapCode)))
        throw new HttpError(403, bootstrapCode ? BAD_INVITE : 'Stall isn’t set up yet: the server needs STALL_BOOTSTRAP_CODE.');
    } else {
      const inv = db
        .prepare('SELECT id FROM invites WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?')
        .get(hashInvite(input.code), now()) as { id: number } | undefined;
      if (!inv) throw new HttpError(403, BAD_INVITE);
      inviteId = inv.id;
    }
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is taken');
    const res = db
      .prepare('INSERT INTO users (username, password_hash, is_admin, display_name, emoji, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(username, hash, isFirst ? 1 : 0, profile.name, profile.emoji, now());
    const id = Number(res.lastInsertRowid);
    if (inviteId !== null) {
      const used = db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE id = ? AND used_at IS NULL').run(id, now(), inviteId);
      if (used.changes !== 1) throw new HttpError(403, BAD_INVITE);
    }
    return { id, username, is_admin: isFirst ? 1 : 0, display_name: profile.name, emoji: profile.emoji };
  });
}

export async function login(db: Db, username: string, password: string): Promise<User | null> {
  const row = db
    .prepare('SELECT id, username, is_admin, display_name, emoji, password_hash FROM users WHERE username = ? AND removed_at IS NULL')
    .get(username) as
    | (User & { password_hash: string })
    | undefined;
  if (!row) {
    dummyHash ??= hashPassword('not-a-real-password');
    await verifyPassword(password, await dummyHash);
    return null;
  }
  if (!(await verifyPassword(password, row.password_hash))) return null;
  return { id: row.id, username: row.username, is_admin: row.is_admin, display_name: row.display_name, emoji: row.emoji };
}

export function createSession(db: Db, userId: number): { token: string; csrf: string } {
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO sessions (id, user_id, csrf, expires_at) VALUES (?, ?, ?, ?)').run(
    hashToken(token),
    userId,
    csrf,
    clock.now() + SESSION_TTL_MS,
  );
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(clock.now());
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
    `SELECT u.id, u.username, u.is_admin, u.display_name, u.emoji, s.csrf FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ? AND u.removed_at IS NULL`,
  );
  return (req: Request, _res: Response, next: NextFunction) => {
    const auth = req.headers.authorization;
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
    const token = bearer ?? readCookie(req, COOKIE);
    if (token) {
      const row = stmt.get(hashToken(token), clock.now()) as (User & { csrf: string }) | undefined;
      if (row) {
        req.user = { id: row.id, username: row.username, is_admin: row.is_admin, display_name: row.display_name, emoji: row.emoji };
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
