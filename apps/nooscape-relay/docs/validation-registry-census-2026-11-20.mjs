#!/usr/bin/env node
/**
 * The count behind docs/validation-registry-census-2026-11-20.md: how many ValidationRequest and ValidationResponse events the
 * ERC-8004 Validation Registry (the proxy at REGISTRY) has emitted on each chain that has it, read from the chain's own logs.
 *
 * Read only. It asks public RPC endpoints (no key) for the registry's code, its implementation slot, block headers, `ownerOf` on the
 * Identity Registry and `eth_getLogs` on the Validation Registry. It writes nothing anywhere and prints no secret, because it holds none.
 *
 * Usage, from apps/nooscape-relay:
 *   node docs/validation-registry-census-2026-11-20.mjs [chainKey ...] > result.json     (progress goes to stderr, the result to stdout)
 * A chain whose public nodes keep no history can be read through an archive endpoint of your own: VALIDATION_CENSUS_RPC_BASE=<url>.
 *
 * How a chain is read:
 *  1. eth_getCode at REGISTRY. No code: the chain has no registry at that address, and nothing more is asked of it.
 *  2. The EIP-1967 implementation slot, and the implementation's code, which must contain both event topics (control A: this
 *     contract emits these two events with exactly these signatures). Code that lacks either is another contract on that address:
 *     the chain is reported as having no registry there, with the reason, and its logs are not read.
 *  3. The first block at or after 2026-01-01 00:00 UTC (the registry's first deployment was on 2026-01-10), found by binary search
 *     over block headers, and the head block, with its time.
 *  4. Every log of the registry from that block to the head, with no topic filter. The widest window the chain's nodes serve is found
 *     by asking for the whole range and then for smaller ranges ending at the head; the range is then read in windows of that size by a
 *     few workers. A window the node refuses is halved. A chain that would need more than MAX_CALLS calls is "not read": it is never
 *     counted as zero. (Control B: the unfiltered read returns only these two events and the proxy's own admin events.)
 *  5. Control C: the last Upgraded event's implementation equals the implementation slot read at the head, so the read reached the end.
 *  6. For each request, ownerOf(agentId) at the Identity Registry, at the block of the request and at the head, to say whether the named
 *     validator is the agent's own owner.
 *
 * A node that answers 429 or a 5xx error, or does not answer, is waited for and asked again (six tries with growing pauses); that is
 * never read as "too wide". A window it still cannot answer is halved, and a node that cannot answer for more than MAX_UNANSWERED windows
 * has stretches it times out on: the chain is "not read" with the reason. Any other refusal, such as a 403 or an RPC error for a range
 * the node will not serve, says the window is too wide for that node, and the window is halved; a window that still fails at MIN_WINDOW
 * blocks makes the chain "not read".
 */
import { keccak_256 } from "@noble/hashes/sha3.js";

export const REGISTRY = "0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58";
export const IDENTITY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const START_TIME = Date.UTC(2026, 0, 1) / 1000;
const MIN_WINDOW = 100;
const MAX_CALLS = 12_000;
const MAX_UNANSWERED = 8;
const WIDTHS = [10_000_000, 1_000_000, 200_000, 50_000, 10_000, 2_000, 500, MIN_WINDOW];
const CHAIN_WORKERS = 4;

const enc = new TextEncoder();
const toHex = (bytes) => Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
const topic = (signature) => "0x" + toHex(keccak_256(enc.encode(signature)));
const T_REQUEST = topic("ValidationRequest(address,uint256,string,bytes32)");
const T_RESPONSE = topic("ValidationResponse(address,uint256,bytes32,uint8,string,bytes32,string)");
const T_UPGRADED = topic("Upgraded(address)");
const T_OWNERSHIP = topic("OwnershipTransferred(address,address)");
const T_INITIALIZED = topic("Initialized(uint64)");
const hexn = (n) => "0x" + n.toString(16);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CHAINS = [
  { key: "ethereum", label: "Ethereum", id: 1, rpcs: ["https://gateway.tenderly.co/public/mainnet", "https://ethereum-rpc.publicnode.com"] },
  { key: "base", label: "Base", id: 8453, rpcs: ["https://base-rpc.publicnode.com"] },
  { key: "arbitrum", label: "Arbitrum One", id: 42161, rpcs: ["https://arbitrum.gateway.tenderly.co", "https://arbitrum-one-rpc.publicnode.com"] },
  { key: "optimism", label: "Optimism", id: 10, rpcs: ["https://optimism.gateway.tenderly.co", "https://optimism-rpc.publicnode.com"] },
  { key: "polygon", label: "Polygon", id: 137, rpcs: ["https://polygon.gateway.tenderly.co", "https://polygon-bor-rpc.publicnode.com"] },
  { key: "bnb", label: "BNB Chain", id: 56, rpcs: ["https://bsc-rpc.publicnode.com"] },
  { key: "gnosis", label: "Gnosis", id: 100, rpcs: ["https://gnosis.gateway.tenderly.co", "https://gnosis-rpc.publicnode.com"] },
  { key: "avalanche", label: "Avalanche C-Chain", id: 43114, rpcs: ["https://avalanche.gateway.tenderly.co"] },
  { key: "celo", label: "Celo", id: 42220, rpcs: ["https://celo.gateway.tenderly.co", "https://forno.celo.org"] },
  { key: "linea", label: "Linea", id: 59144, rpcs: ["https://linea.gateway.tenderly.co", "https://rpc.linea.build"] },
  { key: "monad", label: "Monad", id: 143, rpcs: ["https://rpc2.monad.xyz"] },
  { key: "xlayer", label: "X Layer", id: 196, rpcs: ["https://rpc.xlayer.tech", "https://xlayerrpc.okx.com"] },
  { key: "mantle", label: "Mantle", id: 5000, rpcs: ["https://mantle.gateway.tenderly.co", "https://mantle-rpc.publicnode.com", "https://rpc.mantle.xyz"] },
  { key: "megaeth", label: "MegaETH", id: 4326, rpcs: ["https://mainnet.megaeth.com/rpc"] },
  { key: "scroll", label: "Scroll", id: 534352, rpcs: ["https://rpc.scroll.io", "https://scroll-rpc.publicnode.com"] },
  { key: "taiko", label: "Taiko", id: 167000, rpcs: ["https://rpc.mainnet.taiko.xyz"] },
  { key: "soneium", label: "Soneium", id: 1868, rpcs: ["https://rpc.soneium.org"] },
  { key: "metis", label: "Metis Andromeda", id: 1088, rpcs: ["https://andromeda.metis.io/?owner=1088"] },
  { key: "goat", label: "GOAT Network", id: 2345, rpcs: ["https://rpc.goat.network"] },
  { key: "skale-base", label: "SKALE Base", id: 1187947933, rpcs: ["https://skale-base.skalenodes.com/v1/base"] },
  { key: "abstract", label: "Abstract", id: 2741, rpcs: ["https://api.mainnet.abs.xyz"] },
  { key: "0g", label: "0G", id: 16661, rpcs: ["https://evmrpc.0g.ai"] },
  { key: "injective", label: "Injective EVM", id: 1776, rpcs: ["https://sentry.evm-rpc.injective.network"] },
];

const lastStart = new Map();
/** At least 90 ms between two calls to the same host, so a chain's workers do not hammer a free node. */
async function politely(url) {
  const host = new URL(url).host;
  const wait = Math.max(0, (lastStart.get(host) ?? 0) + 90 - Date.now());
  lastStart.set(host, Date.now() + wait);
  if (wait > 0) await sleep(wait);
}

async function rpcOnce(url, method, params) {
  await politely(url);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    throw Object.assign(new Error("connection failed: " + String(error.message ?? error).slice(0, 80)), { answered: false });
  }
  // 429 and 5xx mean "not now": the node is busy or down, and the same call is asked again. Any other refusal (a node that says 403 or 400
  // for a range it will not serve) is an answer, and the window is made smaller.
  if (!res.ok && (res.status === 429 || res.status >= 500)) throw Object.assign(new Error("HTTP " + res.status), { answered: false });
  let body;
  try {
    body = await res.json();
  } catch {
    throw Object.assign(new Error(res.ok ? "not JSON" : "HTTP " + res.status), { answered: !res.ok });
  }
  if (!res.ok && !body.error) throw Object.assign(new Error("HTTP " + res.status), { answered: true });
  if (body.error) throw Object.assign(new Error(String(body.error.message ?? JSON.stringify(body.error)).slice(0, 140)), { answered: true });
  return body.result;
}

/** One call, trying each of the chain's endpoints in order. A node that answered with an error is not asked again; a node that could not answer is waited for, six tries with growing pauses. */
async function rpc(chain, method, params) {
  let last = new Error("no endpoint");
  for (const url of chain.rpcs) {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const result = await rpcOnce(url, method, params);
        chain.used.add(new URL(url).host);
        return result;
      } catch (error) {
        last = error;
        if (error.answered) break;
        await sleep(700 * 2 ** attempt);
      }
    }
  }
  throw last;
}

async function blockTime(chain, number) {
  const block = await rpc(chain, "eth_getBlockByNumber", [hexn(number), false]);
  return block ? parseInt(block.timestamp, 16) : null;
}

/** The first block whose time is at or after t, by binary search over headers. A block the node has pruned counts as older than t, since pruning removes the oldest blocks first. */
async function firstBlockAtOrAfter(chain, head, t) {
  let lo = 0;
  let hi = head;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    let time = null;
    try {
      time = await blockTime(chain, mid);
    } catch (error) {
      if (!error.answered) throw error;
    }
    if (time === null || time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Every log of `address` from `from` to `to`, unfiltered. */
async function readLogs(chain, address, from, to) {
  const total = to - from + 1;
  const sizes = [...new Set([total, ...WIDTHS.filter((w) => w < total)])];
  let window = null;
  let calls = 0;
  const logs = [];
  let refusal = "";
  for (const size of sizes) {
    calls++;
    try {
      logs.push(...((await rpc(chain, "eth_getLogs", [{ address, fromBlock: hexn(to - size + 1), toBlock: hexn(to) }])) ?? []));
      window = size;
      break;
    } catch (error) {
      if (!error.answered) throw new Error("not read: the nodes would not answer (" + error.message + ")");
      refusal = error.message;
    }
  }
  if (window === null) throw new Error("not read: the node refuses even a window of " + MIN_WINDOW + " blocks (" + refusal + ")");
  const queue = [];
  for (let end = to - window; end >= from; end -= window) queue.push([Math.max(from, end - window + 1), end]);
  if (calls + queue.length > MAX_CALLS) throw new Error("not read: the node serves windows of " + window.toLocaleString("en-US") + " blocks, which would need " + (calls + queue.length).toLocaleString("en-US") + " calls");
  let failure = null;
  let unanswered = 0;
  if (queue.length > 200) console.error(`${chain.key}: reading ${(queue.length + 1).toLocaleString("en-US")} windows of ${window.toLocaleString("en-US")} blocks`);
  const workers = Array.from({ length: queue.length > 2_000 ? CHAIN_WORKERS : 3 }, async () => {
    while (queue.length > 0 && failure === null) {
      const [a, b] = queue.shift();
      calls++;
      try {
        logs.push(...((await rpc(chain, "eth_getLogs", [{ address, fromBlock: hexn(a), toBlock: hexn(b) }])) ?? []));
      } catch (error) {
        // A window the node refuses or could not answer is halved. A node that could not answer more than MAX_UNANSWERED windows has stretches
        // it times out on (halving each of them would take hours), so the chain is not read; so is a window that fails at MIN_WINDOW blocks.
        if (!error.answered) unanswered++;
        if (b - a + 1 > MIN_WINDOW && unanswered <= MAX_UNANSWERED) {
          if (!error.answered) console.error(`${chain.key}: blocks ${a} to ${b} not answered (${error.message}), ${unanswered} of ${MAX_UNANSWERED} allowed, halving`);
          const mid = Math.floor((a + b) / 2);
          queue.push([a, mid], [mid + 1, b]);
        } else {
          failure = new Error("not read: " + (unanswered > MAX_UNANSWERED ? "the node could not answer for more than " + MAX_UNANSWERED + " windows, the last " : "") + "blocks " + a + " to " + b + " could not be read (" + error.message + ")");
        }
      }
    }
  });
  await Promise.all(workers);
  if (failure !== null) throw failure;
  logs.sort((x, y) => parseInt(x.blockNumber, 16) - parseInt(y.blockNumber, 16) || parseInt(x.logIndex, 16) - parseInt(y.logIndex, 16));
  return { logs, calls, window };
}

const address = (word) => "0x" + word.slice(-40);

/** The string at the head offset `slot` (in 32-byte words) of an ABI-encoded data blob. */
function abiString(dataHex, slot) {
  const data = dataHex.slice(2);
  const offset = parseInt(data.slice(slot * 64, slot * 64 + 64), 16) * 2;
  const length = parseInt(data.slice(offset, offset + 64), 16) * 2;
  return Buffer.from(data.slice(offset + 64, offset + 64 + length), "hex").toString("utf8");
}

async function scanChain(chain) {
  const out = { key: chain.key, label: chain.label, id: chain.id, status: null };
  chain.used = new Set();
  try {
    const code = await rpc(chain, "eth_getCode", [REGISTRY, "latest"]);
    out.registryHasCode = Boolean(code && code !== "0x");
    if (!out.registryHasCode) {
      out.status = "no-registry";
      return out;
    }
    const slot = await rpc(chain, "eth_getStorageAt", [REGISTRY, IMPL_SLOT, "latest"]);
    out.implementation = "0x" + slot.slice(-40);
    const implCode = ((await rpc(chain, "eth_getCode", [out.implementation, "latest"])) ?? "0x").toLowerCase();
    out.implementationBytes = (implCode.length - 2) / 2;
    out.controlA = implCode.includes(T_REQUEST.slice(2)) && implCode.includes(T_RESPONSE.slice(2));
    // Code that holds neither event is another contract on the same address, and what it logs is not this registry's: nothing more is asked of it.
    if (!out.controlA) {
      out.status = "no-registry";
      out.reason = "the contract there is not this registry: its code does not hold both event signatures";
      out.endpoints = [...chain.used];
      return out;
    }

    const head = parseInt(await rpc(chain, "eth_blockNumber", []), 16);
    out.headBlock = head;
    out.headTime = await blockTime(chain, head);
    out.startBlock = await firstBlockAtOrAfter(chain, head, START_TIME);
    out.startBlockTime = await blockTime(chain, out.startBlock);
    // A node that has pruned old blocks makes the search above stop at the oldest block it still has. That block must be the one the count starts
    // from, or the chain is "not read": a count that silently starts later is a lower bound passed off as a count.
    if (out.startBlock > 0 && (out.startBlockTime === null || out.startBlockTime - START_TIME > 3600)) {
      const oldest = out.startBlockTime === null ? "unknown" : new Date(out.startBlockTime * 1000).toISOString().slice(0, 10);
      throw new Error("not read: the nodes keep no history before " + oldest);
    }
    const { logs, calls, window } = await readLogs(chain, REGISTRY, out.startBlock, head);
    out.calls = calls;
    out.window = window;

    const requests = logs.filter((l) => l.topics[0] === T_REQUEST);
    const responses = logs.filter((l) => l.topics[0] === T_RESPONSE);
    const upgraded = logs.filter((l) => l.topics[0] === T_UPGRADED);
    const others = logs.filter((l) => ![T_REQUEST, T_RESPONSE].includes(l.topics[0]));
    out.requests = requests.length;
    out.responses = responses.length;
    // Control B: what is neither a request nor a response is one of the proxy's own admin events, and nothing else.
    const names = new Map([[T_UPGRADED, "Upgraded"], [T_OWNERSHIP, "OwnershipTransferred"], [T_INITIALIZED, "Initialized"]]);
    out.adminEvents = {};
    out.unexpectedLogs = 0;
    for (const l of others) {
      const name = names.get(l.topics[0]);
      if (name) out.adminEvents[name] = (out.adminEvents[name] ?? 0) + 1;
      else out.unexpectedLogs++;
    }
    out.controlC = upgraded.length === 0 ? null : address(upgraded[upgraded.length - 1].topics[1]).toLowerCase() === out.implementation.toLowerCase();

    const events = [...requests, ...responses].map((l) => parseInt(l.blockNumber, 16));
    if (events.length > 0) {
      out.firstEventBlock = Math.min(...events);
      out.lastEventBlock = Math.max(...events);
      out.firstEventTime = await blockTime(chain, out.firstEventBlock);
      out.lastEventTime = await blockTime(chain, out.lastEventBlock);
    }
    out.requestAgents = new Set(requests.map((l) => l.topics[2])).size;
    out.requestValidators = new Set(requests.map((l) => address(l.topics[1]).toLowerCase())).size;
    out.responseValidators = new Set(responses.map((l) => address(l.topics[1]).toLowerCase())).size;
    out.responseValues = {};
    for (const l of responses) {
      const value = parseInt(l.data.slice(2, 66), 16);
      out.responseValues[value] = (out.responseValues[value] ?? 0) + 1;
    }
    // A response's request hash was asked for on this chain.
    const asked = new Set(requests.map((l) => l.topics[3]));
    out.responsesWithRequest = responses.filter((l) => asked.has(l.topics[3])).length;

    // Whose request it is: is the named validator the agent's own owner, at the block of the request (a node that keeps old state is needed)
    // and at the head? An owner that cannot be read is "unknown", never "other".
    out.ownerAtRequest = { validator: 0, other: 0, unknown: 0 };
    out.ownerNow = { validator: 0, other: 0, unknown: 0 };
    const ownerAt = async (agentId, block) => {
      try {
        const result = await rpc(chain, "eth_call", [{ to: IDENTITY, data: "0x6352211e" + agentId.slice(2) }, block]);
        return address(result).toLowerCase();
      } catch {
        return null;
      }
    };
    for (const l of requests) {
      const validator = address(l.topics[1]).toLowerCase();
      for (const [bucket, block] of [[out.ownerAtRequest, l.blockNumber], [out.ownerNow, "latest"]]) {
        const owner = await ownerAt(l.topics[2], block);
        if (owner === null) bucket.unknown++;
        else if (owner === validator) bucket.validator++;
        else bucket.other++;
      }
    }
    out.requestsByURIKind = {};
    for (const l of requests) {
      const uri = abiString(l.data, 0);
      const kind = uri.startsWith("ipfs://") ? "ipfs" : uri.startsWith("https://") ? "https" : uri.startsWith("http://") ? "http" : uri.startsWith("data:") ? "data" : uri === "" ? "empty" : "other";
      out.requestsByURIKind[kind] = (out.requestsByURIKind[kind] ?? 0) + 1;
    }
    out.status = "read";
  } catch (error) {
    out.status = "not-read";
    out.reason = String(error.message ?? error).slice(0, 200);
  }
  out.endpoints = [...chain.used];
  return out;
}

async function main() {
  const wanted = process.argv.slice(2);
  const chains = CHAINS.filter((c) => wanted.length === 0 || wanted.includes(c.key));
  // A chain whose public nodes keep no history (Base and BNB Chain) can be read through any archive endpoint: set
  // VALIDATION_CENSUS_RPC_<CHAIN> to its URL (the chain key in capitals, "-" as "_"). The URL is used and never printed; only its host is.
  for (const chain of chains) {
    const own = process.env["VALIDATION_CENSUS_RPC_" + chain.key.toUpperCase().replace(/-/g, "_")];
    if (own) chain.rpcs = [own, ...chain.rpcs];
  }
  const started = Date.now();
  const results = new Array(chains.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, chains.length) }, async () => {
      while (next < chains.length) {
        const i = next++;
        const result = await scanChain(chains[i]);
        results[i] = result;
        console.error(`${chains[i].key}: ${result.status}${result.status === "read" ? ` requests ${result.requests}, responses ${result.responses}, ${result.calls} calls, window ${result.window}` : result.reason ? " (" + result.reason + ")" : ""}`);
      }
    }),
  );
  console.log(JSON.stringify({ measuredAt: new Date().toISOString(), registry: REGISTRY, identity: IDENTITY, topics: { request: T_REQUEST, response: T_RESPONSE, upgraded: T_UPGRADED }, seconds: Math.round((Date.now() - started) / 1000), chains: results }, null, 1));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) await main();
