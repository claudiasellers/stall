# Analytics (Mixpanel)

Stall sends product analytics to Mixpanel **from the server only**, through `app/src/analytics.ts`.
There is no Mixpanel script in the web app, so there is no autocapture, no session replay, no
Mixpanel cookies, and the CSP stays `'self'`-only.

## Setup

| Env var | What it is |
|---|---|
| `MIXPANEL_TOKEN` | Mixpanel project token (Project settings > Overview). Empty = analytics off. Set it in Render, never commit it. |
| `ANALYTICS_ID_SALT` | Secret used to hash user ids. Render generates it. **Never change it**: a new salt makes every member look like a new user. |
| `MIXPANEL_API_HOST` | Optional. `https://api-eu.mixpanel.com` for an EU-residency project. |
| `ANALYTICS_DEBUG` | `true` logs each event to stdout instead of guessing. |

Both the token and the salt must be set or nothing is sent. In the Mixpanel project, also turn off
**Project settings > Data & Privacy > "Use IP address for geolocation"** as a second layer (the
server already sends `ip=0`).

## Privacy rules (enforced in code, not by convention)

1. **Who:** a member is `u_` + HMAC-SHA256(salt, user id), truncated. Never a username, nickname,
   emoji, email or database id. No people profiles are created. Server-side events with no member
   (e.g. `album_unlocked`) use `distinct_id = system`.
2. **Where:** every request carries `ip=0`, so Mixpanel stores no city, region or country.
3. **What:** only event names in `EVENTS` are sent, and only the property keys listed for each.
4. **Values:** a property value must be a number, a boolean, or a short lowercase identifier
   (`/^[a-z0-9_]{1,40}$/`). Anything else is silently dropped. Free text cannot pass that check, so
   post bodies, quotes, regrets, captions, names, venues, addresses and photo data can't leak even
   if a call site passes them by mistake.
5. **Never track:** content of any kind, who a post is about, who is in a photo, plus-one names or
   handles, venue names, locations, amounts in The Tab, Roster/Vetting data, anything about
   substances. Count the action, not the substance (`tab_entry_added`, not the amount).

## Calling it

```ts
import { track } from './analytics.ts';

track('rsvp_set', req.user!.id, { status: 'maybe_lying', previous_status: 'in' });
track('post_created', req.user!.id, { kind: 'regret', severity: 'social_death', anonymous: true, self_destruct: true });
track('album_unlocked', null, { photo_count: 37 });
```

`track` never throws and never waits on the network; events are batched and flushed every 10 s
(and on SIGTERM). If Mixpanel is down, the batch is dropped. Event names are a typed union, so an
event that isn't in the catalog is a compile error. To add one, add it to `EVENTS` and to the table
below in the same change.

For anonymous posts, still pass the author's id (counts per member stay correct, and the hashed
id can't be joined back to a username by anyone who sees Mixpanel), but never pass anything that
says *which* post it was.

## Event catalog

Wired today: `signed_up`, `invite_created`, `invite_redeemed`, `profile_updated`, `member_removed`,
`logged_in`, `app_opened`, `push_enabled`, `feature_suggested`,
`feature_voted`, `feature_approved`, `feature_rejected`, `feature_shipped`.
The rest are reserved for the group-app features and get wired as each feature lands.

| Event | Properties | Where it fires |
|---|---|---|
| `signed_up` | `via`: invite, bootstrap | account created (invite signups also send `invite_redeemed`) |
| `logged_in` | | password login |
| `app_opened` | `client`: web, native | `GET /api/v1/me`, at most once per member per 30 min (DAU/retention) |
| `invite_created` / `invite_redeemed` | | invites |
| `profile_updated` | | profile saved |
| `push_enabled` | | push subscription saved |
| `member_removed` | `posts_policy`: keep, anonymize, delete | admin removes a member |
| `event_created` | `kind`, `has_stages`, `has_location_drop`, `recurring` | event created |
| `rsvp_set` | `status`, `previous_status`: in, out, maybe_lying, afters_only, coming_late | RSVP set or changed |
| `plus_one_requested` / `plus_one_decided` | `outcome`: approved, rejected, expired | plus-one vetting |
| `bring_item_claimed` | | bring list |
| `event_viewed` | `phase`: upcoming, live, archive | event page opened |
| `guest_rsvp` | `status` | guest link RSVP |
| `post_created` | `kind`, `anonymous`, `severity`, `self_destruct`, `has_event` | quote, regret, hot take, lost item, canon, prophecy |
| `post_deleted` | `kind`, `reason`: author, admin, expired | |
| `reaction_added` | `target_type`: post, media, event | |
| `quote_claimed` | `stance`: stand_by, dispute | |
| `regret_forgiven` | | absolution threshold reached |
| `photo_uploaded` | `count` | |
| `photo_vetoed` | | |
| `album_unlocked` | `photo_count` | server, when a roll develops (`distinct_id = system`) |
| `album_viewed` / `caption_added` | | |
| `checkin_posted` | | Where We At (never the venue) |
| `next_move_poll_created` / `next_move_voted` | | |
| `cooked_meter_set` | `level` 1-10 | |
| `buddy_assigned` | `method`: random, chosen, auto_cooked | |
| `home_safe_tapped` | `minutes_after_cutoff` | |
| `home_safe_escalated` | `stage`: buddy, group | |
| `tab_entry_added` | `split_count` | never the amount or memo |
| `tab_settled` | | |
| `lost_item_posted` / `lost_item_claimed` / `irish_goodbye_logged` | | |
| `ballot_cast` | `subject_type`, `value` | any vote on the shared ballot engine |
| `court_case_filed` / `court_verdict` | `outcome`: guilty, not_guilty | |
| `feature_suggested` | | Suggestion Box |
| `feature_voted` | `value`: up, down, clear | |
| `feature_approved` / `feature_rejected` | `by`: admin, consensus | |
| `feature_shipped` | | builder reports a request done |

## Useful Mixpanel reports to build

- **Insights:** DAU/WAU on `app_opened`; `post_created` broken down by `kind`.
- **Retention:** `signed_up` → `app_opened`, weekly.
- **Funnel:** `event_created` → `rsvp_set` → `photo_uploaded` → `album_viewed` (does the night get remembered?).
- **Safety check:** `home_safe_escalated` count by `stage` (should trend to zero).
