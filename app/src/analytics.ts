/**
 * Product analytics (Mixpanel), server-side only.
 *
 * Privacy rules this module enforces, so callers can't get them wrong:
 *  - Disabled (every call is a no-op) unless MIXPANEL_TOKEN and ANALYTICS_ID_SALT are both set.
 *  - No Mixpanel script ever runs in the browser: no autocapture, no session replay, no cookies.
 *  - Users are an opaque HMAC of their id (`u_<hex>`), never a username, nickname or db id.
 *  - Requests go out with `ip=0`, so Mixpanel does no IP geolocation (no city/region/country).
 *  - Only events in EVENTS are sent, with only the property keys listed for them.
 *  - Property values must be numbers, booleans, or short lowercase identifiers (/^[a-z0-9_]{1,40}$/).
 *    Free text cannot pass that check, so post bodies, quotes, regrets, captions, names, venues,
 *    locations and photo data can't leak even if a caller passes them by mistake.
 *  - No people profiles are created.
 *
 * Usage from a route or service:  track('rsvp_set', userId, { status: 'maybe_lying' });
 */
import { createHmac, randomUUID } from 'node:crypto';

/** Event catalog: event name -> allowed property keys. Add new events here (and to docs/ANALYTICS.md). */
export const EVENTS = {
  // accounts and sessions
  signed_up: ['via'], // via: 'invite' | 'bootstrap' (first admin)
  logged_in: [],
  app_opened: ['client'], // at most once per user per 30 minutes; client: 'web' | 'native'
  invite_created: [],
  invite_redeemed: [],
  profile_updated: [],
  push_enabled: [],
  member_removed: ['posts_policy'], // keep | anonymize | delete

  // events and RSVPs
  event_created: ['kind', 'has_stages', 'has_location_drop', 'recurring'], // kind: party | dinner | trip | game | spontaneous
  rsvp_set: ['status', 'previous_status'], // in | out | maybe_lying | afters_only | coming_late
  plus_one_requested: [],
  plus_one_decided: ['outcome'], // approved | rejected | expired
  bring_item_claimed: [],
  event_viewed: ['phase'], // upcoming | live | archive
  guest_rsvp: ['status'],

  // posts: quote | regret | hot_take | lost_item | canon | prophecy
  post_created: ['kind', 'anonymous', 'severity', 'self_destruct', 'has_event'],
  post_deleted: ['kind', 'reason'], // reason: author | admin | expired
  reaction_added: ['target_type'], // post | media | event
  quote_claimed: ['stance'], // stand_by | dispute
  regret_forgiven: [],

  // photos
  photo_uploaded: ['count'],
  photo_vetoed: [],
  album_unlocked: ['photo_count'], // server-side, when an event's roll develops
  album_viewed: [],
  caption_added: [],

  // night-of tools
  checkin_posted: [],
  next_move_poll_created: [],
  next_move_voted: [],
  cooked_meter_set: ['level'], // 1..10
  buddy_assigned: ['method'], // random | chosen | auto_cooked
  home_safe_tapped: ['minutes_after_cutoff'],
  home_safe_escalated: ['stage'], // buddy | group
  tab_entry_added: ['split_count'],
  tab_settled: [],
  lost_item_posted: [],
  lost_item_claimed: [],
  irish_goodbye_logged: [],

  // lore and court (votes reuse the ballot engine)
  ballot_cast: ['subject_type', 'value'], // subject_type: court_case | hot_take | plus_one | poll | feature
  court_case_filed: [],
  court_verdict: ['outcome'], // guilty | not_guilty

  // suggestion box (the Claude build pipeline)
  feature_suggested: [],
  feature_voted: ['value'], // up | down | clear
  feature_approved: ['by'], // admin | consensus
  feature_rejected: ['by'],
  feature_shipped: [],
} as const satisfies Record<string, readonly string[]>;

export type AnalyticsEvent = keyof typeof EVENTS;
type PropsFor<E extends AnalyticsEvent> = Partial<Record<(typeof EVENTS)[E][number], string | number | boolean>>;

const SAFE_STRING = /^[a-z0-9_]{1,40}$/;
const FLUSH_MS = 10_000;
const MAX_BATCH = 50; // Mixpanel /track accepts up to 50 events per request
const MAX_QUEUE = 2_000;
const APP_OPEN_WINDOW_MS = 30 * 60_000;

type MpEvent = { event: string; properties: Record<string, unknown> };

export type AnalyticsConfig = { token: string; salt: string; apiHost: string; debug: boolean };

export function loadAnalyticsConfig(env: NodeJS.ProcessEnv = process.env): AnalyticsConfig {
  return {
    token: env.MIXPANEL_TOKEN?.trim() ?? '',
    salt: env.ANALYTICS_ID_SALT?.trim() ?? '',
    apiHost: (env.MIXPANEL_API_HOST?.trim() || 'https://api.mixpanel.com').replace(/\/+$/, ''),
    debug: env.ANALYTICS_DEBUG === 'true',
  };
}

let cfg: AnalyticsConfig | null = null;
let queue: MpEvent[] = [];
let timer: NodeJS.Timeout | null = null;
let inflight: Promise<void> = Promise.resolve();
const lastAppOpen = new Map<number, number>();

/** Call once at startup. Safe to call with no Mixpanel settings: analytics stays off. */
export function initAnalytics(c: AnalyticsConfig = loadAnalyticsConfig()): boolean {
  if (!c.token) {
    cfg = null;
    return false;
  }
  if (!c.salt) {
    console.warn('[stall] MIXPANEL_TOKEN is set but ANALYTICS_ID_SALT is not: analytics stays off.');
    cfg = null;
    return false;
  }
  cfg = c;
  if (!timer) {
    timer = setInterval(() => void flushAnalytics(), FLUSH_MS);
    timer.unref();
    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
      process.once(sig, () => {
        void flushAnalytics().finally(() => process.exit(0));
      });
    }
  }
  console.log('[stall] analytics: Mixpanel (server-side, ids hashed, ip=0)');
  return true;
}

export function analyticsEnabled(): boolean {
  return cfg !== null;
}

/** Opaque, stable id for a user. Not reversible without ANALYTICS_ID_SALT. */
export function analyticsId(userId: number, salt = cfg?.salt ?? ''): string {
  return 'u_' + createHmac('sha256', salt).update(`user:${userId}`).digest('hex').slice(0, 32);
}

/** Keeps only allowlisted keys with safe values. Exported for tests. */
export function sanitize(event: AnalyticsEvent, props: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
  const allowed: readonly string[] = EVENTS[event] ?? [];
  const out: Record<string, string | number | boolean> = {};
  if (!props) return out;
  for (const key of allowed) {
    const v = props[key];
    if (typeof v === 'boolean') out[key] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else if (typeof v === 'string' && SAFE_STRING.test(v)) out[key] = v;
  }
  return out;
}

/**
 * Record an event. Never throws and never blocks the request.
 * `userId` null means a server-side event with no member attached (e.g. album_unlocked).
 */
export function track<E extends AnalyticsEvent>(event: E, userId: number | null, props?: PropsFor<E>): void {
  if (!cfg) return;
  try {
    if (!(event in EVENTS)) return;
    const properties: Record<string, unknown> = {
      ...sanitize(event, props as Record<string, unknown>),
      token: cfg.token,
      time: Date.now(),
      $insert_id: randomUUID().replace(/-/g, ''),
      distinct_id: userId === null ? 'system' : analyticsId(userId),
    };
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push({ event, properties });
    if (cfg.debug) console.log('[stall] analytics', event, properties);
    if (queue.length >= MAX_BATCH) void flushAnalytics();
  } catch {
    // analytics must never break the app
  }
}

/** `app_opened`, deduplicated to once per user per 30 minutes. Feeds DAU/WAU and retention. */
export function trackAppOpen(userId: number, client: 'web' | 'native'): void {
  if (!cfg) return;
  const now = Date.now();
  const last = lastAppOpen.get(userId) ?? 0;
  if (now - last < APP_OPEN_WINDOW_MS) return;
  lastAppOpen.set(userId, now);
  if (lastAppOpen.size > 10_000) lastAppOpen.clear();
  track('app_opened', userId, { client });
}

/** Sends everything queued. Failed batches are dropped, not retried, to keep the free server light. */
export function flushAnalytics(): Promise<void> {
  if (!cfg || queue.length === 0) return inflight;
  const c = cfg;
  const batches: MpEvent[][] = [];
  while (queue.length) batches.push(queue.splice(0, MAX_BATCH));
  inflight = inflight.then(async () => {
    for (const batch of batches) {
      try {
        const res = await fetch(`${c.apiHost}/track?ip=0&verbose=1`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(batch),
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) console.warn(`[stall] analytics: Mixpanel returned ${res.status}, dropped ${batch.length} events`);
      } catch (err) {
        console.warn(`[stall] analytics: send failed (${(err as Error).name}), dropped ${batch.length} events`);
      }
    }
  });
  return inflight;
}

/** Test helper: inspect and clear the queue without sending. */
export function _drainForTest(): MpEvent[] {
  const q = queue;
  queue = [];
  return q;
}
