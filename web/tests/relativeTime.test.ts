import { describe, expect, it } from 'vitest';
import { relativeTime } from '../src/lib/relativeTime.ts';

const NOW = new Date('2026-08-14T18:00:00.000Z');

function minutesAgo(n: number): string {
  return new Date(NOW.getTime() - n * 60_000).toISOString();
}

describe('relativeTime', () => {
  it('renders "undated" for a null publishedAt -- distinct from any real elapsed time', () => {
    expect(relativeTime(null, NOW)).toBe('undated');
  });

  it('renders "undated" for an unparseable string rather than "NaN ago"', () => {
    expect(relativeTime('not-a-timestamp', NOW)).toBe('undated');
  });

  it('renders "just now" for anything under a minute old', () => {
    expect(relativeTime(minutesAgo(0), NOW)).toBe('just now');
    expect(relativeTime(new Date(NOW.getTime() - 30_000).toISOString(), NOW)).toBe('just now');
  });

  it('renders "just now" for a future timestamp (clock skew) rather than a negative value', () => {
    expect(relativeTime(new Date(NOW.getTime() + 60_000).toISOString(), NOW)).toBe('just now');
  });

  it('renders minutes for under an hour', () => {
    expect(relativeTime(minutesAgo(5), NOW)).toBe('5m ago');
    expect(relativeTime(minutesAgo(59), NOW)).toBe('59m ago');
  });

  it('renders hours for under a day', () => {
    expect(relativeTime(minutesAgo(60), NOW)).toBe('1h ago');
    expect(relativeTime(minutesAgo(60 * 5), NOW)).toBe('5h ago');
  });

  it('renders days for under a month', () => {
    expect(relativeTime(minutesAgo(60 * 24 * 2), NOW)).toBe('2d ago');
  });

  it('renders months for under a year', () => {
    expect(relativeTime(minutesAgo(60 * 24 * 60), NOW)).toBe('2mo ago');
  });

  it('renders years beyond that', () => {
    expect(relativeTime(minutesAgo(60 * 24 * 365 * 2), NOW)).toBe('2y ago');
  });

  it('defaults to the real wall clock when no `now` is given (a live item is recent, not "undated")', () => {
    const almostNow = new Date(Date.now() - 5000).toISOString();
    expect(relativeTime(almostNow)).toBe('just now');
  });
});
