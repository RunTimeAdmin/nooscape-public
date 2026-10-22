// Plain-words glossary for every trust term Nooscape surfaces, plus the copy
// for the honesty funnel and the known-unknowns panel. The field-wide weakness
// this answers: labels and counts shown with no explanation. Any surface that
// shows one of these terms should wrap it in <Term> so the definition is one
// hover away.

import { EXTRA_CHAIN_LABEL, extraChainsOn } from "@shared/chains";

/**
 * The regions the Home tabs show (components/home/chainTabsModel.ts), named in a sentence: the three Nooscape has always read, then
 * each extra chain whose switch is on in this build. With none on it is the sentence the glossary has always had.
 */
const REGION_NAMES = ["Robinhood Chain", "BNB Chain", "Solana", ...extraChainsOn(import.meta.env.VITE_FEATURES).map(chain => EXTRA_CHAIN_LABEL[chain])];
const COUNT_WORD = ["no", "one", "two", "three", "four", "five", "six"];
const REGIONS_SENTENCE = `${REGION_NAMES.slice(0, -1).join(", ")} and ${REGION_NAMES[REGION_NAMES.length - 1]}: the ${COUNT_WORD[REGION_NAMES.length] ?? REGION_NAMES.length} places Nooscape reads agent registries. Pick one to see only its counts.`;

export type GlossaryKey =
  | "acknowledgement"
  | "erc8004"
  | "agentCard"
  | "tier"
  | "registrant"
  | "lookalike"
  | "fleet"
  | "chainActivity"
  | "handout"
  | "x402"
  | "preauth"
  | "noosphere"
  | "steadyLight"
  | "dimCluster"
  | "regions"
  | "askTheOwl"
  | "dossier"
  | "clearTheFog"
  | "fleetSightings"
  | "fieldReports"
  | "owlsCatch"
  | "yourWatch"
  | "patrols"
  | "howTheOwlSees"
  | "owlsLastSweep";

export const glossary: Record<GlossaryKey, { title: string; sentence: string }> = {
  acknowledgement: {
    title: "Acknowledged",
    sentence:
      "A source saw this agent and Nooscape kept only locator-class facts: the name, where it was seen, and the source's own key for it. No claims and no tiers. It never appears on the home map as a reviewed record. Acknowledgement is never endorsement.",
  },
  erc8004: {
    title: "ERC-8004",
    sentence:
      "A public sign-up sheet for AI agents on a blockchain. Each agent gets an ID number, an owner wallet, and a link to its profile. Nooscape reads the registrations directly from the chain.",
  },
  agentCard: {
    title: "Agent profile (card)",
    sentence:
      "A small file the agent publishes about itself: name, description, and how to reach it. Whatever it says is self-claimed until a tier says otherwise.",
  },
  tier: {
    title: "Tier",
    sentence:
      "How much Nooscape has checked itself. Tier 2: fetched from an approved source and kept as signed evidence. Tier 3: domain control proven. Tier 4: publisher key approved. Tiers are evidence levels, not quality scores.",
  },
  registrant: {
    title: "Wallet recorded on-chain",
    sentence:
      "The wallet a registry records against an identity. For ERC-8004 it is the wallet that paid the registration, decoded from the registration event. For the Solana registries it is the current owner or authority read from the on-chain account, which can change hands. A chain fact, not a verified operator.",
  },
  lookalike: {
    title: "Look-alikes",
    sentence:
      "Acknowledged entries that share a locator-class fact: the same registering wallet, the same exact name, or the same locator host. Grouped so one operator's registrations can't be mistaken for many independent agents.",
  },
  fleet: {
    title: "Fleet",
    sentence:
      "Many agents registered by one wallet. Fleets are normal for platforms, but worth knowing about before trusting a 'different' agent.",
  },
  chainActivity: {
    title: "Chain activity",
    sentence:
      "On-chain events about an agent's identity: when it was minted, when it changed wallets, and when its profile link was edited. Nooscape counts these directly from the registry. They are timing facts, never a measure of how well the agent works.",
  },
  handout: {
    title: "Hand-out",
    sentence:
      "A change of hands within roughly an hour of minting. It is the signature of a platform distributing identities to many wallets at once, not someone buying an agent.",
  },
  x402: {
    title: "x402",
    sentence:
      "A payment protocol where an agent pays for a service per request, typically a fraction of a cent at a time. The settlement rail it settles on can be measured on-chain; which agent made which payment cannot, yet.",
  },
  preauth: {
    title: "Pre-authorized transfer (EIP-3009)",
    sentence:
      "A wallet signs an instruction that lets a relayer move a fixed amount of its tokens later. The transfer lands on-chain as one settlement. EIP-3009 is older than x402, so some settlements on the rail are ordinary transfers, not agent payments.",
  },

  // The names of the places on the site. Each one says literally what it is, and nothing on any of them is a score.
  noosphere: {
    title: "The Noosphere",
    sentence: "The map of agents: each point is one agent a registry records, coloured by its chain. How a point glows comes from the evidence on record, never from a score or a payment.",
  },
  steadyLight: {
    title: "Steady light",
    sentence: "A point with evidence on record, such as a record Nooscape reviewed and retained. It says evidence exists, not that the agent is good.",
  },
  dimCluster: {
    title: "Dim cluster",
    sentence: "A fleet: many agents recorded against one registering wallet, drawn together and dimmed. It shows where registrations pile up, not who runs them or whether anything is wrong.",
  },
  regions: {
    title: "Regions",
    sentence: REGIONS_SENTENCE,
  },
  askTheOwl: {
    title: "Ask the Owl",
    sentence: "Opens the agent search in the Deep map. Find an agent by name, domain, mint or capability.",
  },
  dossier: {
    title: "Dossier",
    sentence: "The page for one agent: all the evidence Nooscape has on record for it, each part labelled with where it came from. It shows what the record says and leaves the judging to you.",
  },
  clearTheFog: {
    title: "Clear the Fog",
    sentence: "Dims the funnel steps that only count listings, so you see what rests on checked evidence. Nothing is deleted, and you can show them again.",
  },
  fleetSightings: {
    title: "Fleet sightings",
    sentence: "The fleets the Owl has found. Today a fleet means many identities recorded against one registering wallet, which is the only signal so far.",
  },
  fieldReports: {
    title: "Field Reports",
    sentence: "The newest events the Owl has measured on the ERC-8004 registry, each stamped by the block it happened in. The chain keeps no timestamps.",
  },
  owlsCatch: {
    title: "Owl's Catch",
    sentence: "One finding a day, picked by a fixed rule from the record's own counts and not by hand. It says what a count is, never what it means.",
  },
  yourWatch: {
    title: "Your Watch",
    sentence: "The agents you follow. The Owl tells you when their record changes.",
  },
  patrols: {
    title: "Patrols",
    sentence: "Reports from the community of fleets the Owl missed. Each one is reviewed before anything is published.",
  },
  howTheOwlSees: {
    title: "How the Owl sees",
    sentence: "The method in three steps: read the registries, group the fleets, show the evidence.",
  },
  owlsLastSweep: {
    title: "Owl's last sweep",
    sentence: "When the Owl last read a chain successfully. Counts are as of that read, and each chain shows its own time.",
  },
};

// The public honesty funnel: how far an agent can travel from merely seen to
// independently proven. The endpoint ships only step keys and measured counts;
// labels and count notes live here so copy edits never touch the server.
export const directoryFunnelStepCopy: Record<
  string,
  { label: string; note: string; term?: GlossaryKey }
> = {
  acknowledged: {
    label: "Acknowledged in the directory",
    note: "Every agent entry across all surveyed sources. Acknowledgement is never endorsement.",
    term: "acknowledgement",
  },
  withLocator: {
    label: "Locator host recorded",
    note: "Entries carrying a locator host where the agent's record was seen.",
  },
  withRegistrant: {
    label: "Wallet recorded on-chain",
    note: "Entries with a wallet on record: the payer for ERC-8004, the owner for Solana registries.",
    term: "registrant",
  },
  withMintMeasured: {
    label: "Minting measured on-chain",
    note: "Entries whose minting the activity walk has measured, the anchor for counting hand-outs.",
    term: "chainActivity",
  },
  reviewed: {
    label: "Reviewed into public records",
    note: "Records Nooscape fetched itself from an approved source and retained as signed evidence.",
    term: "tier",
  },
  domainProven: {
    label: "Website ownership proven",
    note: "Tier 3 or Tier 4 records: operators who proved domain control or hold a publisher key.",
  },
};

// What no directory can honestly show yet. Nooscape displays the gap instead
// of inventing a number for it.
export const notYetMeasurable: { title: string; sentence: string }[] = [
  {
    title: "What an agent earns",
    sentence:
      "The settlement rail agents pay over is measured, but no payment on it can yet be tied to a registered agent. Per-agent earnings stay unmeasured until facilitator data makes attribution unambiguous.",
  },
  {
    title: "Which agents call each other",
    sentence:
      "Agent-to-agent calls aren't visible on-chain or in profiles. Any 'network' view is layout, not traffic.",
  },
  {
    title: "Uptime over time",
    sentence:
      "Sources are observed on a schedule. An observation is a retained snapshot, not an uptime record.",
  },
  {
    title: "Whether an acknowledged agent is alive",
    sentence:
      "Acknowledgement keeps locator facts only. 'Seen once' is the honest limit of what it can say.",
  },
];
