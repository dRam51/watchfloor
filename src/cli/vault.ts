/**
 * The `vault` command group (M5 task 12) — §8.1's three verbs.
 *
 * `sync` is Task 15's entrypoint body, moved here **unchanged in behaviour and
 * in output**, so that `npm run vault` and `watchfloor vault sync` are one
 * implementation under two names rather than two that will drift. Its tests
 * (`tests/vault/bin.test.ts`, written before this file existed) pin the exact
 * strings it prints, which is what made the move safe to do.
 *
 * `verify` and `prune` are the gap Task 9's report named: both modules shipped
 * complete and tested with **no way to run them at all** — occurrence six of
 * the defect M4a diagnosed. Neither is reimplemented here. This file resolves
 * the vault, reads the corpus where a command needs it, calls the one function
 * that already exists, and renders the result.
 *
 * ## Three refusals, and why they differ
 *
 * | state | sync | verify | prune |
 * | --- | --- | --- | --- |
 * | no `WF_VAULT_ROOT` | `0`, a clean no-op | `1` | `1` |
 * | unmounted | `1` | `1` | `1` |
 *
 * Sync is an instruction: with no vault there are no notes to write and
 * nothing has failed — and that is the shipped configuration, so it must be
 * quiet. Verify and prune are questions about a vault, and a question about a
 * thing that is not there has no answer. Answering `0` would assert a clean
 * bill of health, or an empty tidy-up, for a vault nobody looked at.
 */

import { join } from 'node:path';
import { loadEnv } from '../config/env.ts';
import { closeDb, openDb } from '../db/connection.ts';
import { openDatabase } from '../db/openDatabase.ts';
import { assertMigrationsUpToDate } from '../db/migrate.ts';
import { openVaultSession } from '../vault/session.ts';
import { DEFAULT_MAX_DELETIONS_PER_RUN, pruneVault, type PruneResult } from '../vault/prune.ts';
import { readSavedIndex, verifyVault, type VaultFinding, type VaultVerifyReport } from '../vault/verify.ts';
import { loadVaultSyncDeps, resolveVaultTarget, runVaultSync, type VaultTarget } from '../vault/sync.ts';
import { EXIT_CANNOT_RUN, EXIT_OK, pruneExitCode, verifyExitCode } from './exit.ts';

// Resolved relative to this module, not the process cwd -- a process
// supervisor (§12) may launch us from anywhere. Matches every src/bin/*.ts.
const repoRoot = join(import.meta.dirname, '..', '..');

/** Mirrors src/bin/ingest.ts's own formatLocal -- see its comment on why each entrypoint carries its own. */
function formatLocal(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(iso));
}

const NOT_CONFIGURED_SYNC =
  'vault sync is not configured: WF_VAULT_ROOT is unset. Nothing to do. ' +
  '(Set it in .env to the Watchfloor subtree of your Obsidian vault, e.g. ' +
  '<vault>/watchfloor -- never the vault root itself.)';

function notConfigured(command: string): string {
  return (
    `vault ${command} needs a vault and WF_VAULT_ROOT is unset, so nothing was ` +
    `${command === 'verify' ? 'checked' : 'examined'}. This is the shipped configuration; set ` +
    'WF_VAULT_ROOT in .env to the Watchfloor subtree of your Obsidian vault, e.g. ' +
    '<vault>/watchfloor -- never the vault root itself.'
  );
}

function unmountedMessage(command: string, target: Extract<VaultTarget, { status: 'unmounted' }>): string {
  return (
    `vault ${command} refused: the vault is not mounted -- ${target.refusal.detail} ` +
    `(${target.refusal.reason})\n  root: ${target.root}\n  ${target.refusal.remedy}`
  );
}

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

/**
 * §8.1's `daily/`, `weekly/` and `entities/`, written once.
 *
 * This ignores the daemon's cadence deliberately. `src/vault/cadence.ts` exists
 * so a 60-second tick does not rewrite the weekly note 360 times over a Friday
 * evening; it has nothing to say about a human asking for a sync, so all three
 * areas are written whatever day it is. That also makes this the way to produce
 * a weekly note out of band.
 */
export async function runVaultSyncCommand(): Promise<number> {
  const env = loadEnv();

  // Checked BEFORE the database is opened. With no vault configured there is
  // nothing to do at all, and a missing WF_DB_PATH should not be the error a
  // no-op run reports.
  const target = resolveVaultTarget();
  if (target.status === 'not_configured') {
    console.log(NOT_CONFIGURED_SYNC);
    return EXIT_OK;
  }
  if (target.status === 'unmounted') {
    // Loud, because it means the owner expects sync and is not getting it.
    // The refusal carries its own remedy; a refusal with no remedy gets
    // routed around.
    console.error(
      `vault sync refused: ${target.refusal.detail} (${target.refusal.reason})\n` +
        `  root: ${target.root}\n` +
        `  ${target.refusal.remedy}`,
    );
    return EXIT_CANNOT_RUN;
  }

  const db = openDatabase(env.WF_DB_PATH);
  try {
    // Entrypoints no longer auto-apply migrations -- run `npm run migrate`
    // first. See src/db/migrate.ts's doc comment on assertMigrationsUpToDate.
    const { backfilledChecksums } = assertMigrationsUpToDate(db, join(repoRoot, 'db', 'migrations'));
    if (backfilledChecksums.length > 0) {
      console.log(
        `backfilled checksum for previously-applied migration(s) with no recorded checksum: ` +
          `${backfilledChecksums.join(', ')}`,
      );
    }

    const deps = loadVaultSyncDeps({ repoRoot, db, tz: env.WF_TZ });
    console.log(
      `watchfloor vault sync starting (TZ=${env.WF_TZ}, root=${target.root}, ` +
        `model=${deps.weekly.enrichment.backend.name}/${deps.weekly.enrichment.backend.model})`,
    );

    const now = new Date().toISOString();
    const session = openVaultSession(target.root);
    const report = await runVaultSync(session, deps, { now });

    console.log(`  daily:  ${report.daily === null ? 'not written' : `${report.daily.relPath} (${report.daily.created ? 'created' : 'updated'}, ${report.daily.bytes} bytes)`}`);
    if (report.weekly !== null) {
      const b = report.weekly.blurbs;
      console.log(
        `  weekly: ${report.weekly.relPath} (${report.weekly.write.created ? 'created' : 'updated'}) -- ` +
          `${report.weekly.entries.length} entr(ies), blurbs: ${b.generated} generated, ${b.fromCache} cached, ` +
          `${b.rejected} rejected, ${b.unavailable} unavailable, ${b.refused} refused`,
      );
    } else {
      console.log('  weekly: not written');
    }
    if (report.entities !== null) {
      console.log(
        `  entities: ${report.entities.written.length} written, ${report.entities.skipped.length} skipped` +
          (report.entities.stopped !== null ? ` -- STOPPED EARLY (${report.entities.stopped})` : ''),
      );
    }

    // Per-area refusals printed explicitly rather than left in a return value
    // nobody sees -- the same reason src/bin/ingest.ts prints a dead feed.
    for (const refusal of report.refusals) {
      console.log(`  ! ${refusal.area} refused: ${refusal.detail}`);
    }

    console.log(
      `vault sync finished at ${formatLocal(now, env.WF_TZ)} -- ` +
        `${report.filesWritten} file(s) written under ${target.root}`,
    );

    // A refusal is a failure of the thing the operator asked for, so it is
    // reported in the exit code as well as in the log.
    return report.refusals.length > 0 ? EXIT_CANNOT_RUN : EXIT_OK;
  } finally {
    closeDb(db);
  }
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

function renderFindings(findings: readonly VaultFinding[]): string[] {
  return [...findings]
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
        ((a.relPath ?? '') < (b.relPath ?? '') ? -1 : 1),
    )
    .map(
      (finding) =>
        `  ${finding.severity.padEnd(7, ' ')} ${finding.code.padEnd(23, ' ')} ` +
        `${finding.relPath ?? '(the tree)'}\n            ${finding.detail}`,
    );
}

function renderVerifyReport(report: VaultVerifyReport): string {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const finding of report.findings) counts[finding.severity] += 1;
  const notes = report.notesByArea;

  return [
    `vault verify: ${report.root}`,
    `  scanned ${report.filesScanned} file(s) -- daily ${notes.daily}, weekly ${notes.weekly}, ` +
      `entities ${notes.entities}, saved ${notes.saved} note(s)`,
    `  ${report.findings.length} findings: ${counts.error} error, ${counts.warning} warning, ` +
      `${counts.info} info`,
    ...(report.findings.length > 0 ? ['', ...renderFindings(report.findings)] : []),
    '',
    // Said out loud, every run: `info` is not a lesser problem, and a reader
    // who thinks it is will read a healthy vault as a broken one.
    '  info means "this is what a healthy vault looks like" -- your own notes, an entity note we',
    '  appended a block to, the second directory entry every saved/ note carries. Only warnings',
    '  and errors change the exit code. verify reports and never repairs.',
    '',
  ].join('\n');
}

/**
 * Reads the vault, reports, and writes nothing.
 *
 * The corpus is opened **read-only**, following `src/bin/suggest.ts`: a
 * mechanical guarantee rather than a convention that this command cannot write
 * to the real database whatever a future edit here does. Two of verify's
 * twenty findings need it — the `saved/` key-collision check and the
 * saved-note-missing check — and they are not optional in this caller. A
 * verify that quietly skipped them would report a clean vault while saying
 * nothing about the population it was asked about, which is the exact
 * absence-read-as-emptiness failure the exit codes exist to prevent.
 */
export function runVaultVerifyCommand(options: { readonly json: boolean }): number {
  const env = loadEnv();
  const target = resolveVaultTarget();
  if (target.status === 'not_configured') {
    console.error(notConfigured('verify'));
    return EXIT_CANNOT_RUN;
  }

  const db = openDb(env.WF_DB_PATH, { readOnly: true });
  let savedIndex;
  try {
    savedIndex = readSavedIndex(db);
  } catch (err) {
    throw new Error(
      `vault verify could not read the corpus at ${env.WF_DB_PATH}: ${(err as Error).message}. ` +
        'Two of its checks are questions about saved items, and skipping them silently would ' +
        'report a clean vault while having looked at nothing. Run `npm run migrate` if the ' +
        'database is new.',
    );
  } finally {
    closeDb(db);
  }

  const report = verifyVault({ root: target.root, tz: env.WF_TZ, savedIndex });
  const code = verifyExitCode(report);

  if (options.json) {
    // A machine consumer gets the structure whatever the outcome: `mounted:
    // false` is data, and an empty stdout would be the same silence a human
    // reader is protected from above.
    console.log(JSON.stringify(report, null, 2));
    return code;
  }
  if (!report.mounted) {
    // Nothing was scanned, so there is no report to print. The finding
    // carries the reason and the remedy.
    console.error(`vault verify could not scan ${report.root}:`);
    for (const finding of report.findings) console.error(`  ${finding.detail}`);
    return code;
  }
  process.stdout.write(renderVerifyReport(report));
  return code;
}

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------

function renderPruneResult(result: PruneResult, apply: boolean): string {
  const lines = [`vault prune: ${result.root}`];

  if (result.candidates.length === 0) {
    lines.push('  nothing to remove.');
  } else {
    lines.push(`  ${result.candidates.length} candidate(s):`);
    for (const candidate of result.candidates) {
      lines.push(`    ${candidate.reason.padEnd(19, ' ')} ${candidate.relPath} (${candidate.bytes} bytes)`);
      lines.push(`      ${candidate.detail}`);
    }
  }

  for (const skip of result.skipped) {
    lines.push(`  skipped ${skip.relPath} (${skip.reason})`);
    lines.push(`      ${skip.detail}`);
  }

  if (apply) {
    lines.push('', `  removed ${result.removed.length} file(s).`);
  } else if (result.candidates.length > 0) {
    lines.push(
      '',
      '  dry run: nothing has been deleted. To remove exactly these files, pass the count back:',
      '',
      `      watchfloor vault prune --apply --expect=${result.candidates.length}`,
      '',
      '  If the tree changes before you run that, the counts disagree and nothing is removed.',
    );
  } else {
    lines.push('', '  dry run: nothing has been deleted, and there was nothing to delete.');
  }

  return `${lines.join('\n')}\n`;
}

/**
 * The one command in this project permitted to delete anything.
 *
 * ## Why the destructive path takes two commands
 *
 * `--apply` alone would be a flag an operator acquires the habit of typing.
 * `--apply --expect=N` cannot be typed without having read a dry run, because
 * **N is not knowable any other way** — and the check is not ceremony: the
 * count is a claim about a tree the operator has actually seen, so if anything
 * changed in between, the claim is stale and the run is refused whole.
 *
 * Everything underneath is Task 9's, unmodified: dry run is the default in
 * `pruneVault` too, `removeVaultFile` re-checks the area gate, containment and
 * ownership at the moment of each delete, and `assertRemovable` throws before
 * any removal if a `saved/` or `entities/` note is ever proposed.
 *
 * ## No manifest, deliberately
 *
 * `pruneVault` can also remove a stale fully-managed note, but only against a
 * caller-supplied manifest of what the current sync writes. **This CLI supplies
 * none**, so `daily/` and `weekly/` notes are never proposed. The reason is not
 * caution for its own sake: the only manifest derivable today is "the day and
 * week we are in", which marks every older daily note as stale and would delete
 * the entire accumulated archive. A real manifest is a retention policy, that
 * is M6, and it does not exist yet.
 */
export function runVaultPruneCommand(options: {
  readonly json: boolean;
  readonly apply: boolean;
  readonly expect: number | null;
}): number {
  const target = resolveVaultTarget();
  if (target.status === 'not_configured') {
    console.error(notConfigured('prune'));
    return EXIT_CANNOT_RUN;
  }
  if (target.status === 'unmounted') {
    // Refused here rather than left to pruneVault's silent empty result: a
    // shadow tree looks exactly like a real vault that has lost its contents,
    // and "nothing to remove" would be the wrong reading of both.
    console.error(unmountedMessage('prune', target));
    return EXIT_CANNOT_RUN;
  }

  // ALWAYS a dry run first, even when --apply was given: the count the
  // operator is asserting is checked against a decision made now, not against
  // the one they read before lunch.
  const proposed = pruneVault({ root: target.root });

  if (proposed.refused === 'deletion_cap') {
    console.error(
      `vault prune refused the whole run: ${proposed.candidates.length} candidates is a bug ` +
        'rather than a tidy-up.\n  Deleting the first N and stopping would leave an arbitrary ' +
        'subset behind and look like it worked.\n  Run `watchfloor vault verify` and look at ' +
        'what is in there.',
    );
    return pruneExitCode(proposed);
  }

  if (options.expect !== null && options.expect !== proposed.candidates.length) {
    console.error(
      `vault prune refused: --expect=${options.expect} but this run proposes ` +
        `${proposed.candidates.length} file(s). Nothing has been deleted.\n` +
        '  The count is a claim about a tree you have seen. It disagreeing means the vault ' +
        'changed since your dry run,\n  which is exactly when a delete should stop. Run ' +
        '`watchfloor vault prune` again and read the new count.',
    );
    return EXIT_CANNOT_RUN;
  }

  if (!options.apply) {
    if (options.json) {
      console.log(JSON.stringify(proposed, null, 2));
      return pruneExitCode(proposed);
    }
    process.stdout.write(renderPruneResult(proposed, false));
    return pruneExitCode(proposed);
  }

  // The applied run rescans, so the count is re-derived rather than trusted
  // across the gap. Task 9's own cap is what closes that gap: capping the run
  // at the number just agreed means a tree that gained a candidate in between
  // refuses the WHOLE run instead of deleting one more file than the operator
  // authorised. `Math.min` keeps the 50-file ceiling a ceiling.
  const cap = Math.min(options.expect ?? 0, DEFAULT_MAX_DELETIONS_PER_RUN);
  const result = pruneVault({ root: target.root, apply: true, maxDeletionsPerRun: cap });

  if (result.refused === 'deletion_cap') {
    console.error(
      `vault prune refused: the vault gained a candidate between the check and the delete ` +
        `(${result.candidates.length} now, ${options.expect} authorised). Nothing has been ` +
        'deleted.\n  Run `watchfloor vault prune` again and read the new count.',
    );
    return EXIT_CANNOT_RUN;
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return pruneExitCode(result);
  }
  process.stdout.write(renderPruneResult(result, true));
  return pruneExitCode(result);
}
