// Four worker lanes (each request gets its own git worktree) + one integration lane
// that only merges, builds, tests and publishes. The Stall app owns the queue;
// lanes claim from it atomically, so the orchestrator can restart at any time.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { OrchConfig } from './config.ts';
import type { AppClient } from './appClient.ts';
import type { Store, Job } from './store.ts';
import type { Agent, AgentMode } from './agent.ts';
import { Git } from './git.ts';
import { run, tail } from './exec.ts';
import { log } from './log.ts';
import type { QueueItem, RequestDetail } from '../../shared/types.ts';

type LaneState = { id: string; requestId: number | null; detail: string; abort?: AbortController };

export class Orchestrator {
  cfg: OrchConfig;
  app: AppClient;
  store: Store;
  agent: Agent;
  git: Git;
  lanes: LaneState[];
  integration: LaneState = { id: 'integration', requestId: null, detail: 'Idle' };
  private pumping = false;
  private pumpAgain = false;
  private integrating = false;
  private integrateAgain = false;
  private stopped = false;
  private heartbeatTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  private inflight = new Set<Promise<unknown>>();

  constructor(cfg: OrchConfig, app: AppClient, store: Store, agent: Agent) {
    this.cfg = cfg;
    this.app = app;
    this.store = store;
    this.agent = agent;
    this.git = new Git(cfg);
    this.lanes = Array.from({ length: cfg.workerLanes }, (_, i) => ({ id: String(i + 1), requestId: null, detail: 'Idle' }));
  }

  async start() {
    await this.git.init();
    await this.recover();
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), 30_000);
    this.pollTimer = setInterval(() => {
      this.pump();
      this.kickIntegration();
    }, this.cfg.pollMs);
    await this.heartbeat();
    this.pump();
    this.kickIntegration();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.heartbeatTimer);
    clearInterval(this.pollTimer);
    for (const l of this.lanes) l.abort?.abort();
    await Promise.allSettled([...this.inflight]);
    await this.app.lanes([...this.lanes, this.integration].map((l) => ({ id: l.id, state: 'offline' }))).catch(() => {});
  }

  private track<T>(p: Promise<T>) {
    this.inflight.add(p);
    p.finally(() => this.inflight.delete(p));
    return p;
  }

  /** After a crash: anything mid-flight goes back through the queue (and resumes its session). */
  private async recover() {
    for (const job of this.store.byPhase('working')) {
      log('recover', `#${job.request_id} was mid-build; requeueing to resume`);
      try {
        await this.app.requeue(job.request_id, 'The builder restarted. Resuming where it left off.');
      } catch (e) {
        log('recover', `#${job.request_id} requeue failed: ${(e as Error).message}`);
      }
    }
    for (const job of this.store.byPhase('integrating')) this.store.update(job.request_id, { phase: 'ready' });
  }

  status() {
    return {
      lanes: this.lanes.map(({ id, requestId, detail }) => ({ id, requestId, detail, state: requestId ? 'working' : 'idle' })),
      integration: { id: 'integration', requestId: this.integration.requestId, detail: this.integration.detail, state: this.integration.requestId ? 'working' : 'idle' },
      ready: this.store.byPhase('ready').map((j) => j.request_id),
    };
  }

  async heartbeat() {
    const s = this.status();
    await this.app.lanes([...s.lanes, s.integration]).catch((e) => log('heartbeat', (e as Error).message));
  }

  // ------------------------------------------------------------------ worker lanes

  /** Fill free lanes from the app's queue. Safe to call any time (webhook, poll, lane freed). */
  pump() {
    if (this.stopped) return;
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    void this.track(
      (async () => {
        try {
          do {
            this.pumpAgain = false;
            const free = this.lanes.filter((l) => l.requestId === null);
            if (!free.length) break;
            const queue = await this.app.queue();
            for (const item of queue) {
              const lane = this.lanes.find((l) => l.requestId === null);
              if (!lane) break;
              if (this.lanes.some((l) => l.requestId === item.id)) continue;
              if (!(await this.app.claim(item.id, lane.id))) continue; // someone else got it
              lane.requestId = item.id;
              lane.detail = item.title;
              void this.track(this.runWorker(lane, item));
            }
          } while (this.pumpAgain && !this.stopped);
        } catch (e) {
          log('pump', `queue fetch failed: ${(e as Error).message}`);
        } finally {
          this.pumping = false;
        }
      })(),
    );
  }

  private async runWorker(lane: LaneState, item: QueueItem) {
    const id = item.id;
    const L = (...a: unknown[]) => log(`lane ${lane.id}`, `#${id}`, ...a);
    lane.abort = new AbortController();
    void this.heartbeat();
    let job = this.store.get(id);
    try {
      if (!job || ['done', 'failed', 'cancelled'].includes(job.phase)) {
        if (job) this.store.db.prepare('DELETE FROM jobs WHERE request_id = ?').run(id);
        job = this.store.create({
          request_id: id,
          title: item.title,
          branch: `stall/${id}-${slug(item.title)}`,
          worktree: join(this.cfg.worktreeRoot, `req-${id}`),
        });
      }
      const mode: AgentMode =
        job.phase === 'waiting_reply' ? 'answer' : job.phase === 'rework' ? 'rework' : job.session_id ? 'resume' : 'fresh';
      L(`start (${mode})`);

      const created = await this.git.ensureWorktree(job.worktree, job.branch);
      if (created === 'created' && this.cfg.setupCmd) {
        lane.detail = `${item.title} (setup)`;
        const r = await run(this.cfg.setupCmd, [], { cwd: job.worktree, shell: true, timeoutMs: this.cfg.checkTimeoutMs });
        if (r.code !== 0) L(`setup command failed (continuing): ${tail(r.output, 500)}`);
      }
      this.store.update(id, { phase: 'working', lane: lane.id });
      await this.app.progress(id, {
        status: 'in_progress',
        lane: lane.id,
        branch: job.branch,
        note: mode === 'fresh' ? `Started on branch ${job.branch}.` : undefined,
      });

      const detail = await this.app.detail(id);
      const result = await this.agent.run({
        request: detail,
        mode,
        cwd: job.worktree,
        branch: job.branch,
        baseRef: this.git.baseRef,
        prompt: buildPrompt(mode, detail, job),
        systemAppend: systemAppend(this.cfg, job, this.git.baseRef),
        resumeSessionId: mode === 'fresh' ? null : job.session_id,
        signal: lane.abort.signal,
        askSubmitter: (q) => this.app.question(id, q),
        postUpdate: (note) => this.app.progress(id, { note }),
        onSession: (sid) => this.store.update(id, { session_id: sid }),
        log: L,
      });

      if (lane.abort.signal.aborted) return; // cancelled; cleanup handled by cancel()

      if (result.asked) {
        await this.git.commitAll(job.worktree, `WIP #${id}: paused for a question`);
        this.store.update(id, { phase: 'waiting_reply', lane: null });
        L('paused for submitter');
        return;
      }
      if (result.isError) throw new Error(`Claude stopped with an error: ${result.text || 'unknown'}`);

      await this.git.commitAll(job.worktree, `#${id}: ${item.title}`);
      const ahead = await this.git.commitsAhead(job.worktree);
      if (ahead === 0) throw new Error(`Claude finished without changing anything. Its note: ${result.text || '(none)'}`);

      const summary = (result.text || `Implemented "${item.title}".`).slice(0, 3000);
      this.store.update(id, { phase: 'ready', lane: null, summary, rework_note: null });
      await this.app.progress(id, { status: 'integrating', lane: null, note: 'Work is done on the branch. Waiting for the integration lane to build, test and merge it.' });
      L(`ready (${ahead} commit(s)${result.costUsd ? `, $${result.costUsd.toFixed(2)}` : ''})`);
      this.kickIntegration();
    } catch (e) {
      if (lane.abort.signal.aborted) return;
      const msg = (e as Error).message ?? String(e);
      L(`failed: ${msg}`);
      this.store.update(id, { phase: 'failed', lane: null });
      await this.app.fail(id, tail(msg, 2000)).catch(() => {});
    } finally {
      lane.requestId = null;
      lane.detail = 'Idle';
      lane.abort = undefined;
      void this.heartbeat();
      this.pump();
    }
  }

  // ------------------------------------------------------------------ integration lane

  kickIntegration() {
    if (this.stopped) return;
    if (this.integrating) {
      this.integrateAgain = true;
      return;
    }
    this.integrating = true;
    void this.track(
      (async () => {
        try {
          do {
            this.integrateAgain = false;
            for (;;) {
              const [job] = this.store.byPhase('ready');
              if (!job || this.stopped) break;
              await this.integrate(job);
            }
          } while (this.integrateAgain && !this.stopped);
        } finally {
          this.integrating = false;
          this.integration.requestId = null;
          this.integration.detail = 'Idle';
          void this.heartbeat();
        }
      })(),
    );
  }

  private async integrate(job: Job) {
    const id = job.request_id;
    const L = (...a: unknown[]) => log('integration', `#${id}`, ...a);
    const wt = join(this.cfg.worktreeRoot, 'integration');
    this.store.update(id, { phase: 'integrating' });
    this.integration.requestId = id;
    this.integration.detail = job.title;
    void this.heartbeat();
    try {
      await this.app.progress(id, { status: 'integrating', lane: 'integration', note: 'Integration lane: merging onto the latest base and running checks.' });
    } catch (e) {
      L(`app refused progress (${(e as Error).message}); dropping`);
      this.store.update(id, { phase: 'cancelled' });
      return;
    }

    try {
      await this.ensureIntegrationWorktree(wt);
      for (let attempt = 1; attempt <= 3; attempt++) {
        await this.git.fetch();
        await this.git.git(wt, ['checkout', '-q', '--detach', '--force', this.git.baseRef]);
        await this.git.git(wt, ['reset', '-q', '--hard', this.git.baseRef]);
        await this.git.git(wt, ['clean', '-fdq']);
        const before = await this.git.out(wt, ['rev-parse', 'HEAD']);

        const merge = await this.git.git(
          wt,
          ['-c', 'user.name=Stall', '-c', 'user.email=stall@localhost', 'merge', '--no-ff', '--no-edit', '-m', `Merge #${id}: ${job.title}`, job.branch],
          true,
        );
        if (merge.code !== 0) {
          const conflicts = (await this.git.git(wt, ['diff', '--name-only', '--diff-filter=U'], true)).stdout.trim();
          await this.git.git(wt, ['merge', '--abort'], true);
          return this.rework(job, `Merge conflict with ${this.cfg.baseBranch}${conflicts ? ` in: ${conflicts.split('\n').join(', ')}` : ''}.`, 'conflict');
        }

        for (const [name, cmd] of [['Build', this.cfg.buildCmd], ['Tests', this.cfg.testCmd]] as const) {
          if (!cmd) continue;
          this.integration.detail = `${job.title} (${name.toLowerCase()})`;
          L(`running ${name.toLowerCase()}: ${cmd}`);
          const r = await run(cmd, [], { cwd: wt, shell: true, timeoutMs: this.cfg.checkTimeoutMs });
          if (r.code !== 0) {
            await this.git.git(wt, ['reset', '-q', '--hard', before], true);
            return this.rework(job, `${name} failed${r.timedOut ? ' (timed out)' : ''} after merging onto ${this.cfg.baseBranch}.\n\n${tail(r.output, 6000)}`, 'checks');
          }
        }

        if (this.store.get(id)?.phase === 'cancelled') {
          L('cancelled before publish');
          return;
        }
        const merged = await this.git.out(wt, ['rev-parse', 'HEAD']);
        const published = await this.publish(wt, before, merged);
        if (!published) {
          L(`base moved during checks; retrying (${attempt}/3)`);
          continue;
        }
        L(`merged as ${merged.slice(0, 10)}`);
        this.store.update(id, { phase: 'done' });
        await this.app.complete(id, { summary: job.summary ?? `Merged "${job.title}".`, commit: merged, branch: job.branch });
        await this.git.removeWorktree(job.worktree, this.cfg.remote ? undefined : job.branch).catch(() => {});
        return;
      }
      throw new Error(`${this.cfg.baseBranch} kept moving while checks ran; gave up after 3 attempts`);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      L(`failed: ${msg}`);
      this.store.update(id, { phase: 'failed' });
      await this.app.fail(id, `Integration failed: ${tail(msg, 2000)}`).catch(() => {});
    }
  }

  private async ensureIntegrationWorktree(wt: string) {
    if (existsSync(join(wt, '.git'))) return;
    await this.git.repoLock.lock(async () => {
      await this.git.git(this.cfg.repo, ['worktree', 'prune']);
      await this.git.git(this.cfg.repo, ['worktree', 'add', '--detach', wt, this.git.baseRef]);
    });
    if (this.cfg.setupCmd) await run(this.cfg.setupCmd, [], { cwd: wt, shell: true, timeoutMs: this.cfg.checkTimeoutMs });
  }

  /** Move the base branch to `merged` iff it is still at `before`. Returns false if it moved. */
  private async publish(wt: string, before: string, merged: string): Promise<boolean> {
    const { repo, remote, baseBranch } = this.cfg;
    if (remote) {
      // The remote is the source of truth; a non-fast-forward means someone else merged first.
      const r = await this.git.git(wt, ['push', remote, `${merged}:refs/heads/${baseBranch}`], true);
      if (r.code !== 0) {
        if (/non-fast-forward|fetch first|rejected/i.test(r.output)) return false;
        throw new Error(`git push failed:\n${tail(r.output, 1500)}`);
      }
      await this.git.fetch();
      return true;
    }
    return this.git.repoLock.lock(async () => {
      // If the main checkout has the base branch checked out, fast-forward it so its files update too.
      const head = (await this.git.git(repo, ['symbolic-ref', '-q', 'HEAD'], true)).stdout.trim();
      const bare = (await this.git.out(repo, ['rev-parse', '--is-bare-repository'])) === 'true';
      if (!bare && head === `refs/heads/${baseBranch}`) {
        const cur = await this.git.out(repo, ['rev-parse', 'HEAD']);
        if (cur !== before) return false;
        const r = await this.git.git(repo, ['merge', '--ff-only', '-q', merged], true);
        if (r.code !== 0) throw new Error(`Could not fast-forward ${baseBranch} in ${repo} (uncommitted changes there?):\n${tail(r.output, 1500)}`);
        return true;
      }
      const r = await this.git.git(repo, ['update-ref', `refs/heads/${baseBranch}`, merged, before], true);
      return r.code === 0;
    });
  }

  private async rework(job: Job, reason: string, kind: 'conflict' | 'checks') {
    const id = job.request_id;
    const count = job.rework_count + 1;
    if (count > this.cfg.maxRework) {
      this.store.update(id, { phase: 'failed' });
      await this.app.fail(id, `Integration rejected the branch ${count} times. Last problem: ${tail(reason, 1500)}`);
      return;
    }
    log('integration', `#${id} sending back for rework (${kind}, ${count}/${this.cfg.maxRework})`);
    this.store.update(id, { phase: 'rework', rework_note: reason, rework_count: count });
    await this.app.requeue(id, kind === 'conflict' ? `Integration found a merge conflict; sending it back to a lane to fix. ${reason}` : `Integration checks failed; sending it back to a lane to fix.`);
    this.pump();
  }

  // ------------------------------------------------------------------ events from the app

  async cancel(id: number) {
    const lane = this.lanes.find((l) => l.requestId === id);
    const job = this.store.get(id);
    if (lane?.abort) {
      log(`lane ${lane.id}`, `#${id} cancelled; stopping`);
      lane.abort.abort();
    }
    if (job && !['done', 'cancelled'].includes(job.phase)) {
      this.store.update(id, { phase: 'cancelled' });
      // Give an aborted agent a moment to exit before removing its worktree.
      setTimeout(() => void this.git.removeWorktree(job.worktree, job.branch).catch(() => {}), 2000).unref();
    }
  }
}

// ------------------------------------------------------------------ prompts

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'request';
}

function thread(detail: RequestDetail) {
  return detail.messages
    .filter((m) => m.author !== 'system')
    .map((m) => `[${m.author === 'claude' ? (m.kind === 'question' ? 'You asked' : 'You noted') : `${detail.submitter} ${m.kind === 'reply' ? 'answered' : 'commented'}`}] ${m.body}`)
    .join('\n');
}

function buildPrompt(mode: AgentMode, d: RequestDetail, job: Job): string {
  const request = `Feature request #${d.id} from ${d.submitter}\nTitle: ${d.title}\n\n${d.description}`;
  if (mode === 'fresh') return `${request}\n\nImplement this feature in this repository.`;
  if (mode === 'answer') {
    const lastQ = d.messages.map((m) => m.kind).lastIndexOf('question');
    const replies = d.messages.slice(lastQ + 1).filter((m) => m.author === 'user').map((m) => m.body);
    return `${d.submitter} answered your question:\n\n${replies.join('\n\n') || '(no text)'}\n\nContinue implementing request #${d.id}. If this session has lost context, here it is again:\n\n${request}\n\nConversation so far:\n${thread(d)}`;
  }
  if (mode === 'rework') {
    return `The integration lane rejected your branch for request #${d.id}:\n\n${job.rework_note}\n\nFix this on your branch. If the problem is a merge conflict or the base moved, first run \`git merge ${'<base>'}\` (see the system notes for the exact ref), resolve conflicts, and commit. Then make sure the build and tests pass.\n\nOriginal request:\n${request}`;
  }
  return `You were interrupted while implementing request #${d.id} (the builder restarted). Check \`git status\` and \`git log\` to see where you were, then finish the work.\n\n${request}\n\nConversation so far:\n${thread(d) || '(none)'}`;
}

function systemAppend(cfg: OrchConfig, job: Job, baseRef: string): string {
  const base = baseRef.replace(/^refs\/(heads|remotes)\//, '');
  return `
## You are a Stall worker lane
You implement one feature request from the Stall app, unattended, in a dedicated git worktree.

- Working directory: ${job.worktree} (branch \`${job.branch}\`, started from \`${base}\`).
- Only touch files inside this directory. Do not switch branches, push, rebase shared history, or merge into \`${cfg.baseBranch}\`; a separate integration lane does that after you finish. To pick up the latest base, use \`git merge ${base}\`.
- Commit your work in logical commits with clear messages. Anything uncommitted when you finish is committed for you.
- The integration lane will run${cfg.buildCmd ? ` \`${cfg.buildCmd}\`` : ''}${cfg.buildCmd && cfg.testCmd ? ' and' : ''}${cfg.testCmd ? ` \`${cfg.testCmd}\`` : ''}${!cfg.buildCmd && !cfg.testCmd ? ' no automated checks' : ''}. Run the same checks yourself before you finish and add or update tests for what you build.
- Follow the repository's own conventions (README, CLAUDE.md, existing code style).
- If the request is ambiguous in a way that would change what you build, call the \`ask_submitter\` tool with one focused question written for a non-engineer, commit any work in progress, and end your turn immediately. Otherwise make sensible assumptions and mention them in your summary.
- Use \`post_update\` sparingly for real milestones.
- Your final message is shown to the submitter as "What shipped". Make it 2–4 plain-language sentences about what changed and any assumptions, no code.
`.trim();
}
