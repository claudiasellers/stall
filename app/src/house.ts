// House settings: the group's own rules, editable by admins in the Admin tab.
// Stored in the settings table under "house:<key>"; defaults come from the idea plan.
import type { Db } from './db.ts';
import { HttpError } from './service.ts';

export const HOUSE_DEFAULTS = {
  /** Local hour when last night's photos unlock ("the roll is developed"). */
  photoUnlockHour: 11,
  /** Regrets self-destruct after this many hours unless the author keeps them. 0 = keep by default. */
  regretTtlHours: 24,
  /** How long a plus-one vote stays open. */
  plusOneVoteMinutes: 60,
  /** Default: the address shows this many hours before the start. */
  locationRevealHours: 2,
  /** Spontaneous "out right now" events vanish after this many hours. */
  spontaneousHours: 4,
  /** A regret with this many 🙏 is forgiven. */
  forgiveThreshold: 3,
  /** Plus-one votes: minimum yes votes, and the share of yes needed. */
  plusOneMinYes: 2,
  plusOneRatio: 0.6,
} as const;

export type House = { -readonly [K in keyof typeof HOUSE_DEFAULTS]: number };

const LIMITS: Record<keyof House, [number, number]> = {
  photoUnlockHour: [0, 23],
  regretTtlHours: [0, 24 * 30],
  plusOneVoteMinutes: [5, 24 * 60],
  locationRevealHours: [0, 72],
  spontaneousHours: [1, 12],
  forgiveThreshold: [1, 50],
  plusOneMinYes: [1, 50],
  plusOneRatio: [0.01, 1],
};

export function getHouse(db: Db): House {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'house:%'").all() as { key: string; value: string }[];
  const out: House = { ...HOUSE_DEFAULTS };
  for (const r of rows) {
    const k = r.key.slice(6) as keyof House;
    if (k in out && Number.isFinite(Number(r.value))) out[k] = Number(r.value);
  }
  return out;
}

export function setHouse(db: Db, patch: Record<string, unknown>): House {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in LIMITS)) throw new HttpError(400, `Unknown setting ${k}`);
    const n = Number(v);
    const [lo, hi] = LIMITS[k as keyof House];
    if (!Number.isFinite(n) || n < lo || n > hi) throw new HttpError(400, `${k} must be between ${lo} and ${hi}`);
    if (k !== 'plusOneRatio' && !Number.isInteger(n)) throw new HttpError(400, `${k} must be a whole number`);
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(`house:${k}`, String(n));
  }
  return getHouse(db);
}
