-- Robinhood Chain registry census: measurement queries (read-only).
--
-- Run these against the Nooscape database (MySQL 8). Every statement is a SELECT. None writes anything, and none returns a
-- name, a wallet address or a host name: the output is counts and size buckets only, so it is safe to paste back.
--
-- "Visible" is the site's own rule (server/db.ts, directoryVisibilityCondition): the source is active, the entry is not hidden,
-- the chain pass has not seen its asset close, and its locator host is not on the suppressed domain (agentrank.info). Each
-- statement that reads entries starts with the same WITH clause so it can be run on its own.
--
-- The registry is the ERC-8004 identity registry on Robinhood Chain: entries of the source whose protocol is erc8004. Q7 reads
-- the activity ledger of that source and Q8 and Q9 read the reputation ledger (source protocol erc8004_reputation). The two
-- ledgers hold every event they have recorded, hidden entries included, and say so in the document.
--
-- Run them all in one sitting, so the figures are one moment. Paste back each result grid.

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q0. As of when: the visible entries, when a pass first and last saw one, and when the source last succeeded.
-- ---------------------------------------------------------------------------------------------------------------------------
SELECT COUNT(*)                AS visible_entries,
       MIN(e.firstSeenAt)      AS first_seen_min,
       MAX(e.lastSeenAt)       AS last_seen_max,
       MAX(s.lastSuccessfulAt) AS source_last_success
FROM agent_directory_entries e
JOIN ingestion_sources s ON s.id = e.sourceId
WHERE s.state = 'active'
  AND s.protocol = 'erc8004'
  AND e.hidden = 0
  AND e.assetClosedAt IS NULL
  AND (e.locatorHost IS NULL OR NOT (e.locatorHost = 'agentrank.info' OR e.locatorHost LIKE '%.agentrank.info'));

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q1. Size and surface: entries, registering wallets, https links and their host names, and how much of the registry's
--     activity the directory has measured for them. A column that counts a measured fact skips an entry not measured yet.
-- ---------------------------------------------------------------------------------------------------------------------------
WITH v AS (
  SELECT e.registrant, e.locatorHost, e.mintBlock, e.secondaryTransferCount, e.handoutCount, e.uriUpdateCount
  FROM agent_directory_entries e
  JOIN ingestion_sources s ON s.id = e.sourceId
  WHERE s.state = 'active'
    AND s.protocol = 'erc8004'
    AND e.hidden = 0
    AND e.assetClosedAt IS NULL
    AND (e.locatorHost IS NULL OR NOT (e.locatorHost = 'agentrank.info' OR e.locatorHost LIKE '%.agentrank.info'))
)
SELECT COUNT(*)                       AS entries,
       COUNT(DISTINCT registrant)     AS distinct_wallets,
       SUM(registrant IS NULL)        AS no_wallet,
       SUM(locatorHost IS NOT NULL)   AS with_https_host,
       COUNT(DISTINCT locatorHost)    AS distinct_hosts,
       SUM(mintBlock IS NOT NULL)     AS mint_measured
FROM v;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q2. How many entries one wallet holds: wallets and entries in each size bucket, and the largest holding in the bucket.
--     (The wallet is the owner named in the registration event: the address that registered the entry.)
-- ---------------------------------------------------------------------------------------------------------------------------
WITH v AS (
  SELECT e.registrant
  FROM agent_directory_entries e
  JOIN ingestion_sources s ON s.id = e.sourceId
  WHERE s.state = 'active'
    AND s.protocol = 'erc8004'
    AND e.hidden = 0
    AND e.assetClosedAt IS NULL
    AND (e.locatorHost IS NULL OR NOT (e.locatorHost = 'agentrank.info' OR e.locatorHost LIKE '%.agentrank.info'))
),
w AS (
  SELECT registrant, COUNT(*) AS n FROM v WHERE registrant IS NOT NULL GROUP BY registrant
)
SELECT CASE WHEN n = 1 THEN '1' WHEN n < 10 THEN '2-9' WHEN n < 100 THEN '10-99' WHEN n < 1000 THEN '100-999' ELSE '1000+' END AS entries_per_wallet,
       COUNT(*)  AS wallets,
       SUM(n)    AS entries,
       MAX(n)    AS largest_holding_in_bucket
FROM w
GROUP BY entries_per_wallet
ORDER BY MIN(n);

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q3. The wallets that hold 100 or more entries, by rank and never by address: how many entries each holds, how many of those
--     have an https link, how many sit on the wallet's own largest host name, and how many host names it uses.
-- ---------------------------------------------------------------------------------------------------------------------------
WITH v AS (
  SELECT e.registrant, e.locatorHost
  FROM agent_directory_entries e
  JOIN ingestion_sources s ON s.id = e.sourceId
  WHERE s.state = 'active'
    AND s.protocol = 'erc8004'
    AND e.hidden = 0
    AND e.assetClosedAt IS NULL
    AND e.registrant IS NOT NULL
    AND (e.locatorHost IS NULL OR NOT (e.locatorHost = 'agentrank.info' OR e.locatorHost LIKE '%.agentrank.info'))
),
w AS (
  SELECT registrant, COUNT(*) AS entries, SUM(locatorHost IS NOT NULL) AS with_https_host, COUNT(DISTINCT locatorHost) AS distinct_hosts
  FROM v GROUP BY registrant HAVING COUNT(*) >= 100
),
wh AS (
  SELECT registrant, locatorHost, COUNT(*) AS n FROM v WHERE locatorHost IS NOT NULL GROUP BY registrant, locatorHost
),
top1 AS (
  SELECT registrant, MAX(n) AS on_largest_host FROM wh GROUP BY registrant
)
SELECT ROW_NUMBER() OVER (ORDER BY w.entries DESC) AS wallet_rank,
       w.entries,
       w.with_https_host,
       COALESCE(top1.on_largest_host, 0) AS on_its_largest_host,
       w.distinct_hosts
FROM w
LEFT JOIN top1 ON top1.registrant = w.registrant
ORDER BY w.entries DESC;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q4. Host names, by size and never by name: the five largest hosts (rank and entries only), and how many hosts hold 50 or more
--     entries (the threshold the BNB endpoint-host rule uses). Host rank 0 is that count.
-- ---------------------------------------------------------------------------------------------------------------------------
WITH v AS (
  SELECT e.locatorHost
  FROM agent_directory_entries e
  JOIN ingestion_sources s ON s.id = e.sourceId
  WHERE s.state = 'active'
    AND s.protocol = 'erc8004'
    AND e.hidden = 0
    AND e.assetClosedAt IS NULL
    AND (e.locatorHost IS NULL OR NOT (e.locatorHost = 'agentrank.info' OR e.locatorHost LIKE '%.agentrank.info'))
),
h AS (
  SELECT locatorHost, COUNT(*) AS n FROM v WHERE locatorHost IS NOT NULL GROUP BY locatorHost
),
ranked AS (
  SELECT n, ROW_NUMBER() OVER (ORDER BY n DESC) AS host_rank FROM h
)
SELECT host_rank, n AS entries
FROM ranked
WHERE host_rank <= 5
UNION ALL
SELECT 0 AS host_rank, COUNT(*) AS entries      -- host_rank 0: how many hosts hold 50 or more entries
FROM h
WHERE n >= 50
ORDER BY host_rank;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q5. Names: how many entries still carry the placeholder the pass gives an entry with no name ("Agent #n"), how many names are
--     distinct, and how many entries share a name with others (group sizes only; no name is returned). The step that reads names
--     from registration links runs every day, so this is a snapshot of a figure that moves.
-- ---------------------------------------------------------------------------------------------------------------------------
WITH v AS (
  SELECT e.displayName, (e.displayName REGEXP '^Agent #[0-9]+$') AS isPlaceholder
  FROM agent_directory_entries e
  JOIN ingestion_sources s ON s.id = e.sourceId
  WHERE s.state = 'active'
    AND s.protocol = 'erc8004'
    AND e.hidden = 0
    AND e.assetClosedAt IS NULL
    AND (e.locatorHost IS NULL OR NOT (e.locatorHost = 'agentrank.info' OR e.locatorHost LIKE '%.agentrank.info'))
),
nm AS (
  SELECT displayName, COUNT(*) AS n FROM v WHERE isPlaceholder = 0 GROUP BY displayName
)
SELECT COUNT(*)                                              AS entries,
       SUM(isPlaceholder = 1)                                AS placeholder_names,
       (SELECT COUNT(*)            FROM nm)                  AS distinct_real_names,
       (SELECT COALESCE(SUM(n), 0) FROM nm WHERE n >= 2)     AS entries_sharing_a_name,
       (SELECT COALESCE(SUM(n), 0) FROM nm WHERE n >= 10)    AS entries_in_names_shared_by_10_or_more,
       (SELECT COALESCE(MAX(n), 0) FROM nm)                  AS largest_name_group
FROM v;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q6. Changes of hands and edits, from the totals the directory keeps for each entry: how many transfers after the mint, how many
--     of them were a hand-out (within about an hour of minting, from the minting wallet), how many profile-link edits, and how
--     many entries each touched. An entry the activity walk has not covered yet has null totals and is not in a sum.
-- ---------------------------------------------------------------------------------------------------------------------------
WITH v AS (
  SELECT e.mintBlock, e.secondaryTransferCount, e.handoutCount, e.uriUpdateCount
  FROM agent_directory_entries e
  JOIN ingestion_sources s ON s.id = e.sourceId
  WHERE s.state = 'active'
    AND s.protocol = 'erc8004'
    AND e.hidden = 0
    AND e.assetClosedAt IS NULL
    AND (e.locatorHost IS NULL OR NOT (e.locatorHost = 'agentrank.info' OR e.locatorHost LIKE '%.agentrank.info'))
)
SELECT COUNT(*)                          AS entries,
       SUM(mintBlock IS NOT NULL)        AS mint_measured,
       SUM(secondaryTransferCount IS NOT NULL) AS covered_by_the_walk,
       COALESCE(SUM(secondaryTransferCount), 0) AS transfers_after_mint,
       COALESCE(SUM(handoutCount), 0)    AS handouts,
       SUM(secondaryTransferCount > 0)   AS entries_that_changed_hands,
       SUM(handoutCount > 0)             AS entries_handed_out,
       COALESCE(SUM(uriUpdateCount), 0)  AS profile_link_edits,
       SUM(uriUpdateCount > 0)           AS entries_edited
FROM v;

-- Q6b. How many transfers after the mint an entry has had, and how many profile-link edits: entries in each size bucket.
WITH v AS (
  SELECT e.secondaryTransferCount AS transfers, e.uriUpdateCount AS edits
  FROM agent_directory_entries e
  JOIN ingestion_sources s ON s.id = e.sourceId
  WHERE s.state = 'active'
    AND s.protocol = 'erc8004'
    AND e.hidden = 0
    AND e.assetClosedAt IS NULL
    AND (e.locatorHost IS NULL OR NOT (e.locatorHost = 'agentrank.info' OR e.locatorHost LIKE '%.agentrank.info'))
)
SELECT 'transfers' AS what,
       CASE WHEN transfers = 0 THEN '0' WHEN transfers = 1 THEN '1' WHEN transfers < 5 THEN '2-4' ELSE '5+' END AS per_entry,
       COUNT(*) AS entries
FROM v WHERE transfers IS NOT NULL
GROUP BY per_entry
UNION ALL
SELECT 'edits' AS what,
       CASE WHEN edits = 0 THEN '0' WHEN edits = 1 THEN '1' WHEN edits < 5 THEN '2-4' ELSE '5+' END AS per_entry,
       COUNT(*) AS entries
FROM v WHERE edits IS NOT NULL
GROUP BY per_entry
ORDER BY what, per_entry;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q7. The activity ledger itself: the events of the source by kind (a mint, a transfer after the mint, a profile-link edit), the
--     entries they belong to, and the oldest and newest block. It holds every event the walk has recorded, hidden entries included.
-- ---------------------------------------------------------------------------------------------------------------------------
SELECT a.kind,
       COUNT(*)                      AS events,
       COUNT(DISTINCT a.externalKey) AS entries,
       MIN(a.blockNumber)            AS oldest_block,
       MAX(a.blockNumber)            AS newest_block
FROM agent_directory_chain_activity a
JOIN ingestion_sources s ON s.id = a.sourceId
WHERE s.protocol = 'erc8004'
GROUP BY a.kind
ORDER BY a.kind;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q8. The reputation ledger: the events of the registry's reputation contract by kind, the agents they are about and the
--     wallets that wrote them. It holds every event recorded, and a revoked rating is still a row of its own.
-- ---------------------------------------------------------------------------------------------------------------------------
SELECT r.kind,
       COUNT(*)                     AS events,
       COUNT(DISTINCT r.agentId)    AS agents,
       COUNT(DISTINCT r.clientAddress) AS wallets,
       MIN(r.blockNumber)           AS oldest_block,
       MAX(r.blockNumber)           AS newest_block
FROM agent_reputation_events r
JOIN ingestion_sources s ON s.id = r.sourceId
WHERE s.protocol = 'erc8004_reputation'
GROUP BY r.kind
ORDER BY r.kind;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q9. Who rated and who was rated, by size: the ratings (new_feedback events) each agent holds and each rating wallet wrote, in
--     size buckets, with the largest in the bucket. Counts only: no agent id and no address is returned.
-- ---------------------------------------------------------------------------------------------------------------------------
WITH ev AS (
  SELECT r.agentId, r.clientAddress
  FROM agent_reputation_events r
  JOIN ingestion_sources s ON s.id = r.sourceId
  WHERE s.protocol = 'erc8004_reputation'
    AND r.kind = 'new_feedback'
),
per_agent AS (
  SELECT agentId, COUNT(*) AS n FROM ev GROUP BY agentId
),
per_wallet AS (
  SELECT clientAddress, COUNT(*) AS n FROM ev GROUP BY clientAddress
)
SELECT side, ratings_each, members, ratings, largest_in_bucket
FROM (
  SELECT 'agents' AS side,
         CASE WHEN n = 1 THEN '1' WHEN n < 5 THEN '2-4' WHEN n < 20 THEN '5-19' WHEN n < 100 THEN '20-99' ELSE '100+' END AS ratings_each,
         COUNT(*) AS members,
         SUM(n)   AS ratings,
         MAX(n)   AS largest_in_bucket
  FROM per_agent
  GROUP BY ratings_each
  UNION ALL
  SELECT 'wallets' AS side,
         CASE WHEN n = 1 THEN '1' WHEN n < 5 THEN '2-4' WHEN n < 20 THEN '5-19' WHEN n < 100 THEN '20-99' ELSE '100+' END AS ratings_each,
         COUNT(*) AS members,
         SUM(n)   AS ratings,
         MAX(n)   AS largest_in_bucket
  FROM per_wallet
  GROUP BY ratings_each
) t
ORDER BY side, FIELD(ratings_each, '1', '2-4', '5-19', '20-99', '100+');
