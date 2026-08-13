# Watchfloor

Single-user, self-hosted situational-awareness dashboard across six beats: AI news,
cybersecurity, AI security, notable AI GitHub repos, markets, and US national news.

**The spec is the handoff brief.** Save the original to `docs/brief.md` — it is the
authority for every decision below. This file records only what has been *settled*
outside it, plus the rules easiest to violate by accident.

Status: **preflight passed; M0 not yet planned or approved.** No application code exists.

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

## Portability debt

None yet. Anything macOS-only gets recorded here rather than left silent.
