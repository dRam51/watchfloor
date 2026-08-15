import { describe, expect, it } from 'vitest';
import { entityFileName, entityNoteRelPath, EntityNameError } from '../../src/vault/entities.ts';

/**
 * An entity name becomes a FILENAME. That is the whole hazard of this task.
 *
 * `src/vault/paths.ts` refuses `..`, dot-prefixed segments, backslashes and
 * anything outside the four areas — but every one of those refusals happens
 * *after* somebody has built a path string. If the entity `../../Architecture`
 * were turned into `entities/../../Architecture.md`, the path layer catches it;
 * if it were *sanitised* into `entities/Architecture.md`, the path layer sees a
 * perfectly ordinary request and the sync writes a managed block into a note
 * whose name matches one of the owner's twelve hand-authored files.
 *
 * So this module refuses rather than sanitises, and these tests are written
 * against the refusal.
 */

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof EntityNameError) return err.reason;
    return `threw ${(err as Error).name}: ${(err as Error).message}`;
  }
  return 'did not throw';
}

const NUL = String.fromCharCode(0);
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const DEL = String.fromCharCode(127);

describe('entityFileName — names that are safe', () => {
  it.each([
    ['Anthropic', 'Anthropic.md'],
    ['OpenAI', 'OpenAI.md'],
    ['CVE-2014-4148', 'CVE-2014-4148.md'],
    ['Model Context Protocol', 'Model Context Protocol.md'],
    ['GPT-4.1', 'GPT-4.1.md'],
    ['S&P 500', 'S&P 500.md'],
    ["Moody's", "Moody's.md"],
  ])('accepts %o', (entity, expected) => {
    expect(entityFileName(entity)).toBe(expected);
  });

  it('emits the composed (NFC) spelling, so one entity is one filename', () => {
    // macOS compares filenames normalisation-insensitively and Linux does not.
    // Emitting a single normal form means the two hosts agree about which file
    // an entity maps to. Same reasoning as `isContainedIn`'s NFC comparison in
    // src/vault/paths.ts, applied to the name we CREATE rather than compare.
    const decomposed = `Cafe${String.fromCharCode(0x301)}`;
    const composed = 'Café';
    expect(decomposed.normalize('NFC')).toBe(composed);
    expect(entityFileName(decomposed)).toBe(`${composed}.md`);
    expect(entityFileName(composed)).toBe(`${composed}.md`);
  });

  it('puts every note in the entities area and nowhere else', () => {
    expect(entityNoteRelPath('Anthropic')).toBe('entities/Anthropic.md');
  });
});

describe('entityFileName — the hostile names', () => {
  it.each([
    // The task brief's own example. Refused, never resolved to `Architecture`.
    ['../../Architecture', 'separator'],
    ['..', 'dot_leading'],
    ['.', 'dot_leading'],
    ['daily/2026-08-15', 'separator'],
    ['a/b', 'separator'],
    ['..\\..\\Architecture', 'separator'],
    ['.obsidian', 'dot_leading'],
    ['.hidden', 'dot_leading'],
    ['', 'empty'],
    ['   ', 'empty'],
    [' Anthropic', 'whitespace_edge'],
    ['Anthropic ', 'whitespace_edge'],
    // macOS's Finder swaps `:` and `/`; Windows forbids the whole set below.
    ['01 Tech Projects: Watchfloor', 'reserved_char'],
    ['AC/DC', 'separator'],
    ['C*A', 'reserved_char'],
    ['Who?', 'reserved_char'],
    ['<script>', 'reserved_char'],
    ['say "hi"', 'reserved_char'],
    // Obsidian's own wikilink syntax. A related-entity link is rendered as
    // [[Name]], and every one of these breaks that link or aliases it.
    ['NVDA|AAPL', 'reserved_char'],
    ['#StopRansomware', 'reserved_char'],
    ['Block^ref', 'reserved_char'],
    ['[AINews]', 'reserved_char'],
    // Windows device names. Obsidian runs on Windows and this vault syncs.
    ['NUL', 'device_name'],
    ['con', 'device_name'],
    ['COM1', 'device_name'],
    ['LPT9', 'device_name'],
  ])('refuses %o with reason %s', (entity, reason) => {
    expect(reasonOf(() => entityFileName(entity))).toBe(reason);
  });

  it.each([
    ['NUL byte', NUL],
    ['tab', TAB],
    ['carriage return', CR],
    ['DEL', DEL],
  ])('refuses a name containing a %s', (_label, char) => {
    expect(reasonOf(() => entityFileName(`Anthro${char}pic`))).toBe('control_char');
  });

  it('refuses a trailing newline as edge whitespace, before it reaches the filesystem', () => {
    expect(reasonOf(() => entityFileName(`Anthropic${LF}`))).toBe('whitespace_edge');
  });

  it('refuses a name too long for the ATOMIC WRITE, not merely for the filesystem', () => {
    // Measured on this machine, in a real temp directory: a 243-byte name
    // writes fine, but `src/vault/session.ts` writes through a temp file named
    // `.watchfloor-tmp-<name>.<pid>.<n>` — 24+ bytes more — and that fails with
    // ENAMETOOLONG at 267. A cap of 255 would therefore refuse nothing and
    // still crash mid-sync. Everything must fit with the prefix on.
    expect(reasonOf(() => entityFileName('a'.repeat(198)))).toBe('too_long');
    expect(entityFileName('a'.repeat(190))).toBe(`${'a'.repeat(190)}.md`);
  });

  it('measures length in BYTES, not code units', () => {
    // NAME_MAX is 255 bytes. 190 CJK characters are 570 bytes and would pass a
    // `.length` check while failing at `open`.
    expect(reasonOf(() => entityFileName('漢'.repeat(190)))).toBe('too_long');
  });
});
