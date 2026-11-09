// Night-of tools module: Home Safe roll call + buddies, Where We At, Next Move,
// Cooked Meter, The Tab. Register with one line in app/src/modules/index.ts.
import { NIGHT_MIGRATIONS } from './schema.ts';
import { NightService, type NightCtx } from './service.ts';
import { nightRoutes } from './routes.ts';

// The registry's StallModule/ctx types live in foundation; NightCtx is the
// structural subset this module needs, so it type-checks against either.
const services = new WeakMap<object, NightService>();
const serviceFor = (ctx: NightCtx) => {
  let s = services.get(ctx.db);
  if (!s) services.set(ctx.db, (s = new NightService(ctx)));
  return s;
};

export const module = {
  name: 'night',
  migrations: NIGHT_MIGRATIONS,
  routes: (ctx: NightCtx) => nightRoutes(serviceFor(ctx)),
  /** Called by POST /api/v1/tick. Every step is idempotent (row state or jobs_sent keys). */
  tick: (ctx: NightCtx & { now?: number }) => {
    const s = serviceFor(ctx);
    const nowMs = typeof ctx.now === 'number' ? ctx.now : Date.now();
    return {
      homeSafe: s.tickHomeSafe(nowMs),
      polls: s.closeDuePolls(nowMs),
      tabNudges: s.tickTabNudges(nowMs),
    };
  },
};

export default module;
