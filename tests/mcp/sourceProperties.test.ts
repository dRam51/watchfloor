/**
 * Rules about the SOURCE TREE, expressed as functions so they can be tested
 * rather than merely asserted (M5 task 10) — the same shape, and for the same
 * reason, as `src/vault/sourceRules.ts`:
 *
 * > *"A detector defined inside the test that uses it can only ever be
 * > exercised by that test. Here the detectors are ordinary functions with
 * > their own synthetic-input tests, so this file can prove the detector works
 * > BEFORE trusting what it reports about the real tree."*
 *
 * Four rules, and every one of them exists because breaking it is invisible to
 * an ordinary unit test:
 *
 * 1. **No TypeScript parameter properties.** Node 26 runs `src/bin/*.ts`
 *    through strip-only type removal and rejects them outright; vitest's
 *    esbuild transpiles them fine. The first draft of `src/mcp/readonly.ts`
 *    used one, passed 30 tests, and killed the real process — caught only by
 *    tests/mcp/bin.test.ts spawning it.
 * 2. **Nothing writes to stdout except the transport's own stream.** *"The
 *    server MUST NOT write anything to its `stdout` that is not a valid MCP
 *    message."* A stray `console.log` corrupts a live session, and no assertion
 *    about a return value can see it.
 * 3. **No writable database handle, anywhere in this process.** §8.2: *"the bot
 *    gets no write path."* Not "no write happens" — no write is possible.
 * 4. **No filesystem writes, and no import of the HTTP server.** The same
 *    boundary, extended to the two other ways a process acquires reach.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  findFilesystemWrites,
  findForbiddenImports,
  findParameterProperties,
  findStdoutWrites,
  findWritableDatabaseOpens,
  type SourceFile,
} from '../../src/mcp/sourceRules.ts';

const repoRoot = join(import.meta.dirname, '..', '..');

/** Every file this process's boundary covers: the package, plus its entrypoint. */
function mcpSources(): SourceFile[] {
  const dir = join(repoRoot, 'src', 'mcp');
  const files: SourceFile[] = readdirSync(dir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ path: `src/mcp/${name}`, text: readFileSync(join(dir, name), 'utf8') }));
  files.push({
    path: 'src/bin/mcp.ts',
    text: readFileSync(join(repoRoot, 'src', 'bin', 'mcp.ts'), 'utf8'),
  });
  return files;
}

// ---------------------------------------------------------------------------
// The detectors, on synthetic input, BEFORE the real tree is trusted to them
// ---------------------------------------------------------------------------
describe('findParameterProperties', () => {
  it('flags a single-line parameter property', () => {
    const found = findParameterProperties([
      { path: 'a.ts', text: 'class E extends Error { constructor(readonly reason: string) { super(reason); } }' },
    ]);
    expect(found).toHaveLength(1);
  });

  it('flags one spread across lines, which is how it is usually written', () => {
    const found = findParameterProperties([
      { path: 'a.ts', text: 'class E {\n  constructor(\n    readonly path: string,\n    readonly field: string,\n  ) {}\n}\n' },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]!.line).toBe(2);
  });

  it.each(['private', 'public', 'protected'])('flags the %s modifier too', (modifier) => {
    expect(findParameterProperties([{ path: 'a.ts', text: `class E { constructor(${modifier} x: string) {} }` }])).toHaveLength(1);
  });

  it('does NOT flag a declared field assigned in the constructor — the correct form', () => {
    const text = 'class E extends Error {\n  readonly reason: string;\n  constructor(reason: string) {\n    super(reason);\n    this.reason = reason;\n  }\n}\n';
    expect(findParameterProperties([{ path: 'a.ts', text }])).toEqual([]);
  });

  it('does NOT flag an ordinary constructor', () => {
    expect(findParameterProperties([{ path: 'a.ts', text: 'class E { constructor(message: string) { super(message); } }' }])).toEqual([]);
  });

  // The rule tripping over its own explanation is a real recurrence in this
  // project: src/vault/sourceRules.ts hit it twice in one day. The first draft
  // here flagged src/mcp/readonly.ts and src/mcp/sourceRules.ts, both of which
  // only DESCRIBE the construct in a doc comment.
  it('does NOT flag a parameter property written in a comment about parameter properties', () => {
    const text = '/**\n * Never write `constructor(readonly reason: string)` -- Node 26 refuses it.\n */\nclass E { constructor(reason: string) { super(reason); } }\n';
    expect(findParameterProperties([{ path: 'a.ts', text }])).toEqual([]);
  });

  it('reports a line number that still points at the real line after comments are blanked', () => {
    const text = '/*\n multi\n line\n comment\n*/\nclass E {\n  constructor(readonly x: string) {}\n}\n';
    expect(findParameterProperties([{ path: 'a.ts', text }])[0]!.line).toBe(7);
  });
});

describe('findStdoutWrites', () => {
  it('flags console.log', () => {
    expect(findStdoutWrites([{ path: 'a.ts', text: 'console.log("hi");' }])).toHaveLength(1);
  });

  it('flags process.stdout.write', () => {
    expect(findStdoutWrites([{ path: 'a.ts', text: 'process.stdout.write("hi");' }])).toHaveLength(1);
  });

  it('does not flag process.stderr.write, which the binding permits', () => {
    expect(findStdoutWrites([{ path: 'a.ts', text: 'process.stderr.write(line);' }])).toEqual([]);
  });

  it('does not flag prose about console.log in a comment', () => {
    expect(findStdoutWrites([{ path: 'a.ts', text: ' * a stray console.log() would corrupt the protocol' }])).toEqual([]);
  });
});

describe('findWritableDatabaseOpens', () => {
  it('flags a bare openDb', () => {
    expect(findWritableDatabaseOpens([{ path: 'a.ts', text: 'const db = openDb(path);' }])).toHaveLength(1);
  });

  it('flags openDatabase, which is writable by construction', () => {
    expect(findWritableDatabaseOpens([{ path: 'a.ts', text: "import { openDatabase } from '../db/openDatabase.ts';" }])).toHaveLength(1);
  });

  it('does not flag an explicitly read-only open', () => {
    expect(findWritableDatabaseOpens([{ path: 'a.ts', text: 'const db = openDb(path, { readOnly: true });' }])).toEqual([]);
  });

  it('flags an explicitly read-WRITE open', () => {
    expect(findWritableDatabaseOpens([{ path: 'a.ts', text: 'const db = openDb(path, { readOnly: false });' }])).toHaveLength(1);
  });
});

describe('findFilesystemWrites', () => {
  it.each(['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'renameSync'])(
    'flags %s',
    (call) => {
      expect(findFilesystemWrites([{ path: 'a.ts', text: `${call}(target, data);` }])).toHaveLength(1);
    },
  );

  it('does not flag the reads the migration check needs', () => {
    expect(findFilesystemWrites([{ path: 'a.ts', text: 'readdirSync(dir); readFileSync(path, "utf8");' }])).toEqual([]);
  });
});

describe('findForbiddenImports', () => {
  it('flags fastify', () => {
    expect(findForbiddenImports([{ path: 'a.ts', text: "import type { FastifyInstance } from 'fastify';" }])).toHaveLength(1);
  });

  it('flags reaching into the API package', () => {
    expect(findForbiddenImports([{ path: 'a.ts', text: "import { registerAuth } from '../api/auth.ts';" }])).toHaveLength(1);
  });

  it('does not flag an ordinary internal import', () => {
    expect(findForbiddenImports([{ path: 'a.ts', text: "import { openDb } from '../db/connection.ts';" }])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ...and now the real tree
// ---------------------------------------------------------------------------
describe('the MCP package itself', () => {
  it('is actually being scanned — the non-vacuity check', () => {
    const files = mcpSources();
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(files.map((f) => f.path)).toContain('src/bin/mcp.ts');
    expect(files.map((f) => f.path)).toContain('src/mcp/server.ts');
  });

  it('contains no TypeScript parameter property, which Node 26 cannot strip', () => {
    expect(findParameterProperties(mcpSources())).toEqual([]);
  });

  it('writes nothing to stdout outside the transport stream it is handed', () => {
    expect(findStdoutWrites(mcpSources())).toEqual([]);
  });

  it('opens no writable database handle anywhere, not even at boot', () => {
    expect(findWritableDatabaseOpens(mcpSources())).toEqual([]);
  });

  it('writes nothing to the filesystem', () => {
    expect(findFilesystemWrites(mcpSources())).toEqual([]);
  });

  it('does not import the HTTP server it is isolated from', () => {
    expect(findForbiddenImports(mcpSources())).toEqual([]);
  });
});
