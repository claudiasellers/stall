// Events module schema. Append-only named migrations, tracked in schema_migrations.
// Announcements (RSVP changes, plus-one verdicts, claims) go to core feed_items;
// plus-one votes go to core ballots with subject_type 'plus_one'.
import type { StallModule } from '../types.ts';

export const EVENTS_MIGRATIONS: StallModule['migrations'] = [
  {
    id: 'events-001',
    sql: `
    CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      host_id INTEGER NOT NULL REFERENCES users(id),
      parent_id INTEGER REFERENCES events(id) ON DELETE CASCADE, -- set on stages
      stage_order INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'party',      -- party | dinner | trip | game | birthday | spontaneous | stage
      title TEXT NOT NULL,
      vibe TEXT,                                -- "dress code: expensive but tired"
      details TEXT,
      cover_emoji TEXT,                         -- generated poster: emoji + palette from the id
      cover_key TEXT,                           -- optional uploaded cover (media lane storage key)
      starts_at TEXT NOT NULL,                  -- the time on the invite
      real_starts_at TEXT NOT NULL,             -- the time people actually show up (default +90m)
      ends_at TEXT,                             -- when the night turns into an archive
      location TEXT,
      location_reveal_at TEXT,                  -- NULL = visible now; host always sees it
      expires_at TEXT,                          -- spontaneous: hard-deleted after this
      current_stage_id INTEGER,                 -- rolling events: where the group is now
      recurrence TEXT,                          -- weekly | monthly-first-thu | monthly (template for the next one)
      guest_token TEXT UNIQUE,                  -- optional guest link (event card + RSVP only)
      plus_one_minutes INTEGER NOT NULL DEFAULT 60,
      cancelled_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX events_starts ON events(parent_id, starts_at);
    CREATE INDEX events_expires ON events(expires_at) WHERE expires_at IS NOT NULL;

    -- Honest RSVPs. Stage RSVPs are rows against the stage's own event id.
    CREATE TABLE rsvps (
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('in','out','maybe','afters','late','save_drink')),
      note TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (event_id, user_id)
    );
    CREATE INDEX rsvps_user ON rsvps(user_id);

    -- Guests who came in through a guest link. They see only the card.
    CREATE TABLE guest_rsvps (
      id INTEGER PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('in','out','maybe','afters','late','save_drink')),
      edit_token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX guest_rsvps_event ON guest_rsvps(event_id);

    -- Event ratings for the post-event page (1-10). Separate from core ballots,
    -- which are yes/no only.
    CREATE TABLE event_ratings (
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 10),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (event_id, user_id)
    );

    CREATE TABLE bring_items (
      id INTEGER PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      claimed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      claimed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX bring_items_event ON bring_items(event_id);

    -- Plus-one vetting: a request opens a ballot (subject_type 'plus_one') with a timer.
    CREATE TABLE plus_ones (
      id INTEGER PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      guest_name TEXT,
      guest_instagram TEXT,
      pitch TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','withdrawn')),
      decides_at TEXT NOT NULL,
      decided_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX plus_ones_event ON plus_ones(event_id);
    CREATE INDEX plus_ones_pending ON plus_ones(status, decides_at);
    `,
  },
];
