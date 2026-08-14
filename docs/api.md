# HTTP API reference

§7.1 makes this the load-bearing contract of the whole system:

> **The HTTP API is the only contract.** No server-rendered HTML, no business logic in the
> frontend, no endpoint that returns markup. Scoring, clustering, filtering, and state
> transitions all live server-side. A future client is then a new frontend against the same
> API, not a second implementation.

So this file exists for the clients that don't exist yet — M6's PWA, M8's native shells — as
much as for the current React frontend. A contract nobody wrote down is a weak contract.

Written 2026-08-14, after M3 Waves 1–2. Verified against the running server, not transcribed
from the route files.

## Conventions

- **Everything is under `/api` except `GET /health`**, which is bare and unauthenticated.
- **Auth**: `Authorization: Bearer <WF_API_TOKEN>` on every route except `/health`. Enforced by
  an `onRequest` hook registered at the **root** Fastify instance (`src/api/auth.ts`), so a
  route added later is protected without its author doing anything. Missing and wrong tokens
  are indistinguishable: both return `401 {"error":"unauthorized"}` with no hint which.
- **JSON is camelCase on the wire**, mapped explicitly from the database's snake_case. The
  mapping is a whitelist, not a spread — a column added to `items` cannot silently reach a
  client.
- **Errors are `{ "error": "<lowercase token>" }`**, never a sentence or a stack.
- **Timestamps are canonical `YYYY-MM-DDTHH:mm:ss.sssZ` strings**, never epoch numbers and
  never pre-formatted. Relative time ("3 minutes ago") is the client's job — it needs the
  instant to compute it.
- **Nulls stay null.** `lastFailureAt: null` means never failed; a missing field would mean
  something else. Absence and emptiness are different answers, especially on source health.
- **Bad input fails loudly** with `400 { error }` rather than being coerced or clamped.

## Routes

### `GET /health` — unauthenticated

Liveness probe for process supervision (§12). Deliberately public: a supervisor has no way to
carry a secret, and the body is operational status rather than item data.

```json
{ "status": "ok", "db": "ok", "migrations": 6, "tz": "America/New_York",
  "sources": 27, "costGates": { … } }
```

### `GET /api/feed`

The core read. Ranked items, merged across beats or filtered to one.

| param | type | notes |
| --- | --- | --- |
| `beat` | one of `ai cyber aisec repos markets usnews` | omit for the merged stream; a TOPIC filter |
| `kind` | one of `news paper blog advisory aggregator` | omit for no filter; a CONTENT filter — composes with `beat` (`?beat=aisec&kind=news` is "aisec, but only news") |
| `profile` | `signal` \| `read` | which score orders the result |
| `limit` | 1–200, default 50 | |
| `cursor` | opaque string | from a previous response's `nextCursor` — **pass it back verbatim** |
| `now` | canonical timestamp | overrides the request instant; mostly for tests and point-in-time reads |

Returns `{ items, beat, kind, profile, now, total, nextCursor }`. Each item:

```
itemKey  title  canonicalUrl  summary  sourceId  publishedAt  itemType  kind
beats[]  entities[]  representativeBeat  clusterSize
signalScore  readScore  sortProfile
override { signal:{pinned,priority,label}, read:{…} }
state    { readAt, savedAt, dismissedAt }
```

**`kind` is a source-level fact, not an item-level one — and it can be `null`.** `beat` is a
*topic* (`aisec`); `kind` is a *content format* (news vs. paper vs. blog vs. advisory vs.
aggregator), resolved from the item's source in `config/sources.yaml` (`src/sources/load.ts`'s
`kind` field, itself optional — see that file's own doc comment for why source-level, and why
optional, not required). An item whose source has no `kind` classification, or whose `sourceId`
no longer matches any configured source, reports `kind: null` — never omitted, and never guessed.
A request's own `?kind=` filter is pinned into the pagination cursor exactly like `beat` is: an
explicit `kind` on a later page that disagrees with the cursor's is a `400 cursor_mismatch`,
never silently applied or silently dropped.

**Three things that look like bugs and are not:**

1. **Scores are already decayed** at `now`, server-side. There is no raw score on the wire; a
   client must never apply decay itself.
2. **A pinned row can have `signalScore` 0.000.** Hard overrides pin regardless of computed
   score — on the real corpus, 21 of 50 pinned cyber rows round to exactly zero. **Pinning is a
   separate axis from score**, and a client sorting purely by score would render pinned items
   at the bottom.
3. **`nextCursor` carries a frozen `now`.** Ranking is a function of the clock, so the cursor
   pins page 1's instant and every later page re-applies decay at that same moment. Pagination
   therefore walks one consistent ranking instead of a shifting one. A long-lived cursor goes
   stale *by design* — refresh rather than paginate forever.

Dismissed items are excluded server-side. Do not filter again client-side.

### `GET /api/search`

Full-text search (FTS5) over titles and stored excerpts.

| param | type | notes |
| --- | --- | --- |
| `q` | non-empty string | required |
| `limit` | 1–100, default 25 | |

Returns `{ query, unsearchable, hits: [{ itemKey, title, sourceId, canonicalUrl, publishedAt, itemType, snippet, rank }] }`.

- `rank` is FTS5's bm25 value: **lower (more negative) is a better match**. Results arrive
  sorted, so most clients can ignore it.
- `snippet` marks the matched span with `[` … `]`.
- **`unsearchable: true` means the query contained nothing to search for** — distinct from a
  query that was fine and matched nothing. Only input that tokenises to nothing (whitespace)
  triggers it. Operators are *quoted into literals*, so `?q=AND` searches for the word "AND"
  and returns real hits; `AT&T` and `C++` likewise are safe and meaningful.
- **Only titles and ~300-character excerpts are indexed.** Searching a phrase from the body of
  an article will not find it — the system stores links and short excerpts by policy, never
  full text.

### `GET /api/sources`

Per-source health. §7: *"Silent-failing feeds are the main failure mode of a system like this;
make them loud."*

Each entry carries `id`, `name`, `beats`, `enabled`, `pollInterval`, `lastSuccessAt`,
`lastFailureAt`, `lastError`, `consecutiveFailures`, `nextEligibleAt`, `itemsYielded7d`,
plus derived `failing` and `stale`.

- **`failing` = enabled AND (an error streak OR stale).** The second branch is the important
  one: a feed that last succeeded weeks ago with *zero* errors, because nothing is polling it,
  is the silent failure. A naive `consecutiveFailures > 0` check reports it as healthy.
- **`stale` is measured against each source's own `pollInterval`**, not a global threshold. A
  `1d` source at 25 hours is overdue; a `12h` source at 30 minutes is fine.
- **`itemsYielded7d` is a *tumbling* window, not a sliding one** — it resets rather than
  continuously trailing 7 days. Treat it as an at-a-glance signal, not an analytic.
- A source configured but never polled has no fetch-state row; it appears with nulls rather
  than being omitted.

### `GET /api/dashboard/header`

§7's header strip: `{ beats: { <beat>: { lastRefreshAt, sourceCount } }, failingSources,
enrichmentSpend }`.

`enrichmentSpend` is a **measured** zero, not a placeholder — it reports
`{ amountUsd, measured, asOf, note }`, where the note records that every paid path is
hard-disabled while `WF_ALLOW_PAID_ANTHROPIC` is unset. It will start reporting real numbers at
M5 without a code change.

### `GET /api/dashboard/layout` · `PUT /api/dashboard/layout`

Lane order and per-lane collapse state, **server-side** — §7.1: *"Don't put any of it in
browser storage."* Single-user means phone and desktop see identical state with no sync logic.

`PUT` is a **full replace**: send all six lanes in the desired order. Array order *is* lane
order. Partial updates of an ordered collection have no clean semantics, so they are not
offered.

### Item state

```
POST   /api/items/:itemKey/read
POST   /api/items/:itemKey/save
DELETE /api/items/:itemKey/save
POST   /api/items/:itemKey/dismiss
GET    /api/items/:itemKey/state
```

All return `{ readAt, savedAt, dismissedAt }`. `:itemKey` is the 64-character sha256 hex digest
of the canonical URL.

- **All are idempotent.** A keyboard UI makes held keys and double-taps ordinary: a second
  dismiss does not re-stamp the timestamp and does not log a second interest signal.
- **There is deliberately no un-dismiss.** §7: *"Dismissed items never come back."* The
  asymmetry between `DELETE …/save` and the absence of `DELETE …/dismiss` is the point, and a
  test asserts that absence so nobody adds one to make the shape regular.
- **Dismissal writes a negative interest signal** to `interest_dismissal_signals`, atomically
  with the state change. Nothing reads it back to adjust weights — §7 says log it, don't
  auto-tune, and that is enforced by test rather than by convention.
- **State is keyed on `item_key`**, so it survives a source re-delivering an item as a new
  version.
