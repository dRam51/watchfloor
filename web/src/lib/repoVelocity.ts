import type { FeedItemVelocity } from '../api/types.ts';

/**
 * Display logic for §7's "stars + velocity arrow" -- kept OUT of the component
 * so the two falsehoods it exists to prevent can be pinned by a plain unit
 * test rather than by scraping rendered DOM (web/tests/repoVelocity.test.ts).
 *
 * Pure. No clock, no locale, no DOM. Same convention every scoring module in
 * src/ follows and the same one lib/relativeTime.ts and lib/scoreIntensity.ts
 * already follow on this side.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS MOSTLY ABOUT WHAT NOT TO SAY
 * ---------------------------------------------------------------------------
 *
 * 1. SPAN IS ELAPSED TIME, NOT A COUNT OF DAY LABELS. src/score/velocity.ts's
 *    first decision is that the rate is computed from observation INSTANTS:
 *    "a poll at 23:00 and the next at 01:00 straddle two calendar days.
 *    Counting labels calls that 'one day' and reports a rate 12x too high."
 *    The server refuses that window -- and then this layer gets handed
 *    `spanDays: 0.0833` and could undo the whole thing by printing "2 days".
 *    So {@link formatSpan} switches UNIT by magnitude (minutes / hours / days)
 *    and every non-minute tier keeps a decimal point. There is no input for
 *    which it emits a bare whole number of days, which is what makes the
 *    day-label reading unrepresentable rather than merely discouraged.
 *
 * 2. AN UNMEASURED RATE IS NOT A ZERO RATE. `starsPerDay` exists only on the
 *    `ok` branch of the union, and on a fresh database EVERY repo is
 *    insufficient for the first seven days -- the plan calls this "the shape
 *    of the feature", not an edge case. So the three directional arrows are
 *    reserved for measured directions and the insufficient branch gets its own
 *    non-arrow glyph plus an explicit count of the history that does exist.
 *    A "-> 0/day" during that first week would be a confident lie told during
 *    exactly the window in which the lane is most likely to be judged.
 *
 * 3. A TINY RATE IS NOT A FLAT ONE. `+0.004/d` rounded to one decimal prints
 *    "+0.0", which reads as the measured-flat case. {@link formatStarsPerDay}
 *    widens precision as the magnitude shrinks and falls back to a BOUND
 *    ("+<0.01") rather than ever printing a zero for a nonzero measurement.
 */

/** Three arrows, reserved exclusively for a MEASURED direction. */
const ARROW_UP = '▲';
const ARROW_DOWN = '▼';
const ARROW_FLAT = '→';

/**
 * The insufficient-history glyph. Deliberately not an arrow, not a rotated
 * arrow, and not a dimmed arrow: at a glance in a dense lane, anything
 * arrow-shaped reads as a direction, and "we have not measured this yet" is
 * not a direction. A neutral ellipsis-like mark reads as "pending".
 */
const GLYPH_UNKNOWN = '‥';

const HOURS_PER_DAY = 24;
const MINUTES_PER_DAY = 1440;

/**
 * An elapsed span, in the largest unit that keeps it legible -- and NEVER as a
 * bare count of days.
 *
 * Output vocabulary is closed and always unit-marked:
 *   `0m` · `<1m` · `<N>m` · `<N>.<N>h` · `<N>.<N>d`
 *
 * The day tier always carries a decimal point. That is the whole guard: "6d"
 * could be misread as six day labels, "6.0d" is unambiguously a measurement.
 */
export function formatSpan(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return '0m';

  if (days < 1 / HOURS_PER_DAY) {
    const minutes = days * MINUTES_PER_DAY;
    // Never round a real span down to "0m", which is the value reserved for a
    // genuinely unmeasured one.
    if (minutes < 1) return '<1m';
    return `${Math.round(minutes)}m`;
  }

  if (days < 1) return `${(days * HOURS_PER_DAY).toFixed(1)}h`;
  return `${days.toFixed(1)}d`;
}

/**
 * A signed stars-per-day rate.
 *
 * Sign is always explicit for a nonzero rate, including the negative one:
 * src/score/velocity.ts refuses to clamp negatives because "clamping to 0
 * makes a repo that just lost 300 purged fake stars indistinguishable from a
 * genuinely flat repo, discarding the single strongest piece of evidence that
 * its earlier spike was manufactured". Rendering `|rate|` would throw that
 * away one layer later.
 *
 * Precision widens as magnitude shrinks, and bottoms out at a BOUND rather
 * than a zero -- see this module's doc comment, point 3.
 */
export function formatStarsPerDay(rate: number): string {
  if (!Number.isFinite(rate)) return '?';
  if (rate === 0) return '0.0';

  const sign = rate > 0 ? '+' : '-';
  const magnitude = Math.abs(rate);

  // Above 100/day the decimal is noise in a dense row; a repo gaining 1,234.6
  // stars a day is not meaningfully different from one gaining 1,235.
  if (magnitude >= 100) return `${sign}${magnitude.toFixed(0)}`;
  if (magnitude >= 1) return `${sign}${magnitude.toFixed(1)}`;
  if (magnitude >= 0.01) return `${sign}${magnitude.toFixed(2)}`;
  return `${sign}<0.01`;
}

export type VelocityDirection = 'up' | 'down' | 'flat' | 'unknown';

export interface VelocityDisplay {
  direction: VelocityDirection;
  /** An arrow ONLY when `direction` is a measured one. */
  glyph: string;
  /** The short, always-visible label. Carries no rate when nothing was measured. */
  label: string;
  /** The full sentence for a `title=` attribute. Never a substitute for the label. */
  title: string;
  /**
   * The measured interval ended before the window did -- the rate is true, but
   * for an interval that stopped `staleDays` ago. Reported, never gated:
   * gating would blank the lane after a single missed poll (src/score/
   * velocity.ts, decision 4).
   */
  stale: boolean;
}

function okDisplay(v: Extract<FeedItemVelocity, { status: 'ok' }>): VelocityDisplay {
  const direction: VelocityDirection = v.starsPerDay > 0 ? 'up' : v.starsPerDay < 0 ? 'down' : 'flat';
  const glyph = direction === 'up' ? ARROW_UP : direction === 'down' ? ARROW_DOWN : ARROW_FLAT;

  const gained = v.starsGained >= 0 ? `+${v.starsGained}` : `${v.starsGained}`;
  const parts = [
    `${formatStarsPerDay(v.starsPerDay)} stars per day`,
    `${gained} over ${formatSpan(v.spanDays)}`,
    `${v.observedDays} of ${v.expectedDays} days observed`,
  ];
  if (v.staleDays > 0) {
    // WHOLE days here, NOT formatSpan. Two quantities of different kinds share
    // this sentence and must not share a formatter: `spanDays` is elapsed time
    // between two observation instants (fractional, hence formatSpan), while
    // `staleDays` and `observedDays`/`expectedDays` are counts of day LABELS
    // from Task 2's bucketing (whole by construction). Running staleDays
    // through formatSpan printed "3.0d" for a quantity that genuinely is three
    // days -- borrowing the fractional-unit marker that exists specifically to
    // mark the OTHER kind. Caught by web/tests/repoVelocity.test.ts.
    parts.push(`measurement ends ${v.staleDays} ${v.staleDays === 1 ? 'day' : 'days'} before the window does`);
  }

  return {
    direction,
    glyph,
    label: `${formatStarsPerDay(v.starsPerDay)}/d`,
    title: `${parts.join('; ')}.`,
    stale: v.staleDays > 0,
  };
}

function insufficientDisplay(
  v: Extract<FeedItemVelocity, { status: 'insufficient_history' }>,
): VelocityDisplay {
  // `unknown_repo` is handled apart from the other three on purpose.
  // src/score/velocity.ts returns an EMPTY missingDays for it and explains
  // why: "nothing is 'missing' for a repo that was never watched...  Naming
  // seven missing days here would invite a consumer to render '0 of 7 days
  // observed' for an item that is not a repo at all." This is that consumer.
  if (v.reason === 'unknown_repo') {
    return {
      direction: 'unknown',
      glyph: GLYPH_UNKNOWN,
      label: 'not tracked',
      title:
        'Star velocity is not tracked for this item -- it is not a repository this system takes daily star snapshots of.',
      stale: false,
    };
  }

  const history = `${v.observedDays} of the last ${v.expectedDays} days`;
  const why =
    v.reason === 'no_snapshots'
      ? `No star readings at all in ${history}. On a fresh database this is every repo, for the first week.`
      : v.reason === 'single_snapshot'
        ? `Only one star reading in ${history}; a rate needs two points to subtract between.`
        : `Two or more readings in ${history}, but they span only ${formatSpan(v.spanDays)} of real time -- under the ${formatSpan(v.minSpanDays)} minimum. A shorter sample would state a rate the readings do not support.`;

  return {
    direction: 'unknown',
    glyph: GLYPH_UNKNOWN,
    // The count of history that DOES exist is in the always-visible label, not
    // buried in the tooltip: the plan asks the lane to say "velocity
    // unavailable -- N days of history" rather than render a confident zero,
    // and a tooltip is not something a phone browser ever shows.
    label: `no rate ${v.observedDays}/${v.expectedDays}d`,
    title: `Velocity unknown. ${why}`,
    stale: false,
  };
}

/** What the velocity arrow should say -- including when it must not be an arrow. */
export function velocityDisplay(velocity: FeedItemVelocity): VelocityDisplay {
  return velocity.status === 'ok' ? okDisplay(velocity) : insufficientDisplay(velocity);
}
