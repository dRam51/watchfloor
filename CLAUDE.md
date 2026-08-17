# Watchfloor

Single-user, self-hosted situational-awareness dashboard across six beats: AI news,
cybersecurity, AI security, notable AI GitHub repos, markets, and US national news.

**The spec is the handoff brief.** Save the original to `docs/brief.md` — it is the
authority for every decision below. This file records only what has been *settled*
outside it, plus the rules easiest to violate by accident.

Status: **M0–M8 complete** (M4b deferred). **3,629 tests / 159 files.**
31 sources, 17,252 items, 12,232 entity rows. **M4b (markets) is deferred, not skipped**: its
entire input is `config/portfolio.yaml`, which only the owner can write, and its absence leaves
three of §8.2's five bot tools reporting `not_configured`.

> [!note] M8 — the desktop shell needs Rust, and it is installed
> `rustup` + stable 1.97.1, **566 MB**, installed with `--no-modify-path` so no shell profile was
> edited. `cargo` is not on `PATH` by default: run `. "$HOME/.cargo/env"` or add it yourself.
> `npm run shell` (dev) and `npm run shell:build` (bundle) both need it.
>
> **The shell loads a URL; it does not bundle the frontend.** `WATCHFLOOR_URL` defaults to
> `http://127.0.0.1:4173` (vite preview, NOT the API's 8787 — the API cannot serve HTML, see the
> `vite preview` note below). Bundled assets would be served from `tauri://localhost`, breaking
> the relative `/api/...` contract and forcing CORS onto Fastify for one client. **The webview
> polls, not Rust**, so the bearer token never leaves the tab and Rust never sees a credential —
> pinned by a test asserting `token` appears nowhere in `src-tauri/src/lib.rs`.
>
> **Three of §7.3's four notification triggers do not exist**: Juniper has no feed, NWS is
> robots-blocked, 8-Ks need M4b. KEV and critical-CVE are what notify. The menu-bar market ribbon
> has no data at all, so the tray shows the hard-override count instead.

> [!note] M7 renders. The bug that hid it for a day was **React StrictMode**.
> `load` never fired, so `ready` stayed false and every data layer was empty — while the globe
> itself drew perfectly. Cause: the effect cleanup called `map.remove()` synchronously, so
> StrictMode's mount → cleanup → mount destroyed the first map mid-style-load and the second never
> finished loading. Fix: **defer the teardown by one macrotask** so a re-mount cancels it. Verified
> live with StrictMode ON — 42 markers, 128 arcs, terminator, 180-country choropleth, one WebGL
> context, click-through opening a real item. Pinned by `web/tests/mapLifecycle.test.ts`, watched
> to fail against a reintroduced synchronous `remove()`.
>
> **The expensive part was a bad control.** An early probe "with no sources at all" appeared to
> fail too, which ruled out the style and sent the hunt into the library, the worker, CSP and
> WebGL — including an unnecessary v6→v5 downgrade. That probe was run while
> `optimizeDeps.exclude: ['maplibre-gl']` was set, which breaks MapLibre's named-export interop,
> so it was broken for an unrelated reason and its result meant nothing. **A control experiment
> run in a broken environment is not a control** — re-establish that the known-good case actually
> passes before trusting the known-bad one. What finally worked was bisection from a *verified*
> working probe: every piece of the real style loaded fine, which left the component.

> [!important] M5's acceptance passed, and what it could NOT establish matters as much
> Four of five criteria are proven against the owner's **real** iCloud vault and the live
> corpus, not fixtures: the tree moved aside and rebuilt **177 of 178 files byte-identical**;
> hand-written prose above *and* below a managed block survived a sync untouched; a point-in-time
> read matched SQL ground truth exactly (459 → 458 candidates); §7.4's graph renders. Zero paid
> requests fire with `WF_ALLOW_PAID_ANTHROPIC` unset, proven by three injected bypasses.
>
> **But `item_state` holds `0 saved · 1 read · 0 dismissed` across 11,016 items.** Five features
> are therefore *correct by construction and by unit test, and unproven against use*: `saved/`
> promotion, `verify`'s saved-note checks, the weekly note's "haven't opened" filter, the
> dismissal-signal log, and interest-profile proposals. Twenty minutes of real dashboard use
> converts that column — and is also the only way to answer §7's acceptance question, which is
> still open from M3: does it *read like a terminal rather than a content feed*.

> [!important] The unowned seam is this project's characteristic defect. It has now happened **ten times**.
> Every instance is the same shape: a component that is correctly built, fully tested, and
> **reachable from nothing**. `tsc` is clean, the suite is green, and the feature is inert.
>
> | # | Component | Found by |
> | --- | --- | --- |
> | 1 | `registerItems` — the dashboard could display state it had no way to change | M3 integration |
> | 2 | The `github_search` adapter — in the `SourceType` union since M1, no registry entry | M4a live run |
> | 3 | Star snapshots — velocity would have returned `no_snapshots` *forever*, not for seven days | M4a live run |
> | 4 | The README enricher — §4's fourth suppression rule silently inert | M4a live run |
> | 5 | Entity extraction — `item_entities` is **0 rows across 7,267 items**, and a comment has said so since M2 | M5 Task 7 |
> | 6–7 | `createLlmBackend` and `loadEnrichmentPolicy` — Wave 1's whole LLM stack, called only by its own modules | M5 Task 15 |
> | 8 | Scoring ran in **neither** unattended entrypoint — 1,119 of 7,056 items unscored, newest score two days old | The owner asking a plain question |
> | 9 | `locations` / `item_locations` / `src/domain/location.ts` — in the schema since `0001_init.sql`, **zero rows across three milestones**, a working tested `upsertLocation` with no caller | M7, and it was *scaffolded on purpose*, which is why it looked intentional |
> | 10 | The whole M7 map client — every test green, `tsc` clean, build clean, **feature inert** | Opening the page and asking why one event had not fired. Cause was StrictMode's double mount; **fixed**, see above |
>
> **The tests that should have caught these were often named for the exact rule they failed to
> exercise.** `tests/sources/load.test.ts` had an assertion called *"only uses source types that
> have a registered M1 adapter"* — it passed throughout, because no source used the type.
> `tests/vault/sourceProperties.test.ts` enforced "nothing but the safety layer calls `fs`" while
> exempting the whole directory the note writers live in. Both are the same failure: **scope that
> excludes the only files capable of exhibiting the defect.**
>
> Three practices, earned rather than assumed:
> 1. **A milestone is not done until it has been run against reality.** Every instance above was
>    found by a live run or by a task reading the corpus, never by the suite.
> 2. **Every wave needs an explicit owner for the wiring**, because a task that owns
>    `src/vault/weekly.ts` does not own an entrypoint, and nobody notices the difference.
> 3. **Pin the absence.** M5 Task 8 shipped a test asserting `promoteSavedItem` has no caller, so
>    wiring it turns the test red. That is the first time the pattern announced itself instead of
>    waiting to be discovered.

> [!note] `git add` then `git commit` is a race whenever more than one writer is live
> Twice in one session a commit swallowed another agent's staged files — `git add <path>` stages
> a file's **entire working-tree content**, including edits someone else made between your `add`
> and your `commit`. Explicit paths do not help; the window is the problem.
> **Use `git commit -F - -- <paths>` in one invocation**, which stages and commits atomically.
> Nothing was lost either time, and history is never rewritten here — but a commit message that
> does not describe everything in the commit is exactly the confusion this project avoids
> elsewhere.

**There is a working dashboard.** `npm run migrate` → `npm run ingest` → `npm run score`, then
`npm run dev` (API) and `npm run dev:web` (Vite, `http://localhost:5173`). It prompts once for
`WF_API_TOKEN` and holds it in memory only.

> [!important] The acceptance question is not one a test can answer
> §7's deliverable is "usable daily on a laptop, legible on a phone browser, and already looks
> like a watchfloor." Everything mechanical is verified; whether it *reads like a terminal
> rather than a content feed* is the owner's call. The palette in `web/src/styles/tokens.css`
> is a **proposal**, not a settled choice — §7.1's tokens-in-one-place rule exists precisely so
> retuning it is a one-file edit.

> [!important] The acceptance run is what found M2's worst bug
> Clustering chained **1,543 unrelated CVEs into one cluster** (37% of the corpus) via
> transitive single-linkage over formulaic titles, which *promoted* churn because cluster size
> feeds `signal_score`. It took two fix rounds: stop writing bad clusters (cross-source-only +
> boilerplate-trigram filtering), then — because the first fix was **inert on any existing
> database** under append-only storage — scope `getClusterSizeAsOf` to the latest clustering
> *run* rather than an item's latest membership. Unit tests could not have caught either half.

> [!important] The scoring read path is three functions, not one
> `getCurrentItem` returns a single stored *version*, and three separate facts about an item
> are wrong if you read them from it. Use `getItemBeats` (`src/domain/itemBeats.ts`),
> `getItemEntities` (`src/domain/itemEntities.ts`), and — for an undated item's decay
> baseline — the first-seen `fetched_at` read path, not the current version's. Each exists
> because the single-version read silently returned a *plausible* wrong answer. This bit a
> fourth time in M3: a cross-listed item appears in **two lanes at once**, so the keyboard
> focus record is `{beat, itemKey}` rather than a bare key.

> [!warning] Migrations are no longer applied on boot
> `npm run migrate` is the **only** thing that applies them. `api`, `ingest`, `score`, `rank`,
> and `scheduler` all refuse to start with pending migrations. This closed a real incident: a
> routine `npm run rank` had applied a colleague's uncommitted `.sql`, and because
> `schema_migrations` had no checksum, an edited migration was then skipped forever — the live
> DB kept an unoptimised trigger (4.27x insert overhead vs 1.70x) with nothing reporting it.
> **§12's runbook needs this step added**; the brief is not on this machine.

## Resuming work — read these first

Conversation context does not survive a reset; these do.

| Where | What it holds |
| --- | --- |
| `docs/superpowers/plans/2026-08-14-m2-scoring.md` | **The current milestone.** M2 plan: clustering, mechanical scorer, hard overrides, golden-file test. Read "The decision that shapes everything: decay at read time" first — it constrains every scoring task. |
| `.superpowers/sdd/2026-08-14-m2-scoring/` | M2 task reports as they land |
| `.superpowers/sdd/2026-08-13-m1-ingest/progress.md` | **The M1 recovery map.** Every task's status, fix rounds, controller rulings, and carry-forward constraints. Trust it and `git log` over recollection. |
| `.superpowers/sdd/2026-08-12-m0-scaffold/progress.md` | Same for M0 |
| `docs/superpowers/plans/2026-08-13-m1-ingest.md` | The M1 plan — corrected five times; the ledger records why |
| `docs/brief.md` | **Local-only, gitignored — see the warning below.** The authority every plan cites by section number. Ask the human for it; do not commit it. |

> [!note] The brief is not on this machine, and the specs were recovered by grepping transcripts
> M3, M4a, M5 and M6's scope each came from the original paste, which survives in this project's
> session history — **not** from `docs/brief.md`, which has never existed here.
>
> **The transcripts are keyed to the path the repo had at the time**, so after the 2026-08-16
> move they are NOT under a directory named for `~/Watchfloor`:
>
> ```
> ~/.claude/projects/-Users-devinramotar-Documents-home-lab-watchfloor/   <- most of the work
> ~/.claude/projects/-Users-devinramotar-home-lab-watchfloor/             <- brief intermediate stop
> ~/.claude/projects/-Users-devinramotar-Watchfloor/                      <- from the move onward
> ```
>
> Grep all three. M7's and M8's scope is recoverable from the first one; verified 2026-08-16.
> The real fix is still to put `docs/brief.md` on this machine — a spec that lives only in a
> chat log is one bad `rm` from gone.

### The first live corpus is archived, and it is evidence

`attic/wf-m1-firstrun-2026-08-14.db` holds all 3,325 items from the first real ingest. It was
moved there rather than deleted when the DB was wiped for M2, because four findings depend on
it: 1,715 items with a null `published_at`, CISA KEV dumping its full 1,665-entry catalog, the
18 arXiv papers cross-listed across two beats, and the AP corpus's sports/Spanish-language
skew. **Open it `-readonly` and never write to it.** M2 tasks are expected to test against real
rows from it rather than invented fixtures — a fixture cannot prove a claim about real data.

> [!warning] This repository is PUBLIC.
> `docs/brief.md` and `config/portfolio.yaml` are gitignored and **must never be committed**.
> Both carry the owner's real financial positions — holdings with weights, sector
> concentration — plus location and employer context. Keep them locally; nothing in the
> codebase reads either at build or test time, so a clone is unaffected.
>
> Before adding any file that quotes the brief's §11 appendix, or any ticker list, check
> whether it belongs in git at all. The same applies to `.env`, already ignored.

`.superpowers/` is gitignored, so it survives on this machine but **not in a fresh clone**.
Anything that must outlive the machine belongs in `docs/`.

### Open, as of M3

> [!note] Resolved during M2 — all 20 source entries are now `enabled: true`
> This section previously said "two sources are `enabled: false`" (`nvd-cve`, `project-zero`).
> Both were fixed and enabled during M2, and **zero sources are disabled today** — verified
> against `config/sources.yaml`, and flagged by an M3 task that found this line stale. The NVD
> defect it described (API 2.0 sorts ascending by CVE ID, so paginating from `startIndex=0`
> returns 1988-era CVEs forever) is fixed by anchoring the walk at the tail; the sort trap
> itself is recorded under "How to add a source" above, because it recurred in a second source.

**Two hard-override categories have no reachable source.** Juniper SIRT publishes no feed,
and `api.weather.gov` serves a blanket `Disallow: /`, which takes NWS hurricane alerts off
the table during season. Both are recorded in `docs/sources-wishlist.md`. The override
mechanism is *specified* to be generic, so either becoming available is a config change —
verify that against `src/score/overrides.ts` rather than trusting this line.

**A hard override taken literally breaks on cold start.** "Pinned to the top regardless of
computed score" collides with a fact M1 established: **CISA KEV dumps its entire 1,665-entry
catalog on a first poll**, not just recent additions — half the whole first-ingest corpus. An
unbounded KEV override therefore pins 1,665 items above everything else on every cold start
or DB wipe, and the dashboard becomes the KEV catalog. Whatever bound resolves this has to
stay consistent with decay-at-read-time: an override evaluated at read time may use the
reader's `now`; one evaluated at scoring time may not. Note also that a KEV entry's own
`dateAdded` is not when *we* first saw it — on a cold start those differ by years.

**`item_type` is effectively binary, and `press` is empty.** Accepted deliberately on
2026-08-14 — documented rather than fixed, revisit at M4b. After task 7's refinement the
classifier returns `event` for the four government-primary sources and **`analysis` for
everything else**; `press` (PR-wire syndication: PRNewswire, Business Wire, IR boilerplate)
matches **0 of 3,325** real items, because none of the 19 configured sources is a PR-wire.

The cause is structural, not a weak token list. `ItemType` is `event | analysis | press`,
fixed by a CHECK constraint, and **none of them means "ordinary news story"** — which is what
most of the corpus is. So whichever value you default to is wrong for the majority: M1
defaulted to `press` and called everything churn, M2 defaults to `analysis` and calls a box
score depth. Verified against real rows — *"Phillies beat Twins 7-1 at Field of Dreams"* and
*"Swiatek vence a Rybakina en Toronto"* both classify as `analysis`.

Why it is safe to defer: `item_type` only affects decay for the **markets** beat, which has
no configured sources yet. Every other beat keys decay on the beat itself. **Why it must not
be forgotten:** `config/decay.yaml` gives markets `analysis` a 240h signal half-life against
`press`'s 6h — a **40× gap** that starts mattering the moment M4b adds markets sources.

Also note the plan's line that "`press` is the churn bucket that must be suppressed in both
views" is, in substance, unmet — nothing is in that bucket. Sports and Spanish-language
suppression rests entirely on the interest profile (`config/interests.yaml`), which catches
28 of 150 AP titles. Judge the M2 acceptance question — *is the AP sports and Spanish copy
gone from US news?* — against that mechanism, not against `item_type`.

**Reuters has no permitted route at all** — its own robots.txt blocks us, and the Google News
workaround is blocked by Google's. The `google_news` adapter stays in the tree, tested,
pointing at nothing. Any future indirect route must check **every host in the chain**, which
is the specific mistake that cost this one.

> [!note] Resolved
> The CVE URL collision (`cisa-kev` and `nvd-cve` constructing the same NVD URL, so one
> silently masked the other under append-only storage) was fixed before the first ingest by
> giving CISA its own `cisa.gov` URL. Note for any future disambiguator: canonicalization
> strips fragments, so a query parameter is the only kind that survives.

## Settled decisions

| Decision | Value | Rationale |
| --- | --- | --- |
| Node version | **26**, pinned in `.nvmrc` + `engines` | Already installed via Homebrew; no version manager present, so 24 LTS would mean a toolchain install for a benefit expiring when 26 goes LTS (Oct 2026). Revisit if `better-sqlite3` has no ABI 147 prebuild — a one-line change per §12. |
| Branching | **Branchless — commit directly to `main`** | §6 mandates commit-often / never-rewrite-history, which branches add nothing to here. Also avoids superpowers' `using-git-worktrees` and `finishing-a-development-branch` workflows, whose teardown steps collide with §6's never-delete rule and the §13 deny list. |
| Deny list | §13 verbatim **plus** `git checkout *`, `git worktree remove*`, `git branch -d *` | Closes three holes: `git checkout .` discarding uncommitted work, worktree teardown, and lowercase branch delete. |
| Repository | **Public**, at `https://github.com/dRam51/watchfloor` | Overrides the brief's never-push rule, on the owner's explicit instruction. See the warning below for what must never be committed. |
| Recency decay | **Applied at read time, never stored** | `item_scores` is append-only and a decaying score changes continuously, so storing it would append a row per item per beat forever to record nothing but the clock. Store the decay-invariant components; multiply by a decay factor at query time. Also makes historical ranking truthful — "what ranked top last Tuesday" applies Tuesday's decay to what was known then. |
| Beats belong to the item | **Unioned across every version sharing an `item_key`** | An arXiv paper cross-listed in `cs.AI` and `cs.CR` is two rows with one key; the current-item read returned only the tie-break winner's beat. `src/domain/itemBeats.ts` is the corrected read path — `Item.beats` still returns the single-version answer. |
| Migration application | **Explicit `npm run migrate`. Every other entrypoint refuses to boot with pending migrations** instead of auto-applying them. | `src/bin/{api,ingest,score,rank,scheduler}.ts` used to call `runMigrations` on every boot, so a routine `npm run rank` silently applied whatever `*.sql` happened to sit in `db/migrations/` — confirmed to be how an in-flight, still-being-edited migration got applied to `data/wf.db` prematurely during M3. `assertMigrationsUpToDate` (`src/db/migrate.ts`) now also checksums every applied migration and fails loudly, naming the file, if one was edited after being applied — and refuses a migration that would apply out of order. See `.superpowers/sdd/2026-08-14-m3-api-dashboard/fix-migration-runner-report.md`. **§12's runbook needs a new step:** run `npm run migrate` after every `git pull` (or fresh clone) and before `npm run dev` / restarting the scheduler — `docs/brief.md` is gitignored and not present on this machine to edit directly, so this is recorded here until someone with the brief can fold it in. |

## The `node:sqlite` cast quirk — three modules have now hit this

Casting `.all()`'s result to a **named interface** array fails `tsc`; casting to a
**structurally identical inline type literal** passes.

```ts
const rows = stmt.all(...) as MyRow[];                       // TS2352, "neither type
                                                             // sufficiently overlaps"
const rows = stmt.all(...) as Array<{ id: string; n: number }>;   // fine
```

`.all()` returns `Record<string, SQLOutputValue>[]`, and TypeScript's `as` overlap check is
stricter about a named-interface array target than about an inline literal. Keep the named type
for the function's public signature — the constraint applies only to the cast target at the
call site.

`src/cluster/store.ts:88-100` carries the long-form explanation. `src/domain/itemState.ts` and
`src/search/query.ts` each rediscovered it independently, which is why it is recorded here.
**Leave a comment at any new cast site**, or the next person tidies it into a named interface
and reintroduces the error.

## Standing rules — the ones that bite

- **Never delete anything.** No `rm`, no history rewrites, no dropping tables outside a
  reviewed migration. Obsolete files go to `attic/` via `git mv`, with the reason in the
  commit message. Enforced mechanically by `.claude/settings.json`; if a command is
  denied, use the attic pattern rather than routing around it. Same standard applies
  inside any script written here — no `fs.rm`, `fs.unlink`, `shutil.rmtree`.
- **Zero-dollar by default.** The running system must be *incapable* of spending money
  without an explicit `WF_ALLOW_PAID_*` flag. Flag absent = code path hard-disabled, never
  a silent fallback or a deferred retry. No `WF_ALLOW_PAID_ALL`. Every external service
  gets an entry in `docs/costs.md`. A free tier requiring a card on file is a paid service.
- **Portability from the first commit.** Zero absolute paths anywhere in the tree,
  including tests, scripts, and docs. All paths via env (`WF_DB_PATH`, `WF_VAULT_ROOT`,
  `WF_DATA_DIR`, `WF_LOG_DIR`). `TZ` set explicitly in config and every schedule derived
  from it — never read the system timezone. No macOS-only binaries, no Keychain.
  Case-exact imports (macOS is case-insensitive; the target host may not be).
- **The markets beat is a research feed.** Never a trade decision, directional score,
  sentiment label, price target, or position size. If something here starts to resemble
  one, stop and ask.
- **Vault integration owns exactly one subtree** (`watchfloor/`) and never writes outside
  it. `saved/` is written once and never touched again.
- **Stop and ask** when the brief conflicts with itself or with something known to be
  true. Do not resolve contradictions silently.

## Environment

- **Skills required:** `superpowers@claude-plugins-official` and
  `andrej-karpathy-skills@karpathy-skills`, both installed at user scope. These are
  per-machine installs — they do **not** travel with the repo. Reinstall on any new
  development machine (§12 runbook step 8).
- `.claude/settings.json` is read-only infrastructure. Do not modify it without being asked.
- **`AGENTS.md` — resolved 2026-08-14, and nothing regenerates it.** A stale mid-M1 copy of
  this file, with "claude" string-replaced by "Codex", which corrupted the three places that
  word appears inside a real path or package name: it claimed the deny list lives at
  `.Codex/settings.json` and the skills come from `superpowers@Codex-plugins-official`.
  Neither exists. It sat at the repo root — where `AGENTS.md` is a convention some agent
  tooling reads as authoritative — and was **not** gitignored, so it was simultaneously
  readable as instructions and one `git add -A` from being committed as guidance.

  ~~Investigated: **no hook, script, or plugin generates it.**~~ **That conclusion was wrong,
  and a fresh corrupt copy appeared at the repo root the same evening, timestamped during an
  active session.** The original search covered this repo's settings, user-scope Claude
  settings, and plugins — all correctly, and all in the wrong place.

  **The generator is OpenAI Codex (ChatGPT.app).** `AGENTS.md` is Codex's own
  instruction-file convention, exactly as `CLAUDE.md` is Claude's, and it mirrors this file
  into that path with a vendor-name substitution — which is precisely what corrupts the three
  places "claude" appears inside a real path or package name. Evidence: `~/.codex/` holds
  sessions naming this repo, plus a `claude-cowork-import-history.json`, and
  `com.openai.codex` processes run on this machine. **Nothing in Claude's configuration is
  involved, which is why searching Claude's configuration found nothing** — the lesson worth
  keeping is that "no hook in *our* tool generates it" does not establish "nothing generates
  it" on a machine running more than one agent.

  The original copy is at `attic/AGENTS.md.corrupt-2026-08-14`. The repo-root path is now
  **gitignored** (`/AGENTS.md`) rather than left free: it will keep being regenerated, and
  each regeneration is a corrupt instruction file sitting in a public repo's root. A
  deliberately-authored one can still be committed with `git add -f`.
  **This file remains the authority** regardless — and if you use Codex here, be aware the
  `AGENTS.md` it reads is a lossy copy of this one.

## How to run

    npm install
    cp .env.example .env      # then edit — no absolute paths
    npm run migrate           # required before first boot -- see "Settled decisions" above
    npm run dev               # api on 127.0.0.1:$WF_API_PORT
    npm test
    npm run check:portability

## How it actually runs, day to day

`io.dram51.watchfloor.cycle` — a launchd agent that runs **one cycle at 08:00, 13:00 and 19:00
local, then exits.** Not a resident daemon: this is a laptop, and the daemon shape held ~170 MB
resident all day and woke every 60 seconds. Measured before choosing.

```bash
node scripts/generate-service.mjs launchd-cycle > ~/Library/LaunchAgents/io.dram51.watchfloor.cycle.plist
launchctl load ~/Library/LaunchAgents/io.dram51.watchfloor.cycle.plist
launchctl start io.dram51.watchfloor.cycle   # run one now
tail -f logs/cycle.log
```

**A cycle's cost is not one number**, and the first measurement was misleadingly small. A
steady-state run with most sources not due is ~15 s. The first run after a gap is *minutes* —
one measured **563 s**, ingesting 2,515 items and then clustering and scoring across a corpus
that grew 14,055 → 16,570. `Nice 10` and `LowPriorityIO` are in the plist for that reason.

`KeepAlive` is deliberately **absent**. Combined with `StartCalendarInterval` it means "restart
it the moment it exits", which for a job whose whole purpose is to exit is an infinite loop —
the most common way a scheduled launchd agent becomes a runaway.

If the Mac is asleep at a scheduled hour, launchd runs the job **once** shortly after wake
rather than queuing every missed occurrence.

## How to add a source

Edit `config/sources.yaml` — never code. Fields and allowed values are documented
in the file header and enforced by `src/sources/load.ts`. A source with a
malformed `weight`, `beat`, or `poll_interval` fails at load, not at fetch time.

> [!warning] Check what the source actually *sorts by*. This has bitten twice.
> A feed returning HTTP 200 with well-formed, parseable, genuinely-real items can still be
> useless, because **an API's default sort is rarely "newest first"** and the failure is
> completely silent — no error, no null, no malformed row. Both instances were found only by
> looking at the dates of what came back:
>
> - **`nvd-cve`** sorts ascending by CVE id. Paginating from `startIndex=0` returned CVEs
>   from **1988** on every poll, forever. Fixed by anchoring the walk at the tail.
> - **`hn-algolia`** used Algolia's `/search`, which sorts by *relevance* — with no query
>   term, that means all-time popularity. It returned *"Steve Jobs has passed away"*
>   (**5,426 days old**) every hour, on the `ai` beat. Fixed with `/search_by_date` plus a
>   `numericFilters=points>50` quality floor, since pure recency swings to the opposite
>   failure of 1-point submissions minutes old.
>
> So when adding any `json`/`api` source: **fetch it and print the dates.** A one-line check
> (`newest`, `median`, `oldest` age of what comes back) catches this class instantly. A full
> 19-source sweep is recorded in the M2 ledger; re-run it after adding sources.
>
> Two results from that sweep that are *not* bugs but explain row counts:
> `huggingface-blog` carries its entire history (**842 items, median age 767 days**), like
> `cisa-kev`'s 1,665-entry catalog dump — correctly ordered, just complete. And
> `owasp-genai`'s newest item is **93 days old**, so it contributes nothing current to
> `aisec`; that is a quiet publisher, not a sort bug.

## Portability debt

> [!warning] The repo lives at `~/Watchfloor`, and it CANNOT live under `~/Documents`
> Moved there 2026-08-16 from `~/Documents/home-lab/watchfloor`, because **macOS TCC prevents a
> launchd agent from reading or executing anything in `~/Documents`**. Nothing scheduled could
> run. Measured directly, as a launchd agent:
>
> ```
> stat:  works                    <- ls only needs directory metadata
> read:  Operation not permitted  <- cannot read file CONTENTS
> exec:  Operation not permitted  <- cannot run the script
> ~/Library read: works
> ```
>
> Two workarounds failed identically: relocating the log files out of Documents (`exit 78`
> EX_CONFIG became `exit 126` permission denied), and putting a launcher in
> `~/Library/Application Support` that execs into the repo — **the child is blocked too**.
>
> A first diagnosis was **wrong and is worth keeping**: an early probe ran `ls package.json`,
> saw the path print, and concluded Documents was reachable. `ls` only *stats*. Reading and
> executing both fail, and only a probe that reads file *contents* distinguishes them.
>
> `Desktop` and `Downloads` are protected the same way. Anywhere else in `$HOME` is fine.
>
> **Note the directory is `Watchfloor` with a capital W.** A `~/Watchfloor` entry already
> existed, and on a case-insensitive filesystem the original casing wins regardless of what
> `mv` is told. It is one directory with the repo directly inside — but a Linux host would
> treat `~/watchfloor` and `~/Watchfloor` as two different paths, so use the capital.
>
> Nothing in the tree records this path: the zero-absolute-paths rule means the repo never knew
> where it lived, so the move needed no code change at all. `scripts/generate-service.mjs`
> resolves everything at generation time.

**The frontend is served by `vite preview`, which Vite documents as not a production
server.** Decided in M3 task 7 and **signed off by the owner on 2026-08-16** for a single-user,
loopback-bound, Tailscale-only deployment — recorded here
because §12's migration runbook has to state what actually runs on the target host, and
"whatever the dev machine happened to do" is not an answer.

The reasoning is better than it first sounds. Fastify cannot serve the bundle, because
`src/api/auth.ts` registers its bearer-token hook at the **root** instance so that every route
is protected by default — and that would 401 every static asset. Browsers cannot attach an
`Authorization` header to a page navigation, so there is no way for the SPA's own HTML to
carry one. Exempting static paths would reintroduce exactly the allowlist-you-must-remember
that task 1 was built to avoid.

Accepted for a single-user, loopback-bound, Tailscale-only deployment. **The upgrade path, if
that changes:** a second, unauthenticated Fastify instance with `@fastify/static` for the
bundle, with `/api` reached via `tailscale serve`'s path routing or `@fastify/http-proxy` —
two more dependencies, which is why it was not done pre-emptively.

**The Obsidian vault is on iCloud Drive** — `~/Library/Mobile Documents/iCloud~md~obsidian/
Documents/Obsidian-Vault`. iCloud does not exist on Linux, so if the always-on host is Linux the
§8.1 integration cannot run there. Still undecided: Mac host, move the vault to Syncthing/git, or
split ingest from vault-sync. **Note the vault is itself a git repo** (with `.gitleaks.toml`),
which is a real safety net and makes the third option cheaper than it sounds.

> [!important] The sync root is `Watchfloor Feed/`, and it is NOT where the project notes live
> Set 2026-08-16 on the owner's instruction: a **top-level** folder, a sibling of `00 Inbox` /
> `01 Tech Projects` / etc. Deliberately **not** `01 Tech Projects/Watchfloor/`, which holds
> twelve **hand-authored** project notes — because `daily/` and `weekly/` are rewritten on every
> run and `vault prune` is the one job in this system permitted to delete.
>
> The safety layer would refuse to touch those notes anyway (a path's first segment must be
> `daily`/`weekly`/`entities`/`saved`, so a bare filename is not an expressible request, and
> nothing without Watchfloor frontmatter is ever modified) — but two independent reasons to be
> safe is the right number here. `WF_VAULT_ROOT` lives in the gitignored `.env`.
>
> **Go-live, 2026-08-16:** 178 files — 1 daily, 1 weekly, **176 entity notes, 3,298 skipped by
> the note floor**. All twelve hand-authored notes verified **byte-identical** by checksum before
> and after. A second sync left all 178 files byte-identical, with blurbs going
> `23 generated / 0 cached` → `0 generated / 23 cached`: M5's destructive acceptance criterion
> holding against a real iCloud vault rather than a fixture.

~~**`WF_VAULT_ROOT` cannot point at that vault.**~~ **Fixed** (`74ae45d`). It now accepts an
absolute path while `WF_DB_PATH`, `WF_DATA_DIR`, and `WF_LOG_DIR` remain relative-only. The
zero-absolute-paths rule governs the **source tree**, not a gitignored `.env`, and a vault
always lives outside the repo. Verified: the real vault path is accepted and the other three
still reject absolute values.

**Local LLM inference** will differ on the target host. Ollama on Apple Silicon uses Metal; a
mini PC without a capable GPU may not run the same model at all.
