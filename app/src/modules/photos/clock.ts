// Night math for the disposable camera, on top of core house time (app/src/time.ts).
// A "night" runs 06:00 to 05:59 house time and is named by the date it started on,
// so a 2am photo belongs to the previous evening. A roll develops at
// house.photoUnlockHour (11:00) on the morning after its night. All read-time.
import { zonedParts, zonedToUtc } from '../../time.ts';

const NIGHT_ROLLOVER_HOUR = 6;
const pad = (n: number) => String(n).padStart(2, '0');

/** House calendar date (YYYY-MM-DD) of instant t. */
export function localDate(t: number, tz: string): string {
  const p = zonedParts(t, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** The night an instant belongs to, named by its starting date. */
export function nightOf(t: number, tz: string): string {
  return localDate(t - NIGHT_ROLLOVER_HOUR * 3600_000, tz);
}

/** When a night's roll develops: unlockHour house time on the following day. */
export function unlockAt(night: string, tz: string, unlockHour: number): number {
  const [y, m, d] = night.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), unlockHour, 0, tz);
}

/** "MM-DD" of a night, for "N years ago tonight". */
export const monthDay = (night: string) => night.slice(5);
