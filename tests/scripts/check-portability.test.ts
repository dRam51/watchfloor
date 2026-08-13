import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

describe('check:portability', () => {
  it('passes on the current tree', () => {
    const out = execFileSync('node', [join(process.cwd(), 'scripts', 'check-portability.mjs')], {
      encoding: 'utf8',
    });
    expect(out).toContain('portability check passed');
  });
});
