export const INGESTION_PROTOCOLS = ["a2a", "anp", "agntcy", "erc8004", "erc8004_reputation", "catalog", "census", "solana_registry", "solana_8004", "usdg_settlement", "solana_said", "erc8004_bsc", "erc8004_base", "erc8004_eth", "erc8004_arc", "solana_agenc"] as const;
export type IngestionProtocol = (typeof INGESTION_PROTOCOLS)[number];

export type A2aNormalizedCandidate = {
  displayName: string;
  handle: string;
  summary: string | null;
  primaryCapability: string | null;
  specialties: string[];
  agentCardUrl: string;
  endpointUrl: string | null;
  authentication: string | null;
};

/**
 * A catalog record remains asserted discovery metadata. Source-reported signals
 * are retained as findings but never independently upgrade identity verification.
 */
export type CatalogNormalizedCandidate = A2aNormalizedCandidate & {
  externalRecordId: string;
  catalogSignals: string[];
};

/**
 * Public registry metadata derived from a Solana-backed Metaplex listing. The
 * mint and authority are retained as assertions; this adapter does not invoke
 * an advertised A2A endpoint, sign a transaction, or verify chain state.
 */
export type SolanaRegistryCandidate = {
  displayName: string;
  handle: string;
  summary: string | null;
  primaryCapability: string | null;
  specialties: string[];
  mintAddress: string;
  authority: string | null;
  walletAddress: string | null;
  agentMetadataUrl: string;
  agentCardUrl: string | null;
  network: "solana-mainnet";
  sourceSignals: string[];
};

/**
 * An ERC-8004 identity registration observed on-chain. The owner and URI are
 * registry-recorded assertions at registration time; this adapter never
 * dereferences the URI or queries current token state.
 */
export type Erc8004RegistryCandidate = {
  displayName: string;
  handle: string;
  summary: string | null;
  primaryCapability: string | null;
  specialties: string[];
  externalId: string;
  owner: string;
  agentUri: string | null;
  uriKind: "web" | "ipfs" | "inline-json" | "empty" | "other";
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
  sourceSignals: string[];
};

export type RawObservationInput = {
  canonicalLocator: string;
  contentHash: string;
  rawObjectKey: string;
  contentType: string;
  httpStatus: number;
  validationStatus: "valid" | "invalid" | "partial";
  validationFindings: string[];
  observedAt: Date;
};

/**
 * A master-directory acknowledgement for an agent a source observed without the
 * record meeting the evidence bar for a reviewed public record. Acknowledgement
 * is not endorsement: entries carry only locator-class facts (name, host,
 * registering wallet, source, seen dates), never self-descriptions, tiers, or
 * map placement.
 */
export type DirectoryEntryDraft = {
  externalKey: string;
  displayName: string;
  locatorHost: string | null;
  /** Registering wallet for ERC-8004 registrations; null for every other protocol. */
  registrant?: string | null;
  /**
   * The 8004 AgentAccount PDA as last enumerated live — the chain-facts
   * address a later pass confirms closures against. Undefined for every
   * other protocol.
   */
  accountPubkey?: string | null;
  /**
   * SHA-256 hex of the full 8004 registration URI — the profile-link
   * fingerprint. Undefined for every other protocol.
   */
  profileUriHash?: string | null;
  /**
   * The live on-chain feedback counter decoded from the 8004 AgentAccount's
   * first reputation window (step 3). Undefined for every other protocol; a
   * count change deliberately fires no ledger event — the row simply
   * refreshes each pass.
   */
  feedbackCount?: number | null;
  /**
   * Registry-row passes only (the BNB Chain registry): the starting listing
   * state. 0 marks a registration with no usable profile link, which is born
   * excluded; everything else is born pending (the default) and is classified
   * after the walk. Ignored by every directory-entry writer.
   */
  listing?: 0 | 3;
  sourceSignalNote: string | null;
};

/**
 * A chain-activity event acknowledged into the ledger: one mint or secondary
 * ERC-721 Transfer, or one URIUpdated, decoded from the identity registry.
 * Event-anchored locator facts only — ownership timing says an agent moved
 * between wallets, never who operates it or whether it works.
 */
export type DirectoryChainActivityEvent = {
  kind: "mint" | "secondary" | "uri_update";
  /** The directory entry the event belongs to (ERC-8004 composite id). */
  externalKey: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
  /** Transfer `from` (zero address for mints); null for URIUpdated. */
  fromAddress: string | null;
  /** Transfer `to`; null for URIUpdated. */
  toAddress: string | null;
};

/**
 * A USDG settlement acknowledged into the ledger: one EIP-3009 pre-authorized
 * transfer on the canonical Robinhood Chain Global Dollar contract, keyed by
 * its AuthorizationUsed log and decoded from the same receipt. Rail facts
 * only — value moved between two wallets on-chain, never which registered
 * agent (if any) either wallet operates.
 */
export type UsdgSettlementEvent = {
  transactionHash: string;
  /** Log index of the AuthorizationUsed event that keyed the settlement. */
  logIndex: number;
  blockNumber: number;
  payerAddress: string;
  payeeAddress: string;
  relayerAddress: string;
  /** Raw 6-decimal USDG amount as an exact decimal string; never a float. */
  valueRaw: string;
};

/**
 * A Metaplex Solana registry chain fact acknowledged into the Solana activity
 * ledger. Produced by a state diff between two paced on-chain passes (the
 * Core program carries profile edits, so re-read-and-diff is the verified
 * catch — SOLANA_INGEST_SPEC.md §1), with the asset's newest successful
 * transaction signature as the evidence anchor. Facts only: the owner field
 * moved (or the name changed, or the asset vanished) — never who operates
 * the agent or whether it works.
 */
export type SolanaChainActivityEvent = {
  kind: "register" | "transfer" | "profile_update" | "asset_closed";
  /** The MPL Core asset pubkey — the same key space as the directory externalKey. */
  externalKey: string;
  /** The asset's newest successful transaction, fetched per changed asset. */
  transactionSignature: string;
  /** The slot of the pass that observed the diff (not the attribution tx's slot). */
  slot: number;
  /** Prior owner per the directory; null for register and profile_update. */
  fromOwner: string | null;
  /** Current owner per the chain; null only for asset_closed. */
  toOwner: string | null;
};

export type A2aIngestionResult = {
  requestCount: number;
  discoveredCount: number;
  acceptedCount: number;
  rejectedCount: number;
  nextCursor: string | null;
};

export type CatalogIngestionResult = A2aIngestionResult;
export type CensusIngestionResult = A2aIngestionResult;
export type SolanaRegistryIngestionResult = A2aIngestionResult;
export type Solana8004IngestionResult = A2aIngestionResult;
export type SaidIngestionResult = A2aIngestionResult;
export type AgencIngestionResult = A2aIngestionResult;
export type Erc8004IngestionResult = A2aIngestionResult;
export type UsdgSettlementIngestionResult = A2aIngestionResult;

/**
 * One Reputation Registry event acknowledged into the ratings ledger: a third
 * party's NewFeedback against an ERC-8004 agent, its later FeedbackRevoked, or
 * a ResponseAppended reply. Chain-anchored opinion facts only — the ledger
 * records who rated, when, and with what raw score; it never judges whether
 * the opinion is fair and never blends scores across raters (the contract's
 * own getSummary documents the Sybil risk of unfiltered aggregation).
 */
export type Erc8004ReputationEvent = {
  kind: "new_feedback" | "feedback_revoked" | "response_appended";
  /** The rated agent's uint256 token id in the identity registry, as a decimal string. */
  agentId: string;
  /** The rating client (the rater's wallet) — the "who" the display leads with. */
  clientAddress: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
  /**
   * The contract's per-(agentId, clientAddress) 1-indexed feedback counter,
   * emitted by every kind (NewFeedback data head, FeedbackRevoked and
   * ResponseAppended topics) — the exact join key that lets a revocation
   * remove precisely the rating it names. Null only when the event's shape
   * cannot carry one.
   */
  feedbackIndex: number | null;
  /** NewFeedback: raw int128 score as an exact decimal string; null for other kinds. */
  valueRaw: string | null;
  /** NewFeedback: the rater's own decimal placement; null for other kinds. */
  valueDecimals: number | null;
  /** NewFeedback dynamic strings per the EIP-8004 layout, wire-verified 2026-10-11; untrusted text. */
  tag1: string | null;
  tag2: string | null;
  /** Third NewFeedback string (EIP: `endpoint`); observed empty on live events. */
  endpoint: string | null;
  /** Fourth NewFeedback string (EIP: `feedbackURI`) — never dereferenced, never fetched. */
  feedbackUri: string | null;
  /** NewFeedback bytes32 feedbackHash; null for other kinds. */
  feedbackHash: string | null;
  /** ResponseAppended only: who appended the response. */
  responderAddress: string | null;
};

export type Erc8004ReputationIngestionResult = A2aIngestionResult;
