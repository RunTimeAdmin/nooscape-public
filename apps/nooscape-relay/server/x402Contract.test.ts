import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "./rateLimit";
import { loadX402 } from "./x402";
import type { Rpc } from "./x402Chain";
import { CONTRACT_PAUSE_MS, MAX_CONTRACT_CHECKS_AT_ONCE, MAX_CONTRACT_CHECKS_PER_MINUTE, MAX_SENDS, MAX_SENDS_CONTRACT, createPaymentService, type Charge } from "./x402Service";
import { facilitatorAnswers, headerOf, memoryLedger, newBuyer, newContractBuyer, newFacilitator, fakeChain, testConfig, TEST_CIRCLE_KEY, TEST_PAY_TO } from "./x402Testing";

/**
 * Smart-contract wallets (docs/data-access-2026-10-19.md, stage D4b): a payment whose signature is not a regular wallet's key's is taken only
 * when a chain node is set and says the wallet's own code accepts it and the transfer would settle. Every refusal happens before anything is
 * recorded or sent; a wallet has one payment going at a time, is sent to the facilitator at most twice, and is paused for a day after a
 * settlement of its failed after it was broadcast.
 */
const cfg = testConfig();
const RESOURCE = "https://nooscape.si/api/v1/check";

function setup(options: { rpc?: Rpc | null; script?: Parameters<typeof newFacilitator>[1] } = {}) {
  const store = memoryLedger();
  const facilitator = newFacilitator(cfg, options.script);
  const clock = { ms: Date.now() };
  const chain = fakeChain({ now: () => Math.floor(clock.ms / 1000) });
  const service = createPaymentService({ config: cfg, ledger: store.ledger, fetchImpl: facilitator.fetchImpl, now: () => new Date(clock.ms), rpc: options.rpc === undefined ? chain.rpc : options.rpc });
  const wallet = newContractBuyer();
  return { service, store, facilitator, chain, clock, wallet };
}

const said = (charge: Charge) => (charge.deliver ? "" : JSON.stringify(charge.reply.body));
const statusOf = (charge: Charge) => (charge.deliver ? 200 : charge.reply.status);

beforeEach(() => {
  resetRateLimits();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("the setting", () => {
  it("is an https address, optional, never echoed in an error, and shown as a kind of wallet the service takes", () => {
    const base = { X402_NETWORK: "eip155:5042", X402_PAY_TO: TEST_PAY_TO, X402_API_KEY: TEST_CIRCLE_KEY } as NodeJS.ProcessEnv;
    expect(loadX402(base)!.rpc).toBeNull();
    expect(loadX402({ ...base, X402_RPC: "https://node.example/v1/abc123" })!.rpc).toBe("https://node.example/v1/abc123");
    for (const bad of ["http://node.example/x", "node.example", "ftp://node.example", "not a url"]) {
      const failure = (() => {
        try {
          loadX402({ ...base, X402_RPC: bad });
          return null;
        } catch (error) {
          return error as Error;
        }
      })();
      expect(failure?.message, bad).toBe("X402_RPC must be an https address");
    }
  });
});

describe("a smart-contract wallet's payment", () => {
  it("is not taken without a node, with the reason a regular wallet's key was refused, and the chain is not asked", async () => {
    const { service, wallet, chain } = setup({ rpc: null });
    const result = await service.verify("check", headerOf(wallet.pay(cfg, "check")), RESOURCE);
    expect(result.ok).toBe(false);
    expect(!result.ok && JSON.stringify(result.reply.body)).toMatch(/smart-contract wallets are not accepted/);
    expect(chain.calls).toHaveLength(0);
    // accept, which touches no node, says the same.
    expect(service.accept("check", headerOf(wallet.pay(cfg, "check")), RESOURCE).ok).toBe(false);
  });

  it("is taken once the chain says the wallet's own code accepts it, settled like any other, and the long signature goes to the facilitator as it was signed", async () => {
    const { service, store, facilitator, chain, wallet } = setup();
    const payment = wallet.pay(cfg, "check");
    const result = await service.verify("check", headerOf(payment), RESOURCE);
    if (!result.ok) throw new Error(JSON.stringify(result.reply.body));
    expect(result.context.contract).toBe(true);
    expect(chain.calls).toHaveLength(1);
    expect(chain.calls[0]!.method).toBe("eth_call");
    const charge = await service.charge(result.context, "s");
    expect(charge.deliver).toBe(true);
    expect(store.rows[0]).toMatchObject({ status: "paid", payer: wallet.address, endpoint: "check" });
    const sent = JSON.parse(JSON.stringify(facilitator.calls[0]!.body.paymentPayload.payload));
    expect(sent.signature).toBe(payment.payload.signature);
  });

  it("is refused before anything is recorded or sent when the chain says no, with the reason in our words", async () => {
    const { service, store, facilitator, chain, wallet } = setup();
    const expected: Record<string, RegExp> = { invalid: /ERC-1271/, balance: /balance is below the price/, used: /already used/, expired: /expired/, silent: /would not accept/ };
    for (const [verdict, words] of Object.entries(expected)) {
      chain.state.verdict = verdict as never;
      const result = await service.verify("check", headerOf(wallet.pay(cfg, "check")), RESOURCE);
      expect(result.ok, verdict).toBe(false);
      expect(!result.ok && result.reply.status, verdict).toBe(402);
      expect(!result.ok && JSON.stringify(result.reply.body), verdict).toMatch(words);
    }
    expect(store.rows).toHaveLength(0);
    expect(facilitator.calls).toHaveLength(0);
  });

  it("is turned away, without being charged and without being called wrong, when the chain cannot say: a node down, on another chain, behind, or not answering sensibly", async () => {
    const { service, store, facilitator, chain, wallet } = setup();
    for (const verdict of ["down", "wrongChain", "behind", "garbage"] as const) {
      chain.state.verdict = verdict;
      const result = await service.verify("check", headerOf(wallet.pay(cfg, "check")), RESOURCE);
      expect(result.ok, verdict).toBe(false);
      expect(!result.ok && result.reply.status, verdict).toBe(503);
      expect(!result.ok && result.reply.headers["retry-after"], verdict).toBe("10");
      expect(!result.ok && JSON.stringify(result.reply.body), verdict).toMatch(/Nothing was charged/);
    }
    expect(store.rows).toHaveLength(0);
    expect(facilitator.calls).toHaveLength(0);
  });

  it("is not asked of the chain again when the same signed payment comes back (its authorization is spent by then), and a different signature for it is", async () => {
    const { service, chain, wallet } = setup();
    const payment = wallet.pay(cfg, "check");
    const first = await service.verify("check", headerOf(payment), RESOURCE);
    if (!first.ok) throw new Error("not accepted");
    expect((await service.charge(first.context, "s")).deliver).toBe(true);
    expect(chain.calls).toHaveLength(1);
    // The caller whose answer was lost sends it again: served, with no second look at the chain.
    chain.state.verdict = "used";
    const again = await service.verify("check", headerOf(payment), RESOURCE);
    expect(again.ok).toBe(true);
    expect(chain.calls).toHaveLength(1);
    if (!again.ok) throw new Error("not accepted");
    expect((await service.charge(again.context, "s")).deliver).toBe(true);
    // Someone who only knows the wallet and the nonce (both public once it settled) gets nothing: another signature is asked of the chain.
    const forged = wallet.pay(cfg, "check", { nonce: payment.payload.authorization.nonce });
    const refused = await service.verify("check", headerOf(forged), RESOURCE);
    expect(refused.ok).toBe(false);
    expect(chain.calls).toHaveLength(2);
  });

  it("has one payment going at a time: another from the same wallet is told to wait, even two sent at the same moment, and a different wallet is not held", async () => {
    const { service, store, facilitator, wallet } = setup({ script: [facilitatorAnswers.pending()] });
    const one = await service.verify("check", headerOf(wallet.pay(cfg, "check")), RESOURCE);
    const two = await service.verify("check", headerOf(wallet.pay(cfg, "check")), RESOURCE);
    if (!one.ok || !two.ok) throw new Error("not accepted");
    const [a, b] = await Promise.all([service.charge(one.context, "s"), service.charge(two.context, "s")]);
    expect([statusOf(a), statusOf(b)].sort()).toEqual([503, 503]);
    expect(facilitator.calls).toHaveLength(1);
    expect(store.rows).toHaveLength(1);
    expect([a, b].map(said).join(" ")).toMatch(/still settling/);
    const other = newContractBuyer(`0x${"c1".repeat(20)}`);
    const three = await service.verify("check", headerOf(other.pay(cfg, "check")), RESOURCE);
    if (!three.ok) throw new Error("not accepted");
    expect((await service.charge(three.context, "s")).deliver).toBe(true);
  });

  it("is paused for a day after a settlement of its failed after the facilitator broadcast it, and not after one that was only pending", async () => {
    const tx = `0x${"d".repeat(64)}`;
    const { service, store, clock, wallet } = setup({
      script: [() => Response.json({ success: false, errorReason: "transaction_failed", transaction: tx })],
    });
    const first = await service.verify("check", headerOf(wallet.pay(cfg, "check")), RESOURCE);
    if (!first.ok) throw new Error("not accepted");
    await service.charge(first.context, "s");
    expect(store.rows[0]).toMatchObject({ status: "open", transaction: tx });
    expect(store.rows[0]!.reason).toMatch(/^failed after broadcast: transaction_failed/);
    // Set aside by the operator, the wallet is still paused: the settlement failed.
    await store.ledger.close(store.rows[0]!.id, "closed by the operator: failed on chain");
    const second = await service.verify("check", headerOf(wallet.pay(cfg, "check")), RESOURCE);
    if (!second.ok) throw new Error("not accepted");
    const paused = await service.charge(second.context, "s");
    expect(statusOf(paused)).toBe(503);
    expect(said(paused)).toMatch(/paused for a day/);
    expect(!paused.deliver && paused.reply.headers["retry-after"]).toBe("3600");
    expect(store.rows).toHaveLength(1);
    // A day later it may pay again.
    clock.ms += CONTRACT_PAUSE_MS + 60_000;
    const third = await service.verify("check", headerOf(wallet.pay(cfg, "check", { nowSeconds: Math.floor(clock.ms / 1000) })), RESOURCE);
    if (!third.ok) throw new Error("not accepted");
    expect((await service.charge(third.context, "s")).deliver).toBe(true);
  });

  it("is not paused for a settlement the facilitator only called pending", async () => {
    const { service, wallet, store } = setup({ script: [facilitatorAnswers.pending(`0x${"e".repeat(64)}`)] });
    const first = await service.verify("check", headerOf(wallet.pay(cfg, "check")), RESOURCE);
    if (!first.ok) throw new Error("not accepted");
    await service.charge(first.context, "s");
    expect(store.rows[0]!.reason).toBe("settlement_pending");
    expect(await store.ledger.failedFor(cfg.network, wallet.address, new Date(Date.now() - 60_000))).toBe(0);
  });

  it("is sent to the facilitator at most twice, where a regular wallet's payment is sent three times", async () => {
    const pending = Array.from({ length: 6 }, () => facilitatorAnswers.pending());
    const contract = setup({ script: pending });
    const payment = contract.wallet.pay(cfg, "check");
    const verified = await contract.service.verify("check", headerOf(payment), RESOURCE);
    if (!verified.ok) throw new Error("not accepted");
    for (let attempt = 1; attempt <= MAX_SENDS_CONTRACT; attempt += 1) expect((await contract.service.charge(verified.context, "s")).deliver).toBe(false);
    expect(contract.facilitator.calls).toHaveLength(MAX_SENDS_CONTRACT);
    const last = await contract.service.charge(verified.context, "s");
    expect(said(last)).toMatch(/could not be confirmed/);
    expect(contract.facilitator.calls).toHaveLength(MAX_SENDS_CONTRACT);

    const regular = setup({ script: pending });
    const ctx = regular.service.accept("check", headerOf(newBuyer().pay(cfg, "check")), RESOURCE);
    if (!ctx.ok) throw new Error("not accepted");
    for (let attempt = 1; attempt <= MAX_SENDS; attempt += 1) await regular.service.charge(ctx.context, "s");
    expect(regular.facilitator.calls).toHaveLength(MAX_SENDS);
  });
});

describe("the chain checks", () => {
  it("are held to sixteen at a time, and the seventeenth is told to try again, without a record", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => (release = resolve));
    const chain = fakeChain();
    const slow: Rpc = async (method, params) => {
      await gate;
      return chain.rpc(method, params);
    };
    const { service, store, wallet } = setup({ rpc: slow });
    const running = Array.from({ length: MAX_CONTRACT_CHECKS_AT_ONCE + 1 }, () => service.verify("check", headerOf(wallet.pay(cfg, "check")), RESOURCE));
    await vi.waitFor(() => expect(chain.calls.length).toBe(0));
    await new Promise(resolve => setTimeout(resolve, 50));
    release();
    const done = await Promise.all(running);
    expect(done.filter(result => !result.ok && result.reply.status === 503)).toHaveLength(1);
    expect(done.filter(result => result.ok)).toHaveLength(MAX_CONTRACT_CHECKS_AT_ONCE);
    expect(store.rows).toHaveLength(0);
  });

  it("are held to a number a minute from everyone", async () => {
    const { service, wallet, chain } = setup();
    for (let index = 0; index < MAX_CONTRACT_CHECKS_PER_MINUTE; index += 1) expect((await service.verify("check", headerOf(wallet.pay(cfg, "check")), RESOURCE)).ok, `check ${index + 1}`).toBe(true);
    const over = await service.verify("check", headerOf(wallet.pay(cfg, "check")), RESOURCE);
    expect(!over.ok && over.reply.status).toBe(503);
    expect(chain.calls).toHaveLength(MAX_CONTRACT_CHECKS_PER_MINUTE);
  }, 60_000);

  it("are not made for what a regular wallet's own key signed, or for a signature that cannot be one: junk, too long, or an undeployed wallet's", async () => {
    const { service, chain } = setup();
    const regular = newBuyer();
    expect((await service.verify("check", headerOf(regular.pay(cfg, "check")), RESOURCE)).ok).toBe(true);
    const wallet = newContractBuyer();
    for (const signature of ["0x", "0xzz", "not hex", `0x${"11".repeat(2049)}`, `0x${"11".repeat(100)}${"6492".repeat(16)}`]) {
      const result = await service.verify("check", headerOf(wallet.pay(cfg, "check", { signature })), RESOURCE);
      expect(result.ok, signature.slice(0, 12)).toBe(false);
      expect(!result.ok && result.reply.status).toBe(402);
    }
    expect(chain.calls).toHaveLength(0);
  });
});

describe("the other terms still hold for a smart-contract wallet", () => {
  it("is refused for a price, a payee or a network that is not ours before the chain is asked", async () => {
    const { service, chain, wallet } = setup();
    const wrong = wallet.pay(cfg, "check");
    wrong.payload.authorization.value = "1";
    const result = await service.verify("check", headerOf(wrong), RESOURCE);
    expect(result.ok).toBe(false);
    expect(chain.calls).toHaveLength(0);
    expect(TEST_CIRCLE_KEY).toBeTruthy();
  });
});
