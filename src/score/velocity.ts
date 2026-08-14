import type { Db } from '../db/connection.ts';
import { assertCanonicalTimestamp } from '../domain/item.ts';
import {
  localDay,
  getSnapshotWindow,
  resolveRepoId,
  type SnapshotWindow,
} from '../db/repoSnapshots.ts';

// ---------------------------------------------------------------------------
// Star velocity (M4a task 5 / §4).
//
// §4: "Rank by star velocity (stars gained per day over the trailing 7 days),
// not absolute stars. Store daily star snapshots so velocity is computable --
// a repo going 40->400 in a week matters more than one sitting at 30k."
//
// THE CONTRACT THIS MODULE EXISTS FOR: "insufficient history" is a branch of
// the RETURN TYPE, never a 0. On a fresh database there is no velocity and
// there will not be for a week; if a caller could unwrap "we weren't looking"
// into "no growth", the lane would rank confidently on nothing for its first
// seven days, then silently start working -- the worst of both, and precisely
// the shape of every plausible-wrong-answer bug this project has already been
// bitten by (see CLAUDE.md, "The scoring read path is three functions").
//
// So VelocityResult is a discriminated union on `status`, and `starsPerDay`
// exists ONLY on the `ok` branch. `result.starsPerDay`, `const { starsPerDay }
// = result`, and `result.starsPerDay ?? 0` all fail to compile against the
// union. That is asserted, not asserted-about: tests/score/velocity.test.ts
// pins all three with `@ts-expect-error` directives checked by `npm run
// typecheck`, so adding `starsPerDay` to the insufficient branch -- as a 0, an
// optional, or a `| null` -- makes those directives unused and tsc fails with
// TS2578. The same self-guarding technique src/domain/repo.ts's `Excerpt`
// brand uses. Verified by negative control: flattening the union really does
// fail the typecheck, it is not a directive that has quietly stopped meaning
// anything.
//
// PURITY, as in src/score/decay.ts: `now` is always injected and so is `tz`.
// Nothing here reads a wall clock, the host clock's zone, or process.env.TZ.
// (Deliberately not naming the banned call in prose: the test file greps THIS
// source for it, and a mention in a comment would trip the guard.)
// starVelocityFromWindow is the pure numeric core with no database at all
// (decay.ts's decayFactor plays the same role); computeStarVelocity and
// computeStarVelocityForItem are the composed read-then-compute entry points.
//
// DECAY-INVARIANCE: velocity is a STORED component of signal_score, never a
// decayed value. item_scores is append-only, so a component that changes with
// the clock has no stable row to append -- src/score/decay.ts owns decay,
// applied separately at read time. This module does not import it, and the
// test file greps for exactly that (the same three greps
// tests/score/mechanical.test.ts uses).
//
// ---------------------------------------------------------------------------
// FIVE DECISIONS, each forced by a case that will actually occur
// ---------------------------------------------------------------------------
//
// 1. THE RATE IS COMPUTED FROM OBSERVATION INSTANTS, NOT DAY LABELS.
//    `spanDays = (last.observedAt - first.observedAt) / 24h`, fractional --
//    not `dayIndex(last) - dayIndex(first)`. Day bucketing exists to stop a
//    twice-polled day double-counting (Task 2's primary key); it is not the
//    measurement's resolution. A star count read at an instant IS the count at
//    that instant, so the endpoint instants give the exact average rate.
//    Concretely: a poll at 23:00 and the next at 01:00 straddle two calendar
//    days. Counting labels calls that "one day" and reports a rate 12x too
//    high -- a confident, plausible, entirely wrong number. Measured from
//    instants it is 0.083 days, which fails the gate in point 2 and correctly
//    yields insufficient_history. Tested both ways.
//
// 2. THE GATE IS SPAN, NOT COUNT -- and this is what makes a gappy window
//    work. The scheduler will be down sometimes; velocity over a gap is the
//    case that will actually occur, so it had to be designed for rather than
//    tolerated. The average rate over an interval is a function of its two
//    ENDPOINTS alone; the intermediate readings describe the SHAPE of the
//    growth, not its average. So a gap in the MIDDLE costs nothing: a window
//    observed on only days 1 and 7 gives exactly the same, exactly as correct,
//    stars/day as one observed on all seven. (Tested by computing both and
//    asserting equality.) What disqualifies a window is not missing readings
//    but a short SPAN between the two it has.
//    WHY 3 DAYS, of 6 possible in a 7-day window: 1 would admit the noisy
//    sample the plan warns about -- a 2-day sample gaining 200 stars computes
//    to 100/day and would outrank §4's own 40->400 example at 60/day, letting
//    a single 48-hour burst beat a real week-long trend. 6 would mean nothing
//    ranks until day 7 and the lane looks broken for a week. 3 makes a repo
//    rankable on day 4, and `spanCoverage` (span as a fraction of the 6 days
//    the window could span) is returned so a ranker can attenuate a
//    half-covered measurement rather than treating it as equal evidence.
//    Deliberately a plain derived fraction, not a "confidence": no statistical
//    claim is being made and none would be honest from two points.
//
// 3. NEGATIVE VELOCITY IS NEVER CLAMPED. Star counts genuinely go down --
//    users unstar, and GitHub purges spam stars in bulk. Three reasons not to
//    clamp: (a) clamping to 0 makes a repo that just lost 300 purged fake
//    stars indistinguishable from a genuinely flat repo, discarding the single
//    strongest piece of evidence that its earlier spike was manufactured --
//    exactly the repo this lane must not promote; (b) §4 ranks BY velocity, so
//    a declining repo must sort below a flat one, and clamping ties them;
//    (c) a scorer that wants a non-negative contribution can clamp its own
//    term, and it can only make that choice if this module tells the truth
//    first -- clamping here removes the option irreversibly. The cost, stated:
//    a caller that feeds starsPerDay straight into a weighted sum will get a
//    negative term. That is Task 7's decision to make, not this module's to
//    pre-empt.
//
// 4. STALENESS IS REPORTED, NOT GATED. A gap at the END of the window is the
//    one that does cost something: the number is a true rate, but for an
//    interval that stopped `staleDays` ago, so calling it "the trailing 7
//    days" would overstate it. It is surfaced rather than refused because
//    gating on it would blank the lane after a single missed poll even though
//    a perfectly good 6-day measurement exists -- and because the right
//    response differs by consumer: a ranker may want to attenuate, while §7's
//    row wants to say "as of Tuesday". Baking either policy in here would
//    force the other consumer to undo it. Both `staleDays` and the actual
//    endpoints (`first`/`last`, with their days AND instants) are returned, so
//    the number can never be mistaken for something it is not.
//
// 5. mixedTimezone CANNOT PERTURB THE NUMBER, and is passed through as an
//    advisory rather than treated as insufficient history. It reports that
//    WF_TZ changed mid-window, so the window's day LABELS do not all mean the
//    same thing (Task 2 stores `tz` per row for exactly this). But by decision
//    1 the rate is computed from instants, which carry no zone at all -- so
//    the seam is arithmetically irrelevant to `starsPerDay`. Asserted rather
//    than reasoned about: the test records the same two instants twice, once
//    with WF_TZ changing New York -> Tokyo mid-window and once with it
//    constant, and the two rates are identical. What the seam CAN still
//    distort is the bucketing either side of it -- `observedDays` and
//    `missingDays` -- which is why the flag is surfaced instead of dropped.
// ---------------------------------------------------------------------------

/** §4's window: "stars gained per day over the trailing 7 days". */
export const DEFAULT_WINDOW_DAYS = 7;

/**
 * The smallest elapsed span between the two readings a rate is computed from.
 *
 * Not a count of readings -- a SPAN, measured from the observation instants.
 * See the module doc comment ("The gate is span, not count") for why, and for
 * why 3 rather than 1 or 6.
 */
export const DEFAULT_MIN_SPAN_DAYS = 3;

/** One end of the measured interval. */
export interface VelocityEndpoint {
  /** The calendar day in the zone the reading was bucketed under. */
  day: string;
  stars: number;
  /** The canonical UTC instant the reading was actually taken. */
  observedAt: string;
}

export interface VelocityWindowFacts {
  fromDay: string;
  throughDay: string;
  expectedDays: number;
  observedDays: number;
  missingDays: string[];
}

export interface VelocityOk extends VelocityWindowFacts {
  status: 'ok';
  repoId: number;
  /** Signed. Negative is real data -- see the module doc comment, point 3. */
  starsPerDay: number;
  /** `last.stars - first.stars`, so `starsPerDay` is auditable, not opaque. */
  starsGained: number;
  /** Elapsed days between the two observation INSTANTS. Fractional. */
  spanDays: number;
  /**
   * `spanDays` as a fraction of the most the window could possibly span,
   * clamped to [0, 1]. The lever a ranker uses to stop a barely-qualifying
   * sample beating a full one on equal terms. Not a statistical confidence.
   */
  spanCoverage: number;
  /**
   * Whole days between the newest reading and the end of the window. Nonzero
   * means this rate describes an interval that stopped `staleDays` ago.
   * Reported, never gated -- see the module doc comment, point 4.
   */
  staleDays: number;
  first: VelocityEndpoint;
  last: VelocityEndpoint;
  mixedTimezone: boolean;
}

export type InsufficientReason =
  /** The item_key belongs to no repo this system has ever snapshotted. */
  | 'unknown_repo'
  /** The window holds no readings at all -- a fresh database, day one. */
  | 'no_snapshots'
  /** One reading. A rate needs two points; one has nothing to subtract from. */
  | 'single_snapshot'
  /** Two or more readings, too close together in real time to state a rate. */
  | 'span_too_short';

export interface VelocityInsufficient extends VelocityWindowFacts {
  status: 'insufficient_history';
  reason: InsufficientReason;
  /** `null` only for `unknown_repo` -- there is no repo to name. */
  repoId: number | null;
  /** Elapsed days between the oldest and newest reading; 0 when under two. */
  spanDays: number;
  /** The floor `spanDays` failed to reach. */
  minSpanDays: number;
}

export type VelocityResult = VelocityOk | VelocityInsufficient;

const DAY_MS = 86_400_000;

function facts(window: SnapshotWindow): VelocityWindowFacts {
  return {
    fromDay: window.fromDay,
    throughDay: window.throughDay,
    expectedDays: window.expectedDays,
    observedDays: window.observedDays,
    missingDays: window.missingDays,
  };
}

/** The pure core: velocity from an already-read window. No database, no clock. */
export function starVelocityFromWindow(
  window: SnapshotWindow,
  minSpanDays: number = DEFAULT_MIN_SPAN_DAYS,
): VelocityResult {
  if (!(minSpanDays > 0) || !Number.isFinite(minSpanDays)) {
    throw new RangeError(`minSpanDays must be a positive finite number, got ${minSpanDays}`);
  }

  const snapshots = window.snapshots;
  const refuse = (reason: InsufficientReason, spanDays: number): VelocityInsufficient => ({
    ...facts(window),
    status: 'insufficient_history',
    reason,
    repoId: window.repoId,
    spanDays,
    minSpanDays,
  });

  if (snapshots.length === 0) return refuse('no_snapshots', 0);
  if (snapshots.length === 1) return refuse('single_snapshot', 0);

  const first = snapshots[0]!;
  const last = snapshots[snapshots.length - 1]!;
  const spanDays = (Date.parse(last.observedAt) - Date.parse(first.observedAt)) / DAY_MS;
  if (spanDays < minSpanDays) return refuse('span_too_short', spanDays);

  const starsGained = last.stars - first.stars;

  return {
    ...facts(window),
    status: 'ok',
    repoId: window.repoId,
    // No clamp, in either direction -- module doc comment, point 3.
    starsPerDay: starsGained / spanDays,
    starsGained,
    spanDays,
    // A `days`-day window holds `days` day LABELS, so the furthest apart two
    // of them can be is `days - 1`. Real observation instants can exceed that
    // by up to a day (00:30 on the first, 23:30 on the last), hence the clamp
    // -- a coverage above 1 would be a fraction that is not one.
    spanCoverage: Math.min(1, spanDays / (window.expectedDays - 1)),
    // No date arithmetic: `missingDays` already covers exactly this window,
    // and `last.snapshotDay` is its newest OBSERVED day, so every window day
    // after it is by definition missing. Lexicographic `>` is chronological
    // at this fixed YYYY-MM-DD width -- the same property every read in
    // src/db/repoSnapshots.ts relies on.
    staleDays: window.missingDays.filter((day) => day > last.snapshotDay).length,
    first: { day: first.snapshotDay, stars: first.stars, observedAt: first.observedAt },
    last: { day: last.snapshotDay, stars: last.stars, observedAt: last.observedAt },
    mixedTimezone: window.mixedTimezone,
  };
}

export interface VelocityOptions {
  /** Canonical UTC instant. Always injected -- this module reads no clock. */
  now: string;
  /** The zone snapshot days are bucketed in (WF_TZ). Always explicit. */
  tz: string;
  windowDays?: number;
  minSpanDays?: number;
}

/** Reads the trailing window for `repoId` and computes its star velocity. */
export function computeStarVelocity(
  db: Db,
  repoId: number,
  opts: VelocityOptions,
): VelocityResult {
  assertCanonicalTimestamp('now', opts.now);
  const { days, minSpanDays } = validateOptions(opts);

  const window = getSnapshotWindow(db, repoId, {
    throughDay: localDay(opts.now, opts.tz),
    days,
  });
  return starVelocityFromWindow(window, minSpanDays);
}

/**
 * Shared by both entry points so an impossible configuration is reported
 * identically whether or not the repo happens to be one we have seen --
 * otherwise whether a config error surfaces at all would depend on which item
 * a scoring pass reached first.
 */
function validateOptions(opts: VelocityOptions): { days: number; minSpanDays: number } {
  const days = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const minSpanDays = opts.minSpanDays ?? DEFAULT_MIN_SPAN_DAYS;

  // Both of these make velocity permanently uncomputable rather than merely
  // unavailable-for-now, so they fail loudly at the call rather than
  // returning an insufficient_history a reader would take for "not yet".
  if (!Number.isInteger(days) || days < 2) {
    throw new RangeError(
      `windowDays must be an integer >= 2 (a shorter window holds no two days to measure between), got ${days}`,
    );
  }
  if (minSpanDays > days - 1) {
    throw new RangeError(
      `minSpanDays ${minSpanDays} exceeds the ${days - 1} days a ${days}-day window can span`,
    );
  }
  return { days, minSpanDays };
}

/**
 * Steps a calendar-day LABEL by `delta` whole days.
 *
 * Deliberate duplicate of the private `shiftDay` in src/db/repoSnapshots.ts,
 * reproduced rather than exported because that file belongs to another task
 * this milestone. Same reasoning applies verbatim: input and output are bare
 * YYYY-MM-DD labels with no instant and no zone attached, so `Date.UTC` is a
 * fixed frame for proleptic-Gregorian arithmetic, NOT a zone read -- and
 * `new Date(y, m, d)` would both read the host zone and land on the wrong
 * date across a DST shift, where a local day is 23 or 25 hours. IF THE TWO
 * ARE EVER UNIFIED, UNIFY BOTH -- a divergence here would be silent.
 */
function shiftDay(day: string, delta: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + delta)).toISOString().slice(0, 10);
}

/**
 * Velocity for the repo an `item_key` refers to -- the entry point a caller
 * holding the rest of the system's identity (rather than GitHub's numeric id)
 * actually has. See `resolveRepoId` for how the many-to-many mapping is
 * resolved.
 *
 * A key that maps to no repo is folded into the SAME discriminated union as
 * every other insufficient case, rather than returned as its own `null`. That
 * is the whole point: it inherits the compile-time guard, so the fifth route
 * to a confident zero -- "this item is not a repo, so call it flat" -- is
 * closed by the same mechanism as the other four.
 */
export function computeStarVelocityForItem(
  db: Db,
  itemKey: string,
  opts: VelocityOptions,
): VelocityResult {
  assertCanonicalTimestamp('now', opts.now);
  const { days, minSpanDays } = validateOptions(opts);

  const repoId = resolveRepoId(db, itemKey);
  if (repoId !== null) return computeStarVelocity(db, repoId, opts);

  const throughDay = localDay(opts.now, opts.tz);
  return {
    status: 'insufficient_history',
    reason: 'unknown_repo',
    repoId: null,
    fromDay: shiftDay(throughDay, -(days - 1)),
    throughDay,
    expectedDays: days,
    observedDays: 0,
    // Empty, NOT the whole window: nothing is "missing" for a repo that was
    // never watched. `no_snapshots` means we looked and saw nothing;
    // `unknown_repo` means there was never anything to look at. Naming seven
    // missing days here would invite a consumer to render "0 of 7 days
    // observed" for an item that is not a repo at all.
    missingDays: [],
    spanDays: 0,
    minSpanDays,
  };
}
