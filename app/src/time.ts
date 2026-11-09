// Wall-clock helpers for the house time zone (the group lives in one city), using
// only Intl so there is no time-zone database dependency. DST-safe.

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function zonedParts(ms: number, tz: string): Parts {
  const out: Record<string, number> = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return { year: out.year, month: out.month, day: out.day, hour: out.hour % 24, minute: out.minute, second: out.second };
}

/** Offset of tz from UTC at instant ms, in ms (e.g. -4h for New York in summer). */
function offsetAt(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The UTC instant for a wall-clock time in tz. Nonexistent times (spring forward) roll forward. */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ms = guess - offsetAt(guess, tz);
  // A second pass settles instants near a DST change.
  ms = guess - offsetAt(ms, tz);
  return ms;
}

/** The next time the house clock reads hour:00 strictly after ms. */
export function nextLocalHour(ms: number, hour: number, tz: string): number {
  const p = zonedParts(ms, tz);
  let at = zonedToUtc(p.year, p.month, p.day, hour, 0, tz);
  if (at <= ms) {
    // Tomorrow, by calendar day in tz (not +24h, which drifts across DST).
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
    at = zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hour, 0, tz);
  }
  return at;
}
