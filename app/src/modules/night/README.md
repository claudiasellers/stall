# Night-of module

Home Safe roll call with buddies, Where We At, Next Move polls, Cooked Meter, Draft Jail,
Rideshare Roulette, the hydration nag, and The Tab. Screens: `#/tonight`, `#/tab`,
`#/tonight/poll/:id`, plus `nightPanel(event)` on the event page (`app/public/js/views/night.js`).

## Home Safe ladder (all times from the cutoff)

| When | Who gets pinged | Recorded as |
|---|---|---|
| cutoff | the person: "tap home when you're in" | `night_members.escalation = 1` |
| +60 min | their buddy (or buddies, in a trio) | `escalation = 2` |
| +90 min | the whole group | `escalation = 3` |
| tap 🏠 | buddies ("X is home safe"), or the whole group if it had been alerted | `home_at` set, location wiped |
| everyone home | everyone on the roll call; the night closes | `night_sessions.status = 'closed'` |
| +12 h | the night closes itself, location wiped | |

Moving the cutoff resets the ladder for anyone still out. Live location is optional, goes only to
the person's buddies, and is deleted on 🏠, on "stop sharing", and when the night closes. A Cooked
Meter report of 9+ auto-assigns a buddy (preferring someone unpaired and less cooked) and pings them.

## API (`/api/v1`, members only)

| Method & path | Notes |
|---|---|
| `GET /night?eventId=` | Everything for the Tonight screen: active roll calls, trail, polls, cooked board, drafts |
| `POST /night/sessions` | `{ title, cutoffAt, eventId?, memberIds?, pairing?: 'random'\|'manual', pairs?: [[a,b]] }`. With an event and no roster, everyone whose RSVP isn't Out |
| `POST /night/sessions/:id/{join,home,shuffle,end}` | |
| `POST /night/sessions/:id/buddy` | `{ buddyId }` pick your buddy; orphans are re-paired |
| `POST /night/sessions/:id/cutoff` | `{ cutoffAt }` |
| `POST /night/sessions/:id/location` | `{ lat, lng }` or `{ stop: true }` |
| `POST /night/sessions/:id/heading` · `/rideshare` · `/hydrate` | Rideshare Roulette groups by heading (max 4 a car) and picks the booker; hydrate `{ on }` |
| `GET /night/trail?eventId=` · `POST /night/checkins` · `DELETE /night/checkins/:id` | Venue names only, never GPS |
| `GET /night/polls?eventId=&before=&limit=` · `POST /night/polls` · `POST /night/polls/:id/vote` | 2–3 options, 10 min default; closes early on an outright majority of members |
| `GET/POST /night/cooked` · `GET /night/cooked/stats?userId=` | stats feed Stall Wrapped (avg, peak, times at 9+) |
| `GET /night/drafts` · `POST /night/drafts` · `POST /night/drafts/:id/{vote,release}` | Draft rows are hard-deleted when voting closes |
| `GET /tab?eventId=&before=&limit=` | iOwe, owedToMe, wallOfShame, balances, expenses, Venmo links |
| `POST /tab/expenses` | `{ description, amount \| amountCents, payerId?, splitWith?: [ids] \| shares?: {userId: cents}, eventId? }` |
| `DELETE /tab/expenses/:id` · `POST /tab/settlements` · `POST /tab/venmo` | |

## Tick

`tick(ctx)` walks the Home Safe ladder, closes due polls and drafts, sends hydration nags (every 90
min from the start of the night, opt-in, `jobs_sent` key per slot), and sends weekly "you've owed
Max $340 for 19 days" nudges for debts of $5+ older than 7 days (`jobs_sent` key per pair per week).
