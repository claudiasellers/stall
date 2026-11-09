// Season module: trips, football and admin event templates. Builds on events.
// Append-only named migrations (season-NNN).
import type { StallModule } from '../types.ts';

export const SEASON_MIGRATIONS: StallModule['migrations'] = [
  {
    id: 'season-001',
    sql: `
    -- Event templates (admin): Sunday football, Family Meal, Trip, Birthday.
    CREATE TABLE event_templates (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'party',
      title TEXT NOT NULL,
      vibe TEXT,
      details TEXT,
      stages TEXT NOT NULL DEFAULT '[]',      -- JSON array of stage labels
      bring TEXT NOT NULL DEFAULT '[]',       -- JSON array of bring-list items
      weekday INTEGER,                        -- 0-6 local, for "next Sunday"
      start_hour INTEGER NOT NULL DEFAULT 21, -- local hour
      recurrence TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX event_templates_created_by ON event_templates(created_by);
    INSERT INTO event_templates (name, kind, title, vibe, stages, bring, weekday, start_hour, recurrence) VALUES
      ('Sunday football', 'game', 'Sunday football', 'jerseys optional, opinions mandatory', '[]', '["Wings","Beer","Someone who understands the rules"]', 0, 13, 'weekly'),
      ('Family meal', 'dinner', 'Family meal', 'we are splitting it evenly, no arguments', '["Dinner","Bar"]', '["Wine","Dessert"]', NULL, 20, 'monthly'),
      ('Trip', 'trip', 'The trip', 'what happens on the trip goes in the app', '[]', '["Speaker","Sunscreen","Snacks for the car"]', NULL, 10, NULL),
      ('Birthday', 'birthday', 'Birthday', 'dress code: main character', '["Dinner","Bar","Club","Afters"]', '["Candles","A card everyone signs"]', NULL, 20, NULL);

    -- Trips: date poll. Everyone marks the windows they can do; best overlap wins.
    CREATE TABLE date_polls (
      id INTEGER PRIMARY KEY,
      event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      closes_at TEXT,
      chosen_option_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX date_polls_event ON date_polls(event_id);
    CREATE INDEX date_polls_created_by ON date_polls(created_by);
    CREATE INDEX date_polls_created ON date_polls(created_at);
    CREATE TABLE date_poll_options (
      id INTEGER PRIMARY KEY,
      poll_id INTEGER NOT NULL REFERENCES date_polls(id) ON DELETE CASCADE,
      starts_on TEXT NOT NULL,                -- YYYY-MM-DD
      ends_on TEXT NOT NULL,
      label TEXT
    );
    CREATE INDEX date_poll_options_poll ON date_poll_options(poll_id, starts_on);
    CREATE TABLE date_poll_marks (
      option_id INTEGER NOT NULL REFERENCES date_poll_options(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (option_id, user_id)
    );
    CREATE INDEX date_poll_marks_user ON date_poll_marks(user_id);

    -- Trip bible: one page per trip.
    CREATE TABLE trip_bibles (
      event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
      flights TEXT, house TEXT, packing TEXT, itinerary TEXT, reservations TEXT,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX trip_bibles_updated_by ON trip_bibles(updated_by);

    -- Room draft: rooms, then a draft order or a random draw.
    CREATE TABLE trip_rooms (
      id INTEGER PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      beds INTEGER NOT NULL DEFAULT 1 CHECK (beds BETWEEN 1 AND 8)
    );
    CREATE INDEX trip_rooms_event ON trip_rooms(event_id);
    CREATE TABLE trip_drafts (
      event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK (mode IN ('draft','random')),
      draft_order TEXT NOT NULL,              -- JSON array of user ids
      started_at TEXT NOT NULL,
      done_at TEXT
    );
    CREATE TABLE trip_room_picks (
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      room_id INTEGER NOT NULL REFERENCES trip_rooms(id) ON DELETE CASCADE,
      picked_at TEXT NOT NULL,
      PRIMARY KEY (event_id, user_id)
    );
    CREATE INDEX trip_room_picks_room ON trip_room_picks(room_id);
    CREATE INDEX trip_room_picks_user ON trip_room_picks(user_id);

    -- Shared kitty: pooled spends, split evenly to the Tab (tab_expenses/tab_shares).
    CREATE TABLE trip_kitty (
      id INTEGER PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      payer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      memo TEXT NOT NULL,
      tab_expense_id INTEGER,                 -- set when it reached the Tab
      created_at TEXT NOT NULL
    );
    CREATE INDEX trip_kitty_event ON trip_kitty(event_id, created_at);
    CREATE INDEX trip_kitty_payer ON trip_kitty(payer_id);

    -- Trip awards: one vote per voter per category.
    CREATE TABLE trip_award_votes (
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      voter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      nominee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (event_id, category, voter_id)
    );
    CREATE INDEX trip_award_votes_voter ON trip_award_votes(voter_id);
    CREATE INDEX trip_award_votes_nominee ON trip_award_votes(nominee_id);

    -- Football. A game can hang off a watch-party event.
    CREATE TABLE games (
      id INTEGER PRIMARY KEY,
      event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
      season TEXT NOT NULL,                   -- e.g. "2026"
      week INTEGER NOT NULL DEFAULT 1,
      home TEXT NOT NULL,
      away TEXT NOT NULL,
      kickoff_at TEXT NOT NULL,
      home_score INTEGER,
      away_score INTEGER,
      final_at TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX games_event ON games(event_id);
    CREATE INDEX games_season ON games(season, week, kickoff_at);
    CREATE INDEX games_created_by ON games(created_by);
    CREATE TABLE game_picks (
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      team TEXT NOT NULL,
      picked_at TEXT NOT NULL,
      PRIMARY KEY (game_id, user_id)
    );
    CREATE INDEX game_picks_user ON game_picks(user_id);
    CREATE TABLE game_talk (
      id INTEGER PRIMARY KEY,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX game_talk_game ON game_talk(game_id, created_at);
    CREATE INDEX game_talk_user ON game_talk(user_id);
    -- Allegiance shows on every RSVP.
    CREATE TABLE fan_teams (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      team TEXT NOT NULL
    );
    -- Super Bowl squares: 10x10, digits drawn when the board locks.
    CREATE TABLE squares_boards (
      id INTEGER PRIMARY KEY,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      row_digits TEXT,                        -- JSON [10] for the home team, set at lock
      col_digits TEXT,                        -- JSON [10] for the away team
      locked_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX squares_boards_game ON squares_boards(game_id);
    CREATE TABLE squares (
      board_id INTEGER NOT NULL REFERENCES squares_boards(id) ON DELETE CASCADE,
      r INTEGER NOT NULL CHECK (r BETWEEN 0 AND 9),
      c INTEGER NOT NULL CHECK (c BETWEEN 0 AND 9),
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (board_id, r, c)
    );
    CREATE INDEX squares_user ON squares(user_id);
    -- Bar tracker.
    CREATE TABLE bars (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      neighborhood TEXT,
      teams TEXT,                             -- free text: "Giants, Eagles, everything on Sunday"
      added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX bars_added_by ON bars(added_by);
    CREATE TABLE bar_ratings (
      bar_id INTEGER NOT NULL REFERENCES bars(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sound INTEGER CHECK (sound BETWEEN 1 AND 5),
      wings INTEGER CHECK (wings BETWEEN 1 AND 5),
      lines INTEGER CHECK (lines BETWEEN 1 AND 5),
      note TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (bar_id, user_id)
    );
    CREATE INDEX bar_ratings_user ON bar_ratings(user_id);
    `,
  },
  {
    id: 'season-002',
    sql: `
    -- Members removed with the 'anonymize' policy: their season content stays but
    -- every read shows "Former member" instead of their name.
    CREATE TABLE season_anonymized (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE
    );
    `,
  },
];
