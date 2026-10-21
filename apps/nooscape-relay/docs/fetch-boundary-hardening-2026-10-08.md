# Fetch-boundary hardening — production record (2026-10-08)

> **Status:** Shipped (`d85a131`) and live. The private-address guard that protects every approved fetch — the four ingestion adapters and domain-control verification — now lives in one fail-closed module (`server/netGuard.ts`). Its IPv6 check parses every textual form (dotted or hex IPv4-mapped, link-local `fe80::/10`, site-local, multicast, NAT64, 6to4, Teredo, documentation) instead of matching a few string prefixes, and unparseable input is rejected. No public record, contract, or tier is affected.

## What was wrong

- The guard existed as two byte-identical copies (`server/ingestion/a2a.ts`, `server/domainVerification.ts`) — any fix had to land twice or the copies would drift.
- Its IPv6 check was a list of string prefixes: exact `::` / `::1`, `fc` / `fd` (which did cover `fc00::/7`), a literal `fe80:` (missing the rest of `fe80::/10` — `fe81::`–`febf::`), and dotted-only `::ffff:` mappings for just four ranges (`127.`, `10.`, `192.168.`, `169.254.`).
- Therefore an approved source whose DNS answer used a **hex IPv4-mapped** form passed the check: `::ffff:a9fe:a9fe` (169.254.169.254, the cloud metadata IP), `::ffff:ac10:1` (172.16.0.1), `::ffff:7f00:1` (127.0.0.1), `::ffff:c0a8:101` (192.168.1.1). The dotted forms of `172.16–31`, `100.64–127`, and `0.x` were equally unchecked.
- Also uncontested: multicast `ff02::`, site-local `fec0::/10`, NAT64 `64:ff9b::`, 6to4 `2002::`, Teredo `2001:0::`, and IPv4-compatible `::a00:1`. The IPv4 check lacked `192.0.0.0/24` and `198.18.0.0/15`.
- All five fetch sites resolve DNS first and re-check at fetch time, so this guard is the load-bearing SSRF control for the boundary; a bypassing answer steered a fetch into private or metadata space while every other bound (HTTPS-only, `redirect: "error"`, timeout, size cap) stayed satisfied.

## Design: one shared address-guard module

- **`server/netGuard.ts`** is now the single copy of the policy: `isForbiddenIpv4` (this network, private, CGNAT, loopback, link-local incl. the metadata range, `192.0.0.0/24`, `198.18.0.0/15`, multicast/reserved), `isForbiddenIp` for both families, and `isClearlyUnsafeHostname`.
- The IPv6 path parses any textual form — compressed `::`, dotted or hex IPv4 embeddings — into eight groups and decides by bitmask, so `fe80::/10`, `fc00::/7`, `fec0::/10`, multicast, both NAT64 blocks, 6to4, Teredo, documentation space, IPv4-compatible, and all IPv4-mapped forms are covered; unparseable input fails closed (treated as forbidden).
- **Call sites unchanged:** `a2a.ts` `assertPublicHostname` and `domainVerification.ts` keep their exact error classes, messages, and ordering; they now import the shared predicates, so the three adapters that import `assertPublicHostname` from `a2a.ts` (`agenstry`, `agenteconomy`, `metaplex`) are covered automatically.
- **Rejected alternatives:** connect-time DNS pinning via an `undici` dispatcher (undici is not a runtime dependency; adding one for this is disproportionate) and rewriting the fetch path around `node:https` with a custom `lookup` (large churn; would break the fetch-mocking test harness). The check-then-connect window remains an accepted residual, bounded by operator-approved hostnames, HTTPS-only, short timeouts, and `redirect: "error"`.
- **Documented, not deleted:** the unused template services (`_core/voiceTranscription.ts`, `imageGeneration.ts`, `dataApi.ts`, `map.ts`) carry similar fetch patterns but have zero importers; if ever wired they must route through `netGuard`. The `llm` and `notification` fetches target env-configured trusted endpoints, outside this boundary.

## Tests and gates

- `server/netGuard.test.ts` — 5 cases: forbidden IPv4 classes incl. `192.0.0.0/24` and `198.18.0.0/15`; routable IPv4 incl. boundary neighbors (`100.63.255.255` / `100.128.0.1`, `172.15` / `172.32`); every IPv6 bypass form above; allowed IPv6; fail-closed non-address input plus unsafe-hostname rejection (trailing dot included).
- `pnpm check` clean; `pnpm build` clean; suite **18 files / 71 tests** — 70 pass locally; the crawler availability boundary test requires production MySQL and fails environmentally only.

## Production verification (2026-10-08, after the `d85a131` deploy)

- Site healthy after deploy: root 200 with CSP + HSTS and no `X-Powered-By`.
- `liveData.publicRecords` matches the trust-surface baseline exactly — 58 records, 58 `untrustedSummary`, zero old `summary` fields, zero version-like capabilities (41 null), 57 tier_2 + 1 tier_3; the Nooscape Observatory stays `tier_3` with publisher state `unverified`. Server-side-only change: no public record, contract, or tier moves.
- All approved live sources resolve to public addresses, so no legitimate fetch is affected; the guard only rejects the private/metadata answer classes it previously missed.

## Rollback

Revert `d85a131` and push. Fetch behavior returns to the duplicated prefix-string guards; every call site, error, and message is otherwise unchanged.
