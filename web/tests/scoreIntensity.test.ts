import { describe, expect, it } from 'vitest';
import { scoreIntensity, SCORE_INTENSITY_CEILING } from '../src/lib/scoreIntensity.ts';

describe('scoreIntensity', () => {
  it('returns 0 for a score of exactly 0 (the pinned-at-zero case is handled separately by ItemRow, not here)', () => {
    expect(scoreIntensity(0)).toBe(0);
  });

  it('returns 0 for a negative score rather than a negative fill fraction', () => {
    expect(scoreIntensity(-1)).toBe(0);
  });

  it('scales linearly up to the ceiling', () => {
    expect(scoreIntensity(SCORE_INTENSITY_CEILING / 2)).toBeCloseTo(0.5, 10);
    expect(scoreIntensity(SCORE_INTENSITY_CEILING)).toBe(1);
  });

  it('clamps at 1 for anything above the empirical ceiling, rather than overflowing the bar', () => {
    expect(scoreIntensity(SCORE_INTENSITY_CEILING * 10)).toBe(1);
  });

  it('never throws or returns NaN for degenerate input (NaN, Infinity)', () => {
    expect(scoreIntensity(NaN)).toBe(0);
    expect(scoreIntensity(Infinity)).toBe(1);
    expect(scoreIntensity(-Infinity)).toBe(0);
  });

  it('reflects real observed corpus maxima at close to full intensity (verified live 2026-08-14: cyber/read topped 4.9239)', () => {
    expect(scoreIntensity(4.9239)).toBeGreaterThan(0.9);
    expect(scoreIntensity(4.9239)).toBeLessThanOrEqual(1);
  });
});
