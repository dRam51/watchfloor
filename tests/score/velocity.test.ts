import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { recordStarSnapshot } from '../../src/db/repoSnapshots.ts';
import {
  computeStarVelocity,
  computeStarVelocityForItem,
  DEFAULT_MIN_SPAN_DAYS,
} from '../../src/score/velocity.ts';

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

describe('computeStarVelocity with too little history to state a rate', () => {
  it('refuses a single reading -- a rate needs two points, not one', () => {
    // One reading is not "zero growth". It is one number with nothing to
    // subtract from it, and dividing by a zero span would produce NaN or
    // Infinity, either of which sorts somewhere in a ranking.
    const db = migratedDb();
    snap(db, 400, AT('2026-08-14'));

    const result = computeStarVelocity(db, AGENTKIT.repoId, { now: NOW, tz: NY });

    expect(result.status).toBe('insufficient_history');
    if (result.status !== 'insufficient_history') return;
    expect(result.reason).toBe('single_snapshot');
    expect(result.observedDays).toBe(1);
    expect(result.spanDays).toBe(0);
  });

  it('refuses two readings whose real elapsed span is only hours', () => {
    // The case day-label arithmetic gets wrong: a poll at 23:00 and the next
    // at 01:00 sit on two different calendar days, so counting DAY LABELS
    // says one day and reports 200 stars/day. The readings are two hours
    // apart. Measured from the instants the span is 0.083 days, which is
    // below any sane floor -- so the honest answer is that there is not
    // enough history yet, not a rate 12x too high.
    const db = migratedDb();
    snap(db, 200, '2026-08-14T03:00:00.000Z'); // 23:00 Aug 13 in New York
    snap(db, 400, '2026-08-14T05:00:00.000Z'); // 01:00 Aug 14 in New York

    const result = computeStarVelocity(db, AGENTKIT.repoId, { now: NOW, tz: NY });

    expect(result.status).toBe('insufficient_history');
    if (result.status !== 'insufficient_history') return;
    expect(result.reason).toBe('span_too_short');
    expect(result.observedDays).toBe(2);
    expect(result.spanDays).toBeCloseTo(2 / 24, 6);
    expect(result.minSpanDays).toBe(DEFAULT_MIN_SPAN_DAYS);
  });

  it('refuses a noisy two-day sample rather than letting it outrank a real trend', () => {
    // The plan's own question: "Is a repo with 2 days of history ranked
    // against one with 7, and if so, how -- without letting a noisy 2-day
    // sample outrank a real 7-day trend?" A 2-day span gaining 200 stars
    // computes to 100/day, which would beat the §4 example's 60/day. It is
    // refused instead of ranked.
    const db = migratedDb();
    snap(db, 200, AT('2026-08-12'));
    snap(db, 400, AT('2026-08-14'));

    const result = computeStarVelocity(db, AGENTKIT.repoId, { now: NOW, tz: NY });

    expect(result.status).toBe('insufficient_history');
    if (result.status !== 'insufficient_history') return;
    expect(result.reason).toBe('span_too_short');
    expect(result.spanDays).toBe(2);
  });

  it('accepts a span of exactly the minimum', () => {
    // The boundary is inclusive: DEFAULT_MIN_SPAN_DAYS is the smallest span
    // that yields a number, so a repo becomes rankable on day 4 of operation
    // rather than day 8.
    const db = migratedDb();
    snap(db, 100, AT('2026-08-11'));
    snap(db, 400, AT('2026-08-14'));

    const result = computeStarVelocity(db, AGENTKIT.repoId, { now: NOW, tz: NY });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.spanDays).toBe(3);
    expect(result.starsPerDay).toBe(100);
  });
});

describe('computeStarVelocity over a gappy window', () => {
  it('gives the same rate whether the middle days were observed or missed', () => {
    // The case that will ACTUALLY occur: the scheduler was down. A gap in the
    // MIDDLE costs nothing, because the average rate over an interval is a
    // function of its two endpoints alone -- the intermediate readings
    // describe the shape of the growth, not its average. Interpolating or
    // zero-filling the gap would be inventing data to reach the same answer.
    const complete = migratedDb();
    for (const [i, stars] of [40, 100, 160, 220, 280, 340, 400].entries()) {
      snap(complete, stars, AT(`2026-08-${String(8 + i).padStart(2, '0')}`));
    }
    const gappy = migratedDb();
    snap(gappy, 40, AT('2026-08-08'));
    snap(gappy, 400, AT('2026-08-14'));

    const full = computeStarVelocity(complete, AGENTKIT.repoId, { now: NOW, tz: NY });
    const sparse = computeStarVelocity(gappy, AGENTKIT.repoId, { now: NOW, tz: NY });

    expect(full.status).toBe('ok');
    expect(sparse.status).toBe('ok');
    if (full.status !== 'ok' || sparse.status !== 'ok') return;
    expect(sparse.starsPerDay).toBe(full.starsPerDay);
    expect(full.observedDays).toBe(7);
    expect(sparse.observedDays).toBe(2);
    expect(sparse.missingDays).toEqual([
      '2026-08-09',
      '2026-08-10',
      '2026-08-11',
      '2026-08-12',
      '2026-08-13',
    ]);
  });

  it('reports how stale the measurement is when the gap is at the END', () => {
    // A gap at the end is the one that does cost something: the number is a
    // true rate, but for an interval that stopped three days ago. It is
    // reported rather than gated -- see the module doc comment -- so the
    // number can never be mistaken for "as of today".
    const db = migratedDb();
    snap(db, 100, AT('2026-08-08'));
    snap(db, 400, AT('2026-08-11'));

    const result = computeStarVelocity(db, AGENTKIT.repoId, { now: NOW, tz: NY });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.staleDays).toBe(3);
    expect(result.last.day).toBe('2026-08-11');
    expect(result.throughDay).toBe('2026-08-14');
  });

  it('reports what fraction of the window the measurement actually spans', () => {
    // The lever the scorer needs to keep a short sample from beating a long
    // one on equal terms: a 3-day span across a 7-day window covers half of
    // the 6 days the window could possibly span.
    const db = migratedDb();
    snap(db, 100, AT('2026-08-11'));
    snap(db, 400, AT('2026-08-14'));

    const result = computeStarVelocity(db, AGENTKIT.repoId, { now: NOW, tz: NY });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.spanCoverage).toBe(0.5);
  });

  it('caps coverage at 1 when the endpoints span more clock time than day labels', () => {
    // A poll early on the first day and late on the last spans 6.5 days of
    // real time across a window whose day labels are only 6 apart, so the
    // raw ratio exceeds 1. Coverage is a fraction and is clamped.
    const db = migratedDb();
    snap(db, 40, '2026-08-08T04:30:00.000Z'); // 00:30 Aug 8 in New York
    snap(db, 400, '2026-08-14T16:30:00.000Z'); // 12:30 Aug 14 in New York

    const result = computeStarVelocity(db, AGENTKIT.repoId, { now: NOW, tz: NY });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.spanDays).toBe(6.5);
    expect(result.spanCoverage).toBe(1);
  });
});

describe('computeStarVelocity when stars go DOWN', () => {
  it('reports a negative rate rather than clamping it to zero', () => {
    // Real data, not a bug: GitHub purges spam stars, and users unstar. A
    // repo that gained 300 fake stars and had them purged is precisely the
    // one this lane must not promote -- clamping to 0 would make it
    // indistinguishable from a genuinely flat repo and would throw away the
    // strongest available evidence that the earlier spike was fake.
    const db = migratedDb();
    snap(db, 700, AT('2026-08-08'));
    snap(db, 400, AT('2026-08-14'));

    const result = computeStarVelocity(db, AGENTKIT.repoId, { now: NOW, tz: NY });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.starsGained).toBe(-300);
    expect(result.starsPerDay).toBe(-50);
  });

  it('ranks a declining repo below a flat one', () => {
    // The ordering clamping would destroy: with both clamped to 0 these two
    // tie, and §4 ranks BY velocity.
    const declining = migratedDb();
    snap(declining, 700, AT('2026-08-08'));
    snap(declining, 400, AT('2026-08-14'));
    const flat = migratedDb();
    snap(flat, 30_000, AT('2026-08-08'));
    snap(flat, 30_000, AT('2026-08-14'));

    const down = computeStarVelocity(declining, AGENTKIT.repoId, { now: NOW, tz: NY });
    const still = computeStarVelocity(flat, AGENTKIT.repoId, { now: NOW, tz: NY });

    if (down.status !== 'ok' || still.status !== 'ok') throw new Error('expected both ok');
    expect(still.starsPerDay).toBe(0);
    expect(down.starsPerDay).toBeLessThan(still.starsPerDay);
  });
});

describe('computeStarVelocity across a WF_TZ change mid-window', () => {
  it('produces the identical rate, and flags the seam', () => {
    // mixedTimezone cannot perturb the number, because the rate is computed
    // from the observation INSTANTS -- which carry no zone -- and never from
    // the day labels. The labels only decide which bucket a reading lands in.
    // Proven by recording the same two instants twice: once with WF_TZ
    // changing from New York to Tokyo mid-window, once with it constant.
    const seam = migratedDb();
    snap(seam, 40, '2026-08-08T17:00:00.000Z', NY);
    snap(seam, 400, '2026-08-14T05:00:00.000Z', TOKYO); // 14:00 Aug 14 in Tokyo
    const constant = migratedDb();
    snap(constant, 40, '2026-08-08T17:00:00.000Z', NY);
    snap(constant, 400, '2026-08-14T05:00:00.000Z', NY); // 01:00 Aug 14 in New York

    const mixed = computeStarVelocity(seam, AGENTKIT.repoId, { now: NOW, tz: NY });
    const same = computeStarVelocity(constant, AGENTKIT.repoId, { now: NOW, tz: NY });

    if (mixed.status !== 'ok' || same.status !== 'ok') throw new Error('expected both ok');
    expect(mixed.spanDays).toBe(5.5);
    expect(mixed.starsPerDay).toBe(same.starsPerDay);
    expect(mixed.mixedTimezone).toBe(true);
    expect(same.mixedTimezone).toBe(false);
  });
});

describe('computeStarVelocity input validation', () => {
  it('refuses a window too short to hold two distinct days', () => {
    // A one-day window can never contain two day buckets, so velocity over it
    // is not merely unavailable -- it is unaskable. Loud beats a permanent,
    // silent insufficient_history.
    const db = migratedDb();
    expect(() =>
      computeStarVelocity(db, AGENTKIT.repoId, { now: NOW, tz: NY, windowDays: 1 }),
    ).toThrow(RangeError);
  });

  it('refuses a minimum span the window can never reach', () => {
    // The configuration foot-gun: a 7-day window spans at most 6 days, so a
    // 7-day minimum makes every repo permanently uncomputable, and the lane
    // looks broken forever with nothing reporting why.
    const db = migratedDb();
    expect(() =>
      computeStarVelocity(db, AGENTKIT.repoId, { now: NOW, tz: NY, minSpanDays: 7 }),
    ).toThrow(RangeError);
  });

  it('refuses a non-canonical now rather than bucketing a guess', () => {
    const db = migratedDb();
    expect(() =>
      computeStarVelocity(db, AGENTKIT.repoId, { now: '2026-08-14', tz: NY }),
    ).toThrow();
  });
});

describe('the insufficient-history case cannot be silently unwrapped', () => {
  it('will not compile if a caller reads the rate without checking the status', () => {
    // These three `@ts-expect-error` directives ARE the assertion, and they
    // are checked by `npm run typecheck` (tsc -p tsconfig.test.json), NOT by
    // vitest -- esbuild strips types without checking them, exactly as
    // tests/domain/repo.test.ts pins the Excerpt brand.
    //
    // Self-guarding: if `starsPerDay` were ever added to the
    // insufficient_history branch -- as a 0, as an optional, as a `| null` --
    // every directive below becomes unused and tsc fails with TS2578. So the
    // guard cannot rot into a silent no-op the way a runtime assertion could.
    const db = migratedDb();
    const result = computeStarVelocity(db, AGENTKIT.repoId, { now: NOW, tz: NY });

    // @ts-expect-error starsPerDay does not exist on the insufficient branch
    const direct: number = result.starsPerDay;
    // @ts-expect-error destructuring is the same property access
    const { starsPerDay } = result;
    // @ts-expect-error the property access fails before ?? can supply a default
    const defaulted: number = result.starsPerDay ?? 0;

    // Runtime half: TypeScript refused all three, but nothing stops a JS
    // caller, so record what those reads actually produce -- undefined, which
    // `?? 0` would then turn into a confident, wrong "flat".
    expect(direct).toBeUndefined();
    expect(starsPerDay).toBeUndefined();
    expect(defaulted).toBe(0);
    expect(result.status).toBe('insufficient_history');
  });

  it('narrows to a number once the status is checked', () => {
    // The other half: the union must not be so closed that the legitimate
    // caller cannot get at the value.
    const db = migratedDb();
    snap(db, 40, AT('2026-08-08'));
    snap(db, 400, AT('2026-08-14'));
    const result = computeStarVelocity(db, AGENTKIT.repoId, { now: NOW, tz: NY });

    const rate: number = result.status === 'ok' ? result.starsPerDay : Number.NaN;

    expect(rate).toBe(60);
  });
});

describe('computeStarVelocityForItem', () => {
  it('resolves the item key to a repo and computes its velocity', () => {
    const db = migratedDb();
    snap(db, 40, AT('2026-08-08'));
    snap(db, 400, AT('2026-08-14'));

    const result = computeStarVelocityForItem(db, AGENTKIT.itemKey, { now: NOW, tz: NY });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.repoId).toBe(AGENTKIT.repoId);
    expect(result.starsPerDay).toBe(60);
  });

  it('reports an unknown key as insufficient history, not as a zero rate', () => {
    // The fifth way a caller could end up with a confident zero: an item that
    // is not a repo, or a repo never snapshotted. Folded into the SAME union
    // so it inherits the compile-time guard above rather than being a
    // separate `null` each caller handles its own way.
    const db = migratedDb();

    const result = computeStarVelocityForItem(db, 'f'.repeat(64), { now: NOW, tz: NY });

    expect(result.status).toBe('insufficient_history');
    if (result.status !== 'insufficient_history') return;
    expect(result.reason).toBe('unknown_repo');
    expect(result.repoId).toBeNull();
    expect(result.fromDay).toBe('2026-08-08');
    expect(result.throughDay).toBe('2026-08-14');
    expect(result.expectedDays).toBe(7);
    expect(result.missingDays).toEqual([]);
  });
});

describe('velocity is pure and decay-invariant', () => {
  it('reads no clock of its own', () => {
    // `now` is always injected, matching src/score/decay.ts. A Date.now() in
    // here would make a historical query untruthful and this module
    // untestable without freezing time.
    const source = readFileSync(join(process.cwd(), 'src', 'score', 'velocity.ts'), 'utf8');
    expect(source).not.toMatch(/Date\.now\(\)|new Date\(\s*\)/);
  });

  it('never imports or applies decay', () => {
    // Velocity is a STORED component of signal_score. item_scores is
    // append-only, so a component that changes with the clock has no stable
    // row to append -- decay belongs to the read path (src/score/decay.ts),
    // which applies it separately. Structural, not a promise. Same three
    // greps tests/score/mechanical.test.ts:440-442 uses, for the same reason:
    // narrow enough that the module can still DOCUMENT decay-invariance
    // without tripping its own guard.
    const source = readFileSync(join(process.cwd(), 'src', 'score', 'velocity.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"].*decay\.ts['"]/);
    expect(source).not.toMatch(/\bdecayFactor\s*\(/);
    expect(source).not.toMatch(/\bcomputeDecayFactor\s*\(/);
  });

  it('does not write to the database', () => {
    const db = migratedDb();
    snap(db, 40, AT('2026-08-08'));
    snap(db, 400, AT('2026-08-14'));
    const before = db
      .prepare('select count(*) as n, sum(stars) as s from github_repo_star_snapshots')
      .get() as { n: number; s: number };

    computeStarVelocity(db, AGENTKIT.repoId, { now: NOW, tz: NY });
    computeStarVelocityForItem(db, AGENTKIT.itemKey, { now: NOW, tz: NY });

    expect(
      db
        .prepare('select count(*) as n, sum(stars) as s from github_repo_star_snapshots')
        .get(),
    ).toEqual(before);
  });
});

describe('computeStarVelocityForItem validates the same way as computeStarVelocity', () => {
  it('refuses an impossible window even when the key resolves to no repo', () => {
    // Otherwise the identical misconfiguration throws for a repo we have seen
    // and returns quietly for one we have not -- so whether a config error is
    // reported would depend on which item happened to be scored first.
    const db = migratedDb();
    expect(() =>
      computeStarVelocityForItem(db, 'f'.repeat(64), { now: NOW, tz: NY, windowDays: 1 }),
    ).toThrow(RangeError);
    expect(() =>
      computeStarVelocityForItem(db, 'f'.repeat(64), { now: NOW, tz: NY, minSpanDays: 7 }),
    ).toThrow(RangeError);
  });
});
