/**
 * When a long-running daemon writes each vault note (M5 task 15).
 *
 * §8.1 gives the two areas different cadences — the daily note is a picture of
 * today, the weekly reading note is written **Friday evening** — and
 * `src/bin/scheduler.ts` ticks every 60 seconds. Those three facts together
 * are the whole problem this module exists to solve, and both naive solutions
 * fail silently:
 *
 * | rule | failure |
 * | --- | --- |
 * | `hour === 18 && minute === 0` | **misses it.** The process was down, or a slow poll cycle straddled the minute, and the note is simply never written. |
 * | `weekday === Friday && hour >= 18` | **rewrites it every tick.** 360 rewrites over one evening: 360 mtime changes propagated to every device by iCloud, and 360 passes over the LLM. |
 *
 * ## Slots: level-triggered, not edge-triggered
 *
 * Each unit of work has a **slot identity** — the local hour for the daily
 * note, the ISO week for the weekly one — and work is due when the current
 * slot is not the slot already done. "Is it Friday evening?" becomes:
 *
 * > has this week's Friday-evening threshold passed, and is this week's note
 * > still unwritten?
 *
 * That predicate **cannot miss** (it stays true until it is satisfied, so a
 * daemon started on Sunday still writes Friday's note) and **cannot repeat**
 * (it is false the moment it is satisfied). It also has no backlog: three
 * missed hourly refreshes are one refresh, because the daily note is a rewrite
 * of a single file rather than a queue of events.
 *
 * ## Why the daily note refreshes hourly
 *
 * Once a day is wrong in both directions: a note written at 00:01 describes a
 * day that has not happened yet and would sit empty until midnight, and a note
 * written only at the day's end is not a watchfloor. Once a tick is a rewrite
 * a minute of a file in a synced knowledge base. An hour is the compromise,
 * and it is one line — the slot is the hour stamp, so a four-hourly refresh is
 * a change to {@link localHourStamp}'s granularity and nothing else.
 *
 * ## The two watermarks advance differently, and that asymmetry is deliberate
 *
 * - **Daily advances on an ATTEMPT.** A refusal (an unmounted vault) is then
 *   logged at the sync's own cadence rather than every 60 seconds — loud
 *   without being noise — and the next slot is an hour away, writing the same
 *   file. At most an hour of staleness is at stake.
 * - **Weekly advances only on a SUCCESS.** A week's slot never comes back. If
 *   Friday evening's write is refused, consuming the slot would lose the note
 *   for that week permanently, so it is retried on each following daily slot
 *   until it lands — and then never again for that week.
 *
 * ## Everything here is a pure function of (slots, instant, zone)
 *
 * No clock is read, no filesystem is touched, and `tz` is a required parameter
 * with no default: CLAUDE.md's rule is *"TZ set explicitly in config and every
 * schedule derived from it — never read the system timezone"*, and a note's
 * day and week are exactly such derived quantities. The state is held by the
 * caller, which in the daemon is memory — see `src/bin/scheduler.ts` for why
 * that is sufficient rather than a database table.
 */

import { isoWeekOf, type IsoWeek } from './weekly.ts';

/**
 * The hour of the day §8.1's "Friday evening" is taken to mean, in `WF_TZ`.
 *
 * 18:00 is a judgement, and it is named here so that retuning it is one edit.
 * It is late enough that the week's Friday coverage is in the corpus and early
 * enough that the note exists before the evening it is meant to be read in.
 */
export const WEEKLY_RELEASE_HOUR = 18;

/** What has already been done. `null` means "not in this process's lifetime". */
export interface VaultSyncSlots {
  /** The local hour stamp of the last daily ATTEMPT — `2026-08-15T14`. */
  readonly daily: string | null;
  /** The ISO week label of the last weekly SUCCESS — `2026-W33`. */
  readonly weekly: string | null;
}

/** A process that has synced nothing yet. */
export const NO_VAULT_SLOTS: VaultSyncSlots = { daily: null, weekly: null };

export interface VaultSyncDue {
  readonly daily: boolean;
  readonly weekly: boolean;
  /** The calendar day the daily note is for, in `tz`. */
  readonly date: string;
  /** The ISO week `now` falls in, in `tz`. */
  readonly week: IsoWeek;
  /** The slot identity of this instant — what {@link advanceVaultSlots} records. */
  readonly dailySlot: string;
}

const MS_PER_DAY = 86_400_000;

/**
 * `YYYY-MM-DDTHH` for an instant in `tz`.
 *
 * Fixed width on purpose: every comparison in this module is lexicographic,
 * which agrees with chronological order only because the width never varies —
 * the same reasoning `src/domain/item.ts` applies to canonical timestamps and
 * `src/db/repoSnapshots.ts` to calendar days.
 *
 * `hourCycle: 'h23'` is load-bearing. The default for `en-US` reports midnight
 * as `24`, which would sort the first hour of a day after its last.
 *
 * A repeated local hour across a DST fall-back produces the same stamp twice,
 * and that is correct for a slot identity: the hour's work is done once.
 */
export function localHourStamp(instant: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}`;
}

/** The calendar day part of {@link localHourStamp}. */
export function localDayOf(instant: string, tz: string): string {
  return localHourStamp(instant, tz).slice(0, 10);
}

/**
 * The stamp at which `week`'s reading note becomes due: its Friday, at
 * {@link WEEKLY_RELEASE_HOUR}.
 *
 * Day arithmetic on a bare `YYYY-MM-DD` LABEL, so `Date.UTC` here is a fixed
 * frame for proleptic-Gregorian arithmetic rather than a hidden zone read —
 * the same argument `shiftDay` in `src/db/repoSnapshots.ts` and `dayToUtcMs`
 * in `./weekly.ts` both make. The one conversion from an instant to a local
 * day happens in {@link localHourStamp}, with an explicit `tz`.
 */
export function weeklyReleaseStamp(week: IsoWeek): string {
  const [year, month, day] = week.startDay.split('-').map(Number) as [number, number, number];
  // startDay is the week's Monday; Friday is four days on.
  const friday = new Date(Date.UTC(year, month - 1, day) + 4 * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
  return `${friday}T${String(WEEKLY_RELEASE_HOUR).padStart(2, '0')}`;
}

/**
 * What a tick at `now` owes, given what has already been done.
 *
 * The weekly comparison is `>=` against a stamp rather than arithmetic on an
 * offset, which is what makes it correct across a DST transition and in a zone
 * whose offset is not a whole number of hours: both sides are local wall-clock
 * labels produced by the same formatter, so no offset is ever computed.
 */
export function dueVaultWork(slots: VaultSyncSlots, now: string, tz: string): VaultSyncDue {
  const dailySlot = localHourStamp(now, tz);
  const date = dailySlot.slice(0, 10);
  const week = isoWeekOf(date);
  return {
    daily: slots.daily !== dailySlot,
    weekly: slots.weekly !== week.label && dailySlot >= weeklyReleaseStamp(week),
    date,
    week,
    dailySlot,
  };
}

/**
 * The slots to carry into the next tick.
 *
 * Called unconditionally after the work — including after a refusal, which is
 * the point: see the module comment on why the daily watermark records an
 * attempt and the weekly one records a success.
 */
export function advanceVaultSlots(
  slots: VaultSyncSlots,
  due: VaultSyncDue,
  outcome: { readonly weeklyWritten: boolean },
): VaultSyncSlots {
  return {
    daily: due.daily ? due.dailySlot : slots.daily,
    weekly: outcome.weeklyWritten ? due.week.label : slots.weekly,
  };
}
