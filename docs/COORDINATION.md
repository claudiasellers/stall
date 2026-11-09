# Lane coordination

Build lead (orchestrator, quality owner, foundation, final merge-and-build):
thread "Build Stall private group app", branch `claude/project-thread-vnj0qc`.
Lanes message each other directly when they depend on each other's work.

| Lane | Branch | Module / migration ids | Front end | Thread |
|---|---|---|---|---|
| Foundation (lead) | `claude/project-thread-vnj0qc` | core, migration 5 in db.ts | core.js, auth.js, you.js, admin.js | `cmsg_01EzPoN5yMrfvbRJe5GwqfjtGGgoDJdAiH7NTvSqALDhF7` |
| Events & RSVPs | `claude/project-thread-xpevxt` | `events` / `events-NNN` | views/events.js | `cmsg_01EzPoN5yMrfvbRJe5GwqfjtJpChnfq6F3WU7RAoYhEPD6` |
| Quote Wall & Morning After | `claude/project-thread-n5tx90` | `posts` / `posts-NNN` | views/feed.js, views/lore.js | `cmsg_01EzPoN5yMrfvbRJe5GwqfjtG2SzGxET9dCUMBMAZdeqGc` |
| Photo drop | `claude/project-thread-9ah6ta` | `photos` / `photos-NNN` | views/photos.js | `cmsg_01EzPoN5yMrfvbRJe5Gwqfjt2rry4ZRxtBFBV4Wec8mKRn` |
| Night-of | `claude/project-thread-3t0vhu` | `night` / `night-NNN` | views/night.js | `cmsg_01EzPoN5yMrfvbRJe5GwqfjtPZHCevLVe3YFKDqASQK1Tx` |
| Analytics | `claude/project-thread-9s83js` | `app/src/analytics.ts` | none | `cmsg_01EzPoN5yMrfvbRJe5GwqfjtHUpjQKGYD6a7MEYRRn2e7k` |

Registry order in `app/src/modules/index.ts`: events, posts, photos, night.

## Table ownership

| Table | Owner | Used by |
|---|---|---|
| users (+display_name, emoji, removed_at), invites, sessions | core | all |
| ballots, reactions, feed_items, notifications(link), jobs_sent, storage_deletes | core | all |
| events, rsvps, guest_rsvps, event_ratings, bring_items, plus_ones | events | posts, photos, night (event_id FKs) |
| posts (quote, regret, lost_item, irish_goodbye, hot_take, canon, prophecy) | posts | events archive (counts) |
| photos, photo_captions, vetoes | photos | events archive |
| night_* tables, tab_expenses, tab_shares, tab_settlements | night | events archive |

## Dependencies and handoffs

| # | Dependency | From → to | Status |
|---|---|---|---|
| 1 | Module contract, core tables, clock, tz, storage, tick, publicRoutes | lead → all | ✅ on lead branch |
| 2 | `events(id)` exists before posts/photos/night migrations run | events → posts, photos, night | registry order |
| 3 | `eventCard(e)` export | events → night (Tonight tab) | stub in core |
| 4 | `photoSection(event)`, `eventPosts(event)`, `nightPanel(event)` mounted on event page | photos, posts, night → events | stubs in core |
| 5 | Reactions API (`POST /reactions`) | posts → photos (target_type 'photo', 'caption') | posts lane |
| 6 | GET /feed unions posts + feed_items | posts ← all (write feed_items) | posts lane |
| 7 | Lost & Found is posts.kind 'lost_item' (not night) | posts | agreed |
| 8 | Guest link route `#/guest/:token` public, `/api/v1/public/guest/*` | events | agreed |

## Timeline (Nov 9, UTC)

- 18:32 foundation pushed: rebase onto `claude/project-thread-vnj0qc`.
- 18:50 lanes push final work to their own branch and message the lead.
- 19:00 lead merges in registry order, typechecks, runs the tests and e2e, opens one PR.
- No lane writes or runs tests (user's instruction). Testing happens at the merge step.

## Merge queue (live since 18:33 UTC)

1. **Submit:** open a PR to `main` from your branch and add the label `ready-to-merge`.
2. **Gate (build lane):** trial-merge the PR head onto the latest `main`; run `npm run typecheck`, `npm test`,
   `npm run e2e`, then boot the app, call `/api/v1/tick` and load every tab in a phone-sized browser
   looking for JS errors.
3. **Green →** merged to `main` (Render deploys it). Registry-line conflicts in `app/src/modules/index.ts`
   and `app/public/app.js` are resolved by the build lane (union of both sides); the merge then lands
   through the build lane's branch, and your PR closes as merged.
4. **Red →** the build lane removes the label and messages your thread with the failure. Merge `origin/main`
   into your branch, fix, push, relabel.
5. One concern per PR; keep diffs inside your module plus the one registry/import line.
