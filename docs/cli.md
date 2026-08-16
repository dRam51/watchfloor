# The `watchfloor` CLI

M5 task 12. §8.1 names two commands explicitly — `watchfloor vault verify` and
`watchfloor vault prune` — and M5's scope line says "CLI" without enumerating the rest. This
file records what the rest turned out to be, and why.

    npm run watchfloor -- --help
    npm run watchfloor -- vault verify
    npm run watchfloor -- vault prune

The `--` is npm's; everything after it belongs to the CLI.

## The surface

| command | where it runs |
| --- | --- |
| `vault sync` | in this process |
| `vault verify` | in this process |
| `vault prune` | in this process |
| `migrate`, `ingest`, `score`, `rank`, `suggest`, `api`, `scheduler` | **spawned** — the same file the matching `npm run` script runs |

**The delegated list is discovered from `src/bin/`, not written down.** A hand-maintained
command table is this project's characteristic defect in miniature: it compiles, it is tested,
and it silently stops describing reality the day someone adds an entrypoint — which is exactly
how M4a's `github_search` adapter came to be unreachable. `src/bin/*.ts` is already the complete
set of ways this system can be started, so the CLI reads that directory. A new entrypoint is
runnable through the CLI the day it lands, with no edit here.

Descriptions are still hand-written (`src/cli/help.ts`), because "what does `score` do" cannot
be derived from a filename. An entrypoint with no description is **listed anyway**, with a
blank — omitting it would make `--help` lie about what can be run. `tests/cli/help.test.ts`
holds the description list to completeness separately, so a new entrypoint reads as
*describe me*, never as *you cannot run this*.

### Delegation, not duplication

`watchfloor ingest` spawns exactly the file `npm run ingest` spawns, and **every flag after a
command name is the child's to parse**. `score --force` and `suggest --json` already mean
something in `src/bin/`; re-declaring them here would be a second copy of an interface this
layer does not own, and it would drift the first time either side changed.

Signals (`SIGINT`, `SIGTERM`, `SIGHUP`) are forwarded to the child, so `watchfloor scheduler`
is interruptible and a supervisor's `SIGTERM` reaches the daemon rather than orphaning it.
**A supervisor should still point at `src/bin/scheduler.ts` directly** (§12): this wrapper is a
convenience for a human at a terminal, and every layer between a supervisor and its process is
a layer that can fail on its own.

### What was excluded

- **A `bin` field in `package.json`.** `watchfloor` as a globally-linked command would run
  without `--env-file=.env`, so every invocation would fail on `WF_DB_PATH`. The npm script is
  the honest invocation.
- **`--version`.** `package.json` says `0.0.0` and nothing bumps it; a version flag that always
  reports the same string is noise.
- **An arg-parsing dependency.** Node 26 has `util.parseArgs`, and `src/bin/suggest.ts` already
  uses it. The whole surface is six flags.
- **A `--fix` for verify.** Refused explicitly, with a message, rather than silently ignored.

## Exit codes — a contract

| code | meaning |
| --- | --- |
| `0` | the command ran and the answer is good |
| `1` | the command **could not run**, or the run was refused |
| `2` | the command ran and **found something you must look at** |

`1` and `2` are separate for the same reason `/api/sources` reports `everPolled: false` rather
than an empty array: **absence is not emptiness.** A `vault verify` that has been failing to
start for three weeks because `WF_VAULT_ROOT` is wrong must not be indistinguishable from a
vault with one stale temp file in it — and an unattended check that only looks at "nonzero"
makes them the same event.

Two consequences that look like inconsistencies until you name the question each command asks:

- **An unmounted vault is `1`, not `2`**, even though `verifyVault` reports it as an `error`
  finding. Nothing was scanned. "No other problems found" in a tree nobody looked at is the
  false negative the whole contract exists to prevent.
- **`vault sync` with no vault configured is `0`; `vault verify` with no vault configured is
  `1`.** Sync is an instruction — there are no notes to write, nothing failed, and that is the
  shipped configuration. Verify is a question — there is no vault, so there is no answer, and
  `0` would assert a clean bill of health for something that does not exist. Sync's code is
  Task 15's shipped contract and is deliberately unchanged.

A delegated command's exit code is **the child's, verbatim**; a child killed by a signal
answers `128 + n`.

## `vault verify`

Reports §8.1's invariants across twenty finding codes. **It never repairs**, there is no
`--fix`, and `src/vault/verify.ts` has no repair path to expose.

`--json` prints the whole report, including `mounted: false`.

`info` is not a lesser problem — it means *"this is what a healthy vault looks like and you
should be able to see it"*: the owner's hand-authored notes, an entity note we appended a block
to, the permanent second directory entry every `saved/` note carries, an `entities/` that is
empty because no entity extractor exists yet. Only warnings and errors change the exit code.

The corpus is opened **read-only** (following `src/bin/suggest.ts`) — a mechanical guarantee,
not a convention, that this command cannot write to the real database. Two of the twenty
findings are questions about saved items, and they are **not optional here**: a verify that
silently skipped them would report a clean vault having looked at nothing, which is the exact
failure the exit codes exist to prevent. If the corpus cannot be read, verify exits `1` and
says so.

## `vault prune` — the one command permitted to delete

**A dry run is the default, and the only default.**

    watchfloor vault prune                      # look. prints N candidates
    watchfloor vault prune --apply --expect=N   # delete exactly those N

### Why the flags are shaped this way

`--apply` on its own is refused. A flag that is sufficient by itself is a flag an operator
acquires the habit of typing, and this runs against `CLAUDE.md`'s first standing rule — *never
delete anything*.

`--expect=N` **cannot be typed without having read a dry run**, because N is not knowable any
other way. And it is not ceremony: the count is a claim about a tree the operator has actually
seen, so if anything changed in between, the claim is stale and the run is refused whole. The
applied run rescans and is capped at the number just agreed (`maxDeletionsPerRun`), so a vault
that *gained* a candidate in the gap refuses the entire run rather than deleting one more file
than was authorised.

`--help` is answered before anything else is validated: `vault prune --apply --expect=3 --help`
prints help and prunes nothing.

Everything underneath is Task 9's, unmodified — `removeVaultFile` re-checks the area gate,
containment after symlink resolution, and ownership at the moment of every delete, and
`assertRemovable` throws before any removal if a `saved/` or `entities/` note is ever proposed.

### No manifest, deliberately

`pruneVault` can also remove a stale fully-managed note, but only against a caller-supplied
manifest of what the current sync writes. **This CLI supplies none**, so `daily/` and `weekly/`
notes are never proposed.

That is not caution for its own sake. The only manifest derivable today is *"the day and the
week we are in"* — and passing that would mark **every older daily note as stale and delete the
entire accumulated archive**, which is the opposite of what the vault is for. A real manifest
is a retention policy; retention is M6; it does not exist yet. Until it does, the third prune
class stays unreachable from the CLI on purpose, and that is recorded here rather than left as
a gap somebody closes by guessing.

## `npm run vault` still means sync

`npm run vault` with no arguments is `vault sync`, exactly as it has been since Task 15 — the
§12 runbook says so, and a script whose meaning changes under an operator is worse than one
that is slightly inconsistent with its sibling. `npm run vault -- verify` and
`npm run vault -- prune` now work too, so the old entrypoint is no longer the sync-only dead
end Task 9 flagged. `watchfloor vault`, which has no history to keep, prints the group's help.
