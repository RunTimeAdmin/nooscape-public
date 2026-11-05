# Searching by a whole host (3 November 2026)

A one-condition change to the directory search, one test, and this record. No migration, no new setting.

**Status.** Merged as PR 255 on 2026-11-04 at 02:17:25Z (branch `fix/search-by-whole-host`, main 4d60dd6) and live within about a minute: the first poll that saw it was before 02:18:25Z. "Checked" below says what the tests showed and "Live" what was seen after the deploy.

**Decided:** 2026-11-03, by the operator, in chat. After a plugin for Coinbase's Wallet MCP was drafted and its calls were run against the live API, he was shown that a search by a whole host found nothing and was given the steps before the plugin could be submitted, the first being "the search fix, live". He sent that list back as his answer.

## What happened

A call in the plugin, a search for the listings of one host, returned nothing for a host that has listings.

| Query, asked of the live site on 2026-11-03 | Results |
|---|---:|
| `host=cubicle.algotrada.com` | 0 |
| `q=cubicle.algotrada.com` | 0 |
| `q=algotrada.com` | 0 |
| `q=cubicle.algotrada` | 3 |
| `q=algotrada` | 3 |
| `q=cubicle` | 3 |

The three listings are agents 96558 to 96560 on Base. The pre-flight check (`POST /api/v1/check`) with a `url` asks the same search for the host and then keeps the listings whose host is exactly that, so it had the same blind spot. A check that matches no listing is answered and not charged for, so nobody paid for a miss, but the answer read as "nothing on record" about a host that had listings.

## Cause

A query of three or more characters becomes a boolean full-text query with one required term per word, here `+cubicle.algotrada.com*`. The parser splits the host at its dots. `com` is on InnoDB's default stopword list, and a required stopword matches nothing. The list, read from `INFORMATION_SCHEMA.INNODB_FT_DEFAULT_STOPWORD` on MariaDB 10.11.19 (the production engine) and on MySQL 8.4.11 (the CI engine), is the same on both: a, about, an, are, as, at, be, by, com, de, en, for, from, how, i, in, is, it, la, of, on, or, that, the, this, to, und, was, what, when, where, who, will, with, www.

The same table and the same index definition as the directory's, on both engines:

| Full-text query | Found |
|---|---:|
| `+cubicle.algotrada.com*` | 0 |
| `+www.example.com*` | 0 |
| `+cubicle.algotrada*` | 1 |
| `+h77.example.net*` | 1 |
| `+api.example.org*` | 1 |

So a whole host is missed whenever one of its labels is a stopword, and `com` and `www` are the common ones. An exact match on the same table found the row on both engines, in any letter case, and `EXPLAIN` showed the plain index on the host being used (`type` `ref`).

## What changed

- `server/db.ts`: a pattern `HOST_NAME` (two or more dot-separated labels of letters, digits and hyphens) and one more condition in `directorySearchConditions`. When the query is a whole host name, `locatorHost` equal to the query in lower case is tried as well. The search already runs one query per index and merges the best rows by id, so a listing that both full text and the exact match find is returned once and counted once. The equality uses the existing index `agent_directory_locator_host_idx` (migration 0020). The visibility rules (hidden rows, closed assets, paused sources, the suppressed domain) apply to it as to the others.
- `server/directorySearch.integration.test.ts`: one test over six rows: two visible listings of `cubicle.algotrada.com`, a hidden one and one in a paused source (neither may appear), a `www.example.com` listing, and another `.com` host. The whole host finds the two visible rows, newest first. The same host in capitals finds them. `www.example.com` finds its row. A host nobody has finds nothing. The count is 2 and is not capped. A word of the host (`cubicle`) still finds them through full text.

## Checked

- The new test failed before the change on MySQL 8.4.11 with `expected [] to deeply equal ["com-2", "com-1"]`, and passes after it. The other 29 tests in the file pass unchanged. They compare the new search with the statement it replaced over 23 queries, two of them hosts.
- `pnpm check` is clean. The full suite on MySQL 8.4.11 passed: 285 files, 5,010 tests passed and 18 skipped, the same 18 as the run before the change (which had 5,009 passed).
- MariaDB 10.11 cannot run that test file, which sets `cte_max_recursion_depth`, a MySQL variable, and could not before this change. The queries in the table above were run by hand on MariaDB 10.11.19 instead.

## Not changed

- Only a whole host is matched exactly. `algotrada.com` still does not find `cubicle.algotrada.com`; that is what `host=` and the check's `url` mean.
- A stopword used as a plain word in free text, such as `the`, behaves as before.
- The search box on the site calls the same function, so it now finds a whole host as well.

## Live

Asked of the live site on 2026-11-04 at about 02:18Z, after the deploy:

| Query | Before | After |
|---|---:|---:|
| `host=cubicle.algotrada.com` | 0 | 3 |
| `q=cubicle.algotrada.com` | 0 | 3 |
| `q=Cubicle.Algotrada.COM` | not asked | 3 |
| `q=algotrada.com` | 0 | 0 |
| `q=cubicle.algotrada` | 3 | 3 |
| `q=algotrada` | 3 | 3 |
| `q=cubicle` | 3 | 3 |

The first two rows are the fix, and the third shows that the query is lower-cased. The fourth is a part of a host, which is not matched exactly by design. The rest are unchanged. After the deploy the plugin's live API test passed in full (42 of 42 checks pass, the paid check stopped at its 402) and `verify-live` exited 0 (48 passed, 0 warning(s), 0 failed).

## Open

Nothing. A part of a host (`algotrada.com`) still finds nothing, by design.
