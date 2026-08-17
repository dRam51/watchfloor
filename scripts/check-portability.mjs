#!/usr/bin/env node
// Enforces the §12 portability rules mechanically. Read-only: reports and exits.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const RULES = [
  { name: 'absolute unix path', re: /\/(Users|home)\/[A-Za-z0-9._-]+/g },
  { name: 'absolute windows path', re: /\b[A-Za-z]:\\\\?[A-Za-z0-9._-]+/g },
  { name: 'macOS-only binary', re: /\b(pbcopy|pbpaste|osascript|mdfind|diskutil)\b/g },
  { name: 'macOS keychain', re: /\bsecurity\s+(find|add)-generic-password\b/g },
];

const SKIP = [
  /^package-lock\.json$/,
  /^docs\/brief\.md$/,
  /^scripts\/check-portability\.mjs$/,
  // Planning docs quote this script's own rule list (e.g. `pbcopy`) as prose,
  // not as portability violations in application code.
  /^docs\/superpowers\/plans\//,
  // This checker's own tests build deliberately-bad fixtures as string
  // literals -- `config/Sources.yaml` and an absolute path -- so scanning them
  // reports the fixtures as violations of the rules they exist to prove. Same
  // exemption, and same reason, as scripts/check-portability.mjs above.
  //
  // Worth naming: a rule matching its own definition or its own test is now the
  // FOURTH occurrence in this project (src/vault/sourceRules.ts hit it twice in
  // one day, src/mcp/sourceRules.ts once). It is apparently intrinsic to
  // source-scanning rules, and the fix is always this: exempt the file that
  // describes the rule, never weaken the pattern.
  /^tests\/scripts\/check-portability\.test\.ts$/,
];

// Target directory defaults to the current one, preserving the CI behavior
// exactly. An explicit argument exists so the rules can be exercised against a
// known-bad fixture tree: a test that only asserts "passes on the current
// tree" stays green even if every rule below were deleted.
const target = resolve(process.argv[2] ?? '.');

// Inside a git repo, git ls-files is authoritative — it honors .gitignore and
// skips node_modules for free. Fall back to walking the directory when it
// yields nothing, which covers both "not a repo at all" and the subtler case
// of an untracked directory *inside* one: there, git ls-files succeeds and
// returns zero files, which would make the whole check pass vacuously.
function listFiles(dir) {
  try {
    const tracked = execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    if (tracked.length > 0) return tracked;
  } catch {
    // not a git repository — fall through to the walk
  }
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)));
}

const files = listFiles(target).filter((f) => !SKIP.some((re) => re.test(f)));

const violations = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(join(target, file), 'utf8');
  } catch {
    continue; // binary or unreadable — nothing to check
  }
  const lines = text.split('\n');
  for (const rule of RULES) {
    lines.forEach((line, i) => {
      rule.re.lastIndex = 0;
      const match = rule.re.exec(line);
      if (match) violations.push(`${file}:${i + 1}  ${rule.name}: ${match[0]}`);
    });
  }
}

// Read relative to the target, not the process cwd, so the rule travels with
// the directory being checked. A fixture tree with no tsconfig.json is not a
// violation — there is nothing to get wrong.
try {
  const tsconfig = JSON.parse(readFileSync(join(target, 'tsconfig.json'), 'utf8'));
  if (tsconfig.compilerOptions?.forceConsistentCasingInFileNames !== true) {
    violations.push('tsconfig.json  forceConsistentCasingInFileNames must be true (§12)');
  }
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

// ---------------------------------------------------------------------------
// Case-exact FILE REFERENCES (M6). §12 asks for "a lint rule or a CI check that
// enforces case-exact imports and filenames", because macOS is case-insensitive
// and Linux is not: `./Item` resolving item.ts works on the dev laptop and
// breaks on the target host.
//
// ## What is already covered, and why this is scoped narrowly
//
// TypeScript IMPORTS are already handled, by tsconfig's
// forceConsistentCasingInFileNames (asserted just above) plus `npm run
// typecheck`. Verified empirically rather than assumed, both ways round:
//
//   - a file imported correctly elsewhere and once with bad casing -> TS1149
//   - a file whose ONLY importer uses bad casing               -> TS1261
//
// The second was the one worth checking, since TS1149's message is phrased as
// "differs from already included file name" and reads as though it needs a
// correct reference to compare against. It does not.
//
// So re-implementing an import scanner here would be redundant. What tsc
// genuinely cannot see is a path assembled from STRING LITERALS at runtime --
// `join(repoRoot, 'config', 'sources.yaml')`, a migration filename, a fixture
// path. Those are just strings to the compiler, they resolve on macOS whatever
// their casing, and they fail at runtime on Linux with ENOENT. That is the gap
// this closes.
// ---------------------------------------------------------------------------

// Every tracked path, indexed by its lowercase form, so a reference can be
// compared against what is really on disk.
const realByLower = new Map();
for (const f of listFiles(target)) realByLower.set(f.toLowerCase(), f);

// Two tracked files differing only in case cannot both survive a checkout on a
// case-insensitive filesystem -- one silently overwrites the other. Checked
// first because everything below assumes the map is unambiguous.
const seenLower = new Map();
for (const f of listFiles(target)) {
  const lower = f.toLowerCase();
  const first = seenLower.get(lower);
  if (first !== undefined && first !== f) {
    violations.push(`${f}  differs from ${first} only in casing — they collide on a case-insensitive checkout`);
  }
  seenLower.set(lower, f);
}

// A quoted, repo-relative path under a directory whose contents are read by
// path at runtime. Deliberately not every string that looks pathish: a URL
// path, a vault-relative note name, or a SQL identifier would produce noise
// with no portability meaning.
const RUNTIME_PATH = /['"`]((?:config|db\/migrations|tests\/fixtures|scripts|web\/src)\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+)['"`]/g;

for (const file of files) {
  let text;
  try {
    text = readFileSync(join(target, file), 'utf8');
  } catch {
    continue;
  }
  text.split('\n').forEach((line, i) => {
    RUNTIME_PATH.lastIndex = 0;
    let m;
    while ((m = RUNTIME_PATH.exec(line)) !== null) {
      const referenced = m[1];
      const real = realByLower.get(referenced.toLowerCase());
      // Unknown to git = not a tracked file. That is an ordinary miss (a
      // generated path, a fixture written at test time), not a casing problem;
      // reporting it would make this rule noisy and therefore ignored.
      if (real !== undefined && real !== referenced) {
        violations.push(
          `${file}:${i + 1}  case-mismatched path: refers to ${referenced}, on disk it is ${real}`,
        );
      }
    }
  });
}

if (violations.length > 0) {
  console.error(`portability check failed (${violations.length}):`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`portability check passed (${files.length} files)`);
