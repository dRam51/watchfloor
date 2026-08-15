/**
 * The daily vault note (M5 task 5).
 *
 * §8.1: *"Daily note (`daily/YYYY-MM-DD.md`) — frontmatter with date, per-beat
 * counts, and the market ribbon snapshot. Sections per beat, top N each as a
 * link plus one-line why. Hard-override items pinned in a 'Flagged' section at
 * the top. **Idempotent overwrite, not append.**"*
 *
 * ## Idempotence is the acceptance criterion, so it is the design constraint
 *
 * M5 acceptance deletes the whole `watchfloor/` tree and requires `daily/` to
 * reproduce **exactly**. That makes "idempotent overwrite" a testable property
 * rather than a habit: the note must be a pure function of (corpus state, date,
 * config). Nothing here reads a clock, and the note carries no generation
 * timestamp, no run id, and no counter — anything that differs between two runs
 * over the same corpus would break the acceptance test, and would do it
 * silently, since a note with a fresh timestamp still *looks* right.
 *
 * The one place a clock would normally enter is decay, which M2 applies at read
 * time from the reader's `now`. So `now` is not read here either: it is
 * {@link dailyNoteInstant}, derived from the note's own date and `WF_TZ`.
 */

import { assertCalendarDay, localDay } from '../db/repoSnapshots.ts';

const HOUR_MS = 3_600_000;

/**
 * The instant a daily note is computed against: the **last millisecond of
 * `date` in `tz`**.
 *
 * Derived, never read from a clock — that is what makes the note reproducible.
 * Regenerating 2026-08-15's note at 09:00 and again at 22:00 asks decay and the
 * hard overrides the same question both times, so the same corpus yields the
 * same bytes. A wall-clock `now` would move every decayed score between the two
 * runs and quietly reorder the note.
 *
 * Found by bisection against {@link localDay} rather than by arithmetic on a
 * UTC offset, so the day boundary here is the *same* boundary the token
 * ceiling, the star snapshots, and the header strip already use. A zone whose
 * offset is not a whole number of hours, or one that shifts across this very
 * boundary, needs no special case: the predicate is monotone either way.
 */
export function dailyNoteInstant(date: string, tz: string): string {
  assertCalendarDay('date', date);
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];

  // Bracketing: no zone is more than 14 hours from UTC, so 18 hours on each
  // side is comfortably outside every offset and every DST shift.
  let lo = Date.UTC(year, month - 1, day) - 18 * HOUR_MS;
  let hi = Date.UTC(year, month - 1, day + 1) + 18 * HOUR_MS;

  const onOrBefore = (ms: number): boolean => localDay(new Date(ms).toISOString(), tz) <= date;

  while (lo + 1 < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (onOrBefore(mid)) lo = mid;
    else hi = mid;
  }
  return new Date(lo).toISOString();
}
