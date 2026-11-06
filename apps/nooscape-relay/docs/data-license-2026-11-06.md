# The data license: CC BY 4.0 (2026-11-06)

> **Status:** Decided and built 2026-11-06 on the owner's order ("go with CC BY 4.0"), from item 7 of the outside list of 4 November 2026 (a final data license). It replaces the provisional terms ("attribution is required, do not resell bulk copies"). The wording is the engineer's, and no lawyer has read it: the owner's rule of 18 October is to ship the current wording.

## What was decided

- **The facts Nooscape produces are licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).** That is the records it keeps, its flags, dates and counts, and the signed evidence. Anyone may copy, share and adapt them, commercially too, if they credit Nooscape and say what they changed. The license also covers database rights, which matter in the EU.
- **What it does not cover.** Text that registrants published (names, descriptions, addresses) stays theirs and is shown as published, and the public sources keep their own terms. The Nooscape name and logo are not licensed (CC BY grants no trademark rights).
- **The credit is one line.** Every answer and webhook carries `license.attribution`: "Data from Nooscape (https://nooscape.si), licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)". Copying that line is the credit the license asks for.
- **Keys, limits and x402 stay.** They set how much a person can read from the service and what a faster read costs. They do not set what a person may do with data they have. The Terms still bar scraping beyond the published rate limits, and now say beside the license that the two are about different things.

## Why

An integrator will not build on terms that say "provisional" and "do not resell", and the outside review said so. The record is dated facts that public registries already publish, so an exclusive claim over them was never the product: the product is the service (current reads, retained evidence that can be verified, a check that is fast and cheap). A license that asks only for credit lets a gateway, a wallet or a researcher use the facts and say where they came from.

## What changed

- `server/apiLicense.ts`: the license object every answer and webhook carries (name "CC BY 4.0", the attribution line above, notes), `url` still the Terms.
- `server/apiV1Spec.ts`: the OpenAPI document's `info.license` names CC BY 4.0 with the link to it, and the license schema's description says so.
- The Developers page: the sample answer, the `license` row and the paragraph under the table.
- The Terms ("The data and the API"): the license, what it does not cover, and how it sits beside the rate limits.
- The data access record's row 8 and its stage D6 lines.
- `server/apiLicense.test.ts` holds the four places together and fails if one still says "provisional" or "do not resell".

## What this cannot do

A CC license cannot be taken back for copies already made: a later change applies to copies taken after it. That is the point of the license, and it is why this record exists.

## Not done

- **A daily bulk export**, the other half of stage D6. It is not built. Until it is, reading everything means reading through the API within its limits, which the license now allows people to share but the limits still pace.
- **The `nooscape-mcp` README** still says "provisional terms" and "do not resell bulk copies". It lives in its own repository and changes with its next release, which the owner publishes.
- **The public README** does not name the data license yet; that is one sentence at the next mirror refresh.

## Rolling back

Put the earlier wording back in `apiLicense.ts`, the specification, the Developers page and the Terms; the test names each place. Copies already taken stay under CC BY 4.0.
