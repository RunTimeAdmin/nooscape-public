# Safe fetch (2026-10-15)

> **Status:** Built, tested and reviewed; nothing calls it yet. It is the shared function the [informational-use decision](./approvals/2026-10-15-informational-use-and-bnb-map.md) requires before any check runs. No migration, no route, no change to anything a visitor sees. The first check, the second cron job and the page the user agent names are separate steps (see "Before the first check runs").

## Why it is separate from the older fetches

The hosts a check contacts are chosen by whoever registered the agent. The older fetches (the ingestion adapters, domain verification, the Solana registration pass) talk to names the operator approved, and [fetch-boundary-hardening](./fetch-boundary-hardening-2026-10-08.md) accepted one residual for them: the address is checked, and then the connection looks the name up again. For names anyone can pick, that gap is not acceptable, so this function connects only to the addresses it checked. The older fetches are unchanged.

## What exists

| File | What it does |
|---|---|
| `server/safeFetch.ts` | One request, or one redirect chain, under every rule below. Never throws. |
| `server/robots.ts` | robots.txt read as RFC 9309 says, for the one visitor `Nooscape-Checker`, with a cache per host. |
| `server/politeFetch.ts` | The manners for a run: at most 5 at once, a second between two requests to one host, a budget of requests, robots.txt first. |

## The rules, and where each is enforced

| Rule (from the decision record) | How |
|---|---|
| https only, no userinfo, no port | `parseTarget`: any other scheme, a user name or password, or a port other than the default is refused before DNS is asked. |
| A name that could be public | Two or more labels of letters, digits, hyphens and underscores, at most 253 characters, so no single label, no bracketed IPv6 literal, no empty label. No IP literal in any spelling (the URL parser turns `2130706433` and `0x7f.1` into dotted form first), nothing under `localhost`, `.local` or `.internal`. |
| The host resolved first and every address checked | The name is resolved once per hop, by asking the name servers for A and AAAA records, and **every** answer goes through `isForbiddenIp` (`netGuard.ts`). One forbidden answer refuses the host; a mixed answer is not filtered down to its public part. |
| The connection made to the address that was checked | A custom `lookup` hands the socket only the checked addresses, whatever Node asks for. There is no pool (`agent: false`), no keep-alive, and a new connection for every request. TLS still names the host and the certificate must be valid for it; there is no way to turn that off. |
| Redirects: limit of three, same checks at every hop | 301, 302, 303, 307 and 308 are followed by hand. Each hop starts again from the URL checks, so a hop to http, to a port, to a bad name or to a bad address ends the fetch. A redirect with no usable `Location`, or one longer than a URL may be, ends it too. |
| 5 second timeout | One deadline for the whole chain: DNS, every hop, every body. It can be made shorter and not longer. |
| 4 KiB body cap | The body is read through a byte cap and cut there. The result says `truncated` and carries the SHA-256 of the bytes kept. A HEAD answer and the body of a redirect are not read. A caller can raise the cap to 256 KiB and no higher. |
| A `Nooscape-Checker` user agent that names a page | `Nooscape-Checker/1.0 (+https://nooscape.si/checker)`. The page is `/checker` (see "The page" below). |
| A refusal for any host that has opted out | `robots.ts`: a `Disallow` for `Nooscape-Checker`, `Nooscape` or `*` ends the fetch with `robots_disallowed`. A robots.txt that answered badly (a 5xx, a 429, too long, sent to something that is not a robots.txt) ends it with `robots_unavailable`, and one that could not be fetched because the host did not answer ends it with the host's own reason (`timeout`, `connection_failed`, `tls_failed`, `response_invalid`, `unresolvable`). |
| At most 5 at once, 1 a second per host, a budget per run | `politeFetch.ts`. Each hop of a redirect is a request of its own, so it spends budget, waits its turn at its host and has its host's robots.txt read. The robots.txt request counts as well. |
| Errors logged, never failing the tick | `safeFetch` and `politeFetch.fetch` never throw. A failure is a result with a reason. |

Also true, and not in the list:

- No cookie or credential is ever sent, a `Set-Cookie` header is never kept, the request asks for no compression, only GET and HEAD are ever sent, response headers are capped at 16 KiB, and an error from the network layer is reduced to its code (`ECONNREFUSED`). A result never names an address a refused name resolved to, and no message from the network reaches it (the `address` of an answered request is the public one the connection was made to).
- **DNS does not use `dns.lookup`.** That call runs on the four-thread pool the rest of the server shares (files, crypto, compression), and a name whose DNS never answers would hold a thread until the system resolver gave up. Four such names at once would hold the whole pool, and the rest of the server's file and crypto work would wait behind them. The resolver used here asks the name servers directly and gives up on its own.
- **Certificate checking is stated, not assumed.** `rejectUnauthorized: true` is set on every request, because `NODE_TLS_REJECT_UNAUTHORIZED=0` in the environment switches checking off for a request that leaves it out. A test sets that variable and shows the request still fails.
- **Time is kept by a clock that cannot be set back** (`performance.now()`), so a step of the system clock cannot stretch a deadline or a pause.
- **A number that is not a number is not a limit.** Every numeric option falls back to its default when it is NaN or Infinity (what a missing setting becomes after `Number(...)`), and is held to its ceiling: 5 seconds, 3 redirects, 256 KiB of body, 5 fetches at once, a minute between requests to one host, 1,000 requests for a run.
- **robots.txt rules are not regular expressions.** A pattern comes from a host we do not control and is matched against a path we do not control. The first version built a regular expression from it, and `Disallow: /a*a*a*a*b$` against a 2,000 character path did not finish. The match is now done by looking for each part between the stars once, in order, and a test compares it with the old regular-expression reading on 20,000 seeded random cases for the same answers. Percent-escapes are compared as one spelling, so `/%70rivate` does not get past `Disallow: /private`. A 429 answer for robots.txt counts as unreadable (a host asking to be asked less is not given leave). A Crawl-delay or Sitemap line between two User-agent lines does not split the group.
- **A robots.txt can be sent to another host's robots.txt and to nothing else,** once at most. Whatever else it was sent to has not been asked whether visitors like this one are welcome there, so a host cannot be used to aim a check at a path.
- **What is remembered about robots.txt is bounded.** Only the groups that can apply to this visitor are kept. A file with more than 1,000 rules for it, or more than 32 KiB of patterns (counted after percent-escapes are written out, because a character outside ASCII becomes nine), is treated like one longer than the 64 KiB that are read: unreadable, so nothing is asked of that host. A gate remembers at most 1,000 hosts. That is roughly 100 KB for a host at the very worst, so about 100 MB for a gate that has filled all 1,000 and about 20 MB for a run (200 hosts).

## What a result says

`ok: true` means the host answered, with any status. A 404 or a 500 is an answer and a fact. It carries `status`, `headers` (lower case, first value, cut at 1 KiB), `body`, `truncated`, `bodySha256`, `address` (the one the connection was made to), `tlsProtocol`, `redirects` and `latencyMs`.

`ok: false` carries a `reason`, a short `detail`, the URL it stopped at, the redirects followed and `latencyMs`.

| Reason | Meaning |
|---|---|
| `invalid_url`, `not_https`, `credentials_in_url`, `port_not_allowed`, `forbidden_host` | The URL was refused before anything was asked of anyone. |
| `unresolvable`, `forbidden_address` | DNS had no answer, or at least one answer was not public address space. |
| `redirect_invalid`, `too_many_redirects` | A redirect with no usable `Location` (or one that is too long, or a robots.txt sent somewhere that is not a robots.txt), or more than three. |
| `timeout`, `connection_failed`, `tls_failed`, `response_invalid` | The host did not answer in time, refused or dropped the connection, failed the certificate check, or sent something that is not HTTP. |
| `robots_disallowed`, `robots_unavailable` | The host asks automated visitors to stay away, or its robots.txt answered badly. A robots.txt that could not be fetched because the host did not answer gives the host's own reason above, not this one. |
| `budget_exhausted` | The run has used its requests. Nothing was sent. Once a run is spent no new name is looked up; fetches already under way when it ran out may have looked one up. |

A failure is a fact about one request on one day. The agent page shows one as a fact with its date and says the checker is retrying; only three asks in a row without an answer read as "failing", which says nothing about why ([agent-checks-2026-10-16](agent-checks-2026-10-16.md), "Display rules"). Never a verdict.

## Using it

```ts
import { createPoliteFetcher } from "./politeFetch";

const polite = createPoliteFetcher({ budget: 150 }); // one for each run
const result = await polite.fetch(endpointUrl, { method: "HEAD" });
if (result.ok) record({ status: result.status, latencyMs: result.latencyMs });
else record({ reason: result.reason, detail: result.detail });
```

`createPoliteFetcher` takes `concurrency` (5, and never more), `perHostGapMs` (1000, a minute at most), `budget` (200, 1,000 at most) and `robots` (on). Turn `robots` off only where the host has given its leave, never for a third party. `safeFetch` alone (no robots.txt, no pacing) is for a caller that supplies its own manners; the checks should use the polite fetcher.

## Limits to know

- **The order of a run is the caller's to get right.** The budget is a cap on a run, and registrations are permissionless, so anyone can register enough agents at fresh names to use a run up. The function cannot tell them from honest ones. The checks should take the agents that were checked longest ago first, so a run spent on junk delays the honest ones and cannot starve them, and should deal URLs out across hosts (one from each in turn).
- **A wait for a host's turn holds one of the 5 places.** A run that queues forty URLs on one host in a row keeps the places busy for forty seconds while other hosts wait.
- **Pacing is by host name, not by address.** Many names on one address (a platform with a subdomain for each agent) are each paced separately, so such a platform can be asked up to 5 at once. The budget bounds a run. If the checks meet a large template fleet, pace by address as well.
- **The robots.txt cache lives in the fetcher.** One fetcher for each run means each run reads each host's robots.txt again, and that costs budget. Sharing one gate across runs is a decision for the checks endpoint.
- **The name servers are read once, when the server starts.** That is the price of asking them directly and not through the system. A change to the host's resolver settings is seen at the next restart, which every deploy is.
- **Without happy eyeballs only the first address is tried.** Node 22 asks the lookup for all the addresses and tries them in turn, and nothing in the app turns that off. If it were turned off, only the first address (an IPv4 one when the name has one) would be tried and the rest ignored. That fails closed.
- **The address guard (`netGuard.ts`) was not changed on 15 October, and was on 27 October.** It did not refuse the three IPv4 documentation blocks (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`), the retired 6to4 relay block, the IPv6 discard prefix `100::/64`, `::ffff:0:0:0/96` (IPv4-translated), and a few reserved IPv6 blocks. None is a public host, and the reviewer found that none of them reaches loopback, link-local or private space on Linux. It was left alone because `clientAddress.ts` uses the same function and its test treated `203.0.113.9` as a public visitor; adding the ranges meant changing that fixture too. An outside review raised the same gap on 27 October ([outside-security-review-2026-10-27](./outside-security-review-2026-10-27.md)), the fixture now uses two real public addresses, and the guard refuses every block the IANA special-purpose registry marks as not globally reachable. Still not refused: `::ffff:0:0:0/96`, which the registry no longer lists, and unallocated IPv6 space outside the registry's rows (the guard is a deny list, not a rule that only `2000::/3` is public).
- **HTTP/1.1 over TLS only,** no proxy, no HTTP/2, no client certificate, nothing read from the response beyond the status, the headers and the capped body.
- **Nothing is stored or logged here.** The function returns facts; what is written, and where, is the caller's.

## Before the first check runs

1. The page the user agent names exists (`/checker`, see below). Its status line said no request had been made yet; stage 2 of the checks replaced it ([agent-checks-2026-10-16](./agent-checks-2026-10-16.md)).
2. The checks endpoint, its migration and the second cron job (todo 78 b). The ingestion tick is at capacity, so checks do not run in it.
3. The public copy that said Nooscape fetches nothing changed in stage 2, where it stopped being true (the About line, the sources page). The BNB card and the registry signals stay, because the checks are not asked of those sources.
4. Done 2026-10-16, on the operator's say: `registrationFetch.ts`, the Solana 8004 name fetch, moved onto this function. It had hundreds of https registration links to read (its own header counted about 410), with no identifying user agent (Node's default), no robots.txt check, a 1 MiB cap, and a connection that was not pinned (it said so itself). See "The 8004 name fetch" below.

## The page (`/checker`)

`client/src/pages/Checker.tsx`, built 2026-10-16: who is asking, what it asks for, how gently, what it records, how to make it stop, and who to write to. It is a page of the app (a route in `App.tsx` and in the server's route list, and an entry in the sitemap) with no read, form or script of its own, so it cannot fail while the server is busy. Until stage 2 its status line said that Nooscape-Checker had not made a request to any host yet. It now says what it asks for and how often, and the wording on the page is held to the checks by `server/checkerPage.test.ts`.

`server/checkerPage.test.ts` holds each number on the page to the constant that enforces it (5 seconds, 4 KiB, 64 KiB for robots.txt, 3 redirects, one request a second, five at a time, the user agent string), runs the opt-out the page shows through the same robots.txt reader the checker uses, and keeps the page free of the word "score", of long dashes, and of anything that reads or sends data. Each test was also run with its claim broken, to see that it fails.

What the page promises, and where each promise is kept, is the table in [agent-checks-2026-10-16](./agent-checks-2026-10-16.md). In short:

- A check asks for one endpoint address that the card of a reviewed agent declares (and where it redirects to), apart from robots.txt. The page names no profile link and no `/.well-known/` path, because no check asks one yet; the check that does has to change the page and its test first.
- It follows no link found in what it reads, and runs nothing it reads.
- It records the date, whether the address answered after any redirects, the status code, how long it took, the reason when there was no answer or a rule stopped the ask, and a fingerprint of the first 4 KiB. The page lists nothing else, and shows neither the reason nor the fingerprint.
- What it records is shown on the agent's page with its date (the Checks section).
- It never changes a tier, whether an agent is listed, its order or its place on the map. A failure is not a verdict.
- A change to a host's robots.txt is picked up the next time it would ask the site, and a robots.txt that keeps it out removes the earlier check from the agent's page.

The contact on the page is the site's own account (`@Nooscape` on X, the one named in the page's `twitter:site` tag). There is no email address on the page because none has been decided; adding one is the operator's call.

The page is not linked from the menu or the footer. It is the address the user agent names, and it is in the sitemap so a search for the name finds it. The server sends the app's ordinary shell for it (the page sets its own title once it runs), so a client that runs no script sees the home page's opening text and not this page. If that matters, the server can write this page's head the way it does for `/catch`.

## The 8004 name fetch (moved onto the safe fetch 2026-10-16)

`server/ingestion/registrationFetch.ts`, the registration-name reader of the Solana 8004 pass, used to make its own requests. It checked each address once, with a lookup of its own, and then connected by name, so the connection was not pinned to the address that was checked (a name could answer differently the second time). It read no robots.txt, sent Node's default user agent, and gave up after 10 seconds and 1 MiB. The operator called that a security fix and asked for it to be moved (2026-10-16).

It now asks through the polite fetcher, one for each pass, like the checks: https only, the connection pinned, redirects by hand (three at most) with the same checks at each hop, robots.txt read first and obeyed, a second between two requests to one host, and the `Nooscape-Checker` user agent. `ipfs://` links still go through the configured gateway (`NOOSCAPE_IPFS_GATEWAY`, `https://ipfs.io/ipfs/` by default, whose robots.txt allows everything). The queue (at most 30 a pass), the retry rules (five tries if the link does not answer, two if the file has no name) and what a name may change (only a placeholder name) are as they were.

What the move costs, and what to watch:

- **The deadline is 5 seconds and the read is 256 KiB, not 10 seconds and 1 MiB.** Those are the safe fetch's own limits. A registration file over 256 KiB, or a gateway that takes longer than 5 seconds for a file it has not cached, now fails the try (the gateway usually has the file cached for the next one). If the share of names that resolve falls, look here first: `SELECT status, COUNT(*) FROM agent_registration_resolutions GROUP BY status;` before and after the deploy shows it.
- **A pass is slower by up to a second for each name that shares a host with the one before it.** A queue of ipfs links is all one host, so a full queue of 30 adds up to about 30 seconds. The tick is at capacity, so the run's time is the thing to watch.
- **A host that keeps the checker out in robots.txt is not read.** Its entries keep the placeholder name, and the try is recorded as `failed` with the reason `robots_disallowed: ...`.
- **The stored reason changed shape.** It is `<reason>: <detail>` from the safe fetch (`timeout: ...`, `forbidden_address: ...`) where the old one said `net guard: ...`. An HTTP status is still `HTTP 503`.
- **`/checker` says all of this.** The page now describes the second job (the name read), the 256 KiB read and the tries, and `server/checkerPage.test.ts` holds those numbers to the constants.

**The ipfs gateway (decided 2026-10-16).** Production set no `NOOSCAPE_IPFS_GATEWAY`, so ipfs links went to `https://ipfs.io/ipfs/<cid>`. On 2026-10-16 that gateway answered **HTTP 429 with `retry-after: 900`** ("This IPFS gateway is switching to a service worker gateway only") to every request that was not a browser, whatever the user agent (Node's default and `Nooscape-Checker` alike), and to a browser user agent it answered a Cloudflare challenge. `dweb.link`, `w3s.link` and `nftstorage.link` did the same. The old reader sent the same kind of request, and the table agreed: 435 ipfs links tried, all HTTP 429, none resolved. The gateways that did answer a server (`ipfs.filebase.io`, `4everland.io`, `gateway.pinata.cloud`) are commercial, answered some CIDs and not others, and Pinata is slow (3 to 6 seconds) and refuses robots.txt without a key, which the polite fetcher reads as "ask nothing". The operator chose a gateway Nooscape runs: Rainbow on a VPS behind nginx at `ipfs.nooscape.si`, reached through a secret path prefix, with `NOOSCAPE_IPFS_GATEWAY` pointing at it. What runs, what it was measured to cost and how to set it up again are in [ipfs-gateway-2026-10-16](ipfs-gateway-2026-10-16.md). A link with no CID in it (`ipfs://placeholder/NN`) is no longer asked of anyone.

Tests: `registrationFetch.test.ts` drives the reader with the safe fetch's own answers (every status, a byte-order mark, a truncated body, every way the fetch can refuse, a fetcher that throws), runs the three refusals that happen before any lookup (http, a password in the link, a local name) through the real fetch, and reads the module to fail on any request that is not the polite fetcher's.

## Independent review (2026-10-15)

After the first version was built, a separate read-only security reviewer went through the three modules and reproduced each finding against the real code on Node 22 with a real TLS server. Its findings, and what changed:

1. **A body that crossed the cap in the read that ended the message crashed the process.** `done` ran twice, once at the cap and once from the `'end'` Node had already queued, and the second SHA-256 digest threw `ERR_CRYPTO_HASH_FINALIZED` outside any handler. The checks would run inside the web process, so the first ordinary page over 4 KiB, or an oversized robots.txt, would have taken the site down. Fixed: `done` returns if the request has already finished. The first tests missed it because the fake stopped emitting once the connection was dropped, and the real-server test sent its body in many small chunks. There is now a test of each shape (a fake that still emits `'end'`, and a real server that ends the message with the chunk that crosses the cap), and both fail without the fix.
2. **A robots.txt could send the fetch anywhere.** The robots request followed redirects to any host and path, and nothing read the destination's robots.txt, so a registrant could aim a request at a path a third party had disallowed. A robots.txt may now be redirected only to another robots.txt, without a query, and once at most.
3. **One fetch could spend 20 requests of the run's budget** (four hops, each host's robots.txt following three redirects). The rule above and a single redirect for a robots.txt bring the worst case to 12 (four hops, each with a robots.txt that may itself move once). The rest is the order of the run (see the limits).
4. **A Crawl-delay or Sitemap line between two User-agent lines split the group and failed open.** RFC 9309 says other records must not end a group. Fixed.
5. **A number that was not a number removed a bound.** See "Also true".
6. **A refused name's result named the address it resolved to.** It no longer does.
7. Smaller: a run with nothing left now does no DNS work for the rest of its list; a Location longer than a URL is refused before it is resolved, because dot segments could bring a cut-short one back under the limit; and the robots cache is bounded.

It also checked and found nothing wrong with: the pinning (Node 22 calls the lookup once with `all: true` and tries only what it returns, so a rebinding answer cannot steer the socket), IP literals in every spelling it tried, mixed public and private answers, CNAME chains, redirects to relative, scheme-relative and backslash targets, the deadline (a slow body, a host that never answers, 20 KiB of headers, an endless stream of 1xx responses), sockets and timers left behind, header and request injection, the hand-over of places in the concurrency limit (200 randomized rounds, never above the limit), and what a result can leak (apart from item 6). It confirmed that the regex-free matcher agrees with the old one on 300,000 random cases and that percent-escape comparison closes four bypasses the first version had (`/%61dmin`, `/priv%61te/x`, a raw `/café`, and `%2f` against `%2F`). Not verified: Node 20, which is not installed here.

A second pass over the fixes found nothing that blocks shipping and verified items 1 and 2 on the real code (20 of 20 crash runs now clean, and seven non-robots redirect targets refused). It also found four things that are now fixed: the memory figure was wrong, because percent-escaping turns a three-byte character into nine characters, so a limit on rules did not bound memory (the limit is now on pattern characters too); a pause between requests of 2^31 ms or more removed the pause, because `setTimeout` fires such a timer at once (the gap is held to a minute, the budget to 1,000); the robots.txt redirect rule had been described as removing most of the cost multiplier on one fetch, but it left a worst case of 16 requests (now 12, with a single redirect); and two sentences in this document claimed more than the code does.

## Tests

- `safeFetch.test.ts`: the network replaced by a table. The URL and name refusals, the DNS refusals (every forbidden class, a mixed answer, a rebinding answer), what the socket is allowed to connect to, every redirect rule (a Location too long to be a URL included), the body cap and hash (and the end of a message arriving in the read that crossed it), the deadline and the clock it is kept by, the options and their ceilings, the error classes, that nothing throws, and that the default resolver is not `dns.lookup`.
- `safeFetch.network.test.ts`: a real TLS server on loopback, with certificates made at run time by `openssl` and never kept (the suite skips where openssl is missing). It reaches a name no DNS can resolve, which proves the connection goes only to the pinned address, and shows that with the real resolver the same name is `unresolvable`. It also covers an untrusted certificate (also with `NODE_TLS_REJECT_UNAUTHORIZED=0` set), a certificate for another name, redirects and a redirect loop, HEAD, the body cap, a body that ends with the chunk that crosses it, a slow body, a dropped connection and a closed port.
- `robots.test.ts`: group choice, the longest-match rule, `*` and `$`, line endings, percent-escapes, other records between User-agent lines, the cache and what an unreadable file means, the limit on rules, a hostile pattern that must not make the match slow, and the 20,000-case comparison with the old reading.
- `politeFetch.test.ts`: the concurrency limit, per-host spacing (asserted as the times requests are made, with fake timers), the budget (including that a spent run starts no new lookups), the options, and robots.txt through redirects, including a robots.txt that tries to send the fetch to another path.

Each test added for a review finding was also run with its fix taken out, to see that it fails.

## Run once against real hosts (2026-10-15)

By hand, outside the test suite, with the real resolver and the real sockets: `example.com` and `github.com` answered (a GET, and a HEAD) over TLS 1.3 from the address the connection was pinned to; `http://` was refused; `wrong.host.badssl.com`, `expired.badssl.com` and `self-signed.badssl.com` failed as `tls_failed` with the certificate error as the detail (the test site timed out on the first try for one and reset the connection for another, then answered as expected on the second); a redirect chain of two was followed and a chain of four stopped at three; a name that does not exist was `unresolvable`; and `localtest.me`, `10.0.0.1.nip.io` and `169.254.169.254.nip.io` (public names that resolve to loopback, a private address and the cloud metadata address) were each refused as `forbidden_address` before anything connected. A polite fetcher run (500 ms gap) over four URLs on three hosts spent 7 requests (the four pages and three robots.txt files), took 1.1 seconds, which is the two gaps the three requests to `example.com` need, and cut two large pages at 4 KiB.

## Rollback

Nothing calls these modules. Revert the change and nothing else moves.
