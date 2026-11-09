// Disposable-camera photo drop: upload all night, see nothing until 11am.
// Registered in app/src/modules/index.ts. Routes mount at /api/v1 behind
// requireMember + CSRF (foundation), all under /photos.
import express, { type Request } from 'express';
import type { ModuleCtx, StallModule } from '../types.ts';
import { HttpError } from '../../service.ts';
import { migrations } from './schema.ts';
import { Photos, type Roll } from './service.ts';

const instances = new WeakMap<object, Photos>();
const photosFor = (ctx: ModuleCtx) => {
  let p = instances.get(ctx);
  if (!p) instances.set(ctx, (p = new Photos(ctx)));
  return p;
};

const NIGHT_RE = /^\d{4}-\d{2}-\d{2}$/;

function routes(ctx: ModuleCtx) {
  const photos = photosFor(ctx);
  const r = express.Router();
  const uid = (req: Request) => req.user!.id;
  const num = (v: unknown) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Bad id');
    return n;
  };
  const rollFrom = (q: Record<string, unknown>): Roll => {
    if (q.event !== undefined && q.event !== '') return { eventId: num(q.event), night: '' };
    const night = String(q.night ?? '');
    if (!NIGHT_RE.test(night)) throw new HttpError(400, 'Pick an event or a night');
    return { eventId: null, night };
  };

  // Rolls
  r.get('/photos/rolls', async (req, res) => res.json({ rolls: await photos.rolls(uid(req)) }));
  r.get('/photos/roll', async (req, res) => res.json(await photos.roll(rollFrom(req.query), uid(req))));
  r.get('/photos/memories', async (req, res) => res.json({ memories: await photos.memories(uid(req)) }));
  /** Where a shot taken now would land, so the camera can say "develops 11am tomorrow". */
  r.get('/photos/current', (req, res) => {
    const eventId = req.query.event ? num(req.query.event) : null;
    const roll = photos.currentRoll(eventId, Date.now());
    res.json({
      eventId: roll.eventId,
      night: roll.night,
      unlockAt: new Date(photos.unlockAt(roll)).toISOString(),
      developed: photos.isDeveloped(roll),
      mine: photos.myLockedCount(uid(req), roll),
    });
  });

  // Upload: reserve -> PUT straight to storage -> commit
  r.post('/photos', async (req, res) => res.status(201).json(await photos.create(uid(req), req.body ?? {})));
  r.post('/photos/:id/commit', async (req, res) => res.json(await photos.commit(num(req.params.id), uid(req))));

  // One photo
  r.get('/photos/:id', async (req, res) => res.json(await photos.detail(num(req.params.id), uid(req))));
  r.get('/photos/:id/original', async (req, res) => res.json(await photos.originalUrl(num(req.params.id), uid(req))));
  r.post('/photos/:id/veto', (req, res) => res.json(photos.veto(num(req.params.id), uid(req))));
  r.delete('/photos/:id', (req, res) => res.json(photos.remove(num(req.params.id), uid(req), !!req.user!.is_admin)));

  // Caption battles
  r.post('/photos/:id/captions', (req, res) => res.status(201).json(photos.addCaption(num(req.params.id), uid(req), req.body?.body)));
  r.post('/photos/captions/:cid/vote', (req, res) => res.json(photos.voteCaption(num(req.params.cid), uid(req), req.body?.on !== false)));
  r.delete('/photos/captions/:cid', (req, res) => res.json(photos.deleteCaption(num(req.params.cid), uid(req), !!req.user!.is_admin)));

  // Admin moderation (the service checks is_admin)
  r.get('/admin/photos', async (req, res) =>
    res.json(await photos.adminList(!!req.user!.is_admin, typeof req.query.before === 'string' ? req.query.before : undefined, Number(req.query.limit) || 50)));
  r.get('/admin/vetoes', (req, res) =>
    res.json(photos.vetoLog(!!req.user!.is_admin, typeof req.query.before === 'string' ? req.query.before : undefined, Number(req.query.limit) || 50)));

  return r;
}

export const module: StallModule = {
  name: 'photos',
  migrations,
  routes,
  tick: (ctx) => photosFor(ctx).tick(),
  onMemberRemoved: (ctx, userId, policy) => photosFor(ctx).memberRemoved(userId, policy),
};

/** For Wrapped: photos shot and vetoed by a member in a year. */
export const photoStats = (ctx: ModuleCtx, userId: number, year: string) => photosFor(ctx).stats(userId, year);
