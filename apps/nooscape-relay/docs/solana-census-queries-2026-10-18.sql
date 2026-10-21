-- Solana registry census: measurement queries (read-only).
--
-- Run these against the Nooscape database (MySQL 8). Every statement is a SELECT. None writes anything, and none returns a
-- name, a wallet address or a host name: the output is counts and size buckets only, so it is safe to paste back.
--
-- "Visible" is the site's own rule (server/db.ts, directoryVisibilityCondition): the source is active, the entry is not hidden,
-- the chain pass has not seen its asset close, and its locator host is not on the suppressed domain (agentrank.info). Each
-- statement starts with the same WITH clause so it can be run on its own.
--
-- The three registries are solana_said (SAID), solana_8004 (the 8004 registry) and solana_registry (Metaplex).

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q0. As of when: the visible entries and the newest time a pass saw one, and when each source last succeeded.
-- ---------------------------------------------------------------------------------------------------------------------------
SELECT e.protocol,
       COUNT(*)            AS visible_entries,
       MIN(e.firstSeenAt)  AS first_seen_min,
       MAX(e.lastSeenAt)   AS last_seen_max,
       MAX(s.lastSuccessfulAt) AS source_last_success
FROM agent_directory_entries e
JOIN ingestion_sources s ON s.id = e.sourceId
WHERE s.state = 'active'
  AND s.protocol IN ('solana_said', 'solana_8004', 'solana_registry')
  AND e.hidden = 0
  AND e.assetClosedAt IS NULL
  AND (e.locatorHost IS NULL OR NOT (e.locatorHost = 'agentrank.info' OR e.locatorHost LIKE '%.agentrank.info'))
GROUP BY e.protocol
ORDER BY e.protocol;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q1. Size and surface of each registry: entries, wallets, links, hosts.
-- ---------------------------------------------------------------------------------------------------------------------------
WITH v AS (
  SELECT e.protocol, e.externalKey, e.displayName, e.locatorHost, e.registrant, e.profileUriHash, e.feedbackCount, e.sourceSignalNote,
         ((e.protocol = 'solana_said' AND e.displayName REGEXP '^SAID agent [1-9A-HJ-NP-Za-km-z]{8}$')
          OR (e.protocol = 'solana_8004' AND e.displayName REGEXP '^8004 agent ')
          OR (e.protocol = 'solana_registry' AND (e.displayName REGEXP '^Metaplex agent ' OR e.displayName REGEXP '^Unnamed registry agent '))) AS isPlaceholder
  FROM agent_directory_entries e
  JOIN ingestion_sources s ON s.id = e.sourceId
  WHERE s.state = 'active'
    AND s.protocol IN ('solana_said', 'solana_8004', 'solana_registry')
    AND e.hidden = 0
    AND e.assetClosedAt IS NULL
    AND (e.locatorHost IS NULL OR NOT (e.locatorHost = 'agentrank.info' OR e.locatorHost LIKE '%.agentrank.info'))
)
SELECT protocol,
       COUNT(*)                                   AS entries,
       COUNT(DISTINCT registrant)                 AS distinct_wallets,
       SUM(registrant IS NULL)                    AS no_wallet,
       SUM(profileUriHash IS NOT NULL)            AS with_link,
       COUNT(DISTINCT profileUriHash)             AS distinct_links,
       SUM(locatorHost IS NOT NULL)               AS with_https_host,
       COUNT(DISTINCT locatorHost)                AS distinct_hosts
FROM v
GROUP BY protocol
ORDER BY protocol;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q2. How many entries one wallet holds: wallets and entries in each size bucket, and the largest holding, per registry.
--     (The wallet is the owner the chain records; for SAID, the authority.)
-- ---------------------------------------------------------------------------------------------------------------------------
WITH v AS (
  SELECT e.protocol, e.registrant
  FROM agent_directory_entries e
  JOIN ingestion_sources s ON s.id = e.sourceId
  WHERE s.state = 'active'
    AND s.protocol IN ('solana_said', 'solana_8004', 'solana_registry')
    AND e.hidden = 0
    AND e.assetClosedAt IS NULL
    AND (e.locatorHost IS NULL OR NOT (e.locatorHost = 'agentrank.info' OR e.locatorHost LIKE '%.agentrank.info'))
),
w AS (
  SELECT protocol, registrant, COUNT(*) AS n FROM v WHERE registrant IS NOT NULL GROUP BY protocol, registrant
)
SELECT protocol,
       CASE WHEN n = 1 THEN '1' WHEN n < 10 THEN '2-9' WHEN n < 100 THEN '10-99' WHEN n < 1000 THEN '100-999' ELSE '1000+' END AS entries_per_wallet,
       COUNT(*)  AS wallets,
       SUM(n)    AS entries,
       MAX(n)    AS largest_holding_in_bucket
FROM w
GROUP BY protocol, entries_per_wallet
ORDER BY protocol, MIN(n);

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q3. How many entries share one link: groups and entries in each size bucket, and the largest group, per registry.
-- ---------------------------------------------------------------------------------------------------------------------------
WITH v AS (
  SELECT e.protocol, e.profileUriHash
  FROM agent_directory_entries e
  JOIN ingestion_sources s ON s.id = e.sourceId
  WHERE s.state = 'active'
    AND s.protocol IN ('solana_said', 'solana_8004', 'solana_registry')
    AND e.hidden = 0
    AND e.assetClosedAt IS NULL
    AND (e.locatorHost IS NULL OR NOT (e.locatorHost = 'agentrank.info' OR e.locatorHost LIKE '%.agentrank.info'))
),
l AS (
  SELECT protocol, profileUriHash, COUNT(*) AS n FROM v WHERE profileUriHash IS NOT NULL GROUP BY protocol, profileUriHash
)
SELECT protocol,
       CASE WHEN n = 1 THEN '1' WHEN n < 10 THEN '2-9' WHEN n < 100 THEN '10-99' ELSE '100+' END AS entries_sharing_a_link,
       COUNT(*)  AS links,
       SUM(n)    AS entries,
       MAX(n)    AS largest_group_in_bucket
FROM l
GROUP BY protocol, entries_sharing_a_link
ORDER BY protocol, MIN(n);

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q4. Host names, by size and never by name: the five largest hosts of each registry (rank and entries only), and how many
--     hosts hold 50 or more entries (the threshold the BNB endpoint-host rule uses).
-- ---------------------------------------------------------------------------------------------------------------------------
WITH v AS (
  SELECT e.protocol, e.locatorHost
  FROM agent_directory_entries e
  JOIN ingestion_sources s ON s.id = e.sourceId
  WHERE s.state = 'active'
    AND s.protocol IN ('solana_said', 'solana_8004', 'solana_registry')
    AND e.hidden = 0
    AND e.assetClosedAt IS NULL
    AND (e.locatorHost IS NULL OR NOT (e.locatorHost = 'agentrank.info' OR e.locatorHost LIKE '%.agentrank.info'))
),
h AS (
  SELECT protocol, locatorHost, COUNT(*) AS n FROM v WHERE locatorHost IS NOT NULL GROUP BY protocol, locatorHost
),
ranked AS (
  SELECT protocol, n, ROW_NUMBER() OVER (PARTITION BY protocol ORDER BY n DESC) AS host_rank FROM h
)
SELECT protocol, host_rank, n AS entries
FROM ranked
WHERE host_rank <= 5
UNION ALL
SELECT protocol, 0 AS host_rank, COUNT(*) AS entries      -- host_rank 0: how many hosts hold 50 or more entries
FROM h
WHERE n >= 50
GROUP BY protocol
ORDER BY protocol, host_rank;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q5. SAID only: what the chain records (read from the note the pass writes): layout, registration month, the badge, the stake.
--     The badge is paid or sponsored, not an identity check, and is counted as exactly that.
-- ---------------------------------------------------------------------------------------------------------------------------
WITH v AS (
  SELECT e.sourceSignalNote AS note
  FROM agent_directory_entries e
  JOIN ingestion_sources s ON s.id = e.sourceId
  WHERE s.state = 'active'
    AND s.protocol = 'solana_said'
    AND e.hidden = 0
    AND e.assetClosedAt IS NULL
    AND (e.locatorHost IS NULL OR NOT (e.locatorHost = 'agentrank.info' OR e.locatorHost LIKE '%.agentrank.info'))
)
SELECT 'layout' AS facet, COALESCE(REGEXP_SUBSTR(note, 'layout v[0-9]'), '(not recorded)') AS value, COUNT(*) AS entries FROM v GROUP BY 1, 2
UNION ALL
SELECT 'registered_month', COALESCE(REGEXP_SUBSTR(note, 'registered [0-9]{4}-[0-9]{2}'), '(not recorded)'), COUNT(*) FROM v GROUP BY 1, 2
UNION ALL
SELECT 'badge', COALESCE(REGEXP_SUBSTR(note, 'badge: (yes|no)'), '(not recorded)'), COUNT(*) FROM v GROUP BY 1, 2
UNION ALL
SELECT 'stake', CASE WHEN note LIKE '%stake: none%' THEN 'stake: none' WHEN note LIKE '%stake: %' THEN 'stake: some' ELSE '(not recorded: layouts 1 and 2)' END, COUNT(*) FROM v GROUP BY 1, 2
UNION ALL
SELECT 'slashes', CASE WHEN note LIKE '%slashes: 0%' THEN 'slashes: 0' WHEN note LIKE '%slashes: %' THEN 'slashes: more than 0' ELSE '(not recorded: layouts 1 and 2)' END, COUNT(*) FROM v GROUP BY 1, 2
ORDER BY 1, 2;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q6. 8004 only: the registry's own feedback counters. Agents in each size bucket and the ratings they hold, and the share
--     of all ratings that the ten agents with the most hold.
-- ---------------------------------------------------------------------------------------------------------------------------
WITH v AS (
  SELECT e.feedbackCount
  FROM agent_directory_entries e
  JOIN ingestion_sources s ON s.id = e.sourceId
  WHERE s.state = 'active'
    AND s.protocol = 'solana_8004'
    AND e.hidden = 0
    AND e.assetClosedAt IS NULL
    AND (e.locatorHost IS NULL OR NOT (e.locatorHost = 'agentrank.info' OR e.locatorHost LIKE '%.agentrank.info'))
)
SELECT CASE WHEN feedbackCount IS NULL THEN '(counter not read)' WHEN feedbackCount = 0 THEN '0' WHEN feedbackCount < 5 THEN '1-4'
            WHEN feedbackCount < 20 THEN '5-19' WHEN feedbackCount < 100 THEN '20-99' ELSE '100+' END AS ratings_per_agent,
       COUNT(*)                        AS agents,
       COALESCE(SUM(feedbackCount), 0) AS ratings
FROM v
GROUP BY ratings_per_agent
ORDER BY MIN(COALESCE(feedbackCount, -1));

WITH v AS (
  SELECT e.feedbackCount
  FROM agent_directory_entries e
  JOIN ingestion_sources s ON s.id = e.sourceId
  WHERE s.state = 'active'
    AND s.protocol = 'solana_8004'
    AND e.hidden = 0
    AND e.assetClosedAt IS NULL
    AND (e.locatorHost IS NULL OR NOT (e.locatorHost = 'agentrank.info' OR e.locatorHost LIKE '%.agentrank.info'))
)
SELECT (SELECT COALESCE(SUM(feedbackCount), 0) FROM (SELECT feedbackCount FROM v ORDER BY feedbackCount DESC LIMIT 10) t) AS ratings_of_top_10_agents,
       (SELECT COALESCE(SUM(feedbackCount), 0) FROM v) AS ratings_of_all_agents;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q7. Metaplex only: which kind of row each entry is (the note says which pass wrote it and what the record held).
-- ---------------------------------------------------------------------------------------------------------------------------
SELECT LEFT(e.sourceSignalNote, 60) AS note_kind, COUNT(*) AS entries
FROM agent_directory_entries e
JOIN ingestion_sources s ON s.id = e.sourceId
WHERE s.state = 'active'
  AND s.protocol = 'solana_registry'
  AND e.hidden = 0
  AND e.assetClosedAt IS NULL
  AND (e.locatorHost IS NULL OR NOT (e.locatorHost = 'agentrank.info' OR e.locatorHost LIKE '%.agentrank.info'))
GROUP BY note_kind
ORDER BY entries DESC;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q8. Names: how many entries still carry the placeholder the pass gives an entry with no name, how many names are distinct,
--     and how many entries share a name with others (group sizes only; no name is returned).
--     SAID names are still being read (about 14 days from 2026-10-18), so the SAID figures here are a snapshot, not a result.
-- ---------------------------------------------------------------------------------------------------------------------------
WITH v AS (
  SELECT e.protocol, e.displayName,
         ((e.protocol = 'solana_said' AND e.displayName REGEXP '^SAID agent [1-9A-HJ-NP-Za-km-z]{8}$')
          OR (e.protocol = 'solana_8004' AND e.displayName REGEXP '^8004 agent ')
          OR (e.protocol = 'solana_registry' AND (e.displayName REGEXP '^Metaplex agent ' OR e.displayName REGEXP '^Unnamed registry agent '))) AS isPlaceholder
  FROM agent_directory_entries e
  JOIN ingestion_sources s ON s.id = e.sourceId
  WHERE s.state = 'active'
    AND s.protocol IN ('solana_said', 'solana_8004', 'solana_registry')
    AND e.hidden = 0
    AND e.assetClosedAt IS NULL
    AND (e.locatorHost IS NULL OR NOT (e.locatorHost = 'agentrank.info' OR e.locatorHost LIKE '%.agentrank.info'))
),
nm AS (
  SELECT protocol, displayName, COUNT(*) AS n FROM v WHERE isPlaceholder = 0 GROUP BY protocol, displayName
)
SELECT v.protocol,
       COUNT(*)                                                   AS entries,
       SUM(v.isPlaceholder = 1)                                   AS placeholder_names,
       (SELECT COUNT(*)                FROM nm WHERE nm.protocol = v.protocol)               AS distinct_real_names,
       (SELECT COALESCE(SUM(n), 0)     FROM nm WHERE nm.protocol = v.protocol AND n >= 2)    AS entries_sharing_a_name,
       (SELECT COALESCE(SUM(n), 0)     FROM nm WHERE nm.protocol = v.protocol AND n >= 10)   AS entries_in_names_shared_by_10_or_more,
       (SELECT COALESCE(MAX(n), 0)     FROM nm WHERE nm.protocol = v.protocol)               AS largest_name_group
FROM v
GROUP BY v.protocol
ORDER BY v.protocol;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Q9. Wallets recorded in more than one registry: how many wallets appear in one, two or all three, and the entries they hold.
--     A wallet recorded in two registries is a recorded fact. It does not say that one operator runs both.
-- ---------------------------------------------------------------------------------------------------------------------------
WITH v AS (
  SELECT e.protocol, e.registrant
  FROM agent_directory_entries e
  JOIN ingestion_sources s ON s.id = e.sourceId
  WHERE s.state = 'active'
    AND s.protocol IN ('solana_said', 'solana_8004', 'solana_registry')
    AND e.hidden = 0
    AND e.assetClosedAt IS NULL
    AND (e.locatorHost IS NULL OR NOT (e.locatorHost = 'agentrank.info' OR e.locatorHost LIKE '%.agentrank.info'))
),
w AS (
  SELECT registrant, COUNT(DISTINCT protocol) AS registries, COUNT(*) AS entries FROM v WHERE registrant IS NOT NULL GROUP BY registrant
)
SELECT registries AS registries_the_wallet_is_in, COUNT(*) AS wallets, SUM(entries) AS entries
FROM w
GROUP BY registries
ORDER BY registries;

