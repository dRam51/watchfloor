/**
 * Two rules about the SOURCE TREE, expressed as functions so they can be
 * tested rather than merely asserted (M5 task 4).
 *
 * The task brief: *"Nothing in Waves 2–4 may call `fs` directly — make that a
 * property you can check, and check it."*
 *
 * ## Why the rules live in `src/` rather than inside the test
 *
 * A detector defined inside the test that uses it can only ever be exercised
 * by that test. Here the detectors are ordinary functions with their own
 * synthetic-input tests, so `tests/vault/sourceProperties.test.ts` can prove
 * the detector works *before* trusting what it reports about the real tree.
 * That distinction is exactly what M4a's post-mortem was about: a test named
 * for a rule it never actually exercised passed for a whole milestone.
 *
 * These functions read no files. The caller supplies the text, which is what
 * makes the synthetic cases possible.
 */

export interface SourceFile {
  /** Repo-relative path, e.g. `src/vault/session.ts`. */
  readonly path: string;
  readonly text: string;
}

export interface ForbiddenCall {
  readonly path: string;
  readonly call: string;
  readonly line: number;
}

// `node:fs`, `node:fs/promises`, bare `fs`, in import, require, or dynamic
// import position. Anchored on the quoted specifier so a module named
// `fsm.ts` or a comment mentioning fs does not match.
const FS_SPECIFIER = /['"](?:node:)?fs(?:\/promises)?['"]/;

// A specifier that resolves into the vault package: any relative path whose
// final directory segment is `vault`. `./vaulting.ts` does not match.
const VAULT_SPECIFIER = /['"][^'"]*\bvault\/[^'"]*['"]/;

export function importsNodeFs(text: string): boolean {
  return FS_SPECIFIER.test(text);
}

export function importsVaultPackage(text: string): boolean {
  return VAULT_SPECIFIER.test(text);
}

/**
 * Every file that imports the vault package **and** reaches for the
 * filesystem itself.
 *
 * `exemptPrefixes` is how `src/vault/` excuses itself: it is the package that
 * is *allowed* to touch `fs`, and its own modules import each other. Passing
 * `[]` therefore turns this into a non-vacuity check — it must flag real files
 * in this repository, or the scan is not reading anything.
 */
export function findVaultCallersTouchingFs(
  files: readonly SourceFile[],
  exemptPrefixes: readonly string[],
): SourceFile[] {
  return files.filter((file) => {
    // The separator is required, exactly as in `isContainedIn`: a bare
    // `startsWith('src/vault')` also exempts `src/vault-sync/`, which is
    // precisely the kind of module this rule exists to catch. Found by the
    // synthetic case in the test file, which used that name on purpose.
    if (exemptPrefixes.some((prefix) => file.path === prefix || file.path.startsWith(`${prefix}/`)))
      return false;
    return importsVaultPackage(file.text) && importsNodeFs(file.text);
  });
}

/**
 * Calls this package may never contain.
 *
 * The deletions come from CLAUDE.md's standing rule ("no `fs.rm`,
 * `fs.unlink`") and the M5 plan's sharpening of it ("`vault prune` is the one
 * job allowed to remove anything").
 *
 * `recursive: true` is here for a different reason and is just as important:
 * `mkdirSync(root, { recursive: true })` is the single call that fabricates
 * the iCloud shadow tree the mount guard exists to prevent, and it is one
 * autocomplete away at every `mkdir` site.
 */
const FORBIDDEN: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'rmSync', re: /\brmSync\s*\(/ },
  { label: 'rmdirSync', re: /\brmdirSync\s*\(/ },
  { label: 'unlinkSync', re: /\bunlinkSync\s*\(/ },
  { label: 'rm', re: /(?:\bfs\.)?\brm\s*\(/ },
  { label: 'rmdir', re: /(?:\bfs\.)?\brmdir\s*\(/ },
  { label: 'unlink', re: /(?:\bfs\.)?\bunlink\s*\(/ },
  // Label deliberately does NOT spell the pattern out: written literally, this
  // entry matches its own line and the rule reports the file that defines it.
  // Found by running the scan over src/vault/ for the first time.
  { label: 'recursive mkdir', re: /recursive\s*:\s*true/ },
];

/**
 * The single exception in the whole project, and the reason it is expressed
 * this way rather than by weakening {@link FORBIDDEN}.
 *
 * The M5 plan: *"`vault prune` is the one job allowed to remove anything, it
 * is confined to `watchfloor/`."* So exactly one delete has to exist, and the
 * useful rule is not "the vault package deletes nothing" — that one is now
 * false — but **"the vault package contains one delete, in one file, of one
 * kind, and it is this one."** {@link findForbiddenCalls} is unchanged and
 * still finds it; the allowance only sorts the finding into a second list.
 *
 * A `path` here is a repo-relative path with either separator.
 */
export interface DeleteAllowance {
  readonly path: string;
  readonly call: string;
}

/**
 * `removeVaultFile` in `src/vault/session.ts` — the only line in this
 * repository permitted to unlink a file. It lives in the safety layer rather
 * than in `prune.ts` for the same reason every other write does: `prune.ts`
 * may not import the filesystem, so the containment, area and ownership gates
 * are enforced in one place that the policy layer cannot route around.
 */
export const VAULT_DELETE_ALLOWANCES: readonly DeleteAllowance[] = [
  { path: 'src/vault/session.ts', call: 'unlinkSync' },
];

export interface ForbiddenCallAudit {
  /** Every finding no allowance covers. This is the list that must be empty. */
  readonly unsanctioned: ForbiddenCall[];
  /**
   * The occurrences an allowance consumed. Asserting on this is what keeps a
   * stale allowance from silently covering a delete added later for an
   * unrelated reason: each allowance is spent by **at most one** occurrence.
   */
  readonly sanctioned: ForbiddenCall[];
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/') === b.replace(/\\/g, '/');
}

/**
 * {@link findForbiddenCalls}, split against a list of named allowances.
 *
 * Each allowance is consumed by the first occurrence matching both its file
 * and its call, so a second delete on another line of the same file lands in
 * `unsanctioned`. "This file may delete things" would be a materially weaker
 * rule than "this one line may", and the weaker one is the one that stops
 * catching the mistake.
 */
export function auditForbiddenCalls(
  files: readonly SourceFile[],
  allowances: readonly DeleteAllowance[],
): ForbiddenCallAudit {
  const unspent = allowances.map((allowance) => ({ allowance, spent: false }));
  const unsanctioned: ForbiddenCall[] = [];
  const sanctioned: ForbiddenCall[] = [];

  for (const found of findForbiddenCalls(files)) {
    const match = unspent.find(
      (candidate) =>
        !candidate.spent &&
        candidate.allowance.call === found.call &&
        samePath(candidate.allowance.path, found.path),
    );
    if (match === undefined) unsanctioned.push(found);
    else {
      match.spent = true;
      sanctioned.push(found);
    }
  }
  return { unsanctioned, sanctioned };
}

export function findForbiddenCalls(files: readonly SourceFile[]): ForbiddenCall[] {
  const found: ForbiddenCall[] = [];
  for (const file of files) {
    file.text.split('\n').forEach((line, index) => {
      // A line that is only a comment is prose about these rules, not a call.
      // `src/vault/session.ts` and `mount.ts` both explain why `recursive:
      // true` is absent, and the explanation must not trip the rule it
      // explains.
      const code = line.trim();
      if (code.startsWith('*') || code.startsWith('//')) return;
      for (const rule of FORBIDDEN) {
        if (rule.re.test(line)) found.push({ path: file.path, call: rule.label, line: index + 1 });
      }
    });
  }
  return found;
}
