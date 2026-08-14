# HTTP API reference

§7.1 makes this the load-bearing contract of the whole system:

> **The HTTP API is the only contract.** No server-rendered HTML, no business logic in the
> frontend, no endpoint that returns markup. Scoring, clustering, filtering, and state
> transitions all live server-side. A future client is then a new frontend against the same
> API, not a second implementation.

So this file exists for the clients that don't exist yet — M6's PWA, M8's native shells — as
much as for the current React frontend. A contract nobody wrote down is a weak contract.

Written 2026-08-14, after M3 Waves 1–2; the `repo` block added after M4a Wave 3. Verified
against the running server, not transcribed from the route files — every payload below was
copied out of a live response.

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
{ "status": "ok", "db": "ok", "migrations": 7, "tz": "America/New_York",
  "sources": 27, "costGates": { … } }
```

`migrations` is the count of *applied* migrations, so it moves when a migration lands — it
was 6 before M4a added `0007_repo_star_snapshots`. A database that has not had
`npm run migrate` run against it still reports the old number, and every entrypoint refuses
to boot in that state rather than auto-applying.

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
repo     null, or the block below
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

#### The `repo` block — repos-lane rows only

`null` on every item that did not come from a `github_search` source. §7: *"Repos lane rows
differ: repo name, one-line description, language, stars + velocity arrow, last-commit age."*
Live response, abridged only where marked:

```json
"repo": {
  "owner": "rustdesk", "name": "rustdesk", "fullName": "rustdesk/rustdesk", "repoId": 101,
  "description": "…", "language": "Rust", "licenseSpdxId": "MIT",
  "stars": 400, "openIssuesAndPullRequests": 7,
  "lastCommitAt": "2026-08-13T09:15:00.000Z",
  "isFork": false, "isArchived": false, "readmeExcerpt": null,
  "velocity": {
    "status": "ok", "repoId": 101,
    "fromDay": "2026-08-08", "throughDay": "2026-08-14",
    "expectedDays": 7, "observedDays": 2,
    "missingDays": ["2026-08-09", "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13"],
    "starsPerDay": 60, "starsGained": 360,
    "spanDays": 6, "spanCoverage": 1, "staleDays": 0,
    "first": { "day": "2026-08-08", "stars": 40,  "observedAt": "2026-08-08T12:00:00.000Z" },
    "last":  { "day": "2026-08-14", "stars": 400, "observedAt": "2026-08-14T12:00:00.000Z" },
    "mixedTimezone": false
  },
  "velocityComponent": 1,
  "hn": {
    "seen": true, "strength": 0.5, "component": 0.5,
    "mentions": [{
      "itemKey": "452ad631b6…", "sourceId": "hn-algolia", "via": "title",
      "title": "RustDesk now supports true unattended remote access on Wayland",
      "canonicalUrl": "https://rustdesk.com/blog/unattended-remote-access-wayland",
      "publishedAt": "2026-08-14T16:12:52.000Z"
    }]
  }
}
```

**`velocity` is a discriminated union on `status`, and the union is intact on the wire.**
When `status` is `"insufficient_history"` there is **no `starsPerDay` field at all** — not
`null`, not `0`. Instead you get `reason` (`unknown_repo` · `no_snapshots` ·
`single_snapshot` · `span_too_short`) and `minSpanDays`, alongside the window facts
(`expectedDays`, `observedDays`, `missingDays`, `spanDays`). A client writing
`velocity.starsPerDay ?? 0` gets `undefined`, deliberately: §4's ranking needs seven days of
snapshots that do not exist on a fresh database, and the lane must **say so** rather than
draw a confident flat arrow. Branch on `status`; render "velocity unavailable — N days of
history" on the other branch. Live, that branch looks like:

```json
"velocity": {
  "status": "insufficient_history", "reason": "unknown_repo", "repoId": null,
  "fromDay": "2026-08-08", "throughDay": "2026-08-14",
  "expectedDays": 7, "observedDays": 0, "missingDays": [], "spanDays": 0, "minSpanDays": 3
}
```

Note `missingDays` is **empty**, not seven days long, when `reason` is `unknown_repo`:
nothing is "missing" for a repo that was never watched. `no_snapshots` means we looked and
saw nothing and *does* name the days. Rendering "0 of 7 days observed" off `unknown_repo`
would be wrong.

**`spanDays` is fractional.** It is elapsed days between two observation *instants*, not a
count of calendar-day labels. Two polls 2 hours apart straddling midnight span 0.083 days,
not 1. Do not round it into the measurement.

**`starsPerDay` can be negative** — repos genuinely lose stars, and GitHub purges spam stars
in bulk. It is not clamped anywhere in the stack, and neither is the score it feeds:
**`signalScore` can be negative** for a barely-moving repo that HN has already covered
(observed at −0.097 on the live corpus). A client must not assume a non-negative score.

**`staleDays > 0` means the rate is real but old** — it describes an interval that stopped
that many days ago, because the poller missed the end of the window. Reported, never gated:
one missed poll must not blank the lane. Render it as "as of *N* days ago" rather than
hiding it.

**`velocityComponent` and `hn.component` are the numbers the scorer actually used**, bounded
to [−1, 1] and [0, 1]. `velocityComponent: 0` is ambiguous by construction — it means either
"flat" or "no history" — which is exactly why `velocity.status` ships beside it.

**`hn` is the M4a acceptance question in the response.** A repo already covered on Hacker
News is **de-ranked, never suppressed** (§4's suppression list is fork / archived / no README
/ dismissed, and this is not on it). `via` says how the match was made: `"url"` for a link
that names the repo — including a deep link into it, or a `*.github.io` Pages site — and
`"title"` for a headline that names the project while linking somewhere else entirely. The
mentions are shipped, not just the flag, so a UI can show *why* a row sank.

**`readmeExcerpt: null` does NOT mean "this repo has no README."** An unread README is
indistinguishable from a missing one. Do not render the absence as a claim.

**`openIssuesAndPullRequests` counts open pull requests too**, because GitHub's
`open_issues_count` does — 3 issues plus 90 PRs reports 93. Do not label it "issues".

**Metadata can be `null` while the signal is not.** `description`, `language`,
`licenseSpdxId`, `stars`, `openIssuesAndPullRequests`, `lastCommitAt`, `isFork`, `isArchived`
and `readmeExcerpt` all come from the stored `raw_json`; if that cannot be read back they are
`null` while `velocity` and `hn` remain fully populated. `owner`/`name`/`fullName` come from
the item's own URL and are always present.

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

Each entry carries, verified against the running route:

```
id  name  beats  weight  enabled
pollInterval  pollIntervalMs  everPolled
lastSuccessAt  lastFailureAt  lastError
consecutiveFailures  nextEligibleAt  inBackoff
itemsYieldedSinceWindowStart  windowStartedAt  updatedAt
stale  failing  degraded
sweep  (null, or { requestsPerPoll, requestsPerMinute, authMode, completable })
```

*(This block previously listed a `kind?` field. `SourceHealth` has never declared one — `kind`
is on `/api/feed`'s items, resolved per source, and was transcribed here in error. Removed
M4a. It is the second time this section documented a field the route does not return; see the
`itemsYielded7d` note below.)*

- **`failing` = enabled AND (an error streak OR stale).** The second branch is the important
  one: a feed that last succeeded weeks ago with *zero* errors, because nothing is polling it,
  is the silent failure. A naive `consecutiveFailures > 0` check reports it as healthy. Two
  sources are in exactly that state on the live corpus right now.
- **`degraded` = enabled AND a sweep that cannot complete.** A third axis, orthogonal to
  `failing`. A `github_search` source issues one request per (topic × recency-half), so nine
  topics is **18 requests against an unauthenticated ceiling of 10 per minute**: ten go out,
  eight never do, and the poll returns *successfully* — zero errors, a fresh `lastSuccessAt`,
  a healthy item count. Every other field on this endpoint says fine. Deliberately **not**
  folded into `failing`: that boolean feeds the header strip's alarm count, and a sweep short
  of budget is permanent until a PAT exists or topics are trimmed, so counting it there would
  pin the alarm above zero forever. A source can be both `failing` and `degraded`; they are
  independent.
- **`sweep` is a prediction, not an observation, and is `null` for single-request sources.**
  The observed figure (`AdapterResult.coverage`, `src/adapters/types.ts`) lives on the
  scheduler's in-memory poll report and is never persisted, and the API is a separate process
  — so this endpoint reports what a *complete* poll would need (`requestsPerPoll`, exact: the
  sweep is a pure function of the topic list) against the ceiling it is billed to
  (`requestsPerMinute`, from GitHub's published limits for `authMode`). It answers "can this
  source ever complete a sweep?", never "did it this time." `authMode` is inferred from this
  process's own `WF_GITHUB_TOKEN`; api and scheduler are separate processes sharing one
  `.env`, so it is the API's mode, which is the poller's only under that assumption.
  `null` means the concept does not apply — never a fabricated one-of-one.
- **`stale` is measured against each source's own `pollInterval`**, not a global threshold. A
  `1d` source at 25 hours is overdue; a `12h` source at 30 minutes is fine. `pollIntervalMs` is
  the same value pre-parsed so a client need not parse `"30m"`.
- **`itemsYieldedSinceWindowStart` is named for what it is.** The underlying counter is a
  *tumbling* window that resets, not a sliding 7-day trail — so it is deliberately **not**
  called `itemsYielded7d`, and `windowStartedAt` tells you which window the number belongs to.
  Read them together or the number means little.
  *(An earlier revision of this file called it `itemsYielded7d` and omitted `weight`,
  `pollIntervalMs`, `everPolled`, `inBackoff`, and `updatedAt`. That was written from
  expectation rather than from the response, and a frontend task caught it. The route was
  always right.)*
- **`everPolled` distinguishes never-polled from polled-and-failed.** A source configured but
  never fetched has no fetch-state row at all; without this flag, its nulls look identical to a
  source that has failed since the beginning.
- **`inBackoff`** is derived from `nextEligibleAt` being in the future — surfaced so a client
  need not re-implement the comparison.

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
