# File layout

One row per source file under `src/`, plus the top-level directories that hold
migrations, scripts, config, and tests rather than importable modules. This is
a map, not an essay — see the file itself for the real detail.

| File | Responsibility |
| --- | --- |
| `src/config/env.ts` | Parse and validate every `WF_*` var; fails fast, naming every missing/invalid var at once. |
| `src/db/connection.ts` | Open SQLite with WAL, `busy_timeout`, and foreign keys on. The only file that imports `node:sqlite`. |
| `src/db/migrate.ts` | Apply `db/migrations/*.sql` in order, one transaction per file, recording applied versions. |
| `src/db/openDatabase.ts` | Opens a process's db, creating only its own parent directory (not `WF_DATA_DIR`/`WF_LOG_DIR`); a failed open is rethrown naming the resolved path instead of disappearing into a silent empty database. |
| `src/domain/item.ts` | `Item` type; append-only insert; current-version and `as_of` point-in-time reads. |
| `src/domain/location.ts` | `locations` / `item_locations` reference-table access (curated gazetteer). |
| `src/sources/load.ts` | Load and zod-validate `config/sources.yaml`. |
| `src/cost/registry.ts` | Every external service Watchfloor touches, and its cost classification. |
| `src/cost/gate.ts` | The single chokepoint any billable call must pass through; hard-disabled without a `WF_ALLOW_PAID_*` flag. |
| `src/api/server.ts` | Builds the Fastify instance and registers routes; never calls `.listen()` itself. |
| `src/api/routes/health.ts` | `GET /health` — unauthenticated liveness probe: db reachability, migration count, TZ, validated source count, cost-gate status. |
| `src/bin/api.ts` | Process entrypoint: load env, open the db via `openDatabase`, run migrations, validate `config/sources.yaml`, build the server, listen on loopback, close both on `SIGTERM`/`SIGINT`. |
| `db/migrations/` | Ordered, numbered `.sql` files; each applied exactly once and recorded in `schema_migrations`. |
| `scripts/` | Standalone maintenance/CI scripts run outside the app process, e.g. `check-portability.mjs` (takes an optional target directory, defaulting to the cwd). |
| `config/` | Runtime configuration read by the app, e.g. `sources.yaml` — data, never code. |
| `tests/` | Vitest specs, mirroring the `src/` tree one file at a time, plus fixtures under `tests/fixtures/`. |

## `WF_API_TOKEN` is not enforced by anything yet

It is validated at startup and then never read. **No route checks it.** The
only route is `/health`, which is deliberately public — a liveness probe for
process supervision. Do not assume a request has been authenticated because a
token is configured. Authentication arrives with the milestone that adds the
real API surface; until then, treat every route as unauthenticated.

## Why `items` is append-only

A correction, re-score, or enrichment writes a *new* row sharing the same
`item_key` with a later `fetched_at` — it never mutates an existing row
(enforced by triggers, not just convention). That is what makes point-in-time
(`as_of`) queries truthful: asking "what did we know as of time T" always
replays the version that was actually current at T, instead of a later
correction leaking backward into the past.

## Why `items` gets triggers where other tables get CHECK constraints

`0002_constraints.sql` pins the beat vocabulary on `item_beats` and
`item_scores` with real `CHECK` constraints, but pins canonical timestamp
format on `items.fetched_at` / `items.published_at` with `BEFORE INSERT`
triggers instead. That asymmetry is deliberate, not an oversight.

SQLite cannot add a `CHECK` to an existing table, so the only route is the
documented table-rebuild procedure — whose first step is
`PRAGMA foreign_keys = OFF`. The migration runner wraps every file in a
transaction, and that pragma is a silent no-op inside one.
`PRAGMA defer_foreign_keys = ON` does not substitute: `DROP TABLE items`
still fails while any row references it from `item_beats`, `item_entities`,
`item_scores`, or `item_locations`. Rebuilding `items` would therefore mean
rebuilding all four children purely to re-point their `REFERENCES` clauses —
rewriting every foreign-key relationship in the schema to add two format
checks. `item_beats` and `item_scores` have no such problem: both are
children with no dependants, so dropping them is safe.

Because `items` is append-only, `INSERT` is the only reachable way a value
can enter either column — `UPDATE` and `DELETE` are already blocked by
`items_no_update` / `items_no_delete`. A `BEFORE INSERT` trigger covers
exactly the surface a `CHECK` would, with none of the rebuild's blast radius.
