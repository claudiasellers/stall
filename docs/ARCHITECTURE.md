# Stall architecture and module conventions

Stall is one Express + libsql (SQLite / Turso) server and a framework-free PWA. Since the
group-app rebuild, features are **modules**: each owns its tables, routes, tick job and screens,
and plugs into a small core. This file is binding for every lane; the build lead reviews against it.

## Core (owned by the build lead)

| Piece | Where | What it gives modules |
|---|---|---|
| Membership | `app/src/auth.ts`, `app/src/members.ts` | Invite-only signup (single-use hashed codes, 7-day default expiry; first admin via `STALL_BOOTSTRAP_CODE`). A member is `users.removed_at IS NULL`. Sessions are rejected for removed users. |
| Profiles | `users.display_name`, `users.emoji` | Show names as `COALESCE(display_name, username)`. `GET /api/v1/members`. |
| Clock | `app/src/clock.ts`, `now()` in `app/src/db.ts` | All stored times are ISO UTC from `now()`. Tests can move the clock (`STALL_TEST_CLOCK=true` → `POST /api/v1/test/clock`). |
| House time | `app/src/time.ts`, `cfg.houseTz` | `nextLocalHour(ms, hour, tz)`, `zonedParts`, `zonedToUtc`. DST-safe, no tz database. |
| House rules | `app/src/house.ts`, `ctx.house()` | Admin-editable: photoUnlockHour, regretTtlHours, plusOneVoteMinutes, plusOneMinYes, plusOneRatio, locationRevealHours, spontaneousHours, forgiveThreshold. |
| Shared tables | migration 5 in `app/src/db.ts` | `ballots` (yes/no votes on anything), `reactions` (emoji on anything), `feed_items` (announcements), `notifications.link`, `jobs_sent` (idempotent scheduled pushes), `storage_deletes`. |
| Voting rule | `consensus()` in `app/src/service.ts` | Min yes votes + yes share, auto-reject. Reuse it for any ballot. |
| Notifications | `ctx.svc.notify(userId, null, body, link)`, `ctx.svc.notifyMembers(body, link, exceptId)` | In-app list, Web Push, live SSE. `link` is a hash route such as `/events/12`. |
| Live updates | `ctx.bus.emit('live', { topic })` | Open screens get window event `stall:<topic>` and re-run their refresh. |
| Photo storage | `app/src/storage.ts`, `ctx.storage` | R2 presigned PUT/GET (10-minute reads) or local disk behind HMAC URLs; `queueStorageDelete(db, key)` inside your transaction. |
| Tick | `POST /api/v1/tick` (bearer `STALL_TICK_TOKEN`) | Runs every module's `tick(ctx)`, then drains storage deletes. Also runs every minute while the server is awake. |
| Front-end core | `app/public/js/core.js` | `api, h, icon, toast, route, go, shell, state, empty, ago, head, who, formOf, setRefresh`. |

## Module contract (`app/src/modules/types.ts`)

```ts
export const module: StallModule = {
  name: 'events',
  migrations: [{ id: 'events-001', sql: `CREATE TABLE ...` }],   // append-only
  routes: (ctx) => router,          // mounted at /api/v1 behind requireMember + CSRF; use your own prefix
  publicRoutes: (ctx) => router,    // optional, /api/v1/public, guest links only
  tick: async (ctx) => {},          // idempotent: purges + scheduled pushes (jobs_sent keys)
  onMemberRemoved: (ctx, userId, policy) => {},  // keep | anonymize | delete their content
};
```

Register with one line in `app/src/modules/index.ts`, in dependency order (events first).
Don't edit `server.ts` or `db.ts` from a lane.

## Rules every module follows

1. **Read-time visibility.** Filter `expires_at IS NULL OR expires_at > now()` and any unlock time in
   every query. Never rely on a job having run.
2. **Deleted means deleted.** Expiry, veto and removal do a hard `DELETE` (plus that row's `reactions`,
   `ballots` and `feed_items`), and stored files go to `storage_deletes`. No `hidden` or `deleted_at` flags.
3. **Schema bar.** `INTEGER PRIMARY KEY`; explicit `ON DELETE` on every FK; an index on every FK and
   every column used to sort or filter by time; `CHECK` constraints on enums; money in integer cents.
4. **Authorization.** Every route assumes only "is a member". Owner/admin checks happen in the service,
   not the client. Anonymous authorship is never sent to any client except the author (`mine: true`).
5. **Privacy.** No structured fields recording substances (who/what/how much/from whom), no contact
   lists, no real names required. Push bodies may name events but not regrets' contents.
6. **Scale.** Each list endpoint is paginated (`?before=<created_at>&limit=`), defaults ≤ 50, and runs as
   one indexed query (no N+1). Aggregate reaction counts with one `GROUP BY` per page.
7. **Front end.** One file per area in `app/public/js/views/`, registered with `route()`. CSS for a
   module goes in `app/public/css/<module>.css` and is added to `sw.js` SHELL. Photo URLs are never
   cached by the service worker (they live under `/api/` or on R2 with short expiry).
8. **Analytics (optional).** If you call `track()` from `app/src/analytics.ts`, send only enums and
   counts, never content, names, venues or amounts.
