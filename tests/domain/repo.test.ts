import { describe, it, expect } from 'vitest';
import { MAX_EXCERPT_LENGTH, toExcerpt } from '../../src/domain/repo.ts';

// ---------------------------------------------------------------------------
// The ~300-character excerpt cap (standing rule: this project stores links and
// short excerpts, never full text). A README is the first field in this project
// whose SOURCE is routinely tens of kilobytes, so the cap is not a formality
// here -- it is the only thing standing between `items.summary_raw` and a
// mirrored copy of someone else's documentation.
// ---------------------------------------------------------------------------

describe('toExcerpt', () => {
  it('returns null for null, so an absent excerpt has exactly one representation', () => {
    expect(toExcerpt(null)).toBeNull();
  });

  it('returns null for whitespace-only text -- a blank excerpt is an absent one', () => {
    expect(toExcerpt('   \n\n\t  ')).toBeNull();
  });

  it('leaves text at exactly the cap unchanged', () => {
    const exact = 'a'.repeat(MAX_EXCERPT_LENGTH);
    expect(toExcerpt(exact)).toBe(exact);
    expect(toExcerpt(exact)!.length).toBe(300);
  });

  it('truncates one character past the cap, at a word boundary, never mid-word', () => {
    // 299 'a's, a space, then a word that starts at index 300 -- so the naive
    // slice would cut the final word in half.
    const raw = `${'a'.repeat(299)} boundary`;
    const excerpt = toExcerpt(raw)!;
    expect(excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_LENGTH);
    expect(excerpt).toBe('a'.repeat(299));
  });

  it('hard-cuts a single pathologically long token rather than returning nothing', () => {
    const excerpt = toExcerpt('x'.repeat(5000))!;
    expect(excerpt.length).toBe(MAX_EXCERPT_LENGTH);
  });

  it('never leaves an orphaned UTF-16 high surrogate at the cut', () => {
    // A rocket emoji (U+1F680) is a surrogate PAIR: cutting at 300 code units
    // lands between its two halves. Node's UTF-8 encoder silently replaces a
    // lone high surrogate with U+FFFD, and SQLite TEXT storage goes through
    // exactly that encoding -- so an orphan here is real stored corruption,
    // not a cosmetic glitch (same hazard as src/normalize/item.ts's summary
    // truncation).
    const excerpt = toExcerpt(`${'x'.repeat(299)}\u{1F680}tail`)!;
    const lastCode = excerpt.charCodeAt(excerpt.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
    expect(excerpt).toBe('x'.repeat(299));
  });

  it('collapses newlines and runs of whitespace into single spaces before capping', () => {
    // A README paragraph arrives hard-wrapped. Stored as one line, the way
    // every other excerpt in this project is -- and the cap must be measured
    // AFTER collapsing, not before, or a hard-wrapped paragraph is capped on a
    // length that includes the wrapping.
    expect(toExcerpt('one\ntwo   three\n\tfour')).toBe('one two three four');
  });

  it('caps the collapsed length, not the raw length', () => {
    // 300 words of 'a' separated by DOUBLE spaces: 300 chars of content plus
    // 598 chars of whitespace raw, but exactly 599 collapsed... so build it
    // precisely: 150 'ab' tokens double-spaced collapses to 449 chars.
    const raw = Array.from({ length: 150 }, () => 'ab').join('  ');
    expect(raw.length).toBe(150 * 2 + 149 * 2);
    const excerpt = toExcerpt(raw)!;
    expect(excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_LENGTH);
    expect(excerpt.startsWith('ab ab ab')).toBe(true);
  });
});
