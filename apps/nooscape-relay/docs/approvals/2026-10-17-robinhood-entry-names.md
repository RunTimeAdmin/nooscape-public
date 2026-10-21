# Decision record: names for the acknowledged Robinhood entries, found by reading the registry for their links

**Decided:** 2026-10-17, by the operator, in chat. The reviewed Robinhood records were named from their registration links ([2026-10-17-robinhood-names.md](./2026-10-17-robinhood-names.md)). The operator was then told that the 8,839 acknowledged Robinhood entries still show "Agent #n", that their links are not stored anywhere, and that naming them needs `tokenURI` calls on the chain, which the Robinhood pass does not make. He answered, about this and one BNB item (which has its own record): "go with this  Naming the 8,839 acknowledged Robinhood entries. It needs tokenURI calls on the chain, which the Robinhood pass doesn’t make today."
**Changes:** extends the Robinhood name step to the acknowledged directory entries; lets that step make one `tokenURI` read on the chain per run, which the source's approval did not cover; changes the wording on `/checker`.
**Does not change:** D1 (no scoring, no tiers, no quality judgments), the reviewed-run publication gate, any tier, which entries are listed, the retained observations and evidence packets, and the BNB entries.

## What the source's approval covered, and what this adds

The Robinhood source was approved for `eth_getLogs` windows on one node (`rpc.mainnet.chain.robinhood.com`). Its pass never calls a per-agent method. This decision adds **one `eth_call` to the same node per run**: Multicall3 `aggregate3`, holding up to 16 `tokenURI(id)` reads of the ERC-8004 identity registry, at the latest block. Multicall3 is deployed on that chain. The read is one attempt with no retry ladder. When the node answers 403 or 429 (its edge throttles bursts and has blocked an address for minutes), chain reads stop for 2 hours; after any other failure, for 30 minutes. Nothing else about the node changes.

## What it does

The step (`server/robinhoodNames.ts`) gets three parts, each cut short when its time or count is up:

1. **Discovery.** For the entries whose name is still the placeholder and that have no recorded link, it reads their `tokenURI` in one batch, newest id first (it began lowest first and was changed the same day: the home page shows the newest registrations in its field reports and the day's catch, and a lowest-first walk of 8,839 entries at 16 a run would have taken about eleven days to reach them; the limits below are unchanged), and records the hash of each link on the entry (`profileUriHash`; the hash of the empty link when there is none or the token reverts). Inline JSON is decoded in place and names the entry without a request. An https address, or an ipfs address with a CID, is queued. An `http` address, another scheme or a link over 512 characters is left alone.
2. **Reading.** The queued links, after the reviewed records' own links, through the same reader and manners as the Solana 8004 name reader and the earlier Robinhood decision. The tries, the spacing and the table are unchanged.
3. **Naming.** A name that was read is written to the entries whose link it came from, only where the name is still the placeholder, cleaned and cut at 120 characters, and the entry's note gets a sentence: "Its name was read from its registration link on <date>; it is the registrant's own claim." A file that several entries share is read once.

## The limits the operator is asked to approve

| | Limit |
|---|---|
| Chain | One `eth_call` of at most 16 reads per run, a run at most every 30 minutes, at the latest block, one attempt. A 403 or 429 pauses chain reads for 2 hours, any other failure for 30 minutes. |
| Files | At most 16 registration files a run, at most 6 of them from one host name, at most 1 request a second to a host, 5 requests at a time in all. |
| Each request | https only, the host's robots.txt first and obeyed, 5 seconds, 256 KiB, 3 redirects with the same checks, the `Nooscape-Checker` user agent. An ipfs link is asked of the configured IPFS gateway, which in production is the one Nooscape runs. |
| Tries | Five at most for a link that does not answer, two for a file with no name in it, and no sooner than 6 hours after the last try. |
| Time | Nothing is started after 20 seconds, and the step starts only on a worker tick that is under 100 seconds old (it began at 40 and was raised the same day, to 60 and then to 100: the BNB rater step took 25 seconds of every tick while its ledger filled, which put the step past 40 on every tick, and the file step of the BNB record ran after it and was past 60). |

(The gate between two runs is 28 minutes, not 30, for the reason given in the BNB registration files record: a step starts at a different time in each tick, and a gate of exactly 30 skipped every other tick. The runs are still one a tick, on ticks at least 30 minutes apart, so no two start closer than 28 minutes.) At a run every 30 minutes that is at most 768 files a day and at most 288 from one host. The constants are in one place (`server/robinhoodNames.ts`), and `/checker` states the last three rows and a test holds the page to them.

**What the sample says about the pace.** A sample of 40 entries (three requests to the node, from the operator's machine) found Multicall3 present and every read answered. 37 of the 40 links were https addresses, 1 was inline JSON, 1 was empty and 1 was another scheme. The 37 sat on 6 hosts, and one host held 25 of them. If that holds for all 8,839 entries, that host's files would take roughly three weeks at the cap, and the others a few days. It takes longer if worker ticks come less often than every 30 minutes.

## A run from the operator's machine

The step itself was run once from the operator's machine against a scratch database holding 16 placeholder entries, capped at 8 files: one multicall to the real node, then the real reader on 8 links. 5 web links gave names, and 3 ipfs links failed because that machine has no Nooscape gateway, which is the expected outcome and left them queued. It was a check of the code on real data and not a pass of the production system. Nothing was kept from it.

## Wording

`/checker` now says that Nooscape-Checker reads the registration link of an agent in the ERC-8004 registry on Robinhood Chain, not only a reviewed one, that for such a registration it first finds the link by reading the registry on the chain, which asks nothing of the site, how many files a run may read and how many from one host, and where the name is shown. `server/checkerPage.test.ts` holds each sentence and number to the code.

## Not decided and not built

- **BNB.** The BNB entries are a separate record.
- **Entries with no link, or a link that is not https or ipfs,** keep "Agent #n". So does an entry whose file has no name or never answers.
- **A name read here can be overwritten.** A later pass that upserts an entry (an operator's observe run over the newest window) rewrites its name and clears its recorded link. The step then finds the link again and names it again, and the file is not read twice because its answer is kept.

## Outcome

- [x] The step, the chain read, the naming and their tests, against a real database and with the real node.
- [x] `/checker` wording and the test that holds it.
- [x] Deployed (#125, 2026-10-17 19:39Z), and the first entries seen named live. The step first ran at 21:00Z that day and named 12 entries (the first names were on one host: "Mesh Gate", "Mesh Trade", "Mesh Trader", "MeshAgent"). It skipped its first hour because its tick limit was 40 seconds (raised in #127). Since #128 it takes the newest ids first, and its run at 01:16Z on 2026-10-18 read 16 links and named 16 entries. It skipped every other tick until #131 (2026-10-18 02:57Z). The pages the home page links to now show real names, and the backlog goes on at the approved pace.
