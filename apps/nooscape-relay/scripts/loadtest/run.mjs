#!/usr/bin/env node
/**
 * Pressure test for the public site: virtual viewers that behave like the Home
 * page (one batched read of the polled queries every 20 s, now and then a search
 * or an agent page), run against a server on this machine. The evidence panel's read
 * every 8 s is not modelled: it needs the id of a reviewed record. It can start the production build itself, so it knows the process,
 * reads its log, and measures the database from the outside.
 *
 *   node scripts/loadtest/run.mjs --spawn --database nooscape_load --viewers 250 --duration 120
 *
 * Why local: the live API limits each client address to 600 requests per 5
 * minutes, so one machine cannot put real load on production, and a test that
 * could would risk the very limits it is meant to check. Locally each viewer
 * sends its own X-Forwarded-For (the app trusts one proxy hop), which is how
 * distinct clients look to the limiter. A target that is not on this machine is
 * refused unless --allow-remote is given.
 *
 * Success is not only HTTP 200: the public procedures swallow database errors
 * and answer with empty data (they fail closed), so each answer is checked for
 * the data the seeded database must produce and counted as degraded if it is empty.
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { batchUrl, checkedTarget, createClient, flag, fmt, judge, num, option, percentile, sleep, startServer } from "./lib.mjs";

const require = createRequire(import.meta.url);

const OPTIONS = {
  base: option("base", "http://127.0.0.1:3200"),
  viewers: num("viewers", 50),
  duration: num("duration", 90),
  ramp: num("ramp", 15),
  pollScale: num("poll-scale", 1),
  churn: num("churn", 0),
  assets: !flag("no-assets"),
  searchEvery: num("search-every", 45),
  trace: option("trace", ""),
  control: flag("control"),
  label: option("label", "run"),
  spawn: flag("spawn"),
  database: option("database", "nooscape_load"),
  dbUrl: option("db-url", "mysql://root:nooscape@127.0.0.1:3307"),
  appUser: option("app-user", ""),
  killEvery: num("kill-every", 0),
  pauseContainer: option("pause-container", ""),
  pauseAt: num("pause-at", 0),
  pauseFor: num("pause-for", 0),
  server: option("server", "dist/index.js"),
  allowRemote: flag("allow-remote"),
};

const target = checkedTarget(OPTIONS.base, OPTIONS.allowRemote);
const client = createClient(target);

// ---------- the queries a Home page polls ----------
const HOME_POLL = [
  "liveData.publicRecords",
  "liveData.publicCoverage",
  "liveData.directoryBreakdown",
  "liveData.directoryWalletCensus",
  "liveData.directoryBscRegistry",
  "liveData.directoryFunnel",
  "liveData.directoryUsdgSettlements",
];
const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];

/** Half the searches are one common word, half an exact name (the word an entry numbered n carries is WORDS[n % 8]). */
function searchTerm() {
  if (Math.random() < 0.5) return WORDS[Math.floor(Math.random() * WORDS.length)];
  const n = Math.floor(Math.random() * 200_000) + 1;
  return `Agent ${n} ${WORDS[n % 8]}`;
}

// ---------- metrics ----------
const kinds = new Map();
const interval = { requests: 0, errors: 0, degraded: 0, limited: 0, latencies: [] };
const totals = { requests: 0, errors: 0, degraded: 0, limited: 0, errorCodes: new Map() };

const traceLines = [];
const runStart = performance.now();

function record(kind, result, soft = 0) {
  if (OPTIONS.trace) traceLines.push([kind, ((performance.now() - result.ms - runStart) / 1000).toFixed(2), result.ms.toFixed(0), result.status].join("\t"));
  const entry = kinds.get(kind) ?? { count: 0, errors: 0, degraded: 0, limited: 0, latencies: [] };
  kinds.set(kind, entry);
  const limited = result.status === 429;
  const failed = !limited && (result.status !== 200 || result.error);
  entry.count += 1;
  entry.latencies.push(result.ms);
  interval.requests += 1;
  interval.latencies.push(result.ms);
  totals.requests += 1;
  if (limited) {
    entry.limited += 1;
    interval.limited += 1;
    totals.limited += 1;
  } else if (failed) {
    entry.errors += 1;
    interval.errors += 1;
    totals.errors += 1;
    const code = result.error ?? `HTTP ${result.status}`;
    totals.errorCodes.set(code, (totals.errorCodes.get(code) ?? 0) + 1);
  } else if (soft > 0) {
    entry.degraded += 1;
    interval.degraded += soft;
    totals.degraded += soft;
  }
}

// ---------- the generator's own event loop ----------
// If this process cannot keep up, the latencies it records include its own queueing. It samples its loop lag
// every 50 ms so a saturated generator shows up in the report instead of being blamed on the server.
let loopLagMax = 0;
let loopLagTotal = 0;
const lagTimer = setInterval(
  (() => {
    let expected = performance.now() + 50;
    return () => {
      const now = performance.now();
      const lag = Math.max(0, now - expected);
      loopLagMax = Math.max(loopLagMax, lag);
      loopLagTotal = Math.max(loopLagTotal, lag);
      expected = now + 50;
    };
  })(),
  50
);

// ---------- viewers ----------
let running = true;
let active = 0;
let mainAsset = null;
let entryIds = [];
const jitter = ms => ms * (0.85 + Math.random() * 0.3);

async function viewer(index, lifetimeMs) {
  const ip = `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`;
  const headers = { "x-forwarded-for": ip, "user-agent": "nooscape-loadtest/1", accept: "application/json" };
  active += 1;
  const stopAt = lifetimeMs > 0 ? performance.now() + lifetimeMs : Infinity;
  const alive = () => running && performance.now() < stopAt;
  try {
    if (OPTIONS.assets) {
      record("page", await client.request("/", { ...headers, accept: "text/html" }));
      if (mainAsset) record("asset", await client.request(mainAsset, { ...headers, accept: "*/*" }));
    }
    const initial = HOME_POLL.map(name => ({ name }));
    const first = await client.request(batchUrl(initial), headers);
    record("home-load", first, judge(first, initial));

    const poll = HOME_POLL.map(name => ({ name }));
    let nextPoll = performance.now() + jitter(20_000 * OPTIONS.pollScale);
    const control = [{ name: "system.health", input: { timestamp: 0 } }];
    let nextControl = OPTIONS.control ? performance.now() + jitter(2_000) : Infinity;
    let nextSearch = OPTIONS.searchEvery > 0 ? performance.now() + jitter(OPTIONS.searchEvery * 1000 * OPTIONS.pollScale) : Infinity;
    while (alive()) {
      const now = performance.now();
      const due = Math.min(nextPoll, nextSearch, nextControl);
      if (due > now) {
        await sleep(Math.min(due - now, 500));
        continue;
      }
      if (nextControl <= now) {
        // system.health is built in memory: no database, no cache. If it stalls, the stall is not in the data path.
        record("control", await client.request(batchUrl(control), headers));
        nextControl = performance.now() + jitter(2_000);
      } else if (nextPoll <= now) {
        const result = await client.request(batchUrl(poll), headers);
        record("poll", result, judge(result, poll));
        nextPoll = performance.now() + jitter(20_000 * OPTIONS.pollScale);
      } else {
        const call = [{ name: "liveData.directorySearch", input: { query: searchTerm(), limit: 12 } }];
        const result = await client.request(batchUrl(call), headers);
        record("search", result, judge(result, call));
        if (entryIds.length && Math.random() < 0.5) {
          const id = entryIds[Math.floor(Math.random() * entryIds.length)];
          const view = [{ name: "liveData.directoryEntry", input: { id } }];
          const entryResult = await client.request(batchUrl(view), headers);
          record("entry", entryResult, judge(entryResult, view));
        }
        nextSearch = performance.now() + jitter(OPTIONS.searchEvery * 1000 * OPTIONS.pollScale);
      }
    }
  } finally {
    active -= 1;
  }
}

// ---------- the server and the database, from the outside ----------
let server = null;

let mysql = null;
async function dbConnection() {
  if (!mysql) {
    const { createConnection } = require("mysql2/promise");
    mysql = await createConnection(`${OPTIONS.dbUrl}/mysql`);
  }
  return mysql;
}

async function dbStatus() {
  const conn = await dbConnection();
  const [rows] = await conn.query("SHOW GLOBAL STATUS WHERE Variable_name IN ('Connections','Threads_connected','Threads_running','Questions','Slow_queries','Aborted_connects')");
  return Object.fromEntries(rows.map(row => [row.Variable_name, Number(row.Value)]));
}

function processStats() {
  if (flag("no-process-stats") || !server?.child?.pid) return Promise.resolve(null);
  return new Promise(resolve => {
    execFile(
      "powershell",
      ["-NoProfile", "-Command", `$p = Get-Process -Id ${server.child.pid}; "$($p.WorkingSet64) $($p.TotalProcessorTime.TotalSeconds)"`],
      { timeout: 10_000 },
      (error, stdout) => {
        if (error) return resolve(null);
        const [rss, cpu] = stdout.trim().split(/\s+/).map(Number);
        resolve({ rssMb: rss / 1048576, cpuSeconds: cpu });
      }
    );
  });
}

async function killAppConnections() {
  const conn = await dbConnection();
  const [rows] = await conn.query("SELECT id FROM information_schema.processlist WHERE db = ? AND command <> 'Daemon'", [OPTIONS.database]);
  for (const row of rows) await conn.query(`KILL ${Number(row.id)}`).catch(() => {});
  return rows.length;
}

const dockerPause = (verb, name) => new Promise(resolve => execFile("docker", [verb, name], () => resolve()));

// ---------- the run ----------
async function main() {
  console.log(`[${OPTIONS.label}] ${OPTIONS.viewers} viewers, ${OPTIONS.duration} s, poll scale ${OPTIONS.pollScale}, ${OPTIONS.spawn ? `spawned ${OPTIONS.server}` : "existing server"} at ${OPTIONS.base}`);
  if (OPTIONS.spawn) {
    const credentials = OPTIONS.appUser ? OPTIONS.dbUrl.replace("root:nooscape", OPTIONS.appUser) : OPTIONS.dbUrl;
    server = await startServer({ script: OPTIONS.server, port: target.port || 3200, databaseUrl: `${credentials}/${OPTIONS.database}` });
  }

  // A site that has been up a while has its caches built; a cold start is a different scenario (--cold).
  if (OPTIONS.spawn && !flag("cold")) {
    const poll = HOME_POLL.map(name => ({ name }));
    let quick = 0;
    for (let i = 0; i < 120 && quick < 3; i += 1) {
      const result = await client.request(batchUrl(poll), { "x-forwarded-for": "10.255.255.253" });
      quick = result.status === 200 && result.ms < 400 ? quick + 1 : 0;
      if (quick < 3) await sleep(500);
    }
    console.log(`settled: the polled reads answer quickly after ${quick >= 3 ? "warm-up" : "60 s (they did not settle)"}`);
  }

  // Learn the main bundle and a few real entry ids once, as a first visitor would.
  const home = await client.request("/", { accept: "text/html" });
  const asset = /\/assets\/index-[A-Za-z0-9_-]+\.js/.exec(home.body.toString("utf8"));
  mainAsset = asset ? asset[0] : null;
  const seedSearch = [{ name: "liveData.directorySearch", input: { query: "Agent 1 alpha", limit: 25 } }];
  const found = await client.request(batchUrl(seedSearch), { "x-forwarded-for": "10.255.255.254" });
  try {
    entryIds = JSON.parse(found.body.toString("utf8"))[0].result.data.json.entries.map(entry => entry.id).filter(Boolean);
  } catch {
    entryIds = [];
  }
  console.log(`warm-up: home ${home.status}, main bundle ${mainAsset ?? "not found"}, ${entryIds.length} entry ids`);

  const dbBefore = await dbStatus().catch(() => null);
  const procBefore = await processStats();
  const started = performance.now();
  console.log(`measuring from ${new Date().toISOString()}`);
  const samples = [];
  let dbMid = null;
  const midpoint = setTimeout(async () => {
    dbMid = await dbStatus().catch(() => null);
  }, (OPTIONS.duration * 1000) / 2);

  // viewers arrive over the ramp; with churn each leaves after about `churn` seconds and a new one replaces it
  const launches = [];
  let nextId = 1;
  const launch = (delayMs, lifetimeSeconds) =>
    launches.push(
      sleep(delayMs).then(async () => {
        if (!running) return;
        const id = nextId++;
        await viewer(id, lifetimeSeconds > 0 ? jitter(lifetimeSeconds * 1000) : 0);
        if (running && OPTIONS.churn > 0) await launch(Math.random() * 3000, OPTIONS.churn);
      })
    );
  for (let i = 0; i < OPTIONS.viewers; i += 1) launch((i / Math.max(OPTIONS.viewers, 1)) * OPTIONS.ramp * 1000, OPTIONS.churn);

  // chaos
  const timers = [];
  if (OPTIONS.killEvery > 0) {
    timers.push(
      setInterval(async () => {
        const killed = await killAppConnections().catch(() => 0);
        console.log(`  chaos: killed ${killed} database connections`);
      }, OPTIONS.killEvery * 1000)
    );
  }
  if (OPTIONS.pauseContainer && OPTIONS.pauseFor > 0) {
    timers.push(
      setTimeout(async () => {
        console.log(`  chaos: pausing the database for ${OPTIONS.pauseFor} s`);
        await dockerPause("pause", OPTIONS.pauseContainer);
        await sleep(OPTIONS.pauseFor * 1000);
        await dockerPause("unpause", OPTIONS.pauseContainer);
        console.log("  chaos: database resumed");
      }, OPTIONS.pauseAt * 1000)
    );
  }

  // report every 10 s
  const reporter = setInterval(async () => {
    const sorted = interval.latencies.slice().sort((a, b) => a - b);
    const status = await dbStatus().catch(() => null);
    const proc = await processStats();
    const elapsed = (performance.now() - started) / 1000;
    samples.push({ elapsed, rssMb: proc?.rssMb ?? 0, threads: status?.Threads_connected ?? 0, connections: status?.Connections ?? 0 });
    console.log(
      `${String(Math.round(elapsed)).padStart(4)} s  viewers ${String(active).padStart(4)}  req ${String(interval.requests).padStart(5)}  err ${interval.errors}  degraded ${interval.degraded}  429 ${interval.limited}  p50 ${fmt(percentile(sorted, 50))}  p95 ${fmt(percentile(sorted, 95))}  max ${fmt(sorted[sorted.length - 1] ?? 0)} ms  gen lag ${fmt(loopLagMax)} ms` +
        (status ? `  db conns ${status.Connections - (dbBefore?.Connections ?? 0)} new, ${status.Threads_connected} open, ${status.Threads_running} running` : "") +
        (proc ? `  rss ${proc.rssMb.toFixed(0)} MB` : "")
    );
    interval.requests = interval.errors = interval.degraded = interval.limited = 0;
    interval.latencies = [];
    loopLagMax = 0;
  }, 10_000);

  await sleep(OPTIONS.duration * 1000);
  running = false;
  clearInterval(reporter);
  clearTimeout(midpoint);
  timers.forEach(timer => {
    clearInterval(timer);
    clearTimeout(timer);
  });
  await Promise.race([Promise.allSettled(launches), sleep(15_000)]);

  const dbAfter = await dbStatus().catch(() => null);
  const procAfter = await processStats();
  const seconds = (performance.now() - started) / 1000;

  // ---------- summary ----------
  console.log(`\n=== ${OPTIONS.label}: ${OPTIONS.viewers} viewers over ${seconds.toFixed(0)} s ===`);
  console.log("kind        count    err  degr   429     p50     p95     p99     max (ms)");
  for (const [kind, entry] of [...kinds.entries()].sort()) {
    const sorted = entry.latencies.slice().sort((a, b) => a - b);
    console.log(
      `${kind.padEnd(11)} ${String(entry.count).padStart(6)} ${String(entry.errors).padStart(6)} ${String(entry.degraded).padStart(5)} ${String(entry.limited).padStart(5)} ${fmt(percentile(sorted, 50)).padStart(7)} ${fmt(percentile(sorted, 95)).padStart(7)} ${fmt(percentile(sorted, 99)).padStart(7)} ${fmt(sorted[sorted.length - 1] ?? 0).padStart(7)}`
    );
  }
  if (OPTIONS.trace) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(OPTIONS.trace, ["kind\tissued_s\tms\tstatus", ...traceLines].join("\n"));
  }
  console.log(`load generator: worst event-loop lag ${fmt(loopLagTotal)} ms (if this is large, the latencies above include the generator's own queueing)`);
  console.log(`total: ${totals.requests} requests (${(totals.requests / seconds).toFixed(1)}/s), ${totals.errors} errors, ${totals.degraded} degraded answers, ${totals.limited} rate-limited`);
  if (totals.errorCodes.size) console.log(`error causes: ${[...totals.errorCodes.entries()].map(([code, n]) => `${code} x${n}`).join(", ")}`);
  if (dbBefore && dbAfter) {
    const opened = dbAfter.Connections - dbBefore.Connections;
    const queries = dbAfter.Questions - dbBefore.Questions;
    // The pool fills once; what matters for the host's hourly cap is what is opened after that, in the second half.
    const steady = dbMid ? dbAfter.Connections - dbMid.Connections : null;
    const steadyText = steady === null ? "" : `, ${steady} in the second half (about ${Math.round((steady / (seconds / 2)) * 3600)} an hour)`;
    console.log(`database: ${opened} connections opened${steadyText}; ${queries} queries (${(queries / seconds).toFixed(0)}/s), ${dbAfter.Slow_queries - dbBefore.Slow_queries} slow, ${dbAfter.Aborted_connects - dbBefore.Aborted_connects} aborted connects`);
  }
  if (procBefore && procAfter) {
    const peak = Math.max(...samples.map(sample => sample.rssMb), procAfter.rssMb);
    const cpu = procAfter.cpuSeconds - procBefore.cpuSeconds;
    console.log(`server process: rss ${procBefore.rssMb.toFixed(0)} -> ${procAfter.rssMb.toFixed(0)} MB (peak ${peak.toFixed(0)}), cpu ${cpu.toFixed(1)} s over ${seconds.toFixed(0)} s (${((cpu / seconds) * 100).toFixed(0)}% of one core)`);
  }
  if (server?.log.length) {
    const notable = server.log.filter(line => /\[Database\]|ER_|storage failure|unexpected error|RateLimit|ECONN|PROTOCOL|Too many/.test(line));
    const counts = new Map();
    for (const line of notable) {
      const key = line.slice(9, 110);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    console.log(`server log: ${server.log.length} lines, ${notable.length} notable`);
    for (const [key, count] of [...counts.entries()].slice(0, 8)) console.log(`  x${count} ${key}`);
  }
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    running = false;
    clearInterval(lagTimer);
    client.close();
    if (server?.child && server.child.exitCode === null) server.child.kill();
    if (mysql) await mysql.end().catch(() => {});
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
  });
