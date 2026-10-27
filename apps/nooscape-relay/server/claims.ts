import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { agentClaimEdits, agentClaimNonces, agentClaims } from "../drizzle/schema";
import { buildClaimMessage, CLAIM_MESSAGE_MAX, CLAIM_NONCE_TTL_MS, type ClaimAction } from "@shared/claimMessage";
import { applyClaimEdit, canonicalClaimEdit, CLAIM_FIELDS, claimEditChanges, normalizeClaimEdit, type ClaimEdit, type ClaimField, type ClaimProfile } from "@shared/claimProfile";
import { FLEET_MIN } from "@shared/noosphere";
import { callChain, callChainForWorker, ChainUnavailableError, claimableChains, claimChainOf, contractAcceptsSignature, isContractAddress, readOwnerOf, type ClaimChain, type EvmCall } from "./claimsChain";
import { isContractSignature, isCounterfactualSignature, isEvmAddress, parseEvmSignature, personalMessageHash, recoverEvmAddress, toChecksumAddress } from "./claimsCrypto";
import { countVisibleEntriesOfRegistrant, getDb, getDirectoryEntryForClaim, requireDb } from "./db";
import { sanitizePublicText } from "./publicText";
import { driverErrorHas, isMissingTable } from "./driverErrors";
import { consumeRateLimit } from "./rateLimit";

/**
 * "Claim this agent" (docs/claims-2026-10-18.md): the owner of an agent on an EVM ERC-8004 registry signs a message with their wallet,
 * the server checks that the registry says that wallet owns the agent now, and the owner may then write a name, a website, a
 * description and a few links beside what Nooscape observed. A claim is the owner's own word. It is never a tier, a review, a rating or
 * a score, it changes nothing about whether an entry is listed or where it sits, and it is shown as "claimed, self-described".
 *
 * What it asks of the owner is one signature on a sign-in message: no transaction, no gas, no approval. What it checks:
 *  - the nonce was issued by this server, is unused, has not expired, and the message sent back is exactly the one it would build;
 *  - the signature is the wallet's (a plain signature, or EIP-1271 for a contract wallet; a counterfactual wallet is refused);
 *  - the registry says that wallet owns the agent now (`ownerOf`), at the claim and again on every edit, and every day after;
 *  - neither the wallet nor the wallet the entry was registered by is a fleet (50 or more listings), and a wallet holds fewer than 50
 *    claims, since a fleet would claim at fleet level, which is not built.
 * An owner that changes revokes the claim and says so in the history. The history is append-only. With the tables missing every call
 * answers "claims are not available" and nothing else happens.
 *
 * A verification that fails because of what the caller sent (a bad signature, a wallet that is not the owner) spends the nonce, so a
 * failed attempt costs a new message and a flood of them cannot spend the chain budget for free; one that fails because the chain could
 * not be read does not. The nonce table keeps its times as unix seconds, so no session time zone can change a message's text.
 */

export type ClaimErrorCode =
  | "UNAVAILABLE"
  | "CHAIN_UNAVAILABLE"
  | "NOT_CLAIMABLE"
  | "FLEET"
  | "BAD_REQUEST"
  | "NONCE"
  | "BAD_SIGNATURE"
  | "COUNTERFACTUAL"
  | "NOT_OWNER"
  | "ALREADY_CLAIMED"
  | "FROZEN"
  | "NO_CLAIM"
  | "OWNER_CHANGED"
  | "RATE_LIMITED"
  | "INVALID_EDIT"
  | "TOO_MANY_EDITS";

/** An answer the visitor is meant to read: its text is fixed and carries no address, no key and no query. */
export class ClaimError extends Error {
  readonly code: ClaimErrorCode;
  readonly field: ClaimField | null;
  constructor(code: ClaimErrorCode, message: string, field: ClaimField | null = null) {
    super(message);
    this.name = "ClaimError";
    this.code = code;
    this.field = field;
  }
}

export const CLAIM_MESSAGES = {
  UNAVAILABLE: "Claims are not available right now.",
  CHAIN_UNAVAILABLE: "The chain could not be read right now. Try again in a few minutes.",
  NOT_CLAIMABLE: "This entry cannot be claimed. Only agents on the Robinhood Chain and BNB Smart Chain registries can.",
  FLEET: "This wallet is listed for many registrations here, or already holds many claims, which makes it a fleet. Claims for fleets are not available yet.",
  BAD_REQUEST: "That request is not valid.",
  NONCE: "That sign-in request is not valid, has been used or has expired. Start again.",
  BAD_SIGNATURE: "The signature does not match the wallet. Start again for a new message.",
  COUNTERFACTUAL: "Wallets that are not deployed yet are not supported. Deploy the wallet and try again.",
  NOT_OWNER: "The registry does not record that wallet as the owner of this agent. Start again for a new message.",
  ALREADY_CLAIMED: "This agent is already claimed.",
  FROZEN: "This claim is on hold.",
  NO_CLAIM: "This agent has no claim from that wallet.",
  OWNER_CHANGED: "The registry no longer records that wallet as the owner, so the claim has been revoked.",
  RATE_LIMITED: "Too many requests. Try again later.",
  INVALID_EDIT: "That change is not valid.",
  TOO_MANY_EDITS: "This agent has reached its limit of edits for the day.",
} as const satisfies Record<ClaimErrorCode, string>;

/** The registries named in the words for an entry that cannot be claimed: "A and B", or "A, B and C" while Arc's claims are on. */
function notClaimableMessage(): string {
  const names = claimableChains().map(chain => chain.label);
  return `This entry cannot be claimed. Only agents on the ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} registries can.`;
}

const fail = (code: ClaimErrorCode, field: ClaimField | null = null) => new ClaimError(code, code === "NOT_CLAIMABLE" ? notClaimableMessage() : CLAIM_MESSAGES[code], field);

/** The failures that are the caller's doing: they spend the nonce. A chain that could not be read does not. */
const SPENDS_THE_NONCE: ReadonlySet<ClaimErrorCode> = new Set<ClaimErrorCode>(["BAD_SIGNATURE", "COUNTERFACTUAL", "NOT_OWNER", "FLEET", "FROZEN", "NO_CLAIM", "OWNER_CHANGED"]);

// ---------------------------------------------------------------- limits

/** Messages for one wallet from one client, and requests from one client, in a window of ten minutes. */
const NONCES_PER_WALLET = 5;
const REQUESTS_PER_CLIENT = 20;
const CLAIM_WINDOW_MS = CLAIM_NONCE_TTL_MS;
/** Edits an agent may take in a day, counted from the nonces that made one, before any chain is asked. */
const EDITS_PER_AGENT_PER_DAY = 20;
/** Claims in force for one wallet: at this many it is a fleet, like the Noosphere's wallets. */
const CLAIMS_PER_WALLET = FLEET_MIN;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The daily check of owners: a claim is asked again when it was last asked this long ago, at most this many claims a run. */
const RECHECK_AFTER_MS = 23 * 60 * 60 * 1000;
const RECHECK_MAX_PER_RUN = 25;
/** A nonce row is kept this long after it expires, for the day's edit count, then swept by the daily step. */
export const NONCE_KEPT_MS = 2 * DAY_MS;

/** Counts a request from one client against its ten-minute limit, for the router to call before any work. */
export function limitClient(clientKey: string, now = Date.now()): void {
  if (!consumeRateLimit(`claim:${clientKey}`, REQUESTS_PER_CLIENT, CLAIM_WINDOW_MS, now).allowed) throw fail("RATE_LIMITED");
}

// ---------------------------------------------------------------- dependencies

type ClaimDeps = {
  /** One read-only call on a chain. A request's is held to a per-minute budget; tests replace it. */
  call: EvmCall;
  now: () => Date;
  /** A new nonce: at least 8 letters and digits. */
  newNonce: () => string;
};

const defaultClaimDeps: ClaimDeps = {
  call: callChain,
  now: () => new Date(),
  newNonce: () => randomBytes(16).toString("hex"),
};

/** The daily check reads with the worker's own call, which a visitor's requests cannot use up. */
const workerClaimDeps: ClaimDeps = { ...defaultClaimDeps, call: callChainForWorker };

/** Unix seconds, and back: the nonce table keeps its times this way. */
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
const fromSeconds = (value: number) => new Date(value * 1000);
/** The time the claim tables keep, to the second. */
const wholeSeconds = (date: Date) => fromSeconds(seconds(date));

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

// ---------------------------------------------------------------- the entry a claim is about

type ClaimTarget = { entryId: string; chain: ClaimChain; tokenId: string };

/** The chain and token an entry's key names, when it names exactly the registry of its own chain. */
export function claimTargetOf(entry: { id: string; protocol: string; externalKey: string }): ClaimTarget | null {
  const chain = claimChainOf(entry.protocol);
  if (!chain) return null;
  const match = /^eip155:(\d+):(0x[0-9a-fA-F]{40}):(0|[1-9]\d{0,77})$/.exec(entry.externalKey);
  if (!match || Number(match[1]) !== chain.chainId || match[2]!.toLowerCase() !== chain.registry.toLowerCase()) return null;
  return { entryId: entry.id, chain, tokenId: match[3]! };
}

const isDuplicate = (error: unknown) => driverErrorHas(error, "ER_DUP_ENTRY");

/** Runs a database step, answering "claims are not available" when the tables are missing and passing every other failure up. */
async function withTables<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (isMissingTable(error)) throw fail("UNAVAILABLE");
    throw error;
  }
}

async function loadTarget(entryId: string): Promise<{ target: ClaimTarget; registrant: string | null }> {
  const entry = await getDirectoryEntryForClaim(entryId);
  const target = entry ? claimTargetOf(entry) : null;
  if (!entry || !target) throw fail("NOT_CLAIMABLE");
  return { target, registrant: entry.registrant };
}

type ClaimRow = typeof agentClaims.$inferSelect;
type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function claimInForce(db: Db | Tx, entryId: string): Promise<ClaimRow | null> {
  const [row] = await db.select().from(agentClaims).where(eq(agentClaims.inForceEntryId, entryId)).limit(1);
  return row ?? null;
}

/**
 * A fleet cannot claim a single agent: the wallet, or the wallet the entry was registered by (an agent moved out of a fleet to a fresh
 * wallet is still a fleet's), is listed for 50 registrations or more, or the wallet already holds 50 claims in force.
 */
async function refuseFleet(db: Db | Tx, target: ClaimTarget, wallet: string, registrant: string | null): Promise<void> {
  const protocol = target.chain.protocol;
  if ((await countVisibleEntriesOfRegistrant(protocol, wallet)) >= FLEET_MIN) throw fail("FLEET");
  if (registrant !== null && registrant.toLowerCase() !== wallet && (await countVisibleEntriesOfRegistrant(protocol, registrant)) >= FLEET_MIN) throw fail("FLEET");
  const [held] = await db.select({ total: sql<number>`count(*)` }).from(agentClaims).where(and(eq(agentClaims.wallet, wallet), isNotNull(agentClaims.inForceEntryId)));
  if (Number(held?.total ?? 0) >= CLAIMS_PER_WALLET) throw fail("FLEET");
}

const profileOf = (row: ClaimRow): ClaimProfile => ({
  name: row.name,
  website: row.website,
  description: row.description,
  links: row.links ? (JSON.parse(row.links) as string[]) : [],
});

// ---------------------------------------------------------------- 1. the nonce, and the message to sign

type IssuedClaimRequest = { nonce: string; message: string; expiresAt: Date };

/**
 * Issues the message for a wallet to sign: to claim an agent, or to make one edit to what a claim shows. Nothing is asked of a chain
 * here. The nonce is returned once; only its hash is kept. `clientKey` is who is asking, so the limit on messages for a wallet is
 * spent by the asker and not by anyone who can name the wallet.
 */
export async function issueClaimRequest(
  input: { entryId: string; wallet: string; action: ClaimAction; edit?: ClaimEdit; clientKey?: string },
  deps: ClaimDeps = defaultClaimDeps
): Promise<IssuedClaimRequest> {
  if (!isEvmAddress(input.wallet) || (input.action !== "claim" && input.action !== "edit")) throw fail("BAD_REQUEST");
  const wallet = input.wallet.toLowerCase();
  // What can be refused without touching anything is refused first, and does not count against anyone.
  let editText: string | null = null;
  if (input.action === "edit") {
    const edit = normalizeClaimEdit(input.edit ?? {}, sanitizePublicText);
    if (!edit.ok) throw new ClaimError("INVALID_EDIT", edit.message, edit.field);
    editText = canonicalClaimEdit(edit.fields);
    if (editText.length > 4000) throw fail("INVALID_EDIT");
  }
  const { target, registrant } = await loadTarget(input.entryId);
  // One wallet cannot be asked for more than a handful of messages in ten minutes by one client, however many pages it asks from.
  // Keyed on the asker as well as the wallet: a stranger who names a wallet spends only their own allowance, never the owner's.
  if (!consumeRateLimit(`claim-wallet:${wallet}:${input.clientKey ?? "-"}`, NONCES_PER_WALLET, CLAIM_WINDOW_MS, deps.now().getTime()).allowed) throw fail("RATE_LIMITED");
  return withTables(async () => {
    const db = requireDb(await getDb());
    const existing = await claimInForce(db, target.entryId);
    if (input.action === "edit") {
      if (!existing || existing.wallet !== wallet) throw fail("NO_CLAIM");
      if (existing.status === "frozen") throw fail("FROZEN");
      await assertEditsLeft(db, target.entryId, deps.now());
    } else {
      if (existing?.status === "frozen") throw fail("FROZEN");
      if (existing && existing.wallet === wallet) throw fail("ALREADY_CLAIMED");
      await refuseFleet(db, target, wallet, registrant);
    }
    const issuedAt = seconds(deps.now());
    const expiresAt = issuedAt + CLAIM_NONCE_TTL_MS / 1000;
    const nonce = deps.newNonce();
    await db.insert(agentClaimNonces).values({ id: randomUUID(), nonceHash: sha256(nonce), action: input.action, entryId: target.entryId, wallet, chainId: target.chain.chainId, editText, issuedAt, expiresAt });
    const message = buildClaimMessage({ address: toChecksumAddress(wallet), action: input.action, entryId: target.entryId, chainId: target.chain.chainId, registry: target.chain.registry, tokenId: target.tokenId, nonce, issuedAt: fromSeconds(issuedAt), expiresAt: fromSeconds(expiresAt), editText });
    return { nonce, message, expiresAt: fromSeconds(expiresAt) };
  });
}

/** An agent takes at most this many edits in a day, counted from the nonces that made one (a refused attempt is not an edit). */
async function assertEditsLeft(db: Db | Tx, entryId: string, now: Date): Promise<void> {
  const [row] = await db
    .select({ total: sql<number>`count(*)` })
    .from(agentClaimNonces)
    .where(and(eq(agentClaimNonces.entryId, entryId), eq(agentClaimNonces.action, "edit"), eq(agentClaimNonces.outcome, "applied"), gt(agentClaimNonces.usedAt, seconds(new Date(now.getTime() - DAY_MS)))));
  if (Number(row?.total ?? 0) >= EDITS_PER_AGENT_PER_DAY) throw fail("TOO_MANY_EDITS");
}

// ---------------------------------------------------------------- 2. checking a signed message

type NonceRow = typeof agentClaimNonces.$inferSelect;

/**
 * Finds the nonce a signed message answers and rebuilds the message from what was stored when it was issued. The text the wallet signed
 * has to be that text, byte for byte, so a message for another site, agent, chain, wallet, edit or time cannot be passed off as this one.
 */
async function loadIssued(db: Db | Tx, input: { nonce: string; message: string }, action: ClaimAction, now: Date): Promise<{ row: NonceRow; target: ClaimTarget; registrant: string | null }> {
  if (typeof input.nonce !== "string" || !/^[0-9a-zA-Z]{8,64}$/.test(input.nonce) || typeof input.message !== "string" || input.message.length > CLAIM_MESSAGE_MAX) throw fail("NONCE");
  const [row] = await db.select().from(agentClaimNonces).where(eq(agentClaimNonces.nonceHash, sha256(input.nonce))).limit(1);
  if (!row || row.action !== action || row.usedAt !== null || row.expiresAt <= seconds(now)) throw fail("NONCE");
  const { target, registrant } = await loadTarget(row.entryId);
  if (target.chain.chainId !== row.chainId) throw fail("NONCE");
  const expected = buildClaimMessage({ address: toChecksumAddress(row.wallet), action, entryId: row.entryId, chainId: row.chainId, registry: target.chain.registry, tokenId: target.tokenId, nonce: input.nonce, issuedAt: fromSeconds(row.issuedAt), expiresAt: fromSeconds(row.expiresAt), editText: row.editText });
  if (input.message !== expected) throw fail("NONCE");
  return { row, target, registrant };
}

/** Uses a nonce once. True when this call used it: the update is conditional, so two at once cannot both. */
async function useNonce(db: Db | Tx, row: NonceRow, outcome: "applied" | "refused", now: Date): Promise<boolean> {
  const [used] = await db
    .update(agentClaimNonces)
    .set({ usedAt: seconds(now), outcome })
    .where(and(eq(agentClaimNonces.id, row.id), isNull(agentClaimNonces.usedAt), gt(agentClaimNonces.expiresAt, seconds(now))));
  return used.affectedRows === 1;
}

/**
 * Runs the checks that follow a nonce's rebuilt message. A failure that is the caller's doing spends the nonce; the failure to read a
 * chain does not, and nothing else does.
 */
async function checkingNonce<T>(db: Db | Tx, row: NonceRow, now: Date, checks: () => Promise<T>): Promise<T> {
  try {
    return await checks();
  } catch (error) {
    if (error instanceof ClaimError && SPENDS_THE_NONCE.has(error.code)) await useNonce(db, row, "refused", now).catch(() => false);
    throw error;
  }
}

/** True when the signature is the wallet's: a plain one that recovers to it, or a contract wallet's own (EIP-1271). */
async function signatureIsFrom(deps: ClaimDeps, chainId: number, wallet: string, message: string, signature: string): Promise<boolean> {
  if (typeof signature !== "string") return false;
  if (isCounterfactualSignature(signature)) throw fail("COUNTERFACTUAL");
  const hash = personalMessageHash(message);
  if (parseEvmSignature(signature) && recoverEvmAddress(hash, signature) === wallet) return true;
  if (!isContractSignature(signature)) return false;
  try {
    return (await isContractAddress(deps.call, chainId, wallet)) && (await contractAcceptsSignature(deps.call, chainId, wallet, hash, signature));
  } catch (error) {
    if (error instanceof ChainUnavailableError) throw fail("CHAIN_UNAVAILABLE");
    throw error;
  }
}

/** The owner the registry records now, asked once. An outage is "try again", never a verdict on the claim. */
async function ownerNow(deps: ClaimDeps, target: ClaimTarget): Promise<string | null> {
  try {
    const read = await readOwnerOf(deps.call, target.chain, target.tokenId);
    return read.status === "owner" ? read.owner : null;
  } catch (error) {
    if (error instanceof ChainUnavailableError) throw fail("CHAIN_UNAVAILABLE");
    throw error;
  }
}

/**
 * The owner as the registry records it, for a claim that is about to be ended: asked twice when the first answer is not the claimant,
 * so one wrong answer (a node that lags, a provider that blips) does not end a claim and discard what its owner wrote. Both answers
 * must say the same thing; the second is the one acted on.
 */
async function ownerBeforeRevoking(deps: ClaimDeps, target: ClaimTarget, claimant: string): Promise<string | null> {
  const first = await ownerNow(deps, target);
  return first === claimant ? first : ownerNow(deps, target);
}

// ---------------------------------------------------------------- 3. making the claim

type ClaimResult = { claimId: string; status: "active"; wallet: string };

/** Makes the claim a signed message asks for, after every check above. The nonce is used only when the claim is written, or when the caller's own mistake spends it. */
export async function verifyAndClaim(input: { nonce: string; message: string; signature: string }, deps: ClaimDeps = defaultClaimDeps): Promise<ClaimResult> {
  return withTables(async () => {
    const db = requireDb(await getDb());
    const { row, target, registrant } = await loadIssued(db, input, "claim", deps.now());
    await checkingNonce(db, row, deps.now(), async () => {
      if (!(await signatureIsFrom(deps, row.chainId, row.wallet, input.message, input.signature))) throw fail("BAD_SIGNATURE");
      await refuseFleet(db, target, row.wallet, registrant);
      if ((await ownerNow(deps, target)) !== row.wallet) throw fail("NOT_OWNER");
    });
    const now = wholeSeconds(deps.now());
    const digest = sha256(input.signature);
    try {
      return await db.transaction(async tx => {
        if (!(await useNonce(tx, row, "applied", now))) throw fail("NONCE");
        const existing = await claimInForce(tx, target.entryId);
        if (existing) {
          if (existing.status === "frozen") throw fail("FROZEN");
          // The same owner claiming again is done already. Another owner is the new owner of an agent that changed hands: the old claim ends.
          if (existing.wallet === row.wallet) return { claimId: existing.id, status: "active" as const, wallet: row.wallet };
          await revokeInTransaction(tx, existing, "owner_changed", row.wallet, now);
        }
        const claimId = randomUUID();
        await tx.insert(agentClaims).values({
          id: claimId,
          entryId: target.entryId,
          inForceEntryId: target.entryId,
          protocol: target.chain.protocol,
          chainId: target.chain.chainId,
          registry: target.chain.registry,
          tokenId: target.tokenId,
          wallet: row.wallet,
          status: "active",
          claimedAt: now,
          statusChangedAt: now,
          lastOwnerCheckAt: now,
          signatureDigest: digest,
        });
        await tx.insert(agentClaimEdits).values({ id: randomUUID(), claimId, entryId: target.entryId, kind: "claim", wallet: row.wallet, signatureDigest: digest, occurredAt: now });
        return { claimId, status: "active" as const, wallet: row.wallet };
      });
    } catch (error) {
      // Two claims for one entry at once: the unique index let one through.
      if (isDuplicate(error)) throw fail("ALREADY_CLAIMED");
      throw error;
    }
  });
}

/** Ends a claim and says why in the history. `wallet` is the owner the registry records now, when that is the reason. */
async function revokeInTransaction(tx: Tx, claim: ClaimRow, reason: "owner_changed" | "token_gone", wallet: string | null, now: Date): Promise<void> {
  await tx.update(agentClaims).set({ status: "revoked", inForceEntryId: null, statusChangedAt: now }).where(eq(agentClaims.id, claim.id));
  await tx.insert(agentClaimEdits).values({ id: randomUUID(), claimId: claim.id, entryId: claim.entryId, kind: "revoke", wallet, reason, occurredAt: now });
}

// ---------------------------------------------------------------- 4. an edit

type EditResult = { claimId: string; changed: number };

/**
 * Applies one signed edit to what a claim shows. The message showed exactly this edit. The registry is asked who owns the agent before
 * anything is written: if it is no longer the claimant (on two readings) the claim is revoked, and the edit is refused.
 */
export async function verifyAndEdit(input: { nonce: string; message: string; signature: string; edit: ClaimEdit }, deps: ClaimDeps = defaultClaimDeps): Promise<EditResult> {
  const normalized = normalizeClaimEdit(input.edit ?? {}, sanitizePublicText);
  if (!normalized.ok) throw new ClaimError("INVALID_EDIT", normalized.message, normalized.field);
  return withTables(async () => {
    const db = requireDb(await getDb());
    const { row, target } = await loadIssued(db, input, "edit", deps.now());
    if (row.editText !== canonicalClaimEdit(normalized.fields)) throw fail("NONCE");
    const claim = await checkingNonce(db, row, deps.now(), async () => {
      const found = await claimInForce(db, target.entryId);
      if (!found || found.wallet !== row.wallet) throw fail("NO_CLAIM");
      if (found.status === "frozen") throw fail("FROZEN");
      await assertEditsLeft(db, target.entryId, deps.now());
      if (!(await signatureIsFrom(deps, row.chainId, row.wallet, input.message, input.signature))) throw fail("BAD_SIGNATURE");
      return found;
    });
    const owner = await ownerBeforeRevoking(deps, target, claim.wallet);
    const now = wholeSeconds(deps.now());
    if (owner !== claim.wallet) {
      // The agent has changed hands since the claim: it ends here, whoever is asking, and the new owner may claim.
      await db.transaction(async tx => {
        const current = await claimInForce(tx, target.entryId);
        if (current && current.id === claim.id) await revokeInTransaction(tx, current, owner === null ? "token_gone" : "owner_changed", owner, now);
        await useNonce(tx, row, "refused", now);
      });
      throw fail("OWNER_CHANGED");
    }
    const digest = sha256(input.signature);
    return db.transaction(async tx => {
      if (!(await useNonce(tx, row, "applied", now))) throw fail("NONCE");
      const current = await claimInForce(tx, target.entryId);
      if (!current || current.id !== claim.id || current.status !== "active") throw fail("NO_CLAIM");
      const before = profileOf(current);
      const after = applyClaimEdit(before, normalized.fields);
      const changes = claimEditChanges(before, normalized.fields);
      // Conditional on the claim still being in force and not on hold at the moment of the write, so an operator's hold or a new owner's
      // claim that lands between the read above and this write wins, and the edit is refused with its nonce unused.
      const [written] = await tx
        .update(agentClaims)
        .set({ name: after.name, website: after.website, description: after.description, links: after.links.length > 0 ? JSON.stringify(after.links) : null, lastOwnerCheckAt: now })
        .where(and(eq(agentClaims.id, claim.id), eq(agentClaims.status, "active"), eq(agentClaims.inForceEntryId, target.entryId)));
      if (written.affectedRows !== 1) throw fail("NO_CLAIM");
      for (const change of changes) {
        await tx.insert(agentClaimEdits).values({ id: randomUUID(), claimId: claim.id, entryId: claim.entryId, kind: "edit", field: change.field, oldValue: change.oldValue, newValue: change.newValue, wallet: row.wallet, signatureDigest: digest, occurredAt: now });
      }
      return { claimId: claim.id, changed: changes.length };
    });
  });
}

// ---------------------------------------------------------------- 5. the daily check of owners

/** `unavailable` is how many chains could not be read in the run, and `stoppedBy` is "chain" when there was one (the others were still asked about). */
type RecheckResult = { checked: number; revoked: number; unavailable: number; stoppedBy: "done" | "chain" };

/** Driver errors carry their parameters after the statement; a log line keeps the statement and not the values. */
const withoutParameters = (message: string) => message.split("\nparams:")[0]!;

/**
 * Asks the registry who owns each claimed agent that has not been asked in 23 hours, a few at a time, and revokes a claim whose agent
 * has changed hands (on two readings in a row). It also sweeps nonce rows two days after they expire. It never throws: an unreadable
 * chain leaves its claims alone for the next run and does not stop the claims on the other chains from being asked about, and with the
 * tables missing it does nothing and says nothing.
 */
export async function recheckClaims(deps: ClaimDeps = workerClaimDeps, limit = RECHECK_MAX_PER_RUN): Promise<RecheckResult> {
  const result: RecheckResult = { checked: 0, revoked: 0, unavailable: 0, stoppedBy: "done" };
  try {
    const db = requireDb(await getDb());
    const cutoff = new Date(deps.now().getTime() - RECHECK_AFTER_MS);
    await db.delete(agentClaimNonces).where(lt(agentClaimNonces.expiresAt, seconds(new Date(deps.now().getTime() - NONCE_KEPT_MS))));
    // A chain that cannot be read is left out for the rest of the run. Its claims stay the oldest due, so with the others behind them in
    // the order the check would otherwise stop at the first of them at every run, and a node that is down would stop it for every chain.
    const down = new Set<string>();
    while (result.checked < limit) {
      // Only claims on a chain whose claims are on and that can be read: a claim that cannot be asked about (Arc's, while its claims are
      // off) would stay the oldest due and take the place of the others at every run.
      const protocols = claimableChains().map(chain => chain.protocol).filter(protocol => !down.has(protocol));
      if (protocols.length === 0) break;
      const due = await db
        .select()
        .from(agentClaims)
        .where(and(or(eq(agentClaims.status, "active"), eq(agentClaims.status, "frozen")), lt(agentClaims.lastOwnerCheckAt, cutoff), inArray(agentClaims.protocol, protocols)))
        .orderBy(asc(agentClaims.lastOwnerCheckAt))
        .limit(limit - result.checked);
      let unreadable = false;
      for (const claim of due) {
        const chain = claimChainOf(claim.protocol);
        if (!chain) continue;
        const target: ClaimTarget = { entryId: claim.entryId, chain, tokenId: claim.tokenId };
        let owner: string | null;
        try {
          owner = await ownerBeforeRevoking(deps, target, claim.wallet);
        } catch (error) {
          if (!(error instanceof ClaimError && error.code === "CHAIN_UNAVAILABLE")) throw error;
          result.unavailable += 1;
          result.stoppedBy = "chain";
          down.add(claim.protocol);
          unreadable = true;
          break;
        }
        const now = wholeSeconds(deps.now());
        if (owner === claim.wallet) {
          await db.update(agentClaims).set({ lastOwnerCheckAt: now }).where(eq(agentClaims.id, claim.id));
        } else {
          await db.transaction(async tx => {
            const current = await claimInForce(tx, claim.entryId);
            if (current && current.id === claim.id) await revokeInTransaction(tx, current, owner === null ? "token_gone" : "owner_changed", owner, now);
          });
          result.revoked += 1;
        }
        result.checked += 1;
      }
      // Nothing was unreadable: everything that was due, up to the limit, has been asked about.
      if (!unreadable) break;
    }
  } catch (error) {
    if (!isMissingTable(error)) {
      const message = withoutParameters(error instanceof Error ? error.message : "Unknown claim check error").replace(/[\r\n]+/g, " ").slice(0, 300);
      console.error(JSON.stringify({ event: "nooscape_claim_recheck_failed", message }));
    }
  }
  return result;
}

// ---------------------------------------------------------------- 5b. what the page asks first

type ClaimState = {
  /** False while the claim tables are missing: the page shows nothing for claims. */
  available: boolean;
  /** True for an entry on the Robinhood Chain, BNB Smart Chain or (while its claims are on) Arc registry that the public can see. */
  claimable: boolean;
  /** The claim in force for the entry, with what its owner wrote, or null. The wallet is public chain data. A claim on hold shows no text. */
  claim: { status: "active" | "frozen"; wallet: string; claimedAt: Date; lastOwnerCheckAt: Date; profile: ClaimProfile } | null;
};

/** What a claim on hold shows: nothing the owner wrote. The text stays in the table, and comes back if the hold is lifted. */
const NO_TEXT: ClaimProfile = { name: null, website: null, description: null, links: [] };

/**
 * What an entry's page needs to decide what to show: whether the entry can be claimed, and the claim in force for it. A read of one
 * row by an indexed key; it asks no chain, writes nothing and never reveals a signature. It answers "not available" while the tables
 * are missing, and "not claimable" for an entry the flow does not cover or the public cannot see.
 */
export async function readClaimState(entryId: string): Promise<ClaimState> {
  let target: ClaimTarget;
  try {
    target = (await loadTarget(entryId)).target;
  } catch (error) {
    if (error instanceof ClaimError && error.code === "NOT_CLAIMABLE") return { available: true, claimable: false, claim: null };
    throw error;
  }
  try {
    const db = requireDb(await getDb());
    const row = await claimInForce(db, target.entryId);
    if (!row || (row.status !== "active" && row.status !== "frozen")) return { available: true, claimable: true, claim: null };
    return { available: true, claimable: true, claim: { status: row.status, wallet: row.wallet, claimedAt: row.claimedAt, lastOwnerCheckAt: row.lastOwnerCheckAt, profile: row.status === "frozen" ? NO_TEXT : profileOf(row) } };
  } catch (error) {
    if (isMissingTable(error)) return { available: false, claimable: true, claim: null };
    throw error;
  }
}

// ---------------------------------------------------------------- 5c. the public history

type ClaimHistoryKind = "claim" | "edit" | "freeze" | "unfreeze" | "revoke" | "redact";

type ClaimHistoryItem = {
  seq: number;
  kind: ClaimHistoryKind;
  /** The field an edit changed, or the field whose text was removed. */
  field: ClaimField | null;
  /** The old and new text of an edit. Null for every other row, and for an edit whose text was removed from view. */
  oldValue: string | null;
  newValue: string | null;
  /** True when this edit's text is not shown: it was removed, or its claim is on hold. The row says a change was made, not what it said. */
  withheld: boolean;
  /** The wallet that signed a claim or an edit. Null for every other row. */
  wallet: string | null;
  /** SHA-256 of the signature of a claim or an edit. Null for every other row. */
  signatureDigest: string | null;
  /** A fixed word: "operator" for a hold, "owner_changed" or "token_gone" for an ended claim, "owner_request" or "nooscape" for a removal (who asked, never why). */
  reason: string | null;
  occurredAt: Date;
};

export type ClaimHistory = {
  available: boolean;
  claimable: boolean;
  /** Newest first. */
  items: ClaimHistoryItem[];
  /** True when older rows exist than the ones returned. */
  truncated: boolean;
};

export const CLAIM_HISTORY_LIMIT = 100;

/**
 * The public history of an entry's claims, newest first: every claim, edit, hold, end and removal, with the time and the signing
 * wallet. The table is append-only and is never changed; a removal is a later row that names the field, and every edit of that field
 * before it is returned as "a change was made" without its text, and so is every edit of a claim that is on hold. The full rows stay in
 * the table as the private record. Reads rows by an indexed key, asks no chain, writes nothing.
 */
export async function readClaimHistory(entryId: string): Promise<ClaimHistory> {
  try {
    await loadTarget(entryId);
  } catch (error) {
    if (error instanceof ClaimError && error.code === "NOT_CLAIMABLE") return { available: true, claimable: false, items: [], truncated: false };
    throw error;
  }
  try {
    const db = requireDb(await getDb());
    const inForce = await claimInForce(db, entryId);
    const onHold = inForce?.status === "frozen" ? inForce.id : null;
    const rows = await db.select().from(agentClaimEdits).where(eq(agentClaimEdits.entryId, entryId)).orderBy(desc(agentClaimEdits.seq)).limit(CLAIM_HISTORY_LIMIT + 1);
    const truncated = rows.length > CLAIM_HISTORY_LIMIT;
    const shown = truncated ? rows.slice(0, CLAIM_HISTORY_LIMIT) : rows;
    // The newest removal of each field for each claim. An edit of that field before it has had its text removed.
    const removedAt = new Map<string, number>();
    for (const row of shown) {
      if (row.kind !== "redact") continue;
      const key = `${row.claimId}:${row.field}`;
      removedAt.set(key, Math.max(removedAt.get(key) ?? 0, row.seq));
    }
    const items = shown.map((row): ClaimHistoryItem => {
      const isEdit = row.kind === "edit";
      const withheld = isEdit && (row.claimId === onHold || row.seq < (removedAt.get(`${row.claimId}:${row.field}`) ?? 0));
      const signed = row.kind === "claim" || isEdit;
      return {
        seq: row.seq,
        kind: row.kind as ClaimHistoryKind,
        field: (row.field as ClaimField | null) ?? null,
        oldValue: isEdit && !withheld ? row.oldValue : null,
        newValue: isEdit && !withheld ? row.newValue : null,
        withheld,
        wallet: signed ? row.wallet : null,
        signatureDigest: signed ? row.signatureDigest : null,
        reason: row.reason,
        occurredAt: row.occurredAt,
      };
    });
    return { available: true, claimable: true, items, truncated };
  } catch (error) {
    if (isMissingTable(error)) return { available: false, claimable: true, items: [], truncated: false };
    throw error;
  }
}

// ---------------------------------------------------------------- 6. the operator's hold

/** Puts a claim on hold, or takes it off, and says so in the history. A revoked claim cannot be held. */
export async function setClaimHeld(claimId: string, held: boolean, now: Date = new Date()): Promise<{ status: "active" | "frozen" }> {
  return withTables(async () => {
    const db = requireDb(await getDb());
    return db.transaction(async tx => {
      const [claim] = await tx.select().from(agentClaims).where(eq(agentClaims.id, claimId)).limit(1);
      if (!claim || claim.status === "revoked") throw fail("NO_CLAIM");
      const next = held ? "frozen" : "active";
      if (claim.status === next) return { status: next };
      const at = wholeSeconds(now);
      await tx.update(agentClaims).set({ status: next, statusChangedAt: at }).where(eq(agentClaims.id, claimId));
      await tx.insert(agentClaimEdits).values({ id: randomUUID(), claimId, entryId: claim.entryId, kind: held ? "freeze" : "unfreeze", reason: "operator", occurredAt: at });
      return { status: next };
    });
  });
}

// ---------------------------------------------------------------- 7. the operator's removal of text

/** Who asked for a removal. The history says which, and never why: the reason stays in the private record and the correspondence. */
export type RemovalBy = "owner" | "nooscape";
const REMOVAL_REASON: Record<RemovalBy, string> = { owner: "owner_request", nooscape: "nooscape" };

/**
 * Removes what an owner wrote from view, for the fields named: the claim's current text is cleared, and one
 * "redact" row per field is added to the history, so every edit of that field before it shows as "a change was made" without its text.
 * The history rows themselves are not changed, which keeps the full record. It works on a claim in any state, a revoked one included,
 * and what the owner writes afterwards is a later row and is not withheld. The operator does it when the owner asks, or under the Terms.
 */
export async function removeClaimText(claimId: string, fields: readonly ClaimField[], by: RemovalBy, now: Date = new Date()): Promise<{ removed: ClaimField[] }> {
  const chosen = CLAIM_FIELDS.filter(field => fields.includes(field));
  if (chosen.length === 0) throw fail("BAD_REQUEST");
  return withTables(async () => {
    const db = requireDb(await getDb());
    return db.transaction(async tx => {
      const [claim] = await tx.select().from(agentClaims).where(eq(agentClaims.id, claimId)).limit(1);
      if (!claim) throw fail("NO_CLAIM");
      const cleared = {
        ...(chosen.includes("name") ? { name: null } : {}),
        ...(chosen.includes("website") ? { website: null } : {}),
        ...(chosen.includes("description") ? { description: null } : {}),
        ...(chosen.includes("links") ? { links: null } : {}),
      };
      await tx.update(agentClaims).set(cleared).where(eq(agentClaims.id, claimId));
      const at = wholeSeconds(now);
      for (const field of chosen) {
        await tx.insert(agentClaimEdits).values({ id: randomUUID(), claimId, entryId: claim.entryId, kind: "redact", field, reason: REMOVAL_REASON[by], occurredAt: at });
      }
      return { removed: chosen };
    });
  });
}

type OperatorClaim = { id: string; status: string; wallet: string; claimedAt: Date; statusChangedAt: Date; profile: ClaimProfile };

/** The claims ever made for an entry, newest first, with the ids and the text the operator needs to hold one or remove its text. Operator only. */
export async function listClaimsForOperator(entryId: string): Promise<OperatorClaim[]> {
  return withTables(async () => {
    const db = requireDb(await getDb());
    const rows = await db.select().from(agentClaims).where(eq(agentClaims.entryId, entryId)).orderBy(desc(agentClaims.claimedAt)).limit(10);
    return rows.map(row => ({ id: row.id, status: row.status, wallet: row.wallet, claimedAt: row.claimedAt, statusChangedAt: row.statusChangedAt, profile: profileOf(row) }));
  });
}
