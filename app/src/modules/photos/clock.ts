// House-clock helpers (tz = cfg.houseTz, hour = house.photoUnlockHour) for the disposable camera. A "night" runs from 06:00 to
// 05:59 local time and is named by the date it started on, so a 2am photo
// belongs to the previous evening. A roll develops at PHOTO_UNLOCK_HOUR (11:00)
// local on the morning after its night. Everything is computed at read time,
// so changing the hour or the time zone re-times every roll at once.

const NIGHT_ROLLOVER_HOUR = 6;

function parts(t: number, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(t))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year, m: o.month, d: o.day, h: o.hour, min: o.minute, s: o.second };
}

/** Milliseconds the zone is ahead of UTC at instant t. */
function offset(t: number, tz: string): number {
  const p = parts(t, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(t / 1000) * 1000;
}

/** UTC instant of a wall-clock time in tz (DST-safe for the hours we use). */
export function zonedToUtc(y: number, m: number, d: number, h: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h);
  let t = guess - offset(guess, tz);
  t = guess - offset(t, tz);
  return t;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar date (YYYY-MM-DD) of instant t. */
export function localDate(t: number, tz: string): string {
  const p = parts(t, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** The night an instant belongs to, named by its starting date. */
export function nightOf(t: number, tz: string): string {
  return localDate(t - NIGHT_ROLLOVER_HOUR * 3600_000, tz);
}

/** When a night's roll develops: unlockHour local on the following day. */
export function unlockAt(night: string, tz: string, unlockHour: number): number {
  const [y, m, d] = night.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), unlockHour, tz);
}

/** "MM-DD" of a night, for "N years ago tonight". */
export const monthDay = (night: string) => night.slice(5);
