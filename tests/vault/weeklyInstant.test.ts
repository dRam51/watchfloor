import { describe, expect, it } from 'vitest';
import { localDay } from '../../src/db/repoSnapshots.ts';
import { assertCanonicalTimestamp } from '../../src/domain/item.ts';
import { isoWeekOf, weeklyNoteInstant } from '../../src/vault/weekly.ts';

/**
 * The note's own as-of instant — **a pure function of (week, WF_TZ), never a
 * wall clock.**
 *
 * Controller ruling, escalated by task 5 (the daily note) and binding on every
 * fully-managed area: task 4's `renderManagedNote` requires a `generatedAt`,
 * and passing `now` there silently breaks the tier's own rule. A wall clock
 * does not fail loudly — it produces a note that differs on every run over an
 * identical corpus, which fails M5's acceptance criterion ("delete the whole
 * `watchfloor/` tree, re-run sync, `daily/` `weekly/` `entities/` reproduce
 * exactly") while passing every ordinary test.
 *
 * Task 5's analogue is the last millisecond of the day; this is the last
 * millisecond of the ISO week. Its `dailyNoteInstant` is private to that
 * module, so this is the weekly equivalent written here rather than imported.
 *
 * Bisected against the same `localDay` the token ceiling buckets by, rather
 * than computed from a zone offset: an offset is a number somebody has to keep
 * right across DST, and `localDay` is already the one place this project turns
 * an instant into a day.
 */
describe('weeklyNoteInstant', () => {
  it.each([
    ['UTC', '2026-08-16T23:59:59.999Z'],
    // EDT in August: UTC-4, so Sunday midnight local is 04:00Z on Monday.
    ['America/New_York', '2026-08-17T03:59:59.999Z'],
    // UTC+9, and no DST at all.
    ['Asia/Tokyo', '2026-08-16T14:59:59.999Z'],
    // UTC+5:45 — a non-hour offset, which an offset-arithmetic version gets
    // wrong in a way an hour-aligned zone would never reveal.
    ['Asia/Kathmandu', '2026-08-16T18:14:59.999Z'],
  ])('is the last millisecond of the week in %s', (tz, expected) => {
    expect(weeklyNoteInstant(isoWeekOf('2026-08-15'), tz)).toBe(expected);
  });

  it('lands on the last millisecond, proven against localDay itself', () => {
    for (const tz of ['UTC', 'America/New_York', 'Asia/Tokyo', 'Australia/Lord_Howe']) {
      const week = isoWeekOf('2026-08-15');
      const instant = weeklyNoteInstant(week, tz);
      expect(localDay(instant, tz)).toBe(week.endDay);
      const oneMillisecondLater = new Date(Date.parse(instant) + 1).toISOString();
      expect(localDay(oneMillisecondLater, tz) > week.endDay).toBe(true);
    }
  });

  it('is right on the week a DST transition falls in', () => {
    // 2026-W44 is Mon 26 Oct – Sun 1 Nov, and US DST ends on 1 November. The
    // week ends in EST (UTC-5), not the EDT (UTC-4) it began in.
    const week = isoWeekOf('2026-11-01');
    expect(week.label).toBe('2026-W44');
    expect(weeklyNoteInstant(week, 'America/New_York')).toBe('2026-11-02T04:59:59.999Z');
  });

  it('is a canonical timestamp, so it can be frontmatter', () => {
    // renderManagedNote rejects anything else.
    expect(() =>
      assertCanonicalTimestamp('generatedAt', weeklyNoteInstant(isoWeekOf('2026-08-15'), 'UTC')),
    ).not.toThrow();
  });

  it('depends on nothing but the week and the zone', () => {
    const week = isoWeekOf('2026-08-15');
    const first = weeklyNoteInstant(week, 'America/New_York');
    const second = weeklyNoteInstant(isoWeekOf('2026-08-11'), 'America/New_York');
    // A different day of the SAME week, and the same answer -- which is what
    // makes Friday evening's run and Saturday morning's run write one file.
    expect(second).toBe(first);
  });
});
