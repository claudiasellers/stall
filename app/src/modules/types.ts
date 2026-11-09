// The contract every feature module implements. See docs/ARCHITECTURE.md.
import type { Router } from 'express';
import type { EventEmitter } from 'node:events';
import type { Db } from '../db.ts';
import type { AppConfig } from '../config.ts';
import type { Service } from '../service.ts';
import type { House } from '../house.ts';
import type { Storage } from '../storage.ts';

export type ModuleCtx = {
  db: Db;
  cfg: AppConfig;
  /** notify(userId, null, body, link) / notifyMembers(body, link, exceptId) / admins() */
  svc: Service;
  /** Live updates: emit('board') refreshes open screens; emit(`user:${id}`, ...) is per user. */
  bus: EventEmitter;
  /** Current house settings (read fresh on each call). */
  house: () => House;
  storage: Storage;
};

export type RemovalPolicy = 'keep' | 'anonymize' | 'delete';

export type StallModule = {
  name: string;
  /** Append-only. Ids are '<name>-NNN'. Applied once each, in registry order. */
  migrations: { id: string; sql: string }[];
  /** Mounted at /api/v1 behind requireMember + CSRF. Use your own path prefix. */
  routes?: (ctx: ModuleCtx) => Router;
  /**
   * Unauthenticated routes (guest links only), mounted at /api/v1/public. Never expose
   * archive, lore or member data here: a guest sees one event card.
   */
  publicRoutes?: (ctx: ModuleCtx) => Router;
  /** Called by POST /api/v1/tick (outside cron pinger) and every minute while awake. Must be idempotent. */
  tick?: (ctx: ModuleCtx) => Promise<void> | void;
  /** Called inside the removal transaction: keep / anonymize / delete this member's content. */
  onMemberRemoved?: (ctx: ModuleCtx, userId: number, policy: RemovalPolicy) => void;
};
