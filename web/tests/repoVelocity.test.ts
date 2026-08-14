import { describe, expect, it } from 'vitest';
import type { FeedItemVelocity } from '../src/api/types.ts';
import { formatSpan, formatStarsPerDay, velocityDisplay } from '../src/lib/repoVelocity.ts';

// ---------------------------------------------------------------------------
// The four forbidden falsehoods this milestone's Waves 1-2 named explicitly
// are pinned here (1 and 4) and in web/tests/RepoRow.test.tsx (2 and 3).
// Each test below names the falsehood it exists to prevent, so deleting it
// deletes the guard visibly rather than quietly.
// ---------------------------------------------------------------------------

describe('formatSpan -- FORBIDDEN FALSEHOOD 1: spanDays is never rendered as a whole number of days', () => {
  // src/score/velocity.ts, decision 1: "a poll at 23:00 and the next at 01:00
  // straddle two calendar days. Counting labels calls that 'one day' and
  // reports a rate 12x too high." The measurement is 0.0833 days. Rendering
  // that as "2 days" (the number of day LABELS it touches) is the exact error
  // Task 5 was built to prevent, restored at the last possible moment.
  it('renders the canonical 23:00/01:00 pair (0.0833 days) in hours, never as a day count', () => {
    const rendered = formatSpan(2 / 24);
    expect(rendered).toBe('2.0h');
    // The falsehood, spelled out: no "2d", no "2 days", no bare day unit at all.
    expect(rendered).not.toMatch(/d/);
  });

  it('never emits a bare whole number of days -- the day tier always carries a decimal', () => {
    // A bare "6d" could be read as "six day labels"; "6.0d" cannot. Every
    // value that reaches the day tier keeps its fractional point, so the
    // rendered string can never be mistaken for a count of calendar days.
    for (const days of [1, 2, 3, 6, 6.5, 6.999, 13]) {
      expect(formatSpan(days)).toMatch(/^\d+\.\d+d$/);
    }
  });

  it('the whole output vocabulary is a closed, always-unit-marked set', () => {
    const samples = [0, 1 / 86_400, 1 / 1440, 5 / 1440, 1 / 24, 2 / 24, 0.5, 0.9999, 1, 2.75, 6.5, 30];
    for (const days of samples) {
      expect(formatSpan(days)).toMatch(/^(0m|<1m|\d+m|\d+\.\d+h|\d+\.\d+d)$/);
    }
  });

  it('sub-minute spans say so rather than rounding to zero', () => {
    expect(formatSpan(1 / 86_400)).toBe('<1m');
    // A genuine zero span (no_snapshots / single_snapshot) is distinct from a
    // tiny-but-real one, and reads as an actual zero.
    expect(formatSpan(0)).toBe('0m');
  });

  it('minutes and hours tiers are chosen by real elapsed time, not by day boundaries', () => {
    expect(formatSpan(5 / 1440)).toBe('5m');
    expect(formatSpan(1 / 24)).toBe('1.0h');
    expect(formatSpan(23 / 24)).toBe('23.0h');
  });
});

describe('formatStarsPerDay -- a nonzero rate never renders as zero', () => {
  it('always carries an explicit sign for a nonzero rate', () => {
    expect(formatStarsPerDay(61.2)).toBe('+61.2');
    // src/score/velocity.ts decision 3: negative velocity is real (spam-star
    // purges, unstarring) and deliberately unclamped. The display must carry
    // it, not absolute-value it away.
    expect(formatStarsPerDay(-8.1)).toBe('-8.1');
  });

  it('a measured flat rate is exactly 0.0, with no sign', () => {
    expect(formatStarsPerDay(0)).toBe('0.0');
  });

  it('a small-but-real rate keeps enough precision to stay visibly nonzero', () => {
    expect(formatStarsPerDay(0.04)).toBe('+0.04');
    expect(formatStarsPerDay(-0.04)).toBe('-0.04');
    // Below two decimals the honest answer is a bound, never a rounded "0.00"
    // -- which would render a real (if tiny) rate as indistinguishable from
    // a measured flat one.
    expect(formatStarsPerDay(0.004)).toBe('+<0.01');
    expect(formatStarsPerDay(-0.004)).toBe('-<0.01');
  });

  it('drops noise decimals on large rates', () => {
    expect(formatStarsPerDay(1234.56)).toBe('+1235');
    expect(formatStarsPerDay(-1234.56)).toBe('-1235');
  });
});

// ---------------------------------------------------------------------------

function ok(overrides: Partial<Extract<FeedItemVelocity, { status: 'ok' }>> = {}): FeedItemVelocity {
  return {
    status: 'ok',
    starsPerDay: 61.2,
    starsGained: 366,
    spanDays: 5.98,
    spanCoverage: 0.99,
    staleDays: 0,
    observedDays: 7,
    expectedDays: 7,
    ...overrides,
  };
}

function insufficient(
  overrides: Partial<Extract<FeedItemVelocity, { status: 'insufficient_history' }>> = {},
): FeedItemVelocity {
  return {
    status: 'insufficient_history',
    reason: 'no_snapshots',
    observedDays: 0,
    expectedDays: 7,
    spanDays: 0,
    minSpanDays: 3,
    ...overrides,
  };
}

describe('velocityDisplay -- direction', () => {
  it('a positive rate is an up arrow', () => {
    const d = velocityDisplay(ok({ starsPerDay: 61.2 }));
    expect(d.direction).toBe('up');
    expect(d.glyph).toBe('▲');
    expect(d.label).toBe('+61.2/d');
  });

  it('a NEGATIVE rate is a down arrow -- unclamped, per src/score/velocity.ts decision 3', () => {
    const d = velocityDisplay(ok({ starsPerDay: -42.5, starsGained: -255 }));
    expect(d.direction).toBe('down');
    expect(d.glyph).toBe('▼');
    expect(d.label).toBe('-42.5/d');
    // A spam-star purge must be legible AS a purge, not flattened to "flat".
    expect(d.title).toContain('-255');
  });

  it('an exactly-zero MEASURED rate is flat -- an arrow, because it was actually measured', () => {
    const d = velocityDisplay(ok({ starsPerDay: 0, starsGained: 0 }));
    expect(d.direction).toBe('flat');
    expect(d.glyph).toBe('→');
    expect(d.label).toBe('0.0/d');
  });

  it('states the span through formatSpan, keeping it distinct from the day-LABEL counts beside it', () => {
    const d = velocityDisplay(ok({ spanDays: 5.98, observedDays: 7, expectedDays: 7 }));
    expect(formatSpan(5.98)).toBe('6.0d');
    expect(d.title).toContain('6.0d');
    // TWO KINDS OF QUANTITY SHARE THIS SENTENCE and must stay distinguishable:
    // `spanDays` is elapsed time between two observation INSTANTS (fractional),
    // while `observedDays`/`expectedDays`/`staleDays` are counts of day LABELS
    // from Task 2's bucketing (whole by construction). The label counts may
    // legitimately read "7 of 7 days"; the SPAN may never take that prose form.
    expect(d.title).toMatch(/7 of 7 days observed/);
    expect(d.title).not.toMatch(/over \d+ days?\b/);
  });
});

describe('velocityDisplay -- FORBIDDEN FALSEHOOD 4: insufficient history never renders a rate', () => {
  // The plan, "the decision that shapes everything": "On a fresh database
  // there is no velocity at all, and there will not be for a week." A
  // confident "-> 0/day" during exactly the week the lane is most likely to
  // be judged would be a lie. There are FOUR distinct reasons, and each gets
  // its own explanation rather than one generic shrug.
  const reasons = ['unknown_repo', 'no_snapshots', 'single_snapshot', 'span_too_short'] as const;

  it.each(reasons)('reason %s: direction is unknown, the glyph is NOT an arrow, and no rate appears', (reason) => {
    const d = velocityDisplay(insufficient({ reason, observedDays: 2, spanDays: 2 / 24 }));
    expect(d.direction).toBe('unknown');
    // Three arrows are reserved for measured directions. None may appear.
    expect(['▲', '▼', '→']).not.toContain(d.glyph);
    // No number-per-day anywhere: not in the label, not in the title.
    expect(d.label).not.toMatch(/\/d\b/);
    expect(`${d.label} ${d.title}`).not.toMatch(/\bstars?\/day\b/);
    // And specifically never a zero rate.
    expect(d.label).not.toContain('0.0');
  });

  it.each(reasons)('reason %s: the title explains WHY, distinctly per reason', (reason) => {
    const d = velocityDisplay(insufficient({ reason, observedDays: 2, spanDays: 2 / 24 }));
    expect(d.title.length).toBeGreaterThan(20);
  });

  it('every reason gets a DIFFERENT explanation -- four states, not one generic shrug', () => {
    const titles = reasons.map((reason) => velocityDisplay(insufficient({ reason })).title);
    expect(new Set(titles).size).toBe(reasons.length);
  });

  it('span_too_short states the measured span in real elapsed time, not day labels', () => {
    // The 12x trap again, one layer up: this reason exists precisely because
    // two readings straddling midnight span two day LABELS but only 2 hours.
    const d = velocityDisplay(insufficient({ reason: 'span_too_short', observedDays: 2, spanDays: 2 / 24, minSpanDays: 3 }));
    expect(d.title).toContain('2.0h');
    expect(d.title).not.toMatch(/\b2 days?\b/);
  });

  it('unknown_repo says NOT TRACKED, never "0 of 7 days observed"', () => {
    // src/score/velocity.ts is explicit that unknown_repo returns an EMPTY
    // missingDays, "not the whole window: nothing is 'missing' for a repo
    // that was never watched... Naming seven missing days here would invite a
    // consumer to render '0 of 7 days observed' for an item that is not a
    // repo at all." This is that consumer, declining the invitation.
    const d = velocityDisplay(insufficient({ reason: 'unknown_repo', observedDays: 0, expectedDays: 7 }));
    expect(d.label).toBe('not tracked');
    expect(`${d.label} ${d.title}`).not.toContain('0 of 7');
    expect(d.label).not.toMatch(/0\/7/);
  });

  it('the three OBSERVED-window reasons do report how much history exists -- "N of 7 days"', () => {
    for (const reason of ['no_snapshots', 'single_snapshot', 'span_too_short'] as const) {
      const d = velocityDisplay(insufficient({ reason, observedDays: 2, expectedDays: 7 }));
      expect(d.label).toContain('2/7d');
      expect(d.title).toContain('2 of the last 7 days');
    }
  });
});

describe('velocityDisplay -- staleness is reported, not hidden', () => {
  it('a fresh window is not marked stale', () => {
    const d = velocityDisplay(ok({ staleDays: 0 }));
    expect(d.stale).toBe(false);
  });

  it('an end-of-window gap surfaces how old the measurement is', () => {
    // src/score/velocity.ts decision 4: the number is a true rate "but for an
    // interval that stopped staleDays ago, so calling it 'the trailing 7
    // days' would overstate it... §7's row wants to say 'as of Tuesday'."
    const d = velocityDisplay(ok({ staleDays: 3 }));
    expect(d.stale).toBe(true);
    // `staleDays` is a WHOLE count of day labels, so it reads as "3 days" --
    // it must NOT borrow formatSpan's "3.0d", whose fractional marker exists
    // to signal the other kind of quantity (see the span test above).
    expect(d.title).toContain('3 days');
    expect(d.title).not.toContain('3.0d');
    // The rate itself is still shown -- gating would blank the lane after one
    // missed poll.
    expect(d.label).toBe('+61.2/d');
  });
});
