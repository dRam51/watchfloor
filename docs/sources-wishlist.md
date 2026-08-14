# Sources wishlist

Sources we want but cannot reach politely. The project's standing rule is **politeness over
completeness**: RSS and APIs only, `robots.txt` respected, and no scraping ever. A source with
no feed and no API is recorded here rather than reached for anyway.

Each entry states what was actually tried, so a future attempt starts from evidence rather than
repeating the same probes.

---

## Juniper SIRT security advisories

**Status:** blocked — no feed exists.
**Why it matters:** the spec names this a first-class source that should surface regardless of
score, because the owner works with Juniper gear day to day. This is the most significant
coverage gap in the cybersecurity beat.

**Tried:** `supportportal.juniper.net` and `kb.juniper.net` both return the same ~266 KB HTML
document — a JavaScript portal shell, not a feed. No RSS, Atom, or JSON endpoint found.

**Revisit if:** Juniper publishes a feed, or exposes a documented advisory API. Their advisories
also propagate into NVD, so `nvd-cve` filtered by vendor keyword partially covers this — but with
NVD's publication lag rather than SIRT's own timing, and without SIRT's severity framing.

---

## Reuters — both routes blocked

**Status:** unreachable. Dropped from `config/sources.yaml` on 2026-08-14.
**Why it matters:** the spec names AP and Reuters the trust anchors of the US news beat, weighted
highest because wires lead most national stories and editorialize least. Losing Reuters halves that
anchor — AP now carries it alone, via its sitemap.

**Route 1 — direct: blocked.** Reuters' `robots.txt` is an allowlist naming ~60 permitted crawlers,
then closing with:

```
User-agent: *
Allow: /plus/
Disallow: /
```

Watchfloor is not on that list, so every path except `/plus/` is off-limits — including the sitemaps
they declare, since a `Sitemap:` directive does not override a `Disallow:`.

**Route 2 — Google News RSS: also blocked.** The indirect route existed precisely because Google *is*
allowlisted by Reuters, so consuming Google's feed touched no forbidden domain. The **first live run
disproved it**: `news.google.com/robots.txt` opens

```
User-agent: *
Disallow: /
```

Our own gate refused the fetch on the very first cycle — correctly — so the adapter never issued a
single request and the source ingested nothing.

**The process lesson, worth keeping.** Both the adapter build and the config pass reasoned carefully
about *reuters.com*'s `robots.txt` — that was the whole justification for the indirect route — and
**neither checked Google's own**. Permission was verified at the destination and assumed at the
intermediary. Any future indirect route must check every host in the chain, not just the one whose
content is wanted.

**Also rejected:** RSSHub and rss-bridge. Both are self-hostable and free, and both work by scraping.
Pointing one at Reuters produces exactly the requests their `robots.txt` forbids — it only moves the
fetching to our server. The tool does not change the permission.

**The `google_news` adapter stays in the tree**, tested and working, with no source pointed at it —
same treatment as the NWS adapter. If a publisher ever needs that shape and permits it, it is ready.

**Revisit if:** Reuters restores a public feed or adds a general crawler allowance; or a different
intermediary that permits us carries their wire.

---

## SCOTUS slip opinions

**Status:** blocked by `robots.txt` — deliberately, and permanently unless they change it.
**Why it matters:** the M1 plan named this a verified source (`scotus-slip`, usnews beat, hard-override
tier) after confirming `https://www.supremecourt.gov/rss/slipopinion.xml` returns a real, parseable RSS
feed (the plan's own note: "the `/rss/cases.xml` in §4 is a 404" — meaning the *reachability* of the
corrected path was checked). Robots-compliance was not checked at the same time.

**Tried:** fetched `https://www.supremecourt.gov/robots.txt` during Task 11 config work (2026-08-13).
The `User-agent: *` group reads:

```
User-agent:*
Disallow: /images/
Disallow: /rss/
Disallow: /cdn/
Crawl-delay:1
```

`/rss/` is explicitly disallowed for every agent this site doesn't name individually (it names only
`discobot` and `SOTScraper`, both fully blocked, never a "yes" for anyone else). `slipopinion.xml` lives
under `/rss/`, so `src/fetch/robots.ts`'s `isAllowed` — traced through directly, not assumed — returns
`false` for this exact path: the `*` group's only matching rule is the 5-character `Disallow: /rss/`,
there is no competing `Allow`, and `maxDisallowLen (5) <= maxAllowLen (-1)` is false. This is not a
theoretical block; it is what the already-shipped robots gate would actually decide.

**Not configured in `config/sources.yaml`** — matching how Reuters-direct is handled above: no entry,
rather than an `enabled: false` row, since this isn't a technical gap that a future code change closes
on its own. Only the Court changing its own policy would.

**Revisit if:** the Court's `robots.txt` ever drops the `/rss/` disallow, or opens a general crawler
allowance the way AP's does. No indirect route (a Google-News-style redirect, as used for Reuters) was
investigated for this task — that would be new source research, outside Task 11's scope of configuring
the already-verified 22.

---

## NWS Florida alerts (`api.weather.gov`)

**Status:** blocked by `robots.txt` — deliberately, and permanently unless they change it.
**Why it matters:** the M1 plan named this a verified, hard-override-tier source (`nws-fl-alerts`) and
it is fully implemented — `src/adapters/json.ts` has a working mapper, `tests/fixtures/adapters/
nws-fl-alerts.json` is a real, live-captured fixture, and the adapter's own test suite passes. The block
found here is not a parsing or adapter problem; it is a permission problem discovered only during
Task 11's config pass, after the adapter had already shipped.

**Tried:** fetched `https://api.weather.gov/robots.txt` during Task 11 config work (2026-08-13),
confirmed with a verbose request to rule out truncation or a proxy artifact. The complete file is:

```
User-agent: *
Disallow: /
```

No named-agent group, no `Allow` exception anywhere — a blanket disallow of the entire host for every
agent, including ours. Traced through `src/fetch/robots.ts`'s real `isAllowed` logic: the `*` group's
only rule is `Disallow: /` (pattern length 1), no `Allow` rule exists, so every path on this host —
including `/alerts/active?area=FL` — resolves to `false`. This is not specific to the alerts path; the
entire `api.weather.gov` host is off-limits by its own declared policy.

**No alternative host found.** `alerts.weather.gov`, the legacy CAP-alerts subdomain this kind of feed
used to live on, no longer resolves at all (DNS failure, confirmed live) — apparently fully decommissioned
in favor of the unified `api.weather.gov` API, which is the one host that disallows us. `www.weather.gov`
publishes no `robots.txt` of its own (404, i.e. no restrictions *declared* — but it also doesn't appear to
serve the same active-alerts data; it is a forecast/informational site, not the CAP alerts API).

**Not configured in `config/sources.yaml`** — same reasoning as SCOTUS above: this is the site's own
declared policy, not a gap this project's code can close. The finished, tested adapter code
(`parseNwsFlAlertEntry` in `src/adapters/json.ts`) is unaffected and stays in the tree; it simply has no
active source pointed at it until this changes.

**Revisit if:** NWS ever narrows `api.weather.gov`'s `robots.txt` to allow general read access (or adds
a named allowance), or publishes the same CAP alert data through a different, unrestricted host.

---

## `oss-security` mailing list

**Status:** blocked — connection refused during verification.
**Tried:** `https://www.openwall.com/lists/oss-security/rss.xml` returned no response at all
(curl exit with no HTTP status), distinct from a 403 or 404.

**Revisit:** worth retrying — this may have been transient, or may need a different path. The
archive is publicly readable, so a feed likely exists somewhere on the host. Low effort, real
value: `oss-security` often carries disclosure discussion ahead of NVD publication.

---

## Notes on things that are *not* blocked

**AP is reachable**, despite having no RSS. Its `robots.txt` disallows `/*.rss` and
`/api/v2/feed/` for everyone, but it *declares* a news sitemap, which is permitted and carries
title, canonical URL, and publication date for ~585 articles. That is the `ap-news` source.

**GDELT was evaluated and rejected** as a route to AP or Reuters — not on politeness grounds but
on quality. It returns zero articles for an exact-domain AP query, rate-limits to one request per
five seconds, and its default domain filter is substring-based: a first query appeared to find AP
articles that were actually from `kelownacapnews.com`.

**All eight `fix-news-sources-and-kind` candidates (2026-08-14) were permitted and are
configured** — Ars Technica, VentureBeat, Import AI, OpenAI blog (`ai` beat); The Hacker
News, Dark Reading, Rapid7, Cisco Talos (`cyber`+`aisec`). Every one was re-verified live
against the real gate (`src/fetch/robots.ts`'s `fetchRobots`/`isAllowed`, not the old "verified
during M1 planning" claim) and for genuinely fresh, parseable content — full evidence,
robots.txt text, and printed dates in `fix-news-sources-and-kind-report.md`
(`.superpowers/sdd/2026-08-14-m3-api-dashboard/`, gitignored, local-only). Nothing here was
rejected outright; the one URL-level trap below is recorded so a future edit doesn't
reintroduce it.

**`venturebeat.com/category/ai/feed` — a stale URL, not a rejected source.** This looks like
the more precisely-scoped choice for the `ai` beat (VentureBeat's site-wide `/feed/` isn't
topic-restricted), and it 200s with well-formed RSS. Live-verified 2026-08-14 to be frozen
stale, though: served from a Vercel edge cache (`x-vercel-cache: HIT`, `age: 277`) with a
newest entry of `2026-05-19T17:45:00Z` — three months old at verification time — reproduced
on repeated fetches, both with and without the trailing slash. This is the exact trap
`CLAUDE.md`'s "How to add a source" warning names: a 200, real, parseable feed that is not
serving newest-first current content. `venturebeat` is configured against the plain
`https://venturebeat.com/feed/` instead (live-verified fresh, newest entry 23.7h old at
verification time, and — VentureBeat's current editorial focus being what it is — every
sampled title was already AI content with no keyword filtering needed).

---

# Wanted beats — features, not blocked sources

Everything above is a source we tried to reach and could not. This section is different:
things the owner wants **built** once the current milestones are done. Recorded here so the
intent survives, with the groundwork already measured.

## New York sports — a beat of its own

**Status:** wanted, deferred until the core project is finished. Requested 2026-08-14.
**Scope:** New York teams — Yankees, Knicks, Giants — news *and* stats.

**Why this is worth doing properly rather than loosening a filter.** Sports is currently
*noise* in this system: §4 names it a suppression target for US news, `config/interests.yaml`
suppresses it, and the M2 acceptance run found AP sports boilerplate topping the `usnews` beat.
Giving it a dedicated beat converts that from a problem into content — the same items stop
being churn in a national-news lane and become the point of a sports lane. **Nothing should be
un-suppressed from `usnews` to achieve this**; a separate beat is exactly what keeps both lanes
honest.

**What already exists.** AP carries NY sports today and it is already being ingested. Measured
against the 2026-08-14 corpus (4,135 items, one poll cycle):

| team | items |
| --- | --- |
| Yankees | 2 |
| Giants | 2 (one is the *San Francisco* Giants — see below) |
| Rangers | 3 (ambiguous — see below) |
| Liberty | 2 |
| Mets | 1 |
| Knicks | 0 |

Real examples: *"Gilbert pitches Mariners to 1-0 win over Yankees"*, *"Malik Nabers takes a
'big step' forward at Giants training camp"*. So a news half of this beat needs **no new
source** to start — but AP's volume is thin (a handful per cycle, from a rolling ~48h sitemap
window), so dedicated team feeds would be needed for real coverage.

**The hard part, already identified: team names are ambiguous.** In the corpus above,
*"Giants host the Rockies in first of 3-game series"* is the **San Francisco** Giants (MLB)
while *"Malik Nabers … Giants training camp"* is the **New York** Giants (NFL). *"Rangers"* is
Texas (MLB) or New York (NHL) depending on the story. A naive team-name filter will pull in the
wrong city constantly. This is the same taxonomy problem M2 hit when trying to *suppress*
sports, and it does not get easier when the goal is to *select* it — sport and league have to
be part of the match, not just the nickname. AP's URL slugs help (`sabally-liberty-wnba`,
`jacob-degrom-texas-rangers` carry league or city), but they are a heuristic, not a declared
field — AP's sitemap publishes only `title`, `publication_date`, `publication`, `name`, and
`language`, with no `<news:keywords>` or `<news:genres>`.

**Stats are a different problem from news** and should be scoped separately. Scores, standings
and box scores are structured data on a schedule, not articles — they likely want their own
adapter type and their own storage, not `items` rows with a 300-character excerpt. Note also
that §5.1's `item_type` half-lives were designed for filings and essays; a final score is
stale in hours and a season standings table is never quite stale.

**Before building, check:**
- **`robots.txt` on every host in the chain** — the rule that cost us Reuters. League sites
  (`mlb.com`, `nba.com`, `nfl.com`), team sites, and any stats API each need checking
  independently, and an aggregator does not inherit its upstream's permission.
- **The zero-dollar rule.** Several sports-stats APIs are commercial, and a free tier that
  requires a card on file counts as paid (§15). Anything needing a key gets a
  `WF_ALLOW_PAID_*` flag and a `docs/costs.md` entry, or it does not ship.
- **Whether the beat needs a new `Beat` union value** (`src/domain/item.ts`) plus a decay
  half-life entry in `config/decay.yaml`. Note `item_beats` has no CHECK constraint, unlike
  `items.item_type` — so an unknown beat string will insert happily and fail later at decay
  resolution, which is a trap worth closing at the same time.
