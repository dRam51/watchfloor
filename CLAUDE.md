# Watchfloor

Single-user, self-hosted situational-awareness dashboard across six beats: AI news,
cybersecurity, AI security, notable AI GitHub repos, markets, and US national news.

**The spec is the handoff brief.** Save the original to `docs/brief.md` — it is the
authority for every decision below. This file records only what has been *settled*
outside it, plus the rules easiest to violate by accident.

Status: **M0 complete (tagged `m0-scaffold`). M1 ingest in progress** — tasks 1–6 done,
7–9 in review, 10–11 not started. 417 tests. **Nothing has been ingested yet**; the DB is
empty until M1 task 11 runs the first live cycle.

## Resuming work — read these first

Conversation context does not survive a reset; these do.

| Where | What it holds |
| --- | --- |
| `.superpowers/sdd/2026-08-13-m1-ingest/progress.md` | **The M1 recovery map.** Every task's status, fix rounds, controller rulings, and carry-forward constraints. Trust it and `git log` over recollection. |
| `.superpowers/sdd/2026-08-12-m0-scaffold/progress.md` | Same for M0 |
| `docs/superpowers/plans/2026-08-13-m1-ingest.md` | The M1 plan — note it has been corrected four times; the ledger records why |
| `docs/brief.md` | **Missing.** The authority every plan cites by section number. Ask the human for it. |

`.superpowers/` is gitignored, so it survives on this machine but **not in a fresh clone**.
Anything that must outlive the machine belongs in `docs/`.

### Blocking before M1 task 11 (first live ingest)

**The CVE URL collision.** `cisa-kev` and `nvd-cve` construct the same NVD URL, so the same
CVE from both sources yields the same `item_key`. Under append-only storage one source
silently masks the other and clustering cannot see two pickups. Fixing it later does not
repair existing rows — it fragments each CVE's history. Give CISA its own `cisa.gov` URL;
a fragment disambiguator is stripped by canonicalization, a query parameter survives.

## Settled decisions

| Decision | Value | Rationale |
| --- | --- | --- |
| Node version | **26**, pinned in `.nvmrc` + `engines` | Already installed via Homebrew; no version manager present, so 24 LTS would mean a toolchain install for a benefit expiring when 26 goes LTS (Oct 2026). Revisit if `better-sqlite3` has no ABI 147 prebuild — a one-line change per §12. |
| Branching | **Branchless — commit directly to `main`** | §6 mandates commit-often / never-rewrite-history, which branches add nothing to here. Also avoids superpowers' `using-git-worktrees` and `finishing-a-development-branch` workflows, whose teardown steps collide with §6's never-delete rule and the §13 deny list. |
| Deny list | §13 verbatim **plus** `git checkout *`, `git worktree remove*`, `git branch -d *` | Closes three holes: `git checkout .` discarding uncommitted work, worktree teardown, and lowercase branch delete. |

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

**`WF_VAULT_ROOT` cannot point at that vault.** `src/config/env.ts` validates it as
relative-only — an over-application of the zero-absolute-paths rule, which governs the source
tree, not a gitignored `.env`. Relax it for this one variable before M5.

**Local LLM inference** will differ on the target host. Ollama on Apple Silicon uses Metal; a
mini PC without a capable GPU may not run the same model at all.
