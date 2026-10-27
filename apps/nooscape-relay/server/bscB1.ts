import { createHash } from "node:crypto";
import { FLEET_MIN } from "@shared/noosphere";
import { bscHasProfileLink, bscUriFacts, type BscRegistration } from "./ingestion/bscChain";
import type { UriKind } from "./ingestion/robinhood";

/**
 * PR-B1, measure only (docs/bsc-b1-measurement-2026-10-16.md). The pure part of the BNB gate measurement: it replays the
 * directory listing rules over the registrations read from the chain, groups the listed entries into fleets and templates
 * (gate G1), and reads a fetched registration file for the completeness and junk checks (gate G2). Nothing here touches
 * the network, the database or the reviewed census; `bscB1Measure.ts` does the reading and calls these.
 *
 * Nothing in this module changes a rule. The listing thresholds below are a copy of `BSC_LISTING_RULES`
 * (agentRegistryRows.ts), kept here so a measurement run does not load the database module, and a test pins the two equal.
 */

export const B1_LISTING_RULES = { sharedProfileLinkFrom: 2, sharedHostFrom: 50, sharedWalletFrom: 10 } as const;
/** Domains the directory never surfaces (db.ts SUPPRESSED_LOCATOR_DOMAINS, pinned by a test). A run asks nothing of them. */
export const B1_SUPPRESSED_DOMAINS: readonly string[] = ["agentrank.info"];

export const isSuppressedHost = (host: string | null | undefined): boolean => {
  if (!host) return false;
  const lower = host.trim().toLowerCase();
  return B1_SUPPRESSED_DOMAINS.some(domain => lower === domain || lower.endsWith(`.${domain}`));
};

// ------------------------------------------------------------------ the registry, as the listing rules see it

export type RegistryRow = {
  agentId: string;
  /** The wallet the Registered event names. Never changes. */
  owner: string;
  /** What the directory row is called: the inline name at registration, else "Agent #id". Never changes. */
  displayName: string;
  /** The URI as it stands after the last URIUpdated. */
  uri: string;
  uriKind: UriKind;
  locatorHost: string | null;
  profileUriHash: string;
  hasLink: boolean;
};

type UriChange = { agentId: string; uri: string };

const rowFor = (registration: BscRegistration): RegistryRow => {
  const facts = bscUriFacts(registration.uri);
  return {
    agentId: registration.agentId,
    owner: registration.owner,
    displayName: facts.inlineName ? facts.inlineName.slice(0, 255) : `Agent #${registration.agentId}`,
    uri: registration.uri,
    uriKind: facts.uriKind,
    locatorHost: facts.locatorHost,
    profileUriHash: facts.profileUriHash,
    hasLink: bscHasProfileLink(facts),
  };
};

/**
 * The registry rows the pass would hold: the first Registered event of an agent wins (the pass inserts ignoring a repeat),
 * then each URIUpdated replaces the link of a row that exists, in chain order, the last one winning. The name and the
 * wallet stay as registered. Both inputs have to be in chain order.
 */
export function buildRegistry(registrations: Iterable<BscRegistration>, changes: Iterable<UriChange>): Map<string, RegistryRow> {
  const rows = new Map<string, RegistryRow>();
  for (const registration of Array.from(registrations)) if (!rows.has(registration.agentId)) rows.set(registration.agentId, rowFor(registration));
  for (const change of Array.from(changes)) {
    const row = rows.get(change.agentId);
    if (!row) continue;
    const facts = bscUriFacts(change.uri);
    row.uri = change.uri;
    row.uriKind = facts.uriKind;
    row.locatorHost = facts.locatorHost;
    row.profileUriHash = facts.profileUriHash;
    row.hasLink = bscHasProfileLink(facts);
  }
  return rows;
}

export type Listing = "listed" | "grouped_shared_link" | "grouped_platform_host" | "grouped_mass_registrant" | "no_link" | "numeric_name";

export type RegistryClassification = {
  listing: Map<string, Listing>;
  /** Registrations per wallet, over every row. */
  walletSize: Map<string, number>;
  hostSize: Map<string, number>;
  hashSize: Map<string, number>;
};

const bump = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);

/**
 * The listing rules of `classifyAgentRegistryListing`, over the current facts: no usable link is excluded, then a name that
 * is only a number, then a link recorded by two or more rows, a host recorded by fifty or more, a wallet that registered
 * ten or more; whatever is left is listed. Every count is over all rows, listed or not.
 */
export function classifyRegistry(rows: Map<string, RegistryRow>, rules: typeof B1_LISTING_RULES = B1_LISTING_RULES): RegistryClassification {
  const walletSize = new Map<string, number>();
  const hostSize = new Map<string, number>();
  const hashSize = new Map<string, number>();
  for (const row of Array.from(rows.values())) {
    bump(hashSize, row.profileUriHash);
    if (row.locatorHost) bump(hostSize, row.locatorHost);
    bump(walletSize, row.owner);
  }
  const listing = new Map<string, Listing>();
  for (const row of Array.from(rows.values())) {
    let state: Listing;
    if (!row.hasLink) state = "no_link";
    else if (/^[0-9]+$/.test(row.displayName)) state = "numeric_name";
    else if ((hashSize.get(row.profileUriHash) ?? 0) >= rules.sharedProfileLinkFrom) state = "grouped_shared_link";
    else if (row.locatorHost && (hostSize.get(row.locatorHost) ?? 0) >= rules.sharedHostFrom) state = "grouped_platform_host";
    else if ((walletSize.get(row.owner) ?? 0) >= rules.sharedWalletFrom) state = "grouped_mass_registrant";
    else state = "listed";
    listing.set(row.agentId, state);
  }
  return { listing, walletSize, hostSize, hashSize };
}

type ListingCounts = { recorded: number; listed: number; grouped: number; withoutProfileLink: number; numericName: number };

/** The same five numbers the public registry profile prints, so a replay can be held against it. */
export function listingCounts(listing: Map<string, Listing>): ListingCounts {
  const counts: ListingCounts = { recorded: listing.size, listed: 0, grouped: 0, withoutProfileLink: 0, numericName: 0 };
  for (const state of Array.from(listing.values())) {
    if (state === "listed") counts.listed += 1;
    else if (state === "no_link") counts.withoutProfileLink += 1;
    else if (state === "numeric_name") counts.numericName += 1;
    else counts.grouped += 1;
  }
  return counts;
}

// ------------------------------------------------------------------ pacing for the chain

export { createCuBucket } from "./ingestion/cuBucket";

// ------------------------------------------------------------------ reading a registration file

const MAX_NAME_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 2_000;

/** Service names and hosts that point at a person or a profile and not at the agent: asked of no one, and not an agent endpoint. */
const SOCIAL_SERVICE_NAMES: ReadonlySet<string> = new Set([
  "twitter", "x", "github", "gitlab", "telegram", "discord", "farcaster", "warpcast", "lens", "linkedin", "youtube", "medium", "mirror",
  "email", "mail", "ens", "did", "wallet", "agentwallet", "avatar", "image", "logo", "icon", "docs", "documentation", "whitepaper", "blog", "contact",
]);
const SOCIAL_HOSTS: readonly string[] = [
  "x.com", "twitter.com", "github.com", "gitlab.com", "t.me", "telegram.me", "telegram.org", "discord.com", "discord.gg", "warpcast.com", "farcaster.xyz",
  "linkedin.com", "youtube.com", "youtu.be", "medium.com", "mirror.xyz", "instagram.com", "facebook.com", "reddit.com", "tiktok.com", "linktr.ee",
];

const isSocialHost = (host: string) => SOCIAL_HOSTS.some(social => host === social || host.endsWith(`.${social}`));

type DeclaredService = { name: string; endpoint: string };

export type RegistrationFacts = {
  name: string | null;
  description: string | null;
  hasImage: boolean;
  /** The file says it is an ERC-8004 registration (its `type` names the standard). */
  typeMarker: boolean;
  /** `registrations` names this registry and this agent id. */
  backReference: boolean;
  x402: boolean;
  /** Every service the file declares with an endpoint string. */
  services: DeclaredService[];
  /** https endpoints that are not a profile of a person: the addresses an agent can be asked at, in the order declared, without repeats. */
  agentEndpoints: string[];
  /** https endpoints of the A2A services, which are agent cards. */
  a2aEndpoints: string[];
  /** Endpoints that are a profile page or a social account. */
  socialEndpointCount: number;
  /** Endpoints that are not https (an ENS name, a DID, a wallet, plain http). */
  otherEndpointCount: number;
  /**
   * https addresses that are not a profile and sit outside the standard's `endpoint` field: a service's `url`, or the file's
   * own `website`, `external_url` or `url`. Counted and never asked.
   */
  altAddressCount: number;
};

type ParsedRegistration = { ok: true; facts: RegistrationFacts } | { ok: false; reason: "not_json" | "not_object" };

const text = (value: unknown, cap: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, cap) : null;
};

const httpsHostOf = (value: string): string | null => {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hostname.length === 0) return null;
    return url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
};

/** The host of an https address, lower case, or null. */
export const hostOfHttps = httpsHostOf;

/** Reads the fields of an ERC-8004 registration file out of its text. `agentId` is only used to read the back reference. */
export function parseRegistrationText(raw: string, agentId: string, registry: string): ParsedRegistration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^﻿/, ""));
  } catch {
    return { ok: false, reason: "not_json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "not_object" };
  const record = parsed as Record<string, unknown>;
  const declared = Array.isArray(record.services) ? record.services : Array.isArray(record.endpoints) ? record.endpoints : [];
  const services: DeclaredService[] = [];
  for (const item of declared) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const service = item as Record<string, unknown>;
    const endpoint = text(service.endpoint, 2_048);
    if (endpoint) services.push({ name: (text(service.name, 64) ?? "").toLowerCase(), endpoint });
  }
  const agentEndpoints: string[] = [];
  const a2aEndpoints: string[] = [];
  let socialEndpointCount = 0;
  let otherEndpointCount = 0;
  for (const service of services) {
    const host = httpsHostOf(service.endpoint);
    if (host === null) {
      otherEndpointCount += 1;
      continue;
    }
    if (SOCIAL_SERVICE_NAMES.has(service.name) || isSocialHost(host)) {
      socialEndpointCount += 1;
      continue;
    }
    if (!agentEndpoints.includes(service.endpoint)) agentEndpoints.push(service.endpoint);
    if (service.name === "a2a" && !a2aEndpoints.includes(service.endpoint)) a2aEndpoints.push(service.endpoint);
  }
  const altAddresses: string[] = [];
  const addAlt = (value: unknown) => {
    const address = text(value, 2_048);
    const host = address === null ? null : httpsHostOf(address);
    if (address === null || host === null || isSocialHost(host) || agentEndpoints.includes(address) || altAddresses.includes(address)) return;
    altAddresses.push(address);
  };
  for (const item of declared) if (item && typeof item === "object" && !Array.isArray(item)) addAlt((item as Record<string, unknown>).url);
  addAlt(record.website);
  addAlt(record.external_url);
  addAlt(record.url);
  const registrations = Array.isArray(record.registrations) ? record.registrations : [];
  const backReference = registrations.some(item => {
    if (!item || typeof item !== "object") return false;
    const entry = item as Record<string, unknown>;
    return typeof entry.agentRegistry === "string" && entry.agentRegistry.toLowerCase().includes(registry.toLowerCase()) && String(entry.agentId) === agentId;
  });
  return {
    ok: true,
    facts: {
      name: text(record.name, MAX_NAME_CHARS),
      description: text(record.description, MAX_DESCRIPTION_CHARS),
      hasImage: text(record.image, 2_048) !== null,
      typeMarker: typeof record.type === "string" && /eip-?8004/i.test(record.type),
      backReference,
      x402: record.x402Support === true,
      services,
      agentEndpoints,
      a2aEndpoints,
      socialEndpointCount,
      otherEndpointCount,
      altAddressCount: altAddresses.length,
    },
  };
}

/** The JSON text inside an inline `data:application/json` URI, or null when it cannot be decoded. */
export function inlineJsonText(uri: string): string | null {
  if (!uri.startsWith("data:application/json")) return null;
  const comma = uri.indexOf(",");
  if (comma < 0) return null;
  const parameters = uri.slice("data:".length, comma);
  const payload = uri.slice(comma + 1);
  if (/;base64/i.test(parameters)) return Buffer.from(payload, "base64").toString("utf8");
  try {
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}

/** D, the headline definition: a name, a description, and at least one https address an agent can be asked at. */
export const isComplete = (facts: RegistrationFacts): boolean => facts.name !== null && facts.description !== null && facts.agentEndpoints.length > 0;
/** D, the stricter definition: the headline plus an image, the standard's `type`, and a back reference to this registry and agent id. */
const isFullyComplete = (facts: RegistrationFacts): boolean => isComplete(facts) && facts.hasImage && facts.typeMarker && facts.backReference;

// ------------------------------------------------------------------ junk and empty

// Built from strings: the project compiles without a target, which refuses the `u` flag on a literal.
const UNICODE_NON_ALNUM = new RegExp(String.raw`[^\p{L}\p{N}]+`, "gu");
const UNICODE_DIGITS = new RegExp(String.raw`\p{N}+`, "gu");
const UNICODE_NON_LETTER = new RegExp(String.raw`[^\p{L}0]+`, "gu");

/** Lower case, NFKC, anything that is not a letter or digit turned to a space, runs of space made one. Digits are kept. */
export const squash = (value: string): string =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(UNICODE_NON_ALNUM, " ")
    .trim();

const PLACEHOLDER_NAMES: ReadonlySet<string> = new Set([
  "test", "testing", "test agent", "agent", "my agent", "new agent", "untitled", "unnamed", "example", "demo", "sample", "name", "string", "null",
  "undefined", "todo", "tbd", "na", "n a", "none", "foo", "bar", "asdf", "qwerty", "hello", "hello world", "agent name", "your agent", "ai agent",
]);
const PLACEHOLDER_NAME_PATTERN = /^(test|demo|sample|example|agent)( agent)?( \d+)?$/;
const PLACEHOLDER_DESCRIPTIONS: ReadonlySet<string> = new Set([
  "description", "a description", "test", "testing", "string", "null", "undefined", "todo", "tbd", "na", "n a", "none", "my agent", "an ai agent",
  "ai agent", "agent description", "your description here", "description here", "no description", "add description", "just a test", "this is a test",
]);
const PLACEHOLDER_HOSTS = ["example.com", "example.org", "example.net", "localhost", "yourdomain.com", "your-domain.com", "domain.com"];
const PLACEHOLDER_SUFFIXES = [".example", ".test", ".invalid", ".localhost", ".local", ".example.com", ".example.org", ".example.net"];
const PRIVATE_ADDRESS = /^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|172\.(1[6-9]|2\d|3[01])\.)/;

const SHORT_NAME_CHARS = 2;
const SHORT_DESCRIPTION_CHARS = 10;

type JunkFlag = "placeholder_name" | "placeholder_description" | "placeholder_endpoint" | "short_name" | "short_description" | "name_is_description";

const isPlaceholderHost = (host: string): boolean => PLACEHOLDER_HOSTS.includes(host) || PLACEHOLDER_SUFFIXES.some(suffix => host.endsWith(suffix)) || PRIVATE_ADDRESS.test(host);

/**
 * Why a registration reads as placeholder text or as no effort, from the text alone. A heuristic list, and every flag is
 * reported by name so a reader can drop one: a name or description that is a stock placeholder, one that is nearly empty,
 * a description that only repeats the name, and an agent whose every address is an example or private one.
 */
export function junkFlags(facts: RegistrationFacts): JunkFlag[] {
  const flags: JunkFlag[] = [];
  const name = facts.name === null ? null : squash(facts.name);
  const description = facts.description === null ? null : squash(facts.description);
  if (name !== null && (PLACEHOLDER_NAMES.has(name) || PLACEHOLDER_NAME_PATTERN.test(name))) flags.push("placeholder_name");
  if (description !== null && (PLACEHOLDER_DESCRIPTIONS.has(description) || description.startsWith("lorem ipsum"))) flags.push("placeholder_description");
  if (facts.agentEndpoints.length > 0 && facts.agentEndpoints.every(endpoint => isPlaceholderHost(httpsHostOf(endpoint) ?? ""))) flags.push("placeholder_endpoint");
  if (facts.name !== null && facts.name.length < SHORT_NAME_CHARS) flags.push("short_name");
  if (facts.description !== null && facts.description.length < SHORT_DESCRIPTION_CHARS) flags.push("short_description");
  if (name !== null && description !== null && name === description) flags.push("name_is_description");
  return flags;
}

// ------------------------------------------------------------------ an A2A agent card (check C, on an address the registration names)

export type CardReading = { state: "valid" } | { state: "invalid"; reason: "not_json" | "not_object" | "no_name" | "no_description" | "no_address" | "too_large" };

/** An agent card is valid here when it is a JSON object with a name, a description and an address (`url` or a `supportedInterfaces` url). */
export function readAgentCard(raw: string): CardReading {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^﻿/, ""));
  } catch {
    return { state: "invalid", reason: "not_json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { state: "invalid", reason: "not_object" };
  const card = parsed as Record<string, unknown>;
  if (text(card.name, MAX_NAME_CHARS) === null) return { state: "invalid", reason: "no_name" };
  if (text(card.description, MAX_DESCRIPTION_CHARS) === null) return { state: "invalid", reason: "no_description" };
  const interfaces = Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces : [];
  const hasAddress =
    text(card.url, 2_048) !== null ||
    interfaces.some(item => item && typeof item === "object" && text((item as Record<string, unknown>).url, 2_048) !== null);
  return hasAddress ? { state: "valid" } : { state: "invalid", reason: "no_address" };
}

/** The most addresses of one agent that are asked. */
const PROBES_PER_AGENT = 2;

/** The addresses to ask for an agent: its first agent addresses that are not example or private hosts. */
export const addressesToAsk = (facts: RegistrationFacts): string[] =>
  facts.agentEndpoints.filter(endpoint => !isPlaceholderHost(httpsHostOf(endpoint) ?? "")).slice(0, PROBES_PER_AGENT);

// ------------------------------------------------------------------ answering (check A)

type ProbeOutcome = "answered" | "no_answer" | "skipped";
const NO_ANSWER_REASONS: ReadonlySet<string> = new Set(["timeout", "connection_failed", "tls_failed", "response_invalid", "unresolvable"]);

/** What the liveness check records for a fetch result (agentChecks.factsOf; a test pins the two together): a complete HTTP answer, a host that did not answer in full, or an ask a rule stopped. */
export function probeOutcomeOf(result: { ok: true } | { ok: false; reason: string }): ProbeOutcome {
  if (result.ok) return "answered";
  return NO_ANSWER_REASONS.has(result.reason) ? "no_answer" : "skipped";
}

// ------------------------------------------------------------------ templates and fleets (gate G1)

/** NFKC, lower case, every run of digits turned to one 0, anything else that is not a letter made one space. */
export const normalizeForTemplate = (value: string | null): string =>
  value === null
    ? ""
    : value
        .normalize("NFKC")
        .toLowerCase()
        .replace(UNICODE_DIGITS, "0")
        .replace(UNICODE_NON_LETTER, " ")
        .trim()
        .slice(0, 2_000);

/** The host of the first address an agent can be asked at, or null. */
export const endpointHostOf = (facts: RegistrationFacts): string | null => (facts.agentEndpoints[0] ? httpsHostOf(facts.agentEndpoints[0]) : null);

/**
 * The template of a registration: its normalized name, its normalized description and the host of its first agent address,
 * hashed. Null when it has neither a name nor a description, so there is nothing to compare. The URI hash is not part of
 * it: a link shared by two registrations is already held out by the listing rules, so every listed entry has its own.
 */
export function templateKeyOf(facts: RegistrationFacts): string | null {
  if (facts.name === null && facts.description === null) return null;
  const parts = [normalizeForTemplate(facts.name), normalizeForTemplate(facts.description), endpointHostOf(facts) ?? ""];
  return createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 16);
}

export type FleetGroup = { key: string; members: string[] };

/** Groups of `minSize` members or more, largest first. A null key joins no group. */
export function groupByKey(members: Array<{ id: string; key: string | null }>, minSize: number): FleetGroup[] {
  const byKey = new Map<string, string[]>();
  for (const member of members) {
    if (member.key === null) continue;
    const list = byKey.get(member.key);
    if (list) list.push(member.id);
    else byKey.set(member.key, [member.id]);
  }
  return Array.from(byKey, ([key, ids]) => ({ key, members: ids }))
    .filter(group => group.members.length >= minSize)
    .sort((a, b) => b.members.length - a.members.length || (a.key < b.key ? -1 : 1));
}

export type G1Entry = { agentId: string; owner: string; templateKey: string | null };
type G1Kind = "independent" | "wallet_fleet" | "template_group" | "wallet_fleet_and_template_group";
type G1Options = { fleetMin?: number; templateMin?: number };

type G1Result = {
  byAgent: Map<string, { kind: G1Kind; walletRegistrations: number; templateSize: number }>;
  walletFleets: FleetGroup[];
  templates: FleetGroup[];
};

/**
 * Gate G1 over the listed entries. A wallet is a fleet when it registered `fleetMin` agents or more (the registry's own
 * count, `walletSize`, as the map's fleets use it), and its listed entries leave the pool. A template is two or more listed
 * entries with the same template key (`templateMin`). An entry in neither is independent.
 */
export function assignG1(entries: G1Entry[], walletSize: Map<string, number>, options: G1Options = {}): G1Result {
  const fleetMin = options.fleetMin ?? FLEET_MIN;
  const templateMin = options.templateMin ?? 2;
  const walletFleets = groupByKey(
    entries.map(entry => ({ id: entry.agentId, key: (walletSize.get(entry.owner) ?? 0) >= fleetMin ? entry.owner : null })),
    1
  );
  const templates = groupByKey(entries.map(entry => ({ id: entry.agentId, key: entry.templateKey })), templateMin);
  const inFleet = new Set(walletFleets.flatMap(group => group.members));
  const templateSize = new Map<string, number>();
  for (const group of templates) for (const id of group.members) templateSize.set(id, group.members.length);
  const byAgent: G1Result["byAgent"] = new Map();
  for (const entry of entries) {
    const fleet = inFleet.has(entry.agentId);
    const template = templateSize.has(entry.agentId);
    byAgent.set(entry.agentId, {
      kind: fleet && template ? "wallet_fleet_and_template_group" : fleet ? "wallet_fleet" : template ? "template_group" : "independent",
      walletRegistrations: walletSize.get(entry.owner) ?? 0,
      templateSize: templateSize.get(entry.agentId) ?? 1,
    });
  }
  return { byAgent, walletFleets, templates };
}

/** For each bar, how many groups reach it and how many members they hold. */
export function sizeTable(groupSizes: number[], bars: number[]): Array<{ bar: number; groups: number; members: number }> {
  return bars.map(bar => {
    const reaching = groupSizes.filter(size => size >= bar);
    return { bar, groups: reaching.length, members: reaching.reduce((sum, size) => sum + size, 0) };
  });
}

// ------------------------------------------------------------------ one entry's result, and the CSV

/** Why a registration file could not be read, or `ok`. */
export type ReadStatus = string;

export type EntryResult = {
  agentId: string;
  externalKey: string;
  owner: string;
  uriKind: UriKind;
  locatorHost: string;
  walletRegistrations: number;
  walletListed: number;
  /** How the registration file was read: `ok`, `inline`, or the reason it was not (`fetch:timeout`, `http:404`, `body:not_json`, `not_fetched:...`). */
  read: ReadStatus;
  name: string;
  hasDescription: boolean;
  hasImage: boolean;
  typeMarker: boolean;
  backReference: boolean;
  agentEndpointCount: number;
  socialEndpointCount: number;
  otherEndpointCount: number;
  altAddressCount: number;
  a2aDeclared: boolean;
  templateKey: string;
  templateSize: number;
  /** The most listed entries that share one of this entry's agent endpoint hosts (this entry included); 0 when it has none. */
  hostGroupSize: number;
  g1: G1Kind;
  complete: boolean;
  fullyComplete: boolean;
  junk: string;
  /** `answered`, `no_answer`, `skipped`, or `not_probed:<why>`. */
  aOutcome: string;
  aStatus: number | null;
  aReason: string;
  aProbed: number;
  aAnswered: number;
  /** Whether any asked address answered with a 2xx or 3xx. */
  aSuccessClass: boolean;
  /** `valid`, `invalid:<why>`, `no_answer`, or `not_declared`. */
  cCard: string;
  g2: boolean;
  /** The first reason, in order, that kept the entry out of G2 (empty when it passed). */
  firstFailure: string;
};

export const ENTRY_COLUMNS: ReadonlyArray<keyof EntryResult> = [
  "agentId", "externalKey", "owner", "uriKind", "locatorHost", "walletRegistrations", "walletListed", "read", "name", "hasDescription", "hasImage",
  "typeMarker", "backReference", "agentEndpointCount", "socialEndpointCount", "otherEndpointCount", "altAddressCount", "a2aDeclared", "templateKey", "templateSize", "hostGroupSize", "g1",
  "complete", "fullyComplete", "junk", "aOutcome", "aStatus", "aReason", "aProbed", "aAnswered", "aSuccessClass", "cCard", "g2", "firstFailure",
];

/** A cell for a spreadsheet: quoted when it has a comma, a quote or a line break, and never starting with a formula character. */
export function csvCell(value: unknown): string {
  let cell = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

export function toCsv(rows: EntryResult[]): string {
  const lines = [ENTRY_COLUMNS.join(",")];
  for (const row of rows) lines.push(ENTRY_COLUMNS.map(column => csvCell(row[column])).join(","));
  return `${lines.join("\n")}\n`;
}

// ------------------------------------------------------------------ building an entry's result

export type ReadRecord = { status: ReadStatus; facts: RegistrationFacts | null };
export type ProbeFacts = {
  url: string;
  /** An A2A service address is an agent card and is read as one. */
  a2a: boolean;
  outcome: ProbeOutcome;
  status: number | null;
  reason: string;
  card: CardReading | null;
};

export type EntryInput = {
  row: RegistryRow;
  externalKey: string;
  walletRegistrations: number;
  walletListed: number;
  read: ReadRecord;
  g1: { kind: G1Kind; templateSize: number };
  templateKey: string | null;
  hostGroupSize: number;
  /** The addresses asked, or null when none was and `notProbedWhy` says why. */
  probes: ProbeFacts[] | null;
  notProbedWhy?: string;
};

const readOk = (status: ReadStatus) => status === "ok" || status === "inline";

const cardState = (probes: ProbeFacts[]): string => {
  const cards = probes.filter(probe => probe.a2a);
  if (cards.length === 0) return "not_declared";
  if (cards.some(probe => probe.card?.state === "valid")) return "valid";
  const read = cards.find(probe => probe.card?.state === "invalid");
  if (read && read.card?.state === "invalid") return `invalid:${read.card.reason}`;
  const answeredBadly = cards.find(probe => probe.outcome === "answered");
  if (answeredBadly) return `invalid:http_${answeredBadly.status}`;
  return cards.some(probe => probe.outcome === "no_answer") ? "no_answer" : "skipped";
};

/** How an entry's endpoint check ended, as a failure label. */
const endpointFailure = (entry: Pick<EntryResult, "aOutcome" | "aReason">): string =>
  entry.aOutcome.startsWith("not_probed") ? `endpoint: ${entry.aOutcome}` : `endpoint: ${entry.aOutcome}${entry.aReason ? ` (${entry.aReason})` : ""}`;

/** One listed entry's row: what was read, what G1 made of it, what was asked of its addresses, and whether it passes G2. */
export function buildEntryResult(input: EntryInput): EntryResult {
  const { row, read, probes } = input;
  const facts = readOk(read.status) ? read.facts : null;
  const complete = facts !== null && isComplete(facts);
  const flags = facts ? junkFlags(facts) : [];
  const asked = probes ?? [];
  const answered = asked.filter(probe => probe.outcome === "answered");
  const aOutcome =
    asked.length === 0 ? `not_probed:${input.notProbedWhy ?? "not_asked"}` : answered.length > 0 ? "answered" : asked.some(probe => probe.outcome === "no_answer") ? "no_answer" : "skipped";
  const unanswered = asked.find(probe => probe.outcome !== "answered");
  const independent = input.g1.kind === "independent";
  const result: EntryResult = {
    agentId: row.agentId,
    externalKey: input.externalKey,
    owner: row.owner,
    uriKind: row.uriKind,
    locatorHost: row.locatorHost ?? "",
    walletRegistrations: input.walletRegistrations,
    walletListed: input.walletListed,
    read: read.status,
    name: (facts?.name ?? "").slice(0, 80),
    hasDescription: facts?.description != null,
    hasImage: facts?.hasImage ?? false,
    typeMarker: facts?.typeMarker ?? false,
    backReference: facts?.backReference ?? false,
    agentEndpointCount: facts?.agentEndpoints.length ?? 0,
    socialEndpointCount: facts?.socialEndpointCount ?? 0,
    otherEndpointCount: facts?.otherEndpointCount ?? 0,
    altAddressCount: facts?.altAddressCount ?? 0,
    a2aDeclared: (facts?.a2aEndpoints.length ?? 0) > 0,
    templateKey: input.templateKey ?? "",
    templateSize: input.g1.templateSize,
    hostGroupSize: input.hostGroupSize,
    g1: input.g1.kind,
    complete,
    fullyComplete: facts !== null && isFullyComplete(facts),
    junk: flags.join("|"),
    aOutcome,
    aStatus: answered[0]?.status ?? null,
    aReason: answered.length > 0 ? "" : (unanswered?.reason ?? ""),
    aProbed: asked.length,
    aAnswered: answered.length,
    aSuccessClass: answered.some(probe => probe.status !== null && probe.status >= 200 && probe.status < 400),
    cCard: asked.length === 0 ? "not_probed" : cardState(asked),
    g2: false,
    firstFailure: "",
  };
  result.g2 = independent && complete && flags.length === 0 && answered.length > 0;
  if (independent && !result.g2) {
    if (facts === null) result.firstFailure = `registration: ${read.status}`;
    else if (!complete) result.firstFailure = result.name === "" || !result.hasDescription ? "incomplete: no name or description" : "incomplete: no agent endpoint";
    else if (flags.length > 0) result.firstFailure = `junk: ${flags[0]}`;
    else result.firstFailure = endpointFailure(result);
  }
  return result;
}

// ------------------------------------------------------------------ the counts

export type Tally = Array<{ label: string; count: number }>;
const tally = (labels: Iterable<string>): Tally => {
  const counts = new Map<string, number>();
  for (const label of Array.from(labels)) counts.set(label, (counts.get(label) ?? 0) + 1);
  return Array.from(counts, ([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : 1));
};

type Summary = {
  g0: { listed: number; byUriKind: Tally; suppressedSkipped: number; walletsBySize: Tally };
  g1: {
    walletFleetWallets: number;
    walletFleetMembers: number;
    templateGroups: number;
    templateMembers: number;
    independent: number;
    withoutContent: number;
    templateSizes: Array<{ bar: number; groups: number; members: number }>;
    largestTemplates: Array<{ members: number }>;
    sharedHosts: Array<{ bar: number; groups: number; members: number }>;
    sameTextOnly: Array<{ bar: number; groups: number; members: number }>;
  };
  read: { allListed: Tally; independents: Tally };
  g2: {
    independents: number;
    read: number;
    complete: number;
    notJunk: number;
    answered: number;
    answeredSuccessClass: number;
    nameAndDescription: number;
    /** Read, with no standard endpoint, but with an https address under a field the standard does not use. */
    noEndpointButAltAddress: number;
    passed: number;
    passedSuccessClass: number;
    fullyCompleteOfPassed: number;
    a2aDeclaredOfPassed: number;
    a2aCardValidOfPassed: number;
  };
  /** Independents that sit on an agent endpoint host shared by `bar` listed entries or more, and how many of the G2 passers do. */
  sharedHostBars: Array<{ bar: number; independents: number; passers: number; passersRemaining: number }>;
  firstFailure: Tally;
  everyFailure: Tally;
  junkFlags: Tally;
  probeStatus: Tally;
  probeReasons: Tally;
  completenessOfAllListed: { read: number; complete: number; completeAndNotJunk: number };
  cCards: Tally;
  /** The status class of the first answer of each G2 passer. */
  passerStatus: Tally;
};

const statusClass = (status: number | null): string => (status === null ? "none" : `${Math.floor(status / 100)}xx`);

/** Every count in the report, from the per-entry results and the group tables. The report prints these and computes nothing else. */
export function summarize(
  entries: EntryResult[],
  extra: { suppressedSkipped: number; walletSizes: number[]; sharedHostSizes: number[]; sameTextSizes: number[]; templateSizes: number[] }
): Summary {
  const independents = entries.filter(entry => entry.g1 === "independent");
  const wasRead = (entry: EntryResult) => readOk(entry.read);
  const walletFleetMembers = entries.filter(entry => entry.g1 === "wallet_fleet" || entry.g1 === "wallet_fleet_and_template_group");
  const templateMembers = entries.filter(entry => entry.g1 === "template_group" || entry.g1 === "wallet_fleet_and_template_group");
  const passed = independents.filter(entry => entry.g2);
  const failures: string[] = [];
  for (const entry of independents) {
    if (entry.firstFailure) failures.push(entry.firstFailure);
  }
  const every: string[] = [];
  for (const entry of independents) {
    if (!wasRead(entry)) {
      every.push(`registration: ${entry.read}`);
      continue;
    }
    if (entry.name === "") every.push("incomplete: no name");
    if (!entry.hasDescription) every.push("incomplete: no description");
    if (entry.agentEndpointCount === 0) every.push("incomplete: no agent endpoint");
    if (entry.junk) for (const flag of entry.junk.split("|")) every.push(`junk: ${flag}`);
    if (entry.aOutcome !== "answered") every.push(endpointFailure(entry));
  }
  const probed = independents.filter(entry => entry.aProbed > 0);
  const allRead = entries.filter(wasRead);
  return {
    g0: {
      listed: entries.length,
      byUriKind: tally(entries.map(entry => entry.uriKind)),
      suppressedSkipped: extra.suppressedSkipped,
      walletsBySize: tally(extra.walletSizes.map(size => (size >= 5 ? "5-9 listed" : size >= 2 ? `${size} listed` : "1 listed"))),
    },
    g1: {
      walletFleetWallets: new Set(walletFleetMembers.map(entry => entry.owner)).size,
      walletFleetMembers: walletFleetMembers.length,
      templateGroups: new Set(templateMembers.map(entry => entry.templateKey)).size,
      templateMembers: templateMembers.length,
      independent: independents.length,
      withoutContent: entries.filter(entry => !wasRead(entry)).length,
      templateSizes: sizeTable(extra.templateSizes, [2, 3, 5, 10, 50]),
      largestTemplates: extra.templateSizes
        .slice()
        .sort((a, b) => b - a)
        .slice(0, 10)
        .map(members => ({ members })),
      sharedHosts: sizeTable(extra.sharedHostSizes, [2, 3, 5, 10, 25]),
      sameTextOnly: sizeTable(extra.sameTextSizes, [2, 3, 5, 10, 50]),
    },
    read: { allListed: tally(entries.map(entry => entry.read)), independents: tally(independents.map(entry => entry.read)) },
    g2: {
      independents: independents.length,
      read: independents.filter(wasRead).length,
      complete: independents.filter(entry => wasRead(entry) && entry.complete).length,
      notJunk: independents.filter(entry => wasRead(entry) && entry.complete && entry.junk === "").length,
      answered: probed.filter(entry => entry.complete && entry.junk === "" && entry.aAnswered > 0).length,
      answeredSuccessClass: probed.filter(entry => entry.complete && entry.junk === "" && entry.aSuccessClass).length,
      nameAndDescription: independents.filter(entry => wasRead(entry) && entry.name !== "" && entry.hasDescription).length,
      noEndpointButAltAddress: independents.filter(entry => wasRead(entry) && entry.agentEndpointCount === 0 && entry.altAddressCount > 0).length,
      passed: passed.length,
      passedSuccessClass: passed.filter(entry => entry.aSuccessClass).length,
      fullyCompleteOfPassed: passed.filter(entry => entry.fullyComplete).length,
      a2aDeclaredOfPassed: passed.filter(entry => entry.a2aDeclared).length,
      a2aCardValidOfPassed: passed.filter(entry => entry.cCard === "valid").length,
    },
    sharedHostBars: [2, 5, 10, 25, 50].map(bar => ({
      bar,
      independents: independents.filter(entry => entry.hostGroupSize >= bar).length,
      passers: passed.filter(entry => entry.hostGroupSize >= bar).length,
      passersRemaining: passed.filter(entry => entry.hostGroupSize < bar).length,
    })),
    firstFailure: tally(failures),
    everyFailure: tally(every),
    junkFlags: tally(independents.filter(wasRead).flatMap(entry => (entry.junk ? entry.junk.split("|") : []))),
    probeStatus: tally(probed.map(entry => (entry.aOutcome === "answered" ? `answered ${statusClass(entry.aStatus)}` : entry.aOutcome))),
    probeReasons: tally(probed.filter(entry => entry.aOutcome !== "answered").map(entry => entry.aReason || entry.aOutcome)),
    completenessOfAllListed: {
      read: allRead.length,
      complete: allRead.filter(entry => entry.complete).length,
      completeAndNotJunk: allRead.filter(entry => entry.complete && entry.junk === "").length,
    },
    cCards: tally(passed.map(entry => entry.cCard)),
    passerStatus: tally(passed.map(entry => statusClass(entry.aStatus))),
  };
}
