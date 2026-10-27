/**
 * The types and plain helpers of the home page's field of agents, shared by Home and by the two parts of it that load on demand
 * (Deep Space and the full field). No JSX and no hooks: a page test can import it without a browser.
 */
import { type EvidenceGroup, PUBLISHER_STATES, type PublisherState, toPublisherState } from "@/lib/evidenceReadout";
import { cn } from "@/lib/utils";

export type Lens = "field" | "protocol" | "trust";

export type TrustFilter = "all" | EvidenceGroup;

export type PublisherValidation = {
  status: PublisherState;
  publisherName: string | null;
  publicKeyFingerprint: string | null;
  verifiedAt: string | null;
  statusChangedAt: string | null;
};

export const publisherStateMeta: Record<PublisherState, { label: string; detail: string }> = {
  allowlisted: { label: "Allowlisted", detail: "Active publisher key" },
  expired: { label: "Expired", detail: "Key needs renewal" },
  revoked: { label: "Revoked", detail: "Key no longer trusted" },
  unverified: { label: "Unverified", detail: "No known publisher key" },
};

export const publisherStates = PUBLISHER_STATES;

export type AtlasAgent = {
  id: string;
  name: string;
  handle: string;
  capability: string;
  chain: string;
  framework: string;
  status: string;
  summary: string;
  specialties: readonly string[];
  proof: string;
  position: { x: number; y: number };
  publisherValidation: PublisherValidation;
};

export type LiveAtlasRecord = {
  agentId: string;
  displayName: string;
  handle: string;
  primaryCapability: string | null;
  untrustedSummary: string | null;
  protocols: string;
  publisherState: string;
  evidenceTier: string;
  sourceCount: number;
  lastObservedAt: string;
};

export type LiveAtlasCoverage = {
  publicRecordCount: number;
  provenanceReadyCount: number;
  coveragePercent: number;
};

// Acknowledgement ledger aggregate: every agent seen across all sources, split
// by protocol. Locator facts only — distinct from the reviewed record set.
// What fills the BNB Chain ERC-8004 registry, as recorded facts (null until the source is approved).
export type BnbRegistryProfile = {
  recorded: number;
  listed: number;
  published: number;
  grouped: number;
  withoutProfileLink: number;
  numericName: number;
  pending: number;
  sharedProfileGroups: Array<{ label: string; registrations: number }>;
  topHosts: Array<{ host: string; registrations: number }>;
  rules: { sharedProfileLinkFrom: number; sharedHostFrom: number; sharedWalletFrom: number };
};

export type DirectoryBreakdown = {
  total: number;
  byProtocol: readonly { protocol: string; count: number }[];
};

// Locator-class facts only. Directory acknowledgements are unreviewed census
// presence: they never carry summaries, trust or tiers. They do not reach the home map: BNB Chain is drawn there only as groups of registrations (`liveData.mapFleets`), never one registration at a time.
type DirectoryAckEntry = {
  id: string;
  displayName: string;
  locatorHost: string | null;
  protocol: string;
  sourceSignalNote: string | null;
  // Fold hints: other directory entries sharing this one's recorded wallet,
  // exact name, or locator host. Grouping facts, never identity or quality.
  related?: { sameWallet: number; sameName: number; sameHost: number };
};

export type DirectoryAckHits = {
  entries: DirectoryAckEntry[];
  matchedTotal: number;
  // Set when the server declined the search because its search capacity was full.
  busy?: boolean;
};

// Wallet concentration over the acknowledgements that record a wallet (the
// ERC-8004 registrant, or the Solana registries' current owner or authority):
// the wallets recorded against the most identities, largest count first. The
// dominant host is a narration hint — locator-class chain facts, never a
// verified operator, never a rating.
export type DirectoryWalletCensus = {
  wallets: readonly { registrant: string; agentCount: number; dominantHost: string | null }[];
};

// The honesty funnel: how far from merely acknowledged to independently
// proven. A null value is an honest "not measured yet", never a false zero.
export type DirectoryFunnel = {
  steps: readonly { key: string; value: number | null }[];
  // Ledger-wide chain-activity totals over the measured entries; null while
  // the activity migration is pending, so the copy stays absent rather than
  // showing false zeros. measuredThroughBlock is the ledger's high-water
  // block — the walk measures up to that block, so counts are honest only
  // "as of" it.
  activityTotals: {
    mintedEntries: number;
    secondaryTransfers: number;
    handoutTransfers: number;
    uriUpdates: number;
    measuredThroughBlock: number | null;
  } | null;
};

// Rail-level USDG settlement totals over the measured windows of the one
// settlement ledger: counts, the median raw value, the micropayment share,
// and block coverage. Null while the source is unmeasured or the migration
// is pending — the money panel stays absent rather than showing false zeros.
export type DirectoryUsdgSettlements = {
  settlementCount: number;
  payerCount: number;
  payeeCount: number;
  relayerCount: number;
  microPaymentCount: number;
  medianValueRaw: string | null;
  firstBlock: number;
  lastBlock: number;
};

// The relay envelope is read when it opens and then once a minute (it was every 8 seconds). A read that fails leaves the last envelope on the page with a note that says when it was read.
export const EVIDENCE_POLL = { refetchInterval: 60_000, refetchOnWindowFocus: true } as const;

export type IngestionEvent = {
  id: string;
  agent: string;
  capability: string;
  protocol: string;
  tone: string;
  position: { x: number; y: number };
};

export type EvidenceEntry = {
  id: string;
  observedAt: string;
  event: string;
  detail: string;
  source: string;
  proofReference: string;
};

export type EvidenceEnvelope = {
  agentId: string;
  observedAt: string;
  sequence: number;
  algorithm: string;
  integrityHash: string;
  signatureAlgorithm: string;
  signature: string;
  relayPublicKeyPem: string;
  relayKeyId?: string;
  canonicalPayload: string;
  relayMode: string;
  publisherValidation?: PublisherValidation;
  provenance?: {
    evidenceClass: "persisted-observation";
    sourceLabel: string;
    sourceRoot: string;
    canonicalLocator: string;
    contentHash: string;
    rawPayloadAccess: "private-object-store";
    retentionPolicy: string;
    validationStatus: "valid" | "invalid" | "partial";
  };
  entries: EvidenceEntry[];
};

export const tones: Record<string, string> = {
  Research: "#C3A6FF",
  Security: "#BFFF76",
  Build: "#FFB86A",
  Commerce: "#66E8FF",
  Data: "#FF9FE7",
};

export function positionForLiveAgent(agentId: string) {
  const value = Array.from(agentId).reduce((total, character) => (total * 31 + character.charCodeAt(0)) >>> 0, 17);
  return { x: 16 + (value % 68), y: 18 + (Math.floor(value / 71) % 62) };
}

export function protocolsForLiveAgent(protocols: string) {
  try {
    const parsed = JSON.parse(protocols);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function mapLiveRecord(record: LiveAtlasRecord): AtlasAgent {
  const protocols = protocolsForLiveAgent(record.protocols);
  const solanaRegistered = protocols.includes("solana_registry") || protocols.includes("solana_8004");
  const protocol = solanaRegistered ? "SOLANA REGISTRY" : protocols[0]?.toUpperCase() ?? "A2A";
  return {
    id: record.agentId,
    name: record.displayName,
    handle: record.handle,
    capability: record.primaryCapability ?? (solanaRegistered ? "Solana registry metadata" : "Agent discovery metadata"),
    chain: solanaRegistered ? "Solana" : "Public web",
    framework: protocol,
    status: "OBSERVED",
    summary: record.untrustedSummary ?? "No public description was retained for this record.",
    specialties: [record.primaryCapability ?? "Discovery", ...protocols].slice(0, 4),
    proof: `${record.evidenceTier.toUpperCase()} · ${record.sourceCount} source`,
    position: positionForLiveAgent(record.agentId),
    publisherValidation: {
      status: toPublisherState(record.publisherState),
      publisherName: null,
      publicKeyFingerprint: null,
      verifiedAt: null,
      statusChangedAt: null,
    },
  };
}

export function isDomainVerifiedAgent(agent: AtlasAgent) {
  return agent.status === "OBSERVED" && agent.publisherValidation.status === "unverified" && agent.proof.toUpperCase().startsWith("TIER_3");
}

export function formatObservedTime(timestamp: string) {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1_000));
  return elapsedSeconds < 60 ? `T-${elapsedSeconds}S` : `T-${Math.floor(elapsedSeconds / 60)}M`;
}

export type ClusterMarker = { id: string; position: { x: number; y: number }; count: number; capability: string };

export function ingressMatchesFramework(framework: string, protocol: string) {
  if (framework === "All protocols") return true;
  if (framework === "A2A Agent Card") return protocol.includes("A2A");
  if (framework === "ERC-8004 Identity") return protocol.includes("ERC-8004");
  if (framework === "AGNTCY Directory") return protocol.includes("AGNTCY");
  if (framework === "ANP JSON-LD") return protocol.includes("ANP");
  return false;
}

// Flow animation is the costliest paint on the field, so only a bounded sample of
// connection lines animates; the rest render as static strands.
export const SIGNAL_ANIMATED_LINES = 14;

export function signalLineTone(base: string, index: number, total: number) {
  const stride = Math.max(1, Math.ceil(total / SIGNAL_ANIMATED_LINES));
  if (index % stride !== 0) return `${base}-static`;
  return cn(base, index % 2 === 0 && `${base}-bright`);
}
