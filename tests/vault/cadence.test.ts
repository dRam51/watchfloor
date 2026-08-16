import { describe, expect, it } from 'vitest';
import {
  advanceVaultSlots,
  dueVaultWork,
  localHourStamp,
  weeklyReleaseStamp,
  NO_VAULT_SLOTS,
  WEEKLY_RELEASE_HOUR,
  type VaultSyncSlots,
} from '../../src/vault/cadence.ts';
import { isoWeekOf } from '../../src/vault/weekly.ts';

/**
 * §8.1: the weekly reading note is written **Friday evening**.
 *
 * A daemon that ticks every 60 seconds has two ways to get an edge-triggered
 * event wrong, and both are silent:
 *
 * - **Miss it.** `hour === 18 && minute === 0` never fires if the process was
 *   down at 18:00, or if a slow poll cycle straddled the minute. The note is
 *   simply never written, and the failure is an absence — the hardest kind to
 *   notice in a vault.
 * - **Rewrite it every tick.** `weekday === Friday && hour >= 18` fires 360
 *   times over one evening. In a synced vault that is 360 mtime changes
 *   propagated to every device, and 360 passes over the LLM.
 *
 * The rule under test is level-triggered instead: each unit of work has a
 * **slot identity** (the local hour for the daily note, the ISO week for the
 * weekly one), and work is due when the current slot is not the one already
 * done. "Is it Friday evening" becomes "has this week's Friday-evening
 * threshold passed, and is this week's note still unwritten" — which cannot
 * miss (it stays true until satisfied) and cannot repeat (it is false once
 * satisfied).
 *
 * Every boundary here comes from `WF_TZ`. The zone is a parameter with no
 * default, so there is no expression of "ask the host what day it is".
 */

const TZ_NY = 'America/New_York';
const TZ_UTC = 'UTC';
/** UTC+05:45. The offset that is not a whole number of hours. */
const TZ_KATHMANDU = 'Asia/Kathmandu';

function slots(daily: string | null, weekly: string | null): VaultSyncSlots {
  return { daily, weekly };
}

describe('localHourStamp — the slot identity, in WF_TZ and never the host zone', () => {
  it('formats a fixed-width, lexicographically ordered stamp', () => {
    expect(localHourStamp('2026-08-15T14:37:02.000Z', TZ_UTC)).toBe('2026-08-15T14');
  });

  it('reads midnight as hour 00, not 24', () => {
    // hourCycle matters: an h24 formatter reports midnight as '24' and makes
    // the stamp sort after every other hour of the same day.
    expect(localHourStamp('2026-08-15T00:10:00.000Z', TZ_UTC)).toBe('2026-08-15T00');
  });

  it('answers a different day for the same instant in two zones', () => {
    // 01:30 UTC on Saturday is still Friday evening in New York. A host-zone
    // read would file this under the wrong day, and — one level up — under the
    // wrong ISO week for a Sunday-night instant.
    const instant = '2026-08-15T01:30:00.000Z';
    expect(localHourStamp(instant, TZ_UTC)).toBe('2026-08-15T01');
    expect(localHourStamp(instant, TZ_NY)).toBe('2026-08-14T21');
  });

  it('handles a zone whose offset is not a whole number of hours', () => {
    // UTC+05:45: 18:20 UTC is 00:05 the next day in Kathmandu.
    expect(localHourStamp('2026-08-15T18:20:00.000Z', TZ_KATHMANDU)).toBe('2026-08-16T00');
  });

  it('is monotone across a DST spring-forward', () => {
    // 2026-03-08, America/New_York: 02:00 local does not exist.
    const before = localHourStamp('2026-03-08T06:30:00.000Z', TZ_NY); // 01:30 EST
    const after = localHourStamp('2026-03-08T07:30:00.000Z', TZ_NY); // 03:30 EDT
    expect(before).toBe('2026-03-08T01');
    expect(after).toBe('2026-03-08T03');
    expect(after > before).toBe(true);
  });

  it('is monotone across a DST fall-back, where a local hour repeats', () => {
    // 2026-11-01, America/New_York: 01:00-02:00 local happens twice. The two
    // instants produce the SAME stamp, which is correct for a slot identity —
    // the work is done once for that hour — and is the reason the comparison
    // below is `>=` on a stamp rather than arithmetic on an offset.
    expect(localHourStamp('2026-11-01T05:30:00.000Z', TZ_NY)).toBe('2026-11-01T01');
    expect(localHourStamp('2026-11-01T06:30:00.000Z', TZ_NY)).toBe('2026-11-01T01');
  });
});

describe('weeklyReleaseStamp — Friday evening, as a comparable stamp', () => {
  it('is the Friday of that ISO week at the release hour', () => {
    // 2026-W33 runs Mon 2026-08-10 .. Sun 2026-08-16.
    const week = isoWeekOf('2026-08-15');
    expect(week.label).toBe('2026-W33');
    expect(weeklyReleaseStamp(week)).toBe(`2026-08-14T${String(WEEKLY_RELEASE_HOUR).padStart(2, '0')}`);
  });

  it('is Friday even for a week that starts in the previous month', () => {
    const week = isoWeekOf('2026-10-01'); // Thursday; the week starts 09-28.
    expect(week.startDay).toBe('2026-09-28');
    expect(weeklyReleaseStamp(week).slice(0, 10)).toBe('2026-10-02');
  });

  it('is Friday across a year boundary', () => {
    // 2020-W53 contains 2021-01-01, which is itself a Friday.
    const week = isoWeekOf('2021-01-01');
    expect(week.label).toBe('2020-W53');
    expect(weeklyReleaseStamp(week).slice(0, 10)).toBe('2021-01-01');
  });
});

describe('the daily note refreshes hourly — never every tick, never once a day', () => {
  it('is due on the first tick of a process that has synced nothing', () => {
    const due = dueVaultWork(NO_VAULT_SLOTS, '2026-08-12T14:05:00.000Z', TZ_UTC);
    expect(due.daily).toBe(true);
    expect(due.date).toBe('2026-08-12');
  });

  it('is not due again in the same local hour', () => {
    const first = dueVaultWork(NO_VAULT_SLOTS, '2026-08-12T14:00:30.000Z', TZ_UTC);
    const after = advanceVaultSlots(NO_VAULT_SLOTS, first, { weeklyWritten: false });
    // 59 ticks later, still 14:xx.
    expect(dueVaultWork(after, '2026-08-12T14:59:30.000Z', TZ_UTC).daily).toBe(false);
  });

  it('is due again in the next local hour', () => {
    const first = dueVaultWork(NO_VAULT_SLOTS, '2026-08-12T14:00:30.000Z', TZ_UTC);
    const after = advanceVaultSlots(NO_VAULT_SLOTS, first, { weeklyWritten: false });
    expect(dueVaultWork(after, '2026-08-12T15:00:30.000Z', TZ_UTC).daily).toBe(true);
  });

  it('runs ONCE after a three-hour outage, not once per hour missed', () => {
    // The catch-up property. A level-triggered slot has no backlog: the daily
    // note is a rewrite of one file, so three missed refreshes are one refresh.
    const at11 = dueVaultWork(NO_VAULT_SLOTS, '2026-08-12T11:00:00.000Z', TZ_UTC);
    let state = advanceVaultSlots(NO_VAULT_SLOTS, at11, { weeklyWritten: false });
    const at14 = dueVaultWork(state, '2026-08-12T14:00:00.000Z', TZ_UTC);
    expect(at14.daily).toBe(true);
    state = advanceVaultSlots(state, at14, { weeklyWritten: false });
    expect(dueVaultWork(state, '2026-08-12T14:30:00.000Z', TZ_UTC).daily).toBe(false);
  });

  it('crosses the day boundary in WF_TZ, not in UTC', () => {
    // 03:30 UTC is still 23:30 the previous day in New York, so the note being
    // written is still the 12th's. A UTC read would open the 13th's note four
    // and a half hours early and leave the 12th's missing its evening.
    const due = dueVaultWork(NO_VAULT_SLOTS, '2026-08-13T03:30:00.000Z', TZ_NY);
    expect(due.date).toBe('2026-08-12');
    expect(dueVaultWork(NO_VAULT_SLOTS, '2026-08-13T03:30:00.000Z', TZ_UTC).date).toBe('2026-08-13');
  });
});

describe('the weekly note is written Friday evening — once, and not missed', () => {
  // 2026-W33: Mon 08-10 .. Sun 08-16. Friday is 08-14.
  const before = '2026-08-14T21:30:00.000Z'; // 17:30 in New York, Friday
  const at = '2026-08-14T22:00:00.000Z'; // 18:00 in New York, Friday
  const later = '2026-08-14T23:30:00.000Z'; // 19:30, same evening

  it('is not due before the release hour on Friday', () => {
    expect(dueVaultWork(NO_VAULT_SLOTS, before, TZ_NY).weekly).toBe(false);
  });

  it('is due at the release hour', () => {
    const due = dueVaultWork(NO_VAULT_SLOTS, at, TZ_NY);
    expect(due.weekly).toBe(true);
    expect(due.week.label).toBe('2026-W33');
  });

  it('is not due again later the same evening — the rewrite-every-tick failure', () => {
    const due = dueVaultWork(NO_VAULT_SLOTS, at, TZ_NY);
    const state = advanceVaultSlots(NO_VAULT_SLOTS, due, { weeklyWritten: true });
    expect(dueVaultWork(state, later, TZ_NY).weekly).toBe(false);
    // And not on the following ticks either, all the way to the week's end.
    expect(dueVaultWork(state, '2026-08-16T20:00:00.000Z', TZ_NY).weekly).toBe(false);
  });

  it('is not due again over the weekend, which is the same ISO week', () => {
    // ISO weeks run Monday..Sunday, so Saturday and Sunday carry the label
    // already written. A "days since Friday" rule would have to special-case
    // this; a slot identity does not.
    const state = slots(null, '2026-W33');
    expect(dueVaultWork(state, '2026-08-15T22:00:00.000Z', TZ_NY).weekly).toBe(false);
    expect(dueVaultWork(state, '2026-08-16T22:00:00.000Z', TZ_NY).weekly).toBe(false);
  });

  it('is not due on the Monday of the next week — the threshold has not passed', () => {
    const state = slots(null, '2026-W33');
    const monday = dueVaultWork(state, '2026-08-17T22:00:00.000Z', TZ_NY);
    expect(monday.week.label).toBe('2026-W34');
    expect(monday.weekly).toBe(false);
  });

  it('IS due for the new week once its own Friday evening arrives', () => {
    const state = slots(null, '2026-W33');
    const due = dueVaultWork(state, '2026-08-21T22:00:00.000Z', TZ_NY);
    expect(due.week.label).toBe('2026-W34');
    expect(due.weekly).toBe(true);
  });

  it('catches up: a daemon started on Sunday still writes Fridays note', () => {
    // The missed-it failure. The threshold is a level, not an edge, so a
    // process that was down all Friday evening writes the note on its first
    // tick — the note is a statement about the week either way (its own as-of
    // instant is the week's last millisecond, not the run's clock).
    const due = dueVaultWork(NO_VAULT_SLOTS, '2026-08-16T15:00:00.000Z', TZ_NY);
    expect(due.week.label).toBe('2026-W33');
    expect(due.weekly).toBe(true);
  });

  it('does not fire for a week whose Friday evening never arrived', () => {
    // Started Wednesday. Nothing is owed yet.
    expect(dueVaultWork(NO_VAULT_SLOTS, '2026-08-12T22:00:00.000Z', TZ_NY).weekly).toBe(false);
  });

  it('decides Friday evening in WF_TZ — the same instant answers differently by zone', () => {
    // 2026-08-14T22:00Z is 18:00 Friday in New York and 22:00 Friday in UTC:
    // due in both. An hour earlier it is 17:00 in New York (not yet) and 21:00
    // in UTC (well past). One instant, two answers, and only the configured
    // zone decides which.
    const instant = '2026-08-14T21:00:00.000Z';
    expect(dueVaultWork(NO_VAULT_SLOTS, instant, TZ_NY).weekly).toBe(false);
    expect(dueVaultWork(NO_VAULT_SLOTS, instant, TZ_UTC).weekly).toBe(true);
  });

  it('files a Sunday-night instant under the right week for a western zone', () => {
    // 2026-08-17T02:00Z is Monday in UTC (week 34) and Sunday evening in New
    // York (week 33). Bucketing by UTC would skip week 33's note entirely for
    // a reader west of Greenwich.
    expect(dueVaultWork(NO_VAULT_SLOTS, '2026-08-17T02:00:00.000Z', TZ_UTC).week.label).toBe('2026-W34');
    expect(dueVaultWork(NO_VAULT_SLOTS, '2026-08-17T02:00:00.000Z', TZ_NY).week.label).toBe('2026-W33');
  });
});

describe('the two watermarks are advanced differently, and the asymmetry is the point', () => {
  it('advances the daily slot on an ATTEMPT, so a refusal is not logged every tick', () => {
    const due = dueVaultWork(NO_VAULT_SLOTS, '2026-08-12T14:00:00.000Z', TZ_UTC);
    const state = advanceVaultSlots(NO_VAULT_SLOTS, due, { weeklyWritten: false });
    expect(state.daily).toBe('2026-08-12T14');
  });

  it('advances the weekly slot only on a SUCCESS, so a missed week is retried', () => {
    // A refused Friday-evening write (vault unmounted) must not consume the
    // week: the next slot for the daily note is an hour away and writes the
    // same file, but a week's slot never comes back.
    const friday = dueVaultWork(NO_VAULT_SLOTS, '2026-08-14T22:00:00.000Z', TZ_NY);
    expect(friday.weekly).toBe(true);
    const refused = advanceVaultSlots(NO_VAULT_SLOTS, friday, { weeklyWritten: false });
    expect(refused.weekly).toBeNull();

    // An hour later, once the daily slot rolls, it is attempted again.
    const retry = dueVaultWork(refused, '2026-08-14T23:00:00.000Z', TZ_NY);
    expect(retry.weekly).toBe(true);
    const written = advanceVaultSlots(refused, retry, { weeklyWritten: true });
    expect(written.weekly).toBe('2026-W33');
    expect(dueVaultWork(written, '2026-08-15T00:00:00.000Z', TZ_NY).weekly).toBe(false);
  });

  it('never advances a slot backwards', () => {
    const state = slots('2026-08-12T14', '2026-W33');
    const due = dueVaultWork(state, '2026-08-12T14:30:00.000Z', TZ_UTC);
    expect(due.daily).toBe(false);
    expect(advanceVaultSlots(state, due, { weeklyWritten: false })).toEqual(state);
  });
});
