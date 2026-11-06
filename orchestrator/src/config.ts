import { resolve } from 'node:path';

function int(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export type OrchConfig = ReturnType<typeof loadOrchConfig>;

export function loadOrchConfig() {
  const repo = resolve(req('TARGET_REPO'));
  return {
    port: int('ORCH_PORT', 4100),
    appUrl: req('STALL_APP_URL').replace(/\/$/, ''),
    appToken: req('STALL_ORCH_TOKEN'),
    webhookSecret: req('STALL_WEBHOOK_SECRET'),
    dataDir: resolve(process.env.ORCH_DATA_DIR ?? 'data/orchestrator'),

    /** Git repo the lanes build features in. */
    repo,
    baseBranch: process.env.BASE_BRANCH ?? 'main',
    /** If set (e.g. "origin"), lanes branch from <remote>/<base> and the integration lane pushes there. */
    remote: process.env.GIT_REMOTE ?? '',
    worktreeRoot: resolve(process.env.WORKTREE_ROOT ?? `${repo}.stall-worktrees`),

    workerLanes: int('WORKER_LANES', 4),
    /** Run in each new worktree before Claude starts (e.g. "npm ci"). */
    setupCmd: process.env.WORKTREE_SETUP_CMD ?? '',
    /** Integration lane checks. Empty = skipped. */
    buildCmd: process.env.BUILD_CMD ?? '',
    testCmd: process.env.TEST_CMD ?? '',
    checkTimeoutMs: int('CHECK_TIMEOUT_SEC', 1200) * 1000,
    /** How many times integration can bounce a branch back to a worker before it fails. */
    maxRework: int('MAX_REWORK', 2),

    agent: (process.env.AGENT ?? 'claude') as 'claude' | 'mock',
    model: process.env.CLAUDE_MODEL || undefined,
    maxTurns: int('CLAUDE_MAX_TURNS', 200),
    maxBudgetUsd: process.env.CLAUDE_MAX_BUDGET_USD ? Number(process.env.CLAUDE_MAX_BUDGET_USD) : undefined,

    pollMs: int('POLL_INTERVAL_SEC', 30) * 1000,
  };
}
