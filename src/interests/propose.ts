/**
 * Interest-profile term PROPOSALS (M3 -- "find stories that are interesting
 * specifically for me"). §7: "Dismissal feeds the interest profile as a
 * negative signal (log it; don't auto-tune the weights)." This module is
 * the "log it" half made useful, and stops exactly at the line the brief
 * draws: it reads `item_state` (saved_at/read_at) and
 * `interest_dismissal_signals` (db/migrations/0004), and PROPOSES candidate
 * boost/suppress terms with their evidence. It never writes to
 * `config/interests.yaml` -- that file is hand-maintained and
 * version-controlled, and nothing here imports a file-write function at
 * all. See "never writes to config/interests.yaml" in
 * tests/interests/propose.test.ts for a byte-level proof, the same style of
 * proof src/domain/itemState.ts's dismissItem uses for the same claim.
 *
 * ## Why this is a genuinely hard small-n problem, not a word-count script
 *
 * The owner has zero saves and zero dismissals as this is written -- the
 * dashboard became usable minutes ago. Early on there will be five saves,
 * not five hundred. A naive "count words in saved titles" pass would
 * confidently propose "the", "says", or whatever noun happened to appear
 * twice. Three defenses, layered, address this (see MIN_CLASS_SIZE,
 * MIN_TERM_COUNT, MIN_Z_SCORE below for the exact numbers and rationale):
 *
 *  1. A GATE on class size: below MIN_CLASS_SIZE saved (or dismissed)
 *     items, this pass proposes nothing at all for that direction and says
 *     so plainly. This is expected to be the common path for weeks.
 *  2. A HARD floor on a term's own raw count (MIN_TERM_COUNT), independent
 *     of any statistic: a term seen twice, however rare it is everywhere
 *     else, is never proposed. Two data points is a coincidence a human
 *     would (rightly) distrust; this makes the code distrust it too,
 *     unconditionally -- see the "never ranks a term highly on two
 *     occurrences" test, which is written to catch this floor being
 *     silently lowered or removed.
 *  3. A statistical significance floor (MIN_Z_SCORE) on top of that, so a
 *     term that clears the count floor but isn't actually disproportionate
 *     (appears at the same rate in the background corpus) still gets
 *     dropped.
 *
 * ## The disproportionality measure: Laplace/Haldane-Anscombe-corrected
 * log-odds ratio, ranked by its Wald z-score
 *
 * For a candidate term and a class (saved, or dismissed) vs. the rest of
 * the known corpus, build the usual 2x2 contingency table (item counts, not
 * word counts -- an item counts once whether the term appears once or five
 * times in its title+excerpt, because "did I write about this at all" is
 * the question, not "how many times"):
 *
 *              contains term      does not contain term
 *   class          a                       b
 *   other           c                       d
 *
 * Raw counts are the wrong statistic on their own -- a term with a=2, c=0
 * looks "infinitely" disproportionate as a bare ratio. Add the standard
 * continuity correction (+0.5 to every cell, the Haldane-Anscombe
 * correction used for exactly this small-count-includes-a-zero-cell
 * problem in 2x2 odds-ratio estimation) before taking logs:
 *
 *   logOddsRatio = ln((a+.5)/(b+.5)) - ln((c+.5)/(d+.5))
 *   variance     = 1/(a+.5) + 1/(b+.5) + 1/(c+.5) + 1/(d+.5)
 *   z            = logOddsRatio / sqrt(variance)
 *
 * The correction does two things at once: it keeps the ratio finite when a
 * cell is 0, and its variance term is DOMINATED by whichever cell is
 * smallest -- so a term resting on very few observations gets a wide
 * standard error and a low z-score even if its raw ratio looks dramatic.
 * That is what makes z, not the raw log-odds, the ranking statistic:
 * candidates are sorted and filtered on z, never on logOddsRatio alone.
 * This is NOT a substitute for the MIN_TERM_COUNT floor above -- it is a
 * second, independent line of defense (see that constant's own comment for
 * why both are needed together).
 *
 * This is a simplified, single-file variant of the log-odds-ratio approach
 * standard in corpus linguistics/"keyness" analysis (e.g. Monroe, Colaresi
 * & Quinn 2008's "Fightin' Words", which uses a background-frequency-
 * weighted Dirichlet prior rather than this flat +0.5 correction). The flat
 * correction was chosen deliberately over implementing that fuller version:
 * it needs no background language model beyond this project's own corpus,
 * it is auditable in five lines, and it is the same correction already
 * standard for small-sample 2x2 odds ratios generally -- not a novel
 * invention for this file. No new dependency, no stemmer, per the task
 * constraints; see the report for the case that stemming would need one.
 */

import type { Db } from '../db/connection.ts';
import { buildTermRegex, type InterestProfile } from './load.ts';

// ---------------------------------------------------------------------------
// Thresholds -- each independently justified, each covered by its own test
// in tests/interests/propose.test.ts's "threshold constants" block so a
// future change to any of these has to be a deliberate, visible edit here.
// ---------------------------------------------------------------------------

/**
 * Minimum number of saved (or dismissed) items before this pass proposes
 * ANYTHING for that direction. Chosen to match the task brief's own
 * framing of what "early" looks like ("there will be five saves, not five
 * hundred") -- five is the smallest count the brief itself treats as a real
 * signal floor, not a zero-evidence guess. Below this, `status` is
 * `'insufficient-signal'` and `candidates` is always `[]` -- this is
 * expected to be the common path for weeks after first use.
 */
export const MIN_CLASS_SIZE = 5;

/**
 * A term must appear in at least this many items of its class before it is
 * even considered, REGARDLESS of how statistically significant it looks.
 * This is the literal answer to "must not rank a term highly on two
 * occurrences": 2 is explicitly excluded, 3 is the floor. Three independent
 * items sharing a term is a materially weaker coincidence than two -- with
 * MIN_CLASS_SIZE=5, a term clearing this floor is present in a majority of
 * the (at least 5) items in its class, not a one-off.
 */
export const MIN_TERM_COUNT = 3;

/**
 * Minimum Wald z-score (see module doc comment) for a term that has
 * cleared MIN_TERM_COUNT to actually be proposed. 1.96 is the conventional
 * two-tailed 95% significance threshold -- not tuned to this dataset, a
 * standard choice so the bar isn't an arbitrary magic number.
 */
export const MIN_Z_SCORE = 1.96;

/** Haldane-Anscombe continuity correction added to every contingency-table cell. See module doc comment. */
export const CONTINUITY_CORRECTION = 0.5;

/** Real example titles shown per candidate -- enough to judge, not a wall of text. */
export const MAX_EXAMPLE_TITLES = 3;

/** Candidates are ranked by z-score and capped so the report stays readable as the corpus grows. */
export const MAX_CANDIDATES_PER_DIRECTION = 20;

/**
 * Minimum token length considered a candidate word. Below this is almost
 * always a stray letter from apostrophe/punctuation splitting, never a
 * meaningful term.
 */
const MIN_TOKEN_LENGTH = 2;

// ---------------------------------------------------------------------------
// Stopwords -- a short, standard English function-word list, in the same
// spirit and for the same reason as src/cluster/similarity.ts's own
// STOPWORDS: these carry no topical content of their own, so counting them
// as "candidate terms" would just rediscover English grammar, not interest.
// Deliberately not exhaustive; hardcoded rather than config-driven, because
// (like that module's list) changing it changes what "a candidate term"
// even means -- an algorithmic detail, not a tuning knob.
// ---------------------------------------------------------------------------
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'is', 'as', 'by', 'with',
  'from', 'into', 'after', 'over', 'amid', 'its', 'it', 'be', 'are', 'was', 'were', 'that',
  'this', 'these', 'those', 'but', 'or', 'not', 'no', 'up', 'down', 'out', 'about', 'than',
  'then', 'so', 'says', 'said', 'new', 'will', 'would', 'can', 'could', 'should', 'just',
  'one', 'two', 'more', 'most', 'some', 'all', 'each', 'per', 'off', 'vs', 'you', 'your',
  'we', 'our', 'they', 'their', 'he', 'she', 'his', 'her', 'has', 'have', 'had', 'us', 'how',
  'what', 'why', 'who', 'when', 'where', 'which', 'amp', 'via', 'also', 'now', 'here', 'there',
  'if', 'do', 'does', 'did', 'been', 'being', 'i', 'am',
  // 'against' verified live: a VACUUM INTO scratch-copy run with real AP
  // sports headlines dismissed ("...against Chargers", "...against Diaz...",
  // "...against Packers") surfaced "against" itself as a suppress candidate
  // -- a preposition, not a topical word; match-report sentence structure
  // ("Team A beat Team B against/at/in ...") makes it correlate with the
  // dismissed class without meaning anything about it.
  'against',
]);

/**
 * Terms this codebase already tried and reverted, per config/interests.yaml's
 * own header ("Terms that look obvious but were deliberately EXCLUDED,
 * because real corpus data showed them actively wrong rather than merely
 * imprecise") -- reused here as a hardcoded blocklist so the same
 * false-positive-prone term doesn't get independently rediscovered by the
 * statistics and proposed right back. Keys are normalizeTermKey()'d.
 */
const KNOWN_AMBIGUOUS_TERMS = new Set(['crypto', 'opinion', 'editorial', 'ai powered', 'top 10']);

// ---------------------------------------------------------------------------
// Tokenization -- deliberately simple (no NLP library, no stemmer; see the
// module doc comment and the report for why). Splits on Unicode letter/digit
// runs, mirroring src/interests/load.ts's WORD_CHAR class so a token never
// splits in the middle of an accented letter.
// ---------------------------------------------------------------------------
const TOKEN_RE = /[\p{L}\p{N}]+/gu;

function tokenize(text: string): string[] {
  return (text.match(TOKEN_RE) ?? []).map((t) => t.toLowerCase());
}

function looksLikeBareYear(token: string): boolean {
  return /^\d+$/.test(token) && token.length === 4;
}

function isNoiseToken(token: string): boolean {
  return token.length < MIN_TOKEN_LENGTH || STOPWORDS.has(token) || looksLikeBareYear(token);
}

/**
 * Normalizes a term for identity comparison (exclusion against the existing
 * profile, and the known-ambiguous blocklist) -- lowercase, hyphens folded
 * to spaces, whitespace collapsed. Mirrors buildTermRegex's own treatment of
 * hyphen/space as interchangeable separators (src/interests/load.ts), so
 * e.g. an existing hyphenated "no-hitter" entry correctly excludes a
 * candidate generated as the space-separated bigram "no hitter".
 */
function normalizeTermKey(term: string): string {
  return term.trim().toLowerCase().replace(/[\s-]+/g, ' ');
}

/**
 * Unigram and bigram candidate terms from one item's text. Bigrams are
 * skipped if either half is a stopword (so "the prompt" never becomes a
 * candidate, only "prompt injection" would survive from "prompt injection
 * attack"-shaped text). Returned as a Set: an item containing "ollama"
 * three times in its excerpt still contributes the candidate once -- the
 * per-item match count (computed separately, against the whole corpus) is
 * what evidence is actually built from, not raw token frequency.
 */
function candidateTermsFromText(text: string): Set<string> {
  const tokens = tokenize(text);
  const candidates = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const tNoise = isNoiseToken(t);
    if (!tNoise) candidates.add(t);
    if (i + 1 < tokens.length) {
      const t2 = tokens[i + 1]!;
      if (!tNoise && !isNoiseToken(t2)) candidates.add(`${t} ${t2}`);
    }
  }
  return candidates;
}

/**
 * arXiv's own Atom feed `<summary>` begins with a fixed, machine-generated
 * preamble -- "arXiv:<id>v<n> Announce Type: <new|cross|replace...>" then a
 * literal "Abstract:" label -- before the actual abstract prose. Verified
 * live: a VACUUM INTO scratch copy of data/wf.db with a real run of five
 * saved arxiv-cs-cr papers surfaced "arxiv", "abstract", "announce", "type",
 * and the bigram "announce type" as boost candidates at z-scores of 3.2-3.2,
 * each in 5/5 saved items -- not because of anything about their TOPIC, but
 * because every one of the corpus's ~350 arXiv items (any beat) carries this
 * exact preamble, so any saved set drawn from that source looks
 * disproportionate on it. Stripped here, at the text level, rather than
 * added to STOPWORDS: unlike a stopword, "type" or "abstract" are
 * legitimate words to propose if they show up in ordinary prose -- it's
 * specifically this MACHINE-GENERATED preamble that is noise, not the words
 * in general. The abstract's own body text is left fully intact and
 * searchable; only the fixed preamble in front of it is removed. This is
 * the same category of decision as src/cluster/similarity.ts's
 * "Normalization decisions, each justified against real titles" -- a
 * narrow, evidence-backed text fix, not a blanket word-level exclusion.
 */
const ARXIV_PREAMBLE_RE = /^arXiv:\S+\s+Announce Type:\s*\S+\s*\n+\s*Abstract:\s*/i;

function stripKnownFeedBoilerplate(excerpt: string): string {
  return excerpt.replace(ARXIV_PREAMBLE_RE, '');
}

// ---------------------------------------------------------------------------
// Reading item_state / interest_dismissal_signals, joined to current titles
// and stored excerpts (summary_raw).
// ---------------------------------------------------------------------------

interface ItemText {
  itemKey: string;
  title: string;
  /** title + " " + summary_raw (the stored excerpt), the searchable text a candidate term is matched against. */
  text: string;
  savedAt: string | null;
  readAt: string | null;
}

/**
 * One row per distinct item_key, its CURRENT version's title/excerpt (same
 * `row_number() over (partition by item_key order by fetched_at desc, rowid
 * desc)` tie-break as src/cluster/store.ts's getCurrentTitlesForClustering
 * and src/domain/item.ts's getCurrentItem), left-joined to item_state so an
 * item with no item_state row at all (never read/saved/dismissed -- the
 * common case) still comes back with saved_at/read_at simply null rather
 * than being dropped.
 */
function readCurrentItemTexts(db: Db): ItemText[] {
  const rows = db
    .prepare(
      `select cur.item_key as item_key, cur.title as title, cur.summary_raw as summary_raw,
              st.saved_at as saved_at, st.read_at as read_at
       from (
         select item_key, title, summary_raw,
                row_number() over (
                  partition by item_key
                  order by fetched_at desc, rowid desc
                ) as rn
         from items
       ) cur
       left join item_state st on st.item_key = cur.item_key
       where cur.rn = 1`,
    )
    // Inline type literal, not a named interface -- same node:sqlite TS2352
    // cast-shape precedent as src/cluster/store.ts and src/domain/itemState.ts.
    .all() as Array<{
    item_key: string;
    title: string;
    summary_raw: string | null;
    saved_at: string | null;
    read_at: string | null;
  }>;

  return rows.map((r) => ({
    itemKey: r.item_key,
    title: r.title,
    text: r.summary_raw ? `${r.title} ${stripKnownFeedBoilerplate(r.summary_raw)}` : r.title,
    savedAt: r.saved_at,
    readAt: r.read_at,
  }));
}

/**
 * Distinct item_keys ever dismissed, read from `interest_dismissal_signals`
 * (db/migrations/0004) -- the append-only negative-signal log the task
 * explicitly names, rather than item_state.dismissed_at. The two are
 * equivalent in membership (dismissItem writes both atomically, and
 * dismissal never reverses -- src/domain/itemState.ts), but reading the
 * purpose-built log keeps this module honest about which table it was told
 * is the negative signal.
 */
function readDismissedItemKeys(db: Db): Set<string> {
  const rows = db.prepare('select distinct item_key from interest_dismissal_signals').all() as Array<{
    item_key: string;
  }>;
  return new Set(rows.map((r) => r.item_key));
}

function buildExistingTermKeySet(profile: InterestProfile): Set<string> {
  const keys = new Set<string>();
  for (const { term } of profile.boosts) keys.add(normalizeTermKey(term));
  for (const { term } of profile.suppressions) keys.add(normalizeTermKey(term));
  return keys;
}

// ---------------------------------------------------------------------------
// The statistic.
// ---------------------------------------------------------------------------

function laplaceLogOddsZ(
  classCount: number,
  classTotal: number,
  otherCount: number,
  otherTotal: number,
): { logOddsRatio: number; zScore: number } {
  const a = classCount + CONTINUITY_CORRECTION;
  const b = classTotal - classCount + CONTINUITY_CORRECTION;
  const c = otherCount + CONTINUITY_CORRECTION;
  const d = otherTotal - otherCount + CONTINUITY_CORRECTION;

  const logOddsRatio = Math.log(a / b) - Math.log(c / d);
  const variance = 1 / a + 1 / b + 1 / c + 1 / d;
  const zScore = logOddsRatio / Math.sqrt(variance);

  return { logOddsRatio, zScore };
}

export interface CandidateEvidence {
  term: string;
  /** Items in the class of interest (saved, or dismissed) containing the term. */
  classCount: number;
  /** Total items in the class of interest. */
  classTotal: number;
  /** Items outside the class containing the term. */
  otherCount: number;
  /** Total items outside the class. */
  otherTotal: number;
  logOddsRatio: number;
  zScore: number;
  /** Up to MAX_EXAMPLE_TITLES real titles from the class where the term matched. */
  exampleTitles: string[];
}

/**
 * Candidates for one direction (boost from saved, or suppress from
 * dismissed). Vocabulary is drawn ONLY from the class's own text -- not the
 * whole corpus -- both for performance (bounded by what a still-small saved/
 * dismissed set actually contains, not by the full item corpus) and because
 * a term that never appears in the class at all can never be "over-
 * represented" in it. `otherItems` supplies the background rate every
 * candidate is compared against. Matching is done via buildTermRegex
 * (src/interests/load.ts) -- the SAME whole-word, Unicode-aware, hyphen/
 * space-interchangeable matcher the mechanical scorer uses -- not a second,
 * independently-written matcher.
 */
function computeDirectionCandidates(
  classItems: ItemText[],
  otherItems: ItemText[],
  excludedKeys: Set<string>,
): CandidateEvidence[] {
  const classTotal = classItems.length;
  const otherTotal = otherItems.length;

  const candidateTerms = new Set<string>();
  for (const item of classItems) {
    for (const term of candidateTermsFromText(item.text)) candidateTerms.add(term);
  }

  const results: CandidateEvidence[] = [];
  for (const term of candidateTerms) {
    const key = normalizeTermKey(term);
    if (excludedKeys.has(key) || KNOWN_AMBIGUOUS_TERMS.has(key)) continue;

    const regex = buildTermRegex(term);
    const matchingClassItems = classItems.filter((it) => regex.test(it.text));
    const classCount = matchingClassItems.length;
    // Hard floor, independent of the statistic below -- see MIN_TERM_COUNT's doc comment.
    if (classCount < MIN_TERM_COUNT) continue;

    const otherCount = otherItems.filter((it) => regex.test(it.text)).length;
    const { logOddsRatio, zScore } = laplaceLogOddsZ(classCount, classTotal, otherCount, otherTotal);
    if (zScore < MIN_Z_SCORE) continue;

    results.push({
      term,
      classCount,
      classTotal,
      otherCount,
      otherTotal,
      logOddsRatio,
      zScore,
      exampleTitles: matchingClassItems.slice(0, MAX_EXAMPLE_TITLES).map((it) => it.title),
    });
  }

  results.sort((x, y) => y.zScore - x.zScore);
  return results.slice(0, MAX_CANDIDATES_PER_DIRECTION);
}

// ---------------------------------------------------------------------------
// Per-direction gating + the top-level report.
// ---------------------------------------------------------------------------

export interface DirectionResult {
  status: 'ok' | 'insufficient-signal';
  /** Number of items currently in this direction's class (saved, or dismissed). */
  classSize: number;
  minRequired: number;
  message: string;
  candidates: CandidateEvidence[];
}

type Direction = 'boost' | 'suppress';

function directionNoun(direction: Direction): string {
  return direction === 'boost' ? 'saved' : 'dismissed';
}

function buildDirectionResult(
  direction: Direction,
  classItems: ItemText[],
  otherItems: ItemText[],
  excludedKeys: Set<string>,
): DirectionResult {
  const classSize = classItems.length;
  const noun = directionNoun(direction);

  if (classSize < MIN_CLASS_SIZE) {
    const remaining = MIN_CLASS_SIZE - classSize;
    return {
      status: 'insufficient-signal',
      classSize,
      minRequired: MIN_CLASS_SIZE,
      message:
        `Not enough signal yet: only ${classSize} ${noun} item(s) so far. ` +
        `Come back after at least ${remaining} more ${noun} item(s) -- ` +
        `${direction} terms need at least ${MIN_CLASS_SIZE} ${noun} items before this pass will propose anything.`,
      candidates: [],
    };
  }

  const candidates = computeDirectionCandidates(classItems, otherItems, excludedKeys);
  return {
    status: 'ok',
    classSize,
    minRequired: MIN_CLASS_SIZE,
    message:
      candidates.length > 0
        ? `${candidates.length} candidate ${direction} term(s) found from ${classSize} ${noun} item(s).`
        : `${classSize} ${noun} item(s) is enough to look, but no term cleared the evidence bar ` +
          `(at least ${MIN_TERM_COUNT} occurrences and a z-score of at least ${MIN_Z_SCORE}). ` +
          `Expected with a small or varied sample -- not an error.`,
    candidates,
  };
}

export interface ProposalReport {
  generatedAt: string;
  /** Total distinct items currently in the corpus (any interaction state). */
  corpusSize: number;
  savedCount: number;
  dismissedCount: number;
  readCount: number;
  boosts: DirectionResult;
  suppressions: DirectionResult;
  /** Always non-empty -- see the module doc comment and CLAUDE.md's honesty requirements. */
  caveats: string[];
}

const ECHO_CHAMBER_CAVEAT =
  'Echo-chamber risk: these boost proposals are derived only from what you already saved, so accepting all of ' +
  'them will narrow the feed toward what you already like over time. The seed terms already in ' +
  'config/interests.yaml came from the brief, not from behavior -- that difference is worth preserving. Weigh ' +
  'each proposal, don’t rubber-stamp the list.';

const BLIND_SPOT_CAVEAT =
  'Blind spot: dismissal is logged, but ignoring an item is not. An item you scrolled past without dismissing ' +
  'leaves no trace here, so its absence from the dismissed set is not evidence you liked it -- only that you did ' +
  'not actively reject it.';

function readSignalCaveat(readCount: number): string {
  return (
    `${readCount} item(s) have been read but not necessarily saved or dismissed. read_at is treated as a weak ` +
    `signal only and is reported here for context -- it does not drive either computation above, because ` +
    `opening an item is much weaker evidence of interest than deliberately saving it.`
  );
}

/**
 * Reads item_state and interest_dismissal_signals, and proposes boost/
 * suppress term candidates. Read-only: issues no writes to the database and
 * (mechanically proven, not just by omission of an import -- see
 * tests/interests/propose.test.ts) never touches config/interests.yaml.
 * `generatedAt` is caller-supplied, matching every other domain module's
 * "now is always injected" convention (src/domain/itemState.ts) even though
 * this module writes nothing -- it keeps the function pure and deterministic
 * for tests.
 */
export function proposeInterestTerms(db: Db, profile: InterestProfile, generatedAt: string): ProposalReport {
  const allItems = readCurrentItemTexts(db);
  const dismissedKeys = readDismissedItemKeys(db);
  const existingKeys = buildExistingTermKeySet(profile);

  const savedItems = allItems.filter((it) => it.savedAt !== null);
  const nonSavedItems = allItems.filter((it) => it.savedAt === null);
  const dismissedItems = allItems.filter((it) => dismissedKeys.has(it.itemKey));
  const nonDismissedItems = allItems.filter((it) => !dismissedKeys.has(it.itemKey));
  const readCount = allItems.filter((it) => it.readAt !== null).length;

  const boosts = buildDirectionResult('boost', savedItems, nonSavedItems, existingKeys);
  const suppressions = buildDirectionResult('suppress', dismissedItems, nonDismissedItems, existingKeys);

  const caveats = [BLIND_SPOT_CAVEAT, ECHO_CHAMBER_CAVEAT];
  if (readCount > 0) caveats.push(readSignalCaveat(readCount));

  return {
    generatedAt,
    corpusSize: allItems.length,
    savedCount: savedItems.length,
    dismissedCount: dismissedItems.length,
    readCount,
    boosts,
    suppressions,
    caveats,
  };
}

// ---------------------------------------------------------------------------
// Human-readable formatting -- a copy-pasteable YAML snippet per candidate.
// The weight is a bound-compliant PLACEHOLDER (1.0, the file's own
// documented "weakest signal" band), never a claim of importance: this
// module proposes terms with evidence, it does not judge them (CLAUDE.md /
// task honesty requirements -- "never claim a term is good").
// ---------------------------------------------------------------------------

function formatCandidate(direction: Direction, c: CandidateEvidence): string {
  const classLabel = direction === 'boost' ? 'saved' : 'dismissed';
  const lines = [
    `  "${c.term}" -- in ${c.classCount}/${c.classTotal} ${classLabel} item(s), vs ${c.otherCount}/${c.otherTotal} elsewhere ` +
      `(log-odds=${c.logOddsRatio.toFixed(2)}, z=${c.zScore.toFixed(2)})`,
    ...c.exampleTitles.map((t) => `    e.g. "${t}"`),
    `    -- copy into config/interests.yaml under \`${direction === 'boost' ? 'boosts' : 'suppressions'}:\`:`,
    `      - term: "${c.term}"`,
    `        weight: 1.0  # placeholder -- pick 0.1-2.0 yourself; this pass does not judge specificity/ambiguity`,
  ];
  return lines.join('\n');
}

function formatDirection(direction: Direction, result: DirectionResult): string {
  const label = direction === 'boost' ? 'BOOST candidates (from saved)' : 'SUPPRESS candidates (from dismissed)';
  const lines = [`${label}: ${result.message}`];
  for (const c of result.candidates) lines.push(formatCandidate(direction, c));
  return lines.join('\n');
}

/** Renders a ProposalReport as human-readable text for the CLI. Pure formatting -- no I/O. */
export function formatProposalReport(report: ProposalReport): string {
  const lines = [
    `interest-profile proposals -- generated ${report.generatedAt}`,
    `corpus: ${report.corpusSize} item(s) -- saved=${report.savedCount} dismissed=${report.dismissedCount} read=${report.readCount}`,
    '',
    formatDirection('boost', report.boosts),
    '',
    formatDirection('suppress', report.suppressions),
    '',
    'Notes:',
    ...report.caveats.map((c) => `  - ${c}`),
  ];
  return lines.join('\n');
}
