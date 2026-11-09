// Domain logic shared by the browser routes and the orchestrator API.
// Every state change that the orchestrator must hear about writes an outbox row
// in the same transaction, so a crash can never lose a queue event.
import { EventEmitter } from 'node:events';
import { type Db, tx, now } from './db.ts';
import type { AppConfig } from './config.ts';
import type { QueueItem, RequestDetail, RequestStatus, ThreadMessage, WebhookEvent } from '../../shared/types.ts';

export type RequestRow = {
  id: number;
  user_id: number;
  username: string;
  title: string;
  description: string;
  status: RequestStatus;
  priority: number;
  lane: string | null;
  branch: string | null;
  commit_sha: string | null;
  summary: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  completed_at: string | null;
  score: number;
  upvotes: number;
  downvotes: number;
};

export type MessageRow = {
  id: number;
  request_id: number;
  author: 'user' | 'claude' | 'system';
  username: string | null;
  kind: 'question' | 'reply' | 'note';
  body: string;
  admin_only: number;
  created_at: string;
};

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Live events for SSE. `user:<id>` gets notifications; `request:<id>` and `board` get refresh hints. */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

const SELECT_REQUEST = `
  SELECT r.*, u.username,
    COALESCE((SELECT SUM(value) FROM votes v WHERE v.request_id = r.id), 0) AS score,
    (SELECT COUNT(*) FROM votes v WHERE v.request_id = r.id AND v.value = 1) AS upvotes,
    (SELECT COUNT(*) FROM votes v WHERE v.request_id = r.id AND v.value = -1) AS downvotes
  FROM requests r JOIN users u ON u.id = r.user_id`;

export class Service {
  db: Db;
  cfg: AppConfig;
  constructor(db: Db, cfg: AppConfig) {
    this.db = db;
    this.cfg = cfg;
  }

  // ---------- reads ----------

  getRequest(id: number): RequestRow | undefined {
    return this.db.prepare(`${SELECT_REQUEST} WHERE r.id = ?`).get(id) as RequestRow | undefined;
  }

  mustGet(id: number): RequestRow {
    const r = this.getRequest(id);
    if (!r) throw new HttpError(404, 'Request not found');
    return r;
  }

  listRequests(opts: { userId?: number; statuses?: RequestStatus[]; order?: 'queue' | 'recent' | 'votes' } = {}) {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.userId !== undefined) {
      where.push('r.user_id = ?');
      params.push(opts.userId);
    }
    if (opts.statuses?.length) {
      where.push(`r.status IN (${opts.statuses.map(() => '?').join(',')})`);
      params.push(...opts.statuses);
    }
    const order =
      opts.order === 'queue'
        ? 'r.priority DESC, score DESC, COALESCE(r.approved_at, r.created_at) ASC'
        : opts.order === 'votes'
          ? 'score DESC, r.created_at DESC'
          : 'r.updated_at DESC';
    const sql = `${SELECT_REQUEST} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order}`;
    return this.db.prepare(sql).all(...params) as RequestRow[];
  }

  messages(requestId: number): MessageRow[] {
    return this.db
      .prepare(
        `SELECT m.*, u.username FROM messages m LEFT JOIN users u ON u.id = m.user_id
         WHERE m.request_id = ? ORDER BY m.id`,
      )
      .all(requestId) as MessageRow[];
  }

  myVote(requestId: number, userId: number): number {
    const row = this.db.prepare('SELECT value FROM votes WHERE request_id = ? AND user_id = ?').get(requestId, userId) as
      | { value: number }
      | undefined;
    return row?.value ?? 0;
  }

  myVotes(userId: number): Map<number, number> {
    const rows = this.db.prepare('SELECT request_id, value FROM votes WHERE user_id = ?').all(userId) as {
      request_id: number;
      value: number;
    }[];
    return new Map(rows.map((r) => [r.request_id, r.value]));
  }

  queuePosition(id: number): number | null {
    const queued = this.listRequests({ statuses: ['queued'], order: 'queue' });
    const i = queued.findIndex((r) => r.id === id);
    return i === -1 ? null : i + 1;
  }

  // ---------- user actions ----------

  createRequest(userId: number, title: string, description: string): RequestRow {
    title = title.trim();
    description = description.trim();
    if (title.length < 3 || title.length > 140) throw new HttpError(400, 'Title must be 3–140 characters');
    if (description.length < 10 || description.length > 10000)
      throw new HttpError(400, 'Description must be 10–10,000 characters');
    const id = tx(this.db, () => {
      const res = this.db
        .prepare('INSERT INTO requests (user_id, title, description, status) VALUES (?, ?, ?, ?)')
        .run(userId, title, description, 'proposed');
      const id = Number(res.lastInsertRowid);
      // Submitters back their own idea.
      this.db.prepare('INSERT INTO votes (request_id, user_id, value) VALUES (?, ?, 1)').run(id, userId);
      this.addMessage(id, 'system', 'note', 'Idea shared. Voting is open!');
      this.evaluateVotes(id);
      return id;
    });
    bus.emit('board');
    return this.mustGet(id);
  }

  /** value: 1, -1, or 0 to clear. Allowed while the request is proposed or queued. */
  vote(requestId: number, userId: number, value: number): RequestRow {
    if (![1, -1, 0].includes(value)) throw new HttpError(400, 'Bad vote');
    tx(this.db, () => {
      const r = this.mustGet(requestId);
      if (r.status !== 'proposed' && r.status !== 'queued')
        throw new HttpError(409, 'Voting is closed for this request');
      if (value === 0) {
        this.db.prepare('DELETE FROM votes WHERE request_id = ? AND user_id = ?').run(requestId, userId);
      } else {
        this.db
          .prepare(
            `INSERT INTO votes (request_id, user_id, value) VALUES (?, ?, ?)
             ON CONFLICT (request_id, user_id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`,
          )
          .run(requestId, userId, value);
      }
      this.evaluateVotes(requestId);
    });
    bus.emit('board');
    bus.emit(`request:${requestId}`);
    return this.mustGet(requestId);
  }

  /** Apply the consensus rule to a proposed request. */
  private evaluateVotes(requestId: number) {
    const r = this.mustGet(requestId);
    if (r.status !== 'proposed') return;
    const v = consensus(r, this.cfg);
    if (v === 'approve') {
      this.approve(
        requestId,
        this.cfg.voteMinUpvotes <= 0
          ? 'In line to be built.'
          : `Enough people want this (${r.upvotes} yes, ${r.downvotes} no). It is in line to be built!`,
      );
    } else if (v === 'reject') {
      this.setStatus(requestId, 'rejected');
      this.addMessage(requestId, 'system', 'note', `Most people voted no (${r.upvotes} yes, ${r.downvotes} no), so this one is on hold.`);
      this.notify(r.user_id, requestId, `Your idea “${r.title}” didn’t get enough votes this time.`);
    }
  }

  approve(requestId: number, note = 'An admin gave this the green light. It is in line to be built!') {
    tx(this.db, () => {
      const r = this.mustGet(requestId);
      if (r.status !== 'proposed' && r.status !== 'rejected') throw new HttpError(409, `Cannot approve a ${r.status} request`);
      this.db
        .prepare(`UPDATE requests SET status = 'queued', approved_at = ?, updated_at = ? WHERE id = ?`)
        .run(now(), now(), requestId);
      this.addMessage(requestId, 'system', 'note', note);
      this.notify(r.user_id, requestId, `🎉 Your idea “${r.title}” is going to be built!`);
      const fresh = this.mustGet(requestId);
      this.enqueueWebhook({ type: 'request.queued', request: toQueueItem(fresh) });
    });
    bus.emit('board');
    bus.emit(`request:${requestId}`);
  }

  reject(requestId: number, actorId: number) {
    tx(this.db, () => {
      const r = this.mustGet(requestId);
      if (r.status !== 'proposed' && r.status !== 'queued') throw new HttpError(409, `Cannot reject a ${r.status} request`);
      this.setStatus(requestId, 'rejected');
      this.addMessage(requestId, 'system', 'note', 'An admin decided to pass on this one for now.', actorId);
      this.notify(r.user_id, requestId, `An admin passed on your idea “${r.title}” for now.`);
      if (r.status === 'queued') this.enqueueWebhook({ type: 'request.cancelled', requestId });
    });
    bus.emit('board');
    bus.emit(`request:${requestId}`);
  }

  cancel(requestId: number, actorId: number) {
    tx(this.db, () => {
      const r = this.mustGet(requestId);
      if (['done', 'failed', 'rejected', 'cancelled'].includes(r.status))
        throw new HttpError(409, `Request is already ${r.status}`);
      const wasWithOrchestrator = r.status !== 'proposed';
      this.setStatus(requestId, 'cancelled');
      this.addMessage(requestId, 'system', 'note', 'Cancelled.', actorId);
      if (wasWithOrchestrator) this.enqueueWebhook({ type: 'request.cancelled', requestId });
    });
    bus.emit('board');
    bus.emit(`request:${requestId}`);
  }

  /** Submitter answers Claude's question. Sends the request back to the front of the queue. */
  reply(requestId: number, userId: number, body: string) {
    body = body.trim();
    if (!body) throw new HttpError(400, 'Reply cannot be empty');
    if (body.length > 10000) throw new HttpError(400, 'Reply is too long');
    tx(this.db, () => {
      const r = this.mustGet(requestId);
      if (r.status !== 'needs_info') throw new HttpError(409, 'Claude is not waiting on an answer for this request');
      const messageId = this.addMessage(requestId, 'user', 'reply', body, userId);
      this.db
        .prepare(`UPDATE requests SET status = 'queued', priority = 1, lane = NULL, updated_at = ? WHERE id = ?`)
        .run(now(), requestId);
      this.enqueueWebhook({ type: 'request.replied', requestId, messageId, body });
    });
    bus.emit('board');
    bus.emit(`request:${requestId}`);
  }

  /** A comment from the submitter that is not an answer (does not change status). */
  comment(requestId: number, userId: number, body: string) {
    body = body.trim();
    if (!body) throw new HttpError(400, 'Comment cannot be empty');
    this.addMessage(requestId, 'user', 'note', body.slice(0, 10000), userId);
    bus.emit(`request:${requestId}`);
  }

  // ---------- orchestrator actions ----------

  orchQueue(): QueueItem[] {
    return this.listRequests({ statuses: ['queued'], order: 'queue' }).map(toQueueItem);
  }

  orchDetail(id: number): RequestDetail {
    const r = this.mustGet(id);
    return {
      ...toQueueItem(r),
      status: r.status,
      lane: r.lane,
      branch: r.branch,
      messages: this.messages(id).map(
        (m): ThreadMessage => ({ id: m.id, author: m.author, kind: m.kind, body: m.body, createdAt: m.created_at }),
      ),
    };
  }

  /** Atomic claim: only one lane can move a request out of `queued`. */
  orchClaim(id: number, lane: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE requests SET status = 'in_progress', lane = ?, priority = 0, updated_at = ? WHERE id = ? AND status = 'queued'`,
      )
      .run(lane, now(), id);
    if (res.changes === 1) {
      this.addMessage(id, 'system', 'note', 'Claude started building this.');
      bus.emit('board');
      bus.emit(`request:${id}`);
      return true;
    }
    return false;
  }

  orchProgress(id: number, p: { status?: 'in_progress' | 'integrating'; lane?: string | null; branch?: string; note?: string; detail?: string }) {
    tx(this.db, () => {
      const r = this.mustGet(id);
      if (['done', 'cancelled', 'rejected'].includes(r.status)) throw new HttpError(409, `Request is ${r.status}`);
      this.db
        .prepare(
          `UPDATE requests SET status = COALESCE(?, status), lane = CASE WHEN ? THEN ? ELSE lane END,
           branch = COALESCE(?, branch), updated_at = ? WHERE id = ?`,
        )
        .run(p.status ?? null, p.lane !== undefined ? 1 : 0, p.lane ?? null, p.branch ?? null, now(), id);
      if (p.note) this.addMessage(id, 'claude', 'note', p.note);
      if (p.detail) this.addMessage(id, 'claude', 'note', p.detail, undefined, true);
    });
    bus.emit('board');
    bus.emit(`request:${id}`);
  }

  orchQuestion(id: number, question: string): number {
    question = question.trim();
    if (!question) throw new HttpError(400, 'Question cannot be empty');
    const messageId = tx(this.db, () => {
      const r = this.mustGet(id);
      if (r.status !== 'in_progress') throw new HttpError(409, `Cannot ask a question while ${r.status}`);
      const mid = this.addMessage(id, 'claude', 'question', question);
      this.db.prepare(`UPDATE requests SET status = 'needs_info', lane = NULL, updated_at = ? WHERE id = ?`).run(now(), id);
      this.notify(r.user_id, id, `🙋 Claude has a quick question about “${r.title}”.`);
      return mid;
    });
    bus.emit('board');
    bus.emit(`request:${id}`);
    return messageId;
  }

  /** Send a request back through the queue (e.g. integration rejected it). */
  orchRequeue(id: number, reason: string, detail?: string) {
    tx(this.db, () => {
      const r = this.mustGet(id);
      if (!['in_progress', 'integrating'].includes(r.status)) throw new HttpError(409, `Cannot requeue a ${r.status} request`);
      this.db
        .prepare(`UPDATE requests SET status = 'queued', priority = 1, lane = NULL, updated_at = ? WHERE id = ?`)
        .run(now(), id);
      this.addMessage(id, 'claude', 'note', reason);
      if (detail) this.addMessage(id, 'claude', 'note', detail, undefined, true);
    });
    bus.emit('board');
    bus.emit(`request:${id}`);
  }

  orchComplete(id: number, p: { summary: string; commit?: string; branch?: string }) {
    tx(this.db, () => {
      const r = this.mustGet(id);
      if (r.status === 'cancelled') throw new HttpError(409, 'Request was cancelled');
      this.db
        .prepare(
          `UPDATE requests SET status = 'done', lane = NULL, summary = ?, commit_sha = ?, branch = COALESCE(?, branch),
           completed_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(p.summary, p.commit ?? null, p.branch ?? null, now(), now(), id);
      this.addMessage(id, 'system', 'note', 'It’s live! 🎉');
      this.notify(r.user_id, id, `🎉 Your idea “${r.title}” is live!`);
      // Everyone who upvoted it hears about it too.
      const voters = this.db
        .prepare('SELECT user_id FROM votes WHERE request_id = ? AND value = 1 AND user_id != ?')
        .all(id, r.user_id) as { user_id: number }[];
      for (const v of voters) this.notify(v.user_id, id, `🎉 “${r.title}”, which you voted for, is live!`);
    });
    bus.emit('board');
    bus.emit(`request:${id}`);
  }

  orchFail(id: number, reason: string) {
    tx(this.db, () => {
      const r = this.mustGet(id);
      if (['done', 'cancelled'].includes(r.status)) throw new HttpError(409, `Request is ${r.status}`);
      this.db
        .prepare(`UPDATE requests SET status = 'failed', lane = NULL, failure_reason = ?, completed_at = ?, updated_at = ? WHERE id = ?`)
        .run(reason, now(), now(), id);
      this.addMessage(id, 'system', 'note', 'Claude got stuck on this one. An admin has been told.');
      this.addMessage(id, 'claude', 'note', reason, undefined, true);
      this.notify(r.user_id, id, `Claude got stuck on “${r.title}”. An admin will take a look.`);
      for (const a of this.admins()) if (a !== r.user_id) this.notify(a, id, `Claude got stuck on “${r.title}”. Open it to see what happened.`);
    });
    bus.emit('board');
    bus.emit(`request:${id}`);
  }

  /** Admin: put a failed request back in the queue. */
  retry(id: number) {
    tx(this.db, () => {
      const r = this.mustGet(id);
      if (r.status !== 'failed') throw new HttpError(409, 'Only failed requests can be retried');
      this.db
        .prepare(`UPDATE requests SET status = 'queued', priority = 1, failure_reason = NULL, completed_at = NULL, updated_at = ? WHERE id = ?`)
        .run(now(), id);
      this.addMessage(id, 'system', 'note', 'An admin asked Claude to try again.');
      this.enqueueWebhook({ type: 'request.queued', request: toQueueItem(this.mustGet(id)) });
    });
    bus.emit('board');
    bus.emit(`request:${id}`);
  }

  admins(): number[] {
    return (this.db.prepare('SELECT id FROM users WHERE is_admin = 1 AND removed_at IS NULL').all() as { id: number }[]).map((r) => r.id);
  }

  // ---------- notifications ----------

  notify(userId: number, requestId: number | null, body: string, link?: string) {
    this.db
      .prepare('INSERT INTO notifications (user_id, request_id, body, link, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, requestId, body, link ?? null, now());
    // Emit after the surrounding transaction has committed.
    queueMicrotask(() => {
      bus.emit(`user:${userId}`, { type: 'notification', body, requestId, link });
      bus.emit('notify', { userId, requestId, body, link });
    });
  }

  /** Notify every active member (optionally except one). */
  notifyMembers(body: string, link: string, exceptId?: number) {
    const ids = this.db.prepare('SELECT id FROM users WHERE removed_at IS NULL AND id != ?').all(exceptId ?? 0) as { id: number }[];
    for (const u of ids) this.notify(u.id, null, body, link);
  }

  unreadCount(userId: number): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId) as {
        n: number;
      }
    ).n;
  }

  notifications(userId: number, limit = 100) {
    return this.db
      .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?')
      .all(userId, limit) as { id: number; request_id: number | null; link: string | null; body: string; read_at: string | null; created_at: string }[];
  }

  markRead(userId: number, requestId?: number) {
    if (requestId !== undefined) {
      this.db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND request_id = ? AND read_at IS NULL').run(now(), userId, requestId);
    } else {
      this.db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), userId);
    }
  }

  // ---------- internals ----------

  private setStatus(id: number, status: RequestStatus) {
    this.db.prepare('UPDATE requests SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
  }

  addMessage(requestId: number, author: MessageRow['author'], kind: MessageRow['kind'], body: string, userId?: number, adminOnly = false): number {
    const res = this.db
      .prepare('INSERT INTO messages (request_id, author, kind, body, user_id, admin_only) VALUES (?, ?, ?, ?, ?, ?)')
      .run(requestId, author, kind, body, userId ?? null, adminOnly ? 1 : 0);
    this.db.prepare('UPDATE requests SET updated_at = ? WHERE id = ?').run(now(), requestId);
    return Number(res.lastInsertRowid);
  }

  enqueueWebhook(event: WebhookEvent) {
    this.db.prepare('INSERT INTO webhook_outbox (event, payload) VALUES (?, ?)').run(event.type, JSON.stringify(event));
    queueMicrotask(() => bus.emit('outbox'));
  }
}

export type ConsensusConfig = Pick<AppConfig, 'voteMinUpvotes' | 'consensusRatio' | 'rejectMinDownvotes'>;

export function consensus(r: { upvotes: number; downvotes: number }, cfg: ConsensusConfig): 'approve' | 'reject' | 'pending' {
  if (cfg.voteMinUpvotes <= 0) return 'approve';
  const total = r.upvotes + r.downvotes;
  const yes = total ? r.upvotes / total : 0;
  if (r.upvotes >= cfg.voteMinUpvotes && yes >= cfg.consensusRatio) return 'approve';
  if (cfg.rejectMinDownvotes > 0 && r.downvotes >= cfg.rejectMinDownvotes && r.downvotes > r.upvotes) return 'reject';
  return 'pending';
}

/** Human summary of what a proposal still needs. */
export function consensusProgress(r: { upvotes: number; downvotes: number }, cfg: ConsensusConfig): string {
  if (cfg.voteMinUpvotes <= 0) return '';
  const need = Math.max(0, cfg.voteMinUpvotes - r.upvotes);
  const total = r.upvotes + r.downvotes;
  const pct = total ? Math.round((100 * r.upvotes) / total) : 0;
  const parts = [];
  void pct;
  if (need > 0) parts.push(`${need} more ${need === 1 ? 'person' : 'people'} to want it`);
  if (total && r.upvotes / total < cfg.consensusRatio) parts.push('more yes votes than no');
  return parts.length ? `Needs ${parts.join(' and ')}` : '';
}

export function toQueueItem(r: RequestRow): QueueItem {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    submitter: r.username,
    priority: r.priority,
    score: r.score,
    createdAt: r.created_at,
  };
}

export function laneLabel(lane: string | null): string {
  if (!lane) return '';
  return lane === 'integration' ? 'the integration lane' : `lane ${lane}`;
}
