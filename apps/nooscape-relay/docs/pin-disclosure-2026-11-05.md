# A pinned entry says so (2026-11-05)

> **Status:** Built 2026-11-05, after the second outside architecture review of that day. No migration: it reads the table of migration 0056 ([the pins addendum](./bsc-erc8004-2026-10-13.md)). That table is empty, so no entry shows anything on the day this ships.

## Why

A pin is the one place where a person's decision, and not a published rule, puts a registration in the listing. The review found that the Home page said so in one sentence about the rules ("the operator can pin an entry to keep it listed") and nowhere else, so a reader could not tell which entries were pinned. For a service whose claim is that every record carries its basis, that is the first gap a careful reader finds. A pin is now a recorded fact on the entry it lists.

## What a reader sees

- **On the entry's page**, in the Registry entry section, a part headed `Listed by the operator`: the day the pin was set, what a pin does (it keeps a registration listed whatever the published listing rules say about its link, host, wallet or name, until the operator removes it), that it is the operator's decision and not the rules', and the operator's note if one was written. The words are in `client/src/lib/pinText.ts`, and a test holds them free of any word of trust, score, safety or review: the sentence says who decided and what a pin does, and nothing about the agent.
- **In the API**, `GET /api/v1/agents/{chain}/{id}` and the batch answer two fields, both in the OpenAPI document: `listed_because`, which is `rules` or `operator_pin`, and `pin`, which is null or `{ pinned_at, note }`.
- **In the published rules**, the sentence on the Home page ends: "the operator can pin an entry to keep it listed, and an entry listed that way says so on its page and in the API, with the operator's note".

The search summaries and the answer of `/check` do not carry it. They point to the entry, and the entry says.

## The note is public

The operator's note is shown as written, cleaned of control and invisible characters and cut to 300 characters (the column's width). Write it to be read, and put nothing in it that should not be public. The operator's pack for adding a pin says so.

## What it does not do

- It does not say why the rules would have held the entry out, or that they would have. A pin on an entry the rules list anyway shows as a pin.
- A claim in force, which spares the host rule, is not a pin. It shows through `claim`, as it did.
- If the pins table cannot be read, the entry reads as it did before and no pin is shown. A missing table is quiet; any other failure is logged as `Entry pin`.

## How it is built

- `server/db.ts`, `getAgentDirectoryEntry`: one read of the pins table by the entry's source and key (the table's primary key), after the entry's other sections. The same read serves the page and the API, so they cannot disagree.
- `server/apiV1.ts` and `server/apiV1Spec.ts`: the two fields. `client/src/pages/DirectoryAgent.tsx` and `client/src/lib/pinText.ts`: the part and its words.

## Checked

- `apiV1.test.ts`: the default answer says `rules` and a null pin; a pin answers `operator_pin` with its day and note, and with a null note; every answer is checked against the OpenAPI document.
- `agentRegistryRows.integration.test.ts`, on MySQL 8.4 and MariaDB 10.11: a pinned entry carries its pin with the note cleaned, a pin with no note carries a null note, an entry the rules list carries none, and an entry reads as before when the pins table is not there.
- `pinText.test.ts` and `directoryProtocols.test.ts`: the words, with no long dash and none of the words above, and the rules sentence.
- `apiV1.test.ts` also holds the document to requiring every field it declares for an agent, the two new ones among them, and `directoryAgentPin.test.ts` holds the page part at the source (there is no browser test runner).
- Seventeen planted bugs, each caught: the pin not read, read by key alone or by source alone, a missing table failing the entry, the note served as written, the pin left out of the entry, `rules` shown for a pinned entry, the pin or its note left out of the answer, the fields not declared or not required by the document, the rules sentence without the disclosure, the page part shown for every entry or its note always shown, the entry type without the field, and a sentence that claims quality. One was not caught at first (the document not requiring the new fields), which is why the schema test above exists.

## Rolling back

Remove the section in `getAgentDirectoryEntry`, the two fields and the page part. Nothing is stored by this change.
