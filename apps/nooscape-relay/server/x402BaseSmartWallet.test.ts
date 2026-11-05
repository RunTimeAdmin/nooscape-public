import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { indexAnswer } from "./apiV1";
import { llmsText, x402WellKnown } from "./discovery";
import { toChecksumAddress } from "./claimsCrypto";
import { resetRateLimits } from "./rateLimit";
import { ARC_MAINNET, ARC_USDC, BASE_MAINNET, BASE_USDC, loadX402, type PaymentPayload, type X402Config } from "./x402";
import { CDP_FACILITATOR_URL } from "./x402Cdp";
import type { Rpc } from "./x402Chain";
import { CONTRACT_PAUSE_MS, CONTRACT_REFUSED_PAUSE_MS, MAX_CONTRACT_CHECKS_AT_ONCE, MAX_CONTRACT_FAULTS_PER_HOUR, MAX_SENDS_CONTRACT, createPaymentService, paymentServiceFromEnv, type Charge } from "./x402Service";
import { facilitatorAnswers, fakeChain, headerOf, memoryLedger, newBuyer, newCdpKeys, newContractBuyer, newFacilitator, testConfig, TEST_CIRCLE_KEY, TEST_PAY_TO } from "./x402Testing";

/**
 * A smart-contract wallet on Base (docs/x402-base-smart-wallets-2026-11-04.md). Coinbase Wallet, which the Wallet MCP signs with, is one, and
 * Base took regular wallets only until now. It is taken when the operator switches it on (X402_BASE_SMART_WALLETS=1) and a Base node is set
 * (BASE_RPC_URL): the node says whether the wallet's own code (ERC-1271) accepts the signature, as Arc's does, and Coinbase settles it.
 * Every refusal happens before anything is recorded or sent. Every key here is made for the test.
 */
const keys = newCdpKeys();
const BASE_NODE = "https://base-node.example/v1/abc123";
const ARC_NODE = "https://arc-node.example/v1/xyz789";
const on = testConfig({ ...keys.env, BASE_RPC_URL: BASE_NODE, X402_BASE_SMART_WALLETS: "1" });
const off = testConfig({ ...keys.env, BASE_RPC_URL: BASE_NODE });
const noNode = testConfig({ ...keys.env, X402_BASE_SMART_WALLETS: "1" });
const RESOURCE = "https://nooscape.si/api/v1/check";
const CDP_SETTLE = `${CDP_FACILITATOR_URL}/settle`;
const NOW = new Date("2026-11-04T00:00:00Z");

function setup(options: { config?: X402Config; script?: Parameters<typeof newFacilitator>[1]; baseRpc?: Rpc | null; arcRpc?: Rpc; balanceNodes?: Record<string, Rpc> } = {}) {
  const config = options.config ?? on;
  const store = memoryLedger();
  const facilitator = newFacilitator(config, options.script);
  const clock = { ms: Date.now() };
  const now = () => Math.floor(clock.ms / 1000);
  const baseChain = fakeChain({ chainId: 8453, now });
  const arcChain = fakeChain({ chainId: 5042, now });
  const service = createPaymentService({
    config,
    ledger: store.ledger,
    fetchImpl: facilitator.fetchImpl,
    now: () => new Date(clock.ms),
    rpc: options.arcRpc ?? arcChain.rpc,
    baseRpc: options.baseRpc === undefined ? baseChain.rpc : options.baseRpc,
    balanceNodes: options.balanceNodes,
  });
  return { service, store, facilitator, clock, baseChain, arcChain, wallet: newContractBuyer() };
}

const said = (charge: Charge) => (charge.deliver ? "" : JSON.stringify(charge.reply.body));
const statusOf = (charge: Charge) => (charge.deliver ? 200 : charge.reply.status);
const onBase = (wallet: ReturnType<typeof newContractBuyer>, over: Parameters<ReturnType<typeof newContractBuyer>["pay"]>[2] = {}): PaymentPayload => wallet.pay(on, "check", { network: BASE_MAINNET, ...over });

beforeEach(() => {
  resetRateLimits();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("the setting", () => {
  it("is on only when it is exactly 1, and is read with the Base node", () => {
    const base = { X402_NETWORK: ARC_MAINNET, X402_PAY_TO: TEST_PAY_TO, X402_API_KEY: TEST_CIRCLE_KEY, ...keys.env, BASE_RPC_URL: BASE_NODE } as NodeJS.ProcessEnv;
    expect(loadX402(base)!.baseSmartWallets).toBe(false);
    expect(loadX402({ ...base, X402_BASE_SMART_WALLETS: "1" })!.baseSmartWallets).toBe(true);
    for (const other of ["0", "", "yes", "true", "on", " "]) expect(loadX402({ ...base, X402_BASE_SMART_WALLETS: other })!.baseSmartWallets, other).toBe(false);
    expect(loadX402({ ...base, X402_BASE_SMART_WALLETS: " 1 " })!.baseSmartWallets).toBe(true);
  });

  it("shows smart_contract for Base in the index only when it is on and a Base node is set, and leaves Arc's rule alone", () => {
    const wallets = (cfg: X402Config) => Object.fromEntries(indexAnswer(NOW, cfg).pay_per_call!.networks.map(item => [item.network, item.wallets]));
    expect(wallets(off)).toEqual({ [BASE_MAINNET]: ["regular"], [ARC_MAINNET]: ["regular"] });
    expect(wallets(on)).toEqual({ [BASE_MAINNET]: ["regular", "smart_contract"], [ARC_MAINNET]: ["regular"] });
    expect(wallets(noNode)).toEqual({ [BASE_MAINNET]: ["regular"], [ARC_MAINNET]: ["regular"] });
    // The top-level kinds are those of the first network offered, which is Base.
    expect(indexAnswer(NOW, on).pay_per_call!.wallets).toEqual(["regular", "smart_contract"]);
    expect(indexAnswer(NOW, off).pay_per_call!.wallets).toEqual(["regular"]);
    // Arc takes them with its own node, as before, whatever Base is set to.
    const arcNode = testConfig({ ...keys.env, BASE_RPC_URL: BASE_NODE, X402_RPC: "https://rpc.example.org/arc" });
    expect(wallets(arcNode)).toEqual({ [BASE_MAINNET]: ["regular"], [ARC_MAINNET]: ["regular", "smart_contract"] });
  });

  it("is said on the page for a model, per network, and the discovery document does not change with it", () => {
    const line = (cfg: X402Config, network: string, name: string, asset: string, payTo: string, kinds: string) => `Network: ${name} (${network}). Asset: USDC at ${asset}. Pay to: ${payTo}. Wallets: ${kinds}.`;
    const payTo = toChecksumAddress(TEST_PAY_TO);
    const withSwitch = llmsText(indexAnswer(NOW, on));
    expect(withSwitch).toContain(line(on, BASE_MAINNET, "Base", BASE_USDC, payTo, "regular wallets and smart-contract wallets"));
    expect(withSwitch).toContain(line(on, ARC_MAINNET, "Arc mainnet", ARC_USDC, TEST_PAY_TO, "regular wallets"));
    const without = llmsText(indexAnswer(NOW, off));
    expect(without).toContain(line(off, BASE_MAINNET, "Base", BASE_USDC, payTo, "regular wallets"));
    expect(JSON.stringify(x402WellKnown(on, NOW))).toBe(JSON.stringify(x402WellKnown(off, NOW)));
  });

  it("is said in the log: on, on without a node, and set while Base is not offered", () => {
    const env = { X402_NETWORK: ARC_MAINNET, X402_PAY_TO: TEST_PAY_TO, X402_API_KEY: TEST_CIRCLE_KEY } as NodeJS.ProcessEnv;
    const logged = () => vi.mocked(console.log).mock.calls.flat().join(" ") + " " + vi.mocked(console.error).mock.calls.flat().join(" ");
    paymentServiceFromEnv({ ...env, ...keys.env, BASE_RPC_URL: BASE_NODE, X402_BASE_SMART_WALLETS: "1" }, memoryLedger().ledger);
    expect(logged()).toContain("Base takes smart-contract wallets");
    expect(logged()).not.toContain(BASE_NODE);
    vi.mocked(console.log).mockClear();
    vi.mocked(console.error).mockClear();
    paymentServiceFromEnv({ ...env, ...keys.env, X402_BASE_SMART_WALLETS: "1" }, memoryLedger().ledger);
    expect(logged()).toContain("smart-contract wallets are not taken on Base: BASE_RPC_URL is not set");
    vi.mocked(console.log).mockClear();
    vi.mocked(console.error).mockClear();
    paymentServiceFromEnv({ ...env, X402_BASE_SMART_WALLETS: "1" }, memoryLedger().ledger);
    expect(logged()).toContain("smart-contract wallets are not taken on Base: Base is not offered");
    vi.mocked(console.log).mockClear();
    vi.mocked(console.error).mockClear();
    paymentServiceFromEnv({ ...env, ...keys.env, BASE_RPC_URL: BASE_NODE }, memoryLedger().ledger);
    expect(logged()).not.toMatch(/smart-contract wallets/);
  });
});

describe("a smart-contract wallet's payment on Base", () => {
  it("is refused with the old words while the switch is off, and Base's node is never asked, even when one is handed in", async () => {
    const { service, baseChain, wallet } = setup({ config: off });
    const result = await service.verify("check", headerOf(wallet.pay(off, "check", { network: BASE_MAINNET })), RESOURCE);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reply.status).toBe(402);
    expect(!result.ok && JSON.stringify(result.reply.body)).toContain("smart-contract wallets are not accepted yet: sign with a regular wallet's key");
    expect(baseChain.calls).toHaveLength(0);
  });

  it("is refused with the same words when the switch is on and no Base node is set", async () => {
    const { service, baseChain, wallet } = setup({ config: noNode, baseRpc: null });
    const result = await service.verify("check", headerOf(wallet.pay(noNode, "check", { network: BASE_MAINNET })), RESOURCE);
    expect(!result.ok && JSON.stringify(result.reply.body)).toContain("smart-contract wallets are not accepted yet");
    expect(baseChain.calls).toHaveLength(0);
  });

  it("is taken once Base's node says the wallet's own code accepts it, asking Base and no other chain, and settled by Coinbase with the long signature as it was signed", async () => {
    const { service, store, facilitator, baseChain, arcChain, wallet } = setup();
    const payment = onBase(wallet);
    expect(service.accept("check", headerOf(payment), RESOURCE).ok).toBe(false); // accept touches no node
    const result = await service.verify("check", headerOf(payment), RESOURCE);
    if (!result.ok) throw new Error(JSON.stringify(result.reply.body));
    expect(result.context.contract).toBe(true);
    expect(baseChain.calls).toHaveLength(1);
    expect(arcChain.calls).toHaveLength(0);
    // The simulated transfer is Base's USDC, and not Arc's.
    const asked = JSON.stringify(baseChain.calls[0]).toLowerCase();
    expect(asked).toContain(BASE_USDC.slice(2).toLowerCase());
    expect(asked).not.toContain(ARC_USDC.slice(2).toLowerCase());
    const charge = await service.charge(result.context, "s");
    expect(charge.deliver).toBe(true);
    expect(facilitator.calls.map(call => call.url)).toEqual([CDP_SETTLE]);
    expect(facilitator.calls[0]!.body.paymentPayload.payload).toMatchObject({ signature: payment.payload.signature });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ network: BASE_MAINNET, status: "paid", payer: wallet.address, endpoint: "check" });
  });

  it("leaves Arc's rule as it was: a payment on Arc asks Arc's node, and Base's node is not asked", async () => {
    const { service, baseChain, arcChain, wallet } = setup();
    const result = await service.verify("check", headerOf(wallet.pay(on, "check", { network: ARC_MAINNET })), RESOURCE);
    expect(result.ok).toBe(true);
    expect(arcChain.calls).toHaveLength(1);
    expect(baseChain.calls).toHaveLength(0);
  });

  it("is refused before anything is recorded or sent when the chain says no, with the reason in our words", async () => {
    const { service, store, facilitator, baseChain, wallet } = setup();
    const expected: Record<string, RegExp> = { invalid: /ERC-1271/, balance: /balance is below the price/, used: /already used/, expired: /expired/, silent: /would not accept/ };
    for (const [verdict, words] of Object.entries(expected)) {
      baseChain.state.verdict = verdict as never;
      const result = await service.verify("check", headerOf(onBase(wallet)), RESOURCE);
      expect(result.ok, verdict).toBe(false);
      expect(!result.ok && result.reply.status, verdict).toBe(402);
      expect(!result.ok && JSON.stringify(result.reply.body), verdict).toMatch(words);
    }
    expect(store.rows).toHaveLength(0);
    expect(facilitator.calls).toHaveLength(0);
  });

  it("is turned away, not charged and not called wrong, when the node cannot say: down, on another chain (Arc's answer from a Base setting), behind, or not sensible", async () => {
    const { service, store, facilitator, baseChain, wallet } = setup();
    for (const verdict of ["down", "wrongChain", "behind", "garbage"] as const) {
      baseChain.state.verdict = verdict;
      const result = await service.verify("check", headerOf(onBase(wallet)), RESOURCE);
      expect(result.ok, verdict).toBe(false);
      expect(!result.ok && result.reply.status, verdict).toBe(503);
      expect(!result.ok && result.reply.headers["retry-after"], verdict).toBe("10");
      expect(!result.ok && JSON.stringify(result.reply.body), verdict).toMatch(/Nothing was charged/);
    }
    // A node that answers for the wrong chain id is also what Base's setting pointed at Arc's node would give.
    const crossed = setup({ baseRpc: fakeChain({ chainId: 5042 }).rpc });
    const result = await crossed.service.verify("check", headerOf(onBase(crossed.wallet)), RESOURCE);
    expect(!result.ok && result.reply.status).toBe(503);
    expect(store.rows).toHaveLength(0);
    expect(facilitator.calls).toHaveLength(0);
  });

  it("is not asked about its funds by the balance node: the simulation held them", async () => {
    const asked: string[] = [];
    const balance: Rpc = async method => {
      asked.push(method);
      return `0x${"0".repeat(64)}`;
    };
    const { service, wallet } = setup({ balanceNodes: { [BASE_MAINNET]: balance } });
    const result = await service.verify("check", headerOf(onBase(wallet)), RESOURCE);
    if (!result.ok) throw new Error("not accepted");
    expect((await service.charge(result.context, "s")).deliver).toBe(true);
    expect(asked).toEqual([]);
  });

  it("has one payment going at a time on Base, even two sent at once, and a different wallet is not held", async () => {
    const { service, store, facilitator, wallet } = setup({ script: [facilitatorAnswers.pending()] });
    const one = await service.verify("check", headerOf(onBase(wallet)), RESOURCE);
    const two = await service.verify("check", headerOf(onBase(wallet)), RESOURCE);
    if (!one.ok || !two.ok) throw new Error("not accepted");
    const [a, b] = await Promise.all([service.charge(one.context, "s"), service.charge(two.context, "s")]);
    expect([statusOf(a), statusOf(b)].sort()).toEqual([503, 503]);
    expect(facilitator.calls).toHaveLength(1);
    expect(store.rows).toHaveLength(1);
    expect([a, b].map(said).join(" ")).toMatch(/still settling/);
    const other = newContractBuyer(`0x${"c1".repeat(20)}`);
    const three = await service.verify("check", headerOf(onBase(other)), RESOURCE);
    if (!three.ok) throw new Error("not accepted");
    expect((await service.charge(three.context, "s")).deliver).toBe(true);
  });

  it("is paused for a day after a settlement of its failed on Base, and that pause is Base's own: the same wallet may still pay on Arc", async () => {
    const tx = `0x${"d".repeat(64)}`;
    const { service, store, clock, wallet } = setup({ script: [() => Response.json({ success: false, errorReason: "transaction_failed", transaction: tx })] });
    const first = await service.verify("check", headerOf(onBase(wallet)), RESOURCE);
    if (!first.ok) throw new Error("not accepted");
    await service.charge(first.context, "s");
    expect(store.rows[0]).toMatchObject({ network: BASE_MAINNET, status: "open", transaction: tx });
    expect(store.rows[0]!.reason).toMatch(/^failed after broadcast: transaction_failed/);
    await store.ledger.close(store.rows[0]!.id, "closed by the operator: failed on chain");
    const second = await service.verify("check", headerOf(onBase(wallet)), RESOURCE);
    if (!second.ok) throw new Error("not accepted");
    const paused = await service.charge(second.context, "s");
    expect(statusOf(paused)).toBe(503);
    expect(said(paused)).toMatch(/paused for a day/);
    expect(!paused.deliver && paused.reply.headers["retry-after"]).toBe("3600");
    expect(store.rows).toHaveLength(1);
    // On Arc the same address is not paused: it is another network's settlement that failed.
    const arc = await service.verify("check", headerOf(wallet.pay(on, "check", { network: ARC_MAINNET })), RESOURCE);
    if (!arc.ok) throw new Error("not accepted");
    expect((await service.charge(arc.context, "s")).deliver).toBe(true);
    // A day later it may pay on Base again.
    clock.ms += CONTRACT_PAUSE_MS + 60_000;
    const third = await service.verify("check", headerOf(onBase(wallet, { nowSeconds: Math.floor(clock.ms / 1000) })), RESOURCE);
    if (!third.ok) throw new Error("not accepted");
    expect((await service.charge(third.context, "s")).deliver).toBe(true);
  });

  it("is sent to Coinbase at most twice, where a regular wallet's payment is sent three times", async () => {
    const pending = Array.from({ length: 6 }, () => facilitatorAnswers.pending());
    const contract = setup({ script: pending });
    const verified = await contract.service.verify("check", headerOf(onBase(contract.wallet)), RESOURCE);
    if (!verified.ok) throw new Error("not accepted");
    for (let attempt = 1; attempt <= MAX_SENDS_CONTRACT; attempt += 1) expect((await contract.service.charge(verified.context, "s")).deliver).toBe(false);
    expect(contract.facilitator.calls).toHaveLength(MAX_SENDS_CONTRACT);
    expect(said(await contract.service.charge(verified.context, "s"))).toMatch(/could not be confirmed/);
    expect(contract.facilitator.calls).toHaveLength(MAX_SENDS_CONTRACT);
  });

  it("is not asked of the chain again when the same signed payment comes back, and a different signature for it is", async () => {
    const { service, baseChain, wallet } = setup();
    const payment = onBase(wallet);
    const first = await service.verify("check", headerOf(payment), RESOURCE);
    if (!first.ok) throw new Error("not accepted");
    expect((await service.charge(first.context, "s")).deliver).toBe(true);
    baseChain.state.verdict = "used";
    const again = await service.verify("check", headerOf(payment), RESOURCE);
    expect(again.ok).toBe(true);
    expect(baseChain.calls).toHaveLength(1);
    if (!again.ok) throw new Error("not accepted");
    expect((await service.charge(again.context, "s")).deliver).toBe(true);
    const forged = onBase(wallet, { nonce: payment.payload.authorization.nonce });
    expect((await service.verify("check", headerOf(forged), RESOURCE)).ok).toBe(false);
    expect(baseChain.calls).toHaveLength(2);
  });

  it("is still refused for an undeployed wallet's signature (ERC-6492), with words that say what to do, and for junk, and the chain is not asked", async () => {
    const { service, baseChain, wallet } = setup();
    const undeployed = `0x${"11".repeat(100)}${"6492".repeat(16)}`;
    const result = await service.verify("check", headerOf(onBase(wallet, { signature: undeployed })), RESOURCE);
    expect(result.ok).toBe(false);
    const words = !result.ok ? JSON.stringify(result.reply.body) : "";
    expect(words).toContain("not deployed yet (an ERC-6492 signature)");
    expect(words).toContain("send one transaction from it first");
    for (const signature of ["0x", "0xzz", "not hex", `0x${"11".repeat(2049)}`]) {
      expect((await service.verify("check", headerOf(onBase(wallet, { signature })), RESOURCE)).ok, signature.slice(0, 12)).toBe(false);
    }
    expect(baseChain.calls).toHaveLength(0);
  });

  it("is held to our terms before the chain is asked: a wrong amount is refused", async () => {
    const { service, baseChain, wallet } = setup();
    const wrong = onBase(wallet);
    wrong.payload.authorization.value = "1";
    expect((await service.verify("check", headerOf(wrong), RESOURCE)).ok).toBe(false);
    expect(baseChain.calls).toHaveLength(0);
  });

  it("leaves a regular wallet's key exactly as it was: no node is asked for it, with the switch on or off", async () => {
    for (const config of [on, off]) {
      const { service, baseChain, store } = setup({ config });
      const buyer = newBuyer();
      const result = await service.verify("check", headerOf(buyer.pay(config, "check", { network: BASE_MAINNET })), RESOURCE);
      if (!result.ok) throw new Error("not accepted");
      expect(result.context.contract).toBeUndefined();
      expect((await service.charge(result.context, "s")).deliver).toBe(true);
      expect(baseChain.calls).toHaveLength(0);
      expect(store.rows[0]).toMatchObject({ network: BASE_MAINNET, status: "paid" });
    }
  });
});

describe("what the independent review asked for", () => {
  const faulty = (index: number) => newContractBuyer(`0x${(index + 1).toString(16).padStart(40, "0")}`);

  it("resumes a recorded payment, open or paid, when the switch has been turned off since, and still refuses a new one", async () => {
    const store = memoryLedger();
    const facilitator = newFacilitator(on, [facilitatorAnswers.pending()]);
    const make = (config: X402Config) =>
      createPaymentService({ config, ledger: store.ledger, fetchImpl: facilitator.fetchImpl, rpc: fakeChain({ chainId: 5042 }).rpc, baseRpc: fakeChain({ chainId: 8453 }).rpc });
    const wallet = newContractBuyer();
    const payment = onBase(wallet);
    const first = make(on);
    const verified = await first.verify("check", headerOf(payment), RESOURCE);
    if (!verified.ok) throw new Error("not accepted");
    expect((await first.charge(verified.context, "s")).deliver).toBe(false);
    expect(store.rows[0]).toMatchObject({ status: "open", network: BASE_MAINNET });
    // The operator switches Base's smart wallets off. The caller whose answer has not come sends the same payment again: it is resumed, not refused.
    const second = make(off);
    const again = await second.verify("check", headerOf(payment), RESOURCE);
    if (!again.ok) throw new Error(JSON.stringify(again.reply.body));
    expect(again.context.contract).toBe(true);
    expect((await second.charge(again.context, "s")).deliver).toBe(true);
    expect(store.rows[0]).toMatchObject({ status: "paid" });
    expect(facilitator.calls).toHaveLength(2);
    // A paid one is served again from the record while the switch stays off.
    const third = make(off);
    const served = await third.verify("check", headerOf(payment), RESOURCE);
    if (!served.ok) throw new Error("not accepted");
    expect((await third.charge(served.context, "s")).deliver).toBe(true);
    // A new payment of that wallet is refused with the old words.
    const fresh = await make(off).verify("check", headerOf(onBase(wallet)), RESOURCE);
    expect(!fresh.ok && JSON.stringify(fresh.reply.body)).toContain("smart-contract wallets are not accepted yet");
  });

  it("pauses a wallet for a quarter of an hour after Coinbase refuses a payment the chain check passed, on that network only, and records the refusal as such", async () => {
    const { service, store, clock, wallet } = setup({ script: [facilitatorAnswers.refused("invalid_exact_evm_payload_signature")] });
    const first = await service.verify("check", headerOf(onBase(wallet)), RESOURCE);
    if (!first.ok) throw new Error("not accepted");
    expect(said(await service.charge(first.context, "s"))).toMatch(/was refused/);
    expect(store.rows[0]).toMatchObject({ network: BASE_MAINNET, status: "refused", reason: "refused after a passing check: invalid_exact_evm_payload_signature" });
    // The same wallet may not start another now. Nothing is sent and nothing is recorded.
    const second = await service.verify("check", headerOf(onBase(wallet)), RESOURCE);
    if (!second.ok) throw new Error("not accepted");
    const paused = await service.charge(second.context, "s");
    expect(statusOf(paused)).toBe(503);
    expect(said(paused)).toMatch(/paused for a few minutes/);
    expect(!paused.deliver && paused.reply.headers["retry-after"]).toBe("900");
    expect(store.rows).toHaveLength(1);
    // Another wallet is not held, and this wallet is not held on Arc, where nothing of its was refused.
    const other = await service.verify("check", headerOf(onBase(newContractBuyer(`0x${"c1".repeat(20)}`))), RESOURCE);
    if (!other.ok) throw new Error("not accepted");
    expect((await service.charge(other.context, "s")).deliver).toBe(true);
    const arc = await service.verify("check", headerOf(wallet.pay(on, "check", { network: ARC_MAINNET })), RESOURCE);
    if (!arc.ok) throw new Error("not accepted");
    expect((await service.charge(arc.context, "s")).deliver).toBe(true);
    // A quarter of an hour later it may pay on Base again.
    clock.ms += CONTRACT_REFUSED_PAUSE_MS + 60_000;
    const third = await service.verify("check", headerOf(onBase(wallet, { nowSeconds: Math.floor(clock.ms / 1000) })), RESOURCE);
    if (!third.ok) throw new Error("not accepted");
    expect((await service.charge(third.context, "s")).deliver).toBe(true);
  });

  it("records a regular key's refusal as it always was and pauses nothing", async () => {
    const { service, store } = setup({ script: [facilitatorAnswers.refused("invalid_payload")] });
    const buyer = newBuyer();
    const first = await service.verify("check", headerOf(buyer.pay(on, "check", { network: BASE_MAINNET })), RESOURCE);
    if (!first.ok) throw new Error("not accepted");
    expect(said(await service.charge(first.context, "s"))).toMatch(/was refused/);
    expect(store.rows[0]).toMatchObject({ status: "refused", reason: "invalid_payload" });
    const second = await service.verify("check", headerOf(buyer.pay(on, "check", { network: BASE_MAINNET })), RESOURCE);
    if (!second.ok) throw new Error("not accepted");
    expect((await service.charge(second.context, "s")).deliver).toBe(true);
  });

  it("takes no more smart-contract payments on a network after twenty were refused or failed in an hour, tells the operator once, and leaves Arc and regular keys alone", async () => {
    const tx = `0x${"d".repeat(64)}`;
    const script = Array.from({ length: MAX_CONTRACT_FAULTS_PER_HOUR }, (_, index) =>
      index % 2 === 0 ? facilitatorAnswers.refused("invalid_exact_evm_payload_signature") : () => Response.json({ success: false, errorReason: "transaction_failed", transaction: tx })
    );
    const { service, store, clock, baseChain } = setup({ script });
    for (let index = 0; index < MAX_CONTRACT_FAULTS_PER_HOUR; index += 1) {
      const verified = await service.verify("check", headerOf(onBase(faulty(index))), RESOURCE);
      if (!verified.ok) throw new Error(`not accepted at ${index}`);
      await service.charge(verified.context, "s");
    }
    expect(store.rows.filter(row => row.status === "refused")).toHaveLength(MAX_CONTRACT_FAULTS_PER_HOUR / 2);
    expect(store.rows.filter(row => row.status === "open")).toHaveLength(MAX_CONTRACT_FAULTS_PER_HOUR / 2);
    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).toContain(`smart-contract wallets are paused on ${BASE_MAINNET}`);
    expect(logged.match(/are paused on/g)).toHaveLength(1);
    expect(logged).not.toContain(BASE_NODE);
    const asked = baseChain.calls.length;
    const blocked = await service.verify("check", headerOf(onBase(newContractBuyer(`0x${"ee".repeat(20)}`))), RESOURCE);
    expect(!blocked.ok && blocked.reply.status).toBe(503);
    expect(!blocked.ok && JSON.stringify(blocked.reply.body)).toMatch(/paused for a while/);
    expect(baseChain.calls).toHaveLength(asked);
    // Arc is another network, and a regular key on Base is not a smart-contract wallet.
    expect((await service.verify("check", headerOf(newContractBuyer(`0x${"ef".repeat(20)}`).pay(on, "check", { network: ARC_MAINNET })), RESOURCE)).ok).toBe(true);
    expect((await service.verify("check", headerOf(newBuyer().pay(on, "check", { network: BASE_MAINNET })), RESOURCE)).ok).toBe(true);
    // The hour moves on and the network takes them again.
    clock.ms += 60 * 60 * 1000 + 1_000;
    const later = await service.verify("check", headerOf(onBase(newContractBuyer(`0x${"ed".repeat(20)}`), { nowSeconds: Math.floor(clock.ms / 1000) })), RESOURCE);
    expect(later.ok).toBe(true);
  });

  it("tells the local reason too when a 65-byte signature the chain refused was not a regular key's either, and not for a long one", async () => {
    const { service, baseChain } = setup();
    baseChain.state.verdict = "invalid";
    const payment = newBuyer().pay(on, "check", { network: BASE_MAINNET });
    payment.payload.authorization.from = `0x${"ab".repeat(20)}`;
    const short = await service.verify("check", headerOf(payment), RESOURCE);
    const words = !short.ok ? JSON.stringify(short.reply.body) : "";
    expect(words).toContain("ERC-1271");
    expect(words).toContain("As a regular wallet's key it was refused too: the signature is not the payer's");
    const long = await service.verify("check", headerOf(onBase(newContractBuyer())), RESOURCE);
    expect(!long.ok && JSON.stringify(long.reply.body)).not.toContain("As a regular wallet's key");
  });

  it("reaches the node the settings name, BASE_RPC_URL and not Arc's, when no node is handed in", async () => {
    const baseChain = fakeChain({ chainId: 8453 });
    const arcChain = fakeChain({ chainId: 5042 });
    const facilitator = newFacilitator(on);
    const urls: string[] = [];
    const config = testConfig({ ...keys.env, BASE_RPC_URL: BASE_NODE, X402_RPC: ARC_NODE, X402_BASE_SMART_WALLETS: "1" });
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url === BASE_NODE || url === ARC_NODE) {
        urls.push(url);
        const call = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
        return Response.json({ jsonrpc: "2.0", id: 1, result: await (url === BASE_NODE ? baseChain : arcChain).rpc(call.method, call.params) });
      }
      return facilitator.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const service = createPaymentService({ config, ledger: memoryLedger().ledger, fetchImpl });
    const onBaseResult = await service.verify("check", headerOf(onBase(newContractBuyer())), RESOURCE);
    expect(onBaseResult.ok).toBe(true);
    expect(urls).toEqual([BASE_NODE]);
    const onArc = await service.verify("check", headerOf(newContractBuyer(`0x${"c2".repeat(20)}`).pay(config, "check", { network: ARC_MAINNET })), RESOURCE);
    expect(onArc.ok).toBe(true);
    expect(urls).toEqual([BASE_NODE, ARC_NODE]);
  });

  it("holds the wallet checks to sixteen at a time on each network on its own: a slow Base node does not take Arc's places", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => (release = resolve));
    const quick = fakeChain({ chainId: 8453 });
    const slowBase: Rpc = async (method, params) => {
      await gate;
      return quick.rpc(method, params);
    };
    const { service, arcChain } = setup({ baseRpc: slowBase });
    const running = Array.from({ length: MAX_CONTRACT_CHECKS_AT_ONCE }, (_, index) => service.verify("check", headerOf(onBase(faulty(index))), RESOURCE));
    await new Promise(resolve => setTimeout(resolve, 30));
    const over = await service.verify("check", headerOf(onBase(faulty(99))), RESOURCE);
    expect(!over.ok && over.reply.status).toBe(503);
    const arc = await service.verify("check", headerOf(newContractBuyer().pay(on, "check", { network: ARC_MAINNET })), RESOURCE);
    expect(arc.ok).toBe(true);
    expect(arcChain.calls).toHaveLength(1);
    release();
    expect((await Promise.all(running)).filter(result => result.ok)).toHaveLength(MAX_CONTRACT_CHECKS_AT_ONCE);
  });

  it("trusts Base's node to be 15 seconds behind at most, where Arc's may be 60", async () => {
    const behind = (chainId: number, seconds: number) => fakeChain({ chainId, now: () => Math.floor(Date.now() / 1000) - seconds }).rpc;
    const slow = setup({ baseRpc: behind(8453, 30) });
    const tooFar = await slow.service.verify("check", headerOf(onBase(slow.wallet)), RESOURCE);
    expect(!tooFar.ok && tooFar.reply.status).toBe(503);
    const near = setup({ baseRpc: behind(8453, 10) });
    expect((await near.service.verify("check", headerOf(onBase(near.wallet)), RESOURCE)).ok).toBe(true);
    const arc = setup({ arcRpc: behind(5042, 30) });
    expect((await arc.service.verify("check", headerOf(arc.wallet.pay(on, "check", { network: ARC_MAINNET })), RESOURCE)).ok).toBe(true);
  });

  it("does not trust Coinbase's answer to a smart-contract wallet's payment any more than to a key's: pending, then a catch-all refusal on the last send stays open", async () => {
    const { service, store, wallet } = setup({ script: [facilitatorAnswers.pending(), facilitatorAnswers.refused("invalid_payload")] });
    const verified = await service.verify("check", headerOf(onBase(wallet)), RESOURCE);
    if (!verified.ok) throw new Error("not accepted");
    expect((await service.charge(verified.context, "s")).deliver).toBe(false);
    const last = await service.charge(verified.context, "s");
    expect(said(last)).toMatch(/could not be confirmed/);
    expect(store.rows[0]).toMatchObject({ status: "open" });
    expect(store.rows[0]!.reason).toMatch(/^refused on resend: invalid_payload/);
  });
});
