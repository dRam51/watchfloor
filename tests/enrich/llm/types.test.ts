import { describe, expect, it } from 'vitest';
import {
  FREE_PRICING,
  computeCost,
  isLlmOk,
  makeUsage,
  type LlmPricing,
  type LlmResult,
  type LlmUsage,
} from '../../../src/enrich/llm/types.ts';

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

describe('makeUsage', () => {
  it('reports counted usage when the backend returned both halves', () => {
    expect(makeUsage(42, 27)).toEqual({
      inputTokens: 42,
      outputTokens: 27,
      totalTokens: 69,
      counted: true,
    });
  });

  it('keeps a partial count visible but refuses to call it counted', () => {
    // A backend that reports only the prompt half cannot be capped on total
    // tokens, so `counted` must be false -- but throwing the one real number
    // away would be its own kind of lie.
    expect(makeUsage(42, null)).toEqual({
      inputTokens: 42,
      outputTokens: null,
      totalTokens: null,
      counted: false,
    });
  });

  it('never invents a zero for a call whose tokens were never reported', () => {
    // §5's daily ceiling is built on these numbers. A hardcoded 0 here would
    // make an unmetered backend look infinitely cheap to the cap.
    expect(makeUsage(null, null)).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      counted: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

const PAID: LlmPricing = { usdPerMillionInputTokens: 3, usdPerMillionOutputTokens: 15 };

describe('computeCost', () => {
  it('reports a free-forever backend as a MEASURED zero, not an unknown', () => {
    // This is what feeds /api/dashboard/header's enrichmentSpend, which
    // distinguishes `{ amountUsd: 0, measured: true }` from
    // `{ amountUsd: null, measured: false }`.
    const cost = computeCost(makeUsage(42, 27), FREE_PRICING, 'ollama-local');
    expect(cost.amountUsd).toBe(0);
    expect(cost.measured).toBe(true);
    expect(cost.serviceId).toBe('ollama-local');
  });

  it('still reports a measured zero for a free backend that counted nothing', () => {
    // Zero times unknown is zero. A local backend's spend is a structural
    // guarantee, so it stays measurable even when its token counts are not --
    // which is exactly the case a crashed/unreachable local call produces.
    const cost = computeCost(makeUsage(null, null), FREE_PRICING, 'ollama-local');
    expect(cost.amountUsd).toBe(0);
    expect(cost.measured).toBe(true);
  });

  it('prices a billable backend from its counted tokens', () => {
    // 1,000,000 in at $3/M plus 1,000,000 out at $15/M.
    const cost = computeCost(makeUsage(1_000_000, 1_000_000), PAID, 'anthropic-api');
    expect(cost.amountUsd).toBe(18);
    expect(cost.measured).toBe(true);
  });

  it('refuses to price a billable backend whose tokens were not counted', () => {
    // Reporting $0 here would be a placeholder masquerading as a measurement
    // -- the exact failure src/domain/headerStrip.ts already refuses.
    const cost = computeCost(makeUsage(null, null), PAID, 'anthropic-api');
    expect(cost.amountUsd).toBeNull();
    expect(cost.measured).toBe(false);
  });

  it('refuses to price a billable backend from a half-counted call', () => {
    const cost = computeCost(makeUsage(500, null), PAID, 'anthropic-api');
    expect(cost.amountUsd).toBeNull();
    expect(cost.measured).toBe(false);
  });

  it('carries a note explaining the figure, so a zero is never bare', () => {
    expect(computeCost(makeUsage(1, 1), FREE_PRICING, 'ollama-local').note).toMatch(/\S/);
    expect(computeCost(makeUsage(null, null), PAID, 'anthropic-api').note).toMatch(/\S/);
  });
});

// ---------------------------------------------------------------------------
// The union: unavailable must be unmistakable
// ---------------------------------------------------------------------------

describe('a caller cannot mistake "the model was unavailable" for "it said nothing"', () => {
  it('will not compile if a caller reads the text without checking the status', () => {
    // These four `@ts-expect-error` directives ARE the assertion, and they are
    // checked by `npm run typecheck` (tsc -p tsconfig.test.json), NOT by
    // vitest -- esbuild strips types without checking them. Same technique
    // src/score/velocity.ts's insufficient-history branch uses, and here for
    // the same reason: an empty string stored as an enrichment result is
    // indistinguishable from a real one, forever.
    //
    // Self-guarding: adding `text` to the unavailable branch -- as '', as an
    // optional, as a `| null` -- makes every directive below unused and tsc
    // fails with TS2578. The guard cannot rot into a no-op.
    const result = unavailableResult();

    // @ts-expect-error text does not exist on the unavailable branch
    const direct: string = result.text;
    // @ts-expect-error destructuring is the same property access
    const { text } = result;
    // @ts-expect-error the property access fails before ?? can supply a default
    const defaulted: string = result.text ?? '';
    // @ts-expect-error finish is likewise an ok-branch-only fact
    const finish = result.finish;

    // Runtime half: TypeScript refused all four, but nothing stops a JS
    // caller, so record what those reads actually produce -- undefined, which
    // `?? ''` then turns into a confident, wrong "the model had nothing to say".
    expect(direct).toBeUndefined();
    expect(text).toBeUndefined();
    expect(defaulted).toBe('');
    expect(finish).toBeUndefined();
  });

  it('narrows to the ok branch through isLlmOk', () => {
    const result: LlmResult = okResult('a real answer');
    expect(isLlmOk(result)).toBe(true);
    if (!isLlmOk(result)) throw new Error('unreachable');
    const text: string = result.text;
    expect(text).toBe('a real answer');
  });

  it('reports usage and a cost figure on the unavailable branch too', () => {
    // A call that never reached a model still has to answer "what did this
    // cost?" -- otherwise a failing backend is invisible to §5's ceiling.
    const result = unavailableResult();
    expect(isLlmOk(result)).toBe(false);
    expect(result.cost.amountUsd).toBe(0);
    expect(result.cost.measured).toBe(true);
    expect(result.usage.counted).toBe(false);
  });
});

const ZERO_USAGE: LlmUsage = makeUsage(null, null);

/** Typed as the full union on purpose -- narrowing it would defeat the pins. */
function unavailableResult(): LlmResult {
  return {
    status: 'unavailable',
    reason: 'not_running',
    backend: 'ollama',
    model: 'llama3.2:latest',
    detail: 'connection refused',
    retryable: true,
    usage: ZERO_USAGE,
    cost: computeCost(ZERO_USAGE, FREE_PRICING, 'ollama-local'),
    latencyMs: 1,
    asOf: '2026-08-15T00:00:00.000Z',
  };
}

function okResult(text: string): LlmResult {
  const usage = makeUsage(10, 5);
  return {
    status: 'ok',
    text,
    finish: 'stop',
    backend: 'ollama',
    model: 'llama3.2:latest',
    usage,
    cost: computeCost(usage, FREE_PRICING, 'ollama-local'),
    latencyMs: 1,
    asOf: '2026-08-15T00:00:00.000Z',
  };
}
