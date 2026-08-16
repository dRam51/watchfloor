import { describe, expect, it } from 'vitest';
import {
  applyManagedBlock,
  hasManagedBlock,
  isWatchfloorManaged,
  readWatchfloorFrontmatter,
  renderManagedNote,
  splitManagedBlock,
  VaultContentError,
  WATCHFLOOR_BEGIN_MARKER,
  WATCHFLOOR_END_MARKER,
} from '../../src/vault/frontmatter.ts';

/**
 * §8.1: **"Never modify a file lacking Watchfloor frontmatter."**
 *
 * This is the rule that saves the owner's twelve hand-authored notes. They are
 * prose written by hand and none of them carries any frontmatter at all, so the
 * gate's job is to answer "no" for every one of them and for anything else a
 * human might plausibly write — including a hand-written note ABOUT Watchfloor,
 * which is what several of these are.
 */

// Openings taken from the shape of the real notes: an H1, prose, no
// frontmatter. The filenames are the real ones.
const HAND_AUTHORED_OPENINGS = [
  ['Architecture.md', '# Architecture\n\nSix beats, one SQLite file, append-only items.\n'],
  ['Open Questions.md', '# Open Questions\n\n- Does `item_type` need the M4b rework?\n'],
  ['Settled Decisions.md', '# Settled Decisions\n\nNode 26. Branchless on `main`.\n'],
  ['Standing Rules.md', '# Standing Rules\n\nNever delete anything. Zero-dollar by default.\n'],
  ['Portability Debt.md', '# Portability Debt\n\nThe vault is on iCloud Drive.\n'],
  ['Source Inventory.md', '# Source Inventory\n\n28 sources, all robots-verified.\n'],
  ['Plan Corrections.md', '# Plan Corrections\n\nThe M1 plan was corrected five times.\n'],
  ['Watchfloor.md', '# Watchfloor\n\nSingle-user situational-awareness dashboard.\n'],
  ['Milestone 0 — Scaffold.md', '# Milestone 0 — Scaffold\n\nDone.\n'],
  ['Milestone 1 — Ingest.md', '# Milestone 1 — Ingest\n\nRecovered after five corrections.\n'],
  ['Milestone 2 — Scoring.md', '# Milestone 2 — Scoring\n\nClustering chained 1,543 CVEs.\n'],
  ['Milestone 3 — API and Dashboard.md', '# Milestone 3 — API and Dashboard\n\n12 tasks.\n'],
] as const;

describe('isWatchfloorManaged — the gate that saves the hand-authored notes', () => {
  it.each(HAND_AUTHORED_OPENINGS)('answers no for the hand-authored %s', (_name, content) => {
    expect(isWatchfloorManaged(content)).toBe(false);
  });

  it('answers yes for a note this package rendered', () => {
    const note = renderManagedNote({
      tier: 'fully-managed',
      generatedAt: '2026-08-15T07:00:00.000Z',
      body: '# 2026-08-15\n',
    });
    expect(isWatchfloorManaged(note)).toBe(true);
  });

  it('answers no for an empty file', () => {
    expect(isWatchfloorManaged('')).toBe(false);
  });

  it('answers no for a file with frontmatter that is not ours', () => {
    expect(isWatchfloorManaged('---\ntags: [watchfloor]\n---\n\n# Notes\n')).toBe(false);
  });

  // The most plausible near-miss: a hand-written note about this project that
  // the owner tagged. `watchfloor` appearing as a VALUE is not ownership.
  it('answers no when watchfloor appears as a value rather than as the key', () => {
    expect(isWatchfloorManaged('---\nproject: watchfloor\nstatus: managed\n---\n\n# Notes\n')).toBe(
      false,
    );
  });

  it('answers no when the key is present but the value is not exactly `managed`', () => {
    expect(isWatchfloorManaged('---\nwatchfloor: true\nwatchfloor_tier: fully-managed\n---\n')).toBe(
      false,
    );
    expect(
      isWatchfloorManaged('---\nwatchfloor: Managed\nwatchfloor_tier: fully-managed\n---\n'),
    ).toBe(false);
  });

  it('answers no when the tier key is missing — both keys are required', () => {
    expect(isWatchfloorManaged('---\nwatchfloor: managed\n---\n')).toBe(false);
  });

  it('answers no when the tier is not one this package uses', () => {
    expect(isWatchfloorManaged('---\nwatchfloor: managed\nwatchfloor_tier: whatever\n---\n')).toBe(
      false,
    );
  });

  // Fail closed. A file whose frontmatter does not parse is a file we do not
  // understand, and "do not understand" must never resolve to "overwrite".
  it('answers no for frontmatter that is not valid YAML', () => {
    expect(isWatchfloorManaged('---\nwatchfloor: managed\n  : : :\n---\n')).toBe(false);
  });

  it('answers no for frontmatter that parses to a scalar rather than a mapping', () => {
    expect(isWatchfloorManaged('---\njust a string\n---\n')).toBe(false);
  });

  it('answers no when the block is never closed', () => {
    expect(isWatchfloorManaged('---\nwatchfloor: managed\nwatchfloor_tier: fully-managed\n')).toBe(
      false,
    );
  });

  // Frontmatter is frontmatter: it is the first thing in the file or it is
  // nothing. Otherwise any note quoting one of our own notes becomes ours.
  it('answers no when our frontmatter appears further down the file', () => {
    const quoted =
      '# Architecture\n\nThe daily note looks like this:\n\n' +
      '---\nwatchfloor: managed\nwatchfloor_tier: fully-managed\n---\n';
    expect(isWatchfloorManaged(quoted)).toBe(false);
  });

  it('answers no when the opening fence is indented or has trailing text', () => {
    expect(isWatchfloorManaged(' ---\nwatchfloor: managed\nwatchfloor_tier: fully-managed\n---\n'))
      .toBe(false);
    expect(isWatchfloorManaged('---yaml\nwatchfloor: managed\nwatchfloor_tier: fully-managed\n---\n'))
      .toBe(false);
  });
});

describe('renderManagedNote', () => {
  it('puts our frontmatter at the very top and the body below it', () => {
    const note = renderManagedNote({
      tier: 'fully-managed',
      generatedAt: '2026-08-15T07:00:00.000Z',
      body: '# 2026-08-15\n\nSomething happened.\n',
    });
    expect(note.startsWith('---\nwatchfloor: managed\n')).toBe(true);
    expect(note).toContain('watchfloor_tier: fully-managed');
    expect(note).toContain('watchfloor_generated_at: 2026-08-15T07:00:00.000Z');
    expect(note).toContain('# 2026-08-15');
  });

  it('is byte-identical for identical input — the fully-managed tier is idempotent', () => {
    const input = {
      tier: 'fully-managed',
      generatedAt: '2026-08-15T07:00:00.000Z',
      body: '# 2026-08-15\n',
    } as const;
    expect(renderManagedNote(input)).toBe(renderManagedNote(input));
  });

  it('carries extra frontmatter fields a later task supplies', () => {
    const note = renderManagedNote({
      tier: 'fully-managed',
      generatedAt: '2026-08-15T07:00:00.000Z',
      body: '# x\n',
      fields: { date: '2026-08-15', ai_count: 12 },
    });
    expect(note).toContain('date: 2026-08-15');
    expect(note).toContain('ai_count: 12');
    expect(isWatchfloorManaged(note)).toBe(true);
  });

  it('refuses a caller-supplied field that would overwrite one of ours', () => {
    expect(() =>
      renderManagedNote({
        tier: 'fully-managed',
        generatedAt: '2026-08-15T07:00:00.000Z',
        body: '# x\n',
        fields: { watchfloor: 'not-managed' },
      }),
    ).toThrow(VaultContentError);
  });

  it('refuses a non-canonical generatedAt', () => {
    expect(() =>
      renderManagedNote({ tier: 'fully-managed', generatedAt: '2026-08-15', body: '# x\n' }),
    ).toThrow(VaultContentError);
  });

  // A body carrying a marker would let content decide where the managed block
  // ends -- the injection that turns a rendered blurb into a rewrite of the
  // owner's prose.
  it('refuses a body containing a managed-block marker', () => {
    expect(() =>
      renderManagedNote({
        tier: 'managed-block',
        generatedAt: '2026-08-15T07:00:00.000Z',
        body: `text ${WATCHFLOOR_END_MARKER} more`,
      }),
    ).toThrow(VaultContentError);
  });

  it('always ends with exactly one trailing newline', () => {
    for (const body of ['# x', '# x\n', '# x\n\n\n']) {
      const note = renderManagedNote({
        tier: 'fully-managed',
        generatedAt: '2026-08-15T07:00:00.000Z',
        body,
      });
      expect(note.endsWith('\n')).toBe(true);
      expect(note.endsWith('\n\n')).toBe(false);
    }
  });
});

describe('splitManagedBlock — fails closed on anything ambiguous', () => {
  const withBlock = `# Anthropic\n\nMy own notes.\n\n${WATCHFLOOR_BEGIN_MARKER}\nold\n${WATCHFLOOR_END_MARKER}\n\nMore of my notes.\n`;

  it('finds the block and returns the surrounding text verbatim', () => {
    const split = splitManagedBlock(withBlock);
    expect(split.kind).toBe('present');
    if (split.kind !== 'present') return;
    expect(split.prologue).toBe('# Anthropic\n\nMy own notes.\n\n');
    expect(split.epilogue).toBe('\n\nMore of my notes.\n');
  });

  it('reports absent when there are no markers', () => {
    expect(splitManagedBlock('# Anthropic\n\nJust prose.\n').kind).toBe('absent');
  });

  it.each([
    ['a begin with no end', `a\n${WATCHFLOOR_BEGIN_MARKER}\nb\n`],
    ['an end with no begin', `a\n${WATCHFLOOR_END_MARKER}\nb\n`],
    ['two begins', `${WATCHFLOOR_BEGIN_MARKER}\na\n${WATCHFLOOR_BEGIN_MARKER}\nb\n${WATCHFLOOR_END_MARKER}\n`],
    ['two ends', `${WATCHFLOOR_BEGIN_MARKER}\na\n${WATCHFLOOR_END_MARKER}\nb\n${WATCHFLOOR_END_MARKER}\n`],
    ['an end before its begin', `${WATCHFLOOR_END_MARKER}\na\n${WATCHFLOOR_BEGIN_MARKER}\n`],
  ])('reports malformed for %s', (_label, text) => {
    expect(splitManagedBlock(text).kind).toBe('malformed');
  });

  it('hasManagedBlock agrees with splitManagedBlock on the present case only', () => {
    expect(hasManagedBlock(withBlock)).toBe(true);
    expect(hasManagedBlock('# Anthropic\n')).toBe(false);
    expect(hasManagedBlock(`a\n${WATCHFLOOR_BEGIN_MARKER}\nb\n`)).toBe(false);
  });
});

describe('applyManagedBlock — the append-do-not-clobber rule', () => {
  const HAND_WRITTEN =
    '# Anthropic\n\nMy own reading notes on Anthropic. Do not touch this paragraph.\n';

  it('creates a fully rendered note when the file does not exist yet', () => {
    const result = applyManagedBlock(null, 'generated body', {
      generatedAt: '2026-08-15T07:00:00.000Z',
      title: 'Anthropic',
    });
    expect(isWatchfloorManaged(result)).toBe(true);
    expect(hasManagedBlock(result)).toBe(true);
    expect(result).toContain('generated body');
  });

  // §8.1: "If the markers are missing from an existing file, APPEND them --
  // never clobber a file you did not create." The proof that nothing was
  // clobbered is that the original bytes are a STRICT PREFIX of the result.
  it('appends markers to a hand-authored file, leaving every existing byte in place', () => {
    const result = applyManagedBlock(HAND_WRITTEN, 'generated body', {
      generatedAt: '2026-08-15T07:00:00.000Z',
      title: 'Anthropic',
    });
    expect(result.startsWith(HAND_WRITTEN)).toBe(true);
    expect(hasManagedBlock(result)).toBe(true);
    expect(result).toContain('generated body');
  });

  it('does not prepend frontmatter to a hand-authored file — that would not be an append', () => {
    const result = applyManagedBlock(HAND_WRITTEN, 'body', {
      generatedAt: '2026-08-15T07:00:00.000Z',
      title: 'Anthropic',
    });
    expect(result.startsWith('# Anthropic')).toBe(true);
    expect(isWatchfloorManaged(result)).toBe(false);
  });

  it('appends to a file that does not end in a newline without joining the lines', () => {
    const noTrailer = '# Anthropic\n\nLast line with no newline';
    const result = applyManagedBlock(noTrailer, 'body', {
      generatedAt: '2026-08-15T07:00:00.000Z',
      title: 'Anthropic',
    });
    expect(result.startsWith(noTrailer)).toBe(true);
    expect(result).toContain('newline\n');
  });

  it('replaces only between the markers on a second run', () => {
    const first = applyManagedBlock(HAND_WRITTEN, 'first body', {
      generatedAt: '2026-08-15T07:00:00.000Z',
      title: 'Anthropic',
    });
    const second = applyManagedBlock(first, 'second body', {
      generatedAt: '2026-08-16T07:00:00.000Z',
      title: 'Anthropic',
    });
    expect(second.startsWith(HAND_WRITTEN)).toBe(true);
    expect(second).toContain('second body');
    expect(second).not.toContain('first body');
  });

  it('preserves prose the owner added BELOW the managed block', () => {
    const withTrailer = `${HAND_WRITTEN}\n${WATCHFLOOR_BEGIN_MARKER}\nold\n${WATCHFLOOR_END_MARKER}\n\n## My conclusions\n\nStill mine.\n`;
    const result = applyManagedBlock(withTrailer, 'new', {
      generatedAt: '2026-08-15T07:00:00.000Z',
      title: 'Anthropic',
    });
    expect(result.startsWith(HAND_WRITTEN)).toBe(true);
    expect(result.endsWith('\n\n## My conclusions\n\nStill mine.\n')).toBe(true);
    expect(result).toContain('new');
    expect(result).not.toContain('old');
  });

  it('is idempotent — the same body twice produces byte-identical output', () => {
    const opts = { generatedAt: '2026-08-15T07:00:00.000Z', title: 'Anthropic' };
    const once = applyManagedBlock(HAND_WRITTEN, 'body', opts);
    expect(applyManagedBlock(once, 'body', opts)).toBe(once);
  });

  it('refuses a malformed existing file rather than guessing where the block is', () => {
    const malformed = `${HAND_WRITTEN}\n${WATCHFLOOR_BEGIN_MARKER}\nunclosed\n`;
    expect(() =>
      applyManagedBlock(malformed, 'body', {
        generatedAt: '2026-08-15T07:00:00.000Z',
        title: 'Anthropic',
      }),
    ).toThrow(VaultContentError);
  });

  it('refuses a body containing a marker', () => {
    expect(() =>
      applyManagedBlock(HAND_WRITTEN, `x ${WATCHFLOOR_BEGIN_MARKER} y`, {
        generatedAt: '2026-08-15T07:00:00.000Z',
        title: 'Anthropic',
      }),
    ).toThrow(VaultContentError);
  });
});

describe('the invariant applyManagedBlock checks on itself', () => {
  // Every non-creating path asserts, at runtime, that the bytes outside the
  // markers are unchanged. That check is what makes the append rule a proof
  // rather than a claim about the code that happens to be there today.
  it('every result of a real note keeps the outside bytes byte-identical', () => {
    const before = '# Anthropic\n\nOwner prose.\n';
    const after = applyManagedBlock(before, 'generated', {
      generatedAt: '2026-08-15T07:00:00.000Z',
      title: 'Anthropic',
    });
    const split = splitManagedBlock(after);
    expect(split.kind).toBe('present');
    if (split.kind !== 'present') return;
    // Everything the owner wrote is still there, in order, ahead of the block.
    expect(split.prologue.startsWith(before)).toBe(true);
    // And the only bytes this package added ahead of the block are the blank
    // line separating the prose from the marker.
    expect(split.prologue.slice(before.length)).toBe('\n');
  });
});

/**
 * The read-only accessor `vault verify` (M5 task 9) needs.
 *
 * Verify has to answer "which tier does this file CLAIM to be", and the only
 * honest source is the bytes on disk. A second YAML parser in `verify.ts`
 * would be a second answer to "is this ours" — the exact duplication that put
 * the separator bug in two places on the same day — so the accessor lives here
 * and `isWatchfloorManaged` is now defined in terms of it.
 */
describe('readWatchfloorFrontmatter', () => {
  it('returns the tier and the generated-at stamp of a note we wrote', () => {
    const text = renderManagedNote({
      tier: 'managed-block',
      generatedAt: '2026-08-15T03:59:59.999Z',
      body: '# X\n',
      fields: { item_key: 'abc' },
    });

    const parsed = readWatchfloorFrontmatter(text);
    expect(parsed?.tier).toBe('managed-block');
    expect(parsed?.generatedAt).toBe('2026-08-15T03:59:59.999Z');
    expect(parsed?.fields.item_key).toBe('abc');
  });

  it('answers null for exactly the files isWatchfloorManaged rejects', () => {
    for (const text of [
      '# Architecture\n\nHand-written prose.\n',
      '---\nproject: watchfloor\n---\n\n# Mine\n',
      '---\nwatchfloor: managed\n---\n\n# No tier\n',
      '---\nwatchfloor: managed\nwatchfloor_tier: invented\n---\n',
      '---\n: : :\n---\n',
    ]) {
      expect(readWatchfloorFrontmatter(text)).toBeNull();
      expect(isWatchfloorManaged(text)).toBe(false);
    }
  });
});
