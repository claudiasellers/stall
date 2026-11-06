import { spawn } from 'node:child_process';

export type ExecResult = { code: number; stdout: string; stderr: string; output: string; timedOut: boolean };

const MAX_BUF = 2 * 1024 * 1024;

/** Run a command (argv form, or a shell string when `shell` is true) and capture output. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; shell?: boolean; timeoutMs?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal } ,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      shell: opts.shell ?? false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env },
      signal: opts.signal,
      detached: process.platform !== 'win32', // own process group so timeouts kill children too
    });
    let stdout = '';
    let stderr = '';
    let output = '';
    let timedOut = false;
    const take = (buf: string, chunk: string) => (buf.length > MAX_BUF ? buf : buf + chunk);
    child.stdout.on('data', (d) => { stdout = take(stdout, String(d)); output = take(output, String(d)); });
    child.stderr.on('data', (d) => { stderr = take(stderr, String(d)); output = take(output, String(d)); });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }, opts.timeoutMs)
      : undefined;
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr + String(e), output: output + String(e), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, output, timedOut });
    });
  });
}

export const tail = (s: string, n = 4000) => (s.length > n ? '…' + s.slice(-n) : s);

/** Serializes async sections (used for repo-wide git operations). */
export class Mutex {
  private p: Promise<void> = Promise.resolve();
  lock<T>(fn: () => Promise<T>): Promise<T> {
    const out = this.p.then(fn);
    this.p = out.then(() => undefined, () => undefined);
    return out;
  }
}
