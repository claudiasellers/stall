import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { run, Mutex, type ExecResult } from './exec.ts';
import type { OrchConfig } from './config.ts';

export class GitError extends Error {
  result: ExecResult;
  constructor(msg: string, result: ExecResult) {
    super(`${msg}\n${result.output.trim()}`);
    this.result = result;
  }
}

export class Git {
  cfg: OrchConfig;
  /** Repo-wide operations (fetch, worktree add/remove, ref updates) go through here. */
  repoLock = new Mutex();
  constructor(cfg: OrchConfig) {
    this.cfg = cfg;
  }

  async git(cwd: string, args: string[], allowFail = false): Promise<ExecResult> {
    const r = await run('git', args, { cwd, timeoutMs: 5 * 60_000 });
    if (r.code !== 0 && !allowFail) throw new GitError(`git ${args.join(' ')} failed`, r);
    return r;
  }

  async out(cwd: string, args: string[]): Promise<string> {
    return (await this.git(cwd, args)).stdout.trim();
  }

  /** The ref new branches start from and integration merges onto. */
  get baseRef(): string {
    return this.cfg.remote ? `refs/remotes/${this.cfg.remote}/${this.cfg.baseBranch}` : `refs/heads/${this.cfg.baseBranch}`;
  }

  async init() {
    const { repo } = this.cfg;
    if (!existsSync(repo)) throw new Error(`TARGET_REPO ${repo} does not exist`);
    await this.git(repo, ['rev-parse', '--git-dir']);
    await mkdir(this.cfg.worktreeRoot, { recursive: true });
    await this.fetch();
    await this.git(repo, ['rev-parse', '--verify', this.baseRef]).catch(() => {
      throw new Error(`Base ref ${this.baseRef} not found in ${repo}`);
    });
    await this.git(repo, ['worktree', 'prune']);
  }

  async fetch() {
    if (!this.cfg.remote) return;
    await this.repoLock.lock(() => this.git(this.cfg.repo, ['fetch', '--prune', this.cfg.remote]));
  }

  /** Create (or reattach) the worktree for a feature branch. */
  async ensureWorktree(path: string, branch: string): Promise<'created' | 'existing'> {
    if (existsSync(path)) {
      const r = await this.git(path, ['rev-parse', '--abbrev-ref', 'HEAD'], true);
      if (r.code === 0 && r.stdout.trim() === branch) return 'existing';
    }
    await this.fetch();
    return this.repoLock.lock(async () => {
      const { repo } = this.cfg;
      await this.git(repo, ['worktree', 'prune']);
      if (existsSync(path)) await this.git(repo, ['worktree', 'remove', '--force', path], true);
      const exists = (await this.git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], true)).code === 0;
      if (exists) await this.git(repo, ['worktree', 'add', path, branch]);
      else await this.git(repo, ['worktree', 'add', '-b', branch, path, this.baseRef]);
      return 'created' as const;
    });
  }

  async removeWorktree(path: string, branch?: string) {
    await this.repoLock.lock(async () => {
      const { repo } = this.cfg;
      await this.git(repo, ['worktree', 'remove', '--force', path], true);
      await this.git(repo, ['worktree', 'prune'], true);
      if (branch) await this.git(repo, ['branch', '-D', branch], true);
    });
  }

  /** Commit anything Claude left uncommitted. Returns true if a commit was made. */
  async commitAll(cwd: string, message: string): Promise<boolean> {
    await this.git(cwd, ['add', '-A']);
    const dirty = (await this.git(cwd, ['diff', '--cached', '--quiet'], true)).code !== 0;
    if (!dirty) return false;
    await this.git(cwd, ['-c', 'user.name=Stall', '-c', 'user.email=stall@localhost', 'commit', '-q', '--no-verify', '-m', message]);
    return true;
  }

  async commitsAhead(cwd: string): Promise<number> {
    return Number(await this.out(cwd, ['rev-list', '--count', `${this.baseRef}..HEAD`]));
  }

  async changedFiles(cwd: string): Promise<string[]> {
    const s = await this.out(cwd, ['diff', '--name-only', `${this.baseRef}...HEAD`]);
    return s ? s.split('\n') : [];
  }
}
