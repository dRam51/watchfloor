import type { SourceHealth } from '../api/sourceHealth.ts';

/**
 * Display order for the source-health page (M3 task 11, §7: "make [silent
 * failures] loud"). Pure and framework-free so the ordering rule itself is
 * unit-testable without mounting `SourceHealthPage`.
 *
 * Failing sources (which already INCLUDES the zero-error stale case -- see
 * `SourceHealth.failing`'s own doc comment) sort first, so the thing this
 * whole page exists to surface is never buried below a long list of
 * healthy ones. Disabled sources sort last: they are an operator decision,
 * not a problem, so they get the LEAST visual priority rather than
 * competing with sources that actually need attention. Everything else
 * (healthy and enabled) keeps its `config/sources.yaml` declaration order
 * in the middle tier -- `Array.prototype.sort` is a stable sort (ES2019+),
 * so ties within a tier never reorder relative to the input.
 */
function healthTier(source: SourceHealth): number {
  if (source.failing) return 0;
  if (!source.enabled) return 2;
  return 1;
}

export function sortForHealthDisplay(sources: readonly SourceHealth[]): SourceHealth[] {
  return [...sources].sort((a, b) => healthTier(a) - healthTier(b));
}
