# Contributing

Issues and pull requests are welcome.

- Report a vulnerability to security@nooscape.si, not in a public issue (see `SECURITY.md`).
- Before a large change, open an issue to talk it over. The rules the site keeps (facts with their dates, no verdicts, every claim on a page true) are tested, and a change that breaks one will not merge.
- Run `pnpm check` and `pnpm test` in `apps/nooscape-relay` before you open a pull request. The tests that need a database skip when none is reachable.
- Keep a change small and say what it checks. The documentation index is `apps/nooscape-relay/docs/README.md`.

By contributing you agree that your contribution is licensed under the MIT license of this repository.
