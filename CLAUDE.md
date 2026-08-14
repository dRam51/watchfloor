# Watchfloor

Single-user, self-hosted situational-awareness dashboard across six beats: AI news,
cybersecurity, AI security, notable AI GitHub repos, markets, and US national news.

**The spec is the handoff brief.** Save the original to `docs/brief.md` — it is the
authority for every decision below. This file records only what has been *settled*
outside it, plus the rules easiest to violate by accident.

Status: **M0 complete (tagged `m0-scaffold`). M1 ingest complete. M2 dedupe+scoring in
progress** — Wave 1 underway. 515 tests. The first live ingest ran on 2026-08-14 and pulled
**3,325 real items in 10.3s across 17 sources**; the second cycle cost zero network requests.

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

### Open, as of M2 Wave 1

**Two sources are `enabled: false`** in `config/sources.yaml` and their DISABLED comment
blocks may be stale — check the code before believing them. `nvd-cve` is the live one: NVD's
API 2.0 sorts **ascending by CVE ID**, not by `lastModified` as an earlier comment claimed,
so paginating from `startIndex=0` returns 1988-era CVEs forever. Verified live: index 0 is
`CVE-1999-0095` (published 1988-10-01) while the tail of the same window is a CVE published
minutes ago. Any fix has to page from the tail.

**Two hard-override categories have no reachable source.** Juniper SIRT publishes no feed,
and `api.weather.gov` serves a blanket `Disallow: /`, which takes NWS hurricane alerts off
the table during season. Both are recorded in `docs/sources-wishlist.md`. The override
mechanism is built generically so either becoming available is a config change.

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
- **`AGENTS.md` is a generated mirror of this file and is currently wrong.** Something ports
  `CLAUDE.md` → `AGENTS.md` by string-replacing "claude" with "Codex", which corrupts the
  three places the word appears inside a real path or package name: it tells the reader the
  deny list lives at `.Codex/settings.json` and the skills come from
  `superpowers@Codex-plugins-official`. Neither exists. **This file is the authority**; treat
  `AGENTS.md` as untrusted until whatever generates it is fixed or removed. It is untracked
  and must not be committed in that state.

## How to run

    npm install
    cp .env.example .env      # then edit — no absolute paths
    npm run dev               # api on 127.0.0.1:$WF_API_PORT
    npm test
    npm run check:portability

## How to add a source

Edit `config/sources.yaml` — never code. Fields and allowed values are documented
in the file header and enforced by `src/sources/load.ts`. A source with a
malformed `weight`, `beat`, or `poll_interval` fails at load, not at fetch time.

## Portability debt

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
