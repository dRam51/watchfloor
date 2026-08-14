/**
 * item_type classification: what STRUCTURAL KIND of publication an item is
 * (event | analysis | press) -- never what to do about it, and never a
 * markets sentiment/directional signal (see the Global Constraints in
 * docs/superpowers/plans/2026-08-14-m2-scoring.md).
 *
 * ## What this replaces
 * M1's `assignItemType` (formerly src/normalize/item.ts, ~line 492) said of
 * itself: "This rule is deliberately crude -- full classification is a later
 * milestone's job (M2/M4b)." It classified `press` as a plain fallthrough:
 * anything that wasn't an explicit `tier` declaration, a government-primary
 * source, or >=400 words (measured on the feed's ORIGINAL, pre-truncation
 * summary) landed in `press`.
 *
 * ## Why that fallthrough was the real bug, not a missing detector
 * Measured against attic/wf-m1-firstrun-2026-08-14.db (3,325 real items, 17
 * sources, read-only, M1's crude rule): **1,572 of 3,325 items (47.3%) were
 * labelled `press`, and EVERY non-government-primary source had 100% (or, for
 * simonwillison, 73%) of its items land there** -- 306 arXiv cs.AI paper
 * abstracts, 841 Hugging Face blog posts, 150 AP wire stories, 100 DeepMind
 * blog posts, 48 arXiv cs.CR abstracts, and all of Krebs, BleepingComputer,
 * NPR, PBS, OWASP GenAI, Latent Space, and Hacker News. None of that is
 * churn. Two concrete mechanisms drove it, neither about the item's actual
 * content:
 *   1. `ap-news` (type: news_sitemap) and `huggingface-blog` (type: rss)
 *      carry NO summary/description field in their feeds at all --
 *      `summary_raw is null` for 100% of both sources' rows (991 items
 *      combined) in the archived corpus. Word count against a `null` summary
 *      is defined as 0, so these landed in `press` regardless of the
 *      underlying article's substance -- a feed-FORMAT artifact, not a
 *      property of the content.
 *   2. An arXiv abstract, or a short practitioner blog excerpt, is routinely
 *      150-300 words -- well short of 400 -- while still being exactly the
 *      substantive research/analysis content this dashboard exists to
 *      surface. `simonwillison`'s own split under the old rule (8 items >=
 *      400 words -> analysis, 22 items < 400 words -> press, all from the
 *      SAME practitioner blog) is the clearest single proof that word count
 *      was never measuring "is this churn" -- it was measuring "did this
 *      RSS excerpt happen to run long."
 * Given `press` is specified to be "suppressed in both views" (M2 plan,
 * "What M1 handed forward"), shipping the old rule into M2 unchanged would
 * have suppressed roughly half the corpus -- including frontier-model launch
 * posts ("Introducing Gemini 3.7 Flash"), respected security journalism
 * (Krebs, BleepingComputer), and public-service wire news (NPR, PBS, AP) --
 * which is close to the opposite of this dashboard's purpose.
 *
 * ## What "churn" actually means here, and what does NOT work
 * Two heuristics were tried against the real corpus and REJECTED before this
 * one shipped, both for the same underlying reason Task 1 already found with
 * the interest profile's suppression terms: this domain's legitimate content
 * and actual press-release language overlap too much for a topic- or
 * verb-based proxy to be safe.
 *
 *   - **Announcement-verb titles** ("announces", "unveils", "introducing").
 *     Checked against the real corpus: `deepmind-blog` alone has 10 titles
 *     matching, including "Introducing Gemini 3.7 Flash" and "Introducing
 *     Google Antigravity" -- DeepMind's own house style for flagship model
 *     launches, exactly the highest-value content the `ai` beat exists to
 *     surface. `huggingface-blog` has 77 such titles, e.g. "Introducing
 *     AnyLanguageModel: One API for Local and Remote LLMs on Apple
 *     Platforms" -- an ordinary open-source tooling post. An announcement
 *     verb is simply how this entire domain writes headlines for real
 *     releases; it is not evidence of promotional churn. (Same failure shape
 *     as Task 1's "AI-powered", which matched legitimate ai/aisec research
 *     headlines as often as actual promotional copy and shipped with zero
 *     seed terms as a result -- see config/interests.yaml's header and
 *     task-1-report.md. That module owns funding-round language
 *     ("Series A/B/C", "seed funding", "funding round") as a SUPPRESSION
 *     term already; this classifier does not re-detect it, because that is a
 *     topical "do I care about this" question the interest profile already
 *     answers, not a structural "what kind of publication is this" question.)
 *   - **A bare wire-service dateline** ("CITY, Month Day, Year --" opening
 *     the body text). Checked against the real corpus with a dedicated
 *     regex: zero matches anywhere in 3,325 items. But the dateline
 *     convention is not exclusive to promotional press releases -- it is the
 *     shared print-teletype-era convention of ALL wire-distributed copy,
 *     including legitimate AP/Reuters/UPI journalism ("WASHINGTON (AP) --",
 *     "NEW YORK, Aug 14 --"). `ap-news` is exactly the source this would
 *     eventually threaten: it is a weight-1.8, top-tier-trust usnews source
 *     that currently carries no body text at all (its `news_sitemap` feed
 *     structurally has none), so the collision is not live today -- but the
 *     moment that adapter or a similar wire source starts carrying real
 *     dateline-formatted lede text, a bare dateline check would suppress
 *     exactly the trusted wire journalism this dashboard most wants.
 *     Rejected pre-emptively on that structural reasoning, the same way
 *     Task 1 pre-emptively excluded bare "opinion" over its collision with
 *     legitimate SCOTUS/appellate opinion coverage -- a reasoned, plausible
 *     collision with high-value content is excluded here even without a
 *     currently-live example, not only after one is observed.
 *
 * ## What DOES work: a mechanical wire-syndication fingerprint
 * {@link isPressReleaseChurn} looks for two kinds of signal that are, as far
 * as this corpus and reasoning can show, specific to actual press-release
 * distribution and have no legitimate-content collision:
 *   1. The three current major press-release distribution wires' own brand
 *      tokens (PR Newswire, Business Wire, GlobeNewswire, both spelled-out
 *      and concatenated forms) -- proper nouns unique to the PR distribution
 *      industry.
 *   2. Boilerplate legal/IR phrases that are near-universal in actual
 *      corporate press releases and have no ordinary-English collision:
 *      "forward-looking statements", "safe harbor statement", "for
 *      immediate release". ("safe harbor" ALONE was considered and rejected
 *      -- it is also generic tax/privacy-policy legal vocabulary (a "safe
 *      harbor provision"); the full three-word phrase is what's specific to
 *      a press release's standard legal notice.)
 *
 * **Honest result on the real corpus: zero matches.** None of the 17
 * configured sources are actual press-release distribution wires -- they are
 * research-lab blogs, practitioner blogs, wire news services, academic
 * preprints, security research, government primaries, and a community-voted
 * aggregator. This is the same situation as the M2 plan's two hard-override
 * categories with no reachable source (Juniper SIRT, NWS) and Task 1's
 * press-release suppression category, which shipped with zero seed terms:
 * the mechanism is real, tested against constructed fixtures shaped like
 * genuine press releases, and ready to fire the moment a source that
 * actually carries wire-syndicated content is added -- not faked to produce
 * output on data that doesn't contain what it's looking for.
 *
 * ## Why word count was removed entirely, not just recalibrated
 * Once `press` requires positive structural evidence and everything else
 * defaults to `analysis` (see below), a word-count threshold has nothing
 * left to discriminate: it previously separated "long -> analysis" from
 * "short -> press", but both outcomes are now `analysis` regardless of
 * length. Keeping it would be dead logic. It is also the one M1 signal that
 * genuinely cannot be reproduced faithfully against already-stored data:
 * `items.summary_raw` is truncated to 300 characters at insert time
 * (src/normalize/item.ts's `truncateSummary`), so a word count taken from
 * stored data is a lower bound, not the true count M1 measured pre-
 * truncation. Verified directly: reproducing M1's word-count rule against
 * `summary_raw` (instead of the original untruncated summary M1 actually
 * used) disagrees with the real stored `item_type` for exactly the 8
 * `simonwillison` items whose true summaries crossed 400 words but whose
 * stored, truncated summaries no longer do. Removing word count as a
 * classification input sidesteps that lossiness entirely rather than
 * building on top of it.
 *
 * @see ../../.superpowers/sdd/2026-08-14-m2-scoring/task-7-report.md for the
 * full architectural decision (why this is an insert-time-only refinement,
 * not a read-time reclassification path), the per-source relabelling
 * measurements, and what the decay integration (src/score/decay.ts, not
 * modified by this module) needs from this function.
 */

import type { ItemType } from '../domain/item.ts';
import type { Source } from '../sources/load.ts';

// ---------------------------------------------------------------------------
// event: government-primary sources.
//
// Moved verbatim from src/normalize/item.ts's old `assignItemType` (M1 task
// 4 / fix round 1 finding 2) -- unchanged in every particular (the exact id
// set, the cisa- prefix rule, the precedence ahead of the churn check below).
// This half of the old rule was never the problem: cisa-kev (1,665 items),
// cisa-advisories (30), federal-register (20), and whitehouse-actions (30)
// are 100% correctly `event` in the real corpus, both before and after this
// refinement -- see task-7-report.md's per-source table.
// ---------------------------------------------------------------------------

const GOVERNMENT_PRIMARY_IDS = new Set([
  'federal-register',
  'whitehouse-actions',
  'scotus-slip',
  'nws-fl-alerts',
  'nvd-cve',
]);

export function isGovernmentPrimary(sourceId: string): boolean {
  return GOVERNMENT_PRIMARY_IDS.has(sourceId) || sourceId.startsWith('cisa-');
}

// ---------------------------------------------------------------------------
// press: the real churn signal. See the module doc comment above for the
// full real-corpus reasoning behind exactly this list and nothing more.
// ---------------------------------------------------------------------------

// The three current major press-release distribution wires. Deliberately
// small: each is a proper noun specific to the PR distribution industry, not
// padded with smaller/regional/defunct wires "for completeness" the way Task
// 1's config/interests.yaml deliberately avoided padding its term lists
// without real-corpus or structural justification. Grows the moment a real
// hit or a structurally-certain gap (like Task 1's Juniper/NWS overrides)
// justifies an addition.
const WIRE_SERVICE_TOKENS = [
  'prnewswire',
  'pr newswire',
  'business wire',
  'businesswire',
  'globenewswire',
  'globe newswire',
];

// Standard corporate/IR legal boilerplate. Full phrases only -- "safe
// harbor" alone was tried and rejected (collides with generic tax/privacy
// "safe harbor provision" language); "release" alone was never considered
// (collides with ordinary software/product "release notes" usage).
const BOILERPLATE_PHRASES = ['forward-looking statements', 'safe harbor statement', 'for immediate release'];

/**
 * True if `title` or `summary` carries a mechanical fingerprint of
 * press-release wire syndication -- a named distribution wire's own brand
 * token, or one of the three standard corporate/IR legal-boilerplate
 * phrases. Checked as plain case-insensitive substring containment: unlike
 * Task 1's short acronym terms ("eval", "RAG", "MCP", "BGP"), every token
 * and phrase here is long and specific enough (a multi-word brand name or a
 * three-to-four-word legal phrase) that no whole-word/Unicode-boundary
 * machinery is needed -- there is no plausible English word or identifier
 * that contains "forward-looking statements" or "globenewswire" as an
 * accidental substring.
 *
 * `summary` is checked when present; a `null` summary (real for ap-news and
 * huggingface-blog, whose feeds carry no description field at all -- see
 * module doc comment) falls back to checking `title` alone rather than
 * treating the absence of a summary as evidence of anything.
 */
export function isPressReleaseChurn(title: string, summary: string | null): boolean {
  const haystacks = summary === null ? [title] : [title, summary];
  for (const text of haystacks) {
    const lower = text.toLowerCase();
    for (const token of WIRE_SERVICE_TOKENS) {
      if (lower.includes(token)) return true;
    }
    for (const phrase of BOILERPLATE_PHRASES) {
      if (lower.includes(phrase)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// classifyItemType: the composed rule.
// ---------------------------------------------------------------------------

/**
 * Classifies what kind of item this is: `event` (official/primary-source
 * declaration), `analysis` (everything else, by default), or `press` (a
 * mechanically-detected wire-syndication churn signature).
 *
 * Precedence, identical in shape to M1's rule and for the same reason in
 * every case: an explicit operator declaration (`source.tier`) outranks a
 * source-identity heuristic (`isGovernmentPrimary`), which outranks a
 * content heuristic (`isPressReleaseChurn`). Each check is a strict
 * short-circuit ahead of the next -- a government-primary source is `event`
 * even if its content happens to contain a wire-service token; see
 * task-7-report.md and this file's tests for the real cisa-kev-shaped case.
 *
 * The default when nothing matches is `analysis`, not `press` -- the single
 * highest-leverage change this refinement makes. See the module doc comment
 * for the full real-corpus measurement (1,572 of 3,325 real items, 47.3%,
 * were wrongly `press` under M1's rule purely by defaulting there).
 *
 * `source` is accepted whole (matching M1's `assignItemType(source, ...)`
 * call shape exactly) rather than a narrower custom input type, so this
 * function is a drop-in replacement at its one call site
 * (`src/normalize/item.ts`'s `normalizeItem`) and needs no adapter to reuse
 * later wherever a `Source` is already in scope -- see task-7-report.md for
 * what a future read-time caller (e.g. decay's wiring) would need to supply
 * instead if `source` isn't already at hand there.
 */
export function classifyItemType(source: Source, title: string, summary: string | null): ItemType {
  if (source.tier === 'event') return 'event';
  if (source.tier === 'analysis') return 'analysis';
  if (isGovernmentPrimary(source.id)) return 'event';
  if (isPressReleaseChurn(title, summary)) return 'press';
  return 'analysis';
}
