# Reference fixtures

Frozen databases and the results expected from them, so the backend keeps
opening and migrating databases that earlier releases created. They were
captured once from `pinote` 0.26.0 and cannot be regenerated from this
repository; change them only for a deliberate format change.

- `migrations.json`: for schema versions 0–8, the database before migration as
  SQL (`before`; `null` for a new database) and its schema, version and rows
  after migration (`after`).
- `bridge-snapshots.sql` and `bridge-snapshots.json`: a schema-8 database and
  the Electron bridge's `snapshot` responses for its `active`, `archive` and
  `scheduled` views.
