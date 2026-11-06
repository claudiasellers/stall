// End-to-end run: real app + real orchestrator + a scratch git repo, with the mock agent.
// Exercises voting/consensus, admin approval, rejection, clarifying questions + resume,
// integration failures sent back for rework, merge conflicts, cancellation, and notifications.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

class Fatal extends Error {}
const tmp = mkdtempSync(join(tmpdir(), 'stall-e2e-'));
const repo = join(tmp, 'target');
const APP_PORT = 3100 + Math.floor(Math.random() * 500);
const ORCH_PORT = APP_PORT + 1000;
const TOKEN = 'orch-token-' + Math.random().toString(36).slice(2);
const SECRET = 'whsec-' + Math.random().toString(36).slice(2);
const base = `http://127.0.0.1:${APP_PORT}`;

// ---- scratch target repo
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
writeFileSync(join(repo, 'README.md'), '# target\n');
writeFileSync(join(repo, 'shared.txt'), 'original\n');
execFileSync('git', ['-C', repo, 'add', '-A']);
execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
if (!process.env.E2E_CHECKED_OUT) execFileSync('git', ['-C', repo, 'checkout', '-q', '--detach']); // else: main stays checked out and is fast-forwarded

const procs: ChildProcess[] = [];
function start(name: string, script: string, env: Record<string, string>) {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (d: Buffer) => process.env.E2E_VERBOSE && process.stdout.write(`[${name}] ${d}`);
  p.stdout!.on('data', out);
  p.stderr!.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  procs.push(p);
  return p;
}
const cleanup = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('exit', cleanup);

start('app', 'app/src/server.ts', {
  PORT: String(APP_PORT),
  STALL_DB: join(tmp, 'app.db'),
  STALL_ORCH_TOKEN: TOKEN,
  STALL_WEBHOOK_URL: `http://127.0.0.1:${ORCH_PORT}/webhook`,
  STALL_WEBHOOK_SECRET: SECRET,
  VOTE_MIN_UPVOTES: '2',
  CONSENSUS_RATIO: '0.6',
  REJECT_MIN_DOWNVOTES: '2',
});
await waitFor(async () => (await fetch(`${base}/api/v1/config`)).ok, 'app up');

start('orch', 'orchestrator/src/index.ts', {
  ORCH_PORT: String(ORCH_PORT),
  STALL_APP_URL: base,
  STALL_ORCH_TOKEN: TOKEN,
  STALL_WEBHOOK_SECRET: SECRET,
  ORCH_DATA_DIR: join(tmp, 'orch'),
  TARGET_REPO: repo,
  AGENT: 'mock',
  MOCK_DELAY_MS: '200',
  TEST_CMD: 'test ! -f BROKEN',
  BUILD_CMD: 'true',
  POLL_INTERVAL_SEC: '2',
  WORKER_LANES: '4',
});
await waitFor(async () => (await fetch(`http://127.0.0.1:${ORCH_PORT}/health`).catch(() => null))?.ok ?? false, 'orchestrator up');

// ---- tiny client with cookies + csrf
class Client {
  cookie = '';
  csrf = '';
  async call(method: string, path: string, body?: unknown, expect = 200) {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: this.cookie, ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const data = await res.json().catch(() => ({}));
    assert.equal(res.status, expect, `${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
    if (data.csrf) this.csrf = data.csrf;
    return data;
  }
}
const alice = new Client(), bob = new Client(), carol = new Client();
const a = await alice.call('POST', '/auth/signup', { username: 'alice', password: 'password123' });
assert.equal(a.user.isAdmin, true, 'first user is admin');
const b = await bob.call('POST', '/auth/signup', { username: 'bob', password: 'password123' });
assert.equal(b.user.isAdmin, false);
await carol.call('POST', '/auth/signup', { username: 'carol', password: 'password123' });
await bob.call('POST', '/auth/signup', { username: 'Bob', password: 'password123' }, 409);
await new Client().call('POST', '/auth/login', { username: 'bob', password: 'wrong-password' }, 401);

// CSRF: a cookie without the token is refused
const noCsrf = new Client();
noCsrf.cookie = bob.cookie;
await noCsrf.call('POST', '/requests', { title: 'x'.repeat(5), description: 'y'.repeat(20) }, 403);

const mk = async (c: Client, title: string, description: string) => (await c.call('POST', '/requests', { title, description }, 201)).request;
const get = async (c: Client, id: number) => (await c.call('GET', `/requests/${id}`)).request;

const plain = await mk(alice, 'Plain feature', 'Add a plain feature to the repo please.');
const ask = await mk(alice, 'Feature with a question', 'Add a coloured banner. [ask]');
const brk = await mk(bob, 'Breaks tests first', 'This one breaks the tests at first. [break]');
const c1 = await mk(alice, 'Conflict one', 'Edit the shared file. [conflict]');
const c2 = await mk(carol, 'Conflict two', 'Also edit the shared file. [conflict]');
const unpopular = await mk(carol, 'Unpopular idea', 'Something nobody else wants.');
const cancelMe = await mk(bob, 'Cancel me later', 'Will be cancelled while waiting. [ask]');

assert.equal(plain.status, 'proposed');
// consensus: 2 upvotes, >= 60% yes
await bob.call('POST', `/requests/${plain.id}/vote`, { value: 1 });
assert.equal((await get(alice, plain.id)).status, 'queued', 'consensus queues it');
// non-admin cannot approve
await bob.call('POST', `/requests/${ask.id}/approve`, {}, 403);
// admin approval bypasses votes
await alice.call('POST', `/requests/${ask.id}/approve`, {});
await alice.call('POST', `/requests/${brk.id}/vote`, { value: 1 });
await alice.call('POST', `/requests/${c1.id}/approve`, {});
await alice.call('POST', `/requests/${c2.id}/approve`, {});
await alice.call('POST', `/requests/${cancelMe.id}/approve`, {});
// two downvotes, 1 up -> rejected
await alice.call('POST', `/requests/${unpopular.id}/vote`, { value: -1 });
await bob.call('POST', `/requests/${unpopular.id}/vote`, { value: -1 });
assert.equal((await get(carol, unpopular.id)).status, 'rejected');
await bob.call('POST', `/requests/${unpopular.id}/vote`, { value: 1 }, 409); // voting closed

// the question arrives; only the submitter can answer
await waitFor(async () => (await get(alice, ask.id)).status === 'needs_info', 'question asked');
await bob.call('POST', `/requests/${ask.id}/reply`, { body: 'Purple' }, 403);
const notes = await alice.call('GET', '/notifications');
assert.ok(notes.notifications.some((n: { body: string }) => n.body.includes('question')), 'question notification');
await alice.call('POST', `/requests/${ask.id}/reply`, { body: 'Orange, please' });

// cancel one that is waiting on an answer
await waitFor(async () => (await get(bob, cancelMe.id)).status === 'needs_info', 'second question asked');
await bob.call('POST', `/requests/${cancelMe.id}/cancel`, {});

const built = [plain, ask, brk, c1, c2];
await waitFor(async () => {
  const s = await Promise.all(built.map(async (r) => (await get(alice, r.id)).status));
  if (s.includes('failed')) throw new Fatal(`a request failed: ${JSON.stringify(s)}`);
  return s.every((x) => x === 'done');
}, 'all built and merged', 60_000);

// ---- verify the repo
const log = execFileSync('git', ['-C', repo, 'log', '--oneline', 'main']).toString();
for (const r of built) assert.ok(log.includes(`Merge #${r.id}:`), `main has merge for #${r.id}`);
const files = execFileSync('git', ['-C', repo, 'ls-tree', '-r', '--name-only', 'main']).toString();
for (const r of built) assert.ok(files.includes(`features/req-${r.id}.md`), `feature file for #${r.id}`);
assert.ok(!files.includes('BROKEN'), 'broken file was fixed in rework');
const askFile = execFileSync('git', ['-C', repo, 'show', `main:features/req-${ask.id}.md`]).toString();
assert.ok(askFile.includes('Orange, please'), 'answer reached the resumed lane');
assert.ok(!files.includes(`features/req-${cancelMe.id}.md`), 'cancelled request was not merged');

const brkDetail = await bob.call('GET', `/requests/${brk.id}`);
assert.ok(brkDetail.messages.some((m: { body: string }) => m.body.includes('checks failed')), 'rework note on timeline');
const done = await alice.call('GET', `/requests/${plain.id}`);
assert.match(done.request.commit, /^[0-9a-f]{40}$/);
const bobNotes = await bob.call('GET', '/notifications');
assert.ok(bobNotes.notifications.some((n: { body: string }) => n.body.includes('you voted for')), 'voters notified');
const board = await alice.call('GET', '/board');
assert.equal(board.orchestrator, 'online');
assert.equal(board.lanes.length, 5);
assert.equal((await get(bob, cancelMe.id)).status, 'cancelled');
await waitFor(async () => !existsSync(join(`${repo}.stall-worktrees`, `req-${cancelMe.id}`)), 'cancelled worktree removed');
for (const r of built) assert.ok(!existsSync(join(`${repo}.stall-worktrees`, `req-${r.id}`)), `worktree cleaned for #${r.id}`);

console.log('\n' + execFileSync('git', ['-C', repo, 'log', '--graph', '--oneline', 'main']).toString());
console.log('E2E PASSED');
cleanup();
process.exit(0);

async function waitFor(fn: () => Promise<boolean>, what: string, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return;
    } catch (e) {
      if (Date.now() > end || e instanceof Fatal || e instanceof assert.AssertionError) throw e;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
void readFileSync;
