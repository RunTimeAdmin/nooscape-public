import { createHash } from "node:crypto";
import { CONTRACT_REFUSED_REASON, dbPaymentLedger, type PaymentLedger, type PaymentRow } from "./apiPayments";
import { consumeRateLimit } from "./rateLimit";
import {
  BASE_MAINNET,
  base64Json,
  contractCandidate,
  decodePayment,
  loadX402,
  paymentIdOf,
  ledgerNetworks,
  paymentProblem,
  railFor,
  railsOf,
  settleBody,
  settleOnRail,
  signatureProblem,
  termsReply,
  timeProblem,
  type PaymentPayload,
  type Rail,
  type Reply,
  type X402Config,
  type X402Endpoint,
} from "./x402";
import { checkContractSignature, rpcClient, usdcBalance, type Rpc } from "./x402Chain";

/**
 * What the server does with a payment (docs/data-access-2026-10-19.md, stage D4). The rules that keep a caller's money safe, in the
 * order they matter:
 *  - An answer is built before anything is charged, so a request that fails (not found, a bad body) never costs a caller anything.
 *  - An answer is delivered only when the facilitator confirmed the settlement and named the transaction. Anything it did not decide
 *    ("open") is never delivered and never refused.
 *  - One signed authorization is settled once. It is recorded before it is sent (its payer and nonce are unique), so a retry, or two
 *    requests at once, finds the record instead of paying twice. A caller who retries gets the same answer back without paying again.
 *  - A payment belongs to the request it was sent with. The same payment for another request is refused.
 *  - A payment that is `open` is sent again, with the same idempotency key, only when its caller sends the request again, and at most
 *    three times. It is never given up on as refused after being sent: a late refusal does not undo a settlement that may have happened.
 *  - At most eight settlements are in flight (the place is taken before the database is touched, so a burst cannot get past the cap), at
 *    most 300 new payments start in a minute, and a pause switch stops new payments while resolving the ones already recorded.
 *  - A smart-contract wallet (stage D4b) is taken only when a chain node is set for its network, and only after the chain says the wallet's own
 *    code accepts the signature and the transfer would settle (a simulation, before anything is recorded). One such wallet has one payment
 *    unresolved at a time on a network, is paused for a day on it after a settlement that failed after it was broadcast, and is sent to the
 *    facilitator at most twice, because a wallet's code can change its answer between the simulation and the settlement and the facilitator
 *    pays that gas. Arc's node is X402_RPC. Base's is BASE_RPC_URL and is used only when the operator has switched Base's smart wallets on
 *    (X402_BASE_SMART_WALLETS=1, docs/x402-base-smart-wallets-2026-11-04.md); until then a payment on Base must be signed by a regular wallet's key.
 *  - A payment belongs to the network it names (docs/x402-base-bazaar-2026-10-21.md): it is recorded under that network, and sent to the
 *    facilitator that settles it. The same authorization on two networks is two payments.
 *  - A new payment is screened before it takes a place in the shared budget (docs/x402-base-bazaar-2026-10-21.md, "Funds and pace"): a
 *    regular wallet that holds less USDC than the price is turned away, where a node is set for its network, and one wallet may start only so
 *    many in a minute. Neither is recorded, so a retry of the same authorization after the wallet is funded is simply a new start.
 * Nothing here changes what an answer says. Payment buys the call and nothing else.
 */

export const MAX_SENDS = 3;
/** Sends of a payment from a smart-contract wallet: its code can change its answer, and a settlement that fails costs gas. */
export const MAX_SENDS_CONTRACT = 2;
/** How long a smart-contract wallet is paused after a settlement of its failed after the facilitator broadcast it. */
export const CONTRACT_PAUSE_MS = 24 * 60 * 60 * 1000;
/** How long a smart-contract wallet is paused after the facilitator refused a payment of its that the chain check had passed. */
export const CONTRACT_REFUSED_PAUSE_MS = 15 * 60 * 1000;
/**
 * Payments of smart-contract wallets on one network that were refused or failed in an hour, past which that network takes no more of them until the
 * hour has moved on, and the operator is told. A wallet's code can pass the chain check and still fail where the facilitator runs it, and a wallet
 * costs nothing to make, so the pause of one wallet is not a limit on all of them. Held in this process's memory.
 */
export const MAX_CONTRACT_FAULTS_PER_HOUR = 20;
const CONTRACT_FAULT_WINDOW_MS = 60 * 60 * 1000;
/** Base's node is a metered provider: it is given less time than Arc's, and its latest block may be less behind (about seven blocks). */
export const BASE_CONTRACT_TIMEOUT_MS = 5_000;
export const BASE_MAX_BEHIND_SECONDS = 15;
/** Chain checks of smart-contract wallets: how many at once, and how many a minute from everyone (each is a read on a metered node). */
export const MAX_CONTRACT_CHECKS_AT_ONCE = 16;
export const MAX_CONTRACT_CHECKS_PER_MINUTE = 600;
export const MAX_SERVES = 3;
export const MAX_IN_FLIGHT = 8;
/** New payments started in a minute, from everyone. The facilitator and the database are shared, and an authorization costs its maker nothing. */
export const MAX_NEW_PER_MINUTE = 300;
/** New payments one wallet may start in a minute, once it is known to hold the price: more than that is a flood and not a caller. */
export const MAX_NEW_PER_PAYER_PER_MINUTE = 60;
/** Funds checks of payers (each a read on a metered node): how many at once, and how many a minute from everyone. Past either, the check is skipped and the facilitator decides. */
export const MAX_BALANCE_CHECKS_AT_ONCE = 32;
export const MAX_BALANCE_CHECKS_PER_MINUTE = 1_200;
/** How long a node may take to say what a payer holds: the check is on the way of every new payment, and a node that is slow is skipped. */
export const BALANCE_TIMEOUT_MS = 3_000;
/** A payment that has been unresolved this long is not going to be resolved by a retry: it is for the operator to look at. */
export const STALE_AFTER_MS = 60 * 60 * 1000;
const STALE_COUNT_MS = 60_000;

/** A payment that passed the checks that need no database: the terms are ours, the signature is the payer's. */
export type PayContext = { endpoint: X402Endpoint; payment: PaymentPayload; resource: string; /** Signed by a smart-contract wallet, which the chain said accepted it. */ contract?: boolean };

export type Accepted = { ok: true; context: PayContext } | { ok: false; reply: Reply };

export type Charge = { deliver: true; headers: Record<string, string> } | { deliver: false; reply: Reply };

export type PaymentService = {
  config: X402Config;
  /** "off" when payments cannot be recorded (the table is missing), "paused" when no new payment is taken, "on" otherwise. */
  state: () => Promise<"off" | "paused" | "on">;
  /** The 402 that tells a caller the price and how to pay. */
  offer: (endpoint: X402Endpoint, resource: string, why: string) => Reply;
  /** The cheap checks on a PAYMENT-SIGNATURE header: it is a payment, on our terms, signed by its payer. Touches no database. */
  accept: (endpoint: X402Endpoint, header: string, resource: string) => Accepted;
  /** Everything accept does, and, for a signature that is not a regular wallet's key's, the chain's word on a smart-contract wallet (when a node is set). */
  verify: (endpoint: X402Endpoint, header: string, resource: string) => Promise<Accepted>;
  /** How many payments have been unresolved for over an hour on the network it is set to, held for a minute, or null when that cannot be read. */
  staleCount: () => Promise<number | null>;
  /** Settles the payment once and says whether to deliver the answer. `subject` names what was asked, so a payment is used for it alone. */
  charge: (context: PayContext, subject: string) => Promise<Charge>;
};

type PaymentServiceOptions = {
  config: X402Config;
  ledger: PaymentLedger;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  settleTimeoutMs?: number;
  /** The chain node used to check a smart-contract wallet's signature. Defaults to the one in the settings, if any. */
  rpc?: Rpc | null;
  /** The same for a payment on Base, used only when Base's smart wallets are switched on. Defaults to the one in the settings (BASE_RPC_URL), if any. */
  baseRpc?: Rpc | null;
  /** Nodes that say what a payer holds, by network (see balanceNodesOf). None by default, so a service built any other way asks no node. */
  balanceNodes?: Record<string, Rpc>;
};

const NO_STORE = { "cache-control": "no-store" };

function unavailable(message: string, retryAfterSeconds: number | null, extra: Record<string, unknown> = {}): Reply {
  return {
    status: 503,
    headers: { ...NO_STORE, ...(retryAfterSeconds === null ? {} : { "retry-after": String(retryAfterSeconds) }) },
    body: { error: { code: "unavailable", message, ...extra } },
  };
}

export function createPaymentService(options: PaymentServiceOptions): PaymentService {
  const { config: cfg, ledger } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const locks = new Map<string, Promise<unknown>>();
  let inFlight = 0;
  // Wallet checks running now, by network, so that one network's slow node cannot hold another's places.
  const contractChecks = new Map<string, number>();
  // When smart-contract wallets' payments were refused or failed, by network.
  const contractFaults = new Map<string, number[]>();
  let balanceChecks = 0;
  const balanceNodes = options.balanceNodes ?? {};
  // The chain node that checks a smart-contract wallet's signature, by network. Base's is used only when the operator has switched it on.
  const contractNodes: Record<string, Rpc> = {};
  const arcNode: Rpc | null = options.rpc !== undefined ? options.rpc : cfg.rpc ? rpcClient(cfg.rpc, fetchImpl) : null;
  if (arcNode) contractNodes[cfg.network] = arcNode;
  const baseNode: Rpc | null = !cfg.baseSmartWallets ? null : options.baseRpc !== undefined ? options.baseRpc : cfg.baseRpc ? rpcClient(cfg.baseRpc, fetchImpl, BASE_CONTRACT_TIMEOUT_MS) : null;
  if (baseNode) contractNodes[BASE_MAINNET] = baseNode;

  /** One at a time for one authorization, so two requests carrying it cannot both start a settlement. */
  async function locked<T>(key: string, run: () => Promise<T>): Promise<T> {
    const next = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
    locks.set(key, next);
    try {
      return await next;
    } finally {
      if (locks.get(key) === next) locks.delete(key);
    }
  }

  const nowSeconds = () => Math.floor(now().getTime() / 1000);
  let staleRead: { at: number; value: number | null } | null = null;

  const again = (ctx: PayContext, why: string): Charge => ({ deliver: false, reply: termsReply(cfg, ctx.endpoint, ctx.resource, why) });

  const deliver = (row: PaymentRow, transaction: string): Charge => ({
    deliver: true,
    headers: { ...NO_STORE, "payment-response": base64Json({ success: true, transaction, network: row.network, payer: row.payer }) },
  });

  /** Records an outcome, twice if the first write fails. What was learned from the facilitator is logged if it cannot be written. */
  async function record(row: PaymentRow, change: Parameters<PaymentLedger["resolve"]>[1]): Promise<void> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await ledger.resolve(row.id, change);
        return;
      } catch (error) {
        if (attempt === 2) console.error(`[x402] could not record ${change.status} for ${row.paymentId} (${change.transaction ?? "no transaction"}):`, error instanceof Error ? error.message.split("\nparams:")[0] : String(error));
      }
    }
  }

  /** One of the places to settle in, or null when all are taken. Taken before anything slow is done, and given back by the caller. */
  function reserve(): (() => void) | null {
    if (inFlight >= MAX_IN_FLIGHT) return null;
    inFlight += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        inFlight -= 1;
      }
    };
  }
  const busy = (): Charge => ({ deliver: false, reply: unavailable("Too many payments are being settled at once. Try again in a moment.", 2) });

  /** Sends a payment to the facilitator. The caller holds a place for it. */
  async function send(ctx: PayContext, row: PaymentRow, resend: boolean): Promise<Charge> {
    const rail = railFor(cfg, row.network);
    if (!rail) {
      // Not reachable from a payment that was accepted (a network we do not take is refused before anything is recorded); never guess a facilitator.
      await record(row, { status: "open", reason: `not settled: no settlement for ${row.network}` });
      return { deliver: false, reply: unavailable("Payments cannot be settled right now. Nothing was charged. Try again later.", 60) };
    }
    const result = await settleOnRail(cfg, rail, settleBody(cfg, ctx.endpoint, ctx.resource, ctx.payment, row.paymentId), row.payer, fetchImpl, options.settleTimeoutMs);
    if (result.kind === "paid") {
      await record(row, { status: "paid", transaction: result.transaction });
      console.log(`[x402] paid ${row.endpoint} ${row.paymentId} ${result.transaction} on ${row.network}${result.bazaar ? ` (bazaar: ${result.bazaar})` : ""}`);
      return deliver(row, result.transaction);
    }
    if (result.kind === "refused") {
      // A refusal of a payment that was sent before is not trusted: the first send may have settled. It stays open, and the caller is told
      // it could not be confirmed, with the id to quote.
      if (resend) {
        await record(row, { status: "open", reason: `refused on resend: ${result.reason}` });
        return again(ctx, `The payment could not be confirmed (${result.reason}). Check your wallet before paying again: if the USDC was not sent, sign a new payment, and if it was, contact the operator and quote ${row.paymentId}.`);
      }
      // A smart-contract wallet's payment that the chain check passed and the facilitator refused cost the shared budget a send for nothing:
      // the wallet is paused for a short while (contractGate), and the network counts it toward its limit.
      if (ctx.contract) noteContractFault(row.network);
      await record(row, { status: "refused", reason: ctx.contract ? `${CONTRACT_REFUSED_REASON}: ${result.reason}` : result.reason });
      return again(ctx, `The payment was refused (${result.reason}). Nothing was charged. Sign a new payment.`);
    }
    if (result.kind === "unavailable") {
      console.error(`[x402] the payment service refused our credentials, terms or address (${result.reason}); ${row.paymentId} is open`);
      await record(row, { status: "open", reason: `not settled: ${result.reason}` });
      // A first send that was refused before anything could move cost nothing. A later send may follow a first whose answer was lost, and that
      // one may have settled: the caller is not told that nothing was charged.
      if (resend) {
        return {
          deliver: false,
          reply: unavailable(`This payment could not be confirmed right now. If you were charged, contact the operator and quote ${row.paymentId}. Send the same request again later to try once more.`, 60, { payment_id: row.paymentId }),
        };
      }
      return { deliver: false, reply: unavailable("Payments cannot be settled right now. Nothing was charged. Try again later.", 60) };
    }
    // A transaction was named and the facilitator did not call it pending: it was broadcast and failed. The wallet is paused for a day.
    const failed = result.transaction !== undefined && !result.pending;
    if (failed && ctx.contract) noteContractFault(row.network);
    const said = failed ? `failed after broadcast: ${result.reason}` : result.reason;
    // The ledger keeps the first transaction a payment named. A later send that names another (a broadcast that reverted because the first had
    // spent the authorization, for one) is told in the reason, because either may be the one that moved the money.
    const later = result.transaction !== undefined && row.transaction !== null && result.transaction !== row.transaction ? ` (a later send named ${result.transaction})` : "";
    await record(row, { status: "open", reason: `${said}${later}`, transaction: result.transaction ?? null });
    return {
      deliver: false,
      reply: unavailable("The payment has not settled yet. Send this same request again with the same payment: you are charged once, and the answer comes when it settles.", 5, { payment_id: row.paymentId }),
    };
  }

  async function serve(ctx: PayContext, row: PaymentRow): Promise<Charge> {
    if (nowSeconds() > row.validBefore || !(await ledger.countServe(row.id, MAX_SERVES))) {
      return again(ctx, "This payment has already been used. Sign a new payment for a new call.");
    }
    return deliver(row, row.transaction ?? "");
  }

  async function resume(ctx: PayContext, row: PaymentRow, subjectHash: string): Promise<Charge> {
    if (row.subjectHash !== subjectHash) return again(ctx, "This payment is attached to a different request. Sign a new payment for this one.");
    if (row.status === "paid") return serve(ctx, row);
    if (row.status === "refused") return again(ctx, `This payment was refused (${row.reason ?? "no reason given"}). Sign a new payment.`);
    if (row.status === "closed") return again(ctx, `This payment was set aside after the operator looked at it. Sign a new payment. If you were charged, contact the operator and quote ${row.paymentId}.`);
    // settling or open: it may have settled, so it is sent again with the same key, a limited number of times.
    if (row.sends >= (ctx.contract ? MAX_SENDS_CONTRACT : MAX_SENDS)) {
      return { deliver: false, reply: unavailable(`This payment could not be confirmed. If you were charged, contact the operator and quote ${row.paymentId}, and do not pay again until you have heard back. If you were not charged, sign a new payment.`, null, { payment_id: row.paymentId }) };
    }
    const release = reserve();
    if (!release) return busy();
    try {
      if (!(await ledger.countSend(row.id))) {
        const settled = await ledger.find(row.network, row.payer, row.nonce);
        if (settled && settled.status !== "settling" && settled.status !== "open") {
          release();
          return await resume(ctx, settled, subjectHash);
        }
        return { deliver: false, reply: unavailable("The payment is being settled. Try again in a moment.", 2) };
      }
      return await send(ctx, row, true);
    } finally {
      release();
    }
  }

  /** Notes that a smart-contract wallet's payment was refused or failed on a network, and tells the operator when the network reaches its limit. */
  function noteContractFault(network: string): void {
    const at = now().getTime();
    const recent = (contractFaults.get(network) ?? []).filter(time => at - time < CONTRACT_FAULT_WINDOW_MS);
    recent.push(at);
    contractFaults.set(network, recent);
    if (recent.length === MAX_CONTRACT_FAULTS_PER_HOUR) console.error(`[x402] smart-contract wallets are paused on ${network}: ${recent.length} of their payments were refused or failed in the last hour`);
  }

  const contractBreakerOpen = (network: string): boolean => {
    const at = now().getTime();
    return (contractFaults.get(network) ?? []).filter(time => at - time < CONTRACT_FAULT_WINDOW_MS).length >= MAX_CONTRACT_FAULTS_PER_HOUR;
  };

  /**
   * What a smart-contract wallet may not do on a network: pay while another payment of its is unresolved there, for a day after a settlement of
   * its failed there, or for a quarter of an hour after the facilitator refused a payment of its that the chain check had passed.
   */
  async function contractGate(payer: string, network: string): Promise<Charge | null> {
    if ((await ledger.failedFor(network, payer, new Date(now().getTime() - CONTRACT_PAUSE_MS))) > 0) {
      return { deliver: false, reply: unavailable("Payments from this wallet are paused for a day after a settlement of its failed. Use another wallet, or a key.", 3600) };
    }
    if ((await ledger.refusedFor(network, payer, new Date(now().getTime() - CONTRACT_REFUSED_PAUSE_MS))) > 0) {
      return { deliver: false, reply: unavailable("Payments from this wallet are paused for a few minutes after the payment service refused one. Try again later, or use a regular wallet's key.", 900) };
    }
    if ((await ledger.openFor(network, payer)) >= 1) return { deliver: false, reply: unavailable("A payment from this wallet is still settling. Try again in a moment.", 10) };
    return null;
  }

  /**
   * What a new payment must pass before it takes a place in the shared budget: the wallet's funds, and then its pace. A regular wallet that
   * holds less than the price is turned away here with nothing recorded and nothing sent on, because its authorization cost it nothing to
   * sign and the facilitator would refuse it anyway. A node that cannot say, or a check over its budget, lets the payment through to the
   * facilitator, which decides as it always has. A smart-contract wallet's funds were part of the chain's simulation already. Only a
   * wallet that holds the price is counted for its pace, so a flood of empty wallets cannot fill the table of limits.
   */
  async function screenPayer(ctx: PayContext, payer: string): Promise<Charge | null> {
    const network = ctx.payment.accepted.network;
    const node = ctx.contract ? undefined : balanceNodes[network];
    const rail = railFor(cfg, network);
    if (node && rail && consumeRateLimit("x402-balance", MAX_BALANCE_CHECKS_PER_MINUTE, 60_000).allowed && balanceChecks < MAX_BALANCE_CHECKS_AT_ONCE) {
      balanceChecks += 1;
      let held: bigint | null;
      try {
        held = await usdcBalance(node, rail.asset, payer);
      } finally {
        balanceChecks -= 1;
      }
      if (held !== null && held < BigInt(ctx.payment.payload.authorization.value)) return again(ctx, "This wallet holds less USDC than the price. Nothing was charged.");
    }
    if (!consumeRateLimit(`x402-payer:${network}:${payer}`, MAX_NEW_PER_PAYER_PER_MINUTE, 60_000).allowed) {
      return { deliver: false, reply: unavailable("Too many payments from this wallet in the last minute. Try again shortly.", 15) };
    }
    return null;
  }

  async function start(ctx: PayContext, payer: string, nonce: string, subjectHash: string): Promise<Charge> {
    if (cfg.pauseNew) return { deliver: false, reply: unavailable("Pay per call is paused. Try again later, or use an API key.", 60) };
    const late = timeProblem(ctx.payment, nowSeconds());
    if (late) return again(ctx, late);
    if (ctx.contract) {
      const blocked = await contractGate(payer, ctx.payment.accepted.network);
      if (blocked) return blocked;
    }
    const screened = await screenPayer(ctx, payer);
    if (screened) return screened;
    if (!consumeRateLimit("x402-start", MAX_NEW_PER_MINUTE, 60_000).allowed) return { deliver: false, reply: unavailable("Too many payments are being started right now. Try again in a moment.", 10) };
    const release = reserve();
    if (!release) return busy();
    try {
      const z = ctx.payment.payload.authorization;
      const network = ctx.payment.accepted.network;
      const row = await ledger.begin({
        paymentId: paymentIdOf(cfg, ctx.payment, subjectHash),
        network,
        endpoint: ctx.endpoint,
        payer,
        nonce,
        amount: Number(cfg.prices[ctx.endpoint]),
        validBefore: Number(z.validBefore),
        subjectHash,
      });
      if (row) return await send(ctx, row, false);
      // Another request recorded it first.
      const found = await ledger.find(network, payer, nonce);
      if (found) {
        release();
        return await resume(ctx, found, subjectHash);
      }
      return { deliver: false, reply: unavailable("The payment is being settled. Try again in a moment.", 2) };
    } finally {
      release();
    }
  }

  type Inspected = { kind: "ok"; context: PayContext } | { kind: "refused"; reply: Reply } | { kind: "contract"; payment: PaymentPayload; keyProblem: string };

  /** The checks that need no database and no node: a payment, on our terms, whose signature is a regular wallet's key's, or might be a contract's. */
  function inspect(endpoint: X402Endpoint, header: string, resource: string): Inspected {
    const refuse = (why: string): Inspected => ({ kind: "refused", reply: termsReply(cfg, endpoint, resource, why) });
    const payment = decodePayment(header);
    if (!payment) return refuse("PAYMENT-SIGNATURE is not a valid x402 payment");
    try {
      const terms = paymentProblem(cfg, endpoint, payment);
      if (terms) return refuse(terms);
      const key = signatureProblem(cfg, payment);
      if (key === null) return { kind: "ok", context: { endpoint, payment, resource } };
      return contractCandidate(payment) ? { kind: "contract", payment, keyProblem: key } : refuse(key);
    } catch {
      // A header is a stranger's: whatever shape it has, it is refused and never allowed to throw.
      return refuse("PAYMENT-SIGNATURE is not a valid x402 payment");
    }
  }

  /**
   * A smart-contract wallet's payment that is recorded already (the same signature, which the idempotency key holds), as a payment to resume, or
   * null. It is not asked of the chain again, and not turned away when the setting for such wallets has been switched off since: its authorization
   * is spent by then, and a caller whose answer was lost must be served, not refused and invited to pay twice.
   */
  async function recordedContract(endpoint: X402Endpoint, payment: PaymentPayload, resource: string, rail: Rail): Promise<Accepted | null> {
    const z = payment.payload.authorization;
    const existing = await ledger.find(rail.network, z.from.toLowerCase(), z.nonce.toLowerCase());
    return existing && paymentIdOf(cfg, payment, existing.subjectHash) === existing.paymentId ? { ok: true, context: { endpoint, payment, resource, contract: true } } : null;
  }

  /** A new smart-contract wallet's payment: simulated on the node of the network it names. `keyProblem` is why it was not a regular key's. */
  async function verifyContract(endpoint: X402Endpoint, payment: PaymentPayload, resource: string, node: Rpc, rail: Rail, keyProblem: string): Promise<Accepted> {
    const z = payment.payload.authorization;
    const context: PayContext = { endpoint, payment, resource, contract: true };
    const refuse = (why: string): Accepted => ({ ok: false, reply: termsReply(cfg, endpoint, resource, why) });
    if (contractBreakerOpen(rail.network)) {
      return { ok: false, reply: unavailable("Payments from smart-contract wallets are paused for a while after several were refused or failed. Use a regular wallet's key, or try again later.", 600) };
    }
    const running = contractChecks.get(rail.network) ?? 0;
    if (!consumeRateLimit(`x402-contract-check:${rail.network}`, MAX_CONTRACT_CHECKS_PER_MINUTE, 60_000).allowed || running >= MAX_CONTRACT_CHECKS_AT_ONCE) {
      return { ok: false, reply: unavailable("Too many wallet checks are being made right now. Try again in a moment.", 5) };
    }
    contractChecks.set(rail.network, running + 1);
    let verdict: Awaited<ReturnType<typeof checkContractSignature>>;
    try {
      verdict = await checkContractSignature(node, {
        chainId: rail.chainId,
        usdc: rail.asset,
        authorization: z,
        signature: payment.payload.signature,
        nowSeconds: nowSeconds(),
        ...(rail.network === BASE_MAINNET ? { maxBehindSeconds: BASE_MAX_BEHIND_SECONDS } : {}),
      });
    } finally {
      contractChecks.set(rail.network, (contractChecks.get(rail.network) ?? 1) - 1);
    }
    if (verdict === null) return { ok: false, reply: unavailable("The wallet's signature cannot be checked on chain right now. Nothing was charged. Try again shortly.", 10) };
    if (verdict.ok) return { ok: true, context };
    // A signature of 65 bytes is a regular key's as much as a contract's (a Safe with one owner signs that way), so it is checked as both. When the chain
    // refuses it, the reason it was not a regular key's is told too, so that the real cause is not lost behind the ERC-1271 sentence.
    const regular = payment.payload.signature.length === 132 ? ` As a regular wallet's key it was refused too: ${keyProblem}.` : "";
    return refuse(`${verdict.why}. A payment from a smart-contract wallet is taken only when its own code accepts it.${regular}`);
  }

  return {
    config: cfg,
    state: async () => ((await ledger.ready()) ? (cfg.pauseNew ? "paused" : "on") : "off"),
    offer: (endpoint, resource, why) => termsReply(cfg, endpoint, resource, why),
    staleCount: async () => {
      if (staleRead && now().getTime() - staleRead.at < STALE_COUNT_MS) return staleRead.value;
      let value: number | null = null;
      try {
        const before = new Date(now().getTime() - STALE_AFTER_MS);
        value = 0;
        for (const network of ledgerNetworks(cfg)) value += await ledger.stale(network, before);
      } catch {
        value = null;
        // The count is for telling the operator: a database that does not answer is told as unknown.
      }
      staleRead = { at: now().getTime(), value };
      return value;
    },
    accept: (endpoint, header, resource) => {
      const seen = inspect(endpoint, header, resource);
      return seen.kind === "ok" ? { ok: true, context: seen.context } : { ok: false, reply: seen.kind === "refused" ? seen.reply : termsReply(cfg, endpoint, resource, seen.keyProblem) };
    },
    verify: async (endpoint, header, resource) => {
      const seen = inspect(endpoint, header, resource);
      if (seen.kind === "ok") return { ok: true, context: seen.context };
      if (seen.kind === "refused") return { ok: false, reply: seen.reply };
      // Not a regular wallet's key's signature. A payment of a smart-contract wallet that is recorded already is resumed whatever the settings are now.
      // A new one is accepted only where a node is set for the network it pays on (Arc's X402_RPC; Base's BASE_RPC_URL once the operator has switched
      // Base's smart wallets on): no other network's node is ever asked.
      const rail = railFor(cfg, seen.payment.accepted.network);
      if (!rail) return { ok: false, reply: termsReply(cfg, endpoint, resource, seen.keyProblem) };
      const recorded = await recordedContract(endpoint, seen.payment, resource, rail).catch(() => null);
      if (recorded) return recorded;
      const node = contractNodes[rail.network];
      if (!node) return { ok: false, reply: termsReply(cfg, endpoint, resource, seen.keyProblem) };
      return verifyContract(endpoint, seen.payment, resource, node, rail, seen.keyProblem);
    },
    charge: (context, subject) => {
      const z = context.payment.payload.authorization;
      const payer = z.from.toLowerCase();
      const nonce = z.nonce.toLowerCase();
      const network = context.payment.accepted.network;
      // A payment that was accepted names a network we take; a context built any other way is sent the terms again.
      if (!railFor(cfg, network)) return Promise.resolve(again(context, "payment terms do not match this resource"));
      const subjectHash = createHash("sha256").update(`${context.endpoint}|${subject}`).digest("hex");
      const run = () =>
        locked(`${network}:${payer}:${nonce}`, async () => {
          const existing = await ledger.find(network, payer, nonce);
          return existing ? resume(context, existing, subjectHash) : start(context, payer, nonce, subjectHash);
        });
      // A smart-contract wallet has one payment going at a time, so two at once cannot both pass the check for another unresolved one.
      return context.contract ? locked(`payer:${payer}`, run) : run();
    },
  };
}

/**
 * The nodes that say what a payer holds, by network: Arc's (X402_RPC, the operator's own) and Base's (BASE_RPC_URL, the provider the Base
 * identity pass uses). A network with no node is not checked, and its payments go to the facilitator as they did before.
 */
export function balanceNodesOf(cfg: X402Config, fetchImpl: typeof fetch = fetch): Record<string, Rpc> {
  const nodes: Record<string, Rpc> = {};
  if (cfg.rpc) nodes[cfg.network] = rpcClient(cfg.rpc, fetchImpl, BALANCE_TIMEOUT_MS);
  if (cfg.baseRpc && railFor(cfg, BASE_MAINNET)) nodes[BASE_MAINNET] = rpcClient(cfg.baseRpc, fetchImpl, BALANCE_TIMEOUT_MS);
  return nodes;
}

/**
 * The service the server runs, from the environment, or null when pay per call is off. A setting that is half there or unsafe keeps it
 * off and says why in the log, and never throws: a mistake in a setting must not stop the site from starting or turn payments on.
 */
export function paymentServiceFromEnv(env: NodeJS.ProcessEnv = process.env, ledger: PaymentLedger = dbPaymentLedger): PaymentService | null {
  try {
    const config = loadX402(env);
    if (!config) return null;
    console.log(`[x402] pay per call is configured for ${railsOf(config).map(rail => rail.network).join(" and ")}${config.pauseNew ? " (paused)" : ""}; it takes payments once the api_payments table exists`);
    if (config.baseProblem) console.error(`[x402] Base is not offered: ${config.baseProblem}`);
    const balanceNodes = balanceNodesOf(config);
    const unchecked = railsOf(config).filter(rail => !balanceNodes[rail.network]);
    if (config.baseSmartWallets) {
      if (!railFor(config, BASE_MAINNET)) console.log("[x402] smart-contract wallets are not taken on Base: Base is not offered");
      else if (!config.baseRpc) console.log("[x402] smart-contract wallets are not taken on Base: BASE_RPC_URL is not set");
      else console.log("[x402] Base takes smart-contract wallets (deployed ones, whose own code accepts the signature)");
    }
    if (unchecked.length > 0) console.log(`[x402] funds are not checked before a payment is sent on, on ${unchecked.map(rail => rail.network).join(" and ")} (no node is set for it)`);
    return createPaymentService({ config, ledger, balanceNodes });
  } catch (error) {
    console.error(`[x402] pay per call is off: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

let shared: PaymentService | null | undefined;

/** The one service the server runs, read from the environment the first time it is asked for. */
export function sharedPaymentService(): PaymentService | null {
  if (shared === undefined) shared = paymentServiceFromEnv();
  return shared;
}
