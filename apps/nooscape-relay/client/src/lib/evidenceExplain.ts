import { registryChainName } from "./directoryProtocols";

// Plain-sentence explanations for every trust label Nooscape renders. The
// field-wide weakness these answer: scores and tiers shown with no
// explanation. Every surface that shows a tier, publisher state, or
// acknowledgement must also show the matching sentence from here.

export const tierExplanations: Record<string, { label: string; sentence: string }> = {
  tier_2: {
    label: "Tier 2 · Approved-source metadata",
    sentence:
      "An approved source observed this agent and Nooscape retained the raw evidence. Nothing about who runs the agent has been verified, so treat every self-description as a claim.",
  },
  tier_3: {
    label: "Tier 3 · Domain-control verified",
    sentence:
      "The operator proved control of the agent's own domain through a time-boxed HTTPS challenge. The domain is real and current; the publisher's identity is still unverified.",
  },
  tier_4: {
    label: "Tier 4 · Publisher-verified",
    sentence:
      "The operator consented and was allowlisted with a publisher key, so signed claims can be attributed to them. This is the strongest tier Nooscape projects.",
  },
};

export const publisherStateExplanations: Record<string, string> = {
  unverified: "No publisher identity verified. Everything shown comes from retained observations, apart from a name Nooscape read from a registration link, which the agent's page marks.",
  allowlisted: "The publisher holds an active allowlisted key, so signed claims are attributed to them.",
  expired: "The publisher's allowlisted key expired; verified claims fall back to Tier 2 until rechecked.",
  revoked: "The publisher's key was revoked; verified claims fall back to Tier 2.",
};

export const acknowledgedExplanation =
  "Acknowledged, not reviewed. A source saw this agent and Nooscape kept only locator-class facts: no claims and no tiers. It never appears on the home map as a reviewed record. Acknowledgement is never endorsement.";

export const registrantExplanation =
  "The wallet that registered this identity on-chain, decoded from the registration event itself. It is an event-anchored chain fact, not a verified operator, which is how Nooscape can group clone registrations without claiming who runs them.";

/** Plain-words narration for a registering wallet: what its fold count means. */
export function registrantNarration(sameWallet: number) {
  return sameWallet <= 0
    ? "This wallet has registered only this identity in the directory so far."
    : `This wallet has also registered ${sameWallet.toLocaleString()} other ${sameWallet === 1 ? "identity" : "identities"} in the directory.`;
}

/**
 * What the wallet stored against a directory row actually is depends on the
 * protocol, and the ERC-8004 sentence above is only true for ERC-8004:
 * - registrant: the wallet that paid the registration, decoded from the
 *   registration event itself (ERC-8004);
 * - owner: the asset's current owner read from the registry account at the
 *   last pass (Metaplex and 8004 Solana), which changes hands and is not
 *   necessarily the wallet that registered the identity;
 * - authority: the controller recorded in the SAID program account, which the
 *   registering owner can hand to another wallet (transfer_authority).
 */
export type WalletKind = "registrant" | "owner" | "authority";

export function walletKind(protocol: string): WalletKind {
  if (protocol === "solana_said") return "authority";
  if (protocol === "solana_registry" || protocol === "solana_8004") return "owner";
  return "registrant";
}

export const ownerWalletExplanation =
  "The wallet recorded as this asset's current owner in the on-chain registry account at the last pass. Ownership can change hands, so this is not necessarily the wallet that registered the identity. It is a chain fact, not a verified operator.";

export const saidAuthorityExplanation =
  "The wallet currently recorded as this identity's authority in the SAID program account, read from the account itself. SAID lets the registering owner hand authority to another wallet, so this can differ from the wallet the identity was registered under. It is a chain fact, not a verified operator.";

/** The label above the wallet, matched to what the wallet is. */
export function registrantLabel(protocol: string) {
  const kind = walletKind(protocol);
  return kind === "authority" ? "Controlling wallet" : kind === "owner" ? "Current owner wallet" : "Registering wallet";
}

export function registrantExplanationFor(protocol: string) {
  const kind = walletKind(protocol);
  return kind === "authority" ? saidAuthorityExplanation : kind === "owner" ? ownerWalletExplanation : registrantExplanation;
}

/**
 * A chain-pass registry (BNB Chain, Ethereum, Base, Arc) counts the other
 * registrations of a wallet over the whole registry, listed or not, so its
 * narration says that instead of claiming they are all in the directory.
 */
export function registryWalletNarration(chain: string, sameWallet: number) {
  return sameWallet <= 0
    ? `This wallet has registered only this identity on ${chain}.`
    : `This wallet has also registered ${sameWallet.toLocaleString()} other ${sameWallet === 1 ? "identity" : "identities"} on ${chain}, counted over the whole registry (some may not be listed here).`;
}

export function bnbWalletNarration(sameWallet: number) {
  return registryWalletNarration("BNB Chain", sameWallet);
}

/** Fold-count narration worded to match {@link registrantLabel}. */
export function registrantNarrationFor(protocol: string, sameWallet: number) {
  const registryChain = registryChainName(protocol);
  if (registryChain) return registryWalletNarration(registryChain, sameWallet);
  if (walletKind(protocol) === "registrant") return registrantNarration(sameWallet);
  return sameWallet <= 0
    ? "This wallet is recorded against only this identity in the directory so far."
    : `This wallet is also recorded against ${sameWallet.toLocaleString()} other ${sameWallet === 1 ? "identity" : "identities"} in the directory.`;
}

/** The noun the look-alike sentences use for a shared wallet. */
export function sharedWalletNoun(protocol: string) {
  return walletKind(protocol) === "registrant" ? "registering wallet" : "recorded wallet";
}

/** The registries behind the Solana activity ledger, in the order the page shows them. */
export const solanaRegistries = [
  { protocol: "solana_said", label: "SAID" },
  { protocol: "solana_8004", label: "8004" },
  { protocol: "solana_registry", label: "Metaplex" },
] as const;

export function solanaRegistryLabel(protocol: string) {
  return solanaRegistries.find(registry => registry.protocol === protocol)?.label ?? "Solana registry";
}

/**
 * What a ledger event says happened, in plain words. The wording states what
 * the chain recorded and nothing more: a transfer is an owner or authority
 * change, never a sale, and an edit is a change to where the identity says its
 * profile lives, never a judgement of the agent.
 */
export function solanaActivityEventLabel(kind: string, protocol: string) {
  switch (kind) {
    case "register":
      return "Registered";
    case "transfer":
      return protocol === "solana_said" ? "Authority handed to another wallet" : "Changed owner";
    case "profile_update":
      return "Profile edited";
    default:
      return "Registry event";
  }
}

/** The pass-recorded time, in UTC so it reads the same everywhere. It bounds when an event happened; it is not the chain's own timestamp. */
export function formatRecordedAt(value: string | Date) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "time unavailable";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export const solanaActivityExplanation =
  "Each event is a registration, an owner or authority change, or a profile edit that Nooscape's on-chain pass detected and anchored to the transaction that made it. The time shown is when the pass recorded it, which bounds when it happened but is not the chain's own timestamp, and the slot is the one the pass observed, not the transaction's own. A change the pass could not anchor to a transaction is not listed. Owner changes are never read as sales, and nothing here says whether an agent works.";

export const lookalikeExplanation =
  "Look-alike counts group entries that share a locator-class fact. They show where registrations cluster. They never say who runs the agents, that a group is one operator, or that anything is wrong.";

export const chainActivityExplanation =
  "Chain activity counts this identity's ownership events decoded straight from the registry: the mint that created it, later changes of hands, and profile-link edits. Timing is a chain fact about when the identity moved between wallets. It never says who operates the agent or whether it works.";

export const handoutExplanation =
  "A hand-out is a change of hands within about an hour of minting (the block-proxied hour on this chain) from the wallet that minted the identity. That cadence matches a platform distributing identities to wallets, not a sale.";

export const registryRatingsExplanation =
  "Ratings are submitted on-chain by external wallets to the ERC-8004 Reputation Registry and shown exactly as recorded. Nooscape does not score, weight, or endorse them. A revoked rating stays visible and marked, because hiding it would misstate the ledger.";

// Chain-activity event kinds, in plain words. Counted facts decoded from the
// identity registry's Transfer and URIUpdated events — never self-descriptions.
export const chainActivityEventLabels: Record<string, string> = {
  mint: "Minted to its first wallet",
  secondary: "Changed hands",
  uri_update: "Profile link edited",
};

// Hand-outs are secondary Transfers from the minting wallet inside the
// mint-hour window — labelled distinctly from later changes of hands.
export const handoutEventLabel = "Handed out to a wallet";

export function chainActivityEventLabel(kind: string, isHandout?: boolean) {
  if (kind === "secondary" && isHandout) return handoutEventLabel;
  return chainActivityEventLabels[kind] ?? "Chain activity event";
}

// Reputation-ledger event kinds, in plain words. Records decoded from the
// ERC-8004 Reputation Registry's feedback events — shown as submitted,
// never a Nooscape rating.
export const registryRatingsEventLabels: Record<string, string> = {
  new_feedback: "Rating submitted",
  feedback_revoked: "Rating revoked",
  response_appended: "Response appended",
};

export function registryRatingsEventLabel(kind: string) {
  return registryRatingsEventLabels[kind] ?? "Registry event";
}

// Governance-authored evidence events, in plain words. The description that
// accompanies each event is written by Nooscape's own ingestion and
// governance code, never by the agent.
export const timelineEventLabels: Record<string, string> = {
  A2A_AGENT_CARD_OBSERVED: "Agent Card observed",
  CATALOG_AGENT_METADATA_OBSERVED: "Catalog metadata observed",
  SOLANA_REGISTRY_AGENT_METADATA_OBSERVED: "Solana registry metadata observed",
  ERC8004_AGENT_REGISTERED: "Chain identity registered",
  DOMAIN_CONTROL_VERIFIED: "Domain control verified",
  DOMAIN_CONTROL_REVOKED: "Domain control revoked",
  DOMAIN_CONTROL_RECHECKED: "Domain control rechecked",
  PUBLISHER_KEY_ALLOWLISTED: "Publisher key allowlisted",
  PUBLISHER_KEY_REVOKED: "Publisher key revoked",
  PUBLISHER_KEY_EXPIRED: "Publisher key expired",
};

export function timelineEventLabel(eventType: string) {
  return timelineEventLabels[eventType] ?? "Evidence event";
}

/** Extracts the tier key from a proof string like "TIER_2 · 1 source". */
export function tierFromProof(proof: string) {
  const match = /TIER_(\d)/i.exec(proof);
  return match ? `tier_${match[1]}` : null;
}
