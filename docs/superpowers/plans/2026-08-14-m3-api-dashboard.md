# Watchfloor M3 — API + Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal (§ brief, M3):** the thing is usable daily on a laptop, legible on a phone browser, and already looks like a watchfloor.

**Scope:** Fastify endpoints, static bearer token, Vite/React frontend. Merged-stream view first, six-lane wide-viewport layout on top of it. Keyboard nav with pointer equivalents, read/saved/dismissed, source health page, FTS search, design tokens and the §7.4 theme, alert pulse, heat strips, score visualisation, micro-transitions.

**Tech stack:** TypeScript, Node 26, `node:sqlite`, Fastify (already a dependency, already serving `/health`), Zod, Vite + React (new — sanctioned by the brief), vitest.

## Two rulings recorded before anything is built

**Six lanes, one per beat.** The brief contradicts itself — §7 says "Six-lane layout, one lane per beat" while the M3 milestone line and §7.1 each say "five-lane". Raised with the owner 2026-08-14, who confirmed **six**. Corroborated independently by §7's own keyboard spec (`1-6` jump to lane) and by there being exactly six beats. The `repos` and `markets` lanes exist in M3 and sit empty until M4a/M4b fill them.

**The loop-engineering skill requirement is waived.** The brief said it would be added at M3 with a stop-and-wait if absent. It is not installed (only `superpowers`, `karpathy-skills`, `claude-video` are). Raised with the owner, who **waived it entirely** — it is removed from the prerequisite list and must not be flagged at future milestones. §12's migration runbook step 8 still names it; that line is now stale.

## The decision that shapes everything: merged-stream first, lanes second

§7.1 is explicit and the ordering is not negotiable:

> Build the merged-stream view *first* and treat lanes as the wide-viewport arrangement of it — that ordering means mobile is free and desktop is a layout choice, rather than mobile being a port.

So: **no task may build a lane-shaped component before the merged stream works.** A row rendered in the stream is the same row rendered in a lane. If a task finds itself writing lane-specific row logic, that is the signal it has inverted the order.

The companion rule, equally load-bearing:

> **The HTTP API is the only contract.** No server-rendered HTML, no business logic in the frontend, no endpoint that returns markup. Scoring, clustering, filtering, and state transitions all live server-side.

Concretely, the frontend must never compute a score, apply a decay factor, decide cluster membership, or filter by beat. It renders what the API returns. **Decay is applied server-side at read time** (the M2 architecture) — the API returns already-decayed values plus the components, never a raw stored score for the client to decay itself.

## What M2 handed forward

- **`item_scores` holds decay-invariant components.** Every read endpoint applies decay with the request's `now`. `computeDecayFactor` is the only path.
- **Three read paths exist because `getCurrentItem` returns one *version*:** `getItemBeats`, `getItemEntities`, `getItemFirstFetchedAt`. A feed endpoint that reads beats off the current item is wrong in a way tests will not catch.
- **`getLatestItemScore(db, itemKey, beat)`** is the read side of Task 5's identity decision. Use it; do not re-derive.
- **`getClusterSizeAsOf` is run-scoped**, not membership-scoped (fix round 2). Cluster counts shown in a row must come from it.
- **Overrides carry `applies_to: [signal]`** and pin at signal 0.000 when an item is old. A UI that sorts purely by score and expects pinned items to be high-scoring will mis-render them — pinning is a separate axis from score.
- **`item_type` is effectively binary** (`event` for four government-primary sources, `analysis` for everything else; `press` matches nothing). Do not build UI that leans on it.
- The acceptance corpus exists at `data/wf.db` — 4,135 real items, 0 null dates, scored. Build against it.

## Global Constraints

Every task's requirements implicitly include this section.

- **Node 26.** New runtime dependencies limited to Vite/React and what they require; anything else needs justification in the task report.
- **Never delete anything.** No `rm`, no history rewrites, no `fs.rm`/`unlink`. Obsolete files go to `attic/` via `git mv`. **Never edit an applied migration** — new schema is a new migration.
- **`items`, `item_scores`, `item_clusters` stay append-only.** `item_state` is deliberately NOT append-only (it is mutable UI state) — that asymmetry is intentional, per its own schema comment.
- **The markets beat is a research feed.** No sentiment, directional label, price target, or position size anywhere in the API or the UI.
- **This repository is public.** `docs/brief.md` and `config/portfolio.yaml` are gitignored and must never be committed. No ticker, holding, or weight in any tracked file.
- **Zero absolute paths.** Explicit `.ts` extensions in server code. `npm run check:portability` clean — extend it to cover the frontend rather than exempting the frontend from it.
- **No mocks, no network in tests.** Real temp-file SQLite, real fixtures, `server.inject` for route tests.
- Commit after every passing test run. Never rewrite history. Branchless on `main`.

### Visual-performance constraints (§7.4, non-negotiable)

- Animations ride `requestAnimationFrame`, **pause when the tab is hidden**, and respect `prefers-reduced-motion`.
- Heavy renderers stay code-split behind lazy routes.
- **Nothing visual may block or delay data.**
- Micro-transitions are 150–200ms, ease-out, **never bouncy**.
- If a visual feature fights the performance budget, **say which and why** rather than quietly cutting it.

### Accessibility and input constraints (§7.1)

- **Every keyboard action needs a visible, tappable equivalent.** `j`/`k`/`o`/`s`/`x` each need an affordance.
- **Touch targets ≥44px** on interactive elements, including in the dense desktop view.
- **Nothing may assume hover carries meaning.** Hover may enhance; it may never be the only way to reveal information.
- **No state in browser storage.** Read/saved/dismissed and lane order/collapse are server-side, single-user, no device IDs, no sync logic.

---

## Tasks

Waves are barriers; tasks within a wave touch disjoint files and run in parallel.

### Wave 1 — API foundations (parallel)

**Task 1 — Bearer token auth.** `WF_API_TOKEN` is configured and **no route enforces it** (recorded as an open question since M0). A Fastify hook that rejects unauthenticated requests, applied to everything except `/health`. Decide and document whether `/health` stays open (it is a liveness probe) and what an unauthenticated request receives — 401 with no body detail, never a hint about whether the token merely mismatched. Test that a route added later is protected **by default** rather than requiring the author to remember.

**Task 2 — FTS5 search.** New migration adding an FTS5 virtual table over retained item text, plus the query path. §7: "Full-text search across everything retained." Decide what "everything retained" means given the 300-character excerpt cap, whether the index is external-content or a copy, and how it stays in sync with append-only `items` (a trigger, or a rebuild in the scoring pass). Prove it finds a real item from the 4,135-item corpus.

**Task 3 — Item state.** `item_state` (`item_key`, `read_at`, `saved_at`, `dismissed_at`, `updated_at`) exists with **zero readers or writers**. Build the domain layer: mark read, save, dismiss, and un-save. **Dismissed items never come back** (§7), and **dismissal is logged as a negative interest signal without auto-tuning weights** — log it, do not feed it back. This table is mutable by design; keep it keyed on `item_key` so state survives re-versioning.

### Wave 2 — read endpoints (needs Wave 1's auth)

**Task 4 — Feed endpoint.** The core read: items per beat and merged across beats, ranked, paginated, with decay applied server-side at request `now`. Returns everything a row needs — score indicator value, title, source, published time, cluster count, beat tags, override/pin status, read/saved/dismissed state. Must use `getItemBeats`/`getLatestItemScore`/`getClusterSizeAsOf`, never the single-version reads. **Cursor pagination, not offset** — the corpus is append-only and growing under the reader.

**Task 5 — Source health endpoint.** §7 is specific: per source — last success, last failure, **error string**, items yielded over the last 7 days, current backoff state. "Silent-failing feeds are the main failure mode of a system like this; **make them loud**." Note `AdapterResult.capped`'s pinned direction invariant (`src/adapters/types.ts`): it counts entries at the OLD end and is **not** a behind-ness ranking — a health page that sorts by it would rank the healthiest source as furthest behind. `filtered` is a third, distinct count.

**Task 6 — Header strip + UI state.** Last successful refresh per beat, count of failing sources, today's enrichment spend (zero until M5 — surface it as a real zero, not a placeholder). Plus server-side persistence of **lane order and per-lane collapse state** (§7 requires these server-side, and §7.1 forbids browser storage).

### Wave 3 — frontend foundation

**Task 7 — Vite/React scaffold + design tokens.** Build tooling, dev/prod serving, and **design tokens as CSS custom properties in one place** — colors, spacing, type scale. §7: dark, high-contrast, monospace-leaning; no hero images, no big thumbnails, **no infinite scroll**. A native shell reuses the tokens later; a hardcoded palette does not travel. Extend `check:portability` to cover frontend sources.

**Task 8 — The merged stream.** *(The ordering rule above — this is the task that must not be skipped or reordered.)* Single scrollable stream of item rows across all beats, with a **beat filter chip row**. Item row: score indicator, title, source, relative time, cluster count, beat tag — **one line at rest, expands in place** for excerpt and metadata. Every interaction tappable, ≥44px targets, no hover-only affordances.

**Task 9 — Keyboard navigation.** `j`/`k` move, `o` open in new tab, `s` save, `x` dismiss, `/` search, `1-6` jump to lane, `r` refresh — **each with a visible pointer equivalent**. Focus management must be real (a screen reader and a keyboard user should agree on where they are).

### Wave 4 — the watchfloor

**Task 10 — Six-lane layout.** The wide-viewport arrangement *of the merged stream*, not a new component tree. Independently scrollable and collapsible lanes, order and collapse state from Task 6's server-side store. Below ~700px it collapses back to Task 8's stream. Expect US news collapsed most of the day (§7).

**Task 11 — Search UI + source health page.** `/` opens search over Task 2's FTS. The health page renders Task 5's data and makes failures loud.

**Task 12 — §7.4 visual features that have data in M3.** Alert pulse (hard-override items — one glow-pulse, then a persistent left-edge accent until read, **not a blinking siren**); heat strip per lane (thin 24h activity histogram); score visualisation (compact intensity bar). **Ticker tape and sparklines are deferred** — they need M4b holdings and M4a star-velocity data that does not exist yet; say so rather than faking them. Micro-transitions on row expand, lane collapse, and item entry.

## M3 Acceptance

**The deliverable is a judgement call, not a number**: open it over morning coffee on a laptop, and again on a phone browser. Is it usable daily? Does it read like a terminal rather than a content feed? Specifically —

- Does the merged stream work on a phone *before* the lanes exist on desktop?
- Can every keyboard action be done by touch?
- Is a silently-failing source obvious on the health page?
- Does a KEV pin read as pinned even though its score is 0.000?
- Does it already look like a watchfloor?

**Not in M3:** no GitHub lane (M4a), no markets sources or ribbon data (M4b), no enrichment (M5), no vault (M5), no entity graph (M5), no PWA (M6), no map or globe (M7), no native shells (M8).
