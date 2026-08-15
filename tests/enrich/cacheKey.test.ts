import { describe, expect, it } from 'vitest';
import { enrichmentCacheKey, type EnrichmentCacheKeyInput } from '../../src/enrich/cacheKey.ts';

/**
 * The cache key is the whole safety argument of M5 task 3, so these tests are
 * mostly about what must NOT collide.
 *
 * The corpus evidence quoted below is real, and it is what settled the
 * identity-vs-content question. Query, against a `VACUUM INTO` copy of the
 * live corpus on 2026-08-15 (5,937 item_keys, 7,267 stored versions):
 *
 *     with v as (select item_key, count(*) c, count(distinct title) t,
 *                       count(distinct coalesce(summary_raw,'')) s
 *                  from items group by item_key)
 *     select * from v where t > 1 or s > 1;
 *
 * Ten keys came back. Every one of them is a story whose CONTENT changed
 * under a URL that never did -- so an `item_key`-keyed cache would serve a
 * summary of the earlier version forever, with nothing anywhere reporting it.
 */

const BASE: EnrichmentCacheKeyInput = {
  cacheVersion: 1,
  task: 'summary',
  backend: 'ollama',
  model: 'llama3.2',
  system: 'Summarise in one line.',
  prompt: 'Signs of life emerge under Colombia quake rubble',
  maxOutputTokens: 512,
  temperature: 0,
};

function keyWith(overrides: Partial<EnrichmentCacheKeyInput>): string {
  return enrichmentCacheKey({ ...BASE, ...overrides });
}

describe('enrichmentCacheKey', () => {
  it('is a 64-character lowercase sha256 hex digest', () => {
    expect(enrichmentCacheKey(BASE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across calls with identical input', () => {
    expect(enrichmentCacheKey(BASE)).toBe(enrichmentCacheKey({ ...BASE }));
  });

  it('does not depend on property order', () => {
    const reordered: EnrichmentCacheKeyInput = {
      temperature: BASE.temperature,
      prompt: BASE.prompt,
      model: BASE.model,
      cacheVersion: BASE.cacheVersion,
      maxOutputTokens: BASE.maxOutputTokens,
      backend: BASE.backend,
      system: BASE.system,
      task: BASE.task,
    };
    expect(enrichmentCacheKey(reordered)).toBe(enrichmentCacheKey(BASE));
  });
});

describe('the stale-version failure this key exists to prevent', () => {
  // ap-news, item_key 1f88cd304c7ae28b9570af8a1e8e5d329128b24bc14c76121db351ace4944d59.
  // Three stored versions on 2026-08-14 (18:38, 20:16, 23:40 UTC), one URL,
  // one item_key. The headline moved from the aftermath to a rescue.
  const COLOMBIA_V1 = 'Survivors face the challenge of rebuilding after Colombia quake';
  const COLOMBIA_V3 = 'Signs of life emerge under Colombia quake rubble';

  // ap-news, 563ddaec26a476c3f36a2a97384c61d79ab3292059359cc53449be7d86ac4b9b.
  const FORT_HOOD_V1 = 'Army identifies 2 Fort Hood helicopter pilots killed in crash';
  const FORT_HOOD_V3 = 'Army pauses Apache helicopter training missions after crash';

  // ap-news, a1a0c3f2558dce96ddcf0c59b607a9175936a011fabfae2b94cea4b57e9f26bf.
  // The direction of the claim reverses between the two versions.
  const MARKETS_V1 = 'Wall Street holds near its record following the latest weak update on the US economy';
  const MARKETS_V2 = 'Wall Street slips back from its record following the latest weak update on the US economy';

  it.each([
    ['a developing disaster story', COLOMBIA_V1, COLOMBIA_V3],
    ['a story whose subject changed entirely', FORT_HOOD_V1, FORT_HOOD_V3],
    ['a claim whose direction reversed', MARKETS_V1, MARKETS_V2],
  ])('misses when a real item is re-polled with revised content: %s', (_label, before, after) => {
    expect(keyWith({ prompt: after })).not.toBe(keyWith({ prompt: before }));
  });

  it('still hits when the same item is re-polled UNCHANGED, which is the common case', () => {
    // 1,149 of 5,937 keys in the live corpus have more than one stored
    // version; only 10 of those changed content. The cache has to be a hit
    // for the other 1,139, or it saves nothing.
    expect(keyWith({ prompt: COLOMBIA_V1 })).toBe(keyWith({ prompt: COLOMBIA_V1 }));
  });
});

describe('every input that changes the answer changes the key', () => {
  it('separates two models -- a hit across them would attribute one model output to another', () => {
    expect(keyWith({ model: 'llama3.2' })).not.toBe(keyWith({ model: 'qwen2.5' }));
  });

  it('separates two backends running the same model name', () => {
    expect(keyWith({ backend: 'ollama' })).not.toBe(keyWith({ backend: 'anthropic' }));
  });

  it('separates two tasks over identical content', () => {
    // §8.1's weekly blurb and a one-line summary are different answers to the
    // same article. Sharing a row would put a blurb where a summary belongs.
    expect(keyWith({ task: 'summary' })).not.toBe(keyWith({ task: 'weekly_blurb' }));
  });

  it('separates two system prompts', () => {
    expect(keyWith({ system: 'Summarise in one line.' })).not.toBe(
      keyWith({ system: 'Explain why this matters.' }),
    );
  });

  it('distinguishes an ABSENT system role from an empty one', () => {
    // Not pedantry: `system: undefined` sends no system message at all, while
    // `''` sends an empty one. Collapsing them would let a prompt-shape change
    // reuse an answer produced under the other shape.
    expect(keyWith({ system: null })).not.toBe(keyWith({ system: '' }));
  });

  it('separates two output-token caps', () => {
    // A completion truncated at 64 tokens is a different artifact from one
    // allowed 512, and `finish: 'length'` is stored alongside it.
    expect(keyWith({ maxOutputTokens: 64 })).not.toBe(keyWith({ maxOutputTokens: 512 }));
  });

  it('separates two temperatures', () => {
    expect(keyWith({ temperature: 0 })).not.toBe(keyWith({ temperature: 0.8 }));
  });

  it('distinguishes an unset bound from a set one', () => {
    expect(keyWith({ maxOutputTokens: null })).not.toBe(keyWith({ maxOutputTokens: 512 }));
    expect(keyWith({ temperature: null })).not.toBe(keyWith({ temperature: 0 }));
  });

  it('changes wholesale when cacheVersion is bumped', () => {
    // The invalidation lever. CLAUDE.md forbids deleting rows, so a changed
    // prompt template is invalidated by bumping this in
    // config/enrichment.yaml -- every old row stays on disk, unreachable and
    // inspectable, rather than being cleared.
    expect(keyWith({ cacheVersion: 1 })).not.toBe(keyWith({ cacheVersion: 2 }));
  });
});

describe('field boundaries cannot be forged', () => {
  // A naive `[task, model, prompt].join(':')` lets content from one field
  // impersonate the next one. Length-prefixed encoding makes that impossible,
  // and these are the cases that would otherwise collide.
  it('does not let a task name absorb the model name', () => {
    expect(keyWith({ task: 'sum', model: 'llama3.2' })).not.toBe(
      keyWith({ task: 'sumllama3.2', model: 'x' }),
    );
  });

  it('does not let a system prompt absorb the user prompt', () => {
    expect(keyWith({ system: 'abc', prompt: 'def' })).not.toBe(
      keyWith({ system: 'ab', prompt: 'cdef' }),
    );
  });

  it('does not let a delimiter inside a prompt shift the boundary', () => {
    expect(keyWith({ system: 'a|1:', prompt: 'b' })).not.toBe(
      keyWith({ system: 'a', prompt: '|1:b' }),
    );
  });
});

describe('rejects input it cannot key honestly', () => {
  it('refuses a non-integer or negative cacheVersion', () => {
    expect(() => keyWith({ cacheVersion: 1.5 })).toThrow(RangeError);
    expect(() => keyWith({ cacheVersion: -1 })).toThrow(RangeError);
  });

  it('refuses an empty task -- the row would not say what it is for', () => {
    expect(() => keyWith({ task: '' })).toThrow(RangeError);
  });

  it('refuses an empty model', () => {
    expect(() => keyWith({ model: '' })).toThrow(RangeError);
  });
});
