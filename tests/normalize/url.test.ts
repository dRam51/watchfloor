import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalizeUrl, InvalidUrlError } from '../../src/normalize/url.ts';

interface GoldenCase {
  note: string;
  input: string;
  expected: string;
}

// Checked-in golden file, not inlined: a future change to the rules shows up
// as a reviewable diff on this one file instead of scattered test edits.
const golden: GoldenCase[] = JSON.parse(
  readFileSync(
    join(process.cwd(), 'tests', 'fixtures', 'normalize', 'url-canonicalization.json'),
    'utf8',
  ),
);

describe('canonicalizeUrl', () => {
  describe('golden fixtures', () => {
    for (const { note, input, expected } of golden) {
      it(note, () => {
        expect(canonicalizeUrl(input)).toBe(expected);
      });
    }
  });

  // item_key = sha256(canonicalUrl) and `items` is append-only (trigger
  // enforced, no UPDATE/DELETE). If this function ever changes its output for
  // a URL it has already produced, that article's version history silently
  // splits into two unrelated chains with no way to repair it. This property
  // is therefore checked across the whole fixture set, not as a single case.
  describe('idempotence: canonicalize(canonicalize(x)) === canonicalize(x)', () => {
    for (const { note, input } of golden) {
      it(`holds for: ${note}`, () => {
        const once = canonicalizeUrl(input);
        const twice = canonicalizeUrl(once);
        expect(twice).toBe(once);
      });
    }
  });

  describe('malformed input', () => {
    it('throws InvalidUrlError for a string with no scheme', () => {
      expect(() => canonicalizeUrl('not a url')).toThrow(InvalidUrlError);
    });

    it('throws InvalidUrlError for an empty string', () => {
      expect(() => canonicalizeUrl('')).toThrow(InvalidUrlError);
    });

    it('throws InvalidUrlError for a protocol-relative URL (no absolute scheme)', () => {
      expect(() => canonicalizeUrl('//example.com/foo')).toThrow(InvalidUrlError);
    });

    it('throws InvalidUrlError for a bare relative path', () => {
      expect(() => canonicalizeUrl('/some/path')).toThrow(InvalidUrlError);
    });

    it('throws InvalidUrlError for a non-http(s) scheme (mailto)', () => {
      expect(() => canonicalizeUrl('mailto:test@example.com')).toThrow(InvalidUrlError);
    });

    it('throws InvalidUrlError for a non-http(s) scheme (ftp)', () => {
      expect(() => canonicalizeUrl('ftp://example.com/file')).toThrow(InvalidUrlError);
    });
  });
});
