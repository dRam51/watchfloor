/**
 * Scales an already-decayed score (§7.4: "score shown as a compact
 * intensity bar") to a 0..1 fill fraction for `ItemRow`'s intensity bar.
 * Plain arithmetic, no ranking/filtering/decay decision of its own -- the
 * frontend renders a number the API already computed
 * (`activeScore`/`activeOverride`, `web/src/api/types.ts`), it never
 * derives one (§7.1: "no business logic in the frontend").
 *
 * WHERE THE CEILING CAME FROM: config/scoring.yaml's own theoretical max is
 * (cluster.signal_weight + source.signal_weight) * interest.multiplier_ceiling
 * = (3.5 + 3.5) * 3.0 = 21 for signal_score, 15 for read_score -- but that
 * ceiling requires max cluster corroboration AND max source trust AND max
 * interest boost AND zero decay simultaneously, which recency decay makes
 * essentially unreachable in practice. Verified live against the running
 * server (2026-08-14, data/wf.db's 4,135-item M2 acceptance corpus) rather
 * than assumed: the highest-ranked real item in ANY beat topped out at
 * 4.25 (usnews, signal) to 4.92 (cyber, read) -- e.g.
 * `GET /api/feed?beat=usnews&limit=5&profile=signal` returned 4.2518 as its
 * single highest score, and `GET /api/feed?beat=cyber&limit=5&profile=read`
 * returned 4.9239. Using the theoretical max (21/15) as "full" would render
 * every bar in the app, including the day's single hottest item, at under
 * 25% fill -- failing the entire point of an at-a-glance intensity signal.
 * 5.0 is picked as a single shared ceiling (not per-profile) because the
 * two profiles' real maxima land close enough together (4.25 vs 4.92) that
 * a second constant would imply a precision this data doesn't support.
 *
 * NOT AUTO-DERIVED FROM config/scoring.yaml: there is no API field carrying
 * a "max score observed" or the config's own thresholds (isHighOnBoth is
 * computed server-side and never returned on the wire, and the frontend
 * cannot read config/scoring.yaml directly -- it lives outside `web/`, and
 * "the HTTP API is the only contract" per §7.1). This constant is a
 * manually-kept, empirically-calibrated value -- the same convention this
 * codebase already uses for every other config-adjacent number with no
 * frontend-visible counterpart (src/score/mechanical.ts's own doc comment
 * on `scorer_version`: "the owner edits thoughtfully rather than on an
 * enforced mechanism"). If config/scoring.yaml's weights are retuned
 * heavily enough to shift real-world maxima, revisit this by hand.
 */
export const SCORE_INTENSITY_CEILING = 5.0;

/** Clamped 0..1 fraction of `SCORE_INTENSITY_CEILING` -- never negative (a
 * score cannot be negative given computeMechanicalScore's formula, but this
 * guards the display math regardless of that invariant holding upstream)
 * and never above 1 (an outlier above the empirical ceiling still reads as
 * "full", not as an overflowing bar). */
export function scoreIntensity(score: number): number {
  if (Number.isNaN(score) || score <= 0) return 0;
  return Math.min(1, score / SCORE_INTENSITY_CEILING);
}
