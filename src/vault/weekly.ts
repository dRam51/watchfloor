/**
 * The weekly reading note (M5 task 6) — §8.1's *"the artifact I care most
 * about"*.
 *
 * > Written Friday evening: the week's top `read_score` items I haven't
 * > opened, with real blurbs — what the piece argues, why it's worth the time,
 * > estimated read time.
 *
 * Every write goes through `src/vault/session.ts`; this module imports no
 * `node:fs`. It lives inside `src/vault/`, which the source-tree rule in
 * `src/vault/sourceRules.ts` **exempts** from that check, so
 * `tests/vault/weeklySourceRules.test.ts` asserts it separately rather than
 * relying on a rule that does not cover it.
 */

import { assertCalendarDay } from '../db/repoSnapshots.ts';

// ---------------------------------------------------------------------------
// The week
// ---------------------------------------------------------------------------

/** One ISO-8601 week: the unit §8.1's `weekly/YYYY-[Www].md` filename names. */
export interface IsoWeek {
  /** The ISO year, which is not always the Gregorian year of `startDay`. */
  readonly year: number;
  /** 1–53. */
  readonly week: number;
  /** `2026-W33` — zero-padded, and the note's filename stem. */
  readonly label: string;
  /** Monday, as a `YYYY-MM-DD` label. */
  readonly startDay: string;
  /** Sunday, as a `YYYY-MM-DD` label. */
  readonly endDay: string;
}

const MS_PER_DAY = 86_400_000;

/**
 * Day arithmetic on bare `YYYY-MM-DD` LABELS, in the same frame and for the
 * same reason as `shiftDay` in `src/db/repoSnapshots.ts`: neither input nor
 * output carries an instant or a zone, so `Date.UTC` is a fixed frame for
 * proleptic-Gregorian arithmetic rather than a hidden timezone read. The
 * conversion from an instant to a day happens once, in `localDay`, with an
 * explicit WF_TZ.
 */
function dayToUtcMs(day: string): number {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, date);
}

function utcMsToDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 0 = Monday … 6 = Sunday. ISO's week starts on Monday; `getUTCDay` does not. */
function isoWeekday(ms: number): number {
  return (new Date(ms).getUTCDay() + 6) % 7;
}

/**
 * The ISO-8601 week a calendar day falls in.
 *
 * ISO's rule is "week 1 is the week containing the first Thursday", which is
 * why every computation here goes via that week's own Thursday: the Thursday
 * is the only day of a week guaranteed to sit in the same ISO year as the week
 * itself, so it decides both the year and the number without a special case
 * for either boundary.
 *
 * Takes a `YYYY-MM-DD` label rather than an instant, deliberately. The caller
 * supplies `localDay(now, WF_TZ)`; accepting an instant here would silently
 * bucket by UTC and file a Sunday-evening note under the following week for a
 * reader west of Greenwich.
 */
export function isoWeekOf(day: string): IsoWeek {
  assertCalendarDay('day', day);

  const ms = dayToUtcMs(day);
  const weekday = isoWeekday(ms);
  const monday = ms - weekday * MS_PER_DAY;
  const thursday = monday + 3 * MS_PER_DAY;

  const year = new Date(thursday).getUTCFullYear();
  // 4 January is in ISO week 1 by definition, whatever weekday it falls on.
  const jan4 = Date.UTC(year, 0, 4);
  const week1Monday = jan4 - isoWeekday(jan4) * MS_PER_DAY;
  const week = Math.round((monday - week1Monday) / (7 * MS_PER_DAY)) + 1;

  return {
    year,
    week,
    label: `${year}-W${String(week).padStart(2, '0')}`,
    startDay: utcMsToDay(monday),
    endDay: utcMsToDay(monday + 6 * MS_PER_DAY),
  };
}

/** §8.1's `weekly/YYYY-[Www].md`. The only path this module ever writes. */
export function weeklyNoteRelPath(week: IsoWeek): string {
  return `weekly/${week.label}.md`;
}
