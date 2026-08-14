# Watchfloor

Single-user, self-hosted situational-awareness dashboard across six beats: AI news,
cybersecurity, AI security, notable AI GitHub repos, markets, and US national news.

**The spec is the handoff brief.** Save the original to `docs/brief.md` — it is the
authority for every decision below. This file records only what has been *settled*
outside it, plus the rules easiest to violate by accident.

Status: **M0, M1, M2 complete. M3 API + dashboard — all 12 tasks landed; acceptance is the
owner's judgement call and has not been made yet.** **1,507 tests.** 27 sources, all
robots-verified. Pushed to GitHub through `6bf482c`.

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

  Investigated: **no hook, script, or plugin generates it.** `.claude/settings.json` has no
  `hooks` key, user-scope settings have none, and this file is the only one in the tree that
  mentions it. It was a one-off artifact, not a build product, so it will not come back.

  Moved to `attic/AGENTS.md.corrupt-2026-08-14` and gitignored — preserved on this machine,
  absent from a clone, exactly how the archived first-run database is handled. The repo-root
  path is deliberately left free: a *correct* `AGENTS.md` could be written there later.
  **This file remains the authority** regardless.

## How to run

    npm install
    cp .env.example .env      # then edit — no absolute paths
    npm run migrate           # required before first boot -- see "Settled decisions" above
    npm run dev               # api on 127.0.0.1:$WF_API_PORT
    npm test
    npm run check:portability

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

**The frontend is served by `vite preview`, which Vite documents as not a production
server.** Decided in M3 task 7 and **awaiting the owner's explicit sign-off** — recorded here
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
Documents/Obsidian-Vault`, with Watchfloor owning `01 Tech Projects/Watchfloor/`. iCloud does
not exist on Linux, so if the always-on host is Linux the §8.1 integration cannot run there.
Decide before M5: Mac host, move the vault to Syncthing/git, or split ingest from vault-sync.

~~**`WF_VAULT_ROOT` cannot point at that vault.**~~ **Fixed** (`74ae45d`). It now accepts an
absolute path while `WF_DB_PATH`, `WF_DATA_DIR`, and `WF_LOG_DIR` remain relative-only. The
zero-absolute-paths rule governs the **source tree**, not a gitignored `.env`, and a vault
always lives outside the repo. Verified: the real vault path is accepted and the other three
still reject absolute values.

**Local LLM inference** will differ on the target host. Ollama on Apple Silicon uses Metal; a
mini PC without a capable GPU may not run the same model at all.
