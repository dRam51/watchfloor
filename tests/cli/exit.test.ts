import { describe, expect, it } from 'vitest';
import { EXIT_CANNOT_RUN, EXIT_FOUND, EXIT_OK, pruneExitCode, verifyExitCode } from '../../src/cli/exit.ts';
import type { VaultFinding, VaultVerifyReport } from '../../src/vault/verify.ts';
import type { PruneResult } from '../../src/vault/prune.ts';

/**
 * The exit-code contract (M5 task 12).
 *
 * The distinction this file exists for is the one `/api/sources` already makes
 * between `everPolled: false` and an empty array: **a check that ran and found
 * violations is not the same event as a check that could not run.** Collapsing
 * them into "nonzero" is how a cron job that has been failing to start for
 * three weeks looks exactly like a vault with a stale temp file in it.
 */

function report(findings: readonly VaultFinding[], mounted = true): VaultVerifyReport {
  return {
    root: 'vault/watchfloor',
    mounted,
    rootExists: mounted,
    filesScanned: findings.length,
    notesByArea: { daily: 0, weekly: 0, entities: 0, saved: 0 },
    findings,
  };
}

const HAND_AUTHORED: VaultFinding = {
  code: 'hand_authored',
  severity: 'info',
  relPath: 'Architecture.md',
  detail: "the owner's",
};

describe('vault verify', () => {
  it('is 0 for a vault with no findings at all', () => {
    expect(verifyExitCode(report([]))).toBe(EXIT_OK);
  });

  it('is 0 when every finding is info', () => {
    // THE load-bearing case. `info` in src/vault/verify.ts means "this is what
    // a healthy vault looks like and you should see it" — the owner's twelve
    // hand-authored notes, an appended entity block, every saved/ temp link.
    // A verify that exited nonzero on those would be a verify nobody runs.
    expect(verifyExitCode(report([HAND_AUTHORED, { ...HAND_AUTHORED, code: 'entities_empty' }]))).toBe(
      EXIT_OK,
    );
  });

  it('is 2 when a warning is present', () => {
    expect(
      verifyExitCode(
        report([HAND_AUTHORED, { ...HAND_AUTHORED, code: 'temp_leftover', severity: 'warning' }]),
      ),
    ).toBe(EXIT_FOUND);
  });

  it('is 2 when an error is present', () => {
    expect(
      verifyExitCode(report([{ ...HAND_AUTHORED, code: 'wrong_tier', severity: 'error' }])),
    ).toBe(EXIT_FOUND);
  });

  it('is 1 — not 2 — when the vault is unmounted, because nothing was scanned', () => {
    // `unmounted` is an `error` finding, and it is the one error that must not
    // read as "the vault has a problem": the scan did not happen. Reporting it
    // as a finding would say zero problems were found in a tree nobody looked
    // at.
    expect(
      verifyExitCode(report([{ ...HAND_AUTHORED, code: 'unmounted', severity: 'error' }], false)),
    ).toBe(EXIT_CANNOT_RUN);
  });
});

function pruneResult(over: Partial<PruneResult>): PruneResult {
  return {
    root: 'vault/watchfloor',
    mounted: true,
    applied: false,
    candidates: [],
    removed: [],
    skipped: [],
    refused: null,
    ...over,
  };
}

const CANDIDATE = {
  relPath: 'daily/.watchfloor-tmp-2026-08-15.md.1.0',
  reason: 'temp_leftover' as const,
  bytes: 12,
  detail: 'an interrupted write',
};

describe('vault prune', () => {
  it('is 0 for a dry run with nothing to remove', () => {
    expect(pruneExitCode(pruneResult({}))).toBe(EXIT_OK);
  });

  it('is 2 for a dry run that found something', () => {
    // Not a failure — an answer. It is what makes `prune; if [ $? -eq 2 ]`
    // a usable check, and the count it prints is what --apply then requires.
    expect(pruneExitCode(pruneResult({ candidates: [CANDIDATE] }))).toBe(EXIT_FOUND);
  });

  it('is 0 when an applied run removed everything it proposed', () => {
    expect(
      pruneExitCode(
        pruneResult({ applied: true, candidates: [CANDIDATE], removed: [CANDIDATE.relPath] }),
      ),
    ).toBe(EXIT_OK);
  });

  it('is 2 when an applied run left a candidate behind', () => {
    // The safety layer re-checks every removal at the moment it happens, so a
    // proposed-but-not-removed file means this program's policy layer and its
    // safety layer disagreed. That is a bug to look at, not a clean run.
    expect(pruneExitCode(pruneResult({ applied: true, candidates: [CANDIDATE], removed: [] }))).toBe(
      EXIT_FOUND,
    );
  });

  it('is 1 when the whole run was refused by the deletion cap', () => {
    expect(pruneExitCode(pruneResult({ candidates: [CANDIDATE], refused: 'deletion_cap' }))).toBe(
      EXIT_CANNOT_RUN,
    );
  });

  it('is 1 when the vault is unmounted', () => {
    expect(pruneExitCode(pruneResult({ mounted: false }))).toBe(EXIT_CANNOT_RUN);
  });
});

describe('the three codes are distinct', () => {
  it('never collapses "found something" into "could not run"', () => {
    expect(new Set([EXIT_OK, EXIT_CANNOT_RUN, EXIT_FOUND]).size).toBe(3);
  });
});
