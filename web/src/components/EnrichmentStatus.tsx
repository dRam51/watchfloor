import './EnrichmentStatus.css';

/**
 * §15's third clause, on screen (M5 task 14):
 *
 *   "Flag absent = the code path is hard-disabled: the scheduler skips the
 *   job, the API returns a clear 'disabled by cost policy' status, and **the
 *   dashboard shows the feature as off**."
 *
 * M5 task 2 built a backend that *reports* `disabled_by_cost_policy` and
 * proved that no request escapes it. Nothing rendered it, so §15 was only
 * partly discharged. This is the rendering.
 *
 * ## The design problem, which is not a layout problem
 *
 * A paid path being off is the **shipped, chosen, permanent** state of this
 * system — the M5 plan's RULING 2 has the owner running Ollama deliberately
 * and Anthropic shipping hard-disabled. So this must read as *"this is how
 * you set it up"*, never as *"something is broken"*. A dashboard that puts a
 * permanent, correct condition in the colour reserved for failures teaches
 * its only operator to ignore that colour, which costs exactly when it
 * matters.
 *
 * Three facts, three lines, three vocabularies, and the whole component is
 * arranged so that no two of them can be confused:
 *
 * | fact | line | how it reads |
 * | --- | --- | --- |
 * | which backend runs, and may it | `.enrichment__backend` | plain, secondary |
 * | each paid path's flag | `.enrichment__paid` | dim — configuration |
 * | today's spend | `.enrichment__spend` | plain figure, or "unknown" |
 * | can the backend be reached | `.enrichment__reach` | ERROR when it cannot |
 *
 * Only the last one may be loud. `--color-error` and not `--color-alert`, on
 * the same reasoning global.css records for the failing-source badge: alert
 * is a watchfloor *signal* (a KEV pin), whereas a daemon that will not answer
 * is a genuine fault.
 *
 * The one exception is a **configured backend that is itself disabled**: the
 * paid path is off *and* it is the one enrichment was told to use, so nothing
 * is being enriched at all. That gets `--color-alert` — attention, not
 * failure, because it is still a configuration statement with a one-line
 * remedy.
 *
 * ## What it does not do
 *
 * It does not compute. Every judgement here — which backend, which state,
 * reachable or not — is made server-side by `getEnrichmentStatus`
 * (src/domain/headerStrip.ts) and arrives decided, per §7.1's "no business
 * logic in the frontend". This file chooses words and classes.
 */

// ---------------------------------------------------------------------------
// The wire shape -- GET /api/dashboard/header
// ---------------------------------------------------------------------------

export interface PaidPathData {
  category: string;
  /** The exact `WF_ALLOW_PAID_*` variable. Naming it is the whole remedy. */
  flag: string;
  state: 'enabled' | 'disabled_by_cost_policy';
  /** True when `config/llm.yaml` selects a backend that spends against it. */
  selected: boolean;
}

export interface ConfiguredBackendData {
  name: string;
  model: string | null;
  serviceId: string;
  costClass: string;
  spendCategory: string | null;
  state: 'enabled' | 'disabled_by_cost_policy';
}

export interface ReachabilityData {
  status: 'reachable' | 'unreachable' | 'unknown';
  day: string | null;
  attempts: number;
  reached: number;
  unreached: number;
  costPolicyRefusals: number;
  /**
   * The last attempt's unavailable reason, decided server-side. Non-null with
   * `status: 'reachable'` is a real pairing -- `model_missing` means the
   * daemon answered and lacks the model.
   */
  reason: string | null;
  detail: string;
}

/** `enrichment` on the header response. */
export interface EnrichmentStatusData {
  backend: ConfiguredBackendData | null;
  paidPaths: PaidPathData[];
  reachability: ReachabilityData;
  asOf: string;
  note: string;
}

/** `enrichmentSpend` on the header response — unchanged since M3. */
export interface EnrichmentSpendData {
  amountUsd: number | null;
  measured: boolean;
  asOf: string;
  note: string;
}

export interface EnrichmentStatusProps {
  status: EnrichmentStatusData | null;
  spend: EnrichmentSpendData | null;
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

const REACH_LABEL: Record<ReachabilityData['status'], string> = {
  // "reached" rather than "healthy": it is a statement about the last attempt,
  // which is all the ledger can honestly support.
  reachable: 'reached',
  unreachable: 'NOT REACHABLE',
  // Never "ok". A day with no enrichment call is ordinary on the vault
  // cadence, and ordinary is not the same as well.
  unknown: 'not tried today',
};

function formatSpend(spend: EnrichmentSpendData): string {
  // `measured: false` means UNKNOWN, never zero -- printing $0.00 there would
  // be a placeholder masquerading as a measurement, which is the exact thing
  // the field was shaped to avoid.
  if (!spend.measured || spend.amountUsd === null) return 'unknown';
  return `$${spend.amountUsd.toFixed(2)}`;
}

export function EnrichmentStatus({ status, spend }: EnrichmentStatusProps) {
  // An absent response is not a report of "off". Rendering a cost-policy
  // claim from data that has not arrived is how a loading state becomes an
  // assertion about money.
  if (status === null) return null;

  const { backend, reachability } = status;
  const backendDisabled = backend !== null && backend.state === 'disabled_by_cost_policy';

  return (
    <section className="enrichment" aria-label="enrichment status">
      <p
        className={`enrichment__line enrichment__backend${
          backendDisabled ? ' enrichment__backend--disabled' : ''
        }`}
        // The server's own sentence, in full. The line is short by design; the
        // reasoning behind it should still be one hover away.
        title={status.note}
      >
        <span className="enrichment__label">enrichment</span>{' '}
        {backend === null ? (
          <span className="enrichment__value">backend not reported</span>
        ) : (
          <>
            <span className="enrichment__value">
              {backend.name}
              {backend.model === null ? '' : `/${backend.model}`}
            </span>{' '}
            <span className="enrichment__meta">{backend.costClass}</span>
            {backendDisabled && (
              <>
                {' '}
                <span className="enrichment__flagword">disabled by cost policy</span>
              </>
            )}
          </>
        )}
      </p>

      {status.paidPaths.map((path) => (
        <p
          key={path.category}
          className={`enrichment__line enrichment__paid enrichment__paid--${
            path.state === 'enabled' ? 'on' : 'off'
          }`}
        >
          <span className="enrichment__label">paid: {path.category}</span>{' '}
          <span className="enrichment__value">{path.state === 'enabled' ? 'on' : 'off'}</span>{' '}
          <span className="enrichment__meta">
            {path.state === 'enabled'
              ? `${path.flag} is set`
              : `${path.flag} unset, by cost policy`}
            {path.selected ? ' · this is the configured backend' : ''}
          </span>
        </p>
      ))}

      {spend !== null && (
        <p
          className={`enrichment__line enrichment__spend enrichment__spend--${
            spend.measured ? 'measured' : 'unmeasured'
          }`}
          title={spend.note}
        >
          <span className="enrichment__label">spend today</span>{' '}
          <span className="enrichment__value">{formatSpend(spend)}</span>{' '}
          <span className="enrichment__meta">{spend.measured ? 'measured' : 'unmeasured'}</span>
        </p>
      )}

      <p
        className={`enrichment__line enrichment__reach enrichment__reach--${reachability.status}`}
        title={reachability.detail}
      >
        <span className="enrichment__label">backend</span>{' '}
        <span className="enrichment__value">{REACH_LABEL[reachability.status]}</span>{' '}
        {/* The REASON, on the line rather than in the tooltip. An operator
            reading "NOT REACHABLE" needs to know whether to start the daemon
            (`not_running`) or pull a model (`model_missing`) -- those are
            different actions, and the seam keeps them apart precisely so the
            wrong one is not taken. */}
        {reachability.reason !== null && (
          <>
            <span className="enrichment__reason">{reachability.reason}</span>{' '}
          </>
        )}
        <span className="enrichment__meta">
          {reachability.day === null
            ? 'no day to measure over'
            : `${reachability.reached}/${reachability.attempts} attempt(s) reached on ${reachability.day}`}
        </span>
      </p>
    </section>
  );
}
