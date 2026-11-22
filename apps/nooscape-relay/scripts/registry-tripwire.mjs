#!/usr/bin/env node
/**
 * The upgrade tripwire for the ERC-8004 registries.
 *
 * What Nooscape reads from a chain, and what it tells a caller about an agent (the check's pay_to among it), rests on what three
 * contracts do on each chain: the Identity, Reputation and Validation Registry. Each is an upgradeable proxy (EIP-1967), so its owner
 * can change what it does without moving its address. The implementation an upgrade installs is kept in a storage slot of the proxy.
 * This reads that slot for each registry on every chain the app reads, and compares it with the implementation Nooscape last
 * verified (PINS below, read from the chains on PINS_VERIFIED).
 *
 * A slot that differs, or that cannot be read, is said in one line, through notify.sh (deploy/vps/tripwire.sh runs this once a day).
 * A clean run is quiet, except for one line on Mondays, so that silence is not taken for a dead job. A slot that differs is said again
 * on every run until PINS is updated: an upgrade that nobody has looked at stays loud.
 *
 * Read only: eth_getStorageAt against each chain's node, and nothing written anywhere. A node address can carry a key (the app's own
 * settings BSC_RPC_URL and the rest), so nothing here prints, logs or returns one: a line names a chain, a registry and an address
 * on the chain, never a node, and a node that fails is named by what happened ("the node did not answer").
 *
 *   docker compose exec -T app node scripts/registry-tripwire.mjs [--heartbeat]
 *
 * It prints a summary line, a line for each slot, and an "ALERT: ..." line for each thing to say. --heartbeat adds the Monday line on
 * any day. It exits 0 once it has read and said what it found, 1 when it could not run, and 2 for an argument it does not know.
 */
import { pathToFileURL } from "node:url";

/** The EIP-1967 implementation slot of a proxy: keccak256("eip1967.proxy.implementation") minus one. */
export const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/** The three registries. Each is a proxy at the same address on every chain it runs on. */
export const REGISTRIES = [
  { name: "identity", title: "Identity", proxy: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" },
  { name: "reputation", title: "Reputation", proxy: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" },
  { name: "validation", title: "Validation", proxy: "0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58" },
];

/**
 * The chains the app reads, as server/ingestion/erc8004Chains.ts and robinhood.ts name them (a test holds the two lists together, so
 * a chain added there and not here fails the build). `env` is the app's own setting for the chain's node, which carries a key and is
 * asked first; `rpcs` are public nodes that need no key, asked after it.
 */
export const CHAINS = [
  { key: "robinhood", label: "Robinhood Chain", chainId: 4663, env: null, rpcs: ["https://rpc.mainnet.chain.robinhood.com"] },
  { key: "bnb", label: "BNB Chain", chainId: 56, env: "BSC_RPC_URL", rpcs: ["https://bsc-rpc.publicnode.com"] },
  { key: "ethereum", label: "Ethereum", chainId: 1, env: "ETH_RPC_URL", rpcs: ["https://ethereum-rpc.publicnode.com", "https://gateway.tenderly.co/public/mainnet"] },
  { key: "base", label: "Base", chainId: 8453, env: "BASE_RPC_URL", rpcs: ["https://base-rpc.publicnode.com"] },
  { key: "monad", label: "Monad", chainId: 143, env: "MONAD_RPC_URL", rpcs: ["https://rpc2.monad.xyz"] },
  { key: "gnosis", label: "Gnosis", chainId: 100, env: "GNOSIS_RPC_URL", rpcs: ["https://gnosis-rpc.publicnode.com", "https://gnosis.gateway.tenderly.co"] },
  { key: "arc", label: "Arc", chainId: 5042, env: "X402_RPC", rpcs: ["https://rpc.mainnet.arc.io"] },
  { key: "celo", label: "Celo", chainId: 42220, env: "CELO_RPC_URL", rpcs: ["https://forno.celo.org", "https://celo.gateway.tenderly.co"] },
];

/** The day the pins below were read from the chains. */
export const PINS_VERIFIED = "2026-11-20";

/** The implementation each registry's proxy pointed at on PINS_VERIFIED. It was the same on every chain, except where PINNED_BY_CHAIN says. */
export const PINNED = {
  identity: "0x7274e874ca62410a93bd8bf61c69d8045e399c02",
  reputation: "0x16e0fa7f7c56b9a767e34b192b51f921be31da34",
  validation: "0xdb31f5d9167f8ebc8b30fbbf814c4d297c2d7f99",
};

/**
 * A chain's own pin for a registry, where it was not the one above: the implementation, or null for a proxy that was not deployed there.
 * Robinhood Chain's Validation Registry is its own deployment: the same 5,876 bytes and the same two events as the other chains'
 * implementation, and a different hash of its code (docs/registry-tripwire-2026-11-20.md).
 */
export const PINNED_BY_CHAIN = {
  robinhood: { validation: "0x1b325b4035d264fe04f40a632b6798771127c79a" },
};

export function pinFor(chain, registry) {
  const own = PINNED_BY_CHAIN[chain];
  return own && Object.hasOwn(own, registry) ? own[registry] : PINNED[registry];
}

const TIMEOUT_MS = 15_000;
const ATTEMPTS = 3;
const WAITS_MS = [1_000, 3_000];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * What a storage word says: the implementation address in its low 20 bytes, or null when the slot is empty (no implementation). A
 * word that is not 32 bytes, or that holds anything above the address, is not an EIP-1967 slot and is not guessed at.
 */
export function parseSlot(result) {
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(result)) return { ok: false, reason: "the node's answer was not a 32-byte word" };
  const word = result.slice(2).toLowerCase();
  if (!/^0{24}/.test(word)) return { ok: false, reason: "the slot holds more than an address" };
  const address = `0x${word.slice(24)}`;
  return { ok: true, implementation: /^0x0{40}$/.test(address) ? null : address };
}

/** The node addresses to ask for a chain, in order: the app's own setting (it carries a key) when it is an https address, then the public ones. */
export function endpointsOf(chain, env) {
  const own = chain.env ? String(env[chain.env] ?? "").trim() : "";
  let secure = false;
  try {
    secure = own !== "" && new URL(own).protocol === "https:";
  } catch {
    // not an address, so it is not used
  }
  return [...(secure ? [own] : []), ...chain.rpcs];
}

/**
 * One call to one node. "answer" holds the result; "retry" says the node could not answer now (down, slow, busy, or limiting its
 * callers); "refused" says it answered and the answer is no. The reason is a fixed phrase: never the node's own words or its address.
 */
async function ask(url, body, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": "Nooscape-Registry-Tripwire/1.0 (+https://nooscape.si)" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { kind: "retry", reason: error?.name === "TimeoutError" ? "the node timed out" : "the node could not be reached" };
  }
  if (response.status === 429 || response.status === 403 || response.status >= 500) return { kind: "retry", reason: `the node answered HTTP ${response.status}` };
  let json;
  try {
    json = await response.json();
  } catch {
    return { kind: "refused", reason: response.ok ? "the node did not answer with JSON" : `the node answered HTTP ${response.status}` };
  }
  if (json && typeof json === "object" && json.error) {
    const busy = /rate|limit|busy|too many|try again|timeout/i.test(String(json.error.message ?? ""));
    return busy ? { kind: "retry", reason: "the node is limiting its callers" } : { kind: "refused", reason: "the node refused the call" };
  }
  if (!response.ok) return { kind: "refused", reason: `the node answered HTTP ${response.status}` };
  return { kind: "answer", result: json?.result };
}

/**
 * One proxy's implementation slot, asking each node in turn. A node that cannot answer now is asked again twice, a node that answers
 * no or answers nonsense is not, and the next node is tried. `unreachable` says the last failure was a node that did not answer.
 */
export async function readSlot(endpoints, proxy, { fetchImpl = fetch, wait = sleep } = {}) {
  if (endpoints.length === 0) return { status: "unreadable", reason: "no node address is set", unreachable: true };
  let last = { reason: "the node could not be reached", unreachable: true };
  for (const url of endpoints) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const answer = await ask(url, { jsonrpc: "2.0", id: 1, method: "eth_getStorageAt", params: [proxy, IMPLEMENTATION_SLOT, "latest"] }, fetchImpl);
      if (answer.kind === "answer") {
        const slot = parseSlot(answer.result);
        if (slot.ok) return { status: "read", implementation: slot.implementation };
        last = { reason: slot.reason, unreachable: false };
        break;
      }
      last = { reason: answer.reason, unreachable: answer.kind === "retry" };
      if (answer.kind === "refused") break;
      if (attempt < ATTEMPTS - 1) await wait(WAITS_MS[attempt]);
    }
  }
  return { status: "unreadable", ...last };
}

/**
 * Every slot. The chains are read side by side and the registries of one chain one after another, so a chain's node is asked politely.
 * A chain whose node does not answer is asked once, and its other registries are reported as not read for the same reason.
 */
export async function readAll({ env = process.env, fetchImpl = fetch, wait = sleep } = {}) {
  const perChain = await Promise.all(
    CHAINS.map(async chain => {
      const endpoints = endpointsOf(chain, env);
      const readings = [];
      let down = null;
      for (const registry of REGISTRIES) {
        if (down !== null) {
          readings.push({ chain: chain.key, registry: registry.name, status: "unreadable", reason: down });
          continue;
        }
        const reading = await readSlot(endpoints, registry.proxy, { fetchImpl, wait });
        if (reading.status === "unreadable" && reading.unreachable) down = reading.reason;
        readings.push({ chain: chain.key, registry: registry.name, status: reading.status, implementation: reading.implementation, reason: reading.reason });
      }
      return readings;
    })
  );
  return perChain.flat();
}

const MOST_LISTED = 6;
const labelOf = key => CHAINS.find(chain => chain.key === key)?.label ?? key;
const titleOf = name => REGISTRIES.find(registry => registry.name === name)?.title ?? name;
const show = address => address ?? "no implementation";
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
/** The first few of a list, then how many more, so that one message stays far under a chat message's limit. */
const listed = items => (items.length <= MOST_LISTED ? items.join("; ") : `${items.slice(0, MOST_LISTED).join("; ")}; and ${items.length - MOST_LISTED} more`);

/**
 * What the readings say: the lines to log and the alerts to send. A slot that differs from its pin is a change, one that was not
 * read is said apart, and when neither is there the only message is the Monday line (or the one --heartbeat asks for).
 */
export function evaluate(readings, { now = new Date(), heartbeat = false } = {}) {
  const slots = [];
  const changed = [];
  const notRead = [];
  let matched = 0;
  for (const reading of readings) {
    const name = `${labelOf(reading.chain)} ${titleOf(reading.registry)} Registry`;
    const label = `${reading.chain} ${reading.registry}`.padEnd(22);
    if (reading.status !== "read") {
      notRead.push(`${name} (${reading.reason})`);
      slots.push(`  ${label} not read: ${reading.reason}`);
      continue;
    }
    const pin = pinFor(reading.chain, reading.registry);
    if (reading.implementation === pin) {
      matched += 1;
      slots.push(`  ${label} ${show(reading.implementation)}  matches`);
    } else {
      changed.push(`${name} now ${show(reading.implementation)}, verified ${show(pin)}`);
      slots.push(`  ${label} ${show(reading.implementation)}  DIFFERS, verified ${show(pin)}`);
    }
  }
  const chains = new Set(readings.map(reading => reading.chain)).size;
  const lines = [
    `registry tripwire: ${plural(readings.length, "slot", "slots")} on ${plural(chains, "chain", "chains")}: ${matched} match the pins of ${PINS_VERIFIED}, ${changed.length} differ, ${notRead.length} not read`,
    ...slots,
  ];
  const alerts = [];
  if (changed.length > 0) {
    alerts.push(
      `ERC-8004 registry change: ${plural(changed.length, "proxy slot differs", "proxy slots differ")} from what Nooscape verified on ${PINS_VERIFIED}: ${listed(changed)}. ` +
        "The check's pay_to, the claims and the ratings rest on these registries. Re-check them, then update PINNED in scripts/registry-tripwire.mjs. This repeats on every run until then."
    );
  }
  if (notRead.length > 0) {
    alerts.push(`registry tripwire could not read ${plural(notRead.length, "slot", "slots")}: ${listed(notRead)}. A change in ${notRead.length === 1 ? "that registry" : "those registries"} is not seen until it can.`);
  }
  if (alerts.length === 0 && (heartbeat || now.getUTCDay() === 1)) {
    alerts.push(`registry tripwire is watching: all ${readings.length} proxy slots on ${plural(chains, "chain", "chains")} match the pins of ${PINS_VERIFIED}.`);
  }
  return { lines, alerts };
}

export async function main({ argv = process.argv.slice(2), env = process.env, fetchImpl = fetch, wait = sleep, now = new Date(), out = line => console.log(line) } = {}) {
  if (argv.some(arg => arg !== "--heartbeat")) {
    out("usage: node scripts/registry-tripwire.mjs [--heartbeat]");
    return 2;
  }
  const readings = await readAll({ env, fetchImpl, wait });
  const { lines, alerts } = evaluate(readings, { now, heartbeat: argv.includes("--heartbeat") });
  for (const line of lines) out(line);
  for (const alert of alerts) out(`ALERT: ${alert}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
