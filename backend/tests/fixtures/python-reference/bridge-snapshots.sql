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
INSERT INTO "events" VALUES(1,1,'add',NULL,'active','2026-11-22T00:28:57.232337+00:00','older 🌱',NULL,'Z',NULL,NULL,NULL,'{}','{}');
INSERT INTO "events" VALUES(2,2,'add',NULL,'active','2026-11-22T00:28:57.233337+00:00','newer',NULL,'A',NULL,NULL,NULL,'{}','{}');
INSERT INTO "events" VALUES(3,1,'agent','active','active','2026-11-22T00:28:57.234337+00:00','older 🌱','older 🌱','Z','Z',NULL,NULL,'{"Result": "one"}','{}');
INSERT INTO "events" VALUES(4,1,'start','active','in_progress','2026-11-22T00:28:57.235337+00:00','older 🌱',NULL,'Z',NULL,NULL,NULL,'{"Result": "one"}','{"Result": "one"}');
INSERT INTO "events" VALUES(5,3,'add',NULL,'active','2026-11-22T00:28:57.235337+00:00','scheduled',NULL,NULL,NULL,NULL,NULL,'{}','{}');
INSERT INTO "events" VALUES(6,3,'schedule','active','scheduled','2026-11-22T00:28:57.236337+00:00','scheduled',NULL,NULL,NULL,'2099-01-01T00:00:00.123456+00:00',NULL,'{}','{}');
INSERT INTO "events" VALUES(7,4,'add',NULL,'active','2026-11-22T00:28:57.236337+00:00','done',NULL,NULL,NULL,NULL,NULL,'{}','{}');
INSERT INTO "events" VALUES(8,4,'done','active','done','2026-11-22T00:28:57.236338+00:00','done',NULL,NULL,NULL,NULL,NULL,'{}','{}');
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
INSERT INTO "notes" VALUES(1,'older 🌱','in_progress','2026-11-22T00:28:57.232337+00:00','2026-11-22T00:28:57.235337+00:00','Z',NULL,'{"Result": "one"}','["11111111-1111-4111-8111-111111111111"]');
INSERT INTO "notes" VALUES(2,'newer','active','2026-11-22T00:28:57.233337+00:00','2026-11-22T00:28:57.233337+00:00','A',NULL,'{}','[]');
INSERT INTO "notes" VALUES(3,'scheduled','scheduled','2026-11-22T00:28:57.235337+00:00','2026-11-22T00:28:57.236337+00:00',NULL,'2099-01-01T00:00:00.123456+00:00','{}','[]');
INSERT INTO "notes" VALUES(4,'done','done','2026-11-22T00:28:57.236337+00:00','2026-11-22T00:28:57.236338+00:00',NULL,NULL,'{}','[]');
CREATE TABLE tags (name TEXT PRIMARY KEY NOT NULL, default_folder TEXT);
INSERT INTO "tags" VALUES('Unused',NULL);
INSERT INTO "tags" VALUES('Z',NULL);
INSERT INTO "tags" VALUES('A',NULL);
CREATE INDEX scheduled_times ON notes(remind_at) WHERE state = 'scheduled';
DELETE FROM "sqlite_sequence";
INSERT INTO "sqlite_sequence" VALUES('notes',4);
INSERT INTO "sqlite_sequence" VALUES('events',8);
COMMIT;
PRAGMA user_version=8;
