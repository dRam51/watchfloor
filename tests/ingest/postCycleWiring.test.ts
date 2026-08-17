import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * M4a's live run found THREE gaps of one shape, and only one shape:
 * `9b57df9` (the `github_search` adapter was in no registry), `e5a3260` (star
 * snapshots were recorded by nothing) and `2201e7c` (task 6's README enricher
 * was called by nothing). Every unit test passed through all three, because
 * each was a gap BETWEEN correctly-built, fully-tested parts.
 *
 * These are source-text assertions, which is unusual here and deliberate. The
 * thing being asserted is not a behaviour -- it is that a call site EXISTS in
 * a composition root, and a composition root is precisely the code no unit
 * test instantiates. `src/domain/repo.ts`'s test sets the precedent by
 * grepping that module for SQL writes for the same reason: some guarantees are
 * about the text.
 *
 * BOTH bins, never one. `npm run ingest` is what a person runs by hand; the
 * scheduler is what actually runs in production, so wiring only the first
 * makes a hand-run acceptance check look fine while the deployed system does
 * nothing. That asymmetry is exactly how the star-snapshot gap would have
 * survived a partial fix.
 */

const BINS = ['ingest', 'scheduler'] as const;

function binSource(name: string): string {
  return readFileSync(join(process.cwd(), 'src', 'bin', `${name}.ts`), 'utf8');
}

/** Each post-cycle pass, and the module it must be imported from. */
const POST_CYCLE_PASSES: ReadonlyArray<readonly [fn: string, module: string]> = [
  ['recordStarSnapshots', '../ingest/starSnapshots.ts'],
  ['enrichRepoReadmes', '../ingest/repoEnrichment.ts'],
  // M5 task 16. The backfill over 7,267 stored item versions -- occurrence
  // eight of this pattern if it were left unwired, and the first one caught
  // before a live run rather than by it.
  ['sweepEntities', '../entities/sweep.ts'],
  // M7 task 5. `locations` and `item_locations` have been in the schema since
  // 0001_init.sql and held ZERO rows across three milestones, while
  // src/domain/location.ts carried a working, fully-tested `upsertLocation`
  // that nothing called. That is occurrence nine, and unlike the eight before
  // it, it was scaffolded deliberately for a milestone that had not arrived --
  // which is precisely why it could sit there looking intentional.
  //
  // Seeding is listed separately from sweeping because they can fail
  // independently: a sweep with no seed finds nothing (item_locations has a
  // foreign key to locations, so a match cannot even be stored), and a seed
  // with no sweep populates a map with pins and no items behind them. Both
  // failures render as a plausible, quiet, wrong map.
  ['seedLocations', '../locations/seed.ts'],
  ['sweepLocations', '../locations/sweep.ts'],
];

describe('every post-cycle pass is wired into BOTH composition roots', () => {
  for (const bin of BINS) {
    for (const [fn, module] of POST_CYCLE_PASSES) {
      it(`src/bin/${bin}.ts imports and calls ${fn}`, () => {
        const source = binSource(bin);
        expect(source).toContain(`from '${module}'`);
        expect(source).toMatch(new RegExp(`\\b${fn}\\s*\\(`));
      });
    }
  }

  it('gates README enrichment on the repo source being DUE, in both', () => {
    // The scheduler ticks every 60s by default; task 6 sized its per-sweep cap
    // against an hourly poll. Without this gate the sweep runs 60x an hour and
    // holds Core at the reserve floor -- see repoSourceWasDue.
    for (const bin of BINS) {
      expect(binSource(bin)).toMatch(/\brepoSourceWasDue\s*\(/);
    }
  });

  it('hands the entity ruleset to runPollCycle in both, so NEW items get entities too', () => {
    // The sweep alone would eventually cover new items, but only on the next
    // cycle -- an item would exist with no entities for up to a poll interval,
    // and `npm run ingest && npm run score` would score it without them.
    for (const bin of BINS) {
      const source = binSource(bin);
      expect(source).toContain(`from '../entities/rules.ts'`);
      expect(source).toMatch(/loadEntityRulesFile\s*\(/);
      expect(source).toMatch(/runPollCycle\([^)]*\{\s*entityRules\s*\}/s);
    }
  });

  it('registers the github_search adapter in both, since a pass over zero repos does nothing', () => {
    // The first of the three gaps. Kept here rather than in its own file
    // because all three are one failure mode and one list is harder to let rot.
    for (const bin of BINS) {
      expect(binSource(bin)).toMatch(/github_search:\s*githubSearchAdapter/);
    }
  });
});
