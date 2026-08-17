# Watchfloor M8 — Native shells

**Goal (§ brief, M8):** *"Both shells run against the unmodified API with zero shell-specific
endpoints."*

**Scope (§7.3):** Tauri desktop wrapper — global hotkey, native notifications wired to the
hard-override rules, menu-bar item, launch-at-login. Mobile stays on the installed PWA unless it
has been established to be inadequate.

---

## What §7.3 asks for, and what is actually reachable

Checked against config and the live corpus before writing any code, because half of it is blocked
by facts established in earlier milestones.

| §7.3 feature | Status |
| --- | --- |
| Global hotkey to summon the dashboard | **buildable** |
| Launch at login | **buildable** |
| Native notifications for hard-override items | **one of four named triggers reachable** |
| Menu-bar item showing the market ribbon | **no data source exists** |

§7.3 names four notification triggers: *"KEV entries, Juniper SIRT advisories, 8-Ks from held
names, NWS/NHC alerts for my area."* `config/overrides.yaml` has six rules, **two enabled**:

- `cisa-kev-catalog` — **enabled**, 1,665 items in the corpus
- `cve-critical-cvss` — **enabled**, 3,200 items. Not named in §7.3, and it is the same kind of
  claim, so it notifies too.
- `juniper-sirt-advisory` — **disabled**: Juniper publishes no feed (M1, `docs/sources-wishlist.md`)
- `nws-nhc-alerts` — **disabled**: `api.weather.gov` serves a blanket `Disallow: /`
- `8k-held-name`, `earnings-within-5-sessions` — **disabled**: M4b, blocked on `config/portfolio.yaml`

**The owner ruled on 2026-08-17:** install Rust and build it, with the blocked features recorded
as waiting on M4b rather than silently dropped. The menu-bar content was left to this plan; it
shows the **hard-override count** — the same signal the notifications fire on, so the tray and the
notifications tell one story rather than two, and it is the only option whose data certainly
exists today.

---

## DECISION — the shell loads the server's URL. It does not bundle the frontend.

This is the decision everything else follows from, and the alternative is worse in a way that is
not obvious until you trace it.

**Chosen: the Tauri window navigates to the running Watchfloor URL** (`http://127.0.0.1:4173` by
default, overridable for Tailscale). The shell is a window, a hotkey, a tray and a notifier around
the *deployed* web UI.

**Rejected: bundling `web/dist` as Tauri app assets.** It sounds more "native" and it drags in
three problems the brief explicitly does not want:

1. **It breaks the relative-path contract.** `web/src/api/client.ts` calls `/api/...` and every
   environment resolves that against the server's own origin (§7.1's *"the HTTP API is the only
   contract"*). Bundled assets are served from `tauri://localhost`, so every call would resolve
   against the app, not the server, and the frontend would need an absolute-base-URL concept it
   has never needed.
2. **It forces CORS onto the API.** A webview at `tauri://localhost` calling
   `http://100.x.x.x:8787` is cross-origin. Fastify would need `@fastify/cors` and an allowlist —
   a real change to the API, made for the benefit of one client. §7.3: *"if either one needs a new
   endpoint that the web UI doesn't have, that's a signal the API is wrong."* This is that signal
   in a slightly different shape, and the answer is the same: do not.
3. **It creates a second copy of the UI that can drift.** A bundled shell ships whatever
   `web/dist` held at package time. Loading the URL means the shell shows the same bytes the
   browser does, always.

The cost, stated plainly: **the shell needs the server reachable at launch**, and shows a
connection error otherwise. That is not a regression — §7.3 already says *"Both shells assume
Tailscale connectivity"* and *"No offline-first sync, no local database."*

## DECISION — the token never leaves the webview, so polling happens in JavaScript

The obvious way to build notifications is to poll the API from Rust on a timer. **Do not.** It
requires the bearer token to live on the Rust side, which means persisting it somewhere — and the
web UI's whole credential discipline is that the token is held *in memory for this tab only, never
stored* (`web/src/auth/AuthContext.tsx`, and the login screen says so to the reader).

So: **the webview polls, exactly as the dashboard already does, and calls a Tauri command to fire
the native notification.** Rust does OS integration only — notify, hotkey, tray, autostart — and
never sees a credential. §7.3: *"Neither ships credentials beyond the static bearer token."* This
ships none at all.

Consequence worth stating: notifications fire only while the app is running. With launch-at-login
that is "always", and the window can be hidden to the tray while the webview keeps polling.

## The API is not touched

Notifications need "which items are newly pinned". `GET /api/feed?beat=…` already returns
`override.signal.pinned` per item (M3). The tray count is the same query. **Zero new endpoints**,
which is M8's stated deliverable.

---

## Tasks

1. **Scaffold `src-tauri/`** — Cargo manifest, `tauri.conf.json`, icons generated from the
   existing PWA set. Window points at the configured URL.
2. **Global hotkey** — `tauri-plugin-global-shortcut`, toggling show/hide.
3. **Tray item** — hard-override count as the tray title, updated from the webview.
4. **Notifications** — `tauri-plugin-notification`, fired from the webview's poll.
5. **Launch at login** — `tauri-plugin-autostart`.
6. **Frontend integration** — a module that detects it is inside Tauri and enables the extra
   behaviour, and is completely inert in a browser. The web build must not change.
7. **Wiring test** — the occurrence-eleven guard. The shell's integration must be reachable from
   `App.tsx`, and the browser build must not import Tauri APIs at all.

## Mobile — §7.3's "stop at the PWA unless it is genuinely inadequate"

Measured against the production build at 375 px, 2026-08-17:

| check | result |
| --- | --- |
| Layout at phone width | `Stream` (narrow), correctly chosen |
| Horizontal overflow | **none** — `scrollWidth` equals viewport |
| §7.1's 44 px touch targets | **115 interactive elements, 0 below 44 px** |
| Manifest, icons, apple-touch-icon, theme-color | all present |

> [!warning] Offline read is UNVERIFIED, and that is not the same as broken.
> Service workers do not register in the harness browser used for this check: a three-line,
> unambiguously valid worker served 200 from the same origin fails with the identical
> *"unknown error occurred when fetching the script"* as the real one. **The environment cannot
> register any service worker**, so the observation says nothing about `sw.js`.
>
> This control was run specifically because M7 lost a day to a probe that was broken for an
> unrelated reason and was trusted anyway. `web/tests/sw.test.ts` exercises the shipped worker's
> logic in `node:vm`, so the code is tested; what is untested is registration and offline replay
> on a real device.
>
> **Needs one manual check**, and it is the only thing standing between the PWA and a clean
> "adequate": install it on the phone, put the phone in airplane mode, open it, confirm the last
> feed renders.

On the evidence available the PWA is adequate and M8's mobile half is **stop here**, per §7.3.
Capacitor stays unbuilt unless push notifications or background refresh turn out to matter.
