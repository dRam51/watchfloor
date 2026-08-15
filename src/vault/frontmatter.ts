/**
 * The frontmatter gate and the managed-block protocol (M5 task 4).
 *
 * §8.1: **"Never modify a file lacking Watchfloor frontmatter."**
 *
 * This is the rule that saves the owner's twelve hand-authored notes. They are
 * prose, written by hand, and **none of them carries any frontmatter at all**
 * — so the gate's job is to answer "no" for every one of them, and for
 * anything else a human might plausibly write, including a hand-written note
 * *about* Watchfloor. Several of those twelve are exactly that.
 *
 * ## Two gates, in two directions
 *
 * - **Producer.** {@link renderManagedNote} is the only function that returns
 *   {@link ManagedContent}, and the whole-file write path accepts nothing
 *   else. A caller therefore cannot write a file that lacks our marker, which
 *   is what makes the *next* run's consumer gate meaningful — a file we wrote
 *   without a marker would be a file we could never safely touch again.
 * - **Consumer.** {@link isWatchfloorManaged} is checked against what is
 *   actually on disk immediately before every overwrite. The brand proves what
 *   we are about to write; only reading proves what is already there.
 *
 * ## What makes the marker unforgeable by accident
 *
 * Four conditions, all required:
 *
 * 1. The frontmatter fence is the **very first byte** of the file. A note
 *    quoting one of our daily notes therefore does not become ours.
 * 2. The block parses as a YAML **mapping** — a scalar or a list is not ours.
 * 3. Top-level key `watchfloor`, exact string value `managed`. Not a tag, not
 *    a value: `project: watchfloor` is somebody's own note about this project.
 * 4. Top-level key `watchfloor_tier`, one of §8.1's three tiers.
 *
 * Every failure — including a YAML parse error — answers **no**. Fail closed:
 * a file we cannot parse is a file we do not understand, and "do not
 * understand" must never resolve to "overwrite".
 *
 * ## The one place §8.1 argues with itself, and how it is resolved
 *
 * §8.1 says "never modify a file lacking Watchfloor frontmatter" AND, of
 * `entities/`, "if the markers are missing from an existing file, **append**
 * them — never clobber a file you did not create." A pre-existing hand-written
 * entity note has no frontmatter, so the first rule forbids what the second
 * requires. M5 acceptance settles the intent: *"a hand-edited entity note's
 * own prose survives untouched"* — the note is processed, and its prose
 * survives.
 *
 * The resolution is not a judgement call, it is a provable property.
 * {@link applyManagedBlock} on a marker-less file **appends only**, and
 * asserts at runtime that the original bytes are a strict prefix of the
 * result. Nothing is modified in the sense the rule cares about, because
 * nothing that was there can be gone. Note the consequence: such a file is
 * never given frontmatter, because prepending would not be an append. It is
 * recognised by its markers from then on, which is why the entity write path
 * tests `isWatchfloorManaged(text) || hasManagedBlock(text)`.
 *
 * Whole-file overwrite (`daily/`, `weekly/`) gets no such latitude: there, the
 * frontmatter gate is absolute.
 *
 * This module is pure. It reads no clock, touches no filesystem, and every
 * timestamp is injected — the same contract every domain module in this
 * project keeps.
 */

import { parse as parseYaml } from 'yaml';
import { assertCanonicalTimestamp } from '../domain/item.ts';
import type { VaultTier } from './paths.ts';

export class VaultContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultContentError';
  }
}

/** §8.1's marker pair, verbatim. */
export const WATCHFLOOR_BEGIN_MARKER = '<!-- watchfloor:begin -->';
export const WATCHFLOOR_END_MARKER = '<!-- watchfloor:end -->';

const OWNERSHIP_KEY = 'watchfloor';
const OWNERSHIP_VALUE = 'managed';
const TIER_KEY = 'watchfloor_tier';
const GENERATED_AT_KEY = 'watchfloor_generated_at';
const RESERVED_KEYS: readonly string[] = [OWNERSHIP_KEY, TIER_KEY, GENERATED_AT_KEY];

const VALID_TIERS: readonly VaultTier[] = ['fully-managed', 'managed-block', 'write-once'];

const FENCE = '---';

declare const managedContentBrand: unique symbol;

/**
 * A complete note body that provably carries Watchfloor frontmatter, because
 * {@link renderManagedNote} put it there.
 *
 * Branded exactly as `Excerpt` is in `src/domain/repo.ts`, and for the same
 * reason: a plain `string` parameter would let any caller pass arbitrary text
 * to a whole-file write, and TypeScript would accept it. The brand is declared
 * and never defined, so it exists only in the type system — no runtime
 * property, nothing to serialise, every string operation still works. An
 * explicit `as ManagedContent` remains possible, and that is the point: it is
 * visible in review rather than silent.
 */
export type ManagedContent = string & { readonly [managedContentBrand]: true };

/**
 * Extracts the leading frontmatter block's raw text, or `null` if the file
 * does not open with one.
 *
 * Deliberately strict about the opening fence: it must be the first three
 * bytes, followed by a newline and nothing else on that line. An indented or
 * suffixed fence (`---yaml`) is not frontmatter here even where some parsers
 * would accept it, because the loosest reading is the one that lets an
 * unrelated file be claimed.
 */
function frontmatterText(text: string): string | null {
  if (!text.startsWith(`${FENCE}\n`)) return null;
  const rest = text.slice(FENCE.length + 1);
  const lines = rest.split('\n');
  const closing = lines.indexOf(FENCE);
  if (closing === -1) return null;
  return lines.slice(0, closing).join('\n');
}

/**
 * Whether this file's own frontmatter says Watchfloor generated it.
 *
 * Answers `false` for every failure mode, including a YAML parse error. See
 * the module comment for the four conditions and why each one is there.
 */
export function isWatchfloorManaged(text: string): boolean {
  const block = frontmatterText(text);
  if (block === null) return false;

  let parsed: unknown;
  try {
    parsed = parseYaml(block);
  } catch {
    return false; // fail closed
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;

  const record = parsed as Record<string, unknown>;
  if (record[OWNERSHIP_KEY] !== OWNERSHIP_VALUE) return false;
  return VALID_TIERS.includes(record[TIER_KEY] as VaultTier);
}

export interface ManagedNoteInput {
  readonly tier: VaultTier;
  /** Canonical UTC timestamp, injected. Never read from the wall clock here. */
  readonly generatedAt: string;
  readonly body: string;
  /** Extra frontmatter a later task supplies (date, per-beat counts, ...). */
  readonly fields?: Readonly<Record<string, unknown>>;
}

function assertNoMarkers(text: string, what: string): void {
  if (text.includes(WATCHFLOOR_BEGIN_MARKER) || text.includes(WATCHFLOOR_END_MARKER)) {
    // Content deciding where the managed block ends is the injection that
    // turns a generated blurb into a rewrite of the owner's own prose.
    throw new VaultContentError(`${what} must not contain a watchfloor block marker`);
  }
}

function renderFrontmatterValue(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') {
    // Quote anything that could be read as YAML structure rather than as text.
    return /^[A-Za-z0-9][A-Za-z0-9 ._:\/-]*$/.test(value) ? value : JSON.stringify(value);
  }
  return JSON.stringify(value);
}

/**
 * The only sanctioned way to build {@link ManagedContent}.
 *
 * Output is a pure function of its input, so the fully-managed tier's
 * "idempotent overwrite" is a property of this function rather than a habit of
 * its callers: the same inputs produce byte-identical output, and the M5
 * acceptance test's "delete the tree and reproduce it exactly" reduces to
 * supplying the same inputs.
 */
export function renderManagedNote(input: ManagedNoteInput): ManagedContent {
  // The marker ban applies to a CALLER-SUPPLIED body only. `applyManagedBlock`
  // composes the frontmatter with a block it built itself, and goes through
  // `renderFrontmatterBlock` directly for exactly that reason.
  assertNoMarkers(input.body, 'note body');
  const frontmatter = renderFrontmatterBlock(input.tier, input.generatedAt, input.fields);
  const body = input.body.replace(/\n+$/, '');
  return `${frontmatter}\n${body}\n` as ManagedContent;
}

function renderFrontmatterBlock(
  tier: VaultTier,
  generatedAt: string,
  fields?: Readonly<Record<string, unknown>>,
): string {
  assertCanonicalTimestampOrThrow(generatedAt);
  const lines = [
    FENCE,
    `${OWNERSHIP_KEY}: ${OWNERSHIP_VALUE}`,
    `${TIER_KEY}: ${tier}`,
    `${GENERATED_AT_KEY}: ${generatedAt}`,
  ];
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (RESERVED_KEYS.includes(key)) {
      // A caller able to set `watchfloor:` could render a note that the gate
      // would then refuse to update, stranding it forever.
      throw new VaultContentError(`frontmatter key ${JSON.stringify(key)} is reserved`);
    }
    assertNoMarkers(String(value), `frontmatter value for ${key}`);
    lines.push(`${key}: ${renderFrontmatterValue(value)}`);
  }
  lines.push(FENCE);
  return `${lines.join('\n')}\n`;
}

function assertCanonicalTimestampOrThrow(value: string): void {
  try {
    assertCanonicalTimestamp('generatedAt', value);
  } catch (cause) {
    throw new VaultContentError((cause as Error).message);
  }
}

export type ManagedBlockSplit =
  | { readonly kind: 'present'; readonly prologue: string; readonly epilogue: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'malformed'; readonly detail: string };

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/**
 * Locates the managed block, returning the bytes on either side of it.
 *
 * Fails closed on anything ambiguous — two begins, an end before its begin, a
 * begin with no end. Guessing where a block "probably" ends is guessing which
 * of the owner's paragraphs to overwrite.
 */
export function splitManagedBlock(text: string): ManagedBlockSplit {
  const begins = countOccurrences(text, WATCHFLOOR_BEGIN_MARKER);
  const ends = countOccurrences(text, WATCHFLOOR_END_MARKER);
  if (begins === 0 && ends === 0) return { kind: 'absent' };
  if (begins !== 1 || ends !== 1) {
    return { kind: 'malformed', detail: `found ${begins} begin and ${ends} end markers` };
  }
  const beginAt = text.indexOf(WATCHFLOOR_BEGIN_MARKER);
  const endAt = text.indexOf(WATCHFLOOR_END_MARKER);
  if (endAt < beginAt) {
    return { kind: 'malformed', detail: 'the end marker precedes the begin marker' };
  }
  return {
    kind: 'present',
    prologue: text.slice(0, beginAt),
    epilogue: text.slice(endAt + WATCHFLOOR_END_MARKER.length),
  };
}

/** Whether a well-formed managed block is present. Malformed answers `false`. */
export function hasManagedBlock(text: string): boolean {
  return splitManagedBlock(text).kind === 'present';
}

export interface ManagedBlockOptions {
  readonly generatedAt: string;
  /** Used only when creating the file from nothing. */
  readonly title: string;
}

function blockText(body: string): string {
  return `${WATCHFLOOR_BEGIN_MARKER}\n${body.replace(/\n+$/, '')}\n${WATCHFLOOR_END_MARKER}`;
}

/**
 * Produces the new full text of an `entities/` note.
 *
 * Three cases, and the invariant each one carries:
 *
 * - **File absent** — render a complete managed note (frontmatter + markers).
 * - **Markers present** — replace between them. The prologue and epilogue are
 *   literal slices of the existing text and are re-emitted unchanged, so the
 *   bytes outside the block are byte-identical by construction.
 * - **Markers absent** — append. Asserted at runtime: the existing text must
 *   be a **strict prefix** of the result. This is §8.1's "append them — never
 *   clobber a file you did not create", as a checked property rather than a
 *   claim about the code that happens to be here.
 *
 * A malformed existing file throws. So does a body containing a marker.
 */
export function applyManagedBlock(
  existing: string | null,
  body: string,
  options: ManagedBlockOptions,
): string {
  assertNoMarkers(body, 'managed block body');

  if (existing === null) {
    const frontmatter = renderFrontmatterBlock('managed-block', options.generatedAt, {
      title: options.title,
    });
    return `${frontmatter}\n# ${options.title}\n\n${blockText(body)}\n`;
  }

  const split = splitManagedBlock(existing);
  if (split.kind === 'malformed') {
    throw new VaultContentError(
      `refusing to touch a note with a malformed watchfloor block: ${split.detail}`,
    );
  }

  if (split.kind === 'absent') {
    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    const result = `${existing}${separator}${blockText(body)}\n`;
    if (!result.startsWith(existing)) {
      // Unreachable by construction; asserted because "by construction" is
      // exactly the kind of claim that stops being true during a refactor.
      throw new VaultContentError('append would not have preserved the existing bytes');
    }
    return result;
  }

  const result = `${split.prologue}${blockText(body)}${split.epilogue}`;
  if (
    !result.startsWith(split.prologue) ||
    !result.endsWith(split.epilogue) ||
    result.length < split.prologue.length + split.epilogue.length
  ) {
    throw new VaultContentError('replacement would not have preserved the bytes outside the block');
  }
  return result;
}
