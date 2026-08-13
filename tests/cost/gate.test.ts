import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPaidAllowed, assertPaidAllowed, gateStatus, CostPolicyError } from '../../src/cost/gate.ts';
import { SERVICES } from '../../src/cost/registry.ts';

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

  it('every paid service declares a spend category', () => {
    for (const service of SERVICES.filter((s) => s.costClass === 'paid')) {
      expect(service.category, `${service.id} is paid but has no category`).toBeTruthy();
    }
  });
});
