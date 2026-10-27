# Decision record: names for the Base and Arc entries, read from the files their registration links name

**Decided:** 2026-10-26, by the operator, in chat. After a look at what the other ERC-8004 explorers show that Nooscape does not, the operator was told that an entry on Base or Arc whose link is a web address or an ipfs address is called "Agent #n" (8004scan shows "Clawdia" for Base #2290, which Nooscape calls "Agent #2290"), that Base and Arc names come only from JSON held inside the link, and that naming the rest means reading the link from the chain and then the file it names, as the Robinhood name step does. He answered "1 then 2 then 5", where 1 was this.
**Changes:** adds a name step for Base and Arc; lets it make one `tokenURI` read on each chain's own node per turn, which neither source's approval covered; changes the wording on `/checker` and on the sources page.
**Does not change:** D1 (no scoring, no tiers, no quality judgments), which registrations are listed, any tier, the retained observations and evidence packets, the registry rows, and Robinhood Chain and BNB Chain.

## What the sources' approvals covered, and what this adds

The Base and Arc sources were approved for `eth_getLogs` windows on one node each (Alchemy's Base host, and the operator's own Arc node). The pass never calls a per-agent method, and it never opens a link. This decision adds, for each chain, **one `eth_call` per turn to the same node**: Multicall3 `aggregate3`, holding up to 16 `tokenURI(id)` reads of the ERC-8004 identity registry, at the `finalized` block (the block the pass reads up to). Multicall3 is deployed on both chains (checked on 2026-10-26: the real read returned links on Base, and Arc holds 3,808 bytes of code at its address). The read is one attempt with no retry ladder, checked as the pass checks its own reads (the endpoint variable names the host the source row records, and the host is a public one). When the node answers 403 or 429, or says it is busy, chain reads for that chain stop for 2 hours; after any other failure, for 30 minutes. The registry rows keep the SHA-256 of a link and not the link, so the chain is the only place the link can be had.

It also adds reads of the files the links name, on other people's hosts, which is the same thing the Robinhood, Solana 8004 and SAID name reads already do.

## What it does

The step (`server/chainNames.ts`) takes one chain a run, Base and Arc in turn (a chain with nothing to ask leaves the run to the other), in three parts:

1. **Healing.** An entry that shows the placeholder, whose link already has a name that was read, gets that name at once, with no request. The listing makes an entry again from its registry row when a registration leaves the listing and comes back, and the row carries the placeholder.
2. **Discovery.** For up to 16 entries that show the placeholder and that no earlier run has looked at, newest id first, it reads `tokenURI` from the chain. The link counts only when its hash is the one the registry row recorded, so a name comes from the very link the entry was listed from. A web link, or an ipfs link with a CID in it, is queued. A link that holds its own JSON with a name in it (set after the registration, so the pass did not name the entry from it) gives that name at once, with no request. Anything else, a token that reverts, and a link that is not the recorded one, is recorded as settled so it is not read from the chain again; a link the pass has since updated is found again once the row records it.
3. **Reading and naming.** The queued links, newest first, through the same reader and manners as the Robinhood and SAID name reads. A name that was read is written to the entry it came from, only where the name is still the placeholder, cleaned and cut at 120 characters, and the entry's note gets a sentence: "Its name was read from its registration link on <date>; it is the registrant's own claim." A name that is only a number (the listing rules hold such a registration out) or that reads "Agent #n" is not taken, and the file is recorded as one with no name.

Nothing is kept from a file but its name. The tries are kept in `agent_registration_resolutions`, the table the other name reads use, so there is no migration, no new source and no new setting.

## The limits the operator is asked to approve

| | Limit |
|---|---|
| Chain | One `eth_call` of at most 16 reads per run, on one chain, a run at most every 30 minutes, at the finalized block, one attempt. A 403, a 429 or a busy answer pauses that chain's reads for 2 hours, any other failure for 30 minutes. |
| Files | At most 16 registration files a run (both chains together), at most 6 of them from one host name, at most 1 request a second to a host, 5 requests at a time in all. |
| Each request | https only, the host's robots.txt first and obeyed, 5 seconds, 256 KiB, 3 redirects with the same checks, the `Nooscape-Checker` user agent. An ipfs link is asked of the configured IPFS gateway, which in production is the one Nooscape runs. |
| Tries | Five at most for a link that does not answer, two for a file with no name in it, and no sooner than 6 hours after the last try. |
| Time | Nothing is started after 20 seconds, and the step starts only on a worker tick that is under 100 seconds old. The gate between two runs is 28 minutes (`server/stepInterval.ts`). |

The pace is the Robinhood name step's, taken from its constants, so it cannot drift from it. At a run every 30 minutes that is at most 768 files a day, the two chains together. `/checker` states these limits and a test holds the page to them.

**What the sample says about the pace.** On 2026-10-26 the live API listed at least 1,000 Base entries that show the placeholder (its search stops counting at 1,000) out of 9,087 listed, and 309 of Arc's 352. The Arc entries checked that show the placeholder carry ipfs links. At the approved pace, with both chains waiting, Arc takes about a day and Base the days after it: if Base has about 8,000 placeholders that is about eleven more days, longer if worker ticks come less often than every 30 minutes, and longer for the files that need a second try. Newest entries are taken first, which is the order the home page shows them in.

## A check on live data

The reader and the file step were run from the operator's machine on 2026-10-26 against the real chains, with nothing written to any database.

- **The chain read.** Multicall3 answered on Base (a public node) and on Arc (the operator's node) with a link for all 25 ids asked, 15 on Base and 10 on Arc.
- **The recorded link.** For the tokens whose events could be read, the link `tokenURI` gave was the latest link in the registry's own events (a registration, and any later update): 4 of 4 on Base, 6 of 6 on Arc. Five of the six on Arc were registered with another link and updated to their ipfs link afterwards, which is why the step compares with the link the registry row holds (the pass applies updates to the row) and not with the registration alone.
- **Web files.** Ten Base links on https gave six names ("DEUSPROOF", "Grok Crypto Quant API", "NEMO x402 Micro-Services", "something_agent / StillCurrent", "Cleave for Agents", "Flow"); four were not read because of the site: one answered its robots.txt with a 530, one timed out, one disallows automated visitors, and one could not be reached for its robots.txt. Two Arc links on one host gave "XFUN" and "EVE", and one file had no name.
- **ipfs files.** That machine has no Nooscape gateway, and `ipfs.io` answers 429 to everything that is not a browser (`docs/ipfs-gateway-2026-10-16.md`). Through a public gateway, Base #2290 gave "Clawdia", the name 8004scan shows for it; three other links timed out in 5 seconds. The gateway Nooscape runs answered 25 of 25 test links within 2 seconds on 2026-10-16, so ipfs reads should do better in production than here.

## Wording

`/checker` now says that Nooscape-Checker reads the registration link of an agent on Base or Arc as well, that it first finds the link by reading the registry on the chain, that the Base and Arc names take the two chains in turn and keep the Robinhood pace, and where the name is shown. The sources page says the same of an active Base or Arc source. `server/checkerPage.test.ts` holds each sentence and number to the code.

## Chosen by Claude, so the operator can say no

- **Names only.** Not the description, the image, the service endpoints or any other field of a file. Showing more would need the owner-text rules the claims use.
- **The Robinhood pace,** and one chain a run, so the shared worker tick gains at most one more step of at most 20 seconds, and only on the ticks the interval allows.
- **Newest first,** for the discovery and the reading.
- **The link must be the recorded one.** A token whose link is not the one the registry row holds is settled and not named until the pass records the new link.
- **No new switch.** The chain's own switch (`chain_base`, `chain_arc`) and an active source decide. Pausing a source stops its names along with its pass.

## Not decided and not built

- **BNB Chain.** Its listed entries show "Agent #n" too, but its file step keeps no name by an earlier decision. Adding names there is a change to that decision.
- **Ethereum.** It joined this step on 2026-10-27 (see the addendum at the end).
- **Held-out registrations,** which have no entry and so no name.
- **Anything but the name** (see above).
- **A check of the name against anything.** A name is whatever the file says, so an entry can call itself after a known project. The note says it is the registrant's own claim, as on the other chains, and the name changes nothing about the entry's tier, whether it is listed, or its place on the map. Search by name will now find these names, which makes this more visible than it was with "Agent #n".

## How to watch it, and how to undo it

A run that did anything writes one `nooscape_chain_names` line to the runtime log, and a failure one `nooscape_chain_names_failed` line. Progress, read-only:

```sql
SELECT protocol, COUNT(*) AS still_nameless FROM agent_directory_entries WHERE protocol IN ('erc8004_base', 'erc8004_arc', 'erc8004_eth') AND displayName REGEXP '^Agent #[0-9]+$' GROUP BY protocol;
SELECT s.protocol, r.uriKind, r.status, COUNT(*) AS links FROM agent_registration_resolutions r JOIN ingestion_sources s ON s.id = r.sourceId WHERE s.protocol IN ('erc8004_base', 'erc8004_arc', 'erc8004_eth') GROUP BY s.protocol, r.uriKind, r.status;
```

To stop it without a deploy, pause the chain's source. To undo it, revert the change, then put the placeholders back and clear the reads:

```sql
UPDATE agent_directory_entries
SET sourceSignalNote = REGEXP_REPLACE(sourceSignalNote, ' Its name was read from its registration link on [0-9]{4}-[0-9]{2}-[0-9]{2}; it is the registrant''s own claim[.]', ''),
    displayName = CONCAT('Agent #', SUBSTRING_INDEX(externalKey, ':', -1))
WHERE protocol IN ('erc8004_base', 'erc8004_arc', 'erc8004_eth') AND sourceSignalNote LIKE '% Its name was read from its registration link on %';
DELETE FROM agent_registration_resolutions WHERE sourceId IN (SELECT id FROM ingestion_sources WHERE protocol IN ('erc8004_base', 'erc8004_arc', 'erc8004_eth'));
```

An entry that was named at registration, from JSON inside its link, has no such sentence in its note and is not touched. An entry named from JSON set after its registration has the sentence and goes back to "Agent #n", which is what it showed before.

## Outcome

- [x] The step, the chain read, the naming and their tests, against a real database (MySQL 8.4 and MariaDB 10.11) and with the real nodes.
- [x] `/checker` and sources-page wording, and the test that holds them.
- [x] Merged and deployed (PR 212, main 9f42a01, 2026-10-26 23:57Z, `verify-live` 44 of 44), and the first entries seen named live: by 00:29Z the first run had named five Base entries (for example #1135673, now "DEUSPROOF"), each with the dated sentence in its note.
- [ ] Arc's placeholders (309 at the last count) and the rest of Base's backlog worked through: about a day for Arc, about eleven more for Base.

## Addendum, 2026-10-27: Ethereum joins the step

**Decided:** 2026-10-27, by the operator, in chat ("5 is ethereum", the last of "1 then 2 then 5"). This record's list of what was not built said Ethereum would join when its switch went on.
**Changes:** Ethereum is added to the chains the step takes in turn, third after Base and Arc, and the words on `/checker` and the sources page that name the chains now name it. Nothing in the table of limits above changes: the same sixteen reads a run, six to a host, a run every thirty minutes at most, one attempt at the chain, the same pauses. No migration, no new source and no new setting. The chain's switch (`chain_ethereum`) and an active source decide, as they do for the other two.
**Does not change:** which registrations are listed, any tier, BNB Chain and Robinhood Chain.

**Checked against the real chain on 2026-10-27.** The step's own chain read (`readTokenUrisFromChain`, one Multicall3 `eth_call` at the finalized block) was run on Ethereum through the operator's NodeReal account for 18 agent ids spread over the registry's history. It answered for 17, and for all 17 the link was the same as a plain `tokenURI` call gave; the 18th, an id that does not exist, reverts and gives no link, as it does on the other chains. The 17 links were 8 empty, 7 web addresses (on ag0.xyz, agents.exquisite.land, api.freaks.one, api.normies.art, lagrangebend.com, metadata.evoevo.ai and kokomoji.art), 1 JSON held inside the link and 1 of another kind.

**What it has to do.** A rehearsal of the first Ethereum pass on 2026-10-27 (`docs/ethereum-go-live-2026-10-27.md`) listed 5,186 entries. 3,878 of them are named from JSON inside their link and 1,308 show "Agent #n", which is the work for this step.

**Pace.** The three chains share the same sixteen reads every thirty minutes, 768 files a day in all, and a chain with nothing to ask leaves the run to the next. At sixteen entries a run, Arc's 309 take about 20 runs, Ethereum's 1,308 about 80, and Base's, if it is near 8,000, about 500. Taking the chains in turn, Ethereum is done about three days after it is listed, and the end of Base's backlog moves about two days later than the eleven it was given with two chains.

**Chosen by Claude, so the operator can say no.** Ethereum last in the turn, so Base and Arc keep their order, and no limit of its own.

**Undo.** As above: the SQL there now lists `erc8004_eth` too. Pausing the source stops the names along with its pass.
