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
| `src/fetch/http.ts` | `politeFetch` — conditional GET (ETag/If-Modified-Since), per-host minimum spacing, streaming byte ceiling, timeout, and retryable-vs-permanent error classification. The only file that sends an outbound content request. |
| `src/fetch/robots.ts` | `isAllowed`/`fetchRobots` — parses a `robots.txt` body and decides allow/deny for a given path; results cached 24h per origin. A safety gate, not a convenience: a disallowed source is skipped, never fetched anyway. |
| `src/adapters/types.ts` | The shared `Adapter`/`AdapterResult`/`EntryParser` contract every adapter implements, plus the 304-handling and skip-and-count helpers (`notModifiedResult`, `fetchedResult`, `parseEntries`) all four adapters reuse. |
| `src/adapters/rss.ts` | RSS 2.0 + Atom adapter (`type: rss`) — format is content-sniffed from the parsed root element, so this also handles real Atom feeds (e.g. Simon Willison's) configured with `type: rss`. |
| `src/adapters/json.ts` | JSON adapter (`type: json`) — dispatches on `source.id` via a per-source mapper registry (CISA KEV, NVD CVE, HN Algolia, Federal Register, NWS alerts); adding a JSON source is a new mapper, not a new adapter. |
| `src/adapters/newsSitemap.ts` | Google-News-schema sitemap adapter (`type: news_sitemap`, AP's route) — reads `<news:title>`/`<news:publication_date>`/`<loc>`, capped at `MAX_ITEMS_PER_FETCH` most-recent entries per run. |
| `src/adapters/googleNews.ts` | Google News RSS adapter (`type: google_news`, Reuters' route) — delegates entirely to `rss.ts`, then strips the `" - Publisher"` title suffix. Never resolves an item's link, by construction: that would land a request on the publisher's own disallowed domain. |
| `src/normalize/url.ts` | `canonicalizeUrl` — pure, idempotent URL canonicalization (tracking-param stripping, `www.`/scheme normalization, fragment removal). Feeds `item_key`, so its output is permanent per-URL once ingested; never does network redirect resolution. |
| `src/normalize/item.ts` | `normalizeItem` — raw adapter output (`RawItem`) → validated `NewItem`: canonicalizes the URL, parses `publishedAt` into canonical UTC or `null` (never guessed), truncates `summary` to 300 chars at a word boundary, and assigns `item_type` by a single mechanical rule M2 will refine. |
| `src/db/fetchState.ts` | Per-source fetch state: `getFetchState`/`recordSuccess`/`recordFailure`/`isEligible`, with exponential backoff bounded so a failing source is never more eligible than a healthy one. Mutable, deliberately not append-only. |
| `src/cost/registry.ts` | Every external service Watchfloor touches, and its cost classification. |
| `src/cost/gate.ts` | The single chokepoint any billable call must pass through; hard-disabled without a `WF_ALLOW_PAID_*` flag. |
| `src/api/server.ts` | Builds the Fastify instance and registers routes; never calls `.listen()` itself. |
| `src/api/routes/health.ts` | `GET /health` — unauthenticated liveness probe: db reachability, migration count, TZ, validated source count, cost-gate status. |
| `src/scheduler/run.ts` | `runPollCycle` — polls every source once, isolates each behind a try/catch so one throwing source never stops the rest, and records success/failure via `fetchState.ts`. All schedule arithmetic derives from `WF_TZ`, never the system clock's zone. |
| `src/bin/api.ts` | Process entrypoint: load env, open the db via `openDatabase`, run migrations, validate `config/sources.yaml`, build the server, listen on loopback, close both on `SIGTERM`/`SIGINT`. |
| `src/bin/scheduler.ts` | Scheduler process entrypoint. |
| `db/migrations/` | Ordered, numbered `.sql` files; each applied exactly once and recorded in `schema_migrations`. |
| `scripts/` | Standalone maintenance/CI scripts run outside the app process, e.g. `check-portability.mjs` (takes an optional target directory, defaulting to the cwd). |
| `config/` | Runtime configuration read by the app, e.g. `sources.yaml` — data, never code. |
| `tests/` | Vitest specs, mirroring the `src/` tree one file at a time, plus fixtures under `tests/fixtures/`. |

## `WF_API_TOKEN` is enforced by `src/api/auth.ts` (M3 task 1)

A global `onRequest` hook, registered at the root Fastify instance in
`buildServer`, rejects any request without a valid `Authorization: Bearer
<token>` header. It is an exemption list, not a protection list: every route
is covered by default, including ones registered after the hook — `/health`
is the one named exception, kept public as a liveness probe for process
supervision. A 401 looks identical whether the token was missing or wrong,
and the comparison is constant-time (see that file's comments for why).

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
