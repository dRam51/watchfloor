/**
 * The ranking CLI (M2 Task 9) -- the interface that answers the M2
 * acceptance question: "query the top items per beat and judge whether they
 * are the ones a human would have picked." Read-only: never writes to the
 * database (src/score/rank.ts, this task's own module, does the composing;
 * this file is wiring plus a plain-text table printer). Decay is applied
 * here, at display time, from THIS process's own `now` -- the one legitimate
 * place decay enters this task (see src/score/rank.ts's module doc comment).
 *
 * Both scores are always printed as separate columns -- never blended into
 * one number (§5.1, CLAUDE.md). No sentiment, directional label, price
 * target, or position size appears anywhere in this file's output, for any
 * beat, including markets.
 *
 *   npm run rank                       -- top 10 per beat, sorted by signal
 *   npm run rank -- --beat=usnews       -- one beat only
 *   npm run rank -- --top=20            -- more rows
 *   npm run rank -- --sort=read         -- sort by read_score instead
 */

import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { loadEnv } from '../config/env.ts';
import { openDatabase } from '../db/openDatabase.ts';
import { runMigrations } from '../db/migrate.ts';
import { closeDb } from '../db/connection.ts';
import { BEATS, type Beat } from '../domain/item.ts';
import { rankBeat, loadRankDepsFromConfigFiles, type BeatRanking, type SortProfile } from '../score/rank.ts';

const repoRoot = join(import.meta.dirname, '..', '..');

/** Mirrors src/bin/scheduler.ts's own formatLocal -- see src/bin/ingest.ts's identical comment for why this is duplicated rather than shared. */
function formatLocal(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(iso));
}

function isBeat(value: string): value is Beat {
  return (BEATS as readonly string[]).includes(value);
}
function isSortProfile(value: string): value is SortProfile {
  return value === 'signal' || value === 'read';
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function printBeat(ranking: BeatRanking, top: number, profile: SortProfile): void {
  console.log(`\n=== ${ranking.beat} -- sorted by ${profile} (${ranking.scoredCount}/${ranking.candidateCount} scored) ===`);
  if (ranking.candidateCount === 0) {
    console.log('  (no items in this beat yet)');
    return;
  }
  if (ranking.scoredCount === 0) {
    console.log(`  ${ranking.candidateCount} item(s), none scored yet -- run \`npm run score\` first`);
    return;
  }

  const shown = ranking.items.slice(0, top);
  console.log(`   #   signal    read  clus  override              source            title`);
  shown.forEach((item, i) => {
    const overrideLabel = item.signalOverride.pinned
      ? item.signalOverride.matches[0]!.id
      : item.readOverride.pinned
        ? `${item.readOverride.matches[0]!.id} (read)`
        : '—';
    console.log(
      `  ${String(i + 1).padStart(2)}  ${item.signalScore.toFixed(3).padStart(7)}  ${item.readScore.toFixed(3).padStart(6)}  ` +
        `${String(item.clusterSize).padStart(4)}  ${truncate(overrideLabel, 20).padEnd(21)} ${truncate(item.sourceId, 16).padEnd(17)} ${truncate(item.title, 72)}`,
    );
  });
  if (ranking.scoredCount > shown.length) {
    console.log(`  ... ${ranking.scoredCount - shown.length} more scored item(s) not shown (--top=${top})`);
  }
}

try {
  const { values } = parseArgs({
    options: {
      beat: { type: 'string' },
      top: { type: 'string', default: '10' },
      sort: { type: 'string', default: 'signal' },
    },
  });

  const top = Number.parseInt(values.top ?? '10', 10);
  if (!Number.isFinite(top) || top <= 0) throw new Error(`--top must be a positive integer, got "${values.top}"`);

  const sort = values.sort ?? 'signal';
  if (!isSortProfile(sort)) throw new Error(`--sort must be "signal" or "read", got "${sort}"`);

  let beats: Beat[];
  if (values.beat !== undefined) {
    if (!isBeat(values.beat)) throw new Error(`--beat must be one of ${BEATS.join(', ')}, got "${values.beat}"`);
    beats = [values.beat];
  } else {
    beats = [...BEATS];
  }

  const env = loadEnv();
  const db = openDatabase(env.WF_DB_PATH);
  try {
    runMigrations(db, join(repoRoot, 'db', 'migrations'));
    const deps = loadRankDepsFromConfigFiles(join(repoRoot, 'config', 'decay.yaml'), join(repoRoot, 'config', 'overrides.yaml'));

    const now = new Date().toISOString();
    console.log(`watchfloor ranking as of ${formatLocal(now, env.WF_TZ)} (sort=${sort}, top=${top})`);

    for (const beat of beats) {
      printBeat(rankBeat(db, beat, now, deps, sort), top, sort);
    }
  } finally {
    closeDb(db);
  }
  process.exit(0);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
