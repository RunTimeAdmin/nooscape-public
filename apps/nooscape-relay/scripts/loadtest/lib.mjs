// Shared pieces of the load-test tools: option parsing, a keep-alive HTTP client,
// tRPC batch URLs, and starting the production build with its log captured.
import { spawn } from "node:child_process";
import http from "node:http";
import { performance } from "node:perf_hooks";

export const args = process.argv.slice(2);
export const flag = name => args.includes(`--${name}`);
export const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
export const num = (name, fallback) => Number(option(name, fallback));
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The tools target a server on this machine unless the owner has said otherwise. */
export function checkedTarget(base, allowRemote) {
  const target = new URL(base);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) && !allowRemote) {
    console.error(`Refusing to load ${target.hostname}: these tools target a server on this machine. Pass --allow-remote only with the owner's go-ahead and a plan to stop.`);
    process.exit(2);
  }
  return target;
}

export function createClient(target) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1024 });
  function request(path, headers = {}) {
    return new Promise(resolve => {
      const started = performance.now();
      const req = http.request(
        { host: target.hostname, port: target.port || 80, path, method: "GET", agent, headers, timeout: 60_000 },
        res => {
          const chunks = [];
          res.on("data", chunk => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, ms: performance.now() - started, body: Buffer.concat(chunks) }));
        }
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", error => resolve({ status: 0, ms: performance.now() - started, body: Buffer.alloc(0), error: error.code ?? error.message }));
      req.end();
    });
  }
  return { request, close: () => agent.destroy() };
}

/** The URL tRPC's batch link builds for GET queries; an undefined input is serialized the way superjson does. */
export function batchUrl(calls) {
  const input = {};
  calls.forEach((call, index) => {
    input[index] = call.input === undefined ? { json: null, meta: { values: ["undefined"] } } : { json: call.input };
  });
  return `/api/trpc/${calls.map(call => call.name).join(",")}?batch=1&input=${encodeURIComponent(JSON.stringify(input))}`;
}

/** What a healthy, seeded database must produce. A fail-closed (empty) answer is "degraded", not "ok". */
export const validators = {
  "liveData.publicRecords": data => Array.isArray(data?.records) && data.records.length > 0,
  "liveData.publicCoverage": data => data?.publicRecordCount > 0,
  "liveData.directoryBreakdown": data => data?.total > 0,
  "liveData.directoryBscRegistry": data => data?.profile != null,
  "liveData.directorySearch": data => data?.matchedTotal > 0,
  "liveData.directoryEntry": data => data?.entry != null,
  "liveData.agentProfile": data => data?.kind !== "none",
};

/** Counts the answers in a batch response that came back as an error or as the empty fail-closed shape. */
export function judge(result, calls) {
  if (result.status !== 200) return 0;
  let parsed;
  try {
    parsed = JSON.parse(result.body.toString("utf8"));
  } catch {
    return calls.length;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  let soft = 0;
  items.forEach((item, index) => {
    if (item?.error) {
      soft += 1;
      return;
    }
    const validate = validators[calls[index]?.name];
    if (validate && !validate(item?.result?.data?.json)) soft += 1;
  });
  return soft;
}

/** Starts the production build with its output captured; resolves once it is listening. */
export async function startServer({ script, port, databaseUrl, nodeArgs = [] }) {
  const log = [];
  const env = { ...process.env, NODE_ENV: "production", PORT: String(port), DATABASE_URL: databaseUrl };
  const child = spawn(process.execPath, [...nodeArgs, script], { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  const onData = chunk => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) if (line.trim()) log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  for (let i = 0; i < 120; i += 1) {
    await sleep(500);
    if (log.some(line => line.includes("Server running on"))) return { child, log };
    if (child.exitCode !== null) throw new Error(`the server exited at boot:\n${log.slice(-8).join("\n")}`);
  }
  child.kill();
  throw new Error(`the server did not start:\n${log.slice(-8).join("\n")}`);
}

export const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);
export const fmt = value => (value >= 100 ? value.toFixed(0) : value.toFixed(1));
