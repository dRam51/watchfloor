import { SPEND_CATEGORIES, type SpendCategory } from './registry.ts';

export class CostPolicyError extends Error {
  constructor(category: SpendCategory) {
    super(
      `${category} is disabled by cost policy; set WF_ALLOW_PAID_${category.toUpperCase()}=1 to enable spending`,
    );
    this.name = 'CostPolicyError';
  }
}

/**
 * The single chokepoint for anything that could bill. Absent flag means the code
 * path is hard-disabled — never a silent fallback, never a deferred retry (§15).
 */
export function isPaidAllowed(
  category: SpendCategory,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[`WF_ALLOW_PAID_${category.toUpperCase()}`] === '1';
}

export function assertPaidAllowed(
  category: SpendCategory,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isPaidAllowed(category, env)) throw new CostPolicyError(category);
}

export function gateStatus(
  env: NodeJS.ProcessEnv = process.env,
): Record<SpendCategory, 'enabled' | 'disabled (cost policy)'> {
  const status = {} as Record<SpendCategory, 'enabled' | 'disabled (cost policy)'>;
  for (const category of SPEND_CATEGORIES) {
    status[category] = isPaidAllowed(category, env) ? 'enabled' : 'disabled (cost policy)';
  }
  return status;
}
