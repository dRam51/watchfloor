import { describe, it, expect } from 'vitest';
import {
  normalizeTitle,
  titleTokens,
  trigramsOfTokens,
  titleTrigrams,
  jaccardSimilarity,
  trigramJaccard,
} from '../../src/cluster/similarity.ts';

// ---------------------------------------------------------------------------
// normalizeTitle -- case, punctuation, the em-dash/quote characters that show
// up in the real M2 task-4 brief examples and in the real corpus itself
// (verified against attic/wf-m1-firstrun-2026-08-14.db, read-only, never
// opened by this file -- see the "REAL CORPUS" describe blocks below for the
// titles copied out of it by hand).
// ---------------------------------------------------------------------------
describe('normalizeTitle', () => {
  it('lowercases', () => {
    expect(normalizeTitle('Kennedy Center Board')).toBe('kennedy center board');
  });

  it('deletes a straight apostrophe with no space, collapsing a possessive into one token', () => {
    expect(normalizeTitle("Trump's name")).toBe('trumps name');
  });

  it('deletes a curly right single quote (U+2019) identically to a straight apostrophe', () => {
    // Real: 6 of the 180 usnews titles in the M1 corpus use U+2019 for a
    // possessive ("Nevada’s", "Trump’s", "Shakur’s", ...). A
    // title normalized one way and its cross-source paraphrase normalized the
    // other way must still line up token-for-token, or the two would fail to
    // match purely because of which apostrophe glyph a wire service happened
    // to emit that day -- not because of any real difference in wording.
    expect(normalizeTitle('Trump’s name')).toBe(normalizeTitle("Trump's name"));
    expect(normalizeTitle('Trump’s name')).toBe('trumps name');
  });

  it('turns an em dash (U+2014) into a word boundary, not a joiner', () => {
    // Real: "Kennedy Center Board votes again to shut main building down —
    // and add Trump's name back" (npr-news). An em dash here separates two
    // independent clauses -- treating it as a joiner would glue "down" to
    // "and" into one nonsense token.
    expect(normalizeTitle('shut main building down — and add')).toBe('shut main building down and add');
  });

  it('turns an en dash (U+2013) into a word boundary too', () => {
    expect(normalizeTitle('pages 10–20')).toBe('pages 10 20');
  });

  it('turns a hyphen-minus into a word boundary, same as the dash family', () => {
    // Mirrors the boundary treatment src/interests/load.ts already settled on
    // for hyphens in Task 1 of this same milestone -- one mental model for
    // "is a hyphen a joiner or a separator" across the M2 config tree, rather
    // than a different answer per module. A compound like "no-hitter" becomes
    // two tokens ("no", "hitter"); nothing in this module tries to recognize
    // compounds as a special case.
    expect(normalizeTitle('a two-year closure')).toBe('a two year closure');
  });

  it('turns other punctuation (colon, comma, period, quotes, slash, ampersand, dollar) into word boundaries', () => {
    expect(normalizeTitle("'Act of terror': U.S. condemns")).toBe('act of terror u s condemns');
    expect(normalizeTitle('6 2/3 innings')).toBe('6 2 3 innings');
    expect(normalizeTitle('Red Sox, Blue Jays')).toBe('red sox blue jays');
    expect(normalizeTitle('$19B-$26 billion')).toBe('19b 26 billion');
  });

  it('is Unicode-aware: an accented letter is kept as a letter, not treated as punctuation', () => {
    // Real ap-news title: "Bears evalúan 2 sitios para estadio en Indiana".
    // This module does not attempt cross-language matching (see the module
    // doc comment and the report), but it must not mangle non-English text
    // internally either -- an ASCII-only [^a-z0-9\s] class would have turned
    // "evalúan" into "eval an", inventing a word split that isn't there.
    expect(normalizeTitle('Bears evalúan 2 sitios')).toBe('bears evalúan 2 sitios');
  });

  it('collapses repeated whitespace produced by adjacent punctuation, and trims', () => {
    expect(normalizeTitle('  "Act of terror":   U.S. condemns...  ')).toBe('act of terror u s condemns');
  });

  it('is idempotent -- normalizing an already-normalized title is a no-op', () => {
    const once = normalizeTitle("'Act of terror': U.S. condemns — Israel's role");
    expect(normalizeTitle(once)).toBe(once);
  });
});

// ---------------------------------------------------------------------------
// titleTokens -- normalization + whitespace split + stopword removal.
// ---------------------------------------------------------------------------
describe('titleTokens', () => {
  it('splits normalized text on whitespace', () => {
    expect(titleTokens('kennedy center board')).toEqual(['kennedy', 'center', 'board']);
  });

  it('drops stopwords', () => {
    // "a", "the", "of", "in", "and", "to" are all stopwords; the content
    // words survive in order.
    expect(titleTokens('the drone strikes on the refinery in Russia and Crimea')).toEqual([
      'drone',
      'strikes',
      'refinery',
      'russia',
      'crimea',
    ]);
  });

  it('is case-insensitive for stopword matching (normalizeTitle already lowercased)', () => {
    expect(titleTokens('The Kennedy Center')).toEqual(['kennedy', 'center']);
  });

  it('returns an empty array for a title that normalizes to nothing (all punctuation)', () => {
    expect(titleTokens('...')).toEqual([]);
  });

  it('returns an empty array for a title that is entirely stopwords', () => {
    expect(titleTokens('a the of')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// trigramsOfTokens -- the shingling step. n = 3 always (this module computes
// TRIgram Jaccard, not a configurable n-gram size); shingle size degrades
// gracefully to min(3, tokens.length) for short inputs rather than crashing
// or producing an empty set for every title under 3 tokens.
// ---------------------------------------------------------------------------
describe('trigramsOfTokens', () => {
  it('produces one 3-word shingle per sliding window, joined with a single space', () => {
    const tokens = ['kennedy', 'center', 'board', 'moves', 'forward'];
    // 5 tokens -> 3 windows of size 3: [0,1,2], [1,2,3], [2,3,4]
    expect(trigramsOfTokens(tokens)).toEqual(
      new Set(['kennedy center board', 'center board moves', 'board moves forward']),
    );
  });

  it('a set, not a list -- a repeated shingle counts once', () => {
    // 6 tokens -> 4 windows: [0,1,2]="a b a", [1,2,3]="b a b", [2,3,4]="a b a"
    // (repeat of the first window), [3,4,5]="b a b" (repeat of the second).
    // Only 2 DISTINCT shingles, even though 4 windows were slid.
    const tokens = ['a', 'b', 'a', 'b', 'a', 'b'];
    expect(trigramsOfTokens(tokens).size).toBe(2);
    expect(trigramsOfTokens(tokens)).toEqual(new Set(['a b a', 'b a b']));
  });

  it('degrades to a single whole-sequence shingle for exactly 2 tokens', () => {
    expect(trigramsOfTokens(['kennedy', 'center'])).toEqual(new Set(['kennedy center']));
  });

  it('degrades to a single one-token shingle for exactly 1 token', () => {
    expect(trigramsOfTokens(['kennedy'])).toEqual(new Set(['kennedy']));
  });

  it('returns an empty set for zero tokens, not a crash', () => {
    expect(trigramsOfTokens([])).toEqual(new Set());
  });

  it('exactly 3 tokens produces exactly 1 shingle (the whole thing)', () => {
    expect(trigramsOfTokens(['a', 'b', 'c'])).toEqual(new Set(['a b c']));
  });
});

// ---------------------------------------------------------------------------
// jaccardSimilarity -- the generic set-similarity primitive. Deliberately
// untyped to titles: takes any Set<string>, so it is testable (and reusable)
// independent of the title-specific pipeline above it.
// ---------------------------------------------------------------------------
describe('jaccardSimilarity', () => {
  it('is 1 for two identical non-empty sets', () => {
    expect(jaccardSimilarity(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
  });

  it('is 0 for two disjoint non-empty sets', () => {
    expect(jaccardSimilarity(new Set(['a', 'b']), new Set(['c', 'd']))).toBe(0);
  });

  it('is intersection/union for a partial overlap', () => {
    // {a,b,c} ∩ {b,c,d} = {b,c} (2); {a,b,c} ∪ {b,c,d} = {a,b,c,d} (4)
    expect(jaccardSimilarity(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))).toBe(2 / 4);
  });

  it('is 0, not NaN or 1, when both sets are empty', () => {
    // 0/0 is mathematically undefined; this module resolves it toward the
    // conservative reading ("no evidence of similarity was found") rather
    // than the permissive one ("identical"), consistent with this task's
    // "prefer under-clustering" mandate -- an accidental empty/empty
    // collision (e.g. two titles that are both pure punctuation) must not
    // silently read as a perfect match.
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });

  it('is symmetric', () => {
    const a = new Set(['a', 'b', 'c']);
    const b = new Set(['b', 'c', 'd', 'e']);
    expect(jaccardSimilarity(a, b)).toBe(jaccardSimilarity(b, a));
  });
});

// ---------------------------------------------------------------------------
// titleTrigrams -- the composed pipeline (normalize -> tokenize -> shingle),
// exposed on its own so a caller (e.g. the clustering/grouping step) can
// compute a title's shingle set once and reuse it across many comparisons
// instead of re-normalizing on every pairwise call.
// ---------------------------------------------------------------------------
describe('titleTrigrams', () => {
  it('equals trigramsOfTokens(titleTokens(title))', () => {
    const title = "Kennedy Center Board votes again to shut main building down — and add Trump's name back";
    expect(titleTrigrams(title)).toEqual(trigramsOfTokens(titleTokens(title)));
  });
});

// ---------------------------------------------------------------------------
// trigramJaccard -- REAL CORPUS validation.
//
// Every title below is copied BY HAND, verbatim (including the exact
// apostrophe/dash glyphs), from attic/wf-m1-firstrun-2026-08-14.db
// (read-only, never opened by this test -- see CLAUDE.md's warning on that
// file). Source query used to pull usnews titles:
//
//   sqlite3 -readonly attic/wf-m1-firstrun-2026-08-14.db \
//     "select source_id, title from items
//      where source_id in ('ap-news','npr-news','pbs-newshour')"
//
// Every expected score below is the EXACT intersection/union fraction,
// independently hand-derived from this module's own spec (normalize ->
// lowercase, delete apostrophes, dash family and all other punctuation to
// spaces, collapse whitespace -> split on whitespace -> drop stopwords ->
// 3-word sliding-window shingles -> Jaccard), not copied from a prior run of
// the implementation. See task-4-report.md for the full token-by-token
// derivation of each fraction below.
// ---------------------------------------------------------------------------
describe('trigramJaccard -- the five real cases from the task brief', () => {
  it('PAIR 1 (should cluster): settler siege, npr-news vs pbs-newshour -- 2/17', () => {
    const npr = "U.S. ambassador calls settler siege of Palestinian homes a 'horrific act of terror'";
    const pbs = "'Act of terror': U.S. condemns Israeli settler siege of Palestinian homes in West Bank";
    // npr tokens (11, stopwords "of"x1 dropped -- "a" dropped):
    //   u s ambassador calls settler siege palestinian homes horrific act terror
    // pbs tokens (12, "of" and "in" dropped):
    //   act terror u s condemns israeli settler siege palestinian homes west bank
    // Shared trigrams: "u s ambassador"? no -- walk the windows: npr windows
    // are {u s ambassador, s ambassador calls, ambassador calls settler,
    // calls settler siege, settler siege palestinian, siege palestinian homes,
    // palestinian homes horrific, homes horrific act, horrific act terror} (9,
    // since 11 tokens -> 9 windows). pbs windows (12 tokens -> 10 windows):
    // {act terror u, terror u s, u s condemns, s condemns israeli, condemns
    // israeli settler, israeli settler siege, settler siege palestinian, siege
    // palestinian homes, palestinian homes west, homes west bank}. Shared:
    // "settler siege palestinian", "siege palestinian homes" = 2. Union = 9 +
    // 10 - 2 = 17.
    expect(trigramJaccard(npr, pbs)).toBeCloseTo(2 / 17, 12);
  });

  it('PAIR 2 (should cluster): Mangione, npr-news vs pbs-newshour -- 2/16', () => {
    const npr = 'Mangione could plead guilty in federal case ahead of N.Y. murder trial';
    const pbs = 'AP report: Luigi Mangione expected to plead guilty in federal case over CEO killing';
    expect(trigramJaccard(npr, pbs)).toBeCloseTo(2 / 16, 12);
  });

  it('PAIR 3 (the hard one -- MISSED at the chosen threshold): Kennedy Center, npr-news vs pbs-newshour -- 1/17', () => {
    const npr = "Kennedy Center Board votes again to shut main building down — and add Trump's name back";
    const pbs = 'Kennedy Center board moves forward with a two-year closure to allow for renovations';
    // The only shared trigram is "kennedy center board" itself -- the fourth
    // word diverges immediately ("votes" vs "moves") so no other window
    // lines up. This is deliberately the LOWEST-scoring of the three real
    // "should cluster" pairs -- see the group.test.ts threshold-sensitivity
    // tests and task-4-report.md for why 1/17 = 0.0588 is NOT safely
    // separable from real spurious pairs found elsewhere in the corpus.
    expect(trigramJaccard(npr, pbs)).toBeCloseTo(1 / 17, 12);
  });

  it('TRAP 4 (must NOT cluster): Ukraine drone strikes are a different event in each title -- 0/16', () => {
    const npr = "By sky and sea, Ukraine's drone strikes challenge Russia's grip on Crimea";
    const pbs = 'Ukrainian drones strike major oil refinery deep inside Russia, setting it ablaze';
    // Heavy topical overlap (Ukraine, drones, Russia) but NO shared inflected
    // form survives verbatim: "Ukraine's"/"Ukrainian", "drone"/"drones",
    // "strikes"/"strike" are all different literal tokens after
    // normalization, so zero windows can possibly align. This module does no
    // stemming (see the module doc comment) -- that is exactly what keeps
    // this trap at a real, provable 0, not a "low but nonzero" score that
    // could drift above threshold on a bad config change.
    expect(trigramJaccard(npr, pbs)).toBe(0);
  });

  it('TRAP 5 (must NOT cluster): same source, same underlying event, different angle -- 0/18', () => {
    const pbsA = "'Act of terror': U.S. condemns Israeli settler siege of Palestinian homes in West Bank";
    const pbsB = 'Palestinian American family recounts siege of West Bank home by Israeli settlers';
    // Judgment call (see task-4-report.md "Trap 5"): a condemnation story and
    // a first-person family-recounts-it story about the same underlying
    // event are NOT merged here. Shared vocabulary ("Palestinian", "siege",
    // "West Bank", "Israeli", "settlers") never lands three-in-a-row in the
    // same order in both titles, so the trigram signal is genuinely zero --
    // this is not a threshold call, the two titles share no 3-word phrase at
    // all once tokenized.
    expect(trigramJaccard(pbsA, pbsB)).toBe(0);
  });
});

describe('trigramJaccard -- bonus real cross-source pairs found during full-corpus validation (not in the original five)', () => {
  it('Mangione, ap-news (English) vs pbs-newshour -- the strongest real pair in the corpus, 3/12', () => {
    const ap = 'Luigi Mangione expected to plead guilty in killing of UnitedHealthcare CEO';
    const pbs = 'AP report: Luigi Mangione expected to plead guilty in federal case over CEO killing';
    expect(trigramJaccard(ap, pbs)).toBeCloseTo(3 / 12, 12);
  });

  it('Mangione, npr-news vs ap-news (English) -- the SAME story, direct pairwise score is exactly 0', () => {
    // Real: this is why clustering must be transitive (see group.ts and
    // group.test.ts) rather than requiring every pair within a group to
    // clear the threshold directly. npr and ap-en each independently clear
    // the threshold against pbs (see the two tests above and group.test.ts's
    // hub test) but share literally no 3-word phrase with EACH OTHER.
    const npr = 'Mangione could plead guilty in federal case ahead of N.Y. murder trial';
    const apEn = 'Luigi Mangione expected to plead guilty in killing of UnitedHealthcare CEO';
    expect(trigramJaccard(npr, apEn)).toBe(0);
  });
});

describe('trigramJaccard -- spurious-cluster risk found in AP English sports/wire copy (full-corpus sweep)', () => {
  it('two DIFFERENT WNBA box scores share the "X scores N points as/and Y ..." template -- scores exactly 0 (no false positive)', () => {
    const gameA = 'Howard, Gray each score 29 points as the Dream ease by the Sun 104-69';
    const gameB = 'Ionescu scores 20 points and Liberty avoid record collapse to hold off Sparks';
    expect(trigramJaccard(gameA, gameB)).toBe(0);
  });

  it('"AP source says" boilerplate on two UNRELATED transactions scores 1/13 -- HIGHER than pair 3, and must stay below the production threshold', () => {
    // Real, and the single most important finding against a loose threshold:
    // this spurious pair OUTSCORES the genuine Kennedy Center pair (1/17 ≈
    // 0.0588) above. Any threshold low enough to catch pair 3 directly is
    // therefore also low enough to merge these two unrelated MLB/NFL
    // transactions -- see task-4-report.md and group.test.ts's threshold
    // sensitivity tests for the full argument.
    const mariners = 'Mariners to send rookie shortstop Emerson to Triple-A, AP source says';
    const seahawks = 'Seahawks, cornerback Terrion Arnold are working on a deal, AP source says';
    expect(trigramJaccard(mariners, seahawks)).toBeCloseTo(1 / 13, 12);
    expect(trigramJaccard(mariners, seahawks)).toBeGreaterThan(1 / 17); // > pair 3's score
  });

  it('"throws TD pass" template on two DIFFERENT preseason games scores 1/18 -- also above pair 3', () => {
    const gameA = "Fernando Mendoza throws TD pass in Raiders' 27-14 loss to Cardinals in preseason game";
    const gameB = 'Flacco throws TD pass in relief of Burrow as Bengals beat Lions 16-14';
    expect(trigramJaccard(gameA, gameB)).toBeCloseTo(1 / 18, 12);
  });

  it('the AP "top photos of the day/week" recurring feature does NOT collide once stopwords are dropped', () => {
    // Without stopword removal this pair scores 0.2727 (3/11) -- higher than
    // every one of the three required true pairs, including the strongest
    // one. Dropping stopwords collapses "the top photos of the day by AP's
    // photojournalists" and "...of the week by AP photojournalists" down to
    // token streams that diverge on their very first content word after
    // "top photos" ("day"/"aps" vs "week"/"ap"), producing 0 shared
    // trigrams. See task-4-report.md for the with/without-stopwords
    // comparison in full.
    const day = "The top photos of the day by AP's photojournalists";
    const week = 'The top photos of the week by AP photojournalists';
    expect(trigramJaccard(day, week)).toBe(0);
  });
});
