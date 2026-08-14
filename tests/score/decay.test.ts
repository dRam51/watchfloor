import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidTimestampError } from '../../src/domain/item.ts';
import {
  effectivePublishedAt,
  decayFactor,
  resolveHalfLifeHours,
  computeDecayFactor,
  parseDecayConfig,
  loadDecayConfig,
  DecayConfigError,
  UnknownDecayKeyError,
  type DecayConfig,
  type DecayInput,
} from '../../src/score/decay.ts';

// ---------------------------------------------------------------------------
// A minimal, hand-built config used by most tests below, independent of the
// real checked-in config/decay.yaml (which gets its own dedicated tests at
// the bottom of this file). Numbers are chosen to make the math land on
// clean, hand-checkable values -- e.g. 'cyber' signal has a 6h half-life so
// an age of 6h, 12h, 18h lands exactly on 1, 2, 3 half-lives.
//
// This mirrors the *shape* of the real config but is deliberately NOT copied
// from src/score/decay.ts's own implementation -- these are independent
// numbers chosen for test legibility, not derived from the shipped values.
// ---------------------------------------------------------------------------
function testConfig(): DecayConfig {
  return {
    beats: {
      ai: { signal_half_life_hours: 48, read_half_life_hours: 504 },
      cyber: { signal_half_life_hours: 6, read_half_life_hours: 336 },
      aisec: { signal_half_life_hours: 8, read_half_life_hours: 336 },
      repos: { signal_half_life_hours: 72, read_half_life_hours: 336 },
      usnews: { signal_half_life_hours: 24, read_half_life_hours: 168 },
    },
    markets_item_types: {
      event: { signal_half_life_hours: 4, read_half_life_hours: 168 },
      analysis: { signal_half_life_hours: 240, read_half_life_hours: 720 },
      press: { signal_half_life_hours: 6, read_half_life_hours: 168 },
    },
  };
}

const NOW = '2026-08-14T00:00:00.000Z';

function hoursBefore(iso: string, hours: number): string {
  return new Date(Date.parse(iso) - hours * 3_600_000).toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z');
}

// ---------------------------------------------------------------------------
// effectivePublishedAt -- the null published_at decision, isolated
// ---------------------------------------------------------------------------
// M1's first live ingest had 1,715 of 3,325 items with published_at null
// (1,665 of those from cisa-kev alone, whose JSON feed carries no publish-
// date field at all -- verified against attic/wf-m1-firstrun-2026-08-14.db).
// The decision: fall back to fetchedAt. Weighed against the alternatives:
//   - treat as maximally old -> buries an undated item permanently, even if
//     it is genuinely important (a KEV entry with no date is still a KEV
//     entry). Silent and irrecoverable under append-only storage.
//   - treat as maximally fresh -> undated churn would dominate every list
//     forever, growing worse as more unhandled-format sources appear.
//   - fall back to fetchedAt -> always defined (NOT NULL in the schema),
//     and defensible: it answers "how long has it been since we noticed
//     this" rather than "how long has it been since this happened". The
//     stated cost: a genuinely old document surfaced late (e.g. a historical
//     CVE our scanner only just found) will look artificially fresh relative
//     to items whose true publish date is known. That's a real, accepted
//     trade-off, not a silent one.
describe('effectivePublishedAt (the null published_at decision)', () => {
  it('uses publishedAt directly when present', () => {
    expect(
      effectivePublishedAt({ publishedAt: '2026-08-01T00:00:00.000Z', fetchedAt: '2026-08-10T00:00:00.000Z' }),
    ).toBe('2026-08-01T00:00:00.000Z');
  });

  it('falls back to fetchedAt when publishedAt is null', () => {
    expect(effectivePublishedAt({ publishedAt: null, fetchedAt: '2026-08-10T00:00:00.000Z' })).toBe(
      '2026-08-10T00:00:00.000Z',
    );
  });

  it('real cisa-kev shape: published_at null, fetched_at from the first live ingest', () => {
    // Copied by hand from attic/wf-m1-firstrun-2026-08-14.db (read-only,
    // never opened by this test): "Metabase SQL Injection Vulnerability",
    // source_id cisa-kev, item_type event, published_at NULL,
    // fetched_at 2026-08-14T03:47:10.404Z.
    expect(
      effectivePublishedAt({ publishedAt: null, fetchedAt: '2026-08-14T03:47:10.404Z' }),
    ).toBe('2026-08-14T03:47:10.404Z');
  });
});

describe('decayFactor -- null published_at flows through to the actual decay math', () => {
  it('an undated item decays identically to a dated item whose publishedAt equals its fetchedAt', () => {
    const fetchedAt = '2026-08-01T00:00:00.000Z';
    const undated = decayFactor({ publishedAt: null, fetchedAt }, NOW, 24);
    const datedAtFetch = decayFactor({ publishedAt: fetchedAt, fetchedAt }, NOW, 24);
    expect(undated).toBe(datedAtFetch);
  });

  it('is NOT treated as uniformly fresh: an undated item fetched long ago decays more than one fetched recently', () => {
    const oldUndated = decayFactor({ publishedAt: null, fetchedAt: '2026-06-01T00:00:00.000Z' }, NOW, 24);
    const recentUndated = decayFactor({ publishedAt: null, fetchedAt: '2026-08-13T00:00:00.000Z' }, NOW, 24);
    expect(oldUndated).toBeLessThan(recentUndated);
  });

  it('is NOT treated as maximally stale: an undated item fetched moments ago is nearly as fresh as a freshly-published one', () => {
    const undatedJustFetched = decayFactor({ publishedAt: null, fetchedAt: NOW }, NOW, 24);
    expect(undatedJustFetched).toBeCloseTo(1, 9);
  });
});

// ---------------------------------------------------------------------------
// decayFactor -- the pure numeric core
// ---------------------------------------------------------------------------
describe('decayFactor', () => {
  it('is exactly 1 at age zero, regardless of half-life', () => {
    expect(decayFactor({ publishedAt: NOW, fetchedAt: NOW }, NOW, 6)).toBe(1);
    expect(decayFactor({ publishedAt: NOW, fetchedAt: NOW }, NOW, 720)).toBe(1);
  });

  it('is exactly one half at age == halfLife', () => {
    const publishedAt = hoursBefore(NOW, 6);
    expect(decayFactor({ publishedAt, fetchedAt: publishedAt }, NOW, 6)).toBeCloseTo(0.5, 12);
  });

  it('is one quarter at age == 2x halfLife, one eighth at 3x', () => {
    const halfLife = 10;
    expect(
      decayFactor({ publishedAt: hoursBefore(NOW, 20), fetchedAt: hoursBefore(NOW, 20) }, NOW, halfLife),
    ).toBeCloseTo(0.25, 12);
    expect(
      decayFactor({ publishedAt: hoursBefore(NOW, 30), fetchedAt: hoursBefore(NOW, 30) }, NOW, halfLife),
    ).toBeCloseTo(0.125, 12);
  });

  it('is monotonically non-increasing as age increases, across a wide sweep including the double-precision underflow boundary', () => {
    const halfLife = 1; // 1-hour half-life makes the sweep below span ~1076 half-lives
    const ages = [0, 1, 2, 5, 10, 50, 100, 500, 1000, 1074, 1075, 1076, 2000, 10000, 100000];
    const factors = ages.map((age) =>
      decayFactor({ publishedAt: hoursBefore(NOW, age), fetchedAt: hoursBefore(NOW, age) }, NOW, halfLife),
    );
    for (let i = 1; i < factors.length; i++) {
      expect(factors[i]).toBeLessThanOrEqual(factors[i - 1]!);
    }
    for (const f of factors) {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
      expect(Number.isFinite(f)).toBe(true);
      expect(Number.isNaN(f)).toBe(false);
    }
  });

  // ---------------------------------------------------------------------
  // No floor: exponential decay approaches, and is allowed to reach, zero.
  // Considered and rejected: an artificial floor (e.g. clamp to some small
  // epsilon) only moves the point at which every sufficiently-old item ties
  // -- it doesn't remove ties among ancient items, it just relabels them.
  // For signal_score specifically, a floor would actively fight the design
  // intent: sharp/hours-scale decay exists precisely so ancient material
  // reads as irrelevant *now*, and a floor that keeps it "a little bit
  // relevant forever" undermines that. For read_score the half-life is
  // weeks-to-months, so underflow to literal 0.0 would take centuries of
  // item age -- not a practical concern. Sort stability among items that
  // both land at exactly 0.0 is delegated to whatever secondary sort key
  // the read query already uses (e.g. published_at); that's not this
  // module's job to invent.
  // ---------------------------------------------------------------------
  it('has no floor: a very old item decays to a small but strictly positive, finite factor', () => {
    const publishedAt = hoursBefore(NOW, 50 * 6); // 50 half-lives at a 6h half-life
    const factor = decayFactor({ publishedAt, fetchedAt: publishedAt }, NOW, 6);
    expect(factor).toBeGreaterThan(0);
    expect(factor).toBeLessThan(1e-14);
    expect(Number.isFinite(factor)).toBe(true);
  });

  it('has no floor: an astronomically old item is allowed to underflow to exactly 0, not throw or go negative', () => {
    // 56 years at a 6h half-life is ~81,800 half-lives -- vastly past IEEE-754
    // double underflow (~1075 half-lives), so this must land on literal 0.
    const factor = decayFactor({ publishedAt: '1970-01-01T00:00:00.000Z', fetchedAt: '1970-01-01T00:00:00.000Z' }, NOW, 6);
    expect(factor).toBe(0);
    expect(Number.isNaN(factor)).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Future-dated clamp. Real, not hypothetical: the AP news-sitemap adapter
  // produced published_at values slightly ahead of fetchedAt during M1.
  // Decision: clamp age at >= 0, which caps the factor at exactly 1.0 --
  // a future-dated item is treated as "as fresh as possible right now",
  // never boosted past that ceiling. The alternative (letting factor exceed
  // 1.0) would let bad clock data outrank a genuinely on-time fresh item,
  // rewarding the data-quality defect instead of merely tolerating it.
  // ---------------------------------------------------------------------
  describe('future-dated clamp', () => {
    it('a publishedAt a few minutes ahead of now clamps to exactly 1, never exceeds it', () => {
      const publishedAt = new Date(Date.parse(NOW) + 5 * 60_000).toISOString();
      expect(decayFactor({ publishedAt, fetchedAt: publishedAt }, NOW, 6)).toBe(1);
    });

    it('a publishedAt days ahead of now also clamps to exactly 1 -- not scaled by how far ahead it is', () => {
      const publishedAt = new Date(Date.parse(NOW) + 5 * 86_400_000).toISOString();
      expect(decayFactor({ publishedAt, fetchedAt: publishedAt }, NOW, 6)).toBe(1);
    });

    it('real AP-shaped case: sitemap publishedAt slightly ahead of the ingest fetchedAt/now pair', () => {
      const fetchedAt = '2026-08-14T03:47:10.404Z';
      const publishedAt = '2026-08-14T03:52:00.000Z'; // ~5 min ahead, as observed in M1
      expect(decayFactor({ publishedAt, fetchedAt }, fetchedAt, 6)).toBe(1);
    });
  });

  describe('validation -- defends against malformed inputs rather than silently miscomputing', () => {
    it('rejects a non-canonical now (reuses the one canonical-timestamp validator, not a private copy)', () => {
      expect(() => decayFactor({ publishedAt: null, fetchedAt: NOW }, '2026-08-14', 6)).toThrow(
        InvalidTimestampError,
      );
    });

    it('rejects a non-canonical fetchedAt', () => {
      expect(() => decayFactor({ publishedAt: null, fetchedAt: '2026-08-14' }, NOW, 6)).toThrow(
        InvalidTimestampError,
      );
    });

    it('rejects a non-canonical publishedAt', () => {
      expect(() => decayFactor({ publishedAt: '2026-08-14', fetchedAt: NOW }, NOW, 6)).toThrow(
        InvalidTimestampError,
      );
    });

    it.each([0, -1, -0.001])('rejects a non-positive halfLifeHours (%s)', (halfLife) => {
      expect(() => decayFactor({ publishedAt: null, fetchedAt: NOW }, NOW, halfLife)).toThrow(RangeError);
    });

    it.each([Number.POSITIVE_INFINITY, Number.NaN])('rejects a non-finite halfLifeHours (%s)', (halfLife) => {
      expect(() => decayFactor({ publishedAt: null, fetchedAt: NOW }, NOW, halfLife)).toThrow(RangeError);
    });
  });
});

// ---------------------------------------------------------------------------
// resolveHalfLifeHours -- per item_type for markets, per beat elsewhere
// ---------------------------------------------------------------------------
describe('resolveHalfLifeHours', () => {
  const config = testConfig();

  it('for a non-markets beat, resolves from config.beats and ignores itemType entirely', () => {
    const viaEvent = resolveHalfLifeHours('cyber', 'event', 'signal', config);
    const viaAnalysis = resolveHalfLifeHours('cyber', 'analysis', 'signal', config);
    const viaPress = resolveHalfLifeHours('cyber', 'press', 'signal', config);
    expect(viaEvent).toBe(config.beats.cyber.signal_half_life_hours);
    expect(viaEvent).toBe(viaAnalysis);
    expect(viaEvent).toBe(viaPress);
  });

  it('for the markets beat, resolves from config.markets_item_types keyed on itemType', () => {
    expect(resolveHalfLifeHours('markets', 'event', 'signal', config)).toBe(
      config.markets_item_types.event.signal_half_life_hours,
    );
    expect(resolveHalfLifeHours('markets', 'analysis', 'signal', config)).toBe(
      config.markets_item_types.analysis.signal_half_life_hours,
    );
    expect(resolveHalfLifeHours('markets', 'press', 'signal', config)).toBe(
      config.markets_item_types.press.signal_half_life_hours,
    );
  });

  it('markets itemType genuinely changes the resolved half-life (unlike non-markets beats)', () => {
    const event = resolveHalfLifeHours('markets', 'event', 'signal', config);
    const analysis = resolveHalfLifeHours('markets', 'analysis', 'signal', config);
    expect(event).not.toBe(analysis);
  });

  it('selects signal vs read half-life per the profile argument', () => {
    expect(resolveHalfLifeHours('ai', 'event', 'signal', config)).toBe(config.beats.ai.signal_half_life_hours);
    expect(resolveHalfLifeHours('ai', 'event', 'read', config)).toBe(config.beats.ai.read_half_life_hours);
  });

  it('throws a named error for a beat with no config entry rather than returning undefined/NaN', () => {
    expect(() => resolveHalfLifeHours('bogus' as unknown as DecayInput['beat'], 'event', 'signal', config)).toThrow(
      UnknownDecayKeyError,
    );
  });

  it('throws a named error for a markets itemType with no config entry', () => {
    const badConfig = { ...config, markets_item_types: { ...config.markets_item_types } } as DecayConfig;
    // @ts-expect-error -- deliberately simulating data that bypassed the type system
    delete badConfig.markets_item_types.press;
    expect(() => resolveHalfLifeHours('markets', 'press', 'signal', badConfig)).toThrow(UnknownDecayKeyError);
  });
});

// ---------------------------------------------------------------------------
// computeDecayFactor -- the composed, per-item-per-profile entry point
// ---------------------------------------------------------------------------
describe('computeDecayFactor', () => {
  const config = testConfig();

  it('composes resolveHalfLifeHours + decayFactor identically to calling them by hand, for a non-markets beat', () => {
    const input: DecayInput = {
      beat: 'cyber',
      itemType: 'event',
      publishedAt: hoursBefore(NOW, 12),
      fetchedAt: hoursBefore(NOW, 12),
    };
    const expected = decayFactor(input, NOW, resolveHalfLifeHours('cyber', 'event', 'signal', config));
    expect(computeDecayFactor(input, 'signal', NOW, config)).toBe(expected);
  });

  it('composes correctly for markets, routing on itemType rather than beat', () => {
    const input: DecayInput = {
      beat: 'markets',
      itemType: 'analysis',
      publishedAt: hoursBefore(NOW, 100),
      fetchedAt: hoursBefore(NOW, 100),
    };
    const expected = decayFactor(input, NOW, resolveHalfLifeHours('markets', 'analysis', 'read', config));
    expect(computeDecayFactor(input, 'read', NOW, config)).toBe(expected);
  });

  it('end-to-end with the real cisa-kev null-published_at shape', () => {
    // Real values copied from attic/wf-m1-firstrun-2026-08-14.db: cisa-kev
    // items carry item_type 'event', beat 'cyber', published_at NULL.
    const input: DecayInput = {
      beat: 'cyber',
      itemType: 'event',
      publishedAt: null,
      fetchedAt: '2026-08-14T03:47:10.404Z',
    };
    const now = '2026-08-14T03:47:10.404Z'; // read happening moments after ingest
    expect(computeDecayFactor(input, 'signal', now, config)).toBeCloseTo(1, 9);
  });
});

// ---------------------------------------------------------------------------
// Two profiles, never blended -- distinguishable by test, not just by shape.
// A test that only checks "signal decreases with age" and, separately,
// "read decreases with age" would still pass if the two half-lives were
// swapped in config: both are still valid decreasing exponentials on their
// own. These tests instead compute BOTH profiles for the SAME input and pin
// the relationship (and, for the first case, the actual magnitudes) between
// them, so a swap is guaranteed to flip the assertion.
// ---------------------------------------------------------------------------
describe('signal_score and read_score are distinguishable, not just independently plausible', () => {
  const config = testConfig();

  it('cyber at 2 weeks old: signal has collapsed to near-nothing while read is still at its own half-life point (56x half-life ratio)', () => {
    const age = 336; // 2 weeks, in hours
    const input: DecayInput = {
      beat: 'cyber',
      itemType: 'event',
      publishedAt: hoursBefore(NOW, age),
      fetchedAt: hoursBefore(NOW, age),
    };
    const signal = computeDecayFactor(input, 'signal', NOW, config);
    const read = computeDecayFactor(input, 'read', NOW, config);

    // cyber signal half-life is 6h; 336h / 6h = 56 half-lives -> negligible.
    expect(signal).toBeGreaterThan(0);
    expect(signal).toBeLessThan(1e-15);
    // cyber read half-life is exactly 336h -> this age IS one full half-life.
    expect(read).toBeCloseTo(0.5, 9);

    // The actual ratio, pinned: if the two half-lives were swapped in
    // config, signal would become 0.5 and read would become ~1.39e-17,
    // making this ratio flip to ~1e-17 and fail this assertion.
    expect(read / signal).toBeGreaterThan(1e15);
  });

  it('markets:analysis at the signal half-life point: read has barely moved while signal is already at 0.5 (swap-sensitive)', () => {
    const age = 240; // markets:analysis signal half-life, in hours
    const input: DecayInput = {
      beat: 'markets',
      itemType: 'analysis',
      publishedAt: hoursBefore(NOW, age),
      fetchedAt: hoursBefore(NOW, age),
    };
    const signal = computeDecayFactor(input, 'signal', NOW, config);
    const read = computeDecayFactor(input, 'read', NOW, config);

    expect(signal).toBeCloseTo(0.5, 9);
    // read half-life is 720h, so at 240h old the factor is 0.5^(1/3).
    expect(read).toBeCloseTo(0.7937005259840998, 9);
    // Swap-sensitive: if the half-lives were exchanged, read would drop to
    // 0.5 and signal would rise to ~0.794, inverting this comparison.
    expect(read).toBeGreaterThan(signal);
  });

  // §5.1's own framing: "a long-form piece must not fall off a cliff at two
  // weeks". Operationalized directly: at the 2-week mark, markets:analysis
  // read_score must retain MORE than half its original value -- a smooth
  // exponential glide, not a cliff.
  it('markets:analysis read_score retains more than half its value at the two-week mark (no cliff)', () => {
    const input: DecayInput = {
      beat: 'markets',
      itemType: 'analysis',
      publishedAt: hoursBefore(NOW, 336),
      fetchedAt: hoursBefore(NOW, 336),
    };
    expect(computeDecayFactor(input, 'read', NOW, config)).toBeGreaterThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// parseDecayConfig / loadDecayConfig -- config loading and validation
// ---------------------------------------------------------------------------
describe('parseDecayConfig', () => {
  const VALID = `
beats:
  ai:      { signal_half_life_hours: 48, read_half_life_hours: 504 }
  cyber:   { signal_half_life_hours: 6,  read_half_life_hours: 336 }
  aisec:   { signal_half_life_hours: 8,  read_half_life_hours: 336 }
  repos:   { signal_half_life_hours: 72, read_half_life_hours: 336 }
  usnews:  { signal_half_life_hours: 24, read_half_life_hours: 168 }
markets_item_types:
  event:    { signal_half_life_hours: 4,   read_half_life_hours: 168 }
  analysis: { signal_half_life_hours: 240, read_half_life_hours: 720 }
  press:    { signal_half_life_hours: 6,   read_half_life_hours: 168 }
`;

  it('parses a valid config', () => {
    const config = parseDecayConfig(VALID);
    expect(config.beats.cyber.signal_half_life_hours).toBe(6);
    expect(config.markets_item_types.analysis.read_half_life_hours).toBe(720);
  });

  it('rejects malformed YAML', () => {
    expect(() => parseDecayConfig('beats: [this is not: valid: yaml')).toThrow(DecayConfigError);
  });

  it('rejects a config missing a required beat', () => {
    // Line-filter rather than a regex replace: a regex anchored only on
    // "usnews:.*\n" doesn't consume its own leading indent, which (verified
    // by hand) left a stray two-space-indented "markets_item_types:" nested
    // under beats -- the test still failed for a real reason (beats.usnews:
    // Required was among the issues) but conflated with two accidental
    // extra violations, so it wasn't isolating one variable. Filtering out
    // the whole usnews line by content leaves every other line, and its
    // indentation, untouched.
    const missingUsnews = VALID.split('\n')
      .filter((line) => !line.trim().startsWith('usnews:'))
      .join('\n');
    expect(() => parseDecayConfig(missingUsnews)).toThrow(DecayConfigError);
  });

  it('rejects markets appearing under beats -- markets is keyed by item_type, not beat', () => {
    const withMarkets = VALID.replace(
      'beats:\n',
      'beats:\n  markets: { signal_half_life_hours: 4, read_half_life_hours: 168 }\n',
    );
    expect(() => parseDecayConfig(withMarkets)).toThrow(DecayConfigError);
  });

  it('rejects a config missing a required markets item_type', () => {
    const missingPress = VALID.split('\n')
      .filter((line) => !line.trim().startsWith('press:'))
      .join('\n');
    expect(() => parseDecayConfig(missingPress)).toThrow(DecayConfigError);
  });

  it.each([0, -1])('rejects a zero or negative half-life (%s)', (badValue) => {
    const bad = VALID.replace('signal_half_life_hours: 6,', `signal_half_life_hours: ${badValue},`);
    expect(() => parseDecayConfig(bad)).toThrow(DecayConfigError);
  });

  it('rejects an unrecognized top-level key', () => {
    expect(() => parseDecayConfig(VALID + '\nextra_stuff: true\n')).toThrow(DecayConfigError);
  });
});

describe('loadDecayConfig against the real, checked-in config/decay.yaml', () => {
  it('the shipped config file validates against its own schema', () => {
    const path = join(process.cwd(), 'config', 'decay.yaml');
    const config = loadDecayConfig(path);
    expect(Object.keys(config.beats).sort()).toEqual(['ai', 'aisec', 'cyber', 'repos', 'usnews']);
    expect(Object.keys(config.markets_item_types).sort()).toEqual(['analysis', 'event', 'press']);
  });

  it('matches what a direct readFileSync + parseDecayConfig produces (loadDecayConfig does no extra transformation)', () => {
    const path = join(process.cwd(), 'config', 'decay.yaml');
    expect(loadDecayConfig(path)).toEqual(parseDecayConfig(readFileSync(path, 'utf8')));
  });

  it('every configured half-life is a positive, finite number of hours', () => {
    const config = loadDecayConfig(join(process.cwd(), 'config', 'decay.yaml'));
    const allPairs = [...Object.values(config.beats), ...Object.values(config.markets_item_types)];
    for (const pair of allPairs) {
      expect(pair.signal_half_life_hours).toBeGreaterThan(0);
      expect(pair.read_half_life_hours).toBeGreaterThan(0);
    }
  });

  // §5.1: signal_score is the sharp/hours profile, read_score is the slow/
  // weeks profile, for every single configured beat and markets item_type --
  // never the other way around, anywhere in the shipped config.
  it('read half-life exceeds signal half-life everywhere in the shipped config (the two profiles are never blended)', () => {
    const config = loadDecayConfig(join(process.cwd(), 'config', 'decay.yaml'));
    const allPairs = [...Object.values(config.beats), ...Object.values(config.markets_item_types)];
    for (const pair of allPairs) {
      expect(pair.read_half_life_hours).toBeGreaterThan(pair.signal_half_life_hours);
    }
  });
});

// ---------------------------------------------------------------------------
// Cheap enough for per-item use in a list query over hundreds of items.
// ---------------------------------------------------------------------------
describe('performance', () => {
  it('computes both profiles for 1000 synthetic items well within a generous budget', () => {
    const config = testConfig();
    const beats: DecayInput['beat'][] = ['ai', 'cyber', 'aisec', 'repos', 'markets', 'usnews'];
    const itemTypes: DecayInput['itemType'][] = ['event', 'analysis', 'press'];

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      const input: DecayInput = {
        beat: beats[i % beats.length]!,
        itemType: itemTypes[i % itemTypes.length]!,
        publishedAt: i % 7 === 0 ? null : hoursBefore(NOW, i),
        fetchedAt: hoursBefore(NOW, i + 1),
      };
      computeDecayFactor(input, 'signal', NOW, config);
      computeDecayFactor(input, 'read', NOW, config);
    }
    const elapsedMs = performance.now() - start;

    // 2000 calls; a generous ceiling well above any plausible regression
    // (real cost is a couple of Date.parse calls and a Math.pow per call).
    expect(elapsedMs).toBeLessThan(200);
  });
});
