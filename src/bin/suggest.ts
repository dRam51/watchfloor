/**
 * The interest-profile proposal CLI ("we need to find a way to find stories
 * that are interesting specifically for me"). Reads item_state and
 * interest_dismissal_signals from WF_DB_PATH and proposes candidate
 * boost/suppress terms with their evidence -- it never applies them. See
 * src/interests/propose.ts's module doc comment for the statistics and
 * thresholds, and CLAUDE.md / §7: "Dismissal feeds the interest profile as
 * a negative signal (log it; don't auto-tune the weights)."
 *
 * Deliberately opens WF_DB_PATH READ-ONLY (`openDb(path, { readOnly: true
 * })`), not via src/db/openDatabase.ts's normal writable path -- a
 * mechanical guarantee, not just a convention, that this command cannot
 * write to the real corpus no matter what a future edit here does. It also
 * does not call assertMigrationsUpToDate: this is a read-only advisory
 * report over tables (item_state, interest_dismissal_signals, items) that
 * have existed since migrations 0001/0004, so it does not need or want to
 * participate in migration-on-boot bookkeeping.
 *
 * Accepting a proposal is a manual copy-paste into config/interests.yaml --
 * that file stays hand-maintained and version-controlled. Nothing in this
 * command, or the module it calls, writes to it.
 *
 *   npm run suggest             -- human-readable report
 *   npm run suggest -- --json   -- machine-readable report
 */

import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { loadEnv } from '../config/env.ts';
import { openDb, closeDb } from '../db/connection.ts';
import { loadInterestsFile } from '../interests/load.ts';
import { proposeInterestTerms, formatProposalReport } from '../interests/propose.ts';

const repoRoot = join(import.meta.dirname, '..', '..');

try {
  const { values } = parseArgs({ options: { json: { type: 'boolean', default: false } } });

  const env = loadEnv();
  const profile = loadInterestsFile(join(repoRoot, 'config', 'interests.yaml'));

  const db = openDb(env.WF_DB_PATH, { readOnly: true });
  try {
    const now = new Date().toISOString();
    const report = proposeInterestTerms(db, profile, now);

    if (values.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatProposalReport(report));
    }
  } finally {
    closeDb(db);
  }
  process.exit(0);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
