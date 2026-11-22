BEGIN TRANSACTION;
CREATE TABLE agent_selections (cwd TEXT PRIMARY KEY, note_id INTEGER NOT NULL REFERENCES notes(id));
CREATE TABLE "events" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id INTEGER NOT NULL REFERENCES notes(id),
        action TEXT NOT NULL CHECK (
            action IN ('add', 'start', 'reset', 'done', 'rm', 'restore', 'import',
                       'edit', 'tag', 'schedule', 'remind', 'agent')
        ),
        previous_state TEXT,
        state TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        text TEXT NOT NULL,
        previous_text TEXT,
        tag TEXT,
        previous_tag TEXT,
        remind_at TEXT,
        previous_remind_at TEXT,
        agent_notes TEXT NOT NULL DEFAULT '{}',
        previous_agent_notes TEXT NOT NULL DEFAULT '{}'
    );
INSERT INTO "events" VALUES(1,1,'add',NULL,'active','2026-11-22T00:28:57.124337+00:00','Node',NULL,'Straße',NULL,NULL,NULL,'{}','{}');
INSERT INTO "events" VALUES(2,1,'agent','active','active','2026-11-22T00:28:57.151007+00:00','Node','Node','Straße','Straße',NULL,NULL,'{"10": "ten", "2": "two", "Next": "日本語\nreview", "__proto__": "safe"}','{}');
INSERT INTO "events" VALUES(3,2,'add',NULL,'active','2026-11-22T00:28:57.151154+00:00','Python',NULL,'Straße',NULL,NULL,NULL,'{}','{}');
CREATE TABLE imports (source TEXT PRIMARY KEY, imported_at TEXT NOT NULL, note_count INTEGER NOT NULL);
CREATE TABLE "notes" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
            state IN ('active', 'in_progress', 'done', 'removed', 'scheduled')
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        tag TEXT,
        remind_at TEXT, agent_notes TEXT NOT NULL DEFAULT '{}', pi_sessions TEXT NOT NULL DEFAULT '[]',
        CHECK ((state = 'scheduled') = (remind_at IS NOT NULL))
    );
INSERT INTO "notes" VALUES(1,'Node','active','2026-11-22T00:28:57.124337+00:00','2026-11-22T00:28:57.151007+00:00','Straße',NULL,'{"10": "ten", "2": "two", "Next": "日本語\nreview", "__proto__": "safe"}','[]');
INSERT INTO "notes" VALUES(2,'Python','active','2026-11-22T00:28:57.151154+00:00','2026-11-22T00:28:57.151154+00:00','Straße',NULL,'{}','[]');
CREATE TABLE tags (name TEXT PRIMARY KEY NOT NULL, default_folder TEXT);
INSERT INTO "tags" VALUES('Straße',NULL);
CREATE INDEX scheduled_times ON notes(remind_at) WHERE state = 'scheduled';
DELETE FROM "sqlite_sequence";
INSERT INTO "sqlite_sequence" VALUES('notes',2);
INSERT INTO "sqlite_sequence" VALUES('events',3);
COMMIT;
PRAGMA user_version=8;
