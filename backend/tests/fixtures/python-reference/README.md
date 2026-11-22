# Python reference fixtures

Outputs of the removed Python implementation (`pinote` 0.26.0, commit
`de1fdb4ce9454eb4771f8bd6c11168b0e5690af0`), captured once so the Node backend
stays compatible with databases that implementation created. They cannot be
regenerated from this repository; change them only for a deliberate format change.

- `migrations.json`: for schema versions 0–8, the database before migration as
  SQL (`before`; `null` for a new database) and its schema, version and rows
  after the Python migration (`after`).
- `mutation-sequence.json`: every durable row after the mutation sequence in
  `tests/store/parity.test.ts`, with clock readings replaced by `CLOCK`.
- `python-written.sql`: a database created by Node, then given agent fields and
  a second task by Python.
- `bridge-snapshots.sql` and `bridge-snapshots.json`: a schema-8 database and
  the Python Electron bridge's `snapshot` responses for its `active`, `archive`
  and `scheduled` views.
