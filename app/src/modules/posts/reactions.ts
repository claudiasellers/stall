// Generic emoji reactions. Any feature can hang reactions off its rows by picking a
// target_type ('post', 'media', 'event', ...). Reads are batched: one query for a
// whole page of targets, never one per card.
import { type Db } from '../../db.ts';
import { HttpError } from '../../service.ts';

/** The quick-pick set shown on cards. 🙏 is absolution on regrets. */
export const REACTION_EMOJI = ['😂', '💀', '🔥', '😭', '🙏', '👀', '❤️', '🫠', '🚩', '🐐'] as const;
const ALLOWED = new Set<string>(REACTION_EMOJI);

export type ReactionSummary = { emoji: string; count: number; mine: boolean };

export function toggleReaction(db: Db, targetType: string, targetId: number, userId: number, emoji: string): boolean {
  if (!ALLOWED.has(emoji)) throw new HttpError(400, 'Pick one of the reaction emoji');
  const del = db
    .prepare('DELETE FROM reactions WHERE target_type = ? AND target_id = ? AND user_id = ? AND emoji = ?')
    .run(targetType, targetId, userId, emoji);
  if (del.changes > 0) return false;
  db.prepare('INSERT INTO reactions (target_type, target_id, user_id, emoji) VALUES (?, ?, ?, ?)').run(targetType, targetId, userId, emoji);
  return true;
}

/** Reaction counts for many targets at once, in REACTION_EMOJI order. */
export function reactionsFor(db: Db, targetType: string, ids: number[], viewerId: number): Map<number, ReactionSummary[]> {
  const out = new Map<number, ReactionSummary[]>();
  if (!ids.length) return out;
  const rows = db
    .prepare(
      `SELECT target_id, emoji, COUNT(*) AS n, MAX(user_id = ?) AS mine
       FROM reactions WHERE target_type = ? AND target_id IN (${ids.map(() => '?').join(',')})
       GROUP BY target_id, emoji`,
    )
    .all(viewerId, targetType, ...ids) as { target_id: number; emoji: string; n: number; mine: number }[];
  const order = (e: string) => {
    const i = (REACTION_EMOJI as readonly string[]).indexOf(e);
    return i === -1 ? 99 : i;
  };
  for (const r of rows) {
    const list = out.get(r.target_id) ?? [];
    list.push({ emoji: r.emoji, count: r.n, mine: !!r.mine });
    out.set(r.target_id, list);
  }
  for (const list of out.values()) list.sort((a, b) => order(a.emoji) - order(b.emoji));
  return out;
}

export function countReactions(db: Db, targetType: string, targetId: number, emoji: string, excludeUserId?: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM reactions WHERE target_type = ? AND target_id = ? AND emoji = ? AND user_id != ?`,
      )
      .get(targetType, targetId, emoji, excludeUserId ?? -1) as { n: number }
  ).n;
}

/** Hard-delete reactions whose targets are gone (used after purges and deletes). */
export function deleteReactionsFor(db: Db, targetType: string, ids: number[]) {
  if (!ids.length) return;
  db.prepare(`DELETE FROM reactions WHERE target_type = ? AND target_id IN (${ids.map(() => '?').join(',')})`).run(targetType, ...ids);
}
