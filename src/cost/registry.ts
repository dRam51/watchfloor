export type CostClass = 'free-forever' | 'free-tier-no-card' | 'paid';

/** One flag per spend category. There is deliberately no "all" category. */
export type SpendCategory = 'anthropic' | 'marketdata';

export const SPEND_CATEGORIES: SpendCategory[] = ['anthropic', 'marketdata'];

export interface ServiceEntry {
  id: string;
  name: string;
  costClass: CostClass;
  /** Required when costClass is 'paid'. */
  category?: SpendCategory;
  rateLimit: string;
  /** What happens at the limit. For non-paid services this must never be "it bills". */
  onLimit: string;
}

export const SERVICES: ServiceEntry[] = [
  {
    id: 'cisa-kev',
    name: 'CISA Known Exploited Vulnerabilities catalog',
    costClass: 'free-forever',
    rateLimit: 'none published',
    onLimit: 'requests fail; source-health page shows it',
  },
  {
    id: 'anthropic-api',
    name: 'Anthropic API (enrichment backend)',
    costClass: 'paid',
    category: 'anthropic',
    rateLimit: 'per account',
    onLimit: 'hard-disabled unless WF_ALLOW_PAID_ANTHROPIC=1',
  },
  {
    id: 'ollama-local',
    name: 'Ollama (local inference)',
    costClass: 'free-forever',
    rateLimit: 'local hardware',
    onLimit: 'requests queue locally; no charge possible',
  },
];
