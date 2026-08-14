import { z } from 'zod';

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
