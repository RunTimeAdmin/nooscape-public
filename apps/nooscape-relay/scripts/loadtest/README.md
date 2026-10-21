# Local pressure test

Tools to drive a production build of the server with simulated viewers and watch what the server, the database, and the process do. Everything runs on this machine. The live site limits each client address to 600 API requests per 5 minutes, so one machine cannot load production in a way that means anything, and a test that could would risk the host limits it is meant to check. `run.mjs` and `probe.mjs` refuse a target that is not on this machine unless `--allow-remote` is given, which should only happen with the site owner's go-ahead and a plan to stop.

## One-time setup

A throwaway MySQL (the same one the database-backed tests use):

```bash
MSYS_NO_PATHCONV=1 docker run -d --name nooscape-gate-test -e MYSQL_ROOT_PASSWORD=nooscape -p 127.0.0.1:3307:3306 --tmpfs /var/lib/mysql mysql:8
```

Then build the app and a database seeded to production scale (about 247k directory entries, 373k BNB Chain registry rows, 82 reviewed records; it takes a few minutes and about 1.2 GB of memory):

```bash
pnpm build
pnpm exec tsx scripts/loadtest/seed.ts nooscape_load
```

`seed.ts` drops the named database first and refuses any server that is not on this machine. Pass `census-only` as a third argument to add just the reviewed census to a database already built.

## The tools

| Tool | What it does |
| --- | --- |
| `probe.mjs --spawn` | Times every public read on its own, one request at a time (one cold, four warm). This separates an endpoint's own cost from queueing behind other viewers. |
| `run.mjs --spawn` | Starts `dist/index.js` and drives N viewers: a page load, then a batched read of the polled queries every 20 s, the evidence panel every 8 s, and now and then a search or an agent page. Each viewer sends its own `X-Forwarded-For`, which is how distinct clients look to the rate limiter (the app trusts one proxy hop). |
| `cpuprofile.mjs` | Profiles a running server's CPU through its inspector (start it with `node --inspect=9230 dist/index.js`) and prints the top functions and the longest stretch without an idle sample. |

Useful `run.mjs` options: `--viewers`, `--duration`, `--ramp` (seconds to bring the viewers in), `--poll-scale` (0.25 polls four times as often), `--search-every` (seconds between searches per viewer, scaled by poll scale), `--churn` (viewers leave after about N seconds and are replaced), `--trace file.tsv` (one line per request, to see when slow requests were issued), `--cold` (do not wait for the caches to warm first).

By default `run.mjs` waits until the polled reads answer quickly, so the numbers describe a site that has been up a while. Use `--cold` for the first minute after a deploy.

## Reading the output

- **Success is not only HTTP 200.** The public procedures swallow database errors and answer with empty data (they fail closed), so each answer is checked for the data the seeded database must produce. An empty answer counts as `degr`, not as success.
- `database: N connections opened, M in the second half` is the number to compare with the host's cap of 500 new connections an hour. The pool fills once; what matters is the second half.
- `load generator: worst event-loop lag` says whether the generator itself kept up. If it is large, the latencies include its own queueing.
- This machine has four logical CPUs shared by MySQL's VM, the server, and the generator, and the database's buffer pool is the 128 MB default, so absolute numbers are pessimistic. Compare runs with each other.

## Failure drills

Each of these has been run and the server recovered without a restart.

```bash
# Kill every database connection every 10 s under 200 viewers (about 1% of answers come back empty around each kill)
node scripts/loadtest/run.mjs --spawn --database nooscape_load --viewers 200 --duration 60 --kill-every 10

# Freeze the database for 20 s (requests wait out the freeze; there is no query timeout)
node scripts/loadtest/run.mjs --spawn --database nooscape_load --viewers 200 --duration 70 --pause-container nooscape-gate-test --pause-at 25 --pause-for 20

# Replay the host's hourly connection cap: a MySQL user allowed 40 new connections an hour
docker exec nooscape-gate-test mysql -uroot -pnooscape -e "CREATE USER 'loadcap'@'%' IDENTIFIED BY 'loadcap' WITH MAX_CONNECTIONS_PER_HOUR 40; GRANT ALL ON nooscape_load.* TO 'loadcap'@'%';"
node scripts/loadtest/run.mjs --spawn --database nooscape_load --app-user loadcap:loadcap --cold --viewers 100 --duration 60 --kill-every 8
# clear the counter afterwards: FLUSH USER_RESOURCES
```

## Results

The measurements and the changes they led to are recorded in [docs/pressure-test-2026-10-14.md](../../docs/pressure-test-2026-10-14.md).
