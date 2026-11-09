// Night-of tools module: Home Safe roll call + buddies, Where We At, Next Move,
// Cooked Meter, The Tab, Draft Jail, Rideshare Roulette, hydration nag.
import type { StallModule, ModuleCtx } from '../types.ts';
import { clock } from '../../clock.ts';
import { NIGHT_MIGRATIONS } from './schema.ts';
import { NightService } from './service.ts';
import { nightRoutes } from './routes.ts';

const services = new WeakMap<object, NightService>();
const serviceFor = (ctx: ModuleCtx) => {
  let s = services.get(ctx.db);
  if (!s) services.set(ctx.db, (s = new NightService(ctx)));
  return s;
};

export const module: StallModule = {
  name: 'night',
  migrations: NIGHT_MIGRATIONS,
  routes: (ctx) => nightRoutes(serviceFor(ctx)),
  /** Every step is idempotent: Home Safe escalation is recorded on the member row, pushes use jobs_sent keys. */
  tick: (ctx) => {
    const s = serviceFor(ctx);
    const nowMs = clock.now();
    s.tickHomeSafe(nowMs);
    s.closeDuePolls(nowMs);
    s.closeDueDrafts(nowMs);
    s.tickHydration(nowMs);
    s.tickTabNudges(nowMs);
  },
  onMemberRemoved: (ctx, userId, policy) => serviceFor(ctx).onMemberRemoved(userId, policy),
};

export default module;
