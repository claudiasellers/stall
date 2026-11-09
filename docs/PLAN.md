# Stall → private group app: build plan and tracker

This is the living plan for turning Stall into a private, invite-only clubhouse for one NYC friend group
(10–25 people). It is the single source of truth for scope, status, decisions and deviations. Every slice
updates this file in the same PR that ships it.

**Inputs this plan reconciles**

- *Stall → private Partiful: idea plan* (Nov 7, 2026). This is the product spec: features, privacy rules,
  phases, data model and technical gotchas. Where it and anything older disagree, it wins.
- *Private group app: build decision and plan* (Nov 7, 2026). The earlier engineering plan: Stall becomes
  the group app in this repo, foundation before features, a central visibility rule, tests the builders
  can't edit, and gated merges.

## Status

Work runs in parallel lanes since Nov 9 (see [COORDINATION.md](COORDINATION.md) and
[ARCHITECTURE.md](ARCHITECTURE.md)). Testing happens once, at the lead's merge-and-build step.

| Phase | Slice | Owner | Status |
|---|---|---|---|
| 1 Foundation | Invite-only joining, bootstrap admin, member removal with keep/anonymize/delete, profiles, clock + house tz, house rules, module system, tick, storage | lead | ✅ built |
| 1 Foundation | New navigation (Tonight · Events · Feed · Lore · You · Admin), feature board behind Admin, Suggest a feature, welcome / Add to Home Screen | lead | ✅ built |
| 2 v1 core | Events, honest RSVPs, location drop, plus-one vetting, bring list, stages, spontaneous, guest links | events lane | 🔨 |
| 2 v1 core | Quote Wall, The Morning After, reactions, Feed, Lost & Found, Irish Goodbye | posts lane | 🔨 |
| 2 v1 core | Photo drop: R2, unlock at 11am, veto, signed URLs, watermark, captions | photos lane | 🔨 |
| 3 Night-of | Home Safe + buddies, Where We At, Next Move, Cooked Meter, The Tab, Draft Jail, Rideshare, Hydration | night lane | 🔨 |
| — | Analytics (Mixpanel, enums and counts only) | analytics lane | 🔨 |
| 4 Lore | Group Court, Hot Takes, The Canon, Superlatives, On This Day, 86'd List, Prophecies | | queued |
| 5 Seasonal | Trips, football, Stall Wrapped | | queued |

## Ground rules every slice is reviewed against

These come from the idea plan's privacy rules. A slice that breaks one doesn't merge.

1. **Invite-only.** No account exists without a single-use, expiring invite code (or the one-time bootstrap
   code for the very first admin). `ALLOW_SIGNUP` is gone.
2. **Membership is checked on every read.** Removed members lose their sessions immediately and can't read
   anything. Guest links (later) only ever see one event card.
3. **Deleted means deleted.** Expiry is enforced at read time by server time, and a sweep hard-deletes
   expired rows and stored files. Nothing is "hidden".
4. **Ephemeral by default.** Regrets default to a 24-hour self-destruct; spontaneous events vanish after
   4 hours; Draft Jail drafts (Phase 3) delete after the vote.
5. **Photos need consent.** Anyone can veto a photo they're in, with no vote, and it's deleted. There are no
   public image URLs: only short-lived signed URLs, minted per request for a signed-in member.
6. **Vibes, not records.** No fields that record specifics about substances (who, from whom, how much), and
   no contacts list for anyone who supplies them. Emoji and the Cooked Meter are fine.
7. **No real names needed.** A profile is a display name and an emoji.
8. **Leaving the group.** A removed member's posts are kept, anonymized or deleted, chosen by the admin at
   removal time; the member's photos and regrets go with them when "delete" is picked.

## Architecture decisions

| # | Decision | Why |
|---|---|---|
| D0 | Features are modules (`app/src/modules/<name>`) with string-id migrations, registered in one list. | Five lanes build in parallel without colliding on numbers, `server.ts` or `db.ts`. |
| D1 | One group per deployment, so membership is `users.removed_at IS NULL`. No `groups` table. | The idea plan is one friend group. The earlier plan's Group/Membership tables add a join to every query for no user-visible gain. Easy to add later. |
| D2 | First admin via a one-time `STALL_BOOTSTRAP_CODE` (Render generates it), never "first signup wins". | The idea plan's top risk: today anyone with the URL becomes admin. |
| D3 | Injectable clock (`app/src/clock.ts`) and a house time zone (`HOUSE_TZ`, default `America/New_York`). | Unlock at 11am, location drop, 24-hour expiry and DST all need deterministic tests. |
| D4 | Expiry and unlocks are computed at read time; `/api/v1/tick` only sends pushes and purges. | Render's free plan sleeps, so timers inside the app can't be trusted (idea plan gotcha). |
| D5 | One `posts` table with a `kind` column (quote, regret, and later hot_take, lost_item, canon, prophecy). | Idea plan data model: the feed is one query. |
| D6 | A general `ballots` table (subject type + id) reusing `consensus()` from the feature board. | Idea plan: plus-one vetting, court, polls and hot takes all share it. |
| D7 | Photo storage behind a driver: Cloudflare R2 (S3 SigV4 presigned PUT/GET, no SDK dependency) when configured, local disk with HMAC-signed URLs otherwise. | The app and tests run with no cloud account; production uses R2 so photo bytes never touch Render. |
| D8 | Photo URLs live under `/api/`, which the service worker never caches; the R2 URLs expire in 10 minutes. | Earlier plan: no sensitive media in service-worker caches. |
| D9 | Frontend stays framework-free, split into ES modules per screen under `app/public/js/`. | No build step; parallel lanes (Phase 3+) each own a screen file instead of colliding in one 800-line file. |
| D10 | Server routes split into per-module routers under `app/src/routes/`. | Same reason on the server. |
| D11 | Members can still see and vote on open suggestions (in You → Suggestion Box); the Building board, lanes, branches and Claude's technical notes are Admin-only. | The idea plan says the group votes, and also that build machinery stays out of the main app. This satisfies both. |

## Deviations from the earlier engineering plan (and why)

- **Phases 1–2 are built directly in this thread, not by the orchestrator's lanes.** The lanes need the Mac
  mini, an API key and the seven orchestrator changes; the idea plan itself says the Suggestion Box takes
  over from Phase 3. Building the foundation by hand also matches the research the earlier plan cited
  (foundation alone first, parallel only on independent work).
- **No "adult confirmation", no generic post durations or "Keep"/Saved tab.** Those came from a different
  PRD. The idea plan's expiry model (24h regrets, 4h spontaneous events, photo unlock) replaces it.
- **Self-building safety uses config, not orchestrator code, for now.** Point the orchestrator's
  `BASE_BRANCH` at `staging` and set `TEST_CMD="npm run typecheck && npm test && npm run e2e"`. Admins
  promote `staging` → `main`. The protected-paths check and PR publishing from the earlier plan move to
  Phase 3 prep, before member suggestions are allowed to reach the queue.

## Data model (as built)

Core tables are migration 5 in `app/src/db.ts`; module tables are in each module (see ARCHITECTURE.md). The sketch below is the idea plan's, refined per lane:

- `users`: `display_name`, `emoji`, `removed_at`.
- `invites(code_hash, created_by, used_by, expires_at, used_at, revoked_at, note)`: codes are stored hashed,
  shown once.
- `events(host_id, title, vibe, kind, starts_at, real_starts_at, location, location_reveal_at, cover_emoji,
  parent_id, expires_at, cancelled_at)`.
- `rsvps(event_id, user_id, status, note, updated_at)`; status changes write a `feed_items` row.
- `bring_items(event_id, label, claimed_by)`.
- `plus_ones(event_id, requester_id, guest_name, guest_ig, status, closes_at)`; votes in `ballots`.
- `posts(author_id, kind, event_id, body, context, speaker_id, speaker_label, severity, anonymous,
  out_of_context, claim, expires_at, forgiven_at)`.
- `reactions(target_type, target_id, user_id, emoji)`.
- `ballots(subject_type, subject_id, user_id, value)`.
- `media(event_id, uploader_id, storage_key, mime, width, height, unlock_at, status, caption)`;
  `media_people(media_id, user_id)` for who's tagged (any tagged person, or the uploader, can veto).
- `feed_items(kind, actor_id, event_id, body, expires_at)`: RSVP changes and other announcements.
- `notifications.link`: general link target alongside the old `request_id`.
- `jobs_sent(key)`: idempotency for scheduled pushes from `/tick`.

## Needs your hands (not blocking the build)

1. **Render env vars.** After the merge, read `STALL_BOOTSTRAP_CODE` in the Render dashboard if nobody has an
   account yet. Existing accounts keep working. Delete `ALLOW_SIGNUP` there if it's set (it's ignored now).
2. **Cloudflare R2.** Create a private bucket and an API token with object read/write, then set `R2_ACCOUNT_ID`,
   `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET` on Render. Add a CORS rule allowing `PUT` from
   the app's origin. Until then, photos use local disk, which Render's free plan wipes on restart.
3. **Cron pinger.** Add the repo secrets `STALL_URL` and `STALL_TICK_TOKEN` (same value as Render's
   `STALL_TICK_TOKEN`) so `.github/workflows/tick.yml` calls `/api/v1/tick` every 10 minutes. Or point
   cron-job.org at it. A paid Render instance makes this optional.
4. **Staging decision.** Recommended: create a `staging` branch and set the orchestrator's `BASE_BRANCH=staging`
   before any member suggestion is built. Render keeps deploying `main` only.

## Phase 3+ backlog (to enter as Suggestion Box items once safety prep is done)

Phase 3 safety prep (by hand, first): protected paths in the integration lane (`test/invariants/**`,
`app/src/authz.ts`, migrations, `orchestrator/**`), PR publishing instead of pushing, per-item budget cap.

Then: Where We At check-ins · Next Move poll (ballots, 10-min timer) · Home Safe roll call with buddies and
escalation via `/tick` · Cooked Meter (auto-buddy at 9+) · The Tab (`ledger`, `ledger_splits`, Venmo deep
link) · Lost & Found (`posts.kind = lost_item`) · Irish Goodbye Tracker · Draft Jail · event stages,
recurring events and guest links · caption battles · Quote of the Month · unmask vote.
