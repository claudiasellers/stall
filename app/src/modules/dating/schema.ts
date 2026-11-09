// Dating: opt-in Roster, date vetting (core ballots + "has anyone met them?"), debrief cards.
// Everything here is opt-in by the member it's about: nobody can add to someone else's
// roster. Aliases only: no real names, photos, contact details or profile links required.
export const DATING_MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: 'dating-001',
    sql: `
  CREATE TABLE dating_roster (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    alias TEXT NOT NULL,                  -- "Finance Guy", "Hinge Theo", "the DJ"
    met_at TEXT,                          -- free text: "Hinge", "Le Bain", "a wedding"
    status TEXT NOT NULL DEFAULT 'talking' CHECK (status IN ('talking', 'dating', 'situationship', 'benched', 'over')),
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX dating_roster_user ON dating_roster(user_id, status);
  CREATE INDEX dating_roster_updated ON dating_roster(updated_at);

  -- Vetting: yes/no on core ballots (subject_type 'date_vet') plus a "has anyone met them?" thread.
  CREATE TABLE dating_vets (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    roster_id INTEGER REFERENCES dating_roster(id) ON DELETE SET NULL,
    alias TEXT NOT NULL,
    context TEXT,                         -- "37, says he's 'in tech', wants to go to Carbone"
    closes_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX dating_vets_user ON dating_vets(user_id);
  CREATE INDEX dating_vets_roster ON dating_vets(roster_id);
  CREATE INDEX dating_vets_time ON dating_vets(created_at);
  CREATE INDEX dating_vets_closes ON dating_vets(closes_at);
  CREATE TABLE dating_vet_comments (
    id INTEGER PRIMARY KEY,
    vet_id INTEGER NOT NULL REFERENCES dating_vets(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    met_them INTEGER NOT NULL DEFAULT 0 CHECK (met_them IN (0, 1)),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX dating_vet_comments_vet ON dating_vet_comments(vet_id, created_at);
  CREATE INDEX dating_vet_comments_user ON dating_vet_comments(user_id);

  CREATE TABLE dating_debriefs (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    roster_id INTEGER REFERENCES dating_roster(id) ON DELETE SET NULL,
    alias TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 10),
    green_flags TEXT,
    red_flags TEXT,
    verdict TEXT NOT NULL DEFAULT 'tbd' CHECK (verdict IN ('again', 'never', 'tbd')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX dating_debriefs_user ON dating_debriefs(user_id);
  CREATE INDEX dating_debriefs_roster ON dating_debriefs(roster_id);
  CREATE INDEX dating_debriefs_time ON dating_debriefs(created_at);
  `,
  },
];
