# Watchfloor M6 — Hardening and Portability

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal (§ brief, M6):** *"I can stand the whole thing up on a different machine from a clean checkout plus one backup file, and the runbook is verified by actually doing it once."*

**Scope:** retention/archive job (preserving the `raw_json` policy), backup script for the SQLite file, PWA manifest + service worker for offline read, Dockerfile + compose file, process supervision for the target host, Tailscale-only bind documented, **migration runbook per §12**, README.

## The deliverable is a rehearsal, not a document

Every prior milestone's acceptance was a property of the code. This one is a property of *a different machine*: a clean checkout plus one backup file must come up working, and **the runbook is verified by actually doing it once.** A runbook nobody has executed is a hypothesis.

That reframes every task here. The Dockerfile is not done when it builds; it is done when the rehearsal used it. The runbook is not done when it is written; it is done when someone followed it start to finish and the gaps it had are fixed.

## ⚠️ The decision that blocks the deliverable

**The Obsidian vault is on iCloud Drive, and iCloud does not exist on Linux.** `CLAUDE.md` has carried "decide before M5" since M3; M5 shipped and the decision is still open. It is now load-bearing, because "stand the whole thing up on a different machine" cannot be verified without knowing which machine.

Three options, with what each costs:

| Option | Consequence |
| --- | --- |
| **Mac host** | Everything works unchanged. `WF_VAULT_ROOT` points at the same iCloud path. Costs: a Mac running 24/7. |
| **Linux host, vault moved to Syncthing or git** | The vault is *already a git repo with `.gitleaks.toml`* — this is cheaper than it sounds. §8.1's integration is filesystem-only and does not care what syncs the directory. |
| **Split: ingest on Linux, vault-sync on the Mac** | Two hosts, two deploys, and `WF_DB_PATH` becomes a shared or replicated file. The most operationally complex option. |

**Do not pick one silently.** Task 1 is blocked on the owner's answer; everything else can proceed.

## What is already true — verify, do not rebuild

Measured 2026-08-16, before planning:

- **`.gitattributes` already enforces LF** (`* text=auto eol=lf`).
- **`npm run check:portability` already exists and passes on 446 files**, and already forbids macOS-only binaries (`pbcopy`, `pbpaste`, `osascript`, `mdfind`, `diskutil`) and absolute paths.
- **`localeCompare` is gone from `src/score/rank.ts`** — codepoint order, with the host-ICU reasoning in a comment.
- **The `.nvmrc` and `engines` pin Node 26.**

**Two §12 claims are false about this codebase, and the difference matters:**

1. **§12 says `better-sqlite3` is a native module that "compiles per platform" and that `node_modules` does not move.** This project uses **`node:sqlite`**, which ships *inside* Node — there is no native module to rebuild, and the migration story is simpler than §12 assumes. `npm ci` on the target is still right; the reason is different. **Do not add `better-sqlite3` to satisfy a doc.**
2. **§12 asks for "a lint rule or a CI check that enforces case-exact imports and filenames." That check does not exist.** `check-portability.mjs` covers absolute paths and macOS binaries, not import casing. macOS is case-insensitive, so `./Item` resolving `item.ts` works here and breaks on Linux — this is the single most likely way the rehearsal fails. **It is Task 2 and it must run before the rehearsal, not after.**

## Global Constraints

- **Never delete anything.** The retention/archive job is the one place this rule meets its hardest case — see Task 3.
- **Zero absolute paths** in the tree. Every path via `WF_DB_PATH`, `WF_VAULT_ROOT`, `WF_DATA_DIR`, `WF_LOG_DIR`. Note `WF_VAULT_ROOT` is the one variable permitted an absolute value, and it lives only in the gitignored `.env`.
- **`TZ` explicit, never the system zone.** Every schedule derives from `WF_TZ`.
- **Secrets in `.env` only.** No Keychain, no platform credential store.
- No mocks; real temp dirs and real temp-file SQLite. Explicit `.ts` extensions. Node 26.
- `data/wf.db` is the live corpus — **10 migrations, 11,016 items, 12,232 entity rows.** Never write to it, never migrate it; `VACUUM INTO` a copy. Note `-readonly` fails while its WAL is hot.
- **Commit atomically: `git commit -F - -- <paths>` in one invocation.**
- **This project has shipped seven components with no caller.** Every task ships its wiring and proves it runs.

---

## Tasks

### Wave 1 — the things the rehearsal depends on (parallel)

**Task 1 — The host decision, and what it implies.** BLOCKED on the owner. Once answered, record it in `CLAUDE.md` and resolve the vault's portability debt entry. If Linux: verify §8.1's integration against a non-iCloud directory and say what changes.

**Task 2 — Case-exact import and filename check.** §12 asks for it, it does not exist, and it is the most likely cause of a failed rehearsal. Add it to `check:portability`. **Prove it bites**: introduce an import whose casing differs from the file on disk and watch it fail — on macOS, where the import still resolves.

**Task 3 — Retention/archive job.** §11's note governs what may be dropped and what `raw_json` must keep. This is where "never delete anything" is hardest: retention *is* deletion by another name. Read `CLAUDE.md`'s standing rule and `db/migrations/`'s append-only triggers before designing. An archive that moves rows to a cold table is not the same as one that removes them — decide, and defend it against the rule.

**Task 4 — Backup script.** The deliverable names **one backup file**. `VACUUM INTO` is the mechanism this project already uses and it produces a consistent single file from a live database. Verify a restore *actually works* — a backup nobody restored is a hypothesis too.

### Wave 2 — packaging (needs Wave 1's answer for the vault)

**Task 5 — Dockerfile + compose.** §12: ship these "regardless". Node 26, `npm ci`, no absolute paths, `.env` injected not baked. Note the six entrypoints (`api`, `scheduler`, `vault`, `mcp`, `migrate`, `watchfloor`) and decide which the image runs.

**Task 6 — Process supervision.** §12: "Write **both** a launchd plist and a systemd unit, or containerize and sidestep the question." If Task 5 containerizes, argue whether both are still wanted. `npm run migrate` must run before the scheduler starts, every deploy.

**Task 7 — Tailscale-only bind, documented.** The API binds 127.0.0.1 today. Write down what actually reaches it and how.

### Wave 3 — the client

**Task 8 — PWA manifest + service worker for offline read.** Note the standing portability debt: **the frontend is served by `vite preview`, which Vite documents as not a production server**, accepted for a single-user Tailscale-only deployment and **still awaiting the owner's explicit sign-off**. A service worker changes that calculus — say how.

### Wave 4 — the deliverable

**Task 9 — The migration runbook (§12) and README.** The runbook must include the step `CLAUDE.md` has been carrying since M3: **`npm run migrate` after every pull or fresh clone, and before `npm run dev` or restarting the scheduler.** `docs/brief.md` is absent from this machine, so §12 cannot be edited in place — the runbook lives in `docs/`.

**Task 10 — THE REHEARSAL.** Stand the system up from a clean checkout plus one backup file, following the runbook literally, and **fix the runbook where it was wrong.** This is the acceptance.

## M6 Acceptance

- A clean checkout plus one backup file comes up working on a different machine.
- **The runbook was actually followed, once, and its gaps fixed.**
- `npm run check:portability` catches a case-mismatched import.
- Retention runs without violating the never-delete rule.
- A backup was restored, not just taken.

**Not in M6:** the map/globe (M7), native shells (M8), markets (M4b, still blocked on `config/portfolio.yaml`).
