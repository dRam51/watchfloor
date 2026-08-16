#!/bin/sh
# Watchfloor scheduler, as a supervised service (M6).
#
# One wrapper, deliberately, for both launchd today and systemd on whatever
# Linux box eventually replaces this laptop. §12: "Keep everything the app needs
# to run in npm scripts, and treat launchd/systemd as a thin wrapper generated
# at deploy time." This is that wrapper; scripts/generate-service.mjs emits the
# supervisor's own config around it.
#
# POSIX sh, not bash: /bin/sh exists everywhere and bash is not guaranteed on a
# minimal Linux image. Nothing here shells out to a macOS-only binary (§12's
# rule, enforced by npm run check:portability).
#
# ## Why migrate runs here rather than being someone's job to remember
#
# CLAUDE.md, since M3: "npm run migrate is the ONLY thing that applies
# migrations. api, ingest, score, rank, and scheduler all refuse to start with
# pending migrations." That refusal is correct and it is also a restart loop
# under a supervisor: launchd sees exit 1, waits, starts it again, forever,
# while the dashboard quietly goes stale.
#
# So the deploy step and the start step are one thing. A supervisor restart
# after a `git pull` that brought a migration self-heals instead of
# flat-lining. This is the step §12's runbook has been missing since M3.
#
# ## Failure behaviour
#
# `set -e` so a failed migration stops here rather than starting a scheduler
# against a schema the code does not expect. The supervisor will retry, and the
# error is in the log with the migration named -- which is a loud failure an
# operator can act on, not a silent wrong answer.
set -eu

# The repo root is derived from this script's own location, never hardcoded and
# never assumed to be the working directory: a supervisor may launch from
# anywhere, which is the same reason every src/bin/*.ts resolves paths from
# import.meta.dirname rather than process.cwd().
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT"

if [ ! -f .env ]; then
  echo "watchfloor: no .env at $REPO_ROOT/.env — copy .env.example and fill it in" >&2
  exit 1
fi

echo "watchfloor service: applying any pending migrations"
npm run --silent migrate

echo "watchfloor service: starting scheduler"
# exec so the supervisor watches the scheduler itself rather than this shell --
# otherwise SIGTERM stops the wrapper and orphans the node process, and the
# scheduler's own SIGTERM handler (which closes the database cleanly) never runs.
exec npm run --silent scheduler
