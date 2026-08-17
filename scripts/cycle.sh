#!/bin/sh
# One complete Watchfloor cycle, then exit (M6).
#
# The laptop-shaped alternative to the resident daemon. Measured before
# choosing: the daemon holds ~170 MB resident all day and takes 78-99% of a
# core for ~28 seconds per cycle. A scheduled one-shot costs the same ~28
# seconds and then costs NOTHING -- no resident memory, no wakeups, nothing
# running on battery between scheduled times.
#
# Deliberately the same POSIX sh, same repo-root derivation, and same
# migrate-first discipline as scripts/scheduler-service.sh. The two differ in
# exactly one way -- this one exits -- which is the difference the supervisor
# config expresses, not something either script should be clever about.
#
# ## What a cycle is
#
#   1. migrate   -- every entrypoint refuses to run with pending migrations,
#                   so this is the step that makes a post-`git pull` run work
#                   instead of failing. See scheduler-service.sh for the
#                   incident behind it.
#   2. ingest    -- poll every DUE source, then star snapshots, README
#                   enrichment, entity extraction, clustering and scoring.
#                   Sources not due are skipped, so a run at a quiet hour is
#                   cheap rather than wasteful.
#   3. vault sync-- daily/weekly/entity notes, if configured. A clean no-op
#                   when WF_VAULT_ROOT is unset.
#
# ## Why `set -e` but a tolerated vault failure
#
# A failed migration must stop the run: ingesting against a schema the code
# does not expect is how data gets damaged. But an unwritable vault -- iCloud
# not yet materialised, the disk full -- must NOT discard a successful ingest
# that already happened. The corpus is the thing that cannot be re-fetched;
# the notes are regenerable by definition.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT"

if [ ! -f .env ]; then
  echo "watchfloor: no .env at $REPO_ROOT/.env — copy .env.example and fill it in" >&2
  exit 1
fi

started=$(date +%s)
echo "watchfloor cycle: $(date '+%Y-%m-%d %H:%M:%S')"

npm run --silent migrate
npm run --silent ingest

# `|| true` on the vault alone, for the reason in the header. The command
# prints its own refusal, so a failure here is visible in the log rather than
# swallowed -- it just does not take the run down with it.
npm run --silent watchfloor -- vault sync || echo "watchfloor cycle: vault sync failed; the ingest above still succeeded" >&2

echo "watchfloor cycle: done in $(($(date +%s) - started))s"
