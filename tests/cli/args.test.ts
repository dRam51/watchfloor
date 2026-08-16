import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../../src/cli/args.ts';

/**
 * The `watchfloor` CLI's argument surface (M5 task 12).
 *
 * Parsing is a pure function of `argv` and is tested as one, so that the
 * spawn tests in `bin.test.ts` are free to be about the wiring rather than
 * about flag combinatorics. The single most important assertion in this file
 * is the one that says **`vault prune` with no flags is a dry run** — every
 * other test here is ordinary CLI hygiene.
 */

describe('nothing, and asking for help', () => {
  it('treats an empty invocation as a request for help that was not made', () => {
    // Distinguished from `--help` because the two deserve different exit
    // codes: asking got you what you asked for, not asking did not.
    expect(parseCliArgs([])).toEqual({ kind: 'no-command' });
  });

  it.each(['--help', '-h', 'help'])('%s asks for the root help', (flag) => {
    expect(parseCliArgs([flag])).toEqual({ kind: 'help', topic: 'root' });
  });

  it('names a group without a command as a request for the group help', () => {
    expect(parseCliArgs(['vault'])).toEqual({ kind: 'help', topic: 'vault' });
  });

  it.each([
    ['sync', 'vault sync'],
    ['verify', 'vault verify'],
    ['prune', 'vault prune'],
  ])('vault %s --help documents that one command', (sub, topic) => {
    expect(parseCliArgs(['vault', sub, '--help'])).toEqual({ kind: 'help', topic });
  });

  it('answers --help even when --apply is also on the line', () => {
    // A `--help` that ran the command first would be the worst possible
    // reading of the one command in this system permitted to delete.
    expect(parseCliArgs(['vault', 'prune', '--apply', '--expect=3', '--help'])).toEqual({
      kind: 'help',
      topic: 'vault prune',
    });
  });
});

describe('vault verify', () => {
  it('needs no flags', () => {
    expect(parseCliArgs(['vault', 'verify'])).toEqual({ kind: 'vault-verify', json: false });
  });

  it('takes --json', () => {
    expect(parseCliArgs(['vault', 'verify', '--json'])).toEqual({
      kind: 'vault-verify',
      json: true,
    });
  });

  it('has no --fix, and the refusal says why', () => {
    // §8.1's verify reports and never repairs; src/vault/verify.ts has no
    // repair path and deliberately no option to add one. A CLI that accepted
    // the flag and ignored it would be worse than one that refuses it.
    const parsed = parseCliArgs(['vault', 'verify', '--fix']);
    expect(parsed.kind).toBe('usage-error');
    expect(parsed.kind === 'usage-error' && parsed.message).toContain('--fix');
    expect(parsed.kind === 'usage-error' && parsed.message).toContain('reports');
  });
});

describe('vault prune — the dry run is the default and the only default', () => {
  it('is a dry run with no flags at all', () => {
    expect(parseCliArgs(['vault', 'prune'])).toEqual({
      kind: 'vault-prune',
      json: false,
      apply: false,
      expect: null,
    });
  });

  it('refuses --apply on its own, and names what is missing', () => {
    // The load-bearing decision. `--apply` alone would be a flag you can
    // acquire the habit of typing; --expect=N cannot be typed without having
    // read a dry run first, because N is not knowable any other way.
    const parsed = parseCliArgs(['vault', 'prune', '--apply']);
    expect(parsed.kind).toBe('usage-error');
    expect(parsed.kind === 'usage-error' && parsed.message).toContain('--expect');
  });

  it('accepts --apply --expect=N', () => {
    expect(parseCliArgs(['vault', 'prune', '--apply', '--expect=3'])).toEqual({
      kind: 'vault-prune',
      json: false,
      apply: true,
      expect: 3,
    });
  });

  it('accepts the separated form --expect N', () => {
    expect(parseCliArgs(['vault', 'prune', '--apply', '--expect', '3'])).toEqual({
      kind: 'vault-prune',
      json: false,
      apply: true,
      expect: 3,
    });
  });

  it('accepts --expect on a dry run, where it only checks the count', () => {
    expect(parseCliArgs(['vault', 'prune', '--expect=0'])).toEqual({
      kind: 'vault-prune',
      json: false,
      apply: false,
      expect: 0,
    });
  });

  it.each(['abc', '-1', '1.5', '', '3 '])('refuses --expect=%s', (value) => {
    const parsed = parseCliArgs(['vault', 'prune', '--apply', `--expect=${value}`]);
    expect(parsed.kind).toBe('usage-error');
  });
});

describe('unknown things are refused rather than guessed at', () => {
  it('refuses an unknown vault subcommand and lists the real ones', () => {
    const parsed = parseCliArgs(['vault', 'frobnicate']);
    expect(parsed.kind).toBe('usage-error');
    expect(parsed.kind === 'usage-error' && parsed.message).toContain('frobnicate');
    expect(parsed.kind === 'usage-error' && parsed.message).toContain('verify');
  });

  it('refuses an unknown flag on a vault command', () => {
    const parsed = parseCliArgs(['vault', 'verify', '--quiet']);
    expect(parsed.kind).toBe('usage-error');
    expect(parsed.kind === 'usage-error' && parsed.message).toContain('quiet');
  });

  it('refuses a stray positional after a vault command', () => {
    const parsed = parseCliArgs(['vault', 'verify', 'now']);
    expect(parsed.kind).toBe('usage-error');
  });
});

describe('everything else is delegated, and its flags are NOT ours to read', () => {
  it('delegates a bare command name', () => {
    expect(parseCliArgs(['ingest'])).toEqual({ kind: 'delegate', command: 'ingest', args: [] });
  });

  it('passes flags through verbatim', () => {
    // `npm run score:force` exists precisely because src/bin/score.ts owns
    // --force. If this layer parsed it, the two would drift the first time
    // score.ts grew a second flag.
    expect(parseCliArgs(['score', '--force'])).toEqual({
      kind: 'delegate',
      command: 'score',
      args: ['--force'],
    });
  });

  it('does not steal --json from a command that has its own', () => {
    // src/bin/suggest.ts already has --json, and it means something there.
    expect(parseCliArgs(['suggest', '--json'])).toEqual({
      kind: 'delegate',
      command: 'suggest',
      args: ['--json'],
    });
  });

  it('does not steal --help from a delegated command either', () => {
    expect(parseCliArgs(['ingest', '--help'])).toEqual({
      kind: 'delegate',
      command: 'ingest',
      args: ['--help'],
    });
  });

  it('refuses a command name that could escape src/bin', () => {
    // The command name becomes a filename. A separator or a dot in it is not
    // a command, and treating it as one is how a CLI runs an arbitrary file.
    for (const name of ['../api', 'foo/bar', '.', 'a.b']) {
      expect(parseCliArgs([name]).kind, name).toBe('usage-error');
    }
  });
});
