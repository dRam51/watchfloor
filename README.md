# Watchfloor

A single-user, self-hosted situational-awareness dashboard. It polls a fixed set of feeds, scores what comes back against an explicit interest profile, and presents six lanes: **AI news, cybersecurity, AI security, notable GitHub repos, markets, and US national news**.

It is built to read like a terminal rather than a content feed, and to be honest about what it does not know.

```
npm ci && cp .env.example .env    # then edit it
npm run migrate
npm run ingest && npm run score
npm run dev        # API
npm run dev:web    # dashboard at http://localhost:5173
```

Full operational procedures — supervision, backup/restore, troubleshooting — are in **[docs/runbook.md](docs/runbook.md)**.

## What it does

- **Ingests** 28 RSS/Atom/JSON/sitemap sources plus GitHub topic search, on per-source poll intervals, honouring `robots.txt`, ETags, and per-host rate limits.
- **Deduplicates** on canonical URL, then clusters near-duplicates by trigram similarity. Multi-source pickup is itself a relevance signal.
- **Scores** mechanically — source trust, corroboration, interest-term matches — with **recency decay applied at read time, never stored**, so historical ranking stays truthful.
- **Ranks repos by star velocity**, not absolute stars, from daily snapshots. A repo going 40 → 400 in a week matters more than one sitting at 30k.
- **Writes an Obsidian vault**: daily and weekly notes, plus entity notes with managed blocks that leave your own prose untouched.
- **Exposes a read-only MCP server** for a separate trading system — data only, with point-in-time (`asOf`) queries so historical evaluation is not contaminated by lookahead.

## Design commitments

These are load-bearing, not aspirational — each is enforced mechanically and has a test that fails when it is violated.

**Zero dollars by default.** The system is *incapable* of spending money without an explicit `WF_ALLOW_PAID_*` flag. Enrichment runs on local Ollama; the Anthropic backend ships hard-disabled. There is an integration test that traps at the socket layer and asserts **zero requests fire** with the flag unset — written that way because the naive version of that test passed while the client was calling the real API.

**Append-only storage.** `items`, `item_scores`, and `item_clusters` are protected by `raise(ABORT)` triggers. Corrections create a new row with a new `fetched_at`; nothing is updated in place. Point-in-time queries are therefore real rather than approximate.

**Politeness over completeness.** RSS and APIs only. If a source has no feed and no permitted route, it is skipped and recorded in [docs/sources-wishlist.md](docs/sources-wishlist.md) rather than scraped. Reuters and NWS are absent for exactly this reason.

**Portability from the first commit.** Every path is an env var; there are zero absolute paths in the tree; `TZ` is explicit and never read from the system. `npm run check:portability` enforces it.

**The markets beat is a research feed.** Never a trade decision, directional score, sentiment label, price target, or position size. The MCP server refuses to expose any field whose name implies a recommendation, in three independent planes.

**Nothing is deleted.** Obsolete files move to `attic/`. The one job permitted to remove anything is `vault prune`, which is a dry run by default and requires an explicit expected count.

## Stack

Node 26 · `node:sqlite` (WAL, FTS5) · Fastify · Vite + React 19 · vitest. No ORM, no SDKs — the Anthropic and MCP SDKs were both evaluated and rejected on measurement, with the reasoning recorded in the relevant modules.

**3,572 tests across 154 files.** The suite leans on mutation testing: a claim is not considered proven until the defect it guards against has been introduced and the test watched to fail.

## Documentation

| | |
| --- | --- |
| [docs/runbook.md](docs/runbook.md) | install, supervision, backup/restore, troubleshooting |
| [docs/api.md](docs/api.md) | the HTTP contract, verified against live responses |
| [docs/cli.md](docs/cli.md) | `watchfloor` commands and the exit-code contract |
| [docs/costs.md](docs/costs.md) | every external service, classified, with its rate limit |
| [CLAUDE.md](CLAUDE.md) | settled decisions, standing rules, and the mistakes worth not repeating |

## Status

M0–M5 complete; M6 (hardening and portability) in progress. The specification it is built from is private and not in this repository.

Not included here, deliberately: `docs/brief.md` and `config/portfolio.yaml` carry personal financial and employment context. Nothing in the codebase reads either at build or test time, so a clone is unaffected.
