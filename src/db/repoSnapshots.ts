/**
 * Converts a canonical UTC instant to the calendar date it falls on **in
 * `tz`** -- the zone the caller supplies, which in this system is always
 * `WF_TZ` (src/config/env.ts). The zone is a required parameter and this
 * module never reads `process.env.TZ`, the host clock's zone, or a default:
 * CLAUDE.md's portability rule is "TZ set explicitly in config and every
 * schedule derived from it -- never read the system timezone", and a snapshot
 * DAY is exactly such a derived schedule quantity.
 */
export function localDay(instant: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
