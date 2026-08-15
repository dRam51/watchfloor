import { describe, expect, it } from 'vitest';
import { isoWeekOf, weeklyNoteRelPath } from '../../src/vault/weekly.ts';

/**
 * The weekly note's own identity: §8.1 names the file `weekly/YYYY-[Www].md`,
 * which is an ISO-8601 week, not "the calendar week containing today".
 *
 * ISO weeks disagree with the Gregorian year at both ends of it, and every
 * disagreement below is a real date that has bitten a real week-numbering
 * implementation: a January day belonging to the previous ISO year, a December
 * day belonging to the next one, and the 53-week years that make
 * `weeks-in-year` a lookup rather than a constant. A note filed under the
 * wrong week is not a cosmetic bug -- the tier is "rewritten every run", so
 * next Friday's run overwrites the wrong file and the right one is never
 * written at all.
 */
describe('isoWeekOf', () => {
  it.each([
    // [calendar day, ISO label, Monday of that week, Sunday of that week]
    ['2026-08-15', '2026-W33', '2026-08-10', '2026-08-16'], // a Saturday
    ['2026-08-10', '2026-W33', '2026-08-10', '2026-08-16'], // its Monday
    ['2026-08-16', '2026-W33', '2026-08-10', '2026-08-16'], // its Sunday
    ['2026-08-17', '2026-W34', '2026-08-17', '2026-08-23'], // the next Monday
    // January days that belong to the PREVIOUS ISO year.
    ['2021-01-01', '2020-W53', '2020-12-28', '2021-01-03'],
    ['2021-01-03', '2020-W53', '2020-12-28', '2021-01-03'],
    ['2021-01-04', '2021-W01', '2021-01-04', '2021-01-10'],
    // December days that belong to the NEXT ISO year.
    ['2019-12-30', '2020-W01', '2019-12-30', '2020-01-05'],
    ['2019-12-29', '2019-W52', '2019-12-23', '2019-12-29'],
    // A 53-week year, at its own boundary.
    ['2020-12-31', '2020-W53', '2020-12-28', '2021-01-03'],
    // Week 1 is the week containing the first Thursday: 2026-01-01 is one.
    ['2026-01-01', '2026-W01', '2025-12-29', '2026-01-04'],
  ])('%s is %s (%s..%s)', (day, label, startDay, endDay) => {
    const week = isoWeekOf(day);
    expect(week.label).toBe(label);
    expect(week.startDay).toBe(startDay);
    expect(week.endDay).toBe(endDay);
  });

  it('refuses anything that is not a calendar-day label', () => {
    // The caller's job is `localDay(now, WF_TZ)`; an instant handed in here
    // would silently pick the UTC day and put a Sunday-evening note in the
    // wrong week for a New York reader.
    expect(() => isoWeekOf('2026-08-15T22:00:00.000Z')).toThrow(/calendar day/);
    expect(() => isoWeekOf('2026-8-15')).toThrow(/calendar day/);
  });
});

describe('weeklyNoteRelPath', () => {
  it('is §8.1s `weekly/YYYY-[Www].md`, zero-padded', () => {
    expect(weeklyNoteRelPath(isoWeekOf('2026-08-15'))).toBe('weekly/2026-W33.md');
    expect(weeklyNoteRelPath(isoWeekOf('2026-01-01'))).toBe('weekly/2026-W01.md');
  });
});
