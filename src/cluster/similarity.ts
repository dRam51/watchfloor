/**
 * Trigram Jaccard similarity over normalized titles (M2 Task 4).
 *
 * This is the NEAR-DUPLICATE layer, one level above dedupe. An exact
 * `canonical_url` match is already one `item_key` (`src/normalize/url.ts`,
 * `src/domain/item.ts`'s `deriveItemKey`) and never reaches this module --
 * this module exists for the case where two DIFFERENT sources publish the
 * SAME real-world story at two DIFFERENT URLs, worded differently enough
 * that no URL-level rule could ever unify them.
 *
 * Pure, synchronous, no I/O, no database -- every function here takes plain
 * strings/sets and returns plain strings/sets/numbers, so it is tested
 * directly against real titles with no fixtures beyond string literals. The
 * DB-facing half of clustering (reading candidate items, writing `clusters`/
 * `item_clusters`) lives in `src/cluster/store.ts`; the grouping algorithm
 * that turns pairwise scores into clusters lives in `src/cluster/group.ts`.
 * This module answers exactly one question: given two titles, how similar
 * are they, 0 to 1?
 *
 * ## Word-level trigrams, not character-level
 *
 * "Trigram similarity" most often means CHARACTER 3-grams (this is what
 * PostgreSQL's pg_trgm does). Validated against the real M1 usnews corpus
 * (attic/wf-m1-firstrun-2026-08-14.db -- 150 ap-news + 20 pbs-newshour + 10
 * npr-news titles, 180 total, read-only, never opened by code) and rejected:
 * character trigrams give every pair of headlines a nontrivial baseline
 * score just from sharing common English function words and word endings
 * (" th", "he ", "ing", "ed ", ...), which buries the real signal in noise.
 * Concretely: TRAP 4 below (two headlines about different Ukraine drone
 * strikes, which must NOT cluster) scores 0.19 under character trigrams --
 * comfortably inside the range any usable threshold would need to cover for
 * the genuine pairs -- but scores an exact, provable 0 under WORD trigrams,
 * because no inflected form survives verbatim ("Ukraine's"/"Ukrainian",
 * "drone"/"drones", "strikes"/"strike" are four different literal tokens).
 * Word-level 3-word shingles require an exact 3-CONSECUTIVE-WORD match,
 * which is a much stronger, lower-noise signal for headline-length text.
 * Full comparison numbers are in task-4-report.md.
 *
 * ## Normalization decisions, each justified against real titles
 *
 * 1. Lowercase (Unicode `.toLowerCase()`, not a byte-wise fold) -- case
 *    carries no meaning distinction in a news headline.
 * 2. Apostrophes (straight `'` U+0027 AND curly right single quote `'`
 *    U+2019) are DELETED, not turned into a boundary. Real: the M1 corpus
 *    mixes both glyphs for the identical grammatical role (possessive) --
 *    "Trump's" (straight, npr-news) vs "Nevada's"/"Trump's"/"Shakur's"
 *    (curly, ap-news/pbs-newshour). Deleting collapses "Trump's" to
 *    "trumps", ONE token -- turning the apostrophe into a boundary instead
 *    (`(?<!\w)'(?!\w)`-style) would split it into "trump" + "s", inventing a
 *    spurious one-letter token that pollutes every shingle window it
 *    touches. Curly LEFT single quote (U+2018) is handled the same way for
 *    symmetry, though it does not occur in the sampled corpus.
 * 3. The dash family -- hyphen-minus (U+002D), en dash (U+2013), em dash
 *    (U+2014) -- becomes a SPACE (a word boundary), not deleted. Real: "shut
 *    main building down — and add Trump's name back" (npr-news) uses an em
 *    dash as a clause separator; deleting it would glue "down" to "and".
 *    This also matches the boundary treatment `src/interests/load.ts`
 *    already settled on for hyphens in this same milestone's Task 1 -- one
 *    mental model for "hyphen = boundary" across the M2 config tree, rather
 *    than a second, different answer here. Cost, stated plainly: a
 *    hyphenated compound like "no-hitter" becomes two separate tokens ("no",
 *    "hitter") rather than staying fused -- no attempt is made to recognize
 *    compounds specially.
 * 4. Every other non-letter, non-digit, non-space character (colon, comma,
 *    period, straight/curly double quotes, slash, ampersand, dollar sign,
 *    ...) also becomes a space. Simpler and more predictable than special-
 *    casing abbreviations like "U.S." -- the cost (a period-delimited
 *    abbreviation splits into single-letter tokens, "u"/"s" rather than
 *    "us") is real but harmless in practice: it never changes whether any of
 *    the real pairs validated in task-4-report.md match, because "U.S."
 *    tokenizes identically on both sides of every real pair that contains
 *    it.
 * 5. Character-class matching is Unicode-aware (`\p{L}`, `\p{N}` with the
 *    `u` flag), not ASCII `[a-z0-9]` -- same reasoning as
 *    `src/interests/load.ts`'s `WORD_CHAR`: an accented letter is a letter.
 *    Real: "Bears evalúan 2 sitios para estadio en Indiana" (ap-news) must
 *    normalize to "bears evalúan 2 sitios..." (accented word intact), not
 *    "bears eval an 2 sitios..." (an ASCII-only class would treat "ú" as
 *    punctuation and split the word in two).
 * 6. Stopwords ARE removed before shingling (a fixed, hardcoded list below,
 *    not config -- see the module's closing note on why). This is the one
 *    normalization decision NOT settled purely by the five required cases;
 *    it is justified by the full-corpus sweep in task-4-report.md, which
 *    found a real false-positive risk this specifically closes: "The top
 *    photos of the day by AP's photojournalists" vs "The top photos of the
 *    week by AP photojournalists" (two different AP photo-roundup features)
 *    score 3/11 ≈ 0.27 WITH stopwords kept -- higher than every one of the
 *    three required genuine pairs -- and exactly 0 with them dropped.
 * 7. No stemming, no pluralization, no lemmatization -- deliberately, same
 *    stance `src/interests/load.ts` took in Task 1. "strikes" does not match
 *    "strike"; this is precisely what keeps TRAP 4 (see similarity.test.ts)
 *    at a real, provable 0 rather than a "usually low" score that could
 *    drift under a bad config change.
 * 8. Cross-language matching is explicitly OUT OF SCOPE, same as Task 1's
 *    interest-profile matching. Real: ap-news carries near-duplicate
 *    English/Spanish pairs of the identical wire story (e.g. "Luigi
 *    Mangione expected to plead guilty..." / "Fuente AP: Mangione prevé
 *    declararse culpable..."), which this module cannot and does not catch
 *    -- there is no shared vocabulary for a trigram to match on. This is an
 *    accepted, documented miss (see task-4-report.md), not a silent gap:
 *    catching it needs language detection/translation, a different kind of
 *    component, not a better string-similarity function.
 */

const APOSTROPHES = /['‘’]/gu;
const DASHES = /[-–—]/gu;
const NON_WORD = /[^\p{L}\p{N}\s]/gu;
const WHITESPACE = /\s+/gu;

/** Lowercase, punctuation-stripped, whitespace-collapsed. Idempotent. */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFC')
    .toLowerCase()
    .replace(APOSTROPHES, '')
    .replace(DASHES, ' ')
    .replace(NON_WORD, ' ')
    .replace(WHITESPACE, ' ')
    .trim();
}

// A short, standard English stopword list -- function words with no topical
// content of their own. Deliberately NOT exhaustive (no attempt to cover
// every closed-class English word): every entry here was either exercised by
// a real title in the validation corpus or is a shared drop-in from that same
// closed class (determiners, prepositions, conjunctions, common auxiliary/
// copula forms). Hardcoded rather than config-driven -- unlike the
// near-duplicate threshold (config/cluster.yaml, genuinely a dial the owner
// would want to retune), this list is an algorithmic implementation detail in
// the same category as src/interests/load.ts's WORD_CHAR or
// src/normalize/item.ts's GOVERNMENT_PRIMARY_IDS: changing it changes what
// "a trigram" even means, not a knob to turn without touching code.
const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'in',
  'on',
  'at',
  'to',
  'for',
  'and',
  'is',
  'as',
  'by',
  'with',
  'from',
  'into',
  'after',
  'over',
  'amid',
  'its',
  'it',
  'be',
  'are',
  'was',
  'were',
  'that',
  'this',
  'but',
  'or',
  'not',
  'no',
  'up',
  'down',
  'out',
  'about',
  'than',
  'then',
  'so',
]);

/** normalizeTitle + whitespace split + stopword removal. Order preserved. */
export function titleTokens(title: string): string[] {
  const normalized = normalizeTitle(title);
  if (normalized === '') return [];
  return normalized.split(' ').filter((word) => word.length > 0 && !STOPWORDS.has(word));
}

// Trigram, not configurable -- this module computes TRIgram Jaccard, per the
// task spec. A shorter shingle (bigram) was measured and rejected: the same
// full-corpus sweep that justified dropping stopwords (see the module doc
// comment) found MORE spurious collisions under bigrams, not fewer -- e.g.
// the "top photos of the day/week" pair reappears at 0.14 under bigrams even
// with stopwords dropped. See task-4-report.md.
const SHINGLE_SIZE = 3;

/**
 * Sliding-window word shingles. Degrades gracefully for short inputs instead
 * of requiring at least 3 tokens: the window size is `min(3, tokens.length)`,
 * so a 1- or 2-token title still produces exactly one shingle (the whole
 * token sequence) rather than an empty set -- two identical short titles
 * still compare as a perfect match, and two different short titles still
 * compare as disjoint, with no special-cased branch needed.
 */
export function trigramsOfTokens(tokens: string[]): Set<string> {
  const shingles = new Set<string>();
  if (tokens.length === 0) return shingles;
  const size = Math.min(SHINGLE_SIZE, tokens.length);
  for (let i = 0; i + size <= tokens.length; i++) {
    shingles.add(tokens.slice(i, i + size).join(' '));
  }
  return shingles;
}

/** titleTokens + trigramsOfTokens, composed for a single title. */
export function titleTrigrams(title: string): Set<string> {
  return trigramsOfTokens(titleTokens(title));
}

/**
 * Generic Jaccard similarity: |A ∩ B| / |A ∪ B|. Not title-specific -- takes
 * any two `Set<string>` -- so it is independently testable against plain
 * sets, and reusable if another set-shaped signal ever needs the same
 * measure.
 *
 * Two empty sets return 0, not 1: mathematically 0/0 is undefined, and this
 * resolves it toward the conservative reading ("no similarity evidence
 * found") per this task's "prefer under-clustering" mandate, rather than the
 * permissive one ("identical"). In practice this only matters for a title
 * that normalizes to zero tokens (e.g. one that is pure punctuation) --
 * real titles in the validated corpus never hit it, but a silent "two
 * empty titles are a perfect match" would be exactly the kind of accidental
 * false merge this whole module exists to avoid.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const member of a) {
    if (b.has(member)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** The public entry point: trigram Jaccard similarity between two raw titles. */
export function trigramJaccard(titleA: string, titleB: string): number {
  return jaccardSimilarity(titleTrigrams(titleA), titleTrigrams(titleB));
}
