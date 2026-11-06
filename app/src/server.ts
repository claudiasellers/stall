import express, { type Request, type Response, type NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { openDb, type Db } from './db.ts';
import { loadAppConfig, type AppConfig } from './config.ts';
import { Service, HttpError, bus, consensus, consensusProgress, type RequestRow } from './service.ts';
import {
  signup, login, createSession, destroySession, setSessionCookie, sessionMiddleware, requireUser, requireAdmin,
  checkCsrf, rateLimiter, readCookie, COOKIE,
} from './auth.ts';
import { startOutbox } from './outbox.ts';
import { startPush, pushEnabled, saveSubscription, removeSubscription, ensureVapidKeys } from './push.ts';
import { ACTIVE_STATUSES, type RequestStatus } from '../../shared/types.ts';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

type LaneReport = { id: string; state: 'idle' | 'working' | 'offline'; requestId?: number | null; detail?: string };

export function createApp(db: Db, cfg: AppConfig) {
  const svc = new Service(db, cfg);
  const app = express();
  const authLimit = rateLimiter(10, 15 * 60_000);
  let lanes: { at: number; lanes: LaneReport[] } = { at: 0, lanes: [] };

  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === 'true');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'",
    );
    next();
  });
  app.use(express.json({ limit: '100kb' }));

  // ---------------- static web app (PWA) ----------------
  app.get('/sw.js', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Service-Worker-Allowed', '/');
    res.sendFile(join(PUBLIC_DIR, 'sw.js'));
  });
  app.use(
    express.static(PUBLIC_DIR, {
      index: 'index.html',
      setHeaders(res, path) {
        if (path.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json');
        if (path.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );

  // ---------------- orchestrator API ----------------
  const orch = express.Router();
  orch.use((req, _res, next) => {
    const given = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const want = cfg.orchestratorToken;
    if (!want || given.length !== want.length || !timingSafeEqual(Buffer.from(given), Buffer.from(want)))
      throw new HttpError(401, 'Bad orchestrator token');
    next();
  });
  orch.get('/queue', (_req, res) => res.json({ queue: svc.orchQueue() }));
  orch.get('/requests/:id', (req, res) => res.json(svc.orchDetail(id(req))));
  orch.post('/requests/:id/claim', (req, res) => {
    const ok = svc.orchClaim(id(req), str(req.body.lane, 'lane'));
    res.status(ok ? 200 : 409).json({ claimed: ok });
  });
  orch.post('/requests/:id/progress', (req, res) => {
    const { status, lane, branch, note, detail } = req.body ?? {};
    if (status !== undefined && status !== 'in_progress' && status !== 'integrating') throw new HttpError(400, 'Bad status');
    svc.orchProgress(id(req), { status, lane, branch, note, detail });
    res.json({ ok: true });
  });
  orch.post('/requests/:id/question', (req, res) => {
    res.json({ messageId: svc.orchQuestion(id(req), str(req.body.question, 'question')) });
  });
  orch.post('/requests/:id/requeue', (req, res) => {
    svc.orchRequeue(id(req), str(req.body.reason, 'reason'), typeof req.body.detail === 'string' ? req.body.detail : undefined);
    res.json({ ok: true });
  });
  orch.post('/requests/:id/complete', (req, res) => {
    svc.orchComplete(id(req), { summary: str(req.body.summary, 'summary'), commit: req.body.commit, branch: req.body.branch });
    res.json({ ok: true });
  });
  orch.post('/requests/:id/fail', (req, res) => {
    svc.orchFail(id(req), str(req.body.reason, 'reason'));
    res.json({ ok: true });
  });
  orch.post('/lanes', (req, res) => {
    lanes = { at: Date.now(), lanes: Array.isArray(req.body?.lanes) ? req.body.lanes.slice(0, 16) : [] };
    bus.emit('board');
    res.json({ ok: true });
  });
  app.use('/api/orch', orch);

  // ---------------- user API (web app + future native clients) ----------------
  const api = express.Router();
  api.use(sessionMiddleware(db));
  api.use(checkCsrf);

  api.get('/config', (_req, res) =>
    res.json({
      allowSignup: cfg.allowSignup,
      pushPublicKey: pushEnabled(cfg) ? cfg.vapidPublicKey : null,
      consensus: { minUpvotes: cfg.voteMinUpvotes, ratio: cfg.consensusRatio, rejectMinDownvotes: cfg.rejectMinDownvotes },
    }),
  );

  const isNative = (req: Request) => req.headers['x-stall-client'] === 'native';
  const sessionResponse = (req: Request, res: Response, user: { id: number; username: string; is_admin: number }) => {
    const { token, csrf } = createSession(db, user.id);
    if (!isNative(req)) setSessionCookie(res, token, cfg.cookieSecure);
    res.json({ user: publicUser(user), csrf, ...(isNative(req) ? { token } : {}) });
  };

  api.post('/auth/signup', async (req, res) => {
    if (!cfg.allowSignup) throw new HttpError(403, 'Sign-ups are closed');
    if (!authLimit(`signup:${req.ip}`)) throw new HttpError(429, 'Too many attempts. Try again later.');
    const user = await signup(db, String(req.body?.username ?? ''), String(req.body?.password ?? ''));
    sessionResponse(req, res, user);
  });
  api.post('/auth/login', async (req, res) => {
    const username = String(req.body?.username ?? '');
    if (!authLimit(`login:${req.ip}:${username.toLowerCase()}`)) throw new HttpError(429, 'Too many attempts. Try again later.');
    const user = await login(db, username, String(req.body?.password ?? ''));
    if (!user) throw new HttpError(401, 'Wrong username or password');
    sessionResponse(req, res, user);
  });
  api.post('/auth/logout', (req, res) => {
    const auth = req.headers.authorization;
    destroySession(db, auth?.startsWith('Bearer ') ? auth.slice(7) : readCookie(req, COOKIE));
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  api.get('/me', (req, res) => {
    if (!req.user) return res.json({ user: null });
    res.json({ user: publicUser(req.user), csrf: req.csrf, unread: svc.unreadCount(req.user.id) });
  });

  api.use(requireUser);

  const view = (r: RequestRow, viewerId: number, myVote?: number) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status,
    submitter: r.username,
    mine: r.user_id === viewerId,
    lane: r.lane, // builder slot number, shown as "Builder N"
    summary: r.summary,
    score: r.score,
    upvotes: r.upvotes,
    downvotes: r.downvotes,
    myVote: myVote ?? 0,
    consensus: r.status === 'proposed' ? consensusProgress(r, cfg) : '',
    canVote: r.status === 'proposed' || r.status === 'queued',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
  });

  const SCOPES: Record<string, RequestStatus[] | undefined> = {
    proposed: ['proposed'],
    active: ACTIVE_STATUSES,
    done: ['done'],
    closed: ['done', 'failed', 'rejected', 'cancelled'],
    all: undefined,
  };

  api.get('/requests', (req, res) => {
    const u = req.user!;
    const scope = String(req.query.scope ?? 'proposed');
    const mine = scope === 'mine';
    if (!mine && !(scope in SCOPES)) throw new HttpError(400, 'Bad scope');
    const rows = svc.listRequests({
      userId: mine ? u.id : undefined,
      statuses: mine ? undefined : SCOPES[scope],
      order: scope === 'proposed' ? 'votes' : scope === 'active' ? 'queue' : 'recent',
    });
    const votes = svc.myVotes(u.id);
    res.json({ requests: rows.map((r) => view(r, u.id, votes.get(r.id))) });
  });

  api.post('/requests', (req, res) => {
    const r = svc.createRequest(req.user!.id, String(req.body?.title ?? ''), String(req.body?.description ?? ''));
    res.status(201).json({ request: view(r, req.user!.id, 1) });
  });

  api.get('/requests/:id', (req, res) => {
    const u = req.user!;
    const r = svc.mustGet(id(req));
    svc.markRead(u.id, r.id);
    res.json({
      request: { ...view(r, u.id, svc.myVote(r.id, u.id)), queuePosition: svc.queuePosition(r.id) },
      messages: svc
        .messages(r.id)
        .filter((m) => !m.admin_only || u.is_admin)
        .map((m) => ({
          id: m.id, author: m.author, username: m.username, kind: m.kind, body: m.body, adminOnly: !!m.admin_only, createdAt: m.created_at,
        })),
      // Technical details are for admins only; regular members never see branches or commits.
      admin: u.is_admin
        ? {
            lane: r.lane,
            branch: r.branch,
            commit: r.commit_sha,
            commitUrl: r.commit_sha && cfg.commitUrlTemplate ? cfg.commitUrlTemplate.replace('{sha}', r.commit_sha) : null,
            failureReason: r.failure_reason,
          }
        : null,
      can: {
        reply: r.user_id === u.id && r.status === 'needs_info',
        comment: r.user_id === u.id || !!u.is_admin,
        cancel: (r.user_id === u.id || !!u.is_admin) && !['done', 'failed', 'rejected', 'cancelled'].includes(r.status),
        approve: !!u.is_admin && (r.status === 'proposed' || r.status === 'rejected'),
        reject: !!u.is_admin && (r.status === 'proposed' || r.status === 'queued'),
        retry: !!u.is_admin && r.status === 'failed',
      },
    });
  });

  api.post('/requests/:id/vote', (req, res) => {
    const value = Number(req.body?.value);
    const r = svc.vote(id(req), req.user!.id, value);
    res.json({ request: view(r, req.user!.id, value) });
  });

  const ownerOrAdmin = (req: Request) => {
    const r = svc.mustGet(id(req));
    if (r.user_id !== req.user!.id && !req.user!.is_admin) throw new HttpError(403, 'Not your request');
    return r;
  };

  api.post('/requests/:id/reply', (req, res) => {
    const r = svc.mustGet(id(req));
    if (r.user_id !== req.user!.id) throw new HttpError(403, 'Only the submitter can answer');
    svc.reply(r.id, req.user!.id, String(req.body?.body ?? ''));
    res.json({ ok: true });
  });
  api.post('/requests/:id/comment', (req, res) => {
    const r = ownerOrAdmin(req);
    svc.comment(r.id, req.user!.id, String(req.body?.body ?? ''));
    res.json({ ok: true });
  });
  api.post('/requests/:id/cancel', (req, res) => {
    svc.cancel(ownerOrAdmin(req).id, req.user!.id);
    res.json({ ok: true });
  });
  api.post('/requests/:id/approve', requireAdmin, (req, res) => {
    svc.approve(id(req), `${req.user!.username} gave this the green light. It is in line to be built!`);
    res.json({ ok: true });
  });
  api.post('/requests/:id/reject', requireAdmin, (req, res) => {
    svc.reject(id(req), req.user!.id);
    res.json({ ok: true });
  });
  api.post('/requests/:id/retry', requireAdmin, (req, res) => {
    svc.retry(id(req));
    res.json({ ok: true });
  });

  api.get('/board', (req, res) => {
    const u = req.user!;
    const stale = Date.now() - lanes.at > 90_000;
    const active = svc.listRequests({ statuses: ACTIVE_STATUSES, order: 'queue' });
    const votes = svc.myVotes(u.id);
    res.json({
      orchestrator: lanes.at === 0 ? 'unknown' : stale ? 'offline' : 'online',
      lanes: lanes.lanes.map((l) => ({ ...l, state: stale ? 'offline' : l.state })),
      queue: active.filter((r) => r.status === 'queued').map((r) => view(r, u.id, votes.get(r.id))),
      working: active.filter((r) => r.status !== 'queued').map((r) => view(r, u.id, votes.get(r.id))),
    });
  });

  api.get('/notifications', (req, res) => {
    res.json({ notifications: svc.notifications(req.user!.id), unread: svc.unreadCount(req.user!.id) });
  });
  api.post('/notifications/read', (req, res) => {
    const rid = req.body?.requestId;
    svc.markRead(req.user!.id, rid === undefined ? undefined : Number(rid));
    res.json({ unread: svc.unreadCount(req.user!.id) });
  });

  api.post('/push/subscribe', (req, res) => {
    try {
      saveSubscription(db, req.user!.id, req.body?.subscription);
    } catch {
      throw new HttpError(400, 'Bad push subscription');
    }
    res.json({ ok: true });
  });
  api.post('/push/unsubscribe', (req, res) => {
    removeSubscription(db, req.user!.id, String(req.body?.endpoint ?? ''));
    res.json({ ok: true });
  });

  // Server-sent events: live notifications and refresh hints.
  api.get('/events', (req, res) => {
    const u = req.user!;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const onUser = (d: unknown) => send('notification', { ...(d as object), unread: svc.unreadCount(u.id) });
    let boardTimer: NodeJS.Timeout | undefined;
    const onBoard = () => {
      // Coalesce bursts of updates.
      if (boardTimer) return;
      boardTimer = setTimeout(() => {
        boardTimer = undefined;
        send('board', {});
      }, 250);
    };
    bus.on(`user:${u.id}`, onUser);
    bus.on('board', onBoard);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      clearTimeout(boardTimer);
      bus.off(`user:${u.id}`, onUser);
      bus.off('board', onBoard);
    });
  });

  api.get('/admin/users', requireAdmin, (_req, res) => {
    res.json({ users: db.prepare('SELECT id, username, is_admin, created_at FROM users ORDER BY id').all() });
  });
  api.post('/admin/users/:id/admin', requireAdmin, (req, res) => {
    const target = id(req);
    const makeAdmin = Boolean(req.body?.isAdmin);
    if (!makeAdmin) {
      const admins = (db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get() as { n: number }).n;
      if (admins <= 1 && target === req.user!.id) throw new HttpError(409, 'You are the last admin');
    }
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(makeAdmin ? 1 : 0, target);
    res.json({ ok: true });
  });

  app.use('/api/v1', api);
  app.use('/api', (_req, _res) => {
    throw new HttpError(404, 'Not found');
  });

  // SPA fallback (hash routing makes this mostly unnecessary, but deep links still work).
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(PUBLIC_DIR, 'index.html')));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if ((err as { type?: string }).type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad JSON' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return { app, svc, consensus };
}

function publicUser(u: { id: number; username: string; is_admin: number }) {
  return { id: u.id, username: u.username, isAdmin: !!u.is_admin };
}

function id(req: Request): number {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Bad id');
  return n;
}

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${name} is required`);
  return v;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadAppConfig();
  const db = openDb(cfg.dbPath, cfg.tursoUrl ? { url: cfg.tursoUrl, authToken: cfg.tursoToken } : undefined);
  console.log(`[stall] database: ${cfg.tursoUrl ? 'Turso (hosted)' : cfg.dbPath}`);
  ensureVapidKeys(db, cfg);
  const { app } = createApp(db, cfg);
  startOutbox(db, cfg);
  startPush(db, cfg);
  app.listen(cfg.port, () => console.log(`[stall] app listening on ${cfg.publicUrl}`));
}
