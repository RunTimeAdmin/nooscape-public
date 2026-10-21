# Public-surface hardening — production record (2026-10-08)

> **Status:** Shipped and live (`7962b85`). The public API is per-client rate limited, request bodies are capped, and every production response carries HSTS plus a strict Content Security Policy whose inline-script hashes are derived from the served HTML. The seed-only AI brief stays public but is hard-bounded by a response cache, a per-client window, and an IP-independent daily LLM budget. This is an implementation record; see [AI handoff](./AI_HANDOFF_2026-10-08.md) for current state.

> **Update 2026-10-14:** the limiter's client key is now Express's `req.ip` (with `trust proxy` at 1), not the leftmost `X-Forwarded-For` entry, and that the Hostinger edge is a single hop is unconfirmed: responses carry `server: hcdn`, so a CDN is in front. `/admin/sources` now shows how the app sees the operator's own request; see [pressure-test-2026-10-14](./pressure-test-2026-10-14.md).

> **Update 2026-10-17 (consulting review):** the AI brief procedure is deleted along with the demo atlas, and the Manus runtime and debug collector are no longer in the build (CI fails if they return), so the policy no longer pins an inline script by hash. The per-client limits are keyed by the network a client is on (an IPv6 client by its /64, a bounded table, an overflow bucket), a tRPC batch is at most 10 procedures, `/.well-known/security.txt` is a route, and `/.well-known/nooscape-keys.json` sends CORS and a cross-origin resource policy so a verifier on another site can read it. See [consulting-review-2026-10-16.md](./consulting-review-2026-10-16.md).

## What shipped

- **Per-client rate limiting** (`server/rateLimit.ts`, mounted in `server/_core/index.ts`): fixed 5-minute windows — 600 requests on `/api/trpc` and 120 on `/manus-storage`. Exceeded requests get HTTP 429 with `Retry-After`. The client key matches the operatorAuth convention (leftmost `X-Forwarded-For`, then the socket address).
- **Bounded AI brief** (`server/routers.ts`): `atlas.summarizeComparison` remains a public procedure but now sits behind a strict 10-per-15-minutes per-client window, an in-memory cache of the seed-only pairs (at most 15 — cached answers never call the model again), and an IP-independent budget of **100 real LLM calls per UTC day**. Invalid (non-seed) agent IDs are rejected before any budget is spent.
- **Request-body caps**: JSON 50 MB → **1 MB**; urlencoded 50 MB → **100 KB**. The storage proxy is GET-only (presigned redirects) and the largest known body is a 256 KB evidence packet, so no legitimate flow is affected.
- **Security headers** (`server/_core/securityHeaders.ts`): `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, HSTS `max-age=31536000` (production only; `includeSubDomains` deliberately omitted until every `nooscape.si` subdomain is confirmed HTTPS-only), and `x-powered-by` disabled. `app.set("trust proxy", 1)` reflects the single Hostinger edge hop.

## Content Security Policy design

The served `index.html` embeds the ~367 KB Manus runtime as an inline script (injected by `vite-plugin-manus-runtime`), so the policy pins it by SHA-256 hash instead of allowing `'unsafe-inline'`:

- Inline-script hashes are computed **at server startup from the file being served** (`dist/public/index.html`), so they stay correct across every rebuild and CDN pass-through — there are no hand-maintained hashes.
- External script and stylesheet origins are parsed from the same HTML (Google Fonts stylesheet + gstatic fonts today).
- `style-src` keeps `'unsafe-inline'` (runtime overlay canvas and style attributes); script execution stays hash-pinned.
- If the HTML cannot be read, the server logs an error and serves without a CSP rather than breaking the site — availability-first fail-open for a read-mostly public surface.

Served policy:

```
default-src 'self'; script-src 'self' 'sha256-…'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; object-src 'none';
base-uri 'self'; form-action 'self'; frame-ancestors 'none'; worker-src 'self'
```

> **Superseded in part on 2026-10-18:** the two typefaces are now served from the site, so `style-src` and `font-src` name no Google host (`style-src 'self' 'unsafe-inline'`, `font-src 'self'`); see [self-hosted-fonts-2026-10-18](./self-hosted-fonts-2026-10-18.md). The rest of the policy above is as it was.

## Production verification (2026-10-08, after the `7962b85` deploy)

- Live headers: no `X-Powered-By`; HSTS, nosniff, X-Frame-Options, Referrer-Policy, Permissions-Policy, and the full CSP are present (the CDN's own `upgrade-insecure-requests` policy composes with ours). `/.well-known/nooscape-keys.json` and `/developers` return 200.
- The CSP hash matches a SHA-256 of the inline runtime in the **live-served HTML byte-for-byte** (nearly 367 KB unpinned would have failed loudly; no CDN rewriting observed).
- Browser run (home / developers / context): **zero CSP violations**, Google fonts load, tRPC polling returns 200s, no 429s during normal browsing.
- Local production-mode smoke (before deploy): a 2 MB body → **413**; the 601st `/api/trpc` request → **429** (exactly at the 600 limit); the same CSP hash cross-check passed.
- The AI brief click reaches the endpoint under the new policy (POST is not CSP-blocked and not rate limited); production currently answers with the graceful configuration error described below.

## Observations (out of scope, deliberately unfixed)

- **The AI brief has never been functional in production.** The endpoint responds `OPENAI_API_KEY is not configured` (HTTP 500) because the Manus LLM proxy key (`ENV.forgeApiKey`, `server/_core/llm.ts`) was never configured on Hostinger; the client surfaces it as “AI brief unavailable”. The new bounds apply the moment a key is configured — enabling it is an explicit operator cost decision, not a code change.
- The umami analytics tag ships with unresolved `%VITE_ANALYTICS_ENDPOINT%` / `%VITE_ANALYTICS_WEBSITE_ID%` placeholders and 400s on every page load; wiring analytics requires setting the build-time Vite variables.
- Rate-limit keys trust the leftmost `X-Forwarded-For` entry, so a non-browser client that forges the header can rotate buckets. This is acceptable while the LLM path is additionally bounded by the IP-independent daily budget; revisit if the public surface grows.
- Limiter state is per-process and in-memory (single node today); it resets on deploy or restart.

## Tests

- `server/rateLimit.test.ts` — window semantics, key isolation, retry math, key derivation.
- `server/securityHeaders.test.ts` — inline-script hash pinning, external-origin parsing, placeholder/relative-URL skipping, baseline directives.
- Suite: **15 files / 55 tests** — 54 pass locally; the crawler availability boundary test requires the production MySQL and fails environmentally on a machine without one.

## Rollback

Revert `7962b85` and push: the relay returns to the previous header/limit behavior immediately. No schema, data, or operator-flow change is involved — the hardening is code-only and stateless apart from in-memory counters.

## Addendum 2026-10-13: directory aggregate cache

The 2026-10-12 review's "uncached public query cost" item was triaged because every route sat behind the
per-client rate limit. With the directory at about 240k rows that was no longer enough: the homepage polls five
aggregate endpoints every 20 seconds per visitor, each a full-table count, and measured latency was 3.6 to 4.4 s
for the funnel, about 2 s for the breakdown, about 1.7 s for the wallet census, and about 1.5 s each for the total
and the activity feed (single-record reads stay near 0.3 s).

`server/readCache.ts` is a small in-process cache with request coalescing. It is applied inside the eight heavy
directory aggregates in `server/db.ts` (`countAgentDirectoryEntries`, `breakdownAgentDirectoryByProtocol`,
`listAgentDirectoryWallets`, `readAgentDirectoryFunnelCounts`, `countAgentDirectoryRegistrants`,
`readAgentDirectoryActivityTotals`, `readAgentDirectoryActivityFeed`, `readAgentDirectoryActivityDaySeries`),
with the same exported signatures.

- **Fresh for 30 seconds, then reloaded.** Concurrent callers share one load, so a burst after expiry costs one
  scan. Tunable with `NOOSCAPE_DIRECTORY_CACHE_TTL_MS`; `0` turns caching off.
- **Failures are never cached or served stale.** The router's fail-closed handling behaves exactly as before.
- **Writes invalidate.** Directory upserts and closure markers, both activity-ledger writes, operator hide and
  unhide, and source decisions (the directory counts only active sources) drop the cache, and a load that was
  already in flight when a write ran is discarded. A hide or a pause is therefore visible on the very next read.
- **Not cached, deliberately:** the reviewed census (`publicRecords`, `publicCoverage`) and everything behind the
  reviewed-run gate, including the funnel's reviewed and domain-proven counts. A withdrawal must take effect
  immediately.
- **Per process.** A second instance (a deploy overlap, or the standalone `pnpm worker:tick`) is at most the TTL
  stale.

Tests: `server/readCache.test.ts` (nine unit cases) and `server/directoryCache.test.ts` (five cases against a real
MySQL: reads are served from cache, and upserts, hide and unhide, and source pause and resume each show on the next
read). Disabling the cache, or removing one invalidation, fails them.

**Superseded in part, 2026-10-14.** Failures are still never cached, the reviewed census is still not cached, and a
hide or a pause is still visible on the very next read. But the TTL is now 5 minutes instead of 30 seconds, a value is
reloaded in the background 30 seconds before it expires so no visitor waits for the reload, the aggregates are built
at boot and again after a burst of writes, and an ingestion write (directory upserts and closure markers, both
activity ledgers) now marks the cache stale instead of dropping it, so a new row shows once a background reload lands,
about 10 seconds later, rather than on the next read. Only an operator's write (hide, unhide, a source decision)
still drops it. See "Public read cost" in [worker-operations.md](./worker-operations.md) for why.

## Addendum 2026-10-13: the analytics tag is wired

The umami tag in `client/index.html` is now the real one (`https://cloud.umami.is/script.js` with the site's
website id), replacing the unresolved `%VITE_ANALYTICS_ENDPOINT%` and `%VITE_ANALYTICS_WEBSITE_ID%` placeholders
that returned a 400 on every page load. Two consequences:

- **The CSP needed one more origin.** The cloud script posts its beacon to `https://gateway.umami.is/api/send`
  (its `data-host-url` is unset), not to the origin it was loaded from. The policy is derived from the built HTML and
  put only the script's own origin in `connect-src`, so the script would have loaded and every beacon would have
  been silently dropped. `buildCspFromHtml` now maps the cloud script origin to its gateway
  (`SCRIPT_COLLECTOR_ORIGINS` in `server/_core/securityHeaders.ts`). No other origin is added, and `script-src`
  still names only the script host.
- **The strip plugin is gone.** `vitePluginConditionalAnalytics` existed to remove the tag when the placeholder was
  unresolved. With a literal tag it could never match, so it was removed from `vite.config.ts`.

What it measures: browser visits (pages, referrers, rough audience). It does not measure agent or API traffic, which
never runs the script, and ad blockers will undercount it. The tag carries `data-domains="nooscape.si,www.nooscape.si"`
(`www` is the only published subdomain), so the tracker records only those hostnames: local previews, mirrors, and
any other host send nothing. That was checked by running the real tracker script in a sandbox on four hostnames,
with and without the attribute (without it, all four sent a beacon). The tag sends page URL, referrer, screen size,
and language to umami; there is no site copy about that yet.

Tests: `server/indexHtml.test.ts` reads the real `client/index.html` (exactly one umami tag with the website id, no
`%VITE_` placeholder anywhere, and a derived policy that lets the script load and its beacon out), and
`server/securityHeaders.test.ts` covers the gateway mapping and that no other origin gains it. Removing the mapping,
restoring a placeholder, changing the website id, and dropping the `data-domains` filter each fail a test.
