// Dating module: opt-in Roster, date vetting vote + "has anyone met them?", debrief cards.
import express, { type Request } from 'express';
import type { StallModule, ModuleCtx } from '../types.ts';
import { HttpError } from '../../service.ts';
import { DATING_MIGRATIONS } from './schema.ts';
import { DatingService } from './service.ts';

const services = new WeakMap<object, DatingService>();
const svcFor = (ctx: ModuleCtx) => {
  let s = services.get(ctx.db);
  if (!s) services.set(ctx.db, (s = new DatingService(ctx)));
  return s;
};
const pid = (req: Request) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Bad id');
  return n;
};
const page = (req: Request) => ({
  before: typeof req.query.before === 'string' && req.query.before ? req.query.before : undefined,
  limit: req.query.limit ? Number(req.query.limit) : undefined,
});

export const module: StallModule = {
  name: 'dating',
  migrations: DATING_MIGRATIONS,
  routes: (ctx) => {
    const d = svcFor(ctx);
    const r = express.Router();
    const me = (req: Request) => req.user!.id;
    const admin = (req: Request) => !!req.user!.is_admin;
    r.get('/dating', (req, res) => res.json({ rosters: d.rosters(), vets: d.vets(me(req), { limit: 20 }), debriefs: d.debriefs(me(req), { limit: 20 }) }));
    r.post('/dating/roster', (req, res) => res.status(201).json(d.addToRoster(me(req), req.body ?? {})));
    r.patch('/dating/roster/:id', (req, res) => res.json(d.updateRoster(pid(req), me(req), req.body ?? {})));
    r.delete('/dating/roster/:id', (req, res) => res.json(d.removeFromRoster(pid(req), me(req))));
    r.get('/dating/vets', (req, res) => res.json({ vets: d.vets(me(req), page(req)) }));
    r.post('/dating/vets', (req, res) => res.status(201).json({ vet: d.openVet(me(req), req.body ?? {}) }));
    r.get('/dating/vets/:id', (req, res) => res.json({ vet: d.vet(pid(req), me(req)) }));
    r.post('/dating/vets/:id/vote', (req, res) => res.json({ vet: d.voteVet(pid(req), me(req), req.body?.value) }));
    r.post('/dating/vets/:id/comments', (req, res) => res.status(201).json({ vet: d.commentVet(pid(req), me(req), req.body ?? {}) }));
    r.delete('/dating/vets/:id', (req, res) => res.json(d.deleteVet(pid(req), me(req), admin(req))));
    r.get('/dating/debriefs', (req, res) => res.json({ debriefs: d.debriefs(me(req), page(req)) }));
    r.post('/dating/debriefs', (req, res) => res.status(201).json(d.addDebrief(me(req), req.body ?? {})));
    r.delete('/dating/debriefs/:id', (req, res) => res.json(d.deleteDebrief(pid(req), me(req), admin(req))));
    return r;
  },
  onMemberRemoved: (ctx, userId) => svcFor(ctx).onMemberRemoved(userId),
};

export default module;
