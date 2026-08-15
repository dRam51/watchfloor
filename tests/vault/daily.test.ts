import { describe, expect, it } from 'vitest';
import { dailyNoteInstant } from '../../src/vault/daily.ts';

/**
 * The daily note (M5 task 5).
 *
 * §8.1: *"Idempotent overwrite, not append."* M5 acceptance sharpens that into
 * a property: delete the whole `watchfloor/` tree, re-run sync, and `daily/`
 * must reproduce **exactly**. So the note has to be a pure function of (corpus
 * state, date, config) — which starts with the instant the note is computed
 * against being derived from the date, never read from a clock.
 */

describe('dailyNoteInstant — the note`s `now`, derived from its date', () => {
  it('is the last millisecond of the calendar day in the configured zone', () => {
    // 2026-08-15 in Toronto is UTC-4, so the day ends at 03:59:59.999Z on the 16th.
    expect(dailyNoteInstant('2026-08-15', 'America/Toronto')).toBe('2026-08-16T03:59:59.999Z');
  });

  it('is UTC-identical for a UTC zone', () => {
    expect(dailyNoteInstant('2026-08-15', 'UTC')).toBe('2026-08-15T23:59:59.999Z');
  });

  it('reads the zone from its argument, never the host', () => {
    expect(dailyNoteInstant('2026-08-15', 'Asia/Tokyo')).toBe('2026-08-15T14:59:59.999Z');
  });
});
