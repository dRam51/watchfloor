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
  type: z.enum(['rss', 'atom', 'json', 'github_search', 'api', 'market_data']),
  url: z.string().url(),
  beats: z.array(z.enum(BEATS)).min(1),
  weight: z.number().min(0.1).max(2.0),
  poll_interval: z.string().regex(/^\d+[mhd]$/, 'must look like 15m, 6h, or 1d'),
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
