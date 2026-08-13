#!/usr/bin/env node
// Enforces the §12 portability rules mechanically. Read-only: reports and exits.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((f) => !SKIP.some((re) => re.test(f)));

const violations = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
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

const tsconfig = JSON.parse(readFileSync('tsconfig.json', 'utf8'));
if (tsconfig.compilerOptions?.forceConsistentCasingInFileNames !== true) {
  violations.push('tsconfig.json  forceConsistentCasingInFileNames must be true (§12)');
}

if (violations.length > 0) {
  console.error(`portability check failed (${violations.length}):`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`portability check passed (${files.length} files)`);
