# Watchfloor M4a — GitHub Repos Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal (§ brief, M4a):** the repos lane surfaces things I haven't already seen on HN.

**Scope (§4, repos beat):** GitHub REST/GraphQL API with a read-only PAT. Topic search, `created:>180d OR pushed:>14d` filtering, **ranking by star velocity rather than absolute stars**, daily star snapshots so velocity is computable, enrichment (language, license, last-commit date, open issues, README first paragraph), and suppression of forks, archived repos, repos with no README, and anything already dismissed.

**Tech stack:** TypeScript, Node 26, `node:sqlite`, Fastify, Zod, vitest. No new dependencies expected — the GitHub API is JSON over HTTPS and `politeFetch` already exists.

## The decision that shapes everything: velocity needs history

§4 is specific — *"**Rank by star velocity** (stars gained per day over the trailing 7 days), not absolute stars. Store daily star snapshots so velocity is computable — a repo going 40→400 in a week matters more than one sitting at 30k."*

**So on day one there is no velocity, and the lane cannot do its job yet.** Seven days of snapshots must accumulate before the ranking the brief asks for is even computable. This is not a bug to engineer around; it is the shape of the feature.

Every task must therefore treat "insufficient history" as a **first-class, well-tested state**, not an edge case:

- What does the lane show on day 1? On day 3?
- Is a repo with 2 days of history ranked against one with 7, and if so, how — without letting a noisy 2-day sample outrank a real 7-day trend?
- Does the UI say *"velocity unavailable — N days of history"* rather than rendering a confident zero?

Getting this wrong produces a lane that looks broken for a week and then silently starts working, which is the worst of both.

## The PAT, and what it gates

§4 says "with a PAT — read-only scope". **The owner must create it; no task may attempt to.** It belongs in `.env` as e.g. `WF_GITHUB_TOKEN`, gitignored like everything else there, and **must never be logged, echoed, or committed** — the same treatment `WF_API_TOKEN` gets in `src/api/auth.ts`.

Rate limits are the reason it matters:

| | Search API | Core API |
| --- | --- | --- |
| unauthenticated | 10 req/min | 60 req/hour |
| with PAT | 30 req/min | 5,000 req/hour |

Light live verification is possible unauthenticated; a real poll cadence is not. **Build so the adapter works either way**, reports which mode it is in, and degrades honestly rather than silently hammering a 60/hour ceiling into backoff.

**Zero-dollar rule:** a GitHub PAT is `free-tier-no-card` in `docs/costs.md`'s taxonomy — an account is required but no payment method is. That is permitted by default; only `paid` needs a `WF_ALLOW_PAID_*` flag. It still needs a `docs/costs.md` row.

## What M1–M3 handed forward

- **`repos` is already a real beat.** It is in `BEATS`, has a decay half-life in `config/decay.yaml` (72h signal / 336h read), renders an empty lane in the dashboard today, and `kind` exists on sources. Nothing structural is missing — the lane is waiting for data.
- **The adapter contract is fixed** (`src/adapters/types.ts`): `fetch(source, state, now?)` → `AdapterResult` with `items`, `etag`, `lastModified`, `notModified`, `skipped?`, `capped?`, `filtered?`. `capped` has a **pinned direction invariant** — it counts the OLD end of a range and is not a behind-ness ranking.
- **`item_state` already records dismissals**, keyed on `item_key`, and `interest_dismissal_signals` logs them. §4's "anything I've already dismissed" is therefore a read, not new machinery.
- **The scoring pipeline is decay-invariant.** A repo item stores components; the read applies decay. Velocity is a *component*, not a decayed value.
- **Excerpts are capped at ~300 characters** by standing rule. A README first paragraph is subject to it.
- **Migrations are no longer applied on boot.** `npm run migrate` is the only applier; every entrypoint refuses to start with pending migrations.

## Global Constraints

- **Node 26.** No new runtime dependency without justification in the task report.
- **Politeness over completeness.** GitHub's API is the sanctioned route; never scrape github.com. Respect rate-limit headers (`x-ratelimit-remaining`, `x-ratelimit-reset`) rather than discovering limits by hitting them.
- **Never delete anything.** No `rm`, no history rewrites, no `fs.rm`/`unlink`. Obsolete files go to `attic/` via `git mv`. **Never edit an applied migration** — and the runner now enforces this with checksums.
- **`items`, `item_scores`, `item_clusters` stay append-only.** Star snapshots are a new table; decide its append-only status deliberately (see Task 2).
- **This repository is public.** The PAT never appears in a tracked file, a log line, or a test fixture.
- **Zero absolute paths.** Explicit `.ts` extensions. `npm run check:portability` clean — note it only sees **tracked** files.
- **No mocks, no network in tests.** Real temp-file SQLite, real captured fixtures. Live verification is for the report, not the suite.
- **`data/wf.db` is the real corpus**: never write to it, never migrate it. Copy with `sqlite3 data/wf.db "VACUUM INTO '<scratch>'"`.
- Commit after every passing test run. Branchless on `main`.

---

## Tasks

Waves are barriers; tasks within a wave touch disjoint files and run in parallel.

### Wave 1 — foundations (parallel)

**Task 1 — GitHub API client.** `src/fetch/github.ts`. PAT from env (optional), rate-limit header handling, conditional requests via ETag, and an explicit authenticated/unauthenticated mode that the caller can see. Must **never log the token**. Decide REST vs GraphQL and justify it — GraphQL fetches more per request (relevant against a 5,000/hr budget) but is harder to cache and to fixture.

**Task 2 — Star snapshot storage.** New migration. One row per repo per day, so trailing-7-day velocity is computable. Decide: append-only like `items`, or upsert-per-day? A snapshot is an observation, not a mutable fact — but a day polled twice must not double-count. State the choice and enforce it. Include what happens when a day is *missed* (the scheduler was down), because velocity over a gappy window is the case that will actually occur.

**Task 3 — Repo domain type + suppression.** `src/domain/repo.ts`. The §4 suppression list — forks, archived, no README, already-dismissed — as testable predicates. Dismissal is a read against existing `item_state`, keyed on `item_key`; do not build a second mechanism.

### Wave 2 — the pipeline (needs Wave 1)

**Task 4 — Search adapter.** `src/adapters/github.ts`, wired as source `type: github_search` (already in the `SourceType` union, with no adapter — it will fail to route today). Topics from config, not code: `llm`, `agents`, `mcp`, `rag`, `ai-security`, `prompt-injection`, `llmops`, `network-automation`, `netdevops`. Filter `created:>` 180 days **OR** `pushed:>` 14 days. Emits `RawItem`s through the existing normalizer.

**Task 5 — Velocity computation.** `src/score/velocity.ts`. Stars/day over the trailing 7 days from Task 2's snapshots. **Pure, `now` injected**, matching every other scoring module. The insufficient-history contract lives here and must be explicit in the return type — not a `0` that a caller mistakes for "flat".

**Task 6 — Enrichment.** Language, license, last-commit date, open-issue count, README first paragraph (≤300 chars, per standing rule). Note the README costs an extra request per repo — decide whether it is worth the rate-limit budget, and say so.

### Wave 3 — surfacing

**Task 7 — Repo scoring + the HN signal.** Velocity into the mechanical scorer as a decay-invariant component. Plus the deliverable's actual test: *"things I haven't already seen on HN."* `hn-algolia` is an existing source — a repo already surfaced there should rank lower, not vanish. Decide the mechanism (URL match? title similarity? the existing clustering?) and justify it.

**Task 8 — The repos lane row.** §7: *"Repos lane rows differ: repo name, one-line description, language, stars + **velocity arrow**, last-commit age."* A different row component from the news row, in the same lane container. The velocity arrow must render honestly when velocity is unknown.

**Task 9 — Live run + acceptance.** Configure real sources in `config/sources.yaml`, run against the live API, and report what the lane actually surfaces — with dates and star counts.

## M4a Acceptance

**The deliverable is comparative, not a number**: does the repos lane surface things the owner has *not* already seen on HN? Specifically —

- Is anything in the top 10 genuinely new to someone who reads Hacker News daily?
- Does a 40→400 repo outrank a static 30k-star one, as §4 demands?
- On a fresh database with no snapshot history, does the lane say so rather than lying with zeros?
- Are forks, archived repos, and README-less repos actually gone?

**Not in M4a:** no markets (M4b), no enrichment LLM pass (M5), no vault, no MCP.
