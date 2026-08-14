import { z } from 'zod';
import type { Db } from '../db/connection.ts';
import { assertCanonicalTimestamp } from '../domain/item.ts';
import { resolveRepoId } from '../db/repoSnapshots.ts';
import { computeStarVelocityForItem, type VelocityResult } from './velocity.ts';

// ---------------------------------------------------------------------------
// The repos lane's own score inputs (M4a task 7 / §4, and the M4a acceptance
// question itself): star velocity as a decay-invariant component, and "have I
// already seen this on Hacker News?".
//
// This module is the SIGNAL. src/score/mechanical.ts turns it into numbers and
// src/api/routes/feed.ts renders the facts behind those numbers; nothing here
// writes anything, anywhere.
//
// ---------------------------------------------------------------------------
// 1. WHY A URL-EQUALITY MATCH WOULD HAVE SHIPPED A FEATURE THAT DID NOTHING
// ---------------------------------------------------------------------------
//
// The obvious implementation of "already seen on HN" is to compare item_keys:
// a repo's item_key is sha256 of `https://github.com/{owner}/{name}`
// (src/domain/repo.ts's repoItemKey), and an HN story's item_key is sha256 of
// whatever it links to. If HN linked to the repo, the keys are equal.
//
// They almost never are. The archived first-run corpus holds exactly ONE
// github.com row -- HN's "YouTube-dl has received a DMCA takedown from RIAA" --
// and it points at
//   https://github.com/github/dmca/blob/master/2020/10/2020-10-23-RIAA.md
// which canonicalizes to a DIFFERENT digest than `github.com/github/dmca`.
// Under append-only storage with no error path, the equality check would have
// matched nothing while looking like it worked, and the milestone's headline
// feature would have been silently inert. That is the exact failure shape this
// project has been bitten by four times (CLAUDE.md, "the scoring read path is
// three functions").
//
// So the match is on IDENTITY, not on URL:
//
//   parseGithubRepoRef  reduces any URL that names a GitHub repository -- root,
//                       deep link, raw.githubusercontent, GitHub Pages -- to
//                       its {owner, name}, and refuses everything else.
//   titleMentionsRepo   catches the case no URL rule can reach: an HN story
//                       that names the project but links to the project's own
//                       website. Real, and common -- see the two live rows in
//                       tests/score/repoSignal.test.ts.
//
// ---------------------------------------------------------------------------
// 2. DE-RANK, NEVER SUPPRESS
// ---------------------------------------------------------------------------
//
// §4's suppression list is exactly four rules -- fork, archived, no README,
// dismissed (src/domain/repo.ts) -- and HN overlap is not one of them. It is a
// scoring term: a repo already all over HN sinks, it does not vanish. Adding a
// fifth suppression rule the brief did not ask for would also make a false
// positive unrecoverable, whereas a false positive here costs a bounded number
// of score points. That asymmetry is what lets the title rule exist at all: it
// is a genuinely lower-confidence signal (hence `title_strength` below being
// less than `url_strength`), which would be indefensible if it could delete a
// repo from the lane.
//
// ---------------------------------------------------------------------------
// 3. DECAY-INVARIANCE -- what `asOf` is, and what it is not
// ---------------------------------------------------------------------------
//
// Both signals are read AS OF an instant the caller supplies, and every query
// below bounds `items.fetched_at <= asOf`. This is the same shape (and the same
// justification) as src/cluster/store.ts's getClusterSizeAsOf, which
// src/score/mechanical.ts already calls with the scoring pass's own `now`: a
// point-in-time snapshot of corroboration AT SCORING TIME, frozen into the
// stored row, NOT a factor that keeps moving after the row is written.
//
// Concretely: the number this module hands the scorer does not change between
// two reads of the same database at the same `asOf`, so item_scores stays
// append-only-with-meaning and src/score/decay.ts remains the only thing that
// applies the clock. This module never imports decay.ts.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Config -- owned by config/scoring.yaml's `repos:` block, embedded into
// MechanicalScoreConfig by src/score/mechanical.ts. Declared HERE rather than
// there so this module has no import back into the scorer (mechanical.ts ->
// repoSignal.ts is a one-way edge).
// ---------------------------------------------------------------------------

const VelocityScoringSchema = z
  .object({
    /**
     * The stars/day at which the velocity component saturates at 1.0. §4's own
     * worked example -- "a repo going 40->400 in a week" -- is ~60/day over the
     * six days a seven-day window can span, so this is calibrated so that
     * example scores full marks rather than being picked round.
     */
    saturation_stars_per_day: z.number().positive().finite(),
    /**
     * How much of the velocity component a MINIMALLY-covered measurement keeps.
     * See attenuateForCoverage: 1.0 disables coverage attenuation entirely.
     */
    coverage_floor: z.number().min(0).max(1),
    signal_weight: z.number().nonnegative().finite(),
    read_weight: z.number().nonnegative().finite(),
  })
  .strict();

const HnScoringSchema = z
  .object({
    /**
     * The source_ids that count as "already seen on HN". A LIST, in config, so
     * adding a second aggregator is an edit here rather than a code change --
     * and so that a source added by another task cannot silently start
     * influencing scores.
     */
    source_ids: z.array(z.string().min(1)).min(1),
    /** Strength of a match made through a URL that names the repo. */
    url_strength: z.number().min(0).max(1),
    /** Strength of a match made only through the story's title. Lower, deliberately. */
    title_strength: z.number().min(0).max(1),
    /** Repo names shorter than this (punctuation removed) never match by title. */
    min_title_slug_length: z.number().int().positive(),
    /** Repo names too generic to be evidence of anything when seen in a headline. */
    generic_names: z.array(z.string().min(1)),
    signal_weight: z.number().nonnegative().finite(),
    read_weight: z.number().nonnegative().finite(),
  })
  .strict()
  .refine((c) => c.title_strength <= c.url_strength, {
    message:
      'hn.title_strength must not exceed hn.url_strength -- a title mention is weaker evidence than a link, and inverting that would make the lower-confidence rule the dominant one',
  });

export const RepoScoringConfigSchema = z
  .object({
    velocity: VelocityScoringSchema,
    hn: HnScoringSchema,
  })
  .strict();

export type RepoScoringConfig = z.infer<typeof RepoScoringConfigSchema>;
export type VelocityScoringConfig = RepoScoringConfig['velocity'];
export type HnScoringConfig = RepoScoringConfig['hn'];

/**
 * The values config/scoring.yaml ships, as a constant.
 *
 * Exists so a caller that has not been handed a loaded scoring config -- today
 * that is src/api/routes/feed.ts, whose deps are built in src/bin/api.ts, a
 * file no M4a task owns -- still resolves the SAME repo facts the scorer used,
 * rather than silently rendering nothing. tests/score/repoSignal.test.ts
 * asserts this deep-equals the parsed `repos:` block of the real
 * config/scoring.yaml, so the two cannot drift apart unnoticed.
 */
export const DEFAULT_REPO_SCORING_CONFIG: RepoScoringConfig = {
  velocity: {
    saturation_stars_per_day: 60,
    coverage_floor: 0.5,
    signal_weight: 3.5,
    read_weight: 1.5,
  },
  hn: {
    source_ids: ['hn-algolia'],
    url_strength: 1,
    title_strength: 0.5,
    min_title_slug_length: 6,
    generic_names: [
      'agents',
      'articles',
      'awesome',
      'benchmark',
      'benchmarks',
      'client',
      'cookbook',
      'course',
      'courses',
      'dataset',
      'datasets',
      'demos',
      'documentation',
      'dotfiles',
      'examples',
      'framework',
      'handbook',
      'homepage',
      'javascript',
      'library',
      'models',
      'notebook',
      'notebooks',
      'papers',
      'playground',
      'plugins',
      'project',
      'projects',
      'prompts',
      'python',
      'research',
      'resources',
      'roadmap',
      'sandbox',
      'scripts',
      'server',
      'starter',
      'template',
      'templates',
      'toolkit',
      'tutorial',
      'tutorials',
      'typescript',
      'website',
    ],
    signal_weight: 2,
    read_weight: 2,
  },
};

// ---------------------------------------------------------------------------
// The URL rule
// ---------------------------------------------------------------------------

export interface GithubRepoRef {
  owner: string;
  name: string;
}

/**
 * github.com paths whose FIRST segment is a site route, not an account. A repo
 * URL is `github.com/{owner}/{name}`, and so is `github.com/topics/llm` --
 * structurally identical, semantically nothing alike. Without this list the
 * lane would de-rank a repo called `llm` because someone posted a topic page.
 *
 * Not exhaustive and cannot be: GitHub adds routes. The failure mode of a
 * MISSING entry is a soft de-rank of one repo, never a suppression (see the
 * module doc comment, point 2), which is why a fixed list is acceptable here
 * and would not be if this drove removal.
 */
const RESERVED_GITHUB_PATHS = new Set([
  'about',
  'account',
  'apps',
  'blog',
  'codespaces',
  'collections',
  'contact',
  'copilot',
  'customer-stories',
  'dashboard',
  'discussions',
  'education',
  'enterprise',
  'events',
  'explore',
  'features',
  'home',
  'issues',
  'join',
  'login',
  'logout',
  'marketplace',
  'mobile',
  'new',
  'nonprofit',
  'notifications',
  'open-source',
  'organizations',
  'orgs',
  'premium-support',
  'pricing',
  'pulls',
  'readme',
  'search',
  'security',
  'sessions',
  'settings',
  'signup',
  'site',
  'solutions',
  'sponsors',
  'stars',
  'team',
  'the-readme-project',
  'topics',
  'trending',
  'users',
  'watching',
  'why-github',
]);

/** GitHub logins: alphanumeric and hyphens, never leading with a hyphen, no dots. */
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
/** Repository names additionally allow dots and underscores. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const PAGES_SUFFIX = '.github.io';

function segmentsOf(pathname: string): string[] {
  return pathname.split('/').filter((s) => s !== '');
}

function refFrom(owner: string, rawName: string): GithubRepoRef | null {
  // `git clone` URLs carry a .git suffix; the repository is the same one.
  const name = rawName.endsWith('.git') ? rawName.slice(0, -4) : rawName;
  if (!OWNER_RE.test(owner)) return null;
  if (!NAME_RE.test(name)) return null;
  if (RESERVED_GITHUB_PATHS.has(owner.toLowerCase())) return null;
  return { owner, name };
}

/**
 * The {owner, name} of the GitHub repository a URL names, or `null` if it names
 * none.
 *
 * Handles every shape a real HN submission actually takes:
 *
 *   github.com/{owner}/{name}              the root
 *   github.com/{owner}/{name}/blob/...     any deep link (blob, tree, issues,
 *                                          pull, releases, commit, wiki, ...)
 *   github.com/{owner}/{name}.git          a clone URL
 *   raw.githubusercontent.com/{owner}/{name}/...
 *   {owner}.github.io                      the user/org Pages site
 *   {owner}.github.io/{name}               a project Pages site
 *
 * ## The one guess, named
 * A Pages URL with EXACTLY ONE path segment is ambiguous: `lxe.github.io/
 * everywebsite` is either the project site of `lxe/everywebsite` or a directory
 * inside `lxe/lxe.github.io`. GitHub's own convention makes the first far more
 * likely, so that is what this returns -- and a Pages URL with TWO OR MORE
 * segments, where the guess gets no more likely and the directory reading gets
 * more so, returns `null` rather than guessing twice. The cost of guessing
 * wrong is a bounded de-rank of one repo, never its removal.
 *
 * Casing is preserved as served (GitHub is case-insensitive but case-
 * preserving); compare with {@link repoRefKey}, never with `===`.
 *
 * Never throws -- a malformed URL is `null`, because this runs over whatever a
 * feed happened to publish.
 */
export function parseGithubRepoRef(raw: string): GithubRepoRef | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  let host = url.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);

  // A gist is not a repository. Its path is `{owner}/{gist-id}`, which would
  // otherwise parse as a repo named after a 32-character hex blob.
  if (host === 'gist.github.com') return null;

  const segments = segmentsOf(url.pathname);

  if (host === 'github.com' || host === 'raw.githubusercontent.com') {
    if (segments.length < 2) return null;
    return refFrom(segments[0]!, segments[1]!);
  }

  if (host.endsWith(PAGES_SUFFIX)) {
    const owner = host.slice(0, -PAGES_SUFFIX.length);
    if (!OWNER_RE.test(owner)) return null;
    if (segments.length === 0) return refFrom(owner, host);
    if (segments.length === 1) return refFrom(owner, segments[0]!);
    return null; // see "The one guess, named"
  }

  return null;
}

/** The case-insensitive identity two refs are compared on. */
export function repoRefKey(ref: GithubRepoRef): string {
  return `${ref.owner.toLowerCase()}/${ref.name.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// The title rule
// ---------------------------------------------------------------------------

/**
 * Lowercased alphanumeric runs. Splitting on punctuation rather than DELETING
 * it is the whole point: a repo called `agents` must not match a headline about
 * an "agentsystem", which is exactly what a substring test over a de-punctuated
 * string does. Tokenising both sides and requiring a CONTIGUOUS token run keeps
 * `mcp-stama` matching "MCP-stama" (two tokens, adjacent) while keeping
 * `agents` off "agent system" (a different token entirely).
 */
export function slugTokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t !== '');
}

function containsTokenRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    let ok = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Does this HN headline name this repository?
 *
 * The half of the signal no URL rule can reach: an HN story linking to
 * `rustdesk.com` or to a Hugging Face mirror, whose title says the project's
 * name. Both are real rows in the live corpus.
 *
 * Two guards, because a bare token match over repo names would fire constantly:
 *
 *  1. **A length floor** on the name with punctuation removed
 *     (`min_title_slug_length`). `github/dmca` is a real repo in the archived
 *     corpus and "DMCA" is a word that appears in headlines about anything;
 *     four characters is not evidence. Its one real row is caught by the URL
 *     rule anyway, so the floor costs nothing there.
 *  2. **A generic-name list** (`generic_names`, config, not code) for names that
 *     clear the floor but still are not evidence -- `awesome`, `models`,
 *     `server`, `python`. The list is config so tuning it never touches this
 *     file.
 *
 * Both guards are deliberately conservative in the direction of MISSING an
 * overlap rather than inventing one: a missed overlap leaves a repo ranked on
 * its velocity alone, which is the pre-existing behaviour, while an invented
 * one moves a good repo down for no reason.
 */
export function titleMentionsRepo(title: string, repoName: string, config: HnScoringConfig): boolean {
  const needle = slugTokens(repoName);
  if (needle.length === 0) return false;

  const slug = needle.join('');
  if (slug.length < config.min_title_slug_length) return false;
  if (config.generic_names.some((g) => slugTokens(g).join('') === slug)) return false;

  return containsTokenRun(slugTokens(title), needle);
}

// ---------------------------------------------------------------------------
// The database reads
// ---------------------------------------------------------------------------

/** One HN story that names this repository, and how we knew. */
export interface HnMention {
  itemKey: string;
  itemId: string;
  title: string;
  canonicalUrl: string;
  sourceId: string;
  publishedAt: string | null;
  fetchedAt: string;
  /** `url` is a link that names the repo; `title` is a headline that does. */
  via: 'url' | 'title';
}

export interface HnOverlap {
  seen: boolean;
  /**
   * The STRONGEST single piece of evidence, not a sum. Ten HN posts about a
   * repo do not make it more already-seen than one -- the reader either has
   * met it or has not -- and summing would let a popular project accumulate an
   * unbounded penalty that no amount of velocity could outweigh, which is
   * suppression by arithmetic (see the module doc comment, point 2).
   */
  strength: number;
  /** Every matching story, oldest first, one per item_key. */
  mentions: HnMention[];
}

/**
 * Every story from a configured aggregator source that names this repository,
 * as of `asOf`.
 *
 * ## The gate is the SOURCE, never the item_key
 * A repo ingested by the github_search adapter has canonical_url
 * `https://github.com/{owner}/{name}`. When HN links to that same root, the two
 * canonicalize identically, so under append-only storage they are two VERSIONS
 * of one item_key -- and an item_key-based self-exclusion would throw away the
 * strongest possible evidence of overlap. Filtering on `source_id in
 * (config.source_ids)` keeps the repo's own row out of its own evidence while
 * keeping HN's row in, which is exactly right in both directions.
 *
 * ## Cost
 * The SQL narrows to aggregator rows matching a cheap LIKE prefilter; the
 * precise decision is made in JavaScript on that small candidate set, so a
 * wildcard character inside a repo name (`_` is a LIKE wildcard and a legal
 * GitHub name character) can only ever over-select, never mis-decide. One query
 * per repo per scoring pass -- the same not-yet-batched shape
 * src/domain/itemBeats.ts and src/score/mechanical.ts's getLatestItemScore
 * already have, and left unbatched for the same reason.
 */
export function findHnOverlap(
  db: Db,
  ref: GithubRepoRef,
  asOf: string,
  config: HnScoringConfig,
): HnOverlap {
  assertCanonicalTimestamp('asOf', asOf);
  if (config.source_ids.length === 0) return { seen: false, strength: 0, mentions: [] };

  const nameTokens = slugTokens(ref.name);
  const titleRuleApplies =
    nameTokens.length > 0 &&
    nameTokens.join('').length >= config.min_title_slug_length &&
    !config.generic_names.some((g) => slugTokens(g).join('') === nameTokens.join(''));

  // Necessary conditions, not sufficient ones -- every candidate is re-decided
  // below. SQLite's LIKE is already case-insensitive over ASCII, which is the
  // whole of a GitHub owner/name.
  const likes = [`%/${ref.owner}/${ref.name}%`, `%${ref.owner}.github.io%`];
  if (titleRuleApplies) likes.push(`%${nameTokens[0]}%`);

  const sourcePlaceholders = config.source_ids.map(() => '?').join(', ');
  const urlOrTitle = titleRuleApplies
    ? 'canonical_url like ? or canonical_url like ? or title like ?'
    : 'canonical_url like ? or canonical_url like ?';

  // Inline type literal, not a named interface -- see CLAUDE.md, "The
  // node:sqlite cast quirk", and src/cluster/store.ts:88-100.
  const rows = db
    .prepare(
      `select item_id, item_key, title, canonical_url, source_id, published_at, fetched_at
         from items
        where source_id in (${sourcePlaceholders})
          and fetched_at <= ?
          and (${urlOrTitle})
        order by fetched_at asc, item_key asc, rowid asc`,
    )
    .all(...config.source_ids, asOf, ...likes) as Array<{
    item_id: string;
    item_key: string;
    title: string;
    canonical_url: string;
    source_id: string;
    published_at: string | null;
    fetched_at: string;
  }>;

  const wanted = repoRefKey(ref);
  const mentions: HnMention[] = [];
  const seenKeys = new Set<string>();

  for (const row of rows) {
    // `items` is append-only and never dedupes, so one HN story can be present
    // as many versions; the oldest is when it was first seen, which is what
    // "already seen" means.
    if (seenKeys.has(row.item_key)) continue;

    const linked = parseGithubRepoRef(row.canonical_url);
    let via: 'url' | 'title' | null = null;
    if (linked !== null && repoRefKey(linked) === wanted) via = 'url';
    else if (titleMentionsRepo(row.title, ref.name, config)) via = 'title';
    if (via === null) continue;

    seenKeys.add(row.item_key);
    mentions.push({
      itemKey: row.item_key,
      itemId: row.item_id,
      title: row.title,
      canonicalUrl: row.canonical_url,
      sourceId: row.source_id,
      publishedAt: row.published_at,
      fetchedAt: row.fetched_at,
      via,
    });
  }

  const strength = mentions.reduce(
    (best, m) => Math.max(best, m.via === 'url' ? config.url_strength : config.title_strength),
    0,
  );
  return { seen: mentions.length > 0, strength, mentions };
}

/**
 * The zone `repoId`'s snapshot days were bucketed in, taken from its NEWEST
 * reading -- or `null` for a repo with no readings.
 *
 * ## Why this is read from the data rather than from WF_TZ
 * `getSnapshotWindow` selects on day LABELS, so a caller that computes
 * `throughDay` in the wrong zone shifts the whole window by a day and can drop
 * a real endpoint (proved in tests/score/repoSignal.test.ts, where reading a
 * Tokyo-bucketed history as UTC degrades a perfectly good rate to
 * single_snapshot). The zone the rows were ACTUALLY bucketed under is stored
 * on every row (Task 2), so reading it back is exact, needs no config, cannot
 * drift from WF_TZ, and keeps this module's "no environment read" property.
 *
 * The NEWEST reading is the right one when WF_TZ changed mid-window: it is the
 * convention currently in force, and `SnapshotWindow.mixedTimezone` already
 * surfaces the seam to anyone who cares. Per src/score/velocity.ts's own
 * decision 5, the seam cannot perturb the rate itself in any case.
 */
export function snapshotTimeZone(db: Db, repoId: number): string | null {
  const row = db
    .prepare(
      `select tz from github_repo_star_snapshots
        where repo_id = ?
        order by snapshot_day desc
        limit 1`,
    )
    .get(repoId) as { tz: string } | undefined;
  return row ? row.tz : null;
}

/**
 * Star velocity for the repo an `item_key` names, read in that repo's own
 * bucketing zone -- {@link snapshotTimeZone}'s whole purpose.
 *
 * Returns src/score/velocity.ts's discriminated union untouched, so
 * `starsPerDay` still exists only on the `ok` branch and "insufficient history"
 * still cannot be unwrapped into a confident zero anywhere downstream.
 *
 * The `'UTC'` fallback applies only when there are no readings to take a zone
 * from, in which case every branch of the union is already insufficient and the
 * zone affects nothing but the cosmetic day labels on the refusal.
 */
export function resolveRepoVelocity(db: Db, itemKey: string, asOf: string): VelocityResult {
  const repoId = resolveRepoId(db, itemKey);
  const tz = repoId === null ? 'UTC' : (snapshotTimeZone(db, repoId) ?? 'UTC');
  return computeStarVelocityForItem(db, itemKey, { now: asOf, tz });
}

// ---------------------------------------------------------------------------
// The two components -- the ONE place each signal becomes a number
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * How much of a measurement's own strength survives its span coverage.
 *
 * `coverage_floor` is 0.5 rather than 0 deliberately. src/score/velocity.ts
 * refuses any window spanning under `DEFAULT_MIN_SPAN_DAYS` (3 of the 6 days a
 * 7-day window can span), so a measurement that reaches this function has
 * `spanCoverage >= 0.5` already -- multiplying by coverage alone would halve a
 * just-qualifying sample, which is a second gate wearing the costume of an
 * attenuation. A floor keeps it a nudge: at the minimum span a measurement
 * keeps 75% of its weight, at full span 100%.
 */
function attenuateForCoverage(spanCoverage: number, config: VelocityScoringConfig): number {
  return config.coverage_floor + (1 - config.coverage_floor) * clamp(spanCoverage, 0, 1);
}

/**
 * §4's star velocity as a bounded, signed, decay-invariant score component.
 *
 * ## INSUFFICIENT HISTORY CONTRIBUTES EXACTLY 0, AND THAT IS A DECISION
 * Not a default, and not a `?? 0` -- src/score/velocity.ts's discriminated
 * union makes that impossible to write, which is why the choice has to be made
 * here, once, in the open.
 *
 * The lane's FIRST SEVEN DAYS are entirely this case, so whatever number is
 * chosen is a constant applied to every repo at once. It therefore changes
 * nothing about the order WITHIN the lane and everything about where the lane
 * sits relative to the other five beats. Zero is the only value that leaves
 * repos ranked exactly as every other beat is -- on source trust, corroboration
 * and interest match -- until there is evidence to add. A positive constant
 * would float the whole lane above better-evidenced items for a week; a
 * negative one would sink it, and both would then LURCH the moment the seventh
 * day landed. Zero also makes the term purely additive evidence: a repo can
 * only gain from velocity it actually demonstrates.
 *
 * The cost, stated: 0 is also what a genuinely FLAT repo scores, so the number
 * alone cannot tell "no growth" from "we were not looking". That is precisely
 * why `/api/feed` ships the whole `VelocityResult` beside the component rather
 * than the component alone, and why §7's row must say "velocity unavailable --
 * N days of history" rather than drawing a flat arrow.
 *
 * ## Shape
 * `sign(v) * log2(1 + |v|) / log2(1 + saturation_stars_per_day)`, clamped to
 * [-1, 1] and then attenuated by span coverage. Log-scaled and saturating for
 * the same reason `normalizeClusterSize` is (src/score/mechanical.ts): the jump
 * from 5 to 50 stars/day says far more than the jump from 500 to 545, and an
 * unbounded term would let one viral week dominate every ranking afterwards.
 * `saturation_stars_per_day` is calibrated so §4's own worked example -- 40 to
 * 400 in a week, ~60/day over the six days a 7-day window spans -- scores full
 * marks, rather than being picked round.
 *
 * ## NEGATIVE VELOCITY IS NOT CLAMPED TO 0 HERE EITHER
 * src/score/velocity.ts deliberately leaves the sign intact and hands this
 * choice down; the same three reasons still hold at this layer. §4 ranks BY
 * velocity, so a repo shedding stars must sort below a flat one and clamping
 * ties them. A bulk spam-star purge is the single strongest evidence that an
 * earlier spike was manufactured -- exactly the repo this lane must not promote
 * -- and clamping discards it. What IS bounded is the magnitude: the same
 * saturation applies in both directions, so a catastrophic unstarring costs at
 * most one `velocity.signal_weight`, never an unbounded amount.
 *
 * A repo whose signal_score goes negative sorts last, which is the intended
 * meaning. Renderers must handle a negative score rather than assuming a
 * non-negative range.
 *
 * ## Staleness is reported, not attenuated
 * `staleDays` is left out of the arithmetic on purpose. Snapshots are written
 * for the whole lane by one poller in one pass, so a gap at the end of the
 * window is a property of the POLLER, not of any repo -- attenuating on it
 * would rescale every repo by the same factor and change no ordering, at the
 * cost of a knob. It is surfaced on `/api/feed` so §7's row can say "as of
 * Tuesday". (The exception, noted rather than handled: a repo that drops out of
 * search results goes stale on its own.)
 */
export function velocityComponentFor(result: VelocityResult, config: VelocityScoringConfig): number {
  if (result.status !== 'ok') return 0;

  const rate = result.starsPerDay;
  const magnitude = clamp(
    Math.log2(1 + Math.abs(rate)) / Math.log2(1 + config.saturation_stars_per_day),
    0,
    1,
  );
  return Math.sign(rate) * magnitude * attenuateForCoverage(result.spanCoverage, config);
}

/**
 * "Already seen on HN" as a de-rank magnitude in [0, 1].
 *
 * Bounded by the strongest configured strength rather than by 1 so that
 * lowering both strengths in config genuinely lowers the ceiling, instead of
 * leaving a stale 1 reachable through a hand-built HnOverlap.
 */
export function hnComponentFor(overlap: HnOverlap, config: HnScoringConfig): number {
  if (!overlap.seen) return 0;
  return clamp(overlap.strength, 0, Math.max(config.url_strength, config.title_strength));
}

// ---------------------------------------------------------------------------
// Both halves, one read
// ---------------------------------------------------------------------------

export interface RepoSignal {
  ref: GithubRepoRef;
  /** `${owner}/${name}` as GitHub served it. */
  fullName: string;
  /** GitHub's numeric id, or `null` for a repo with no snapshot history yet. */
  repoId: number | null;
  velocity: VelocityResult;
  /** {@link velocityComponentFor}'s output for `velocity`. */
  velocityComponent: number;
  hn: HnOverlap;
  /** {@link hnComponentFor}'s output for `hn`. */
  hnComponent: number;
}

/**
 * Everything the repos lane knows about one item, or `null` if the item's own
 * URL names no GitHub repository at all.
 *
 * The identity comes from the item's canonical URL rather than from
 * `github_repo_names`, so a repo that has never been snapshotted still resolves
 * -- which is every repo for the lane's first day. Velocity then reports
 * `unknown_repo`, honestly, instead of the item silently ceasing to be a repo.
 */
export function resolveRepoSignal(
  db: Db,
  itemKey: string,
  canonicalUrl: string,
  asOf: string,
  config: RepoScoringConfig,
): RepoSignal | null {
  const ref = parseGithubRepoRef(canonicalUrl);
  if (ref === null) return null;

  const velocity = resolveRepoVelocity(db, itemKey, asOf);
  const hn = findHnOverlap(db, ref, asOf, config.hn);

  return {
    ref,
    fullName: `${ref.owner}/${ref.name}`,
    repoId: velocity.repoId,
    velocity,
    velocityComponent: velocityComponentFor(velocity, config.velocity),
    hn,
    hnComponent: hnComponentFor(hn, config.hn),
  };
}
