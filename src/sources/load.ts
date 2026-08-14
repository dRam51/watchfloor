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

// ISO 639-2/B, not ISO 639-1: the Google News sitemap schema (see
// src/adapters/newsSitemap.ts's module doc) declares each entry's language as a
// three-letter code -- "eng", "spa" -- verified against the real, live AP sitemap. A
// two-letter code like "en" is a different standard (ISO 639-1) that this document never
// emits, so silently accepting it here would validate a value that can never actually
// match anything at fetch time -- a config typo that "loads fine" and quietly filters
// nothing. Lowercase only: every live-observed value is lowercase, and there is no
// evidence AP (or the schema) ever emits another case to accommodate.
const LANGUAGE_CODE_RE = /^[a-z]{3}$/;

// GitHub's own topic-slug rule, quoted rather than invented: a topic name is at most 50
// characters and "can only contain lowercase letters, numbers, and hyphens, and must start
// with a letter or number." Deliberately the same shape as the `id` regex below, for the
// same reason it is validated at all: GitHub LOWERCASES every topic it stores, so a config
// entry of `LLM` or `Prompt Injection` builds a search query that returns zero repos, with
// no error, no null, and no malformed row anywhere -- the identical silent-nothing failure
// the uppercase check on `languages` above exists to prevent, and a close cousin of the
// sort trap CLAUDE.md records for nvd-cve and hn-algolia. Failing at config load is the
// only place this is visible.
const GITHUB_TOPIC_RE = /^[a-z0-9][a-z0-9-]*$/;
const GITHUB_TOPIC_MAX_LENGTH = 50;

// `filters` stays the free-form, per-source-type map the header comment always promised
// (`keywords` for arxiv-cs-cr, `min_points`+`keywords` for hn-algolia -- neither consumed
// yet, both still forward documentation) -- `.catchall(z.unknown())` keeps every OTHER key
// accepted without validation, exactly as before. `languages` is the one key this task
// makes real: src/adapters/newsSitemap.ts reads it as an allow-list of declared
// <news:language> values to keep. Validated here, not left to `z.unknown()`, so a
// malformed value fails at config load like every other source-config error (weight,
// poll_interval, beats, enrichment) -- never silently accepted and discovered later as
// "the filter isn't doing anything."
const SourceFiltersSchema = z
  .object({
    languages: z
      .array(
        z
          .string()
          .regex(
            LANGUAGE_CODE_RE,
            'must be a three-letter ISO 639-2/B language code (e.g. "eng", "spa"), lowercase -- not a two-letter ISO 639-1 code like "en"',
          ),
      )
      .min(1, 'languages, if present, must list at least one language code -- an empty allow-list would silently drop every entry (use enabled: false to stop polling a source entirely)')
      .optional(),
    // M4a task 4. `github_search` only. The GitHub topics `src/adapters/github.ts` builds
    // one search query pair per, so §4's topic list ("llm, agents, mcp, rag, ai-security,
    // prompt-injection, llmops, network-automation, netdevops") lives in config, never in
    // adapter code -- adding or dropping a topic is a config edit, exactly like adding a
    // source. Required for `github_search` (enforced by the superRefine on SourceSchema
    // below, not here, since this schema cannot see the source's `type`).
    topics: z
      .array(
        z
          .string()
          .max(GITHUB_TOPIC_MAX_LENGTH, `a GitHub topic is at most ${GITHUB_TOPIC_MAX_LENGTH} characters`)
          .regex(
            GITHUB_TOPIC_RE,
            'must be a GitHub topic slug: lowercase letters, numbers and hyphens only, starting with a letter or number (GitHub lowercases every topic it stores, so "LLM" or "Prompt Injection" would query for something that cannot exist)',
          ),
      )
      .min(1, 'topics, if present, must list at least one topic -- a github_search source with no topics polls, spends rate-limit budget, and returns nothing forever (use enabled: false to stop polling a source entirely)')
      .optional(),
    // M4a task 4. `github_search` only: the star floor applied SERVER-SIDE, as a
    // `stars:>=N` qualifier in the search query -- the same enforcement route hn-algolia's
    // own `min_points` takes (via `numericFilters=points>50` in its url, not adapter code),
    // and the reason neither reports anything through `AdapterResult.filtered`: nothing is
    // fetched and then discarded, so there is nothing to count. Optional; the adapter owns
    // the default and documents the evidence behind it.
    min_stars: z
      .number()
      .int('min_stars must be a whole number of stars')
      .min(0, 'min_stars must not be negative')
      .optional(),
  })
  .catchall(z.unknown());

// Source-level CONTENT axis, orthogonal to `beats` (a TOPIC axis). Added by the
// fix-news-sources-and-kind task: `beat` alone can't express "aisec, but only news" --
// `item_type` was tried for exactly that job and found effectively binary in practice (M2:
// `press` matches 0 of 3,325 real items), so this is a new field rather than a repurposing
// of the old one. See config/sources.yaml's header for the full "why source-level, not
// item-level" reasoning (short version: a source's kind is stable and honest -- arXiv is
// always papers -- while an item-level classifier is the exact thing that already failed).
export const KINDS = ['news', 'paper', 'blog', 'advisory', 'aggregator'] as const;
export type Kind = (typeof KINDS)[number];

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
  filters: SourceFiltersSchema.optional(),
  /** Markets sources only. Drives decay and which consumer sees the item (§5.1). */
  tier: z.enum(['event', 'analysis']).optional(),
  /**
   * The content-kind filter -- see KINDS' own doc comment above. Optional, matching
   * `tier`'s existing precedent (not every source needs one), rather than required like
   * `enrichment`: this is a read-side filter, not a decision that changes a source's
   * behavior, so there is no correctness reason to force it onto every hand-built `Source`
   * fixture across the test suite the way `enrichment`'s universally-applicable default
   * did. Every REAL entry in config/sources.yaml is still classified explicitly --
   * "optional in the schema" is not the same claim as "left unclassified in practice".
   */
  kind: z.enum(KINDS).optional(),
  // Gates whether this source's items may enter the LLM enrichment pass -- a later
  // milestone. NOTHING reads this field yet (there is no enrichment pass to gate); its
  // job today is narrower: be recorded and validated so a real decision doesn't quietly
  // rot into a no-op. Do NOT delete this as "unused" just because no adapter or scorer
  // consumes it yet -- that was exactly the bug this field fixes (see below).
  //
  // The decision behind it: AP's robots.txt names ClaudeBot, anthropic-ai, GPTBot, and
  // CCBot as disallowed. Fetching AP's own declared news sitemap (config/sources.yaml's
  // `ap-news`, type: news_sitemap) stays inside AP's stated rules, but handing those
  // headlines to an LLM summarizer is closer to what those blocks are aimed at than a
  // literal robots.txt path match captures. The project owner chose to keep `ap-news`
  // out of enrichment regardless -- see that entry in config/sources.yaml and
  // task-11-report.md's "The `enrichment` field" section for the full reasoning.
  //
  // Before this line existed, `enrichment: false` was already sitting on `ap-news` in
  // config/sources.yaml, set there in the same commit that noted the schema gap -- and
  // doing nothing, silently: a plain `z.object()` (no `.strict()`) drops unrecognized
  // keys instead of rejecting them, so the config loaded "fine" while the decision it
  // encoded had zero effect. Defaults to `true` so every existing source stays
  // enrichment-eligible unless explicitly opted out.
  enrichment: z.boolean().default(true),
})
  // M4a task 4. The only cross-field rule in this schema, and it earns its place: a
  // `github_search` source's ENTIRE input is its topic list (the url is one fixed search
  // endpoint), so one with no `filters.topics` is not a misconfiguration that degrades --
  // it polls on schedule, spends rate-limit budget from a 10-request-per-minute
  // unauthenticated ceiling, and yields zero repos forever, which on a source-health page
  // is indistinguishable from a quiet source. Every other source type carries its own
  // query in its url and is completely unaffected by this.
  //
  // Deliberately NOT expressed as a discriminated union on `type`: that would restructure
  // a schema six other modules' fixtures are built against, to state one requirement that
  // applies to one value of one field.
  .superRefine((source, ctx) => {
    if (source.type === 'github_search' && source.filters?.topics === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['filters', 'topics'],
        message:
          'a github_search source must configure filters.topics -- the topic list is the ' +
          'only input its search query has, so without one it would poll, spend rate-limit ' +
          'budget, and return nothing forever',
      });
    }
  });

const FileSchema = z.object({ sources: z.array(SourceSchema).min(1) });

// `enrichment`'s `.default(true)` above makes it required in z.infer's raw output -- every
// Source that actually came from loadSources()/loadSourcesFile() always carries a concrete
// true/false, never undefined. The exported type is the plain inferred type below, NOT widened
// to `enrichment?: boolean` -- a required boolean would satisfy that wider optional slot, but
// the type would then be claiming a possibility (`undefined`) the loader never actually
// produces. That understatement is a real future cost, not a hypothetical one: when the
// enrichment pass lands in a later milestone, a consumer reading `source.enrichment` as
// `boolean | undefined` would reach for a defensive `?? true` -- silently re-implementing this
// schema's own default at the call site. That duplicated default is exactly where drift
// starts: change `.default(true)` above later and the call-site fallback disagrees with it,
// silently. Keeping the type exact instead costs six hand-built `Source` fixtures across
// `tests/**/*.test.ts` one added field each (fix-enrichment-field follow-up task) -- a one-time
// price, paid once, versus a type that quietly understates its own guarantee to every future
// reader.
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
