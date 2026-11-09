// Membership: invites, profiles, removal. One group per deployment (see docs/PLAN.md D1):
// a member is a user row with removed_at IS NULL.
import { type Db, tx, now } from './db.ts';
import { HttpError } from './service.ts';
import { clock } from './clock.ts';
import { newInviteCode, hashInvite, validateProfile, INVITE_TTL_DAYS_DEFAULT } from './auth.ts';
import type { ModuleCtx, RemovalPolicy } from './modules/types.ts';
import { MODULES } from './modules/index.ts';

export type MemberRow = { id: number; username: string; display_name: string | null; emoji: string | null; is_admin: number; created_at: string };

export const nameOf = (u: { username: string; display_name: string | null }) => u.display_name || u.username;

export function publicMember(u: MemberRow) {
  return { id: u.id, username: u.username, name: nameOf(u), emoji: u.emoji || '🙂', isAdmin: !!u.is_admin, joinedAt: u.created_at };
}

export function listMembers(db: Db): MemberRow[] {
  return db
    .prepare('SELECT id, username, display_name, emoji, is_admin, created_at FROM users WHERE removed_at IS NULL ORDER BY COALESCE(display_name, username) COLLATE NOCASE')
    .all() as MemberRow[];
}

export function getMember(db: Db, id: number): MemberRow | undefined {
  return db.prepare('SELECT id, username, display_name, emoji, is_admin, created_at FROM users WHERE id = ? AND removed_at IS NULL').get(id) as MemberRow | undefined;
}

export function updateProfile(db: Db, userId: number, displayName: unknown, emoji: unknown) {
  const p = validateProfile(typeof displayName === 'string' ? displayName : undefined, typeof emoji === 'string' ? emoji : undefined);
  db.prepare('UPDATE users SET display_name = ?, emoji = ? WHERE id = ?').run(p.name, p.emoji, userId);
  return getMember(db, userId)!;
}

// ---------------- invites

export function createInvite(db: Db, adminId: number, note: unknown, ttlDays: unknown) {
  const days = ttlDays === undefined || ttlDays === null || ttlDays === '' ? INVITE_TTL_DAYS_DEFAULT : Number(ttlDays);
  if (!Number.isFinite(days) || days < 1 || days > 30) throw new HttpError(400, 'Invites last 1 to 30 days');
  const code = newInviteCode();
  const expiresAt = clock.iso(clock.now() + days * 86400_000);
  const n = typeof note === 'string' ? note.trim().slice(0, 80) || null : null;
  db.prepare('INSERT INTO invites (code_hash, created_by, note, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').run(hashInvite(code), adminId, n, expiresAt, now());
  return { code, expiresAt, note: n };
}

export function listInvites(db: Db) {
  const rows = db
    .prepare(
      `SELECT i.id, i.note, i.expires_at, i.used_at, i.revoked_at, i.created_at,
         COALESCE(c.display_name, c.username) AS created_by_name, COALESCE(u.display_name, u.username) AS used_by_name
       FROM invites i LEFT JOIN users c ON c.id = i.created_by LEFT JOIN users u ON u.id = i.used_by
       ORDER BY i.id DESC LIMIT 100`,
    )
    .all() as { id: number; note: string | null; expires_at: string; used_at: string | null; revoked_at: string | null; created_at: string; created_by_name: string | null; used_by_name: string | null }[];
  const t = now();
  return rows.map((r) => ({
    id: r.id,
    note: r.note,
    createdBy: r.created_by_name,
    usedBy: r.used_by_name,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    status: r.used_at ? 'used' : r.revoked_at ? 'revoked' : r.expires_at <= t ? 'expired' : 'active',
  }));
}

export function revokeInvite(db: Db, id: number) {
  const res = db.prepare('UPDATE invites SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL').run(now(), id);
  if (!res.changes) throw new HttpError(409, 'That invite is already used, revoked or gone');
}

// ---------------- removal

export type { RemovalPolicy };

/**
 * Remove a member. Sessions and push subscriptions die immediately. Their posts are
 * kept, anonymized, or deleted (with their photos), per the admin's choice.
 */
export function removeMember(ctx: ModuleCtx, actorId: number, targetId: number, policy: RemovalPolicy) {
  const { db } = ctx;
  if (!['keep', 'anonymize', 'delete'].includes(policy)) throw new HttpError(400, 'Pick keep, anonymize or delete');
  if (actorId === targetId) throw new HttpError(409, 'You can’t remove yourself. Ask another admin.');
  tx(db, () => {
    const u = getMember(db, targetId);
    if (!u) throw new HttpError(404, 'No such member');
    db.prepare("UPDATE users SET removed_at = ?, is_admin = 0, password_hash = '!' WHERE id = ?").run(now(), targetId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(targetId);
    if (policy !== 'keep') db.prepare('DELETE FROM feed_items WHERE actor_id = ?').run(targetId);
    if (policy === 'delete') {
      db.prepare('DELETE FROM reactions WHERE user_id = ?').run(targetId);
      db.prepare('DELETE FROM ballots WHERE user_id = ?').run(targetId);
    }
    for (const m of MODULES) m.onMemberRemoved?.(ctx, targetId, policy);
  });
}
