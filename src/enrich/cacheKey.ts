/**
 * The enrichment cache key (M5 task 3).
 *
 * ## The decision: a hit is keyed on CONTENT, not on identity
 *
 * Enrichment re-runs constantly over an append-only corpus, so without a
 * cache every pass re-asks the model the same questions forever. The obvious
 * key is `item_key` -- it is what the rest of the system keys on, and it is
 * stable across re-polls. It is also wrong, and the corpus says so.
 *
 * `item_key` is `sha256(canonical_url)`. It is an identity for a URL, not for
 * what is AT that URL, and a wire service edits a story in place all day. In
 * a `VACUUM INTO` copy of the live corpus taken 2026-08-15 (5,937 keys, 7,267
 * stored versions), **ten keys have versions whose title or summary differ**,
 * every one of them a US-news headline:
 *
 *   * "Survivors face the challenge of rebuilding after Colombia quake"
 *     became "Signs of life emerge under Colombia quake rubble".
 *   * "Army identifies 2 Fort Hood helicopter pilots killed in crash" became
 *     "Army pauses Apache helicopter training missions after crash".
 *   * "Wall Street holds near its record ..." became "Wall Street slips back
 *     from its record ..." -- the direction of the claim reversed.
 *
 * Under identity keying each of those returns a summary of the earlier
 * version, indefinitely, with nothing anywhere reporting it. That is not a
 * missed cache hit; it is a confident wrong answer of exactly the shape
 * CLAUDE.md records as this project's worst bug class. So identity does not
 * decide a hit.
 *
 * What decides a hit is **the bytes we would have sent**: the task, the
 * backend, the model as requested, the system and user prompts, the bounds,
 * and a cache version. A hit therefore means "we already asked this exact
 * question of this exact model", which is the only statement under which
 * reusing the answer is sound. The item's `item_key` is still recorded on the
 * row (see src/db/llmCache.ts) -- as provenance, never as a lookup input.
 *
 * ### What content keying costs, stated rather than hidden
 *
 * Two versions that differ trivially miss. The archived first-run corpus has
 * 18 arXiv papers cross-listed across two beats whose abstracts differ only
 * in `Announce Type: new` vs `cross`; those pay two calls for one paper.
 * That is the right trade: the alternative buys back 18 local calls by
 * accepting the Colombia-quake failure above on every developing story.
 *
 * ### The one staleness hole content keying does NOT close
 *
 * `model` is the model as REQUESTED, because the key has to exist before the
 * call and the resolved name only arrives with the answer (`llama3.2` ->
 * `llama3.2:latest`). A FLOATING tag can be repointed underneath us: `ollama
 * pull llama3.2` can fetch a different build, and every prior row still
 * matches. src/db/llmCache.ts stores the resolved model alongside so this is
 * at least detectable; pinning the tag in `config/llm.yaml` is what closes
 * it. Recorded here because it is the one case where a hit is not a proof.
 *
 * ## Why the encoding is length-prefixed
 *
 * A plain `join` lets one field impersonate the next: task `sum` + model
 * `llama3.2` and task `sumllama3.2` + model `x` produce the same string, so
 * two genuinely different questions share one answer. Every field is
 * therefore emitted as `<byteLength>:<value>`, which no distinct field vector
 * can collide with -- and `null` gets `-1:`, keeping "no system role at all"
 * apart from "an empty system role", which are different requests on the wire.
 */

import { createHash } from 'node:crypto';
import type { LlmBackendName } from './llm/types.ts';

/**
 * Everything that decides what the model will say. Nothing that merely
 * identifies which item asked -- see the module doc for why.
 */
export interface EnrichmentCacheKeyInput {
  /**
   * Bumped in `config/enrichment.yaml` to invalidate every stored answer.
   * CLAUDE.md forbids deleting rows, so this is how a changed prompt template
   * retires its answers: the old rows stay on disk, unreachable and still
   * inspectable, instead of being cleared.
   */
  cacheVersion: number;
  /** What the answer is FOR (`summary`, `weekly_blurb`, ...). */
  task: string;
  backend: LlmBackendName;
  /** The model as REQUESTED, not as resolved. See the module doc. */
  model: string;
  /** `null` means no system message is sent at all -- not an empty one. */
  system: string | null;
  prompt: string;
  /** `null` means the call carried no per-request override. */
  maxOutputTokens: number | null;
  /** `null` means the call carried no per-request override. */
  temperature: number | null;
}

/**
 * Namespaces the digest. If the encoding below ever changes shape, bumping
 * this retires every old key without touching a row -- the same lever
 * `cacheVersion` gives the operator, held by the code instead.
 */
const KEY_SCHEME = 'wf-enrichment-cache/1';

/** `<byteLength>:<value>`, or `-1:` for an absent field. */
function field(value: string | null): string {
  if (value === null) return '-1:';
  return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

function numberField(value: number | null): string {
  return field(value === null ? null : String(value));
}

/**
 * The cache key for one enrichment question: a 64-character lowercase sha256
 * hex digest, the same shape `item_key` uses (src/domain/item.ts), so the two
 * are interchangeable in a column type and never in meaning.
 */
export function enrichmentCacheKey(input: EnrichmentCacheKeyInput): string {
  if (!Number.isInteger(input.cacheVersion) || input.cacheVersion < 0) {
    throw new RangeError(
      `cacheVersion '${input.cacheVersion}' must be a non-negative integer -- it is the row's invalidation generation, not a free-form label`,
    );
  }
  // A blank task or model would produce a well-formed key for a row that
  // cannot say what it holds or who answered it. Rejected here rather than at
  // the storage layer, so no caller can construct one at all.
  if (input.task === '') {
    throw new RangeError('task must not be empty -- a cache row has to say what it is an answer to');
  }
  if (input.model === '') {
    throw new RangeError('model must not be empty -- a cache row has to say which model answered');
  }

  const encoded = [
    field(KEY_SCHEME),
    numberField(input.cacheVersion),
    field(input.task),
    field(input.backend),
    field(input.model),
    field(input.system),
    field(input.prompt),
    numberField(input.maxOutputTokens),
    numberField(input.temperature),
  ].join('|');

  return createHash('sha256').update(encoded, 'utf8').digest('hex');
}
