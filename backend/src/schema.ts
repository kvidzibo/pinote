// SQL preserved verbatim from the Python schema and migrations.
export const SCHEMA = [
  "CREATE TABLE notes (\n    id INTEGER PRIMARY KEY AUTOINCREMENT,\n    text TEXT NOT NULL,\n    state TEXT NOT NULL CHECK (state IN ('active', 'in_progress', 'done', 'removed')),\n    created_at TEXT NOT NULL,\n    updated_at TEXT NOT NULL\n)",
  "CREATE TABLE events (\n    id INTEGER PRIMARY KEY AUTOINCREMENT,\n    note_id INTEGER NOT NULL REFERENCES notes(id),\n    action TEXT NOT NULL CHECK (\n        action IN ('add', 'start', 'reset', 'done', 'rm', 'restore', 'import')\n    ),\n    previous_state TEXT,\n    state TEXT NOT NULL,\n    occurred_at TEXT NOT NULL\n)",
  "CREATE TABLE imports (source TEXT PRIMARY KEY, imported_at TEXT NOT NULL, note_count INTEGER NOT NULL)"
];
export const MIGRATION_2 = [
  "CREATE TABLE notes_v2 (\n    id INTEGER PRIMARY KEY AUTOINCREMENT,\n    text TEXT NOT NULL,\n    state TEXT NOT NULL CHECK (state IN ('active', 'in_progress', 'done', 'removed')),\n    created_at TEXT NOT NULL,\n    updated_at TEXT NOT NULL\n)",
  "CREATE TABLE events_v2 (\n    id INTEGER PRIMARY KEY AUTOINCREMENT,\n    note_id INTEGER NOT NULL REFERENCES notes_v2(id),\n    action TEXT NOT NULL CHECK (\n        action IN ('add', 'start', 'reset', 'done', 'rm', 'restore', 'import')\n    ),\n    previous_state TEXT,\n    state TEXT NOT NULL,\n    occurred_at TEXT NOT NULL\n)",
  "INSERT INTO notes_v2 SELECT * FROM notes",
  "INSERT INTO events_v2 SELECT * FROM events",
  "UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'notes'), 0)) WHERE name = 'notes_v2'",
  "UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0)) WHERE name = 'events_v2'",
  "DROP TABLE events",
  "DROP TABLE notes",
  "ALTER TABLE notes_v2 RENAME TO notes",
  "ALTER TABLE events_v2 RENAME TO events"
];
export const MIGRATION_3 = [
  "ALTER TABLE notes ADD COLUMN tag TEXT",
  "CREATE TABLE events_v3 (\n    id INTEGER PRIMARY KEY AUTOINCREMENT,\n    note_id INTEGER NOT NULL REFERENCES notes(id),\n    action TEXT NOT NULL CHECK (\n        action IN ('add', 'start', 'reset', 'done', 'rm', 'restore', 'import', 'edit', 'tag')\n    ),\n    previous_state TEXT,\n    state TEXT NOT NULL,\n    occurred_at TEXT NOT NULL,\n    text TEXT NOT NULL,\n    previous_text TEXT,\n    tag TEXT,\n    previous_tag TEXT\n)",
  "INSERT INTO events_v3(id, note_id, action, previous_state, state, occurred_at, text) SELECT e.id, e.note_id, e.action, e.previous_state, e.state, e.occurred_at, n.text FROM events e JOIN notes n ON n.id = e.note_id",
  "UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0)) WHERE name = 'events_v3'",
  "DROP TABLE events",
  "ALTER TABLE events_v3 RENAME TO events"
];
export const MIGRATION_4 = [
  "CREATE TABLE notes_v4 (\n        id INTEGER PRIMARY KEY AUTOINCREMENT,\n        text TEXT NOT NULL,\n        state TEXT NOT NULL CHECK (\n            state IN ('active', 'in_progress', 'done', 'removed', 'scheduled')\n        ),\n        created_at TEXT NOT NULL,\n        updated_at TEXT NOT NULL,\n        tag TEXT,\n        remind_at TEXT,\n        CHECK ((state = 'scheduled') = (remind_at IS NOT NULL))\n    )",
  "CREATE TABLE events_v4 (\n        id INTEGER PRIMARY KEY AUTOINCREMENT,\n        note_id INTEGER NOT NULL REFERENCES notes_v4(id),\n        action TEXT NOT NULL CHECK (\n            action IN ('add', 'start', 'reset', 'done', 'rm', 'restore', 'import',\n                       'edit', 'tag', 'schedule', 'remind')\n        ),\n        previous_state TEXT,\n        state TEXT NOT NULL,\n        occurred_at TEXT NOT NULL,\n        text TEXT NOT NULL,\n        previous_text TEXT,\n        tag TEXT,\n        previous_tag TEXT,\n        remind_at TEXT,\n        previous_remind_at TEXT\n    )",
  "INSERT INTO notes_v4 SELECT *, NULL FROM notes",
  "INSERT INTO events_v4 SELECT *, NULL, NULL FROM events",
  "UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'notes'), 0)) WHERE name = 'notes_v4'",
  "UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0)) WHERE name = 'events_v4'",
  "DROP TABLE events",
  "DROP TABLE notes",
  "ALTER TABLE notes_v4 RENAME TO notes",
  "ALTER TABLE events_v4 RENAME TO events",
  "CREATE INDEX scheduled_times ON notes(remind_at) WHERE state = 'scheduled'"
];
export const MIGRATION_5 = [
  "CREATE TABLE tags (name TEXT PRIMARY KEY NOT NULL)",
  "INSERT OR IGNORE INTO tags(name) SELECT DISTINCT tag FROM notes WHERE tag IS NOT NULL"
];
export const MIGRATION_6 = [
  "ALTER TABLE notes ADD COLUMN agent_notes TEXT NOT NULL DEFAULT '{}'",
  "CREATE TABLE events_v6 (\n        id INTEGER PRIMARY KEY AUTOINCREMENT,\n        note_id INTEGER NOT NULL REFERENCES notes(id),\n        action TEXT NOT NULL CHECK (\n            action IN ('add', 'start', 'reset', 'done', 'rm', 'restore', 'import',\n                       'edit', 'tag', 'schedule', 'remind', 'agent')\n        ),\n        previous_state TEXT,\n        state TEXT NOT NULL,\n        occurred_at TEXT NOT NULL,\n        text TEXT NOT NULL,\n        previous_text TEXT,\n        tag TEXT,\n        previous_tag TEXT,\n        remind_at TEXT,\n        previous_remind_at TEXT,\n        agent_notes TEXT NOT NULL DEFAULT '{}',\n        previous_agent_notes TEXT NOT NULL DEFAULT '{}'\n    )",
  "INSERT INTO events_v6 SELECT *, '{}', '{}' FROM events",
  "UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0)) WHERE name = 'events_v6'",
  "DROP TABLE events",
  "ALTER TABLE events_v6 RENAME TO events",
  "CREATE TABLE agent_selections (cwd TEXT PRIMARY KEY, note_id INTEGER NOT NULL REFERENCES notes(id))"
];
export const MIGRATION_7 = [
  "ALTER TABLE tags ADD COLUMN default_folder TEXT"
];
export const MIGRATION_8 = [
  "ALTER TABLE notes ADD COLUMN pi_sessions TEXT NOT NULL DEFAULT '[]'"
];
