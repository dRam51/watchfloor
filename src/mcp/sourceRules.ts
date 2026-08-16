/**
 * Properties of this package's SOURCE, as functions (M5 task 10).
 *
 * Modelled directly on `src/vault/sourceRules.ts`, including its reason for
 * living in `src/` rather than inside a test file: a detector defined in the
 * test that uses it can never be exercised independently, so it can pass
 * vacuously forever. Here each detector has its own synthetic-input tests in
 * tests/mcp/sourceProperties.test.ts, proving it works before the real tree is
 * handed to it.
 *
 * These functions read no files. The caller supplies the text.
 */

export interface SourceFile {
  /** Repo-relative path, e.g. `src/mcp/server.ts`. */
  readonly path: string;
  readonly text: string;
}

export interface SourceFinding {
  readonly path: string;
  readonly rule: string;
  readonly line: number;
}

/** A line that is only a comment is prose about these rules, not code. */
function isCommentLine(line: string): boolean {
  const code = line.trim();
  return code.startsWith('*') || code.startsWith('//') || code.startsWith('/*');
}

/**
 * Blanks comments while PRESERVING line positions, for the scans that read the
 * whole text rather than line by line.
 *
 * This exists because the first version of `findParameterProperties` flagged
 * `src/mcp/readonly.ts` and this very file — both of which merely *describe*
 * the construct in a doc comment. That is the third time in this project a
 * source-tree rule has matched its own explanation: `src/vault/sourceRules.ts`
 * hit it twice (a `recursive: true` label, and a forbidden-call table matching
 * its own label line). A rule you cannot explain in a comment without tripping
 * it is a rule people delete.
 *
 * Newlines inside a block comment are kept so a reported line number still
 * points at the real one.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

function scanLines(files: readonly SourceFile[], rules: ReadonlyArray<{ label: string; re: RegExp }>): SourceFinding[] {
  const found: SourceFinding[] = [];
  for (const file of files) {
    file.text.split('\n').forEach((line, index) => {
      if (isCommentLine(line)) return;
      for (const rule of rules) {
        if (rule.re.test(line)) found.push({ path: file.path, rule: rule.label, line: index + 1 });
      }
    });
  }
  return found;
}

// ---------------------------------------------------------------------------
// 1. Parameter properties -- the rule that cost a real process crash
// ---------------------------------------------------------------------------
/**
 * `constructor(readonly x: T)` and its `private`/`public`/`protected` siblings.
 *
 * Node 26 executes `src/bin/*.ts` with strip-only type removal, which cannot
 * emit the field assignment a parameter property implies and therefore refuses
 * the syntax outright (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). Vitest transpiles
 * with esbuild, which supports it — so a parameter property is a construct
 * that passes the entire test suite and kills the production process on its
 * first use. That happened here, in `SqlRefusedError`, and was caught only by
 * the child-process test.
 *
 * Scanned over the joined text rather than line by line, because the usual
 * formatting puts the modifier on its own line inside a multi-line parameter
 * list.
 */
export function findParameterProperties(files: readonly SourceFile[]): SourceFinding[] {
  const found: SourceFinding[] = [];
  const constructors = /\bconstructor\s*\(([^)]*)\)/g;
  const modifier = /(^|[\s,(])(readonly|private|public|protected)\s+[A-Za-z_$]/;

  for (const file of files) {
    const code = stripComments(file.text);
    for (const match of code.matchAll(constructors)) {
      const params = match[1] ?? '';
      if (!modifier.test(params)) continue;
      const line = code.slice(0, match.index).split('\n').length;
      found.push({ path: file.path, rule: 'parameter property', line });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// 2. stdout belongs to the protocol
// ---------------------------------------------------------------------------
/**
 * *"The server MUST NOT write anything to its `stdout` that is not a valid MCP
 * message."* The transport writes to the `Writable` it is handed; nothing in
 * this package may reach for the process's own stdout, and `console.log` is
 * the one-keystroke way to do it by accident while debugging.
 *
 * `process.stderr.write` is untouched — the binding explicitly allows it, and
 * the query log depends on it.
 */
export function findStdoutWrites(files: readonly SourceFile[]): SourceFinding[] {
  return scanLines(files, [
    { label: 'console.log', re: /\bconsole\s*\.\s*(?:log|info|debug|dir|table|trace)\s*\(/ },
    { label: 'process.stdout.write', re: /\bprocess\s*\.\s*stdout\s*\.\s*write\s*\(/ },
  ]);
}

// ---------------------------------------------------------------------------
// 3. No writable database handle
// ---------------------------------------------------------------------------
/**
 * §8.2: *"the bot gets no write path."* The distinction this enforces is
 * between "no write happens" and "no write is possible" — a handle opened
 * read-write and merely never written through is the first, and the first is
 * one careless line away from being false.
 *
 * `openDatabase` (src/db/openDatabase.ts) has no read-only mode at all, so
 * importing it is enough to fail. `openDb` is allowed only with an explicit
 * `readOnly: true` on the same call.
 */
export function findWritableDatabaseOpens(files: readonly SourceFile[]): SourceFinding[] {
  // Assembled from fragments so THIS FILE does not contain the token it hunts
  // for. Written as a literal, the pattern matched its own definition line and
  // reported src/mcp/sourceRules.ts as opening a writable database -- the same
  // self-match `stripComments` above exists to fix, arriving by a different
  // route (code, not a comment, so blanking comments does not help).
  const writableOpen = new RegExp(`\\b${'open'}${'Database'}\\b`);
  const found: SourceFinding[] = [];
  for (const file of files) {
    file.text.split('\n').forEach((line, index) => {
      if (isCommentLine(line)) return;
      if (writableOpen.test(line)) {
        found.push({ path: file.path, rule: 'writable database opener', line: index + 1 });
      }
      if (/\bopenDb\s*\(/.test(line) && !/readOnly\s*:\s*true/.test(line)) {
        found.push({ path: file.path, rule: 'openDb without readOnly: true', line: index + 1 });
      }
    });
  }
  return found;
}

// ---------------------------------------------------------------------------
// 4. No filesystem writes, and no HTTP server in the graph
// ---------------------------------------------------------------------------
/**
 * The same boundary as (3), extended to the filesystem. `VACUUM INTO` already
 * proved that "read-only" on the database says nothing about the disk (see
 * src/mcp/readonly.ts); this closes the ordinary route as well.
 *
 * Reads are untouched: src/mcp/migrations.ts must list and hash
 * `db/migrations/*.sql` to do its job.
 */
export function findFilesystemWrites(files: readonly SourceFile[]): SourceFinding[] {
  return scanLines(files, [
    { label: 'writeFileSync', re: /\bwriteFileSync\s*\(/ },
    { label: 'appendFileSync', re: /\bappendFileSync\s*\(/ },
    { label: 'mkdirSync', re: /\bmkdirSync\s*\(/ },
    { label: 'rmSync', re: /\brmSync\s*\(/ },
    { label: 'rmdirSync', re: /\brmdirSync\s*\(/ },
    { label: 'unlinkSync', re: /\bunlinkSync\s*\(/ },
    { label: 'renameSync', re: /\brenameSync\s*\(/ },
    { label: 'linkSync', re: /\blinkSync\s*\(/ },
    { label: 'symlinkSync', re: /\bsymlinkSync\s*\(/ },
    { label: 'truncateSync', re: /\btruncateSync\s*\(/ },
    { label: 'createWriteStream', re: /\bcreateWriteStream\s*\(/ },
  ]);
}

/**
 * "Separate process" is only true if the other process is not in this one's
 * module graph. Importing `src/api/**` would drag Fastify, the dashboard's
 * bearer-token hook and every route into the bot's process — and would make
 * `src/mcp/auth.ts`'s duplicated `constantTimeEqual` look like pointless
 * duplication rather than the boundary it is.
 */
export function findForbiddenImports(files: readonly SourceFile[]): SourceFinding[] {
  return scanLines(files, [
    { label: 'fastify', re: /from\s+['"]fastify['"]/ },
    { label: 'the api package', re: /from\s+['"][^'"]*\bapi\/[^'"]*['"]/ },
  ]);
}

// ---------------------------------------------------------------------------
// 5. No way out to the network (M5 task 11)
// ---------------------------------------------------------------------------
/**
 * The other half of rule 4. That one keeps the *dashboard* out of this
 * process's module graph; this one keeps the *poller* out, and closes the
 * remaining direction a read-only server could acquire reach.
 *
 * It was written because task 11 declined a one-line convenience on exactly
 * this ground and nothing was enforcing it: `get_source_health` needs
 * `poll_interval` in milliseconds, and `src/scheduler/run.ts` exports a parser
 * for it — but that module imports `src/fetch/robots.ts`, so the import would
 * have put an HTTP client in the bot's graph to save six lines of arithmetic.
 * A decision defended only in a comment is one the next person reverses, so it
 * is a rule now, and the duplicated parser is pinned against the original by a
 * test instead.
 *
 * `node:https` and the global `fetch` are included for the blunt reason: a
 * process that cannot construct an outbound request cannot leak a corpus to
 * one, whatever a future tool author intends. `node:sqlite`, `node:crypto`,
 * `node:fs` reads and `node:path` are untouched.
 */
export function findNetworkReach(files: readonly SourceFile[]): SourceFinding[] {
  return scanLines(files, [
    { label: 'the fetch package', re: /from\s+['"][^'"]*\bfetch\/[^'"]*['"]/ },
    { label: 'the adapters package', re: /from\s+['"][^'"]*\badapters\/[^'"]*['"]/ },
    { label: 'the scheduler package', re: /from\s+['"][^'"]*\bscheduler\/[^'"]*['"]/ },
    { label: 'the ingest package', re: /from\s+['"][^'"]*\bingest\/[^'"]*['"]/ },
    { label: 'a node network module', re: /from\s+['"]node:(?:http|https|net|tls|dgram|dns)['"]/ },
    { label: 'undici', re: /from\s+['"]undici['"]/ },
    { label: 'the global fetch', re: /\bfetch\s*\(/ },
    // Assembled from fragments, not written as a literal. Every other pattern
    // here contains a regex escape (`\s`, `\/`, `\b` mid-token) that stops it
    // matching its own definition line; this one is a bare identifier and DID
    // match, reporting src/mcp/sourceRules.ts as reaching for the network. That
    // is the FOURTH occurrence of a source rule matching its own explanation in
    // this project -- src/vault/sourceRules.ts twice in one day, then
    // findParameterProperties, now this. `stripComments` does not help, because
    // the offending text is code.
    { label: 'a browser http client', re: new RegExp(`\\b${'XML'}${'HttpRequest'}\\b`) },
  ]);
}
