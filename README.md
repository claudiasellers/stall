# Stall

Stall is a feature-request app. People sign in, suggest features, and vote on them. Once a request reaches consensus, or an admin approves it, it enters a build queue. A Claude orchestrator picks it up, builds it in one of **four parallel worker lanes** (each in its own git worktree), and hands the finished branch to a **fifth integration lane** that only merges, builds, tests, and publishes. Claude can stop and ask the submitter a question in the app, and the submitter's answer resumes the work. People get notified in the app, and on their phone if they turn notifications on, when Claude has a question and when their feature ships.

The web app is an installable PWA: open it on a phone and use **Share → Add to Home Screen** (iPhone) or **Install app** (Android). Everything the web app does goes through a JSON API (`/api/v1`) that a native iOS app can use later without changes.

```
┌──────────── Stall app (npm run app) ─────────────┐          ┌──────── Orchestrator (npm run orchestrator) ────────┐
│ PWA (app/public)  ──►  /api/v1  (users, votes,   │ webhook  │  POST /webhook ─► pump()                            │
│                         questions, notifications)│ ───────► │                                                     │
│ SQLite: users, requests, votes, messages,        │  signed  │  Lane 1 ─┐ claim from queue, own worktree per       │
│         notifications, webhook_outbox            │          │  Lane 2  │ request, Claude Agent SDK, can call      │
│                                                  │ ◄─────── │  Lane 3  │ ask_submitter → pause → resume session   │
│ /api/orch  (claim, progress, question, requeue,  │  bearer  │  Lane 4 ─┘                                          │
│             complete, fail, lanes heartbeat)     │  token   │  Integration: merge onto base → BUILD_CMD →         │
└──────────────────────────────────────────────────┘          │  TEST_CMD → push / fast-forward → notify, or send   │
                                                              │  back to a lane for rework                          │
                                                              └─────────────────────────────────────────────────────┘
```

## Quick start (local, no Claude)

Requires Node 22.18+ (TypeScript runs directly through Node's type stripping, so there is no build step) and git.

```bash
npm install
npm test          # unit tests
npm run e2e       # full pipeline: app + orchestrator + scratch repo + mock agent
```

`npm run e2e` starts both services against a throwaway git repo and runs the whole flow: signup and login, CSRF, consensus voting, admin approval, rejection by vote, a clarifying question with the answer reaching the resumed lane, a branch that fails tests and is fixed on rework, two branches that conflict, cancellation, and notifications to submitters and voters. It finishes by printing the merge graph of the repo.

To click around yourself:

```bash
export STALL_ORCH_TOKEN=$(openssl rand -hex 32) STALL_WEBHOOK_SECRET=$(openssl rand -hex 32)

# terminal 1: the app on http://localhost:3000 (the first account you create is the admin)
STALL_WEBHOOK_URL=http://127.0.0.1:4100/webhook npm run app

# terminal 2: the orchestrator against any git repo, with the mock agent
git clone <some repo> /tmp/target
STALL_APP_URL=http://127.0.0.1:3000 TARGET_REPO=/tmp/target AGENT=mock npm run orchestrator
```

## Running it for real

1. **Pick the repo Claude builds in.** Make a dedicated clone for the orchestrator (`git clone git@github.com:you/your-product.git /srv/your-product`) with credentials that can push to the base branch. The orchestrator creates worktrees next to it in `/srv/your-product.stall-worktrees/`.
2. **Configure.** Copy `.env.example` to `.env` and fill it in. The two services share `STALL_ORCH_TOKEN` (orchestrator → app calls) and `STALL_WEBHOOK_SECRET` (app → orchestrator webhook signatures). Set `ANTHROPIC_API_KEY` for the orchestrator, and set `BUILD_CMD`, `TEST_CMD` and `WORKTREE_SETUP_CMD` to whatever your product uses.
3. **Run both processes** under a supervisor such as systemd, PM2 or a container platform: `node --env-file=.env --disable-warning=ExperimentalWarning app/src/server.ts` and the same for `orchestrator/src/index.ts`. They can run on different machines. The app only needs to reach `STALL_WEBHOOK_URL`, and the orchestrator only needs to reach `STALL_APP_URL`.
4. **Serve the app over HTTPS** with `COOKIE_SECURE=true` (and `TRUST_PROXY=true` behind a proxy). Phones only offer install and notifications on HTTPS.
5. **Phone notifications (optional):** run `npx web-push generate-vapid-keys` and set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`. On iPhone, notifications work once Stall is added to the Home Screen and opened from there (iOS 16.4+). Each person turns them on under Account.

The orchestrator runs Claude with permission prompts bypassed, because nobody is there to answer them. Run it in a container or VM whose only credentials are for the target repo.

## How a request flows

| Status | Meaning | Who moves it |
|---|---|---|
| `proposed` | Open for votes | Submitter (auto-upvotes their own) |
| `queued` | Approved, waiting for a free lane | Consensus reached, or an admin approved it |
| `in_progress` | A worker lane is building it | Orchestrator claim |
| `needs_info` | Claude asked the submitter a question | `ask_submitter` tool |
| `queued` (priority) | Submitter answered; jumps the queue | Submitter reply |
| `integrating` | Branch finished; waiting for or inside the integration lane | Worker lane |
| `done` | Merged into the base branch | Integration lane |
| `failed` / `rejected` / `cancelled` | Terminal (admins can retry a failed one) | Orchestrator / votes or admin / submitter or admin |

**Consensus.** A proposal is approved when it has at least `VOTE_MIN_UPVOTES` upvotes and at least `CONSENSUS_RATIO` of its votes are yes (by default 3 upvotes and 70%). It is auto-rejected once it has `REJECT_MIN_DOWNVOTES` downvotes and more downvotes than upvotes. Admins can approve or reject at any time and can make other people admins from the Account tab. Votes stay open while a request is queued and decide its order in the queue (replies and rework go first, then net votes, then age).

**Worker lanes.** Each lane claims the next request from the app (`POST /api/orch/requests/:id/claim` is atomic, so two lanes can never take the same one). The lane gets a worktree at `<repo>.stall-worktrees/req-<id>` on branch `stall/<id>-<slug>`, runs `WORKTREE_SETUP_CMD` there, and starts a Claude Agent SDK session in it. The session loads the target repo's `CLAUDE.md` and gets two extra tools:

- `ask_submitter(question)` posts the question to the request thread, notifies the submitter, and pauses. The lane commits any work in progress and is freed for other requests. When the submitter answers, the request returns to the front of the queue, and the next free lane resumes **the same Claude session in the same worktree** with the answer.
- `post_update(note)` adds a progress note to the timeline.

When Claude finishes, the lane commits anything left over, checks that the branch has commits, and marks it ready for integration. Claude's final message becomes the "What shipped" summary.

The worktree belongs to the request rather than the lane. That is what lets a paused request resume on any free lane with its files and session intact, while the four lanes are concurrency slots. A request that is waiting on an answer does not hold up a lane.

**Integration lane.** One at a time, it checks out the latest base in its own worktree, merges the branch with `--no-ff`, and runs `BUILD_CMD` then `TEST_CMD`. If everything passes, it publishes. With `GIT_REMOTE` set it pushes to the remote base branch, and if someone else pushed first it re-fetches and retries. Without a remote it fast-forwards the local base branch with a compare-and-swap. It then tells the app the request is done along with the merge commit SHA, and removes the worktree. A merge conflict or a failed check sends the request back through the queue to a worker lane, along with the conflict list or the tail of the failing output. After `MAX_REWORK` bounces the request is marked failed.

**Crash safety.** The app writes every queue event to a `webhook_outbox` row in the same transaction as the state change, and delivers it with signed retries and exponential backoff. The orchestrator also polls the queue every `POLL_INTERVAL_SEC`, so it never depends on a webhook arriving. The orchestrator keeps its own SQLite file with each request's worktree, branch and session. On restart it requeues anything that was mid-build, which resumes the Claude session, and it re-runs anything that was mid-integration.

## API

### For the web app and future native apps: `/api/v1`

The browser authenticates with an `HttpOnly` session cookie and sends `X-CSRF-Token` on writes. A native client sends `X-Stall-Client: native` to login or signup, gets a `token` back, and then uses `Authorization: Bearer <token>`. CSRF does not apply to bearer requests.

| Method & path | Body | Notes |
|---|---|---|
| `GET /config` | | Signup open, push public key, consensus settings |
| `POST /auth/signup`, `POST /auth/login` | `{username, password}` | → `{user, csrf, token?}` |
| `POST /auth/logout` | | |
| `GET /me` | | `{user, csrf, unread}` |
| `GET /requests?scope=proposed\|active\|done\|closed\|all\|mine` | | Includes `score`, `myVote`, `consensus` text |
| `POST /requests` | `{title, description}` | Starts as `proposed` |
| `GET /requests/:id` | | Request, timeline `messages`, permission flags `can.*`, queue position |
| `POST /requests/:id/vote` | `{value: 1\|-1\|0}` | |
| `POST /requests/:id/reply` | `{body}` | Submitter answers Claude's question |
| `POST /requests/:id/comment` | `{body}` | |
| `POST /requests/:id/cancel` | | Submitter or admin |
| `POST /requests/:id/approve` \| `reject` \| `retry` | | Admin |
| `GET /board` | | Lane states, working items, queue |
| `GET /notifications`, `POST /notifications/read` | `{requestId?}` | |
| `POST /push/subscribe`, `POST /push/unsubscribe` | Web Push subscription | |
| `GET /events` | | Server-sent events: `notification`, `board` |
| `GET /admin/users`, `POST /admin/users/:id/admin` | `{isAdmin}` | Admin |

For a native iOS app, the remaining work is APNs. Add a `devices` table and a sender next to `app/src/push.ts`. Both listen to the same `notify` event on the bus.

### For the orchestrator: `/api/orch` (bearer `STALL_ORCH_TOKEN`)

`GET /queue`, `GET /requests/:id`, `POST /requests/:id/claim {lane}` (409 if taken), `…/progress {status?, lane?, branch?, note?}`, `…/question {question}`, `…/requeue {reason}`, `…/complete {summary, commit, branch}`, `…/fail {reason}`, `POST /lanes {lanes:[…]}` (heartbeat that drives the Build board).

### Webhook: app → orchestrator

`POST $STALL_WEBHOOK_URL` with headers `X-Stall-Event`, `X-Stall-Delivery` (used for dedupe), `X-Stall-Timestamp`, and `X-Stall-Signature: sha256=HMAC(secret, "<timestamp>.<raw body>")`. Signatures older than 5 minutes are rejected. Events: `request.queued`, `request.replied`, `request.cancelled` (see `shared/types.ts`).

## Layout

```
app/src/        server.ts (routes), service.ts (domain + consensus), auth.ts, db.ts (SQLite + migrations), outbox.ts, push.ts
app/public/     PWA: index.html, app.js (no framework), style.css, sw.js, manifest.webmanifest, icons/
orchestrator/src/ index.ts (webhook server), orchestrator.ts (lanes + integration), claudeAgent.ts, mockAgent.ts, git.ts, store.ts
shared/         webhook signing and the types both sides share
scripts/e2e.ts  end-to-end test
```
