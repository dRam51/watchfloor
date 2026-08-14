import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { BEATS } from '../domain/item.ts';

export class SourceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceConfigError';
  }
}

const SourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'must be kebab-case'),
  name: z.string().min(1),
  // Every value here must have an adapter that can emit `type: <value>`
  // (src/adapters/types.ts's SourceType is derived from this union, not the
  // other way around) -- add the new value in the SAME change that
  // introduces its adapter, never after. Missed for news_sitemap/
  // google_news until M1 task 6 fix round 1: Tasks 8 and 9 (the AP and
  // Reuters adapters) could not otherwise construct a conforming `Adapter`
  // at all without a cast or editing this file outside their own scope.
  type: z.enum(['rss', 'atom', 'json', 'github_search', 'api', 'market_data', 'news_sitemap', 'google_news']),
  url: z.string().url(),
  beats: z.array(z.enum(BEATS)).min(1),
  weight: z.number().min(0.1).max(2.0),
  // Tightened from /^\d+[mhd]$/ (M1 task 10, constraint 3): the original
  // pattern accepted "0m"/"0h"/"0d". A zero poll_interval is a live landmine
  // downstream -- src/db/fetchState.ts's recordFailure computes
  // nextEligibleAt = now + min(pollIntervalMs * 2^n, ceiling), so a zero
  // pollIntervalMs makes that delay zero regardless of n, meaning a FAILING
  // source becomes eligible again on every single scheduler tick: backoff is
  // completely defeated for exactly the source that most needs it (one
  // that's already failing against a struggling server). Requiring a
  // nonzero leading digit (`[1-9]` before the rest) rejects "0m"/"0h"/"0d"
  // at config-load time while still accepting every legitimate value
  // ("1m".."99999d" etc.). This is gate 1 of two independent gates against
  // the same hazard -- src/scheduler/run.ts's parsePollIntervalMs is gate 2,
  // a runtime guard on the parsed millisecond value itself, so the hazard is
  // closed even if this regex were ever accidentally reverted. See that
  // module's doc comment for the full defense-in-depth reasoning.
  poll_interval: z.string().regex(/^[1-9]\d*[mhd]$/, 'must look like 15m, 6h, or 1d (a nonzero leading digit)'),
  enabled: z.boolean(),
  filters: z.record(z.unknown()).optional(),
  /** Markets sources only. Drives decay and which consumer sees the item (§5.1). */
  tier: z.enum(['event', 'analysis']).optional(),
});

const FileSchema = z.object({ sources: z.array(SourceSchema).min(1) });

export type Source = z.infer<typeof SourceSchema>;

export function loadSources(yamlText: string): Source[] {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (cause) {
    throw new SourceConfigError(`could not parse YAML: ${(cause as Error).message}`);
  }

  const result = FileSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new SourceConfigError(`invalid sources config:\n${lines.join('\n')}`);
  }

  const seen = new Set<string>();
  for (const source of result.data.sources) {
    if (seen.has(source.id)) throw new SourceConfigError(`duplicate source id: ${source.id}`);
    seen.add(source.id);
  }

  return result.data.sources;
}

export function loadSourcesFile(path: string): Source[] {
  return loadSources(readFileSync(path, 'utf8'));
}
