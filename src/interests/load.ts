import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

export class InterestConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InterestConfigError';
  }
}

// Sanity/typo guard, not a real linguistic limit: a "term" is meant to be a
// word or short phrase that can plausibly appear verbatim in a headline. A
// config entry this long is almost certainly a mistake (a pasted sentence, a
// stray multi-line string) that would never usefully match anything under
// whole-word/phrase semantics anyway -- better to fail loudly at load time
// than load silently and never fire.
const MAX_TERM_LENGTH = 100;

const TermSchema = z.object({
  term: z
    .string()
    .min(1, 'term must not be empty')
    .max(MAX_TERM_LENGTH, `term must be ${MAX_TERM_LENGTH} characters or fewer`)
    // A single check catches three shapes at once: empty-after-trim (pure
    // whitespace), and leading/trailing whitespace. If trim() changes the
    // string at all, something is off that would silently produce a
    // confusing regex (e.g. a leading space would make " eval" look like a
    // distinct, permanently-non-matching term from "eval").
    .refine((t) => t.trim() === t && t.length > 0, 'term must not be blank or have leading/trailing whitespace'),
  // Mirrors src/sources/load.ts's weight bound (0.1-2.0) exactly -- one
  // mental model for "weight" across the config tree, and every seed weight
  // in config/interests.yaml already fits inside it. 0.1 minimum (not 0) for
  // the same reason sources.yaml's poll_interval rejects a zero leading
  // digit: a weight of 0 is an inert entry that loads "successfully" while
  // silently doing nothing -- see that file's comment for the shape of
  // hazard this class of validation exists to catch.
  weight: z.number().min(0.1, 'weight must be at least 0.1').max(2.0, 'weight must be at most 2.0'),
});

const FileSchema = z.object({
  boosts: z.array(TermSchema).min(1, 'boosts must have at least one entry'),
  suppressions: z.array(TermSchema).min(1, 'suppressions must have at least one entry'),
});

export type InterestTerm = z.infer<typeof TermSchema>;

export interface InterestProfile {
  boosts: InterestTerm[];
  suppressions: InterestTerm[];
}

function normalize(term: string): string {
  return term.toLowerCase();
}

function assertNoDuplicates(terms: InterestTerm[], listName: string): void {
  const seen = new Set<string>();
  for (const { term } of terms) {
    const key = normalize(term);
    if (seen.has(key)) {
      throw new InterestConfigError(`duplicate term in ${listName}: ${term}`);
    }
    seen.add(key);
  }
}

export function loadInterests(yamlText: string): InterestProfile {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (cause) {
    throw new InterestConfigError(`could not parse YAML: ${(cause as Error).message}`);
  }

  const result = FileSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new InterestConfigError(`invalid interests config:\n${lines.join('\n')}`);
  }

  const { boosts, suppressions } = result.data;
  assertNoDuplicates(boosts, 'boosts');
  assertNoDuplicates(suppressions, 'suppressions');

  // A term meaning both "I want this" and "I don't want this" at once is a
  // contradiction the scorer has no principled way to resolve -- catch it at
  // load time rather than let it produce an order-dependent or silently
  // cancelled-out score later.
  const boostKeys = new Set(boosts.map((t) => normalize(t.term)));
  for (const { term } of suppressions) {
    if (boostKeys.has(normalize(term))) {
      throw new InterestConfigError(`term appears in both boosts and suppressions: ${term}`);
    }
  }

  return { boosts, suppressions };
}

export function loadInterestsFile(path: string): InterestProfile {
  return loadInterests(readFileSync(path, 'utf8'));
}

// ---------------------------------------------------------------------------
// Matching -- this is the substantive part of the task, not just config I/O.
// ---------------------------------------------------------------------------

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Unicode-aware "word" character class -- deliberately NOT JavaScript's
// built-in \b, which is defined over ASCII \w ([A-Za-z0-9_]) only. Under
// plain \b, an accented letter counts as a NON-word character, so \beval\b
// would wrongly match inside the Spanish word "evalúan" (the boundary
// "fires" right before the accented "ú", which \b doesn't recognize as a
// letter). This is not a hypothetical: it happened against the real M1
// corpus (attic/wf-m1-firstrun-2026-08-14.db, ap-news title "Bears evalúan 2
// sitios para estadio en Indiana y podrían usar ambos"). \p{L} and \p{N}
// (Unicode letter/number categories, available with the regex `u` flag)
// correctly treat accented letters as word characters, closing that gap
// while behaving identically to plain \b for pure-ASCII text.
const WORD_CHAR = String.raw`[\p{L}\p{N}_]`;

/**
 * Builds a case-insensitive, whole-word/whole-phrase matcher for `term`.
 *
 * Boundary semantics (deliberate -- see config/interests.yaml's header and
 * task-1-report.md for the full reasoning and the real-corpus evidence
 * behind each choice):
 *
 *  - A match must not be immediately preceded or followed by a letter,
 *    digit, or underscore (Unicode-aware, see WORD_CHAR above). This is what
 *    keeps "eval" out of "evaluation"/"medieval", "RAG" out of
 *    "dragging"/"fragment"/"storage", and "MCP"/"BGP" out of longer
 *    identifiers -- while still matching next to hyphens, slashes,
 *    parentheses, and straight or curly apostrophes/quotes, since none of
 *    those are word characters ("RAG-based", "eval/test", "Ollama's",
 *    "(MCP)" all match the bare term).
 *  - A term's own words (split on whitespace OR a hyphen) are joined back
 *    together allowing either separator in the matched text. So a
 *    single-token term written with an internal hyphen, like "no-hitter",
 *    also matches the space-separated spelling "no hitter", and a
 *    multi-word phrase term, like "prompt injection", also matches the
 *    hyphenated spelling "prompt-injection" (e.g. inside
 *    "prompt-injection-resistant"). One rule covers both shapes rather than
 *    two different ones.
 *  - No stemming or pluralization, deliberately: "eval" does not match
 *    "evals", "homer" does not match "homers", "Hall of Fame" does not match
 *    "Hall of Famers". Each inflected form that matters needs its own
 *    config entry -- see config/interests.yaml's sports section, which lists
 *    "homer" and "homers" as separate entries for exactly this reason.
 */
export function buildTermRegex(term: string): RegExp {
  const words = term
    .trim()
    .split(/[\s-]+/)
    .filter((w) => w.length > 0)
    .map(escapeRegExp);
  const pattern = words.join('[\\s-]+');
  return new RegExp(`(?<!${WORD_CHAR})${pattern}(?!${WORD_CHAR})`, 'iu');
}

/** True if `term` appears in `text` as a whole word or whole phrase. */
export function termMatches(text: string, term: string): boolean {
  return buildTermRegex(term).test(text);
}

export interface InterestMatch {
  term: string;
  weight: number;
}

/** Every entry in `terms` whose term matches `text`, in input order. */
export function findMatches(text: string, terms: InterestTerm[]): InterestMatch[] {
  const matches: InterestMatch[] = [];
  for (const { term, weight } of terms) {
    if (termMatches(text, term)) matches.push({ term, weight });
  }
  return matches;
}

export interface ProfileMatches {
  boosts: InterestMatch[];
  suppressions: InterestMatch[];
}

/** Matches `text` against both lists of a loaded profile. */
export function matchProfile(text: string, profile: InterestProfile): ProfileMatches {
  return {
    boosts: findMatches(text, profile.boosts),
    suppressions: findMatches(text, profile.suppressions),
  };
}
