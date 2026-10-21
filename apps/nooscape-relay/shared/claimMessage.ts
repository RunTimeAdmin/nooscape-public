/**
 * The message an owner signs to claim an agent, or to edit what the claim shows (docs/claims-2026-10-18.md). It is an EIP-4361
 * ("Sign-In with Ethereum") message, so a wallet shows it as a sign-in and checks its domain against the page that asked. Pure and
 * shared: the server builds it from what it stored when it issued the nonce and compares the text it is sent byte for byte, and the
 * page shows the one it was given.
 *
 * It binds the domain, the page, the chain, the registry and the agent, a nonce the server issued, when it was issued and when it
 * expires, and (for an edit) the edit itself, written out in the message as JSON so the wallet shows exactly what is being signed
 * for and not a hash of it. A signature made for another site, another agent, another edit or an older nonce is therefore not valid
 * here. It asks for no transaction, no gas and no approval, and says so.
 */

export const CLAIM_DOMAIN = "nooscape.si";
export const CLAIM_ORIGIN = `https://${CLAIM_DOMAIN}`;
/** A nonce lives this long and is used once. */
export const CLAIM_NONCE_TTL_MS = 10 * 60 * 1000;

export type ClaimAction = "claim" | "edit";

const NO_COST = "This only proves you own the wallet. No transaction, no gas, no approval.";
export const CLAIM_STATEMENT = `Claim this agent on Nooscape. ${NO_COST}`;
/**
 * The statement of an edit message: the changes as canonical JSON (the fields it names, in a fixed order). JSON has no line break in
 * it, which an EIP-4361 statement may not have, and the text of each field was cleaned of line breaks and control characters before.
 */
export const editStatement = (editText: string) => `Edit the owner-provided profile of this agent on Nooscape. ${NO_COST} Changes: ${editText}`;

/** The registry entry the claim is about, in the CAIP-10 style the directory already keys it by. */
export const claimResource = (chainId: number, registry: string, tokenId: string) => `eip155:${chainId}:${registry}:${tokenId}`;

export type ClaimMessageFields = {
  /** The wallet signing, in its EIP-55 checksummed form. */
  address: string;
  action: ClaimAction;
  /** The directory entry's id: the page the message names. */
  entryId: string;
  chainId: number;
  registry: string;
  tokenId: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
  /** The canonical JSON of the edit, for an edit; null for a claim. */
  editText: string | null;
};

/** The longest message the server issues or accepts: the largest edit (about 3,600 characters of JSON) plus the fixed lines. */
export const CLAIM_MESSAGE_MAX = 8_000;

/** The EIP-4361 text for these fields. The same fields always give the same text. */
export function buildClaimMessage(fields: ClaimMessageFields): string {
  const statement = fields.action === "edit" ? editStatement(fields.editText ?? "") : CLAIM_STATEMENT;
  return [
    `${CLAIM_DOMAIN} wants you to sign in with your Ethereum account:`,
    fields.address,
    "",
    statement,
    "",
    `URI: ${CLAIM_ORIGIN}/agents/${fields.entryId}`,
    "Version: 1",
    `Chain ID: ${fields.chainId}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt.toISOString()}`,
    `Expiration Time: ${fields.expiresAt.toISOString()}`,
    "Resources:",
    `- ${claimResource(fields.chainId, fields.registry, fields.tokenId)}`,
  ].join("\n");
}
