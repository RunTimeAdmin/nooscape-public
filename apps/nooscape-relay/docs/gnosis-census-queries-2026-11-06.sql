-- Gnosis registry census: measurement queries (read-only).
--
-- Run these against the Nooscape database. Every statement is a SELECT. None writes anything, and none returns a name, a wallet
-- address, a host name or a profile link: the output is counts and size buckets only, so it is safe to paste back.
--
-- The registry is the ERC-8004 identity registry on Gnosis (chain id 100): every registration the chain pass has stored for the
-- source whose protocol is erc8004_gnosis, listed or held out, in the table agent_directory_registry_rows. The listing rules read
-- exactly these rows (a profile link shared by 2 or more registrations, a host shared by 50 or more, a wallet that registered 10
-- or more), so the census counts them too. Q0 says how many of them are hidden; the rest of the statements count every row,
-- hidden ones included, as the listing rules do. A host that holds more than 2,000 rows keeps 2,000 of them (the flood cap,
-- docs/flood-host-cap-2026-10-21.md) and counts the rest in agent_directory_registry_overflow; Q0b reads that count, so the
-- registrations stored and the registrations on the chain can be told apart.
--
-- Gnosis's block time is close to constant, from about 5.08 to about 5.19 seconds a block with a slot missed now and then. Q10a and Q10b
-- turn a mint block into a UTC date by adding seconds to a block whose time is known: they follow the chain's own block times
-- through 19 stretches of 250,000 blocks from the registry's first block (44,505,010, 2026-02-04 09:49:00 UTC), each with a start
-- block, its time and the seconds a block in that stretch, all read from the chain; the stretch from the latest start block runs
-- to the finalized block 49,146,890 (2026-11-06 23:11:40 UTC). Checked against the block times in the registrations' own logs, a date
-- is within 148 minutes (the worst of all 4,179 registrations, with a median of 1.6 minutes), so a registration made that close to
-- midnight, or to the end of a month, can land on the next one. Every time is a block header timestamp read from a node on
-- 2026-11-06. An hour is 708 blocks, which is also the hand-out hour in Q8.
--
-- Run them all in one sitting, so the figures are one moment. Paste back each result grid.

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q0. As of when: the registrations stored, how many are hidden, when a pass first and last saw one, when the source last
--     succeeded, and how many of the registrations the directory lists (the entries of the source).
-- ---------------------------------------------------------------------------------------------------------------------------
SELECT COUNT(*)                AS registrations,
       SUM(r.hidden = 1)       AS hidden_registrations,
       MIN(r.firstSeenAt)      AS first_seen_min,
       MAX(r.lastSeenAt)       AS last_seen_max,
       MAX(s.lastSuccessfulAt) AS source_last_success,
       (SELECT COUNT(*)
          FROM agent_directory_entries e
          JOIN ingestion_sources s2 ON s2.id = e.sourceId
         WHERE s2.protocol = 'erc8004_gnosis' AND s2.state = 'active') AS entries_in_the_directory
FROM agent_directory_registry_rows r
JOIN ingestion_sources s ON s.id = r.sourceId
WHERE s.protocol = 'erc8004_gnosis'
  AND s.state = 'active';

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q0b. The flood cap: how many hosts went past the 2,000 rows a host may keep, how many registrations were counted and not stored
--      for them, and the largest host's. Registrations on the chain = the registrations of Q0 plus the second figure here.
-- ---------------------------------------------------------------------------------------------------------------------------
SELECT COUNT(*)                          AS hosts_past_the_cap,
       COALESCE(SUM(o.overflowCount), 0) AS registrations_counted_not_stored,
       COALESCE(MAX(o.overflowCount), 0) AS largest_host_overflow
FROM agent_directory_registry_overflow o
JOIN ingestion_sources s ON s.id = o.sourceId
WHERE s.protocol = 'erc8004_gnosis'
  AND s.state = 'active';

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q1. Size and surface: registrations, registering wallets, https links and their host names, distinct profile links, the
--     registrations that set no profile link at all, and how many have a mint block measured.
--     (The empty-link hash is the SHA-256 of the empty string: a registration that set no URI.)
-- ---------------------------------------------------------------------------------------------------------------------------
WITH v AS (
  SELECT r.registrant, r.locatorHost, r.profileUriHash, r.mintBlock
  FROM agent_directory_registry_rows r
  JOIN ingestion_sources s ON s.id = r.sourceId
  WHERE s.protocol = 'erc8004_gnosis'
    AND s.state = 'active'
)
SELECT COUNT(*)                          AS registrations,
       COUNT(DISTINCT registrant)        AS distinct_wallets,
       SUM(registrant IS NULL)           AS no_wallet,
       SUM(locatorHost IS NOT NULL)      AS with_https_host,
       COUNT(DISTINCT locatorHost)       AS distinct_hosts,
       COUNT(DISTINCT profileUriHash)    AS distinct_profile_links,
       SUM(profileUriHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855') AS no_uri_set,
       SUM(mintBlock IS NOT NULL)        AS mint_measured
FROM v;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q2. How many registrations one wallet made: wallets and registrations in each size bucket, and the largest in the bucket.
--     (The wallet is the owner named in the registration event: the address that registered the entry.) The buckets break at 10
--     (the listing rule), 50 and 100.
-- ---------------------------------------------------------------------------------------------------------------------------
WITH v AS (
  SELECT r.registrant
  FROM agent_directory_registry_rows r
  JOIN ingestion_sources s ON s.id = r.sourceId
  WHERE s.protocol = 'erc8004_gnosis'
    AND s.state = 'active'
),
w AS (
  SELECT registrant, COUNT(*) AS n FROM v WHERE registrant IS NOT NULL GROUP BY registrant
)
SELECT CASE WHEN n = 1 THEN '1' WHEN n < 10 THEN '2-9' WHEN n < 50 THEN '10-49' WHEN n < 100 THEN '50-99' WHEN n < 1000 THEN '100-999' ELSE '1000+' END AS registrations_per_wallet,
       COUNT(*)  AS wallets,
       SUM(n)    AS registrations,
       MAX(n)    AS largest_in_bucket
FROM w
GROUP BY registrations_per_wallet
ORDER BY MIN(n);

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q3. The 25 largest wallets that made 50 or more registrations, by rank and never by address: how many each made, how many of
--     those have an https link, how many sit on the wallet's own largest host name, how many host names it uses and how many
--     profile links.
-- ---------------------------------------------------------------------------------------------------------------------------
WITH v AS (
  SELECT r.registrant, r.locatorHost, r.profileUriHash
  FROM agent_directory_registry_rows r
  JOIN ingestion_sources s ON s.id = r.sourceId
  WHERE s.protocol = 'erc8004_gnosis'
    AND s.state = 'active'
    AND r.registrant IS NOT NULL
),
w AS (
  SELECT registrant, COUNT(*) AS registrations, SUM(locatorHost IS NOT NULL) AS with_https_host, COUNT(DISTINCT locatorHost) AS distinct_hosts, COUNT(DISTINCT profileUriHash) AS distinct_links
  FROM v GROUP BY registrant HAVING COUNT(*) >= 50
),
wh AS (
  SELECT registrant, locatorHost, COUNT(*) AS n FROM v WHERE locatorHost IS NOT NULL GROUP BY registrant, locatorHost
),
top1 AS (
  SELECT registrant, MAX(n) AS on_largest_host FROM wh GROUP BY registrant
)
SELECT ROW_NUMBER() OVER (ORDER BY w.registrations DESC) AS wallet_rank,
       w.registrations,
       w.with_https_host,
       COALESCE(top1.on_largest_host, 0) AS on_its_largest_host,
       w.distinct_hosts,
       w.distinct_links
FROM w
LEFT JOIN top1 ON top1.registrant = w.registrant
ORDER BY w.registrations DESC
LIMIT 25;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q3b. All the wallets that made 50 or more registrations, in one row: how many wallets, how many registrations they made
--      between them, and the largest wallet's.
-- ---------------------------------------------------------------------------------------------------------------------------
WITH w AS (
  SELECT r.registrant, COUNT(*) AS n
  FROM agent_directory_registry_rows r
  JOIN ingestion_sources s ON s.id = r.sourceId
  WHERE s.protocol = 'erc8004_gnosis'
    AND s.state = 'active'
    AND r.registrant IS NOT NULL
  GROUP BY r.registrant
  HAVING COUNT(*) >= 50
)
SELECT COUNT(*) AS wallets_with_50_or_more, COALESCE(SUM(n), 0) AS registrations_on_them, COALESCE(MAX(n), 0) AS largest_wallet
FROM w;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q4. Host names, by size and never by name: the ten largest hosts (rank and registrations only).
-- ---------------------------------------------------------------------------------------------------------------------------
WITH v AS (
  SELECT r.locatorHost
  FROM agent_directory_registry_rows r
  JOIN ingestion_sources s ON s.id = r.sourceId
  WHERE s.protocol = 'erc8004_gnosis'
    AND s.state = 'active'
),
h AS (
  SELECT locatorHost, COUNT(*) AS n FROM v WHERE locatorHost IS NOT NULL GROUP BY locatorHost
)
SELECT ROW_NUMBER() OVER (ORDER BY n DESC) AS host_rank, n AS registrations
FROM h
ORDER BY n DESC
LIMIT 10;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q4b. All the hosts that hold 50 or more registrations (the listing rule's host bar), in one row: how many hosts, how many
--      registrations they hold between them, and the largest host's.
-- ---------------------------------------------------------------------------------------------------------------------------
WITH h AS (
  SELECT r.locatorHost, COUNT(*) AS n
  FROM agent_directory_registry_rows r
  JOIN ingestion_sources s ON s.id = r.sourceId
  WHERE s.protocol = 'erc8004_gnosis'
    AND s.state = 'active'
    AND r.locatorHost IS NOT NULL
  GROUP BY r.locatorHost
  HAVING COUNT(*) >= 50
)
SELECT COUNT(*) AS hosts_with_50_or_more, COALESCE(SUM(n), 0) AS registrations_on_them, COALESCE(MAX(n), 0) AS largest_host
FROM h;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q5. Profile links held by several registrations: profile links and registrations in each size bucket (a link of its own is
--     the bucket '1'), the largest in the bucket, and how many of the registrations in a bucket have an https host. No link and no
--     hash is returned. The empty link (no URI set) is left out of the buckets and counted in Q1.
-- ---------------------------------------------------------------------------------------------------------------------------
WITH v AS (
  SELECT r.profileUriHash, r.locatorHost
  FROM agent_directory_registry_rows r
  JOIN ingestion_sources s ON s.id = r.sourceId
  WHERE s.protocol = 'erc8004_gnosis'
    AND s.state = 'active'
    AND r.profileUriHash IS NOT NULL
    AND r.profileUriHash <> 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
),
l AS (
  SELECT profileUriHash, COUNT(*) AS n, SUM(locatorHost IS NOT NULL) AS with_host FROM v GROUP BY profileUriHash
)
SELECT CASE WHEN n = 1 THEN '1' WHEN n < 10 THEN '2-9' WHEN n < 50 THEN '10-49' WHEN n < 1000 THEN '50-999' ELSE '1000+' END AS registrations_per_link,
       COUNT(*)       AS links,
       SUM(n)         AS registrations,
       MAX(n)         AS largest_in_bucket,
       SUM(with_host) AS registrations_with_https_host
FROM l
GROUP BY registrations_per_link
ORDER BY MIN(n);

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q6. Names: how many registrations still carry the placeholder the pass gives a registration with no name ("Agent #n"), how
--     many names are distinct, and how many registrations share a name with others (group sizes only; no name is returned).
-- ---------------------------------------------------------------------------------------------------------------------------
WITH v AS (
  SELECT r.displayName, (r.displayName REGEXP '^Agent #[0-9]+$') AS isPlaceholder
  FROM agent_directory_registry_rows r
  JOIN ingestion_sources s ON s.id = r.sourceId
  WHERE s.protocol = 'erc8004_gnosis'
    AND s.state = 'active'
),
nm AS (
  SELECT displayName, COUNT(*) AS n FROM v WHERE isPlaceholder = 0 GROUP BY displayName
)
SELECT COUNT(*)                                              AS registrations,
       SUM(isPlaceholder = 1)                                AS placeholder_names,
       (SELECT COUNT(*)            FROM nm)                  AS distinct_real_names,
       (SELECT COALESCE(SUM(n), 0) FROM nm WHERE n >= 2)     AS registrations_sharing_a_name,
       (SELECT COALESCE(SUM(n), 0) FROM nm WHERE n >= 10)    AS registrations_in_names_shared_by_10_or_more,
       (SELECT COALESCE(MAX(n), 0) FROM nm)                  AS largest_name_group
FROM v;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q7. What the listing rules did: the registrations in each state the pass stores (0 no usable link, 1 listed, 2 held out as
--     shared, 3 waiting to be classified, 4 a name that is only a number), and for the ones held out as shared, which rule
--     reached them first, in the order the rules run (a shared profile link, then a host shared by 50 or more, then a wallet that
--     registered 10 or more). A rule that reaches a registration first is not the only one that would have.
-- ---------------------------------------------------------------------------------------------------------------------------
WITH v AS (
  SELECT r.listing, r.profileUriHash, r.locatorHost, r.registrant
  FROM agent_directory_registry_rows r
  JOIN ingestion_sources s ON s.id = r.sourceId
  WHERE s.protocol = 'erc8004_gnosis'
    AND s.state = 'active'
),
c AS (
  SELECT listing,
         COUNT(*) OVER (PARTITION BY profileUriHash)                              AS link_n,
         CASE WHEN locatorHost IS NULL THEN 0 ELSE COUNT(*) OVER (PARTITION BY locatorHost) END AS host_n,
         CASE WHEN registrant  IS NULL THEN 0 ELSE COUNT(*) OVER (PARTITION BY registrant)  END AS wallet_n
  FROM v
)
SELECT listing,
       CASE listing WHEN 0 THEN 'no usable link' WHEN 1 THEN 'listed' WHEN 2 THEN 'held out as shared' WHEN 3 THEN 'waiting' WHEN 4 THEN 'name is only a number' ELSE 'other' END AS state,
       CASE WHEN listing <> 2 THEN '-'
            WHEN link_n >= 2   THEN 'profile link shared by 2 or more'
            WHEN host_n >= 50  THEN 'host shared by 50 or more'
            WHEN wallet_n >= 10 THEN 'wallet that registered 10 or more'
            ELSE 'none of the three (stale)' END AS first_rule,
       COUNT(*) AS registrations
FROM c
GROUP BY listing, state, first_rule
ORDER BY listing, first_rule;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q8. Changes of hands and edits, from the totals the pass keeps for each registration: how many transfers after the mint, how
--     many of them were a hand-out (within the chain's hand-out hour of minting, 708 blocks on Gnosis, from the minting
--     wallet), how many profile-link edits, and how many registrations each touched. A registration the activity walk has not
--     covered yet has null totals and is not in a sum.
-- ---------------------------------------------------------------------------------------------------------------------------
WITH v AS (
  SELECT r.mintBlock, r.secondaryTransferCount, r.handoutCount, r.uriUpdateCount
  FROM agent_directory_registry_rows r
  JOIN ingestion_sources s ON s.id = r.sourceId
  WHERE s.protocol = 'erc8004_gnosis'
    AND s.state = 'active'
)
SELECT COUNT(*)                          AS registrations,
       SUM(mintBlock IS NOT NULL)        AS mint_measured,
       SUM(secondaryTransferCount IS NOT NULL) AS covered_by_the_walk,
       COALESCE(SUM(secondaryTransferCount), 0) AS transfers_after_mint,
       COALESCE(SUM(handoutCount), 0)    AS handouts,
       SUM(secondaryTransferCount > 0)   AS registrations_that_changed_hands,
       SUM(handoutCount > 0)             AS registrations_handed_out,
       COALESCE(SUM(uriUpdateCount), 0)  AS profile_link_edits,
       SUM(uriUpdateCount > 0)           AS registrations_edited
FROM v;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q9. The activity ledger itself: the events of the source by kind (a mint, a transfer after the mint, a profile-link edit), the
--     registrations they belong to, and the oldest and newest block. It holds every event the walk has recorded, hidden
--     registrations included.
-- ---------------------------------------------------------------------------------------------------------------------------
SELECT a.kind,
       COUNT(*)                      AS events,
       COUNT(DISTINCT a.externalKey) AS registrations,
       MIN(a.blockNumber)            AS oldest_block,
       MAX(a.blockNumber)            AS newest_block
FROM agent_directory_chain_activity a
JOIN ingestion_sources s ON s.id = a.sourceId
WHERE s.protocol = 'erc8004_gnosis'
GROUP BY a.kind
ORDER BY a.kind;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q10a. When the registrations were made, the recent days: the registrations in each UTC day, for the last 21 days that have one. The
--       date is the mint block's time, read through the same 19 stretches as Q10b (a start block, its time and the seconds a block
--       in that stretch, each from the chain; the stretch from the latest start block runs to the finalized block). Counts only.
--       (mintBlock is unsigned, so it is cast before the subtraction.)
-- ---------------------------------------------------------------------------------------------------------------------------
WITH v AS (
  SELECT CAST(r.mintBlock AS SIGNED) AS b
  FROM agent_directory_registry_rows r
  JOIN ingestion_sources s ON s.id = r.sourceId
  WHERE s.protocol = 'erc8004_gnosis'
    AND s.state = 'active'
    AND r.mintBlock IS NOT NULL
),
t AS (
  SELECT CASE
    WHEN b >= 49005010 THEN TIMESTAMPADD(SECOND, ROUND(5.08356 * (b - 49005010)), '2026-10-29 14:50:45')
    WHEN b >= 48755010 THEN TIMESTAMPADD(SECOND, ROUND(5.16268 * (b - 48755010)), '2026-10-14 16:19:35')
    WHEN b >= 48505010 THEN TIMESTAMPADD(SECOND, ROUND(5.12304 * (b - 48505010)), '2026-09-29 20:33:35')
    WHEN b >= 48255010 THEN TIMESTAMPADD(SECOND, ROUND(5.12286 * (b - 48255010)), '2026-09-15 00:48:20')
    WHEN b >= 48005010 THEN TIMESTAMPADD(SECOND, ROUND(5.09290 * (b - 48005010)), '2026-08-31 07:07:55')
    WHEN b >= 47755010 THEN TIMESTAMPADD(SECOND, ROUND(5.10054 * (b - 47755010)), '2026-08-16 12:55:40')
    WHEN b >= 47505010 THEN TIMESTAMPADD(SECOND, ROUND(5.12104 * (b - 47505010)), '2026-08-01 17:18:00')
    WHEN b >= 47255010 THEN TIMESTAMPADD(SECOND, ROUND(5.13222 * (b - 47255010)), '2026-07-17 20:53:45')
    WHEN b >= 47005010 THEN TIMESTAMPADD(SECOND, ROUND(5.11644 * (b - 47005010)), '2026-07-03 01:35:15')
    WHEN b >= 46755010 THEN TIMESTAMPADD(SECOND, ROUND(5.12670 * (b - 46755010)), '2026-06-18 05:34:00')
    WHEN b >= 46505010 THEN TIMESTAMPADD(SECOND, ROUND(5.12266 * (b - 46505010)), '2026-06-03 09:49:35')
    WHEN b >= 46255010 THEN TIMESTAMPADD(SECOND, ROUND(5.13796 * (b - 46255010)), '2026-05-19 13:01:25')
    WHEN b >= 46005010 THEN TIMESTAMPADD(SECOND, ROUND(5.12494 * (b - 46005010)), '2026-05-04 17:07:30')
    WHEN b >= 45755010 THEN TIMESTAMPADD(SECOND, ROUND(5.18504 * (b - 45755010)), '2026-04-19 17:03:10')
    WHEN b >= 45505010 THEN TIMESTAMPADD(SECOND, ROUND(5.16346 * (b - 45505010)), '2026-04-04 18:28:45')
    WHEN b >= 45255010 THEN TIMESTAMPADD(SECOND, ROUND(5.09552 * (b - 45255010)), '2026-03-21 00:37:25')
    WHEN b >= 45005010 THEN TIMESTAMPADD(SECOND, ROUND(5.15548 * (b - 45005010)), '2026-03-06 02:36:15')
    WHEN b >= 44755010 THEN TIMESTAMPADD(SECOND, ROUND(5.13898 * (b - 44755010)), '2026-02-19 05:43:50')
    WHEN b >= 44505010 THEN TIMESTAMPADD(SECOND, ROUND(5.12516 * (b - 44505010)), '2026-02-04 09:49:00')
    ELSE NULL
  END AS ts
  FROM v
),
d AS (
  SELECT DATE(ts) AS utc_day FROM t
)
SELECT utc_day, COUNT(*) AS registrations
FROM d
WHERE utc_day > (SELECT MAX(utc_day) FROM d) - INTERVAL 21 DAY
GROUP BY utc_day
ORDER BY utc_day;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q10b. When the registrations were made, the whole history: the registrations in each UTC month. The date is the mint block's
--       time, read through 19 stretches of blocks (a start block, its time and the seconds a block in that stretch, each
--       from the chain; the stretch from the latest start block runs to the finalized block). Counts only.
-- ---------------------------------------------------------------------------------------------------------------------------
WITH v AS (
  SELECT CAST(r.mintBlock AS SIGNED) AS b
  FROM agent_directory_registry_rows r
  JOIN ingestion_sources s ON s.id = r.sourceId
  WHERE s.protocol = 'erc8004_gnosis'
    AND s.state = 'active'
    AND r.mintBlock IS NOT NULL
),
t AS (
  SELECT CASE
    WHEN b >= 49005010 THEN TIMESTAMPADD(SECOND, ROUND(5.08356 * (b - 49005010)), '2026-10-29 14:50:45')
    WHEN b >= 48755010 THEN TIMESTAMPADD(SECOND, ROUND(5.16268 * (b - 48755010)), '2026-10-14 16:19:35')
    WHEN b >= 48505010 THEN TIMESTAMPADD(SECOND, ROUND(5.12304 * (b - 48505010)), '2026-09-29 20:33:35')
    WHEN b >= 48255010 THEN TIMESTAMPADD(SECOND, ROUND(5.12286 * (b - 48255010)), '2026-09-15 00:48:20')
    WHEN b >= 48005010 THEN TIMESTAMPADD(SECOND, ROUND(5.09290 * (b - 48005010)), '2026-08-31 07:07:55')
    WHEN b >= 47755010 THEN TIMESTAMPADD(SECOND, ROUND(5.10054 * (b - 47755010)), '2026-08-16 12:55:40')
    WHEN b >= 47505010 THEN TIMESTAMPADD(SECOND, ROUND(5.12104 * (b - 47505010)), '2026-08-01 17:18:00')
    WHEN b >= 47255010 THEN TIMESTAMPADD(SECOND, ROUND(5.13222 * (b - 47255010)), '2026-07-17 20:53:45')
    WHEN b >= 47005010 THEN TIMESTAMPADD(SECOND, ROUND(5.11644 * (b - 47005010)), '2026-07-03 01:35:15')
    WHEN b >= 46755010 THEN TIMESTAMPADD(SECOND, ROUND(5.12670 * (b - 46755010)), '2026-06-18 05:34:00')
    WHEN b >= 46505010 THEN TIMESTAMPADD(SECOND, ROUND(5.12266 * (b - 46505010)), '2026-06-03 09:49:35')
    WHEN b >= 46255010 THEN TIMESTAMPADD(SECOND, ROUND(5.13796 * (b - 46255010)), '2026-05-19 13:01:25')
    WHEN b >= 46005010 THEN TIMESTAMPADD(SECOND, ROUND(5.12494 * (b - 46005010)), '2026-05-04 17:07:30')
    WHEN b >= 45755010 THEN TIMESTAMPADD(SECOND, ROUND(5.18504 * (b - 45755010)), '2026-04-19 17:03:10')
    WHEN b >= 45505010 THEN TIMESTAMPADD(SECOND, ROUND(5.16346 * (b - 45505010)), '2026-04-04 18:28:45')
    WHEN b >= 45255010 THEN TIMESTAMPADD(SECOND, ROUND(5.09552 * (b - 45255010)), '2026-03-21 00:37:25')
    WHEN b >= 45005010 THEN TIMESTAMPADD(SECOND, ROUND(5.15548 * (b - 45005010)), '2026-03-06 02:36:15')
    WHEN b >= 44755010 THEN TIMESTAMPADD(SECOND, ROUND(5.13898 * (b - 44755010)), '2026-02-19 05:43:50')
    WHEN b >= 44505010 THEN TIMESTAMPADD(SECOND, ROUND(5.12516 * (b - 44505010)), '2026-02-04 09:49:00')
    ELSE NULL
  END AS ts
  FROM v
)
SELECT DATE_FORMAT(ts, '%Y-%m') AS utc_month, COUNT(*) AS registrations
FROM t
GROUP BY utc_month
ORDER BY utc_month;
