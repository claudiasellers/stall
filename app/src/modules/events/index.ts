// Events module: routes under /api/v1/events (behind requireMember + CSRF), a
// public guest-link endpoint, and the tick hook for time-based pushes and purges.
import express, { type Request } from 'express';
import { HttpError } from '../../service.ts';
import type { ModuleContext, StallModule } from '../types.ts';
import { EVENTS_MIGRATIONS } from './schema.ts';
import { EventsService, RSVP } from './service.ts';

const services = new WeakMap<object, EventsService>();
const svcFor = (ctx: ModuleContext) => {
  let s = services.get(ctx.db);
  if (!s) services.set(ctx.db, (s = new EventsService(ctx)));
  return s;
};

const viewer = (req: Request) => {
  if (!req.user) throw new HttpError(401, 'Sign in first');
  return { id: req.user.id, is_admin: req.user.is_admin };
};
const num = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Bad id');
  return n;
};

function routes(ctx: ModuleContext) {
  const ev = svcFor(ctx);
  const r = express.Router();

  r.get('/events/meta', (_req, res) => res.json({ rsvp: RSVP, house: { plusOneVoteMinutes: ctx.house?.plusOneVoteMinutes ?? 60, locationRevealHours: ctx.house?.locationRevealHours ?? 2 } }));
  r.get('/events', (req, res) => res.json({ events: ev.list(viewer(req), String(req.query.scope ?? 'upcoming')) }));
  r.post('/events', (req, res) => {
    const id = ev.create(viewer(req).id, req.body ?? {});
    res.status(201).json(ev.detail(id, viewer(req)));
  });
  r.get('/events/:id', (req, res) => res.json(ev.detail(num(req.params.id), viewer(req))));
  r.patch('/events/:id', (req, res) => {
    ev.update(num(req.params.id), viewer(req), req.body ?? {});
    res.json(ev.detail(num(req.params.id), viewer(req)));
  });
  r.post('/events/:id/cancel', (req, res) => {
    ev.cancel(num(req.params.id), viewer(req));
    res.json({ ok: true });
  });
  r.delete('/events/:id', (req, res) => {
    ev.remove(num(req.params.id), viewer(req));
    res.json({ ok: true });
  });
  r.post('/events/:id/rsvp', (req, res) => {
    ev.rsvp(num(req.params.id), viewer(req).id, req.body?.status, req.body?.note);
    res.json({ ok: true });
  });
  r.post('/events/:id/stages', (req, res) => {
    ev.addStage(num(req.params.id), viewer(req), req.body?.label);
    res.json({ ok: true });
  });
  r.post('/events/:id/stage', (req, res) => {
    ev.moveStage(num(req.params.id), viewer(req).id, num(req.body?.stageId));
    res.json({ ok: true });
  });
  r.post('/events/:id/bring', (req, res) => {
    ev.addBring(num(req.params.id), viewer(req).id, req.body?.label);
    res.json({ ok: true });
  });
  r.post('/events/bring/:itemId/claim', (req, res) => {
    ev.claimBring(num(req.params.itemId), viewer(req).id, req.body?.claim !== false);
    res.json({ ok: true });
  });
  r.delete('/events/bring/:itemId', (req, res) => {
    ev.removeBring(num(req.params.itemId), viewer(req));
    res.json({ ok: true });
  });
  r.post('/events/:id/plus-ones', (req, res) => {
    res.status(201).json({ id: ev.requestPlusOne(num(req.params.id), viewer(req).id, req.body ?? {}) });
  });
  r.post('/events/plus-ones/:pid/vote', (req, res) => {
    ev.votePlusOne(num(req.params.pid), viewer(req).id, Number(req.body?.value));
    res.json({ ok: true });
  });
  r.post('/events/plus-ones/:pid/withdraw', (req, res) => {
    ev.withdrawPlusOne(num(req.params.pid), viewer(req));
    res.json({ ok: true });
  });
  r.post('/events/:id/rate', (req, res) => {
    ev.rate(num(req.params.id), viewer(req).id, req.body?.score);
    res.json({ ok: true });
  });
  r.post('/events/:id/guest-link', (req, res) => {
    res.json({ token: ev.setGuestLink(num(req.params.id), viewer(req), req.body?.on !== false) });
  });
  return r;
}

/**
 * Guest links: no account, no CSRF (no session to forge), event card + RSVP only.
 * Mounted outside the member gate at /api/guest.
 */
function publicRoutes(ctx: ModuleContext) {
  const ev = svcFor(ctx);
  const r = express.Router();
  r.get('/guest/:token', (req, res) => res.json(ev.guestView(String(req.params.token))));
  r.post('/guest/:token/rsvp', (req, res) => {
    res.json(ev.guestRsvp(String(req.params.token), req.body?.name, req.body?.status, req.body?.editToken));
  });
  return r;
}

export const module: StallModule = {
  name: 'events',
  migrations: EVENTS_MIGRATIONS,
  routes,
  publicRoutes,
  tick: (ctx: ModuleContext) => svcFor(ctx).tick(),
};
