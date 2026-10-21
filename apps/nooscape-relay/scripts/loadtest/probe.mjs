#!/usr/bin/env node
/**
 * Times every public read on its own, one request at a time, so an endpoint's
 * cost is not mixed with queueing behind other viewers. The first call of each
 * is cold (an empty read cache, a cold buffer pool), the next four are warm.
 *
 *   node scripts/loadtest/probe.mjs --spawn --database nooscape_load
 */
import { createRequire } from "node:module";
import { batchUrl, checkedTarget, createClient, flag, fmt, judge, option, startServer } from "./lib.mjs";

const require = createRequire(import.meta.url);
const base = option("base", "http://127.0.0.1:3201");
const dbUrl = option("db-url", "mysql://root:nooscape@127.0.0.1:3307");
const database = option("database", "nooscape_load");
const script = option("server", "dist/index.js");
const target = checkedTarget(base, flag("allow-remote"));
const client = createClient(target);
const headers = { "x-forwarded-for": "10.200.0.1", accept: "application/json" };

const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function main() {
  const server = flag("spawn") ? await startServer({ script, port: target.port || 3201, databaseUrl: `${dbUrl}/${database}` }) : null;
  const { createConnection } = require("mysql2/promise");
  const conn = await createConnection(`${dbUrl}/${database}`);
  const idOf = async where => (await conn.query(`SELECT id FROM agent_directory_entries WHERE ${where} LIMIT 1`))[0][0]?.id;
  const ids = {
    catalog: await idOf("protocol = 'catalog'"),
    robinhood: await idOf("protocol = 'erc8004'"),
    bnbListed: await idOf("protocol = 'erc8004_bsc'"),
    said: await idOf("protocol = 'solana_said'"),
  };
  await conn.end();

  const poll = [
    "liveData.publicRecords",
    "liveData.publicCoverage",
    "liveData.directoryBreakdown",
    "liveData.directoryWalletCensus",
    "liveData.directoryBscRegistry",
    "liveData.directoryFunnel",
    "liveData.directoryUsdgSettlements",
  ].map(name => ({ name }));
  const cases = [
    ["page /", null],
    ["home poll (7 queries)", poll],
    ...poll.map(call => [`  ${call.name.replace("liveData.", "")}`, [call]]),
    ["search: common word", [{ name: "liveData.directorySearch", input: { query: "alpha", limit: 12 } }]],
    ["search: exact name", [{ name: "liveData.directorySearch", input: { query: "Agent 12345 alpha", limit: 12 } }]],
    ["search: rare host token", [{ name: "liveData.directorySearch", input: { query: "h4999", limit: 12 } }]],
    ["search: two characters", [{ name: "liveData.directorySearch", input: { query: "ag", limit: 12 } }]],
    ["search: EVM wallet prefix", [{ name: "liveData.directorySearch", input: { query: "0x0000000000000000000000000000000000000b", limit: 12 } }]],
    ["search: no match", [{ name: "liveData.directorySearch", input: { query: "zzzzqqqq", limit: 12 } }]],
    ["entry: catalog", [{ name: "liveData.directoryEntry", input: { id: ids.catalog } }]],
    ["entry: Robinhood identity", [{ name: "liveData.directoryEntry", input: { id: ids.robinhood } }]],
    ["entry: BNB Chain listed", [{ name: "liveData.directoryEntry", input: { id: ids.bnbListed } }]],
    ["entry: SAID", [{ name: "liveData.directoryEntry", input: { id: ids.said } }]],
    ["agent page (agentProfile)", [{ name: "liveData.agentProfile", input: { id: ids.catalog } }]],
    ["agent page, reviewed record", [{ name: "liveData.agentProfile", input: { id: "agent-census-7" } }]],
    ["sources status", [{ name: "liveData.sourceStatuses" }]],
    ["what changed feed", [{ name: "liveData.directoryActivityFeed" }]],
    ["solana activity feed", [{ name: "liveData.directorySolanaActivity" }]],
  ];

  console.log(`${"case".padEnd(34)} ${"cold".padStart(8)} ${"warm med".padStart(9)} ${"warm max".padStart(9)}  bytes  note`);
  for (const [label, calls] of cases) {
    const times = [];
    let bytes = 0;
    let soft = 0;
    let status = 200;
    for (let i = 0; i < 5; i += 1) {
      const result = calls ? await client.request(batchUrl(calls), headers) : await client.request("/", { ...headers, accept: "text/html" });
      times.push(result.ms);
      bytes = result.body.length;
      status = result.status;
      if (calls) soft += judge(result, calls);
    }
    const warm = times.slice(1);
    console.log(
      `${label.padEnd(34)} ${fmt(times[0]).padStart(8)} ${fmt(median(warm)).padStart(9)} ${fmt(Math.max(...warm)).padStart(9)}  ${String(bytes).padStart(5)}  ${status !== 200 ? `HTTP ${status}` : soft ? `${soft} empty/failed answers` : ""}`
    );
  }
  client.close();
  server?.child.kill();
  setTimeout(() => process.exit(0), 300);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
