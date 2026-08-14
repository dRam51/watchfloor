import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPaidAllowed, assertPaidAllowed, gateStatus, CostPolicyError } from '../../src/cost/gate.ts';
import { SERVICES } from '../../src/cost/registry.ts';

/**
 * Locate a service's row in the docs/costs.md table and split it into cells.
 * Throws (rather than returning undefined) when a service has no row at all,
 * so a missing row fails loudly instead of comparing `undefined` to a string.
 */
function findDocRow(doc: string, id: string): string[] {
  const line = doc
    .split('\n')
    .find((l) => l.trim().startsWith('|') && l.includes(`\`${id}\``));
  if (line === undefined) {
    throw new Error(`docs/costs.md has no table row for '${id}'`);
  }
  return line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
}

/** Strip markdown code-span backticks so cell content compares as plain text. */
function normalizeCell(cell: string | undefined): string {
  return (cell ?? '').replace(/`/g, '').trim();
}

describe('cost gate', () => {
  it('denies every paid category when no flags are set', () => {
    const paid = SERVICES.filter((s) => s.costClass === 'paid');
    expect(paid.length).toBeGreaterThan(0);
    for (const service of paid) {
      expect(isPaidAllowed(service.category!, {})).toBe(false);
      expect(() => assertPaidAllowed(service.category!, {})).toThrow(CostPolicyError);
    }
  });

  it('allows only the category whose own flag is set', () => {
    const env = { WF_ALLOW_PAID_ANTHROPIC: '1' };
    expect(isPaidAllowed('anthropic', env)).toBe(true);
    expect(isPaidAllowed('marketdata', env)).toBe(false);
  });

  it('ignores WF_ALLOW_PAID_ALL, which must never exist', () => {
    const env = { WF_ALLOW_PAID_ALL: '1' };
    expect(isPaidAllowed('anthropic', env)).toBe(false);
    expect(isPaidAllowed('marketdata', env)).toBe(false);
  });

  it('treats any value other than "1" as off', () => {
    expect(isPaidAllowed('anthropic', { WF_ALLOW_PAID_ANTHROPIC: 'true' })).toBe(false);
    expect(isPaidAllowed('anthropic', { WF_ALLOW_PAID_ANTHROPIC: '0' })).toBe(false);
  });

  it('reports disabled categories in the form the dashboard shows', () => {
    expect(gateStatus({})).toEqual({
      anthropic: 'disabled (cost policy)',
      marketdata: 'disabled (cost policy)',
    });
  });

  it('every registered service appears in docs/costs.md', () => {
    const doc = readFileSync(join(process.cwd(), 'docs', 'costs.md'), 'utf8');
    for (const service of SERVICES) {
      expect(doc, `docs/costs.md is missing ${service.id}`).toContain(service.id);
    }
  });

  it("docs/costs.md's Class and Flag columns agree with registry.ts, not just the id", () => {
    // Presence alone (the test above) would stay green even if the doc's
    // stated classification or flag silently drifted from the registry —
    // e.g. anthropic-api relabeled 'free-forever' in the doc while
    // registry.ts still says 'paid'. Parse each service's actual row and
    // compare the real Class/Flag tokens, not a substring.
    const doc = readFileSync(join(process.cwd(), 'docs', 'costs.md'), 'utf8');
    for (const service of SERVICES) {
      const cells = findDocRow(doc, service.id);
      const docClass = normalizeCell(cells[2]);
      const docFlag = normalizeCell(cells[3]);
      const expectedFlag = service.category
        ? `WF_ALLOW_PAID_${service.category.toUpperCase()}`
        : '—';

      expect(
        docClass,
        `${service.id}: docs/costs.md Class column says '${docClass}' but registry.ts costClass is '${service.costClass}'`,
      ).toBe(service.costClass);
      expect(
        docFlag,
        `${service.id}: docs/costs.md Flag column says '${docFlag}' but registry.ts derives '${expectedFlag}'`,
      ).toBe(expectedFlag);
    }
  });

  it('every paid service declares a spend category', () => {
    for (const service of SERVICES.filter((s) => s.costClass === 'paid')) {
      expect(service.category, `${service.id} is paid but has no category`).toBeTruthy();
    }
  });
});

describe('GitHub API cost entry (M4a)', () => {
  it('is registered as free-tier-no-card with no spend flag', () => {
    // An account is required to hold a PAT; a payment method is not. Under
    // docs/costs.md's taxonomy that is free-tier-no-card, which is permitted
    // by default — only `paid` needs a WF_ALLOW_PAID_* flag.
    const github = SERVICES.find((s) => s.id === 'github-api');
    expect(github, 'src/cost/registry.ts has no github-api entry').toBeDefined();
    expect(github!.costClass).toBe('free-tier-no-card');
    expect(github!.category).toBeUndefined();
  });

  it('records that the unauthenticated path needs no account at all', () => {
    // The distinction matters for the zero-dollar rule: with no token the
    // system touches GitHub with no account, no key, and no relationship that
    // could ever bill. The PAT only raises a rate limit.
    const github = SERVICES.find((s) => s.id === 'github-api')!;
    expect(github.rateLimit).toMatch(/unauthenticated/i);
    expect(github.rateLimit).toMatch(/60/);
  });

  it('cannot bill at the limit — requests are refused, never charged', () => {
    const github = SERVICES.find((s) => s.id === 'github-api')!;
    expect(github.onLimit).not.toMatch(/bill|charge|overage/i);
  });

  it('no free-tier-no-card service carries a spend category', () => {
    // A category implies a WF_ALLOW_PAID_* flag, and the doc/registry
    // agreement test derives the doc's Flag column from it. A stray category
    // on a non-paid service would silently demand a flag that should not exist.
    for (const service of SERVICES.filter((s) => s.costClass !== 'paid')) {
      expect(service.category, `${service.id} is not paid but declares a category`).toBeUndefined();
    }
  });
});
