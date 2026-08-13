# External service cost registry

Every external service Watchfloor touches appears here. Adding an integration
without an entry fails review (§15.3). This file is mirrored by
`src/cost/registry.ts`, and a test asserts the two agree.

**Classifications**

- `free-forever` — no account, or an account that cannot be billed.
- `free-tier-no-card` — account required, **no payment method on file**.
- `paid` — can bill. Hard-disabled unless its `WF_ALLOW_PAID_*` flag is set.

A free tier that requires a card on file is a paid service with a $0
introductory price, and is disqualified from the default path.

| id | Service | Class | Flag | Rate limit | At the limit |
| --- | --- | --- | --- | --- | --- |
| `cisa-kev` | CISA KEV catalog | free-forever | — | none published | requests fail; shown on source-health |
| `ollama-local` | Ollama local inference | free-forever | — | local hardware | queues locally; no charge possible |
| `anthropic-api` | Anthropic API (enrichment) | paid | `WF_ALLOW_PAID_ANTHROPIC` | per account | hard-disabled without the flag |

## Before the first paid integration

The zero-flag test in `tests/cost/gate.test.ts` proves only that
`isPaidAllowed()` returns **false when it is called**. It does **not** prove
that no code path can reach a paid service — a client that simply never
consults the gate would sail past it. Today the gap is inert: there are no
paid clients in `src/` at all. It stops being inert the moment one lands.

Before or alongside the first real paid client, ship **one** of:

- **(a)** a check that every module importing a paid-classified client also
  calls the gate before any request; or
- **(b)** an integration test that stubs the network layer and asserts **zero
  requests fire** with the flag unset.

This must not ship without one of the two.

## The complete set of ways this system can spend money

```bash
env | grep WF_ALLOW_PAID
```

Empty output means the system cannot originate a charge.
