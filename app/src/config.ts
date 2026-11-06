function int(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer`);
  return n;
}

function ratio(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!(n > 0 && n <= 1)) throw new Error(`${name} must be in (0, 1]`);
  return n;
}

export type AppConfig = ReturnType<typeof loadAppConfig>;

export function loadAppConfig() {
  const cfg = {
    port: int('PORT', 3000),
    dbPath: process.env.STALL_DB ?? 'data/stall.db',
    /** Hosted database (Turso). When set, STALL_DB is ignored. */
    tursoUrl: process.env.TURSO_DATABASE_URL ?? '',
    tursoToken: process.env.TURSO_AUTH_TOKEN ?? '',
    publicUrl: process.env.STALL_PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? `http://localhost:${int('PORT', 3000)}`,
    cookieSecure: process.env.COOKIE_SECURE === 'true',
    allowSignup: process.env.ALLOW_SIGNUP !== 'false',
    /** Bearer token the orchestrator uses to call /api/orch/*. */
    orchestratorToken: process.env.STALL_ORCH_TOKEN ?? '',
    /** Where queue events are POSTed. Empty = no push; the orchestrator still polls. */
    webhookUrl: process.env.STALL_WEBHOOK_URL ?? '',
    webhookSecret: process.env.STALL_WEBHOOK_SECRET ?? '',
    /**
     * Consensus rule: a proposal enters the build queue when it has at least
     * `voteMinUpvotes` upvotes AND at least `consensusRatio` of its votes are yes.
     * Admins can approve at any time. VOTE_MIN_UPVOTES=0 skips voting entirely.
     */
    voteMinUpvotes: int('VOTE_MIN_UPVOTES', 3),
    consensusRatio: ratio('CONSENSUS_RATIO', 0.7),
    /** Proposals with at least this many downvotes and no consensus are rejected. 0 = never auto-reject. */
    rejectMinDownvotes: int('REJECT_MIN_DOWNVOTES', 3),
    /** e.g. https://github.com/you/repo/commit/{sha} */
    /** Web Push (optional). Generate with `npx web-push generate-vapid-keys`. */
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? '',
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? '',
    vapidSubject: process.env.VAPID_SUBJECT ?? 'mailto:admin@example.com',
    commitUrlTemplate: process.env.COMMIT_URL_TEMPLATE ?? '',
  };
  if (!cfg.orchestratorToken) {
    console.warn('[stall] STALL_ORCH_TOKEN is not set: the orchestrator API is disabled.');
  }
  if (cfg.webhookUrl && !cfg.webhookSecret) {
    throw new Error('STALL_WEBHOOK_SECRET is required when STALL_WEBHOOK_URL is set');
  }
  return cfg;
}
