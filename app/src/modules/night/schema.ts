// Night-of tools: Home Safe roll call + buddies, Where We At, Next Move polls,
// Cooked Meter, and The Tab. Owned by this module (append-only steps).
//
// event_id is nullable: night tools work with or without an event (a
// spontaneous night out). Events register before this module. Money is always
// integer cents. Tab expenses keep their history if an event is deleted
// (SET NULL), because deleting a party must not erase who owes whom.
export const NIGHT_MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: 'night-001',
    sql: `
  -- A "night" is the unit Home Safe runs on: who's out, buddy pairs, and the cutoff.
  CREATE TABLE night_sessions (
    id INTEGER PRIMARY KEY,
    event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    started_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cutoff_at TEXT NOT NULL,                 -- when everyone should tap 🏠
    status TEXT NOT NULL DEFAULT 'active',   -- active | closed
    closed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX night_sessions_status ON night_sessions(status, cutoff_at);
  CREATE INDEX night_sessions_event ON night_sessions(event_id);

  CREATE TABLE night_members (
    session_id INTEGER NOT NULL REFERENCES night_sessions(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    buddy_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    home_at TEXT,
    -- 0 nothing sent · 1 cutoff nudge to them · 2 buddy pinged · 3 whole group pinged
    escalation INTEGER NOT NULL DEFAULT 0,
    -- Optional live location: visible only to the buddy, wiped on 🏠.
    share_location INTEGER NOT NULL DEFAULT 0,
    lat REAL, lng REAL, location_at TEXT,
    joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (session_id, user_id)
  );
  CREATE INDEX night_members_user ON night_members(user_id);
  CREATE INDEX night_members_buddy ON night_members(session_id, buddy_id);
  CREATE INDEX night_sessions_started_by ON night_sessions(started_by);

  -- Where We At: venue names only, never GPS.
  CREATE TABLE night_checkins (
    id INTEGER PRIMARY KEY,
    event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    venue TEXT NOT NULL,
    next_venue TEXT,
    next_at TEXT,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX night_checkins_event ON night_checkins(event_id, created_at);
  CREATE INDEX night_checkins_time ON night_checkins(created_at);
  CREATE INDEX night_checkins_user ON night_checkins(user_id);

  -- Next Move: 2–3 options, short timer, plurality wins.
  CREATE TABLE night_polls (
    id INTEGER PRIMARY KEY,
    event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    closes_at TEXT NOT NULL,
    closed_at TEXT,
    winner_option_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX night_polls_open ON night_polls(closed_at, closes_at);
  CREATE INDEX night_polls_event ON night_polls(event_id, created_at);
  CREATE INDEX night_polls_time ON night_polls(created_at);
  CREATE INDEX night_polls_user ON night_polls(user_id);
  CREATE TABLE night_poll_options (
    id INTEGER PRIMARY KEY,
    poll_id INTEGER NOT NULL REFERENCES night_polls(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    label TEXT NOT NULL
  );
  CREATE INDEX night_poll_options_poll ON night_poll_options(poll_id);
  CREATE TABLE night_poll_votes (
    poll_id INTEGER NOT NULL REFERENCES night_polls(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    option_id INTEGER NOT NULL REFERENCES night_poll_options(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (poll_id, user_id)
  );
  CREATE INDEX night_poll_votes_option ON night_poll_votes(option_id);
  CREATE INDEX night_poll_votes_user ON night_poll_votes(user_id);

  -- Cooked Meter: append-only self reports; "current" is the latest in the last 12h.
  CREATE TABLE cooked_reports (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
    level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 10),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX cooked_reports_user ON cooked_reports(user_id, created_at);
  CREATE INDEX cooked_reports_event ON cooked_reports(event_id);
  CREATE INDEX cooked_reports_time ON cooked_reports(created_at);

  -- The Tab: an expense is paid by one person and split into shares.
  CREATE TABLE tab_expenses (
    id INTEGER PRIMARY KEY,
    event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
    payer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    description TEXT NOT NULL,              -- free-text memo only, by design
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX tab_expenses_event ON tab_expenses(event_id);
  CREATE INDEX tab_expenses_payer ON tab_expenses(payer_id);
  CREATE INDEX tab_expenses_created_by ON tab_expenses(created_by);
  CREATE INDEX tab_expenses_time ON tab_expenses(created_at);
  CREATE TABLE tab_shares (
    expense_id INTEGER NOT NULL REFERENCES tab_expenses(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    PRIMARY KEY (expense_id, user_id)
  );
  CREATE INDEX tab_shares_user ON tab_shares(user_id);
  -- A settlement is money moving from one person to another outside the app.
  CREATE TABLE tab_settlements (
    id INTEGER PRIMARY KEY,
    from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    recorded_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX tab_settlements_pair ON tab_settlements(from_id, to_id);
  CREATE INDEX tab_settlements_to ON tab_settlements(to_id);
  CREATE INDEX tab_settlements_recorded_by ON tab_settlements(recorded_by);
  CREATE INDEX tab_settlements_time ON tab_settlements(created_at);
  CREATE TABLE tab_handles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    venmo TEXT
  );
  `,
  },
];
