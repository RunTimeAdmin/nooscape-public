import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeRateLimit, resetRateLimits } from "./rateLimit";
import { ARC_MAINNET, ARC_USDC, BASE_MAINNET, BASE_USDC, type PaymentPayload, type X402Config } from "./x402";
import { usdcBalance, type Rpc } from "./x402Chain";
import {
  BALANCE_TIMEOUT_MS,
  MAX_BALANCE_CHECKS_AT_ONCE,
  MAX_BALANCE_CHECKS_PER_MINUTE,
  MAX_NEW_PER_MINUTE,
  MAX_NEW_PER_PAYER_PER_MINUTE,
  balanceNodesOf,
  createPaymentService,
  paymentServiceFromEnv,
  type Charge,
  type PayContext,
} from "./x402Service";
import { headerOf, memoryLedger, newBuyer, newCdpKeys, newFacilitator, testConfig, TEST_PAY_TO } from "./x402Testing";

/**
 * Whether a payer holds the price, and how fast one wallet may start payments (docs/x402-base-bazaar-2026-10-21.md, "Funds and pace"). A
 * signed authorization costs its maker nothing, so an empty wallet can sign as many as it likes; each one that reached a facilitator took a
 * place in the shared budget of 300 a minute and a row in the ledger. These cases hold the check to what it is for: turn an empty wallet
 * away before anything is recorded or sent on, never refuse on a guess, and never touch a payment that is already recorded.
 */
const RESOURCE = "https://nooscape.si/api/v1/check";
const PRICE = 10_000n;
const keys = newCdpKeys();
const both = testConfig(keys.env);

/** A node that answers balanceOf from a table, and remembers what it was asked. */
function balanceNode(balances: Map<string, bigint> = new Map(), answer?: (holder: string) => Promise<unknown>) {
  const asked: Array<{ method: string; to: string; holder: string; block: unknown }> = [];
  const rpc: Rpc = async (method, params) => {
    const call = params[0] as { to: string; data: string };
    const holder = `0x${call.data.slice(34)}`;
    asked.push({ method, to: call.to, holder, block: params[1] });
    if (answer) return answer(holder);
    return `0x${(balances.get(holder) ?? 0n).toString(16).padStart(64, "0")}`;
  };
  return { rpc, asked, balances };
}

function setup(over: { config?: X402Config; nodes?: Record<string, Rpc> } = {}) {
  const config = over.config ?? both;
  const store = memoryLedger();
  const facilitator = newFacilitator(config);
  const service = createPaymentService({ config, ledger: store.ledger, fetchImpl: facilitator.fetchImpl, balanceNodes: over.nodes });
  const context = (buyer = newBuyer(), network = BASE_MAINNET, endpoint: "check" | "agent" = "check"): PayContext & { buyer: ReturnType<typeof newBuyer>; payment: PaymentPayload } => {
    const payment = buyer.pay(config, endpoint, { network });
    const accepted = service.accept(endpoint, headerOf(payment), RESOURCE);
    if (!accepted.ok) throw new Error(`not accepted: ${JSON.stringify(accepted.reply.body)}`);
    return { ...accepted.context, buyer, payment };
  };
  return { service, store, facilitator, context };
}

const said = (charge: Charge) => (charge.deliver ? "" : JSON.stringify(charge.reply.body));
const statusOf = (charge: Charge) => (charge.deliver ? 200 : charge.reply.status);
const holderOf = (buyer: ReturnType<typeof newBuyer>) => buyer.address.toLowerCase();

beforeEach(() => {
  resetRateLimits();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("reading a wallet's USDC balance with one plain eth_call", () => {
  const holder = "0x4dd214917d962fb402d65c90efba912443358bdf";

  it("asks the token's balanceOf for the wallet at the latest block, and reads the number the node answers", async () => {
    const node = balanceNode(new Map([[holder, 123_456n]]));
    expect(await usdcBalance(node.rpc, BASE_USDC, holder.toUpperCase().replace("0X", "0x"))).toBe(123_456n);
    expect(node.asked).toEqual([{ method: "eth_call", to: BASE_USDC, holder, block: "latest" }]);
  });

  it("sends the selector of balanceOf(address) and the address padded to one word, and nothing else", async () => {
    let sent: unknown;
    await usdcBalance(async (_method, params) => {
      sent = params[0];
      return `0x${"0".repeat(64)}`;
    }, BASE_USDC, holder);
    expect(sent).toEqual({ to: BASE_USDC, data: `0x70a08231${"0".repeat(24)}${holder.slice(2)}` });
  });

  it("holds a balance larger than a double can, exactly", async () => {
    const big = (1n << 255n) + 12_345n;
    expect(await usdcBalance(balanceNode(new Map([[holder, big]])).rpc, BASE_USDC, holder)).toBe(big);
  });

  it("says nothing (null) when the node fails or gives an answer that is not one 32-byte number, and when the address is not an address", async () => {
    const answers: unknown[] = ["0x", `0x${"0".repeat(62)}`, `0x${"0".repeat(66)}`, `0x${"g".repeat(64)}`, "12", 5, null, { result: 1 }];
    for (const answer of answers) expect(await usdcBalance(async () => answer, BASE_USDC, holder), JSON.stringify(answer)).toBeNull();
    expect(await usdcBalance(async () => Promise.reject(new Error("the node did not answer")), BASE_USDC, holder)).toBeNull();
    expect(await usdcBalance(balanceNode().rpc, BASE_USDC, "0x1234")).toBeNull();
    expect(await usdcBalance(balanceNode().rpc, "not an address", holder)).toBeNull();
  });
});

describe("a new payment from a wallet that holds less than the price", () => {
  it("is turned away with a 402 and its reason, with nothing recorded and nothing sent to the facilitator", async () => {
    const node = balanceNode();
    const { service, store, facilitator, context } = setup({ nodes: { [BASE_MAINNET]: node.rpc } });
    for (const held of [0n, PRICE - 1n]) {
      const empty = context();
      node.balances.set(holderOf(empty.buyer), held);
      const charge = await service.charge(empty, "s");
      expect(statusOf(charge), String(held)).toBe(402);
      expect(said(charge)).toContain("This wallet holds less USDC than the price. Nothing was charged.");
      expect(!charge.deliver && charge.reply.headers["payment-required"]).toBeTruthy();
    }
    expect(store.rows).toHaveLength(0);
    expect(facilitator.calls).toHaveLength(0);
  });

  it("does not take a place in the shared budget of 300 a minute, so a flood of empty wallets cannot starve a paying one", async () => {
    const node = balanceNode();
    const { service, store, context } = setup({ nodes: { [BASE_MAINNET]: node.rpc } });
    for (let index = 0; index < MAX_NEW_PER_MINUTE + 50; index += 1) expect(statusOf(await service.charge(context(), "s"))).toBe(402);
    const payer = context();
    node.balances.set(holderOf(payer.buyer), PRICE);
    const paid = await service.charge(payer, "s");
    expect(paid.deliver).toBe(true);
    expect(store.rows).toHaveLength(1);
  });

  it("is asked of the network the payment names: Base's USDC for Base and Arc's for Arc, each with its own node", async () => {
    const baseNode = balanceNode();
    const arcNode = balanceNode();
    const { service, context } = setup({ nodes: { [BASE_MAINNET]: baseNode.rpc, [ARC_MAINNET]: arcNode.rpc } });
    await service.charge(context(newBuyer(), BASE_MAINNET), "s");
    await service.charge(context(newBuyer(), ARC_MAINNET), "s");
    expect(baseNode.asked.map(call => call.to)).toEqual([BASE_USDC]);
    expect(arcNode.asked.map(call => call.to)).toEqual([ARC_USDC]);
  });

  it("is refused on Arc too, where a node is set for it, and is sent on as it was where none is", async () => {
    const node = balanceNode();
    const checked = setup({ nodes: { [ARC_MAINNET]: node.rpc } });
    expect(statusOf(await checked.service.charge(checked.context(newBuyer(), ARC_MAINNET), "s"))).toBe(402);
    expect(checked.facilitator.calls).toHaveLength(0);
    const unchecked = setup({ nodes: { [BASE_MAINNET]: node.rpc } });
    expect((await unchecked.service.charge(unchecked.context(newBuyer(), ARC_MAINNET), "s")).deliver).toBe(true);
    expect(unchecked.facilitator.calls).toHaveLength(1);
  });
});

describe("a new payment from a wallet that holds the price", () => {
  it("is settled once, as it was, after one question to the node", async () => {
    const node = balanceNode();
    const { service, store, facilitator, context } = setup({ nodes: { [BASE_MAINNET]: node.rpc } });
    const payer = context();
    node.balances.set(holderOf(payer.buyer), PRICE);
    const charge = await service.charge(payer, "s");
    expect(charge.deliver).toBe(true);
    expect(node.asked).toEqual([{ method: "eth_call", to: BASE_USDC, holder: holderOf(payer.buyer), block: "latest" }]);
    expect(facilitator.calls).toHaveLength(1);
    expect(store.rows).toMatchObject([{ network: BASE_MAINNET, status: "paid", payer: holderOf(payer.buyer) }]);
  });

  it("is sent on when the node cannot say: a failure, a number that is not one, a node that is down", async () => {
    const answers: Array<(holder: string) => Promise<unknown>> = [
      async () => {
        throw new Error("the node did not answer");
      },
      async () => "0x",
      async () => ({ not: "a number" }),
    ];
    for (const answer of answers) {
      const node = balanceNode(new Map(), answer);
      const { service, facilitator, context } = setup({ nodes: { [BASE_MAINNET]: node.rpc } });
      expect((await service.charge(context(), "s")).deliver).toBe(true);
      expect(node.asked).toHaveLength(1);
      expect(facilitator.calls).toHaveLength(1);
    }
  });

  it("is not asked of the node again once it is recorded: a caller whose answer was lost is served, even if the wallet is empty by then", async () => {
    const node = balanceNode();
    const { service, store, facilitator, context } = setup({ nodes: { [BASE_MAINNET]: node.rpc } });
    const payer = context();
    node.balances.set(holderOf(payer.buyer), PRICE);
    expect((await service.charge(payer, "s")).deliver).toBe(true);
    node.balances.set(holderOf(payer.buyer), 0n);
    const again = await service.charge(payer, "s");
    expect(again.deliver).toBe(true);
    expect(node.asked).toHaveLength(1);
    expect(facilitator.calls).toHaveLength(1);
    expect(store.rows).toHaveLength(1);
  });

  it("is not asked of the node when the wallet is a smart-contract wallet: the chain's simulation already held its funds", async () => {
    const node = balanceNode();
    const { service, context } = setup({ config: testConfig(), nodes: { [ARC_MAINNET]: node.rpc } });
    const contract = { ...context(newBuyer(), ARC_MAINNET), contract: true };
    expect((await service.charge(contract, "s")).deliver).toBe(true);
    expect(node.asked).toHaveLength(0);
  });
});

describe("how many checks are made", () => {
  it("skips the check, and lets the facilitator decide, once the minute's budget of checks is spent", async () => {
    const node = balanceNode();
    const { service, facilitator, context } = setup({ nodes: { [BASE_MAINNET]: node.rpc } });
    for (let index = 0; index < MAX_BALANCE_CHECKS_PER_MINUTE; index += 1) consumeRateLimit("x402-balance", MAX_BALANCE_CHECKS_PER_MINUTE, 60_000);
    expect((await service.charge(context(), "s")).deliver).toBe(true);
    expect(node.asked).toHaveLength(0);
    expect(facilitator.calls).toHaveLength(1);
  });

  it("skips the check, and lets the facilitator decide, when too many are waiting on the node at once, and never lets the count leak", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const node = balanceNode(new Map(), async () => {
      await gate;
      return `0x${PRICE.toString(16).padStart(64, "0")}`;
    });
    const { service, context } = setup({ nodes: { [BASE_MAINNET]: node.rpc } });
    const waiting = Array.from({ length: MAX_BALANCE_CHECKS_AT_ONCE + 5 }, () => service.charge(context(), "s"));
    await vi.waitFor(() => expect(node.asked).toHaveLength(MAX_BALANCE_CHECKS_AT_ONCE));
    release();
    await Promise.all(waiting);
    expect(node.asked).toHaveLength(MAX_BALANCE_CHECKS_AT_ONCE);
    const later = await service.charge(context(), "s");
    expect(later.deliver || statusOf(later) === 503).toBe(true);
    expect(node.asked.length).toBeGreaterThan(MAX_BALANCE_CHECKS_AT_ONCE);
  });

  it("gives a node a short time to answer, so a slow one is skipped and not waited for", () => {
    expect(BALANCE_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});

describe("how fast one wallet may start payments", () => {
  it("is held to a number a minute once it is known to hold the price, with the words and a time to wait, and nothing recorded for the rest", async () => {
    const node = balanceNode();
    const { service, store, context } = setup({ nodes: { [BASE_MAINNET]: node.rpc } });
    const buyer = newBuyer();
    node.balances.set(holderOf(buyer), PRICE * 1000n);
    for (let index = 0; index < MAX_NEW_PER_PAYER_PER_MINUTE; index += 1) expect((await service.charge(context(buyer), "s")).deliver, `payment ${index + 1}`).toBe(true);
    const over = await service.charge(context(buyer), "s");
    expect(statusOf(over)).toBe(503);
    expect(said(over)).toContain("Too many payments from this wallet in the last minute.");
    expect(!over.deliver && over.reply.headers["retry-after"]).toBe("15");
    expect(store.rows).toHaveLength(MAX_NEW_PER_PAYER_PER_MINUTE);
    const other = newBuyer();
    node.balances.set(holderOf(other), PRICE);
    expect((await service.charge(context(other), "s")).deliver).toBe(true);
  }, 60_000);

  it("never refuses a payment that is already recorded, however many that wallet has started", async () => {
    const node = balanceNode();
    const { service, context } = setup({ nodes: { [BASE_MAINNET]: node.rpc } });
    const buyer = newBuyer();
    node.balances.set(holderOf(buyer), PRICE * 1000n);
    const first = context(buyer);
    expect((await service.charge(first, "s")).deliver).toBe(true);
    for (let index = 1; index < MAX_NEW_PER_PAYER_PER_MINUTE; index += 1) await service.charge(context(buyer), "s");
    expect(statusOf(await service.charge(context(buyer), "s"))).toBe(503);
    expect((await service.charge(first, "s")).deliver).toBe(true);
  }, 60_000);

  it("counts only a wallet that holds the price, so empty wallets that repeat never meet the limit and then pay when they are funded", async () => {
    const node = balanceNode();
    const { service, context } = setup({ nodes: { [BASE_MAINNET]: node.rpc } });
    const buyer = newBuyer();
    for (let index = 0; index < MAX_NEW_PER_PAYER_PER_MINUTE + 20; index += 1) expect(statusOf(await service.charge(context(buyer), "s"))).toBe(402);
    node.balances.set(holderOf(buyer), PRICE);
    expect((await service.charge(context(buyer), "s")).deliver).toBe(true);
  }, 60_000);

  it("holds the same wallet on Base and on Arc to a count each", async () => {
    const baseNode = balanceNode();
    const arcNode = balanceNode();
    const { service, context } = setup({ nodes: { [BASE_MAINNET]: baseNode.rpc, [ARC_MAINNET]: arcNode.rpc } });
    const buyer = newBuyer();
    baseNode.balances.set(holderOf(buyer), PRICE * 1000n);
    arcNode.balances.set(holderOf(buyer), PRICE * 1000n);
    for (let index = 0; index < MAX_NEW_PER_PAYER_PER_MINUTE; index += 1) await service.charge(context(buyer, BASE_MAINNET), "s");
    expect(statusOf(await service.charge(context(buyer, BASE_MAINNET), "s"))).toBe(503);
    expect((await service.charge(context(buyer, ARC_MAINNET), "s")).deliver).toBe(true);
  }, 60_000);
});

describe("which networks are checked, and the setting", () => {
  const withNodes = (extra: Record<string, string>, base = true) => testConfig({ ...(base ? keys.env : {}), ...extra });

  it("takes Arc's node from X402_RPC and Base's from BASE_RPC_URL, and checks a network only if it has one", () => {
    const nodes = balanceNodesOf(withNodes({ X402_RPC: "https://arc.example/secret-path", BASE_RPC_URL: "https://base.example/v2/secret-key" }));
    expect(Object.keys(nodes).sort()).toEqual([ARC_MAINNET, BASE_MAINNET].sort());
    expect(Object.keys(balanceNodesOf(withNodes({ BASE_RPC_URL: "https://base.example/v2/secret-key" })))).toEqual([BASE_MAINNET]);
    expect(Object.keys(balanceNodesOf(withNodes({ X402_RPC: "https://arc.example/secret-path" })))).toEqual([ARC_MAINNET]);
    expect(balanceNodesOf(withNodes({}))).toEqual({});
  });

  it("does not check Base where Base is not offered, whatever BASE_RPC_URL holds", () => {
    expect(balanceNodesOf(withNodes({ BASE_RPC_URL: "https://base.example/v2/secret-key" }, false))).toEqual({});
  });

  it("reads only an https address, and a mistake in it leaves Base unchecked and stops nothing", () => {
    for (const bad of ["", "   ", "http://base.example/key", "base.example", "not an address", "ftp://base.example"]) {
      expect(withNodes({ BASE_RPC_URL: bad }).baseRpc, JSON.stringify(bad)).toBeNull();
    }
    expect(withNodes({ BASE_RPC_URL: " https://base.example/v2/key " }).baseRpc).toBe("https://base.example/v2/key");
    expect(withNodes({}).baseRpc).toBeNull();
  });

  it("says at start which networks are not checked, never says where a node is, and still starts", () => {
    const env = { X402_NETWORK: ARC_MAINNET, X402_PAY_TO: TEST_PAY_TO, X402_API_KEY: testConfig().apiKey, ...keys.env, BASE_RPC_URL: "https://base.example/v2/secret-key-12345" };
    expect(paymentServiceFromEnv(env, memoryLedger().ledger)).not.toBeNull();
    const logged = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(logged).toContain(`not checked before a payment is sent on, on ${ARC_MAINNET} (no node is set for it)`);
    expect(logged).not.toContain(BASE_MAINNET + " (no node");
    expect(logged).not.toContain("secret-key-12345");
    expect(logged).not.toContain("base.example");
  });
});
