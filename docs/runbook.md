# Operations runbook

§12's runbook, kept here because `docs/brief.md` is gitignored and not present on every machine.

Every procedure below has been **run**, not just written. Where something has only been reasoned about, it says so.

---

## The one step people forget

**`npm run migrate` after every `git pull`, and before starting anything.**

Since M3, migrations are applied by exactly one command. `api`, `ingest`, `score`, `rank`, `scheduler`, `suggest`, and `vault sync` all **refuse to boot** with pending migrations rather than applying them silently.

```bash
npm run migrate
```

That refusal closed a real incident: a routine `npm run rank` had applied a colleague's uncommitted `.sql`, and because `schema_migrations` had no checksum, the corrected version was then skipped **forever** — the live database kept an unoptimised trigger with 4.27× insert overhead and nothing reported it. The runner now also checksums every applied migration and fails loudly, naming the file, if one was edited after being applied.

`npm run backup` is the single exception: it does not assert migrations, because a database with pending migrations is exactly the one you want a copy of *before* migrating.

---

## First install

```bash
nvm use            # Node 26, pinned in .nvmrc and engines
npm ci
cp .env.example .env
```

Then edit `.env`. The variables that actually matter:

| Variable | Notes |
| --- | --- |
| `WF_DB_PATH` | relative only, e.g. `./data/wf.db` |
| `WF_TZ` | **explicit, never the system zone.** Every schedule derives from it |
| `WF_API_TOKEN` | ≥8 chars. **Change it from the `.env.example` value** |
| `WF_VAULT_ROOT` | absolute, optional. Unset = vault sync is a clean no-op |
| `WF_GITHUB_TOKEN` | optional. Absent = 60 req/hour **per IP**; present = 5,000 |
| `WF_BACKUP_DIR` | optional, defaults to `./backups` |

```bash
npm run migrate
npm test
npm run check:portability
```

---

## Running it

**On a laptop — a scheduled one-shot (recommended):**

```bash
node scripts/generate-service.mjs launchd-cycle > ~/Library/LaunchAgents/io.dram51.watchfloor.cycle.plist
launchctl load ~/Library/LaunchAgents/io.dram51.watchfloor.cycle.plist
```

Runs a full cycle at 08:00, 13:00 and 19:00 local, then **exits**. Nothing resident between runs, nothing on battery, no wakeups. Measured: **15s per run, 305 MB transient, 0 bytes resident afterwards** — against the daemon's 170 MB held all day.

If the Mac is asleep at a scheduled hour, launchd runs the job **once** shortly after wake rather than queuing every missed occurrence. A laptop shut all weekend does one catch-up cycle, not six.

```bash
launchctl start io.dram51.watchfloor.cycle          # run one now, don't wait
launchctl unload ~/Library/LaunchAgents/io.dram51.watchfloor.cycle.plist   # stop entirely
tail -f logs/cycle.log
```

**On an always-on host — the resident daemon:**

```bash
node scripts/generate-service.mjs launchd > ~/Library/LaunchAgents/io.dram51.watchfloor.scheduler.plist
launchctl load ~/Library/LaunchAgents/io.dram51.watchfloor.scheduler.plist
```

On Linux, `systemd` instead — and note a **user** unit needs `sudo loginctl enable-linger $USER` to run without an active login:

```bash
node scripts/generate-service.mjs systemd > ~/.config/systemd/user/watchfloor.service
systemctl --user daemon-reload && systemctl --user enable --now watchfloor
```

Both run `scripts/scheduler-service.sh`, which applies pending migrations and then **execs** the scheduler — so a restart after a pull that brought a migration self-heals, and `SIGTERM` reaches the scheduler's own handler so the database closes cleanly.

**In the foreground, to watch either one:**

```bash
sh scripts/cycle.sh                # one cycle, then exits
sh scripts/scheduler-service.sh    # the resident daemon
```

**By hand.** `npm run ingest` now clusters and scores as part of a cycle, so it is complete on its own; `npm run score` remains available to rescore without polling.

```bash
npm run ingest
```

**The dashboard** — two processes, API and Vite:

```bash
npm run dev
```

```bash
npm run dev:web
```

Then `http://localhost:5173`. It prompts once for `WF_API_TOKEN` and holds it in memory only.

---

## Backup and restore

**Take one:**

```bash
npm run backup
```

`VACUUM INTO`, not a file copy — the database is in WAL mode, so `cp` on a live database silently loses whatever has not been checkpointed and produces a file that opens cleanly and is missing rows. The backup is then **verified by opening it**: `integrity_check`, plus a row-count comparison of every table against the source. It throws rather than reporting a failed backup.

Nothing is ever rotated or deleted. Old copies accumulate until you remove them yourself.

> **This is on the same disk as the corpus.** It protects against a bad migration, a corrupt write, or an experiment gone wrong — **not** against losing the machine. Migration is one file copy by design, so getting a copy off the machine is trivial and worth doing.

**Restore** — verified, not theoretical:

```bash
cp backups/wf-YYYY-MM-DD-HHMMSS.db data/wf.db
npm run migrate          # in case the backup predates a migration
```

The API boots against a restored file and serves the feed; this was exercised end to end on a 60 MB / 80,927-row backup.

---

## The vault

`WF_VAULT_ROOT` unset is the shipped default and a clean no-op. When set, it must point at a subtree Watchfloor **owns exclusively** — never a directory holding hand-written notes.

```bash
npm run watchfloor -- vault verify    # read-only, reports and never repairs
npm run watchfloor -- vault sync      # write daily/, weekly/, entities/
npm run watchfloor -- vault prune     # dry run by default
```

Exit codes are a contract: `0` ran and is good, `1` could not run, `2` ran and found something. An unmounted vault is `1`, not `2` — nothing was scanned.

`prune` requires `--apply --expect=N`, and N is not knowable without reading a dry run first. It refuses the whole run if the count moved.

---

## Troubleshooting

**"pending migrations; run npm run migrate"** — exactly what it says. Expected after a pull.

**The scheduler restart-loops under launchd.** Read `logs/scheduler.error.log`. Most likely a migration failed, which the wrapper deliberately treats as fatal rather than starting against a schema the code does not expect.

**launchd agent does nothing.** launchd does **not** inherit a login shell's `PATH`; the generated plist sets it explicitly. If you hand-edited the plist, that is the first thing to check.

**Nothing new appears in the dashboard.** Check `/api/sources` for `failing` — which is *enabled AND (an error streak OR stale)*. The second branch is the important one: a feed that last succeeded weeks ago with **zero** errors, because nothing is polling it, is the silent failure a naive check reports as healthy.

**`sqlite3 -readonly` fails on the live database.** It cannot open a WAL database with a hot WAL. Use `VACUUM INTO` to make a copy and open that.

**A source returns real, parseable, useless items.** Check what it sorts by. This has bitten three times — NVD paginating from 1988, HN Algolia returning a 5,426-day-old story, and GitHub repo search where *neither* available sort answers the question. Fetch it and print the dates.

---

## What this repo does not contain

`docs/brief.md` and `config/portfolio.yaml` are gitignored and carry personal financial and employment context. Nothing in the codebase reads either at build or test time, so a clone is unaffected. `.env` likewise.
