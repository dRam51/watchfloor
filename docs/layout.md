# File layout

One row per source file under `src/`, plus the top-level directories that hold
migrations, scripts, config, and tests rather than importable modules. This is
a map, not an essay — see the file itself for the real detail.

| File | Responsibility |
| --- | --- |
| `src/config/env.ts` | Parse and validate every `WF_*` var; fails fast, naming every missing/invalid var at once. |
| `src/db/connection.ts` | Open SQLite with WAL, `busy_timeout`, and foreign keys on. The only file that imports `node:sqlite`. |
| `src/db/migrate.ts` | Apply `db/migrations/*.sql` in order, one transaction per file, recording applied versions. |
| `src/domain/item.ts` | `Item` type; append-only insert; current-version and `as_of` point-in-time reads. |
| `src/domain/location.ts` | `locations` / `item_locations` reference-table access (curated gazetteer). |
| `src/sources/load.ts` | Load and zod-validate `config/sources.yaml`. |
| `src/cost/registry.ts` | Every external service Watchfloor touches, and its cost classification. |
| `src/cost/gate.ts` | The single chokepoint any billable call must pass through; hard-disabled without a `WF_ALLOW_PAID_*` flag. |
| `src/api/server.ts` | Builds the Fastify instance and registers routes; never calls `.listen()` itself. |
| `src/api/routes/health.ts` | `GET /health` — unauthenticated liveness probe: db reachability, migration count, TZ, cost-gate status. |
| `src/bin/api.ts` | Process entrypoint: load env, open the db via `openDatabase`, run migrations, build the server, listen on loopback. |
| `src/bin/openDatabase.ts` | Opens the entrypoint's db, creating only its own parent directory (not `WF_DATA_DIR`/`WF_LOG_DIR`); a failed open is rethrown naming the resolved path instead of disappearing into a silent empty database. |
| `db/migrations/` | Ordered, numbered `.sql` files; each applied exactly once and recorded in `schema_migrations`. |
| `scripts/` | Standalone maintenance/CI scripts run outside the app process, e.g. `check-portability.mjs`. |
| `config/` | Runtime configuration read by the app, e.g. `sources.yaml` — data, never code. |
| `tests/` | Vitest specs, mirroring the `src/` tree one file at a time, plus fixtures under `tests/fixtures/`. |

## Why `items` is append-only

A correction, re-score, or enrichment writes a *new* row sharing the same
`item_key` with a later `fetched_at` — it never mutates an existing row
(enforced by triggers, not just convention). That is what makes point-in-time
(`as_of`) queries truthful: asking "what did we know as of time T" always
replays the version that was actually current at T, instead of a later
correction leaking backward into the past.
