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

## Reuters (direct)

**Status:** blocked by `robots.txt` — deliberately, and permanently unless they change it.
**Reached instead via:** Google News RSS scoped to `site:reuters.com`, which never touches their
domain. See the `reuters-gnews` source.

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
