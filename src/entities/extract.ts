/**
 * Entity extraction: item text -> the strings stored in `item_entities`
 * (M5 task 16).
 *
 * Pure. No network, no database, no clock, no filesystem -- the same shape as
 * `src/normalize/item.ts`, which is its main caller, and for the same reason:
 * everything here is tested with plain inputs and outputs, and nothing here can
 * differ between two runs over the same corpus.
 *
 * ===========================================================================
 * MECHANICAL, NOT AN LLM -- and this is a requirement, not a preference
 * ===========================================================================
 * Ollama is live, local and free on this machine, and Wave 1 shipped a cached,
 * ceiling-capped seam. It is still the wrong tool for THIS output, for four
 * reasons that are properties of the system rather than opinions about models:
 *
 *  1. **Entities feed `item_scores`, which is append-only.**
 *     `buildScoringText` (src/score/mechanical.ts) folds entities into the
 *     same matchable text as title and summary, so an extracted entity moves
 *     `interestMultiplier` and therefore both stored scores. Task 5 rejected
 *     LLM blurbs in the daily note on exactly this ground, and the argument is
 *     stronger here: a blurb is prose nobody diffs, a score is a number the
 *     ranking is derived from and which can never be corrected in place.
 *  2. **A cache miss is not a corpus fact.** Task 3 measured that a cold cache
 *     takes ~5 days to converge at the configured ceiling. An LLM extractor
 *     would therefore produce different entities for the same item depending on
 *     whether the daemon was up, whether the day's token budget was spent, and
 *     whether the cache had been reached yet -- and it would look correct while
 *     doing it. `entities/` notes stamp an as-of derived from corpus state; a
 *     non-corpus input breaks that by construction.
 *  3. **Availability.** CLAUDE.md's portability debt records that Ollama on
 *     Apple Silicon uses Metal and the eventual host may not run the same model
 *     at all. Extraction sits in the ingest hot path for every item of every
 *     poll; a hot path that depends on a local daemon is a hot path that stops.
 *  4. **Cost of the backfill.** 7,267 stored items at the configured daily
 *     ceiling is roughly five days of budget to answer a question a regex
 *     answers in milliseconds.
 *
 * What an LLM would genuinely add is generality -- entities nobody thought to
 * put in a gazetteer. That is a real gap and it is stated in the task report
 * rather than hidden: a **person's name, an unnamed startup, a country** are
 * all invisible here. The path that stays open is a hybrid where THIS pass
 * remains authoritative and a cached LLM pass only ever proposes additions
 * that never enter a stored score.
 *
 * ===========================================================================
 * TWO KINDS OF RULE, READING TWO DIFFERENT TEXTS
 * ===========================================================================
 *   patterns   identifier grammars (CVE, CWE)   title + summary + canonical URL
 *   gazetteer  config vocabulary                title + summary
 *
 * The URL is in for identifiers because **cisa-kev states its CVE id nowhere
 * else**: the title and summary are prose, and the id lives in the canonical
 * URL's `field_cve` query parameter. Measured over the live corpus, including
 * the URL takes CVE-bearing items from 1,694 to 3,307 and distinct ids from
 * 931 to 2,538 -- the whole KEV catalogue, which is 1,665 items, joins the
 * graph or does not.
 *
 * The URL is out for the gazetteer because a hostname is a fact about the
 * SOURCE, not a claim about the content: reading it would attribute `OpenAI`
 * to all 1,129 openai-blog items and `Hugging Face` to all 842
 * huggingface-blog items regardless of subject.
 */

import { buildTermRegex } from '../interests/load.ts';
import type { Beat } from '../domain/item.ts';
import type { EntityRuleset, PatternName } from './rules.ts';

export interface EntityExtractionInput {
  title: string;
  summaryRaw: string | null;
  canonicalUrl: string;
  /**
   * The beats of THIS version of the item, not the `item_key`-wide union.
   *
   * Deliberate, and it is the one place this module departs from the
   * "always use the unioned read path" rule that has bitten four times. An
   * extraction is stored per `item_id`, so it must be a pure function of that
   * row -- which is what lets the insert-time path and the backfill sweep
   * provably agree. The union is recovered where it belongs, at read time, by
   * `getItemEntities` (src/domain/itemEntities.ts), which exists for exactly
   * this. A cross-listed arXiv paper therefore gets `ai`-scoped entities on its
   * cs.AI row and `aisec`-scoped ones on its cs.CR row, and a reader sees both.
   */
  beats: readonly Beat[];
}

// ---------------------------------------------------------------------------
// Identifier patterns
// ---------------------------------------------------------------------------

// Grammars live in code rather than config on purpose: "a CVE id" is a shape,
// not vocabulary, and a config file that accepted a pasted regex would be a
// config file that can hang the ingest loop on catastrophic backtracking.
// WHICH ones run is still config (`patterns:` in config/entities.yaml).
//
// The boundary assertions mirror src/interests/load.ts's WORD_CHAR exactly, so
// an id never matches inside a longer token -- `xCVE-2026-1234` and
// `CVE-2026-1234x` are both misses. A hyphen is NOT a word character, which is
// what lets `?field_cve=CVE-2026-20349` and `/vuln/detail/CVE-2026-73491` both
// match while `NOTCWE-79` does not.
const BOUNDARY_LEFT = String.raw`(?<![\p{L}\p{N}_])`;
const BOUNDARY_RIGHT = String.raw`(?![\p{L}\p{N}_])`;

// CVE-YYYY-NNNN..  MITRE's own syntax: four-digit year, then four or more
// arbitrary digits. Bounded above at 10 rather than left open so a corrupted
// digit run cannot become an "entity" nothing will ever match again.
const CVE_RE = new RegExp(`${BOUNDARY_LEFT}CVE-(\\d{4})-(\\d{4,10})${BOUNDARY_RIGHT}`, 'giu');
// CWE-N. This is how vulnerability CLASSES enter the system -- as an id a
// source asserted, never as a phrase inferred from a title template. See
// config/entities.yaml's header for the measurement behind that choice.
const CWE_RE = new RegExp(`${BOUNDARY_LEFT}CWE-(\\d{1,5})${BOUNDARY_RIGHT}`, 'giu');

function matchAll(text: string, re: RegExp, format: (m: RegExpExecArray) => string): string[] {
  // A fresh RegExp per call rather than resetting lastIndex on a shared one:
  // a `g` regex carries mutable state, and sharing it across calls is a
  // correctness hazard that only shows up under interleaving.
  const local = new RegExp(re.source, re.flags);
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = local.exec(text)) !== null) out.push(format(m));
  return out;
}

/**
 * One extractor per declarable pattern name. Keyed by the same union
 * `PATTERN_NAMES` validates, so a name that loads always has an
 * implementation -- a pattern that parsed but silently never ran is precisely
 * the shape of gap this milestone keeps finding, and the type makes it
 * unrepresentable rather than merely unlikely.
 */
export const PATTERN_EXTRACTORS: Record<PatternName, (text: string) => string[]> = {
  // Upper-cased on the way out so `cve-2026-1234` and `CVE-2026-1234` are one
  // entity and one vault note, not two that alternate.
  cve: (text) => matchAll(text, CVE_RE, (m) => `CVE-${m[1]}-${m[2]}`.toUpperCase()),
  cwe: (text) => matchAll(text, CWE_RE, (m) => `CWE-${m[1]}`.toUpperCase()),
};

// ---------------------------------------------------------------------------
// Compiled ruleset
// ---------------------------------------------------------------------------

interface CompiledAlias {
  name: string;
  beats: ReadonlySet<Beat> | null;
  re: RegExp;
}

// Compiling ~120 entries' regexes per item would be the dominant cost of a
// 7,267-item sweep, so a ruleset is compiled once and memoised against the
// ruleset OBJECT (identity, via a WeakMap -- no cache to invalidate, no key to
// get wrong, and a discarded ruleset takes its compilation with it).
const compiled = new WeakMap<EntityRuleset, CompiledAlias[]>();

function compile(ruleset: EntityRuleset): CompiledAlias[] {
  const cached = compiled.get(ruleset);
  if (cached !== undefined) return cached;

  const out: CompiledAlias[] = [];
  for (const entity of ruleset.entities) {
    const beats = entity.beats === null ? null : new Set(entity.beats);
    for (const alias of entity.aliases) {
      out.push({
        name: entity.name,
        beats,
        re: buildTermRegex(alias.term, { caseSensitive: alias.match === 'exact' }),
      });
    }
  }
  compiled.set(ruleset, out);
  return out;
}

// ---------------------------------------------------------------------------
// extractEntities
// ---------------------------------------------------------------------------

/**
 * Every entity `ruleset` attributes to `input`, deduplicated and sorted by
 * codepoint.
 *
 * Codepoint order rather than `localeCompare`, for the reason
 * `src/vault/entities.ts` gives: `localeCompare` depends on the host's ICU
 * data, and these strings reach a vault note whose bytes M5 acceptance
 * compares between runs and, eventually, between machines.
 *
 * Always a `string[]` -- never `null`, never a throw. An item with nothing in
 * it returns `[]`, which is the same shape as an item that has not been scanned
 * yet; the extraction ledger (`item_entity_extractions`, migration 0010) is
 * what distinguishes those two, precisely because this value cannot.
 */
export function extractEntities(input: EntityExtractionInput, ruleset: EntityRuleset): string[] {
  const prose = input.summaryRaw === null ? input.title : `${input.title} ${input.summaryRaw}`;
  const found = new Set<string>();

  // Identifiers are never beat-scoped: CVE-2026-20349 means the same thing in
  // every lane, and an id is asserted by the source rather than inferred.
  const withUrl = `${prose} ${input.canonicalUrl}`;
  for (const pattern of ruleset.patterns) {
    for (const id of PATTERN_EXTRACTORS[pattern](withUrl)) found.add(id);
  }

  const beats = new Set(input.beats);
  for (const alias of compile(ruleset)) {
    if (found.has(alias.name)) continue;
    if (alias.beats !== null && ![...alias.beats].some((b) => beats.has(b))) continue;
    if (alias.re.test(prose)) found.add(alias.name);
  }

  return [...found].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
