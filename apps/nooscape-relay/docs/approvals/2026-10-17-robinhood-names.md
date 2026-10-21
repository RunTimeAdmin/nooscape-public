# Decision record: names for reviewed Robinhood records, read from their registration links

**Decided:** 2026-10-17, by the operator, in chat. Fifteen of the 18 reviewed Robinhood records showed only a number ("Agent #8623"). The operator was told that the registration links of 7 of them hold a name, that 6 more are ipfs links and 2 have no link at all, and that doing it meant reading each link the way the Solana 8004 name reader does. He answered: "go ahead with the Robinhood names".
**Changes:** extends the registration-name read, which the 2026-10-15 and 2026-10-16 decisions allowed for the 8004 registry on Solana, to the reviewed records of the Robinhood Chain ERC-8004 registry; adds a best-effort step to the worker; changes the wording on `/checker`.
**Does not change:** D1 (no scoring, no tiers, no quality judgments), the reviewed-run publication gate, any tier, whether a record is listed or where it sits on the map, the retained observation, the evidence packet, a record's handle and summary, and the 8,839 acknowledged Robinhood directory entries.

## What it does

1. **A step in the worker** (`server/robinhoodNames.ts`), after the BNB steps, on a tick that claimed sources. A paused control plane or a tick held back by the global interval asks nobody anything. It never throws and never fails the tick.
2. **Which records.** Only the reviewed records that are served and whose name is still the placeholder `Agent #<n>`, with a registration link the public summary names that is an https address or an ipfs address with a CID in it. A link that is `http`, `data:` or anything else is not read.
3. **Same reader, same manners as the Solana pass** (`server/ingestion/registrationFetch.ts`): the shared safe fetch (https only, the name resolved first and every address checked, the connection made to an address that was checked, three redirects at most with the same checks), the host's robots.txt read first and obeyed, a second between two requests to a host, 5 seconds a request, 256 KiB, the `Nooscape-Checker` user agent that names `/checker`, and an ipfs link asked of the configured IPFS gateway (in production the one Nooscape runs, [ipfs-gateway-2026-10-16](../ipfs-gateway-2026-10-16.md)).
4. **Pace.** At most 8 links a run, nothing started after 20 seconds, a run at most every 30 minutes, and a link tried again no sooner than 6 hours after its last try. The tries are the Solana reader's: five at most for a link that does not answer, two for a file with no name in it. A resolved link is never read again. (When the step was extended to the directory entries the same day, the files a run reads went from 8 to 16 and a limit of 6 from one host was added: see [2026-10-17-robinhood-entry-names.md](./2026-10-17-robinhood-entry-names.md).)
5. **What is kept.** One row for each link in `agent_registration_resolutions` (the Solana pass's table, so no migration): the link, its hash, the status, the reason when it failed, the name when it resolved, the number of tries and their dates.
6. **What is shown.** When a served record is read (`listLiveAtlasRecords`), the name that was read is laid over the placeholder, cleaned like every public name and cut at 120 characters. Only the display name changes, and the record gets one new optional field, `nameReadAt`, the time the name was read (the developer API page lists it). The retained observation, the evidence packet, the handle and the summary do not change. If the table cannot be read, the records are served as they were.
7. **Where it says so.** The agent's page says under the name: "This name was read from the agent's registration link on <date>. It is the registrant's own claim, and the record's evidence still shows the number." The explanation of an unverified publisher, which said everything shown comes from retained observations only, now says "apart from a name Nooscape read from a registration link, which the agent's page marks". The map and the lists show the name alone.

The name is the registrant's own claim, trimmed and cut at 200 characters when it is read. It says nothing about whether the agent works or who runs it, and it is used only where the record has nothing but a number.

## The look before the decision

Before asking, the operator's assistant made one plain GET to each of the 7 web links from the operator's machine, to see whether they held a name: at most 64 KiB, more than a second between two requests to a host, a browser-style user agent, and no robots.txt read. It was a one-off look to answer the operator's question, outside the manners above, and it was not a pass of Nooscape-Checker. Nothing was kept from it.

## Wording

`/checker` now says that Nooscape-Checker also reads the registration link of a reviewed agent in the ERC-8004 registry on Robinhood Chain to find its name, that anyone can write any web or ipfs address into a registration there, which registrations it reads, that the name is shown on the agent's page and on the map in place of the number, that the agent's page says when it was read, and that the record's signed evidence is not changed. `server/checkerPage.test.ts` holds each of those sentences to the code.

The Robinhood pass still reads no link. Its retained observations say "Nooscape did not fetch it" and that is still true of that pass. Neither sentence is shown on a public page.

## Not decided and not built

- **The 8,839 acknowledged Robinhood entries** stay "Agent #n". Their links are not stored, and reading them would need `tokenURI` calls on the chain, which the Robinhood pass does not make. That is a separate decision. (The operator made it later the same day: [2026-10-17-robinhood-entry-names.md](./2026-10-17-robinhood-entry-names.md).)
- **New observations.** A new observe run is unchanged: it still reads no link and names a registration only from inline JSON.
- **Two records have no link** and cannot be named. A name that cannot be read stays a number.

## Outcome

- [x] The step, the overlay and the pure rules, with tests against a real database.
- [x] `/checker` wording and the test that holds it.
- [x] Deployed (#120, 2026-10-17 17:49Z), and the names seen live: 16 of the 18 reviewed Robinhood records show a name read from their registration link. The other two have no link and keep "Agent #n".
