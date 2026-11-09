// Night-of routes, mounted at /api/v1 behind requireMember + CSRF by the module registry.
import express, { type Request } from 'express';
import { HttpError } from '../../service.ts';
import { clock } from '../../clock.ts';
import { NightService, COOKED_LABELS, BUDDY_PING_AFTER, GROUP_PING_AFTER } from './service.ts';

const pid = (req: Request, key = 'id'): number => {
  const n = Number(req.params[key]);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Bad id');
  return n;
};
const page = (req: Request) => ({
  before: typeof req.query.before === 'string' && req.query.before ? req.query.before : undefined,
  limit: req.query.limit ? Number(req.query.limit) : undefined,
});
const eventQ = (req: Request): number | null => {
  const v = req.query.eventId;
  if (v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Bad eventId');
  return n;
};

export function nightRoutes(night: NightService) {
  const r = express.Router();
  const uid = (req: Request) => req.user!.id;

  // One call for the whole Tonight screen (or an event's night panel with ?eventId=).
  r.get('/night', (req, res) => {
    const eventId = eventQ(req);
    const me = uid(req);
    const sessions = night.tonight(me).filter((s) => !eventId || s.eventId === eventId);
    res.json({
      sessions,
      trail: night.trail(eventId),
      polls: night.polls(me, eventId),
      cooked: night.cookedBoard(),
      drafts: night.drafts(me),
      cookedLabels: COOKED_LABELS,
      homeSafe: { buddyPingAfterMin: BUDDY_PING_AFTER / 60_000, groupPingAfterMin: GROUP_PING_AFTER / 60_000 },
    });
  });

  // ---- Home Safe
  r.post('/night/sessions', (req, res) => res.status(201).json({ session: night.startSession(uid(req), req.body ?? {}) }));
  r.get('/night/sessions/:id', (req, res) => res.json({ session: night.sessionView(pid(req), uid(req)) }));
  r.post('/night/sessions/:id/join', (req, res) => res.json({ session: night.joinSession(pid(req), uid(req)) }));
  r.post('/night/sessions/:id/home', (req, res) => res.json({ session: night.tapHome(pid(req), uid(req)) }));
  r.post('/night/sessions/:id/buddy', (req, res) => res.json({ session: night.pickBuddy(pid(req), uid(req), Number(req.body?.buddyId)) }));
  r.post('/night/sessions/:id/shuffle', (req, res) => res.json({ session: night.reshuffle(pid(req), uid(req)) }));
  r.post('/night/sessions/:id/cutoff', (req, res) => res.json({ session: night.extendCutoff(pid(req), uid(req), req.body?.cutoffAt) }));
  r.post('/night/sessions/:id/location', (req, res) => res.json(night.shareLocation(pid(req), uid(req), req.body ?? {})));
  r.post('/night/sessions/:id/end', (req, res) => res.json(night.endSession(pid(req), uid(req))));

  r.post('/night/sessions/:id/heading', (req, res) => res.json(night.setHeading(pid(req), uid(req), req.body?.heading)));
  r.post('/night/sessions/:id/rideshare', (req, res) => res.json(night.rideshareRoulette(pid(req), uid(req))));
  r.post('/night/sessions/:id/hydrate', (req, res) => res.json(night.setHydrate(pid(req), uid(req), req.body?.on)));

  // ---- Draft Jail
  r.get('/night/drafts', (req, res) => res.json({ drafts: night.drafts(uid(req)) }));
  r.post('/night/drafts', (req, res) => res.status(201).json(night.jailDraft(uid(req), req.body ?? {})));
  r.post('/night/drafts/:id/vote', (req, res) => res.json({ draft: night.voteDraft(pid(req), uid(req), req.body?.choice) }));
  r.post('/night/drafts/:id/release', (req, res) => res.json(night.releaseDraft(pid(req), uid(req))));

  // ---- Where We At
  r.get('/night/trail', (req, res) => res.json(night.trail(eventQ(req))));
  r.post('/night/checkins', (req, res) => res.status(201).json(night.checkIn(uid(req), req.body ?? {})));
  r.delete('/night/checkins/:id', (req, res) => res.json(night.deleteCheckIn(pid(req), uid(req))));

  // ---- Next Move
  r.get('/night/polls', (req, res) => res.json({ polls: night.polls(uid(req), eventQ(req), page(req)) }));
  r.post('/night/polls', (req, res) => res.status(201).json({ poll: night.createPoll(uid(req), req.body ?? {}) }));
  r.get('/night/polls/:id', (req, res) => {
    night.closeDuePolls(clock.now());
    res.json({ poll: night.pollView(pid(req), uid(req)) });
  });
  r.post('/night/polls/:id/vote', (req, res) => res.json({ poll: night.vote(pid(req), uid(req), Number(req.body?.optionId)) }));

  // ---- Cooked Meter
  r.get('/night/cooked', (_req, res) => res.json({ board: night.cookedBoard(), labels: COOKED_LABELS }));
  r.post('/night/cooked', (req, res) => res.json(night.reportCooked(uid(req), req.body ?? {})));
  r.get('/night/cooked/stats', (req, res) => res.json({ stats: night.cookedStats(req.query.userId ? Number(req.query.userId) : undefined) }));

  // ---- The Tab
  r.get('/tab', (req, res) => res.json(night.tab(uid(req), eventQ(req), page(req))));
  r.post('/tab/expenses', (req, res) => res.status(201).json(night.addExpense(uid(req), req.body ?? {})));
  r.delete('/tab/expenses/:id', (req, res) => res.json(night.deleteExpense(pid(req), uid(req), !!req.user!.is_admin)));
  r.post('/tab/settlements', (req, res) => res.status(201).json(night.settle(uid(req), req.body ?? {})));
  r.post('/tab/venmo', (req, res) => res.json(night.setVenmo(uid(req), req.body?.venmo)));

  return r;
}
