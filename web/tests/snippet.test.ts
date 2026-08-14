import { describe, expect, it } from 'vitest';
import { parseSnippet } from '../src/lib/snippet.ts';

describe('parseSnippet', () => {
  it('splits a snippet with a single bracketed match into three segments', () => {
    expect(parseSnippet('the [quick] fox')).toEqual([
      { text: 'the ', matched: false },
      { text: 'quick', matched: true },
      { text: ' fox', matched: false },
    ]);
  });

  it('handles the match at the very start, with no leading plain segment', () => {
    expect(parseSnippet('[quick] fox')).toEqual([
      { text: 'quick', matched: true },
      { text: ' fox', matched: false },
    ]);
  });

  it('handles the match at the very end, with no trailing plain segment', () => {
    expect(parseSnippet('the [quick]')).toEqual([
      { text: 'the ', matched: false },
      { text: 'quick', matched: true },
    ]);
  });

  it('handles a snippet that is only the match', () => {
    expect(parseSnippet('[quick]')).toEqual([{ text: 'quick', matched: true }]);
  });

  it('handles multiple matches in one snippet -- the real, verified case (?q=AI)', () => {
    expect(parseSnippet('Import [AI] 457: [AI] stuxnet')).toEqual([
      { text: 'Import ', matched: false },
      { text: 'AI', matched: true },
      { text: ' 457: ', matched: false },
      { text: 'AI', matched: true },
      { text: ' stuxnet', matched: false },
    ]);
  });

  it('returns the whole string unmatched when there is no bracket at all', () => {
    expect(parseSnippet('nothing matched here')).toEqual([{ text: 'nothing matched here', matched: false }]);
  });

  it('returns an empty array for an empty snippet', () => {
    expect(parseSnippet('')).toEqual([]);
  });

  it('does not lose content after an unterminated "[" -- defensive, not documented to happen', () => {
    expect(parseSnippet('before [unterminated tail')).toEqual([
      { text: 'before ', matched: false },
      { text: '[unterminated tail', matched: false },
    ]);
  });

  it('handles back-to-back matches with no plain text between them', () => {
    expect(parseSnippet('[foo][bar]')).toEqual([
      { text: 'foo', matched: true },
      { text: 'bar', matched: true },
    ]);
  });

  it('handles an empty match (adjacent brackets)', () => {
    expect(parseSnippet('a[]b')).toEqual([
      { text: 'a', matched: false },
      { text: '', matched: true },
      { text: 'b', matched: false },
    ]);
  });
});
