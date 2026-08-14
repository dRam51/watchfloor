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
    // M4a: the repos beat. The ONLY entry in this registry whose class is
    // free-tier-no-card rather than free-forever, and the distinction is
    // exact: holding a PAT requires a GitHub account, so it is not
    // "free-forever" (an account that cannot be billed). It is still
    // permitted by default — no payment method is required, and a GitHub
    // account with no billing details on file has nothing to charge.
    //
    // The unauthenticated path needs no account at all and is the default:
    // WF_GITHUB_TOKEN is optional, and src/fetch/github.ts works without it.
    // The token buys rate limit, never capability that costs money.
    id: 'github-api',
    name: 'GitHub REST API (repos beat)',
    costClass: 'free-tier-no-card',
    rateLimit:
      'unauthenticated (default): 60 core req/hour, 10 search req/min. With a read-only PAT: 5,000 core req/hour, 30 search req/min',
    onLimit:
      'requests refused with 403/429; the client stops sending before overdrawing and shows it on source-health. This API has no paid tier to fall through to',
  },
  {
    id: 'ollama-local',
    name: 'Ollama (local inference)',
    costClass: 'free-forever',
    rateLimit: 'local hardware',
    onLimit: 'requests queue locally; no charge possible',
  },
];
