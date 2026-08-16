/**
 * The wire half of §8.2's prohibition (M5 task 10). The data half lives in
 * tests/mcp/readonly.test.ts.
 *
 * > *"What Watchfloor must never expose or compute: sentiment scores,
 * > directional labels (bullish/bearish), price targets, conviction ratings,
 * > trade signals, position sizing, or any field whose name implies a
 * > recommendation."*
 *
 * The bar this project sets for a claim like that is mutation, so the tool
 * that actually tries to leak `read_score` lives in tests/mcp/server.test.ts,
 * where it is registered against the real dispatcher. This file pins the
 * primitive that stops it.
 */

import { describe, it, expect } from 'vitest';
import { normalizeFieldName, forbiddenPhraseFor, FORBIDDEN_FIELD_PHRASES } from '../../src/mcp/fields.ts';
import { sealBotPayload, ForbiddenFieldError, UnserializableValueError } from '../../src/mcp/serialize.ts';

describe('normalizeFieldName', () => {
  it.each([
    ['read_score', 'read score'],
    ['readScore', 'read score'],
    ['READ_SCORE', 'read score'],
    ['read-score', 'read score'],
    ['Read Score', 'read score'],
    ['read.score', 'read score'],
    ['HTTPStatus', 'http status'],
    ['signalScore2', 'signal score2'],
    ['operating_system', 'operating system'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeFieldName(input)).toBe(expected);
  });
});

describe('forbiddenPhraseFor', () => {
  it.each([
    'read_score',
    'readScore',
    'READ_SCORE',
    'read-score',
    'itemReadScore',
    'readScoreDecayed',
    'sentiment',
    'sentimentScore',
    'bullish',
    'isBearish',
    'price_target',
    'targetPrice',
    'conviction',
    'convictionRating',
    'analyst_rating',
    'tradeSignal',
    'position_size',
    'positionSizing',
    'recommendation',
    'recommended_action',
    'stopLoss',
    'takeProfit',
  ])('refuses %s', (name) => {
    expect(forbiddenPhraseFor(name)).not.toBeNull();
  });

  it.each([
    'signal_score',
    'signalScore',
    'item_key',
    'clusterSize',
    'publishedAt',
    'sourceId',
    'beats',
    'entities',
    'stars',
    'weight',
    // The false positive that decided word-matching over substring-matching:
    // `operating` contains `rating`.
    'operating_system',
    'aggregator',
  ])('allows %s', (name) => {
    expect(forbiddenPhraseFor(name)).toBeNull();
  });

  it('names the rule it broke, so a refusal is actionable', () => {
    expect(forbiddenPhraseFor('readScore')).toBe('read score');
    expect(forbiddenPhraseFor('convictionRating')).toBe('conviction');
  });

  it('every listed phrase is itself refused — the list cannot contain a dead entry', () => {
    for (const phrase of FORBIDDEN_FIELD_PHRASES) {
      expect(forbiddenPhraseFor(phrase), phrase).toBe(phrase);
    }
  });
});

describe('sealBotPayload', () => {
  it('passes a clean payload through unchanged', () => {
    const payload = {
      items: [{ itemKey: 'aaa', signalScore: 4.5, beats: ['cyber'], publishedAt: null }],
      total: 1,
    };
    expect(sealBotPayload(payload)).toEqual(payload);
  });

  it('refuses read_score at the top level', () => {
    expect(() => sealBotPayload({ read_score: 9.25 })).toThrow(ForbiddenFieldError);
  });

  it('refuses readScore nested inside an array of objects', () => {
    let caught: ForbiddenFieldError | null = null;
    try {
      sealBotPayload({ items: [{ itemKey: 'aaa' }, { itemKey: 'bbb', readScore: 9.25 }] });
    } catch (err) {
      caught = err as ForbiddenFieldError;
    }
    expect(caught).toBeInstanceOf(ForbiddenFieldError);
    expect(caught?.field).toBe('readScore');
    expect(caught?.phrase).toBe('read score');
    // The path is what makes a refusal debuggable rather than a mystery.
    expect(caught?.path).toBe('items[1].readScore');
  });

  it('refuses a directional label used as a field name', () => {
    expect(() => sealBotPayload({ outlook: { bullish: true } })).toThrow(/bullish/);
  });

  // ------------------------------------------------------------------------
  // The deliberate limit, stated rather than discovered.
  // ------------------------------------------------------------------------
  // The rule is about field NAMES, because that is what §8.2 says and because
  // blocking values would corrupt real data: a headline genuinely reads
  // "Wall Street turns bearish", and an item title is content the system
  // relays, not a label it computed. A tool that emits {label: "bullish"}
  // therefore passes this layer -- recorded in the task report as the residual,
  // not hidden.
  it('does not refuse a forbidden word appearing as a VALUE', () => {
    expect(() => sealBotPayload({ title: 'Wall Street turns bearish on chip stocks' })).not.toThrow();
  });

  it('refuses the forbidden name even when it is an object key with no value', () => {
    expect(() => sealBotPayload({ scores: { sentiment: null } })).toThrow(ForbiddenFieldError);
  });

  it('never echoes the offending VALUE in the error — refusing must not leak', () => {
    let message = '';
    try {
      sealBotPayload({ readScore: 9.25 });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('readScore');
    expect(message).not.toContain('9.25');
  });
});

describe('sealBotPayload and values JSON would silently mangle', () => {
  it('refuses NaN rather than letting it become null on the wire', () => {
    expect(() => sealBotPayload({ signalScore: Number.NaN })).toThrow(UnserializableValueError);
  });

  it('refuses Infinity for the same reason', () => {
    expect(() => sealBotPayload({ signalScore: Number.POSITIVE_INFINITY })).toThrow(
      UnserializableValueError,
    );
  });

  it('refuses undefined inside an object, which JSON.stringify would drop', () => {
    expect(() => sealBotPayload({ itemKey: undefined })).toThrow(UnserializableValueError);
  });

  it('refuses a function', () => {
    expect(() => sealBotPayload({ go: () => 1 })).toThrow(UnserializableValueError);
  });

  it('refuses a bigint, which JSON.stringify throws on', () => {
    expect(() => sealBotPayload({ n: 1n })).toThrow(UnserializableValueError);
  });

  it('refuses a cycle by name rather than by stack overflow', () => {
    const a: Record<string, unknown> = { itemKey: 'aaa' };
    a.self = a;
    expect(() => sealBotPayload(a)).toThrow(UnserializableValueError);
  });

  it('allows null, which is a real answer', () => {
    expect(() => sealBotPayload({ publishedAt: null })).not.toThrow();
  });
});
