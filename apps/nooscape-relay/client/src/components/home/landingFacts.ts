import { listedChainLabel } from "@shared/chains";
import type { OwlFacts } from "@/components/owl/owlLines";
import { tierExplanations } from "@/lib/evidenceExplain";
import type { ConstellationNode, ConstellationRecord, EvidenceState } from "./constellationModel";

/** A time as ISO text, or null when it is missing or does not read: the read hands over a Date, and a stored one may be text. */
function isoOf(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * What the Owl is told about the record on the Check card: the card's own facts, as data and not as sentences.
 * A fact the page does not have is null, and a line that needs it is not said (components/owl/owlLines.ts).
 */
export function bubbleFacts(node: ConstellationNode | null, evidence: EvidenceState, record: Pick<ConstellationRecord, "lastObservedAt" | "sourceCount"> | undefined): OwlFacts | null {
  // A fleet light is a group of registrations, not a record: the Owl has no fact about it to tell.
  if (!node || node.kind === "fleet") return null;
  const read = evidence.status === "ready" ? evidence : null;
  return {
    key: node.id,
    tierLabel: tierExplanations[node.tier]?.label ?? null,
    chain: node.chain ? listedChainLabel(node.chain) : null,
    observations: read ? read.observations : null,
    publisher: read ? read.publisher : null,
    source: read?.source ?? null,
    lastObservedAt: isoOf(record?.lastObservedAt),
    sourceCount: record?.sourceCount ?? null,
  };
}
