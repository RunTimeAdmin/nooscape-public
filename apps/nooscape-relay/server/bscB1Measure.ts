import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FLEET_MIN } from "@shared/noosphere";
import {
  addressesToAsk,
  assignG1,
  buildEntryResult,
  buildRegistry,
  classifyRegistry,
  createCuBucket,
  groupByKey,
  hostOfHttps,
  inlineJsonText,
  isSuppressedHost,
  listingCounts,
  normalizeForTemplate,
  parseRegistrationText,
  probeOutcomeOf,
  readAgentCard,
  summarize,
  templateKeyOf,
  toCsv,
  endpointHostOf,
  type CardReading,
  type EntryResult,
  type G1Entry,
  type ProbeFacts,
  type ReadRecord,
  type RegistrationFacts,
  type RegistryClassification,
  type RegistryRow,
} from "./bscB1";
import {
  BSC_ALLOWED_HOSTNAME,
  BSC_CHAIN_ID_HEX,
  BSC_DEPLOY_BLOCK,
  BSC_IDENTITY_REGISTRY,
  BSC_REGISTERED_TOPIC,
  BSC_URI_UPDATED_TOPIC,
  bscExternalKey,
  parseBscWindowLogs,
  planBscWindows,
  type BscWindow,
} from "./ingestion/bscChain";
import { BscRpcRangeError, callBscRpc, resolveBscRpcUrl } from "./ingestion/bscRpc";
import { ipfsGatewayUrl, ipfsLinkHasCid } from "./ingestion/registrationFetch";
import { createPoliteFetcher } from "./politeFetch";

/**
 * PR-B1, measure only (docs/bsc-b1-measurement-2026-10-16.md). Reads the BNB Chain ERC-8004 registry from the chain,
 * replays the directory listing rules to find the listed entries (G0), groups them (G1), and checks the independent ones
 * (G2). It reads: the chain through the paced client in ingestion/bscRpc.ts, registration files and agent addresses
 * through the safe fetch. It writes only files under the output folder (gitignored). It touches no database and promotes
 * nothing.
 *
 *   BSC_RPC_URL=... tsx server/bscB1Measure.ts scan     the chain, resumable, paced at 75 CU/s
 *   tsx server/bscB1Measure.ts replay                   the listing rules over what the scan read, held against the live counts
 *   tsx server/bscB1Measure.ts fetch                    the registration file of each listed entry
 *   tsx server/bscB1Measure.ts probe                    the addresses of the independent entries
 *   tsx server/bscB1Measure.ts report                   the counts, the csv, the tables
 *
 *   --out <folder>   where the files go (default bsc-b1-output)
 *   --cu <n>         the chain budget in compute units a second (default 75, half of the 150 the plan allows)
 *   --windows <n>    scan at most this many windows (for a trial)
 */

const COSTS: Record<string, number> = { eth_chainId: 5, eth_getBlockByNumber: 15, eth_getLogs: 50 };
const DEFAULT_CU_PER_SECOND = 75;
const MIN_SPLIT_WIDTH = 64;
const PROBE_MAX_BODY_BYTES = 64 * 1024;
const REGISTRATION_MAX_BODY_BYTES = 256 * 1024;
const WEB_CHUNK = 150;
const IPFS_CHUNK = 60;
const PROBE_CHUNK = 250;
const LIVE_PROFILE_URL = "https://nooscape.si/api/trpc/liveData.directoryBscRegistry";

// ------------------------------------------------------------------ small helpers

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name: string, fallback: string): string => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] ? argv[at + 1]! : fallback;
};
const OUT = flag("out", "bsc-b1-output");
const path = (name: string) => join(OUT, name);
const hex = (n: number) => `0x${n.toString(16)}`;
const log = (message: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${message}`);

const readJson = <T>(name: string): T | null => (existsSync(path(name)) ? (JSON.parse(readFileSync(path(name), "utf8")) as T) : null);
const writeJson = (name: string, value: unknown) => {
  const tmp = `${path(name)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path(name));
};
const readLines = <T>(name: string): T[] =>
  existsSync(path(name))
    ? readFileSync(path(name), "utf8")
        .split("\n")
        .filter(line => line.length > 0)
        .map(line => JSON.parse(line) as T)
    : [];
const appendLines = (name: string, rows: unknown[]) => {
  if (rows.length > 0) appendFileSync(path(name), `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
};

type LiveProfile = { at: string; recorded: number; listed: number; grouped: number; withoutProfileLink: number; numericName: number } | null;

/** Nooscape's own public count of the registry, to hold the replay against. */
async function liveProfile(): Promise<LiveProfile> {
  try {
    const response = await fetch(LIVE_PROFILE_URL, { headers: { "User-Agent": "Nooscape-B1-measurement/1.0" } });
    if (!response.ok) return null;
    const body = (await response.json()) as { result?: { data?: { json?: { profile?: Record<string, number> } } } };
    const profile = body.result?.data?.json?.profile;
    if (!profile) return null;
    return {
      at: new Date().toISOString(),
      recorded: profile.recorded ?? 0,
      listed: profile.listed ?? 0,
      grouped: profile.grouped ?? 0,
      withoutProfileLink: profile.withoutProfileLink ?? 0,
      numericName: profile.numericName ?? 0,
    };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ scan: the chain

type ScanState = {
  nextBlock: number;
  finalized: number;
  windows: number;
  registrations: number;
  uriUpdates: number;
  rejected: number;
  requests: number;
  computeUnits: number;
  elapsedMs: number;
  cuPerSecond: number;
  startedAt: string;
  updatedAt: string;
  done: boolean;
  liveBefore: LiveProfile;
  liveAfter: LiveProfile;
};

async function scan() {
  const cuPerSecond = Number(flag("cu", String(DEFAULT_CU_PER_SECOND)));
  if (!(cuPerSecond > 0 && cuPerSecond <= 75)) throw new Error("--cu must be above 0 and at most 75 (half of 150).");
  mkdirSync(OUT, { recursive: true });
  const url = resolveBscRpcUrl(BSC_ALLOWED_HOSTNAME, process.env.BSC_RPC_URL ?? "");
  const state: ScanState = readJson<ScanState>("scan.json") ?? {
    nextBlock: BSC_DEPLOY_BLOCK,
    finalized: 0,
    windows: 0,
    registrations: 0,
    uriUpdates: 0,
    rejected: 0,
    requests: 0,
    computeUnits: 0,
    elapsedMs: 0,
    cuPerSecond,
    startedAt: new Date().toISOString(),
    updatedAt: "",
    done: false,
    liveBefore: null,
    liveAfter: null,
  };
  if (state.done) {
    // A later scan carries on from where the last one stopped, so the replay can be brought up to the chain's head.
    state.done = false;
    state.liveBefore = null;
    state.liveAfter = null;
  }
  state.cuPerSecond = cuPerSecond;
  state.liveBefore = state.liveBefore ?? (await liveProfile());
  const bucket = createCuBucket(cuPerSecond);
  const began = performance.now();
  const elapsedBefore = state.elapsedMs;

  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    const cost = COSTS[method] ?? 50;
    await bucket.take(cost);
    return callBscRpc(method, params, {
      url,
      countAttempt: () => {
        state.requests += 1;
        state.computeUnits += cost;
      },
    });
  };

  const chainId = await rpc("eth_chainId", []);
  if (typeof chainId !== "string" || chainId.toLowerCase() !== BSC_CHAIN_ID_HEX) throw new Error("The endpoint did not confirm chain id 56.");
  const block = (await rpc("eth_getBlockByNumber", ["finalized", false])) as { number?: string } | null;
  const finalized = Number.parseInt(block?.number ?? "", 16);
  if (!Number.isSafeInteger(finalized)) throw new Error("The finalized block could not be read.");
  state.finalized = finalized;

  const windows = planBscWindows(state.nextBlock, finalized, Number(flag("windows", "1000000")));
  log(`scan from block ${state.nextBlock} to finalized ${finalized}: ${windows.length} windows at ${cuPerSecond} CU/s`);

  const fetchWindow = async (window: BscWindow): Promise<unknown[]> => {
    try {
      const logs = await rpc("eth_getLogs", [
        { address: BSC_IDENTITY_REGISTRY, fromBlock: hex(window.from), toBlock: hex(window.to), topics: [[BSC_REGISTERED_TOPIC, BSC_URI_UPDATED_TOPIC]] },
      ]);
      if (!Array.isArray(logs)) throw new Error("The log response was not an array.");
      if (logs.length > 30_000) throw new BscRpcRangeError("result_size", "more logs than a window may hold");
      return logs;
    } catch (error) {
      if (error instanceof BscRpcRangeError && error.reason === "result_size" && window.to - window.from + 1 > MIN_SPLIT_WIDTH) {
        const middle = Math.floor((window.from + window.to) / 2);
        const first = await fetchWindow({ from: window.from, to: middle });
        const second = await fetchWindow({ from: middle + 1, to: window.to });
        return first.concat(second);
      }
      throw error;
    }
  };

  for (const window of windows) {
    const logs = await fetchWindow(window);
    const parsed = parseBscWindowLogs(logs, { fromBlock: window.from, toBlock: window.to });
    appendLines("chain.jsonl", [
      ...parsed.registrations.map(r => ({ k: "r", a: r.agentId, o: r.owner, u: r.uri, b: r.blockNumber, l: r.logIndex })),
      ...parsed.uriUpdates.flatMap(update => (update.uri === null ? [] : [{ k: "u", a: update.externalKey.split(":").pop()!, u: update.uri, b: update.blockNumber, l: update.logIndex }])),
    ]);
    state.windows += 1;
    state.registrations += parsed.registrations.length;
    state.uriUpdates += parsed.uriUpdates.filter(update => update.uri !== null).length;
    state.rejected += parsed.rejectedCount;
    state.nextBlock = window.to + 1;
    state.elapsedMs = elapsedBefore + (performance.now() - began);
    state.updatedAt = new Date().toISOString();
    writeJson("scan.json", state);
    if (state.windows % 25 === 0) {
      log(`window ${state.windows}: block ${state.nextBlock}, ${state.registrations} registrations, ${state.uriUpdates} link updates, ${state.requests} requests, ${state.computeUnits} CU`);
    }
  }
  state.done = state.nextBlock > finalized;
  state.liveAfter = await liveProfile();
  state.elapsedMs = elapsedBefore + (performance.now() - began);
  writeJson("scan.json", state);
  log(`scan done: ${state.registrations} registrations, ${state.uriUpdates} link updates, ${state.requests} requests, ${state.computeUnits} CU in ${Math.round(state.elapsedMs / 1000)} s`);
}

// ------------------------------------------------------------------ the replay, shared by the later phases

type ChainLine = { k: "r" | "u"; a: string; o?: string; u: string; b: number; l: number };

type Replay = { rows: Map<string, RegistryRow>; classification: RegistryClassification; listed: RegistryRow[] };

function replay(): Replay {
  const lines = readLines<ChainLine>("chain.jsonl");
  const registrations = lines.filter(line => line.k === "r").map(line => ({ agentId: line.a, owner: line.o!, uri: line.u, blockNumber: line.b, transactionHash: "", logIndex: line.l }));
  const changes = lines.filter(line => line.k === "u").map(line => ({ agentId: line.a, uri: line.u }));
  const rows = buildRegistry(registrations, changes);
  const classification = classifyRegistry(rows);
  const listed = Array.from(rows.values())
    .filter(row => classification.listing.get(row.agentId) === "listed")
    .sort((a, b) => (BigInt(a.agentId) < BigInt(b.agentId) ? -1 : 1));
  return { rows, classification, listed };
}

function showReplay() {
  const { rows, classification, listed } = replay();
  const scanState = readJson<ScanState>("scan.json");
  const byKind: Record<string, number> = {};
  for (const row of listed) byKind[row.uriKind] = (byKind[row.uriKind] ?? 0) + 1;
  const reasons: Record<string, number> = {};
  for (const state of Array.from(classification.listing.values())) reasons[state] = (reasons[state] ?? 0) + 1;
  console.log(JSON.stringify({ rows: rows.size, replay: listingCounts(classification.listing), states: reasons, listedByUriKind: byKind, liveBefore: scanState?.liveBefore, liveAfter: scanState?.liveAfter }, null, 2));
}

// ------------------------------------------------------------------ fetch: the registration files

type ReadLine = { a: string; s: string; f: RegistrationFacts | null; ms?: number };

const registryAddress = BSC_IDENTITY_REGISTRY;

function readFromText(row: RegistryRow, raw: string, okStatus: "ok" | "inline"): ReadLine {
  const parsed = parseRegistrationText(raw, row.agentId, registryAddress);
  return parsed.ok ? { a: row.agentId, s: okStatus, f: parsed.facts } : { a: row.agentId, s: `body:${parsed.reason}`, f: null };
}

async function fetchRegistrations() {
  const { listed } = replay();
  const done = new Set(readLines<ReadLine>("registrations.jsonl").map(line => line.a));
  const queue = listed.filter(row => !done.has(row.agentId));
  log(`registrations: ${listed.length} listed, ${done.size} already read, ${queue.length} to read`);

  const local: ReadLine[] = [];
  const web: Array<{ row: RegistryRow; url: string }> = [];
  const ipfs: Array<{ row: RegistryRow; url: string }> = [];
  for (const row of queue) {
    if (isSuppressedHost(row.locatorHost)) local.push({ a: row.agentId, s: "not_fetched:suppressed_domain", f: null });
    else if (row.uriKind === "inline-json") {
      const text = inlineJsonText(row.uri);
      local.push(text === null ? { a: row.agentId, s: "inline:undecodable", f: null } : readFromText(row, text, "inline"));
    } else if (row.uriKind === "web") web.push({ row, url: row.uri });
    else if (row.uriKind === "ipfs") {
      const url = ipfsLinkHasCid(row.uri) ? ipfsGatewayUrl(row.uri) : null;
      if (url === null) local.push({ a: row.agentId, s: "not_fetched:no_cid", f: null });
      else ipfs.push({ row, url });
    } else local.push({ a: row.agentId, s: `not_fetched:${row.uriKind}`, f: null });
  }
  appendLines("registrations.jsonl", local);
  log(`read locally: ${local.length}; to fetch: ${web.length} web, ${ipfs.length} ipfs`);

  const stats = { requests: 0, startedAt: Date.now() };
  const interleave = <T extends { row: RegistryRow }>(items: T[]): T[] => {
    // One of each host in turn, so a host's entries are spread out and a chunk does not queue behind one host's pause.
    const byHost = new Map<string, T[]>();
    for (const item of items) {
      const host = hostOfHttps(item.row.uriKind === "web" ? item.row.uri : "") ?? "ipfs";
      const list = byHost.get(host);
      if (list) list.push(item);
      else byHost.set(host, [item]);
    }
    const lists = Array.from(byHost.values());
    const out: T[] = [];
    for (let round = 0; out.length < items.length; round += 1) for (const list of lists) if (list[round]) out.push(list[round]!);
    return out;
  };

  const lane = async (name: string, items: typeof web, chunkSize: number, concurrency: number) => {
    let pending = interleave(items);
    let completed = 0;
    while (pending.length > 0) {
      const chunk = pending.slice(0, chunkSize);
      const rest = pending.slice(chunkSize);
      const fetcher = createPoliteFetcher({ concurrency, budget: 1000 });
      const results = await Promise.all(
        chunk.map(async ({ row, url }): Promise<ReadLine | null> => {
          const began = performance.now();
          const result = await fetcher.fetch(url, { accept: "application/json", maxBodyBytes: REGISTRATION_MAX_BODY_BYTES });
          const ms = Math.round(performance.now() - began);
          if (!result.ok) return result.reason === "budget_exhausted" ? null : ({ a: row.agentId, s: `fetch:${result.reason}`, f: null, ms } satisfies ReadLine);
          if (result.status < 200 || result.status >= 300) return { a: row.agentId, s: `http:${result.status}`, f: null, ms } satisfies ReadLine;
          if (result.truncated) return { a: row.agentId, s: "body:too_large", f: null, ms } satisfies ReadLine;
          return { ...readFromText(row, new TextDecoder("utf-8", { fatal: false }).decode(result.body), "ok"), ms };
        })
      );
      stats.requests += fetcher.spent();
      const written = results.filter((line): line is ReadLine => line !== null);
      appendLines("registrations.jsonl", written);
      completed += written.length;
      const retry = chunk.filter((_, index) => results[index] === null);
      pending = retry.length === chunk.length ? [] : [...rest, ...retry];
      log(`${name}: ${completed}/${items.length} read`);
    }
  };

  await Promise.all([lane("web", web, WEB_CHUNK, 5), lane("ipfs", ipfs, IPFS_CHUNK, 2)]);
  const previous = readJson<{ fetch?: { requests: number; seconds: number } }>("run-stats.json") ?? {};
  writeJson("run-stats.json", { ...previous, fetch: { requests: (previous.fetch?.requests ?? 0) + stats.requests, seconds: (previous.fetch?.seconds ?? 0) + Math.round((Date.now() - stats.startedAt) / 1000) } });
  log("registrations done");
}

// ------------------------------------------------------------------ the groups, shared by probe and report

type Analysis = {
  replay: Replay;
  reads: Map<string, ReadRecord>;
  entries: G1Entry[];
  g1: ReturnType<typeof assignG1>;
  templateKeys: Map<string, string | null>;
  walletListed: Map<string, number>;
};

function analyze(): Analysis {
  const state = replay();
  const reads = new Map<string, ReadRecord>();
  for (const line of readLines<ReadLine>("registrations.jsonl")) reads.set(line.a, { status: line.s, facts: line.f });
  const missing = state.listed.filter(row => !reads.has(row.agentId)).length;
  if (missing > 0) throw new Error(`${missing} listed entries have no registration read yet. Run fetch first.`);
  const templateKeys = new Map<string, string | null>();
  const walletListed = new Map<string, number>();
  for (const row of state.listed) {
    const read = reads.get(row.agentId)!;
    templateKeys.set(row.agentId, read.facts && (read.status === "ok" || read.status === "inline") ? templateKeyOf(read.facts) : null);
    walletListed.set(row.owner, (walletListed.get(row.owner) ?? 0) + 1);
  }
  const entries = state.listed.map(row => ({ agentId: row.agentId, owner: row.owner, templateKey: templateKeys.get(row.agentId) ?? null }));
  return { replay: state, reads, entries, g1: assignG1(entries, state.classification.walletSize), templateKeys, walletListed };
}

// ------------------------------------------------------------------ probe: the addresses

type ProbeLine = { url: string; a2a: boolean; outcome: string; status: number | null; reason: string; ms: number | null; card: CardReading | null };

const independentTargets = (analysis: Analysis): Array<{ row: RegistryRow; urls: string[]; a2a: Set<string> }> =>
  analysis.replay.listed.flatMap(row => {
    if (analysis.g1.byAgent.get(row.agentId)?.kind !== "independent") return [];
    const read = analysis.reads.get(row.agentId)!;
    if (!read.facts || (read.status !== "ok" && read.status !== "inline")) return [];
    const urls = addressesToAsk(read.facts).filter(url => !isSuppressedHost(hostOfHttps(url)));
    return urls.length > 0 ? [{ row, urls, a2a: new Set(read.facts.a2aEndpoints) }] : [];
  });

async function probe() {
  const analysis = analyze();
  const targets = independentTargets(analysis);
  const a2a = new Set(targets.flatMap(target => Array.from(target.a2a)));
  const urls = Array.from(new Set(targets.flatMap(target => target.urls)));
  const done = new Set(readLines<ProbeLine>("probes.jsonl").map(line => line.url));
  let pending = urls.filter(url => !done.has(url));
  log(`probe: ${targets.length} independent entries with an address, ${urls.length} distinct addresses, ${done.size} already asked`);
  const began = Date.now();
  let requests = 0;
  let asked = 0;
  while (pending.length > 0) {
    const chunk = pending.slice(0, PROBE_CHUNK);
    const rest = pending.slice(PROBE_CHUNK);
    const fetcher = createPoliteFetcher({ concurrency: 5, budget: 1000 });
    const results = await Promise.all(
      chunk.map(async (url): Promise<ProbeLine | null> => {
        const result = await fetcher.fetch(url, { maxBodyBytes: PROBE_MAX_BODY_BYTES });
        if (!result.ok && result.reason === "budget_exhausted") return null;
        const isCard = a2a.has(url);
        let card: CardReading | null = null;
        if (result.ok && isCard && result.status >= 200 && result.status < 300) {
          card = result.truncated ? { state: "invalid", reason: "too_large" } : readAgentCard(new TextDecoder("utf-8", { fatal: false }).decode(result.body));
        }
        return {
          url,
          a2a: isCard,
          outcome: probeOutcomeOf(result),
          status: result.ok ? result.status : null,
          reason: result.ok ? "" : result.reason,
          ms: result.ok ? result.latencyMs : null,
          card,
        };
      })
    );
    requests += fetcher.spent();
    const written = results.filter((line): line is ProbeLine => line !== null);
    appendLines("probes.jsonl", written);
    asked += written.length;
    const retry = chunk.filter((_, index) => results[index] === null);
    pending = retry.length === chunk.length ? [] : [...rest, ...retry];
    log(`probe: ${asked}/${urls.length - done.size} asked`);
  }
  const previous = readJson<{ probe?: { requests: number; seconds: number } }>("run-stats.json") ?? {};
  writeJson("run-stats.json", { ...previous, probe: { requests: (previous.probe?.requests ?? 0) + requests, seconds: (previous.probe?.seconds ?? 0) + Math.round((Date.now() - began) / 1000) } });
  log("probe done");
}

// ------------------------------------------------------------------ report

async function report() {
  const analysis = analyze();
  const probes = new Map<string, ProbeLine>();
  for (const line of readLines<ProbeLine>("probes.jsonl")) probes.set(line.url, line);
  const targets = new Map(independentTargets(analysis).map(target => [target.row.agentId, target]));
  const unasked = Array.from(targets.values()).flatMap(target => target.urls).filter(url => !probes.has(url)).length;
  if (unasked > 0) throw new Error(`${unasked} addresses have not been asked yet. Run probe first.`);

  const { replay: state, reads, g1 } = analysis;
  // The listed entries that were read, and for each agent endpoint host the listed entries that declare it.
  const readable = state.listed.flatMap(row => {
    const read = reads.get(row.agentId)!;
    return read.facts && (read.status === "ok" || read.status === "inline") ? [{ id: row.agentId, facts: read.facts }] : [];
  });
  const hostMembers = new Map<string, Set<string>>();
  for (const item of readable) {
    for (const endpoint of item.facts.agentEndpoints) {
      const host = hostOfHttps(endpoint);
      if (host === null) continue;
      const members = hostMembers.get(host);
      if (members) members.add(item.id);
      else hostMembers.set(host, new Set([item.id]));
    }
  }
  const hostGroupSizeOf = (facts: RegistrationFacts | null): number =>
    Math.max(0, ...(facts?.agentEndpoints ?? []).map(endpoint => hostMembers.get(hostOfHttps(endpoint) ?? "")?.size ?? 0));
  const results: EntryResult[] = state.listed.map(row => {
    const read = reads.get(row.agentId)!;
    const g1Entry = g1.byAgent.get(row.agentId)!;
    const target = targets.get(row.agentId);
    const facts = read.facts;
    let notProbedWhy = "not_independent";
    let asked: ProbeFacts[] | null = null;
    if (g1Entry.kind === "independent") {
      if (!facts || (read.status !== "ok" && read.status !== "inline")) notProbedWhy = "no_registration";
      else if (target) {
        asked = target.urls.map(url => {
          const line = probes.get(url)!;
          return { url, a2a: line.a2a, outcome: line.outcome as ProbeFacts["outcome"], status: line.status, reason: line.reason, card: line.card };
        });
      } else notProbedWhy = facts.agentEndpoints.length === 0 ? "no_agent_endpoint" : "placeholder_endpoint";
    }
    return buildEntryResult({
      row,
      externalKey: bscExternalKey(row.agentId),
      walletRegistrations: g1Entry.walletRegistrations,
      walletListed: analysis.walletListed.get(row.owner) ?? 0,
      read,
      g1: { kind: g1Entry.kind, templateSize: g1Entry.templateSize },
      templateKey: analysis.templateKeys.get(row.agentId) ?? null,
      hostGroupSize: hostGroupSizeOf(facts),
      probes: asked,
      notProbedWhy,
    });
  });

  // Group tables over all listed entries that were read: the composite template, the name and description alone, and the host alone.
  const sizes = (keyOf: (facts: RegistrationFacts) => string | null) => groupByKey(readable.map(item => ({ id: item.id, key: keyOf(item.facts) })), 2).map(group => group.members.length);
  const summary = summarize(results, {
    suppressedSkipped: results.filter(entry => entry.read === "not_fetched:suppressed_domain").length,
    walletSizes: Array.from(analysis.walletListed.values()),
    sharedHostSizes: sizes(facts => endpointHostOf(facts)),
    sameTextSizes: sizes(facts => (facts.name === null && facts.description === null ? null : `${normalizeForTemplate(facts.name)}\u0000${normalizeForTemplate(facts.description)}`)),
    templateSizes: g1.templates.map(group => group.members.length),
  });

  // The fleets: the wallets over the whole registry that reach the fleet minimum, and the largest template groups among the listed.
  const fleetWallets = Array.from(state.classification.walletSize, ([wallet, size]) => ({ wallet, size })).filter(item => item.size >= FLEET_MIN).sort((a, b) => b.size - a.size);
  const nameOf = (id: string) => reads.get(id)?.facts?.name ?? "";
  const fleets = {
    registryWide: {
      minimum: FLEET_MIN,
      wallets: fleetWallets.length,
      registrations: fleetWallets.reduce((sum, item) => sum + item.size, 0),
      largest: fleetWallets.slice(0, 15),
      listedMembers: results.filter(entry => entry.g1 === "wallet_fleet" || entry.g1 === "wallet_fleet_and_template_group").length,
    },
    endpointHosts: Array.from(hostMembers, ([host, members]) => ({ host, members: Array.from(members) }))
      .sort((a, b) => b.members.length - a.members.length || (a.host < b.host ? -1 : 1))
      .slice(0, 20)
      .map(({ host, members }) => ({
        host,
        listed: members.length,
        wallets: new Set(members.map(id => state.rows.get(id)!.owner)).size,
        independent: members.filter(id => g1.byAgent.get(id)?.kind === "independent").length,
        g2: results.filter(entry => members.includes(entry.agentId) && entry.g2).length,
      })),
    templates: g1.templates.slice(0, 25).map(group => ({
      members: group.members.length,
      wallets: new Set(group.members.map(id => state.rows.get(id)!.owner)).size,
      host: (reads.get(group.members[0]!)?.facts && endpointHostOf(reads.get(group.members[0]!)!.facts!)) || "",
      sampleName: nameOf(group.members[0]!).slice(0, 60),
    })),
  };

  const scanState = readJson<ScanState>("scan.json");
  const runStats = readJson<Record<string, unknown>>("run-stats.json");
  const replayCounts = listingCounts(state.classification.listing);
  writeFileSync(path("entries.csv"), toCsv(results));
  writeJson("summary.json", { generatedAt: new Date().toISOString(), replay: replayCounts, live: { before: scanState?.liveBefore ?? null, after: scanState?.liveAfter ?? null }, scan: scanState, runStats, fleets, summary });
  log(`wrote ${path("entries.csv")} (${results.length} rows) and ${path("summary.json")}`);
  console.log(JSON.stringify({ replay: replayCounts, live: { before: scanState?.liveBefore ?? null, after: scanState?.liveAfter ?? null } }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(fleets, null, 2));
}

// ------------------------------------------------------------------ main

async function main() {
  if (command === "scan") await scan();
  else if (command === "replay") showReplay();
  else if (command === "fetch") await fetchRegistrations();
  else if (command === "probe") await probe();
  else if (command === "report") await report();
  else {
    console.error("Usage: tsx server/bscB1Measure.ts <scan|replay|fetch|probe|report> [--out folder] [--cu n]");
    process.exitCode = 2;
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  error => {
    // A failure is reported by its message. The chain client's messages never hold the endpoint.
    console.error(`bscB1Measure failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
);
