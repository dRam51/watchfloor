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
| `cisa-advisories` | CISA Cybersecurity Advisories RSS | free-forever | — | none published; web-served feed | requests fail; shown on source-health |
| `nvd-cve` | NVD CVE Database (API 2.0) | free-forever | — | 5 req/30s unauthenticated (no API key used) | requests fail; shown on source-health |
| `krebs` | Krebs on Security RSS | free-forever | — | none published; web-served feed | requests fail; shown on source-health |
| `bleepingcomputer` | BleepingComputer RSS | free-forever | — | none published; `Crawl-delay: 1` honored via politeFetch's per-host spacing | requests fail; shown on source-health |
| `project-zero` | Google Project Zero feed | free-forever | — | none published; web-served feed | requests fail; shown on source-health |
| `arxiv-cs-cr` | arXiv cs.CR RSS | free-forever | — | none published; web-served feed | requests fail; shown on source-health |
| `arxiv-cs-ai` | arXiv cs.AI RSS | free-forever | — | none published; web-served feed | requests fail; shown on source-health |
| `owasp-genai` | OWASP GenAI Security Project RSS | free-forever | — | none published | requests fail; shown on source-health |
| `simonwillison` | Simon Willison's Weblog (Atom) | free-forever | — | none published; web-served feed | requests fail; shown on source-health |
| `latent-space` | Latent Space RSS (Substack-hosted) | free-forever | — | none published; web-served feed | requests fail; shown on source-health |
| `deepmind-blog` | Google DeepMind Blog RSS | free-forever | — | none published | requests fail; shown on source-health |
| `huggingface-blog` | Hugging Face Blog RSS | free-forever | — | none published | requests fail; shown on source-health |
| `hn-algolia` | Hacker News Search API (Algolia) | free-forever | — | none formally published for this public endpoint | requests fail; shown on source-health |
| `ap-news` | AP News sitemap | free-forever | — | none published; declared in AP's own `robots.txt` | requests fail; shown on source-health |
| `reuters-gnews` | Google News RSS (search endpoint) | free-forever | — | none published for this public endpoint | requests fail; shown on source-health |
| `npr-news` | NPR News RSS | free-forever | — | none published; web-served feed | requests fail; shown on source-health |
| `pbs-newshour` | PBS NewsHour RSS | free-forever | — | none published; web-served feed | requests fail; shown on source-health |
| `federal-register` | Federal Register API | free-forever | — | none published (public GSA-style API) | requests fail; shown on source-health |
| `whitehouse-actions` | White House Presidential Actions RSS | free-forever | — | none published; web-served feed | requests fail; shown on source-health |
| `ars-technica-ai` | Ars Technica — AI category RSS | free-forever | — | none published; web-served feed | requests fail; shown on source-health |
| `venturebeat` | VentureBeat RSS | free-forever | — | none published; web-served feed | requests fail; shown on source-health |
| `import-ai` | Import AI (Jack Clark, Substack) RSS | free-forever | — | none published; web-served feed | requests fail; shown on source-health |
| `openai-blog` | OpenAI Blog RSS | free-forever | — | none published; web-served feed | requests fail; shown on source-health |
| `the-hacker-news` | The Hacker News RSS (via feeds.feedburner.com) | free-forever | — | none published; web-served feed | requests fail; shown on source-health |
| `dark-reading` | Dark Reading RSS | free-forever | — | none published; web-served feed | requests fail; shown on source-health |
| `rapid7` | Rapid7 Blog RSS | free-forever | — | none published; web-served feed | requests fail; shown on source-health |
| `cisco-talos` | Cisco Talos Intelligence Blog RSS | free-forever | — | none published; web-served feed | requests fail; shown on source-health |
| `github-api` | GitHub REST API (repos beat) | free-tier-no-card | — | unauthenticated (default): 60 core req/hour, 10 search req/min. With a read-only PAT: 5,000 core req/hour, 30 search req/min | requests refused with 403/429; client stops before overdrawing; shown on source-health |
| `ollama-local` | Ollama local inference | free-forever | — | local hardware | queues locally; no charge possible |
| `anthropic-api` | Anthropic API (enrichment) | paid | `WF_ALLOW_PAID_ANTHROPIC` | per account | hard-disabled without the flag |

> [!note] `ollama-local` stopped being speculative at M5 task 1 — there is now a client
> The row above predates any code that used it. `src/enrich/llm/ollama.ts` is that code, and
> it is deliberately the one outbound client in the tree that **does not call
> `src/cost/gate.ts`** — §15: *"Ollama, being local, needs no flag."* A gate call there would
> imply a `WF_ALLOW_PAID_OLLAMA` spend category, and adding one to `SPEND_CATEGORIES` for a
> service that cannot bill would weaken the meaning of every other flag. A test greps that
> module for `isPaidAllowed` / `assertPaidAllowed` / `WF_ALLOW_PAID` and fails if any appears.
>
> It still reports a cost on every call: `computeCost` (`src/enrich/llm/types.ts`) runs one
> arithmetic path for every backend, and Ollama simply has zero rates. The consequence is
> worth stating because it is not obvious — **a free-forever backend's spend stays `measured:
> true` even when its token counts are unknown**, since zero times unknown is zero, whereas a
> billable backend with uncounted tokens must report `amountUsd: null` / unmeasured. That is
> the same distinction `enrichmentSpend` already publishes on `/api/dashboard/header`.
>
> The daemon's address is `config/llm.yaml`'s `base_url`, defaulting to loopback. Pointing it
> at a host you do not own would change this row's classification; nothing in the code does.

> [!note] `github-api` is the first and only `free-tier-no-card` entry, and the class is exact
> Every other row is `free-forever`. GitHub differs because holding a personal access token
> requires a GitHub **account** — so it is not "an account that cannot be billed" — while
> requiring **no payment method**, which is what keeps it out of `paid` and therefore
> permitted by default with no `WF_ALLOW_PAID_*` flag.
>
> **The default path needs no account at all.** `WF_GITHUB_TOKEN` is optional and
> `src/fetch/github.ts` has a real unauthenticated mode, which is what runs when it is unset.
> The PAT buys rate limit and nothing else: ~83x the core budget (60/hour → 5,000/hour). It
> unlocks no capability that costs money, because there is no paid tier on this API to fall
> through to — at the limit GitHub refuses requests, and the client refuses to send before
> even that. A read-only token is what §4 asks for; a classic token needs **no scopes ticked
> at all** to read public repository data, and `repo` must not be granted.
>
> Two rate-limit facts worth keeping here rather than only in code, both measured live
> 2026-08-14 against the real API: **`core` and `search` are separate budgets** with separate
> ceilings, and **a 304 still consumed budget** on the unauthenticated path despite GitHub
> documenting conditional requests as exempt. Any future budget arithmetic that treats a
> revalidation as free will overrun the 60/hour ceiling.

None of the 27 sources above require an account, an API key, or a card on file — every
one is a public, unauthenticated RSS/Atom/JSON/sitemap endpoint. Some may be
`enabled: false` in `config/sources.yaml` at any given time (check that file rather than
this one — the two drift); they are registered here regardless, since the zero-dollar rule
is about what the system is *capable* of touching, not only what is currently enabled.

**The eight `fix-news-sources-and-kind` additions (2026-08-14)** are the same class as
everything above: public RSS, no account, no key. `the-hacker-news` is configured directly
against `feeds.feedburner.com` (FeedBurner, a Google-operated feed-hosting service) rather
than `thehackernews.com` — this is the publisher's own sanctioned distribution path
(`thehackernews.com/feeds/posts/default` 302-redirects there by design), not a paid or
authenticated relationship with Google; feeds.feedburner.com serves the content
unauthenticated, same as every other entry in this table.

> [!important] NVD's rate limit is load-bearing on a constant in the adapter
> The `5 req/30s` figure above is not just documentation. `NVD_MAX_PAGES_PER_POLL` in
> `src/adapters/json.ts` is set to **equal, not exceed**, that number — it bounds the total
> requests one poll makes, including the total-discovery probe. **If the figure above is
> ever corrected, that constant must move with it**, and vice versa. They are two copies of
> one fact, in different files, with nothing mechanical keeping them in sync.
>
> This is the whole of NVD's unauthenticated allowance. NVD publishes a higher limit for
> API-key holders, which this project does not use — a key is free but requires registering
> an account, and the zero-dollar rule's standard is what the system is capable of, not what
> it currently spends. Raising the page budget by obtaining a key is a decision to make
> deliberately, not a tuning knob.
No per-host rate limit above is a number this project invented — where a source
publishes one (NVD), it's quoted from that source; everywhere else, "none published"
means exactly that: no formal limit is declared, so the only throttling in effect is
this project's own politeness layer (`politeFetch`'s 2s/host minimum spacing and each
source's configured `poll_interval`), not a server-side quota we could exhaust into a
bill — there is no billing relationship with any of these hosts at all.

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
