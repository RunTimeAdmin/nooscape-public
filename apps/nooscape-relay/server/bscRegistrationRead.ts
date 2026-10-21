import { isReadStatus } from "./bscClusters";

/**
 * What a BNB entry's page says about whether Nooscape has read its registration (docs/approvals/2026-10-18-bnb-checked-unproven.md).
 * The operator allowed the label "Checked, unproven" on 2026-10-18, and chose what "checked" means: a dated read of the entry's
 * registration, which the clustering step makes from the link itself ("inline") and the registration-file step from the file a web
 * or ipfs link names ("fetched"). The date is the one the evidence row already keeps. Nothing else counts: not a try that got no
 * file, not a file that is not a registration, not a link the step does not read, and not a read of an older link.
 *
 * Pure, so the rule can be tested without a database. It reads no file's content and asks nobody: the entry's own address is
 * never asked, and no BNB check of that kind runs (CHECKABLE_SOURCE_PROTOCOLS in agentChecks.ts is the A2A list alone).
 */
export type BscRegistrationRead = { checked: true; readAt: Date } | { checked: false; readAt: null };

export const BSC_NOT_CHECKED: BscRegistrationRead = { checked: false, readAt: null };

/** The evidence row of a listed BNB entry, as far as this rule reads it. */
export type BscEvidenceForRead = { readStatus: string; readAt: Date; profileUriHash: string };

/**
 * Checked only when the evidence row records a read and was made from the link the entry carries now. A row made from an older
 * link says nothing about this entry's registration (the clustering step reads it again, and the next read dates it).
 */
export function registrationReadOf(evidence: BscEvidenceForRead | null | undefined, entryProfileUriHash: string | null): BscRegistrationRead {
  if (!evidence || entryProfileUriHash === null) return BSC_NOT_CHECKED;
  if (!isReadStatus(evidence.readStatus) || evidence.profileUriHash !== entryProfileUriHash) return BSC_NOT_CHECKED;
  return { checked: true, readAt: evidence.readAt };
}
