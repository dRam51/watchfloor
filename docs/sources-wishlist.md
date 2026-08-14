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

**Why:** Reuters' `robots.txt` is an allowlist. It names roughly sixty permitted crawlers, then
closes with:

```
User-agent: *
Allow: /plus/
Disallow: /
```

Watchfloor is not on that list, so every path except `/plus/` is off-limits — including the
sitemaps they declare, since a `Sitemap:` directive does not override a `Disallow:`.

**Also rejected:** RSSHub and rss-bridge. Both are self-hostable and free, but both work by
scraping. Pointing one at Reuters produces exactly the requests their `robots.txt` forbids — it
only moves the fetching to our server. The tool does not change the permission.

**Revisit if:** Reuters restores a public feed, or adds a general-purpose crawler allowance.

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
