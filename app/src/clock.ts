// One clock for the whole server, so expiry, unlocks and timers can be tested
// deterministically. Production always uses the real time; tests (and the e2e run,
// with STALL_TEST_CLOCK=true) can shift it.
let offsetMs = 0;
let frozenAt: number | null = null;

export const clock = {
  now(): number {
    return frozenAt ?? Date.now() + offsetMs;
  },
  iso(ms?: number): string {
    return new Date(ms ?? clock.now()).toISOString();
  },
  /** Test only: jump to an absolute time (keeps ticking from there). */
  set(ms: number) {
    assertTestable();
    frozenAt = null;
    offsetMs = ms - Date.now();
  },
  /** Test only: move forward by ms. */
  advance(ms: number) {
    assertTestable();
    if (frozenAt !== null) frozenAt += ms;
    else offsetMs += ms;
  },
  reset() {
    offsetMs = 0;
    frozenAt = null;
  },
};

export function testClockEnabled() {
  return process.env.STALL_TEST_CLOCK === 'true' && process.env.NODE_ENV !== 'production';
}

function assertTestable() {
  if (process.env.NODE_ENV === 'production') throw new Error('The clock cannot be changed in production');
}

/** Parse a client-supplied time; returns a normalized ISO string or throws a message. */
export function parseTime(v: unknown, name: string): string {
  if (typeof v !== 'string' && typeof v !== 'number') throw new Error(`${name} is required`);
  const ms = typeof v === 'number' ? v : Date.parse(v);
  if (!Number.isFinite(ms)) throw new Error(`${name} is not a valid time`);
  return new Date(ms).toISOString();
}
