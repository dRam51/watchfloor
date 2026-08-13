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

if (violations.length > 0) {
  console.error(`portability check failed (${violations.length}):`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`portability check passed (${files.length} files)`);
