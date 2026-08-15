/**
 * The weekly reading note (M5 task 6) — §8.1's *"the artifact I care most
 * about"*.
 *
 * > Written Friday evening: the week's top `read_score` items I haven't
 * > opened, with real blurbs — what the piece argues, why it's worth the time,
 * > estimated read time.
 *
 * Every write goes through `src/vault/session.ts`; this module imports no
 * `node:fs`. It lives inside `src/vault/`, which the source-tree rule in
 * `src/vault/sourceRules.ts` **exempts** from that check, so
 * `tests/vault/weeklySourceRules.test.ts` asserts it separately rather than
 * relying on a rule that does not cover it.
 */

import type { Db } from '../db/connection.ts';
import { assertCalendarDay, localDay } from '../db/repoSnapshots.ts';
import { assertCanonicalTimestamp, getCurrentItem, BEATS, type Beat } from '../domain/item.ts';
import { getItemFirstFetchedAt } from '../domain/itemFirstFetchedAt.ts';
import { getItemState } from '../domain/itemState.ts';
import { rankBeat, type RankDeps } from '../score/rank.ts';
import type { Kind } from '../sources/load.ts';
import { WATCHFLOOR_BEGIN_MARKER, WATCHFLOOR_END_MARKER } from './frontmatter.ts';

// ---------------------------------------------------------------------------
// The week
// ---------------------------------------------------------------------------

/** One ISO-8601 week: the unit §8.1's `weekly/YYYY-[Www].md` filename names. */
export interface IsoWeek {
  /** The ISO year, which is not always the Gregorian year of `startDay`. */
  readonly year: number;
  /** 1–53. */
  readonly week: number;
  /** `2026-W33` — zero-padded, and the note's filename stem. */
  readonly label: string;
  /** Monday, as a `YYYY-MM-DD` label. */
  readonly startDay: string;
  /** Sunday, as a `YYYY-MM-DD` label. */
  readonly endDay: string;
}

const MS_PER_DAY = 86_400_000;

/**
 * Day arithmetic on bare `YYYY-MM-DD` LABELS, in the same frame and for the
 * same reason as `shiftDay` in `src/db/repoSnapshots.ts`: neither input nor
 * output carries an instant or a zone, so `Date.UTC` is a fixed frame for
 * proleptic-Gregorian arithmetic rather than a hidden timezone read. The
 * conversion from an instant to a day happens once, in `localDay`, with an
 * explicit WF_TZ.
 */
function dayToUtcMs(day: string): number {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, date);
}

function utcMsToDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 0 = Monday … 6 = Sunday. ISO's week starts on Monday; `getUTCDay` does not. */
function isoWeekday(ms: number): number {
  return (new Date(ms).getUTCDay() + 6) % 7;
}

/**
 * The ISO-8601 week a calendar day falls in.
 *
 * ISO's rule is "week 1 is the week containing the first Thursday", which is
 * why every computation here goes via that week's own Thursday: the Thursday
 * is the only day of a week guaranteed to sit in the same ISO year as the week
 * itself, so it decides both the year and the number without a special case
 * for either boundary.
 *
 * Takes a `YYYY-MM-DD` label rather than an instant, deliberately. The caller
 * supplies `localDay(now, WF_TZ)`; accepting an instant here would silently
 * bucket by UTC and file a Sunday-evening note under the following week for a
 * reader west of Greenwich.
 */
export function isoWeekOf(day: string): IsoWeek {
  assertCalendarDay('day', day);

  const ms = dayToUtcMs(day);
  const weekday = isoWeekday(ms);
  const monday = ms - weekday * MS_PER_DAY;
  const thursday = monday + 3 * MS_PER_DAY;

  const year = new Date(thursday).getUTCFullYear();
  // 4 January is in ISO week 1 by definition, whatever weekday it falls on.
  const jan4 = Date.UTC(year, 0, 4);
  const week1Monday = jan4 - isoWeekday(jan4) * MS_PER_DAY;
  const week = Math.round((monday - week1Monday) / (7 * MS_PER_DAY)) + 1;

  return {
    year,
    week,
    label: `${year}-W${String(week).padStart(2, '0')}`,
    startDay: utcMsToDay(monday),
    endDay: utcMsToDay(monday + 6 * MS_PER_DAY),
  };
}

/** §8.1's `weekly/YYYY-[Www].md`. The only path this module ever writes. */
export function weeklyNoteRelPath(week: IsoWeek): string {
  return `weekly/${week.label}.md`;
}

// ---------------------------------------------------------------------------
// Evidence: what we actually hold about a piece
// ---------------------------------------------------------------------------

/**
 * Words of prose a stored payload must carry before it is treated as the
 * article rather than as a teaser.
 *
 * There is **no cliff in the data** to put this on. Measured across the live
 * corpus on 2026-08-15, the payload-length distribution is smooth: ten of the
 * twenty-eight configured sources syndicate a real body (median 755–3,151
 * words), and the rest carry a lead paragraph (13–202 words). 400 words is
 * two minutes at {@link WORDS_PER_MINUTE} — the point below which a read-time
 * estimate says nothing a reader could not have guessed, and above which the
 * material is long enough that a blurb drawn from it is describing the piece
 * rather than its opening sentence. It is a judgement, it is named, and
 * retuning it is one edit.
 */
export const BODY_WORDS_MIN = 400;

/**
 * Content words an excerpt must add over the headline before it counts as
 * material.
 *
 * The failure this prevents is specific and was reproduced live: given
 * *"Down, but not out!"* under the headline *"[AINews] Gemini 3.7 Flash brings
 * GDM back to the forefront"*, `llama3.2` invented "GDM (Graphics Display
 * Manager)" and `llama3.1:8b` invented "GDM (Gemini Desktop Manager)". GDM is
 * Google DeepMind. A length check does not catch that excerpt's siblings
 * either: 24 real rows carry a summary with **zero** content words the title
 * lacks, and a character count passes every one of them.
 *
 * Eight is the same kind of judgement as {@link BODY_WORDS_MIN}, and the same
 * measurement says why it is not lower: 170 of 5,878 excerpts add three words
 * or fewer, which is the tagline band the gate exists to reject.
 */
export const EXCERPT_NOVEL_WORDS_MIN = 8;

/**
 * How much of a body goes into a prompt.
 *
 * `config/llm.yaml`'s `max_prompt_chars` is 24,000 and the backend THROWS
 * above it rather than truncating; this keeps a 3,000-word article — or a
 * 1.3 MB Blogger payload — comfortably inside that with room for the system
 * message. The slice is always a PREFIX, never a middle-out cut, for the
 * reason that config file states in its own comment.
 */
export const MAX_MATERIAL_CHARS = 6000;

/**
 * The reading speed the estimate is quoted at. Round, conservative, and
 * stated in the note itself so the number is never presented as a measurement
 * of the reader.
 */
export const WORDS_PER_MINUTE = 200;

/** §8.1's three grades of "what do we actually hold about this piece". */
export type EvidenceLevel =
  /** The stored payload carries the article. A blurb describes the piece. */
  | 'body'
  /** A real lead or abstract. A blurb describes what the piece says it does. */
  | 'excerpt'
  /**
   * A headline, and nothing that adds to it. **No blurb is generated at this
   * level** — see {@link EXCERPT_NOVEL_WORDS_MIN} for what happened when one
   * was.
   */
  | 'headline';

export interface EvidenceInput {
  readonly title: string;
  /** The stored ~300-character excerpt (`items.summary_raw`). */
  readonly summaryRaw: string | null;
  /** The source's own payload, preserved verbatim (`items.raw_json`). */
  readonly rawJson: string;
}

export interface BlurbEvidence {
  readonly level: EvidenceLevel;
  /** The plain text a prompt may use. Empty at the `headline` level. */
  readonly material: string;
  /** True when `material` is a prefix of a longer body. */
  readonly truncated: boolean;
  /** Words of prose in the stored payload, or `null` when it carried none. */
  readonly bodyWords: number | null;
  /** Content words the excerpt adds over the headline. */
  readonly novelWords: number;
  /** One renderable sentence saying which level this is and why. */
  readonly basis: string;
}

/**
 * Plain text from feed markup.
 *
 * Deliberately blunt: this runs over a payload a *source* controls, and a
 * clever parser is a larger attack surface for no gain — the only question
 * asked of the result is "how many words of prose is this, and what do they
 * say". Script and style bodies are dropped first so their contents do not
 * become "words".
 */
function stripMarkup(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&(?:#8217|#39|rsquo|apos);/g, "'")
    .replace(/&(?:#8220|#8221|ldquo|rdquo|quot);/g, '"')
    .replace(/&(?:#8212|mdash);/g, '—')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countWords(text: string): number {
  return text === '' ? 0 : text.split(/\s+/).filter(Boolean).length;
}

/**
 * Words too common to carry meaning, for the novelty comparison only. Short
 * enough to read, which is the point: a long stop list would make the novelty
 * count depend on a table nobody audits.
 */
const STOP_WORDS: ReadonlySet<string> = new Set(
  ('a an the and or but of in on for to with by from as at is are was were be been being it its ' +
    'this that these those we our you your they their he she his her not no if then than so such ' +
    'into over under after before new has have had will would can could may might do does did')
    .split(' '),
);

function contentWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
  return new Set(words);
}

/** Content words in `text` that the headline does not already contain. */
function novelContentWords(title: string, text: string): number {
  const inTitle = contentWords(title);
  let novel = 0;
  for (const word of contentWords(text)) if (!inTitle.has(word)) novel += 1;
  return novel;
}

/**
 * The longest run of prose a stored feed payload carries, or `null`.
 *
 * Feed shapes differ and this reads all four fields that carry text across the
 * configured sources — `content:encoded` (RSS full-content), Atom `content`,
 * `description`, and `summary` — taking the longest. That is best effort by
 * design: a payload whose text this cannot find simply lands at a lower
 * evidence level, which fails toward "we hold less than we thought", never
 * toward a blurb written from nothing.
 *
 * **This never reproduces the text it counts.** The word count reaches the
 * note; a bounded prefix reaches a local model; nothing here writes article
 * body into the vault. That distinction is why counting it does not conflict
 * with the standing "links and ~300-character excerpts, never full text" rule,
 * which governs what this project *stores* — and `items.raw_json` already
 * holds these bytes, preserved verbatim by M1.
 */
function bodyTextOf(rawJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null; // an unreadable payload is one we hold nothing from
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const candidates: string[] = [];
  for (const key of ['content:encoded', 'content', 'description', 'summary']) {
    const value = record[key];
    if (typeof value === 'string') candidates.push(value);
    else if (value !== null && typeof value === 'object') {
      // fast-xml-parser represents an element with attributes as an object
      // whose text content sits under `#text`.
      const text = (value as Record<string, unknown>)['#text'];
      if (typeof text === 'string') candidates.push(text);
    }
  }
  if (candidates.length === 0) return null;
  return candidates.reduce((longest, next) => (next.length >= longest.length ? next : longest));
}

/**
 * Which of §8.1's three grades of evidence we hold for one item.
 *
 * Pure: no clock, no filesystem, no database. Every input is a column of the
 * item's current version.
 */
export function classifyEvidence(input: EvidenceInput): BlurbEvidence {
  const rawBody = bodyTextOf(input.rawJson);
  const bodyText = rawBody === null ? null : stripMarkup(rawBody);
  const bodyWords = bodyText === null ? null : countWords(bodyText);

  const excerpt = input.summaryRaw === null ? '' : stripMarkup(input.summaryRaw);
  const novelWords = novelContentWords(input.title, excerpt);

  if (bodyText !== null && bodyWords !== null && bodyWords >= BODY_WORDS_MIN) {
    const truncated = bodyText.length > MAX_MATERIAL_CHARS;
    return {
      level: 'body',
      material: truncated ? bodyText.slice(0, MAX_MATERIAL_CHARS) : bodyText,
      truncated,
      bodyWords,
      novelWords,
      basis: `the ${bodyWords}-word body this feed carries`,
    };
  }

  if (novelWords >= EXCERPT_NOVEL_WORDS_MIN) {
    return {
      level: 'excerpt',
      material: excerpt,
      truncated: false,
      bodyWords,
      novelWords,
      basis: `the stored ${excerpt.length}-character excerpt — this feed carries no article text`,
    };
  }

  return {
    level: 'headline',
    material: '',
    truncated: false,
    bodyWords,
    novelWords,
    basis:
      novelWords === 0
        ? 'the headline alone — this feed carried no excerpt, or one that only repeats it'
        : `the headline alone — the excerpt adds only ${novelWords} word(s) to it`,
  };
}

// ---------------------------------------------------------------------------
// Read time
// ---------------------------------------------------------------------------

/**
 * §8.1's "estimated read time", and what it is worth.
 *
 * `minutes` is `null` far more often than it is a number, and that is the
 * design rather than a gap. This project stores links and ~300-character
 * excerpts, never full text, so for eighteen of the twenty-eight configured
 * sources there is nothing to count and no honest number to print. A minute
 * count guessed from a headline reads exactly as authoritative as one counted
 * from an article, which is precisely why it is not printed.
 */
export interface ReadTimeEstimate {
  /** Whole minutes, or `null` when there is nothing to count. */
  readonly minutes: number | null;
  /** What the figure was computed from. Rendered next to it, always. */
  readonly basis: string;
}

export function estimateReadTime(evidence: BlurbEvidence): ReadTimeEstimate {
  if (evidence.level !== 'body' || evidence.bodyWords === null) {
    return {
      minutes: null,
      basis:
        evidence.level === 'excerpt'
          ? 'unknown — this feed carries no article text, only a short excerpt'
          : 'unknown — this feed carries no text beyond the headline',
    };
  }
  return {
    // Never zero: a 400-word floor over 200 wpm cannot round below 2, but the
    // floor is a named constant somebody may lower.
    minutes: Math.max(1, Math.round(evidence.bodyWords / WORDS_PER_MINUTE)),
    basis: `${evidence.bodyWords} words of stored feed text at ${WORDS_PER_MINUTE} wpm`,
  };
}

// ---------------------------------------------------------------------------
// The two questions
// ---------------------------------------------------------------------------

/**
 * §8.1's two model-answerable questions, asked **separately**.
 *
 * The third — read time — is arithmetic (see {@link estimateReadTime}) and is
 * never asked of a model, because a model given a headline will produce a
 * confident number for a document it has not seen.
 *
 * Two calls rather than one structured call costs twice the tokens and buys:
 * no parsing (both local models dropped their own output labels on real items
 * — `llama3.1:8b` twice and `llama3.2` once in one eight-item run on
 * 2026-08-15); independent failure, so a missing "worth it" does not take the
 * "argues" line with it; and independent cache keys, so rewording one question
 * does not retire the other's stored answers.
 */
export const BLURB_QUESTIONS = ['argues', 'worth'] as const;

export type BlurbQuestion = (typeof BLURB_QUESTIONS)[number];

/**
 * The `task` field of the enrichment cache key (`src/enrich/cacheKey.ts`).
 * Distinct per question, so one item's two answers never share a row.
 */
export const BLURB_TASK_ID: Readonly<Record<BlurbQuestion, string>> = {
  argues: 'weekly_blurb_argues',
  worth: 'weekly_blurb_worth',
};

/**
 * The system message per question. Part of the cache key, so editing one of
 * these retires exactly its own answers and nothing else — no
 * `config/enrichment.yaml` version bump needed.
 *
 * `worth`'s wording is the second draft and the difference is visible in the
 * output. The first asked "why is it worth this reader's time"; both models
 * answered with a formula — *"This piece is worth a technical reader's time
 * because..."* — followed by a second summary of the piece. Naming the reader
 * first and banning the opening phrase produced *"For anyone responsible for
 * protecting payment platforms from phishing attacks, this piece provides a
 * detailed technical analysis of the JWR framework's architecture"* from the
 * same model on the same item.
 */
export const BLURB_SYSTEM: Readonly<Record<BlurbQuestion, string>> = {
  argues: [
    'You write one entry of a weekly reading list for a single technical reader.',
    'Say what this piece actually claims or establishes: the substance, not the subject area.',
    'Two sentences at most. Use only what the text below states -- add nothing.',
    'Do not restate the headline. No preamble, no markdown, no bullet points, no quotation.',
  ].join('\n'),
  worth: [
    'You write one entry of a weekly reading list for a single technical reader.',
    'Answer only this: who does this piece pay off for, and what do they get out of it that they would not get from the headline?',
    'One sentence, at most 30 words. Start with the reader it serves, e.g. "For anyone running ...".',
    'Never begin with "This piece" or "This article". Do not summarise the piece. No markdown.',
  ].join('\n'),
};

export class WeeklyBlurbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeeklyBlurbError';
  }
}

export interface BlurbPromptItem {
  readonly sourceId: string;
  readonly title: string;
}

/**
 * The user message, identical for both questions — only the system message
 * differs, so the material is described once.
 *
 * Throws at the `headline` level rather than building a prompt with nothing in
 * it. That is the whole point of the evidence gate: a caller that reaches here
 * with no material has a bug, and returning a prompt would hide it behind a
 * plausible-sounding blurb.
 */
export function buildBlurbPrompt(item: BlurbPromptItem, evidence: BlurbEvidence): string {
  if (evidence.level === 'headline') {
    throw new WeeklyBlurbError(
      `refusing to build a blurb prompt for ${JSON.stringify(item.title)}: ${evidence.basis}`,
    );
  }
  const lead = evidence.truncated
    ? 'The opening of the piece (it continues beyond this):'
    : 'The piece:';
  return `Source: ${item.sourceId}\nHeadline: ${item.title}\n\n${lead}\n${evidence.material}`;
}

// ---------------------------------------------------------------------------
// Validating what came back
// ---------------------------------------------------------------------------

/**
 * Content words a blurb must add over the headline.
 *
 * Guards a different failure from {@link EXCERPT_NOVEL_WORDS_MIN}, and the two
 * must not be confused. The evidence gate stops a blurb being written from
 * nothing; this one stops a blurb that is the headline read back. Neither
 * catches the other's case: a fabricated blurb is full of novel words, and a
 * restatement can be produced from a perfectly good article.
 */
export const BLURB_NOVEL_WORDS_MIN = 5;

export type BlurbRejection =
  /** The model had nothing to say. A real answer, but not a blurb. */
  | 'empty'
  /** The headline, read back. §8.1's named failure. */
  | 'restated_headline'
  /**
   * Generated text carrying a managed-block marker. It would decide where the
   * managed block ends inside a file this project rewrites — see
   * `src/vault/frontmatter.ts`.
   */
  | 'contains_marker';

export type BlurbValidation =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: BlurbRejection };

/** A label the model emitted despite the system message. Observed on both. */
const EMITTED_LABEL = /^(?:ARGUES|WORTH|ANSWER)\s*:\s*/i;

/**
 * Normalises one completion and decides whether it may be rendered.
 *
 * Collapses to a single line first: a blurb is one or two sentences, and a
 * line break inside one is the difference between a sentence and a Markdown
 * heading in a file this project rewrites unattended.
 */
export function validateBlurbText(title: string, text: string): BlurbValidation {
  const oneLine = text.replace(/\s+/g, ' ').trim().replace(EMITTED_LABEL, '').trim();
  if (oneLine === '') return { ok: false, reason: 'empty' };
  if (
    oneLine.includes(WATCHFLOOR_BEGIN_MARKER) ||
    oneLine.includes(WATCHFLOOR_END_MARKER) ||
    // Checked loosely as well as exactly: a marker the renderer would not
    // recognise is still a comment this module did not intend to write.
    /<!--\s*watchfloor:/i.test(oneLine)
  ) {
    return { ok: false, reason: 'contains_marker' };
  }
  if (novelContentWords(title, oneLine) < BLURB_NOVEL_WORDS_MIN) {
    return { ok: false, reason: 'restated_headline' };
  }
  return { ok: true, text: oneLine };
}

// ---------------------------------------------------------------------------
// Selecting the week's reading
// ---------------------------------------------------------------------------

/**
 * The content kinds that count as "a piece to read".
 *
 * **A departure from a literal reading of §8.1, and it needs the owner's
 * ratification exactly as RULING 1 did.** The finding that forced it: ranked
 * by decayed `read_score` over the live corpus (5,937 items, `now` =
 * 2026-08-15T22:00Z), *eighteen of the top twenty items are bare CVE records*
 * -- `CVE-2026-21832`, `CVE-2026-73487`, ... -- followed by four GitHub
 * repository rows. "What the piece argues" has no answer for `CVE-2026-21832`.
 *
 * That is not a scoring defect. `nvd-cve` is a weight-1.6 primary source and
 * cyber's read half-life is 336h, so a recent CVE genuinely scores well on a
 * profile that rewards primary sources. It is a population mismatch, and
 * §8.1's own wording is the evidence for which population it meant: it says
 * "the piece".
 *
 * `kind` is the axis the owner already chose for this class of question
 * (RULING 1). The bot's default is `news + advisory` -- act on it; a reading
 * list's is `news + paper + blog` -- read it. Advisories and aggregator rows
 * are what `signal_score` and the daily note's Flagged section exist for.
 * Source-level, stable, and overridable through {@link WeeklySelectionDeps},
 * so widening it is one argument rather than an edit here.
 */
export const WEEKLY_READING_KINDS: ReadonlySet<Kind> = new Set<Kind>(['news', 'paper', 'blog']);

/**
 * How many blurbed entries a note carries.
 *
 * Counts BLURBABLE items only. Items we hold only a headline for still rank
 * and are still listed, in their own section -- they simply do not consume the
 * limit, because a week whose top twelve are all AP wire headlines would
 * otherwise produce a reading note with nothing to read.
 */
export const DEFAULT_WEEKLY_LIMIT = 12;

/** How many passed-over headline-only items the note names before it stops. */
export const HEADLINE_ONLY_LIMIT = 10;

export interface WeeklySelectionDeps {
  /** Decay and overrides config, as `src/score/rank.ts` consumes them. */
  readonly rank: RankDeps;
  /**
   * `sourceId -> kind`, built from `config/sources.yaml` the same way
   * `src/api/routes/feed.ts` builds it. A source missing from the map, or with
   * no `kind`, is treated as not-a-reading-kind: a source we cannot classify
   * is one we cannot promise is a piece of writing.
   */
  readonly sourceKinds: ReadonlyMap<string, Kind | null>;
  readonly readingKinds?: ReadonlySet<Kind>;
}

export interface WeeklySelectionOptions {
  /** Canonical UTC instant. Injected -- nothing here reads a clock. */
  readonly now: string;
  /** WF_TZ. Decides which ISO week `now` falls in, never the host's zone. */
  readonly tz: string;
  readonly limit?: number;
}

/** One item that made the week's list. */
export interface WeeklyCandidate {
  readonly itemKey: string;
  readonly title: string;
  readonly url: string;
  readonly sourceId: string;
  readonly kind: Kind | null;
  /** The beat it scored highest in, of the beats it belongs to. */
  readonly beat: Beat;
  /** `read_score` with this read's decay applied -- never a stored number. */
  readonly readScore: number;
  readonly publishedAt: string | null;
  /** `publishedAt`, or the first instant this system saw the item. */
  readonly effectiveAt: string;
  /** `effectiveAt` as a calendar day in WF_TZ. What the week window compares. */
  readonly effectiveDay: string;
  readonly evidence: BlurbEvidence;
  readonly readTime: ReadTimeEstimate;
}

/** Why items that ranked did not become candidates. Rendered, not swallowed. */
export interface WeeklyExclusions {
  readonly wrongKind: number;
  readonly alreadyRead: number;
  readonly dismissed: number;
  readonly outsideWeek: number;
}

export interface WeeklySelection {
  readonly week: IsoWeek;
  /** Blurbable items, highest decayed `read_score` first. */
  readonly candidates: readonly WeeklyCandidate[];
  /**
   * Items that ranked but carry no material -- listed in the note without a
   * blurb rather than dropped, so the note does not misreport the ranking.
   */
  readonly headlineOnly: readonly WeeklyCandidate[];
  /** Distinct unread, in-week, reading-kind items considered. */
  readonly consideredCount: number;
  readonly excluded: WeeklyExclusions;
}

interface RankedForWeek {
  readonly itemKey: string;
  readonly title: string;
  readonly sourceId: string;
  readonly beat: Beat;
  readonly readScore: number;
  readonly publishedAt: string | null;
}

/**
 * Every scored item, best beat only, highest decayed `read_score` first.
 *
 * Ranking per beat and concatenating lists a cross-listed item once per lane
 * -- the mistake `CLAUDE.md` records as having bitten four times. Deduping on
 * `item_key` and keeping the best-scoring lane is the same shape as
 * `pickBestBeat` in `src/api/routes/feed.ts`.
 */
function rankedAcrossBeats(db: Db, deps: WeeklySelectionDeps, now: string): RankedForWeek[] {
  const best = new Map<string, RankedForWeek>();
  for (const beat of BEATS) {
    // `markets` has no configured sources (M4b is deferred) and no entry in
    // config/decay.yaml's `beats`, so ranking it is not merely empty -- it
    // would ask for a half-life that file deliberately does not define.
    if (beat === 'markets') continue;
    for (const item of rankBeat(db, beat, now, deps.rank, 'read').items) {
      const existing = best.get(item.itemKey);
      if (existing === undefined || item.readScore > existing.readScore) {
        best.set(item.itemKey, {
          itemKey: item.itemKey,
          title: item.title,
          sourceId: item.sourceId,
          beat: item.beat,
          readScore: item.readScore,
          publishedAt: item.publishedAt,
        });
      }
    }
  }
  return [...best.values()].sort(
    (a, b) => b.readScore - a.readScore || a.title.localeCompare(b.title),
  );
}

/**
 * The week's top unread items, and the evidence we hold about each.
 *
 * Order of filters is deliberate: the cheap in-memory ones (kind, week window
 * for a dated item) run before any per-item query, so a corpus of six thousand
 * items costs a handful of reads rather than three per item.
 */
export function selectWeeklyReading(
  db: Db,
  deps: WeeklySelectionDeps,
  opts: WeeklySelectionOptions,
): WeeklySelection {
  assertCanonicalTimestamp('now', opts.now);
  const week = isoWeekOf(localDay(opts.now, opts.tz));
  const readingKinds = deps.readingKinds ?? WEEKLY_READING_KINDS;
  const limit = opts.limit ?? DEFAULT_WEEKLY_LIMIT;

  const candidates: WeeklyCandidate[] = [];
  const headlineOnly: WeeklyCandidate[] = [];
  let wrongKind = 0;
  let alreadyRead = 0;
  let dismissed = 0;
  let outsideWeek = 0;
  let consideredCount = 0;

  for (const ranked of rankedAcrossBeats(db, deps, opts.now)) {
    if (candidates.length >= limit && headlineOnly.length >= HEADLINE_ONLY_LIMIT) break;

    const kind = deps.sourceKinds.get(ranked.sourceId) ?? null;
    if (kind === null || !readingKinds.has(kind)) {
      wrongKind += 1;
      continue;
    }

    // An undated item's baseline is the FIRST fetch across every version
    // sharing its key, never the current version's -- cisa-kev re-delivers its
    // whole catalogue and would otherwise look new on every poll
    // (src/domain/itemFirstFetchedAt.ts). Queried only when it is needed.
    const effectiveAt =
      ranked.publishedAt ?? getItemFirstFetchedAt(db, ranked.itemKey) ?? opts.now;
    const effectiveDay = localDay(effectiveAt, opts.tz);
    if (effectiveDay < week.startDay || effectiveDay > week.endDay) {
      outsideWeek += 1;
      continue;
    }

    const state = getItemState(db, ranked.itemKey);
    if (state?.readAt !== null && state?.readAt !== undefined) {
      alreadyRead += 1;
      continue;
    }
    if (state?.dismissedAt !== null && state?.dismissedAt !== undefined) {
      dismissed += 1;
      continue;
    }

    const item = getCurrentItem(db, ranked.itemKey);
    // Unreachable: the key came from a scored row moments ago. Skipped rather
    // than thrown so one impossible row cannot cost the week its note.
    if (item === null) continue;

    consideredCount += 1;

    // The CURRENT version's own title, excerpt and payload -- not the
    // ranking row's. A wire service edits a story in place under one URL, and
    // ten keys in the live corpus have versions whose claim reverses
    // ("Wall Street holds near its record" -> "slips back from its record").
    // Beats and entities are the fields the single-version read gets wrong;
    // content is the field it gets right.
    const evidence = classifyEvidence({
      title: item.title,
      summaryRaw: item.summaryRaw,
      rawJson: item.rawJson,
    });

    const candidate: WeeklyCandidate = {
      itemKey: ranked.itemKey,
      title: item.title,
      url: item.url,
      sourceId: ranked.sourceId,
      kind,
      beat: ranked.beat,
      readScore: ranked.readScore,
      publishedAt: item.publishedAt,
      effectiveAt,
      effectiveDay,
      evidence,
      readTime: estimateReadTime(evidence),
    };

    if (evidence.level === 'headline') {
      if (headlineOnly.length < HEADLINE_ONLY_LIMIT) headlineOnly.push(candidate);
    } else if (candidates.length < limit) {
      candidates.push(candidate);
    }
  }

  return {
    week,
    candidates,
    headlineOnly,
    consideredCount,
    excluded: { wrongKind, alreadyRead, dismissed, outsideWeek },
  };
}
