# Security

To report a vulnerability in nooscape.si or in this repository, write to **security@nooscape.si**. Please do not open a public issue for it.

The same address is published for researchers at <https://nooscape.si/.well-known/security.txt>.

## What helps

- What you found and where: a URL, a procedure name (for example `liveData.directorySearch`) or a file.
- How to reproduce it, and what you saw.
- What you think it lets someone do.

## What to leave out

- Load tests and anything that degrades the site for other people.
- Reading or changing data that is not yours, and contacting the people or wallets named in a record.
- Secrets. If you find one, say where it is and do not use it.

## Scope

In scope: nooscape.si and its APIs under `/api/trpc` and `/api/v1` (with the x402 pay-per-call flow), and the code in `apps/nooscape-relay`.

Out of scope: the services Nooscape reads (chains, registries and catalogs) and its hosting provider. Report those to their owners.

## Checking signed evidence

Nooscape signs the evidence packets it exports. The signing keys, and whether each is active, retired or revoked, are published at <https://nooscape.si/.well-known/nooscape-keys.json>. A packet signed by a revoked key must not be trusted.

## Known limitations

- The operator console's browser login has one failure cap for everyone: after 20 failed attempts from anywhere within 15 minutes, every further wrong token is refused until the window ends, and 5 failures from one requester refuse that requester. A correct token is never refused, so the cap slows a guesser and cannot lock the operator out. It is known and is not a way in. The operator's token path is separate and is not affected.

## Supported versions

Only the live site, which is built from the `main` branch.
