import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { recordStarSnapshot } from '../../src/db/repoSnapshots.ts';
import { computeStarVelocity } from '../../src/score/velocity.ts';

const open: Array<ReturnType<typeof openDb>> = [];
function migratedDb() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-test-')), 'wf.db'));
  open.push(db);
  runMigrations(db, join(process.cwd(), 'db', 'migrations'));
  return db;
}

afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

// Every test pins its zone explicitly; nothing here reads process.env.TZ or
// the host clock's zone (CLAUDE.md's portability rule). The .env.example
// default is America/New_York; Tokyo is on the other side of UTC so a
// UTC-only implementation fails rather than accidentally passing.
const NY = 'America/New_York';
const TOKYO = 'Asia/Tokyo';

const AGENTKIT = { repoId: 900001, itemKey: 'a'.repeat(64), fullName: 'acme/agentkit' };

/** Records one reading for AGENTKIT. `at` is a canonical UTC instant. */
function snap(
  db: ReturnType<typeof openDb>,
  stars: number,
  at: string,
  tz: string = NY,
): void {
  recordStarSnapshot(db, { ...AGENTKIT, stars, observedAt: at, tz });
}

// 17:00Z is 13:00 in New York and 02:00 the NEXT day in Tokyo -- a daily poll
// at a fixed instant, which is what a scheduler actually does.
const AT = (day: string) => `${day}T17:00:00.000Z`;
/** An instant whose New York calendar day is 2026-08-14. */
const NOW = '2026-08-14T21:00:00.000Z';

describe('computeStarVelocity, the §4 example', () => {
  it('reports stars gained per day across the window endpoints', () => {
    // §4: "a repo going 40->400 in a week matters more than one sitting at
    // 30k". Seven daily polls, Aug 8 through Aug 14, 40 -> 400 stars. The
    // endpoints are exactly six days apart, so 360 stars / 6 days = 60/day.
    const db = migratedDb();
    snap(db, 40, AT('2026-08-08'));
    snap(db, 400, AT('2026-08-14'));

    const result = computeStarVelocity(db, AGENTKIT.repoId, { now: NOW, tz: NY });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.starsPerDay).toBe(60);
    expect(result.starsGained).toBe(360);
    expect(result.spanDays).toBe(6);
  });
});

describe('computeStarVelocity on a fresh database', () => {
  it('reports insufficient history and names every missing day', () => {
    // The failure this whole task exists to prevent: on day one there is no
    // velocity, and a caller must not be able to read that as "flat".
    const db = migratedDb();

    const result = computeStarVelocity(db, AGENTKIT.repoId, { now: NOW, tz: NY });

    expect(result.status).toBe('insufficient_history');
    if (result.status !== 'insufficient_history') return;
    expect(result.reason).toBe('no_snapshots');
    expect(result.observedDays).toBe(0);
    expect(result.expectedDays).toBe(7);
    expect(result.missingDays).toEqual([
      '2026-08-08',
      '2026-08-09',
      '2026-08-10',
      '2026-08-11',
      '2026-08-12',
      '2026-08-13',
      '2026-08-14',
    ]);
  });
});
