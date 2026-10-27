import { FLEET_MIN } from "@shared/noosphere";
import { assignG1, endpointHostOf, inlineJsonText, parseRegistrationText, templateKeyOf, type FleetGroup } from "./bscB1";
import { BSC_IDENTITY_REGISTRY, bscUriFacts } from "./ingestion/bscChain";

/**
 * The pure rules of the BNB fleet and template clustering (docs/bsc-clusters-2026-10-16.md). It reuses the grouping and the
 * template key that PR-B1 measured with (server/bscB1.ts), so the stored counts and the measured ones come from the same
 * code. Nothing here touches the network or the database.
 */

/** The groups stored: a wallet, a link or a host with this many registrations or more is a fleet. */
export const CLUSTER_MIN = FLEET_MIN;
/** Two or more listed entries with the same template key are a template group. */
export const TEMPLATE_MIN = 2;

/**
 * The endpoint-host rule, adopted by the operator on 2026-10-17 (docs/approvals/2026-10-17-bnb-census-report-and-b5-closed.md):
 * a host that `min` or more listed entries declare as the host of their first agent address is a group. It governs passes
 * made after that day. The 2026-10-16 measurement and the report built on it were made without it and keep their numbers.
 * Change the rule and `version` changes with it, with a new `date`, so a stored group says which rule found it.
 */
export const ENDPOINT_HOST_RULE = { version: "endpoint-host/1", date: "2026-10-17", min: CLUSTER_MIN } as const;

/** "registry" is the one summary row: how many registrations there were when the fleets were last recomputed, and when. */
export type ClusterKind = "wallet" | "shared_link" | "platform_host" | "template" | "registry";

/**
 * What a link read from the chain gives the evidence of a listed entry. The registration file behind a web or ipfs link is read
 * later by its own step (bscRegistrationFiles.ts), which sets "fetched", or one of the statuses of a link that could not be read.
 */
type EvidenceFacts = {
  /** "inline": decoded from the link itself. "link_not_read": a web or ipfs link, not read yet. "unreadable": inline JSON that does not parse. */
  readStatus: "inline" | "link_not_read" | "unreadable";
  templateKey: string | null;
  endpointHost: string | null;
  /** SHA-256 of the URI, to hold against the one the registry row recorded. */
  profileUriHash: string;
};

/** The evidence a URI gives. Only inline JSON is read; a web or ipfs link is not fetched here. */
export function evidenceFromUri(uri: string, agentId: string): EvidenceFacts {
  const facts = bscUriFacts(uri);
  const base = { profileUriHash: facts.profileUriHash, templateKey: null, endpointHost: null };
  if (facts.uriKind !== "inline-json") return { ...base, readStatus: "link_not_read" };
  const text = inlineJsonText(uri);
  const parsed = text === null ? null : parseRegistrationText(text, agentId, BSC_IDENTITY_REGISTRY);
  if (!parsed || !parsed.ok) return { ...base, readStatus: "unreadable" };
  return { ...base, readStatus: "inline", templateKey: templateKeyOf(parsed.facts), endpointHost: endpointHostOf(parsed.facts) };
}

/** The registration of an entry was read, from the link itself ("inline") or from the file its link names ("fetched"). */
export const isReadStatus = (status: string) => status === "inline" || status === "fetched";

/** What the registration file behind a web or ipfs link gives the evidence of a listed entry. */
export function evidenceFromFile(text: string, agentId: string, profileUriHash: string): { readStatus: "fetched" | "link_unparsed"; templateKey: string | null; endpointHost: string | null; profileUriHash: string } {
  const parsed = parseRegistrationText(text, agentId, BSC_IDENTITY_REGISTRY);
  if (!parsed.ok) return { readStatus: "link_unparsed", templateKey: null, endpointHost: null, profileUriHash };
  return { readStatus: "fetched", templateKey: templateKeyOf(parsed.facts), endpointHost: endpointHostOf(parsed.facts), profileUriHash };
}

export type EvidenceRow = { externalKey: string; registrant: string; readStatus: string; templateKey: string | null };

type EntryG1 = {
  g1: "independent" | "template_group" | "wallet_fleet" | "wallet_fleet_and_template_group" | "unread";
  templateSize: number;
  walletRegistrations: number;
};

/**
 * Gate G1 for the listed entries that have evidence, from B1's grouping. A wallet is a fleet at `FLEET_MIN` registrations
 * (over the whole registry: `walletSize`) and a template is `TEMPLATE_MIN` listed entries with one key. An entry whose
 * registration was not read has no template to compare, and is "unread" and not "independent", unless its wallet is a fleet.
 */
export function groupEvidence(rows: EvidenceRow[], walletSize: Map<string, number>): { byKey: Map<string, EntryG1>; templates: FleetGroup[]; walletFleets: FleetGroup[] } {
  const result = assignG1(
    rows.map(row => ({ agentId: row.externalKey, owner: row.registrant, templateKey: isReadStatus(row.readStatus) ? row.templateKey : null })),
    walletSize,
    { fleetMin: CLUSTER_MIN, templateMin: TEMPLATE_MIN }
  );
  const read = new Map(rows.map(row => [row.externalKey, isReadStatus(row.readStatus)]));
  const byKey = new Map<string, EntryG1>();
  result.byAgent.forEach((value, key) => {
    byKey.set(key, {
      g1: value.kind === "independent" && !read.get(key) ? "unread" : value.kind,
      templateSize: value.templateSize,
      walletRegistrations: value.walletRegistrations,
    });
  });
  return { byKey, templates: result.templates, walletFleets: result.walletFleets };
}

export type EndpointHostRow = { registrant: string; readStatus: string; endpointHost: string | null };
export type EndpointHostGroup = { host: string; listedCount: number; walletCount: number };

/**
 * The endpoint-host groups of the listed entries that have evidence: each host declared by `ENDPOINT_HOST_RULE.min` entries
 * or more, in host order. Only an entry whose registration was read has a host to count. The rule
 * stores the groups and nothing else: it changes no entry's G1 result, draws no light and moves no count the public reads.
 * Both kinds of read count: a registration decoded from its own link, and one read from the file its link names.
 */
export function endpointHostGroups(rows: readonly EndpointHostRow[], min: number = ENDPOINT_HOST_RULE.min): EndpointHostGroup[] {
  const hosts = new Map<string, { entries: number; wallets: Set<string> }>();
  for (const row of rows) {
    if (!isReadStatus(row.readStatus) || !row.endpointHost) continue;
    const group = hosts.get(row.endpointHost) ?? { entries: 0, wallets: new Set<string>() };
    group.entries += 1;
    group.wallets.add(row.registrant);
    hosts.set(row.endpointHost, group);
  }
  return Array.from(hosts, ([host, group]) => ({ host, listedCount: group.entries, walletCount: group.wallets.size }))
    .filter(group => group.listedCount >= min)
    .sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
}

/** The agent id inside `eip155:56:<registry>:<id>`, or null when the key is not one. */
export function agentIdOfKey(externalKey: string): string | null {
  const match = /^eip155:56:0x[0-9a-fA-F]{40}:([0-9]{1,78})$/.exec(externalKey);
  return match ? match[1]! : null;
}

/**
 * The member a template group takes its label from: the one with the lowest agent id among those that carry a name of their
 * own (not the "Agent #n" placeholder), whatever order the members come in. The database returns them in no promised order,
 * and a label that changed with it would change on the page between two refreshes.
 */
export function templateLabelMember<T extends { externalKey: string; displayName: string }>(members: readonly T[]): T | undefined {
  const order = (a: string, b: string) => {
    const x = agentIdOfKey(a) ?? "";
    const y = agentIdOfKey(b) ?? "";
    return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
  };
  return members
    .filter(member => !/^Agent #\d+$/.test(member.displayName))
    .sort((a, b) => order(a.externalKey, b.externalKey))[0];
}
