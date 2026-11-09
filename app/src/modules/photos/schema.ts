// Disposable-camera photo drop. Append-only: never edit a shipped migration.
//
// A photo belongs to a "roll": the event it was shot at, or (with no event) the
// house night it was shot on. Rolls are not stored; a roll's develop time is
// derived at read time from its night (see clock.ts), so there is no unlock
// state to drift. Veto is unilateral and destructive: the row is deleted, the
// objects are queued in core storage_deletes, and only a vetoes log row remains
// (for Wrapped's "photos you vetoed").
export const migrations = [
  {
    id: 'photos-001',
    sql: `
    CREATE TABLE photos (
      id INTEGER PRIMARY KEY,
      event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
      night TEXT NOT NULL,                  -- house night (YYYY-MM-DD) the photo was shot on
      uploader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready')),
      original_key TEXT NOT NULL,           -- served only to the uploader
      display_key TEXT NOT NULL,            -- client-resized, max 1600px
      thumb_key TEXT NOT NULL,              -- client-resized, max 480px
      mime TEXT NOT NULL,                   -- original's type
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      bytes INTEGER NOT NULL,               -- original + display + thumb, declared then verified
      taken_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      ready_at TEXT
    );
    CREATE INDEX photos_event ON photos(event_id, status, taken_at) WHERE event_id IS NOT NULL;
    CREATE INDEX photos_night ON photos(night, status, taken_at);
    CREATE INDEX photos_uploader ON photos(uploader_id, night);
    CREATE INDEX photos_pending ON photos(status, created_at) WHERE status = 'pending';

    -- Caption battles. Votes live in core reactions (target_type 'caption', emoji '👍').
    CREATE TABLE photo_captions (
      id INTEGER PRIMARY KEY,
      photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX photo_captions_photo ON photo_captions(photo_id);
    CREATE INDEX photo_captions_user ON photo_captions(user_id);

    -- Who killed how many photos. No photo id: the photo no longer exists.
    CREATE TABLE vetoes (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
      night TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX vetoes_user ON vetoes(user_id, created_at);
    CREATE INDEX vetoes_event ON vetoes(event_id);
    `,
  },
];
