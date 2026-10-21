# The IPFS gateway for the 8004 name reads (2026-10-16)

**Status:** live since 2026-10-16. The gateway runs, `ipfs.nooscape.si` points at it, and `NOOSCAPE_IPFS_GATEWAY` is set in the app's environment (checked by name, the value is masked). The first pass to use it, which finished at 14:15Z, put real names in the public directory that a search had not found ten minutes earlier (see "What was measured"). What is left is the reset of the rows that failed while the public gateways refused, and reading the counts after a pass or two (the end of this record).

About 755 of the registration links in the 8004 registry on Solana are `ipfs://` links, and the file behind each one carries the agent's display name. Reading them needs an IPFS gateway: a server that fetches a file by its CID from the IPFS network and returns it over https. This record is the decision to run one, what runs, how it is reached, what it was measured to cost, and how to set it up again.

## Why Nooscape runs its own

Production set no `NOOSCAPE_IPFS_GATEWAY`, so every ipfs link went to `https://ipfs.io/ipfs/<cid>`. That gateway answers **HTTP 429 with `retry-after: 900`** to every request that is not a browser, whatever the user agent. `dweb.link`, `w3s.link` and `nftstorage.link` do the same. The production table agreed: `agent_registration_resolutions` held 435 ipfs links tried and failed with HTTP 429, and none resolved.

The alternatives were checked on 2026-10-16:

- **Commercial gateways** (`ipfs.filebase.io`, `4everland.io`, `gateway.pinata.cloud`) answered some CIDs and not others. Pinata took 3 to 6 seconds and refuses robots.txt without a key, which the polite fetcher reads as "ask nothing".
- **A free dedicated Pinata gateway** serves only files pinned in the owner's own account. Any other CID answered HTTP 403, and the plan holds 500 files.
- **Rainbow**, the retrieval-only gateway of the IPFS project, answered all 25 test links (below).

Rainbow fetches blocks from the providers that routers name for a CID, checks each block against its hash, and returns the file. It pins nothing. What it holds is a cache that its own garbage collection clears.

## What runs

Docker project `rainbow-ipfs` on a Hostinger VPS (shared with other projects), published only on `127.0.0.1:8090`, so nothing but the nginx on the same machine can reach it.

```yaml
services:
  rainbow:
    image: ghcr.io/ipfs/rainbow:v1.24.1@sha256:4456aefbe0979d1bb24ced8d4953cf8dbece3251fc8833b1873fab4b2fa131ce
    restart: unless-stopped
    ports:
      - "127.0.0.1:8090:8090"
    environment:
      RAINBOW_GATEWAY_LISTEN_ADDRESS: "0.0.0.0:8090"
      RAINBOW_GATEWAY_DOMAINS: "ipfs.nooscape.si"
      RAINBOW_DHT_ROUTING: "off"
      RAINBOW_LIBP2P_MAX_MEMORY: "268435456"
      RAINBOW_MAX_CONCURRENT_REQUESTS: "16"
      RAINBOW_MAX_UNIXFS_DAG_RESPONSE_SIZE: "1048576"
    volumes:
      - rainbow-data:/data/rainbow
    mem_limit: 768m
    cpus: 1.0
    healthcheck:
      test: ["CMD", "curl", "-fsS", "-o", "/dev/null", "http://127.0.0.1:8090/ipfs/bafkqaaa"]
      interval: 60s
      timeout: 10s
      retries: 3
      start_period: 60s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  rainbow-data:
```

The image is pinned by the digest of its multi-arch index, which is also what the `v1.24.1` tag points at. What each setting is for:

| Setting | Why |
|---|---|
| `RAINBOW_GATEWAY_LISTEN_ADDRESS` | Rainbow listens on loopback inside the container by default, which the published port could not reach. The port is published to the host's loopback only. |
| `RAINBOW_GATEWAY_DOMAINS` | The host name nginx sends. It makes `ipfs.nooscape.si` a flat path gateway, with no subdomain gateway. |
| `RAINBOW_DHT_ROUTING=off` | The default (`accelerated`) crawls the whole DHT in the background. In the first test run (denylist on) it held a full CPU core at rest, moved 247 MB in a few minutes and logged that it could not finish refreshing its routing table within the libp2p limits set for it. With it off the same machine idled at 0.02 percent CPU, and about 490 MB less memory. Providers still come from the HTTP routers (`cid.contact` and `delegated-ipfs.dev`), and all 25 test links came back in under 2 seconds. |
| `RAINBOW_LIBP2P_MAX_MEMORY` | The default is 85 percent of the system's memory, which on a shared 16 GB machine is no limit. |
| `RAINBOW_MAX_CONCURRENT_REQUESTS` | The default is 4096. Above 16 at once, Rainbow answers 429 (its documented behavior, not tested here). The checker asks one at a time. |
| `RAINBOW_MAX_UNIXFS_DAG_RESPONSE_SIZE` | Content over 1 MiB answers 410 (documented, not tested here). The reader stops at 256 KiB, and a registration file is a few hundred bytes. |
| `mem_limit`, `cpus`, log rotation | The machine is shared. The container is capped at 768 MB and one core, and its logs at three files of 10 MB. |
| The health check | `bafkqaaa` is the identity CID of an empty file, so it answers without the network. It shows the process is serving, not that the network is reachable. |

**No denylist.** Rainbow can subscribe to the badbits list (`RAINBOW_DENYLISTS=https://badbits.dwebops.pub/badbits.deny`; `denyli.st` no longer resolves). Measured on the test machine it costs 513 MB of memory and a 34 MB download on the first start. It is left off because only the checker can reach this gateway and only a JSON `name` is read from what it returns. The registrant of an agent chooses the CID, so the gateway may fetch content nobody reviewed; the reader keeps at most 256 KiB, parses it as JSON, stores a name of at most 200 characters, and the cache is cleared by garbage collection. If the gateway ever serves anyone else, turn the denylist on first.

## How it is reached

- **DNS:** an A record `ipfs.nooscape.si` to that VPS's public address, TTL 300, in the Hostinger zone for `nooscape.si`. The zone's CAA record already allows Let's Encrypt.
- **nginx** on the same VPS (the host's own nginx, with a Let's Encrypt certificate) in `/etc/nginx/conf.d/ipfs.nooscape.si.conf`:

```nginx
limit_req_zone $binary_remote_addr zone=ipfs_gateway:1m rate=10r/s;

server {
    listen 80;
    server_name ipfs.nooscape.si;

    location = /robots.txt {
        default_type text/plain;
        return 200 "User-agent: *\nAllow: /\n";
    }

    location /SECRET_PLACEHOLDER/ipfs/ {
        limit_except GET HEAD {
            deny all;
        }
        limit_req zone=ipfs_gateway burst=20 nodelay;
        rewrite ^/SECRET_PLACEHOLDER(/ipfs/.*)$ $1 break;
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Host ipfs.nooscape.si;
        proxy_set_header Connection "";
        proxy_connect_timeout 5s;
        proxy_read_timeout 30s;
    }

    location / {
        return 404;
    }
}
```

`certbot --nginx -d ipfs.nooscape.si --redirect` then adds the certificate and the https server.

- **The secret path.** The gateway fetches any CID anyone names, so without a prefix it would be a free public gateway at Nooscape's cost. `SECRET_PLACEHOLDER` is 32 random hex characters generated on the VPS (`openssl rand -hex 16`). It is kept in that nginx file and in the app's `NOOSCAPE_IPFS_GATEWAY`. It is not in this repository, and the name-read path writes no URL to a log or a table: the stored failure reason is `<reason>: <detail>` where the detail is fixed text or an error code (`safeFetch.ts` and `politeFetch.ts` build every detail from literals).
- **What answers.** `/robots.txt` answers 200 with `Allow: /`, because the checker reads it first. Anything else outside the prefix answers 404. Under the prefix only `/ipfs/...` is passed on, for GET and HEAD. More than 10 requests a second from one address answers 503 (a burst of 20 is allowed).

## The app side

- `NOOSCAPE_IPFS_GATEWAY=https://ipfs.nooscape.si/<secret>/ipfs/`, set by the operator in the Node.js app's environment in hPanel. The reader joins `ipfs://<cid>[/path]` onto it as `<gateway><cid>[/path]`, and the result goes through the same polite fetcher as every other link: https only, the connection pinned, robots.txt first, one request a second to a host, 5 seconds, 256 KiB.
- **A link without a CID is asked of no one.** In a sample of 25 ipfs links from the table, 5 were `ipfs://placeholder/NN`. Before this change each of those cost requests and up to five failed tries. Now the first part of the link has to be at least 44 letters and digits (the shortest real CID, a v0 hash, has 46), and anything else is recorded `no_name` without a request, the same as a file with no name in it.
- `/checker` says "an IPFS gateway" where it said "a public IPFS gateway", and a test fails if "public" comes back.
- **Pass time.** A queue of 30 ipfs links is all one host, so a pass spends about 30 seconds in the gaps plus 0.4 to 1.7 seconds a read, roughly 40 to 80 seconds in all. The worker tick is at capacity (see [worker-operations](worker-operations.md)), so this is worth watching. A shorter gap for the gateway would save about 25 seconds a pass, and is not done because `/checker` promises one request a second to a host name.

## What was measured

All of it on 2026-10-16, on the operator's PC (the same compose file, a fresh data volume for each run), asking 25 real CIDs from the production table one at a time (one v0 `Qm...` and 24 v1 `bafkrei...`). Every file came back as JSON with a `name`.

| Run | Result | Memory after the run | CPU after the run |
|---|---|---|---|
| Accelerated DHT (Rainbow's default), denylist on | 25 of 25, 21 within 2 s, slowest 3.7 s | about 1 GB | a full core, 247 MB of traffic in |
| DHT off, denylist on | 25 of 25, all within 2 s, slowest 1.8 s | 528 MB | 0.02 percent |
| DHT off, no denylist (the deployed settings) | 25 of 25, all within 2 s, slowest 1.7 s | 14 MB | 0.02 percent |

The memory and CPU of "accelerated, no denylist" were not measured; the rows above show the crawl at about 490 MB and a core, and the denylist at about 510 MB.

The nginx file was run in a throwaway nginx container against Rainbow: `robots.txt` 200; `/` and `/ipfs/<cid>` without the prefix 404; a wrong prefix 404; the prefix with a real CID returned the registration JSON; POST 403; `/<prefix>/api/v0/id` and `/<prefix>/ipns/...` 404; a parallel burst of 120 requests got 101 answers and 19 times 503.

On the VPS the project came up healthy and uses 13 MB. From outside, `https://ipfs.nooscape.si/robots.txt` answers 200, `/ipfs/bafkqaaa` without the prefix answers 404, http redirects to https, and the certificate is Let's Encrypt's. Through the prefix, the 8004 pass that finished at 14:15Z was the first to read through the gateway. A directory search at 14:05Z found no "SolMonk" and no "Research Curator" entry. At 14:16Z it found "SolMonk #102", "SolMonk #104", "SolMonk #57" and "Research Curator Agent", names of the kind the test links carry. That is the first sign, from outside the database, that the prefix in the app's variable matches the one in nginx and that the reader got files through the gateway.

## Setting it up again

1. Deploy the compose file above as project `rainbow-ipfs` (the Hostinger API `vps_docker_create`, or `docker compose -p rainbow-ipfs up -d` on the box).
2. Add the A record.
3. On the VPS, as root: generate the prefix with `openssl rand -hex 16`, write the nginx file with it in place of `SECRET_PLACEHOLDER`, run `nginx -t` and reload (a bad file stops every site on the machine, so always test first), then run certbot.
4. Check it: `/robots.txt` answers 200, `/ipfs/bafkqaaa` answers 404, and `https://ipfs.nooscape.si/<prefix>/ipfs/bafkreig7zddhseoj47nzdoclad644agf5x4ygozr6rqnpo332fxewi5cdi` returns a JSON registration file named "SolMonk #79".
5. Set `NOOSCAPE_IPFS_GATEWAY` to `https://ipfs.nooscape.si/<prefix>/ipfs/` (copy it from the command that prints it, not by hand) and restart the app.
6. Reopen the links that failed while the public gateways refused them. The retry rule gives up at five tries, so the 435 rows from the 429 period need their count reset:

```sql
UPDATE agent_registration_resolutions SET attempts = 0 WHERE uriKind = 'ipfs' AND status = 'failed';
```

## What to watch

The first passes after the reset read up to 30 links each. To see what they did:

```sql
SELECT uriKind, status, COUNT(*) FROM agent_registration_resolutions GROUP BY uriKind, status;
SELECT failReason, COUNT(*) FROM agent_registration_resolutions WHERE uriKind = 'ipfs' AND status = 'failed' GROUP BY failReason ORDER BY 2 DESC LIMIT 5;
```

The ipfs `resolved` count should rise by up to 30 a pass, and the ipfs `no_name` count by the placeholders. What a failure looks like:

- `timeout: ...`: no provider answered within 5 seconds. The next try may succeed, because Rainbow keeps what it fetched.
- `HTTP 429`: from the gateway, more than 16 requests at once (the checker asks one at a time, so something else is using it), or from `ipfs.io` when the variable is not set. A 503 from nginx means more than 10 a second from one address.
- `connection_failed` or `tls_failed`: the project or nginx is down. Check the project (`vps_docker_containers`) and `nginx -t`.
- `HTTP 404`: nginx did not recognize the path, which almost always means the prefix in `NOOSCAPE_IPFS_GATEWAY` differs from the one in the nginx file. A 404 from a gateway is a failed try on purpose. For an ordinary web link a 404 means the file is gone and the link is settled, but here one mistyped character would settle every ipfs link it is asked about. Correct the variable and run the reset.
- A 410 from the gateway is recorded `no_name`, like a deleted file. Rainbow answers 410 for content over 1 MiB.

If it has to be switched off, remove `NOOSCAPE_IPFS_GATEWAY` and the reader goes back to `ipfs.io`, which answers 429, so the names stay as placeholders. Stop the project with `docker compose -p rainbow-ipfs down` (the Hostinger API `vps_docker_delete` also removes the data volume).

To change the secret, edit the prefix in the nginx file (the `location` line and the `rewrite` line), reload, and change `NOOSCAPE_IPFS_GATEWAY` to match. To update Rainbow, change the digest in the compose file and deploy again; the volume is kept.

## Costs and risks

- **Memory and CPU:** 13 MB and about nothing at rest, capped at 768 MB and one core.
- **Disk:** the cache is small and cleared by Rainbow's garbage collection; logs are capped at 30 MB. The same VPS's disk was at 144 GB of 200 GB (72 percent) on 2026-10-16, growing about 4.5 GB a day before Rainbow was deployed.
- **Network:** with the DHT off, Rainbow dials the providers that the HTTP routers name for a link being read. A provider's abuse desk can mistake libp2p dials for scanning; if one arrives, stopping the project ends it.
- **Content:** the registrant chooses the CID (see the denylist note above).
- **Single machine:** one VPS, one project, no failover. If it is down, ipfs names stay as placeholders and the other reads are unaffected.
- **Upstream:** the Rainbow README says it has no dedicated maintainer at the moment. The image is pinned, so nothing changes under the project unless the digest is changed here.

## Also used by the Robinhood names (2026-10-17)

The step that reads the registration link of a reviewed Robinhood record for its name (docs/approvals/2026-10-17-robinhood-names.md) uses the same reader, so its ipfs links go through this gateway too. Six of the 15 nameless reviewed Robinhood records have an ipfs link, and so do some of the 8,839 acknowledged entries the same step names (docs/approvals/2026-10-17-robinhood-entry-names.md; a sample of 40 found 1 inline, 1 empty and 37 https links, so ipfs is a minority). The extra load is at most 16 links every 30 minutes, ipfs and web together, and only for links not yet read.

## The check that closes this record

After the operator has run the reset, read the two queries above after a pass or two. When the ipfs `resolved` count has grown by about the size of a pass for several passes and the rows from the 429 period have been retried, tick this record in the next docs change.
