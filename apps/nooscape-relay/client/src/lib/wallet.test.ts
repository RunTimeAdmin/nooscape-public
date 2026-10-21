import { describe, expect, it, vi } from "vitest";
import { discoverWallets, requestAddress, signMessage, utf8Hex, walletErrorMessage, WALLET_METHODS, type Eip1193Provider, type WalletWindow } from "./wallet";

/**
 * The browser wallet, as "Claim this agent" uses it: discovery, one account, one signature, and nothing else, against a fake window and
 * fake providers.
 */
const ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";

function provider(handler: (args: { method: string; params?: unknown[] }) => unknown): Eip1193Provider & { calls: Array<{ method: string; params?: unknown[] }> } {
  const calls: Array<{ method: string; params?: unknown[] }> = [];
  return {
    calls,
    request: async args => {
      calls.push(args);
      return handler(args);
    },
  };
}

class FakeWindow extends EventTarget implements WalletWindow {
  ethereum?: unknown;
  /** Wallets that answer when asked, as EIP-6963 wallets do. */
  announcers: Array<{ uuid: string; name: string; provider: Eip1193Provider }> = [];
  constructor() {
    super();
    this.addEventListener("eip6963:requestProvider", () => {
      for (const wallet of this.announcers) this.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: wallet.uuid, name: wallet.name }, provider: wallet.provider } }));
    });
  }
}

describe("finding wallets", () => {
  it("lists the wallets that announce themselves, by name, once each", async () => {
    const win = new FakeWindow();
    const a = provider(() => []);
    const b = provider(() => []);
    win.announcers = [
      { uuid: "uuid-a", name: "Wallet A", provider: a },
      { uuid: "uuid-b", name: "  Wallet B  ", provider: b },
      { uuid: "uuid-a", name: "Wallet A again", provider: a },
    ];
    const found = await discoverWallets(win, 5);
    expect(found.map(wallet => [wallet.id, wallet.name])).toEqual([["uuid-a", "Wallet A"], ["uuid-b", "Wallet B"]]);
    expect(found[0]!.provider).toBe(a);
  });

  it("falls back to the older window.ethereum when nothing announces, and finds nothing when there is nothing", async () => {
    const win = new FakeWindow();
    expect(await discoverWallets(win, 5)).toEqual([]);
    const old = provider(() => []);
    win.ethereum = old;
    expect(await discoverWallets(win, 5)).toEqual([{ id: "window.ethereum", name: "Browser wallet", provider: old }]);
    // Something on window.ethereum that is not a provider is not a wallet.
    win.ethereum = { isMetaMask: true };
    expect(await discoverWallets(win, 5)).toEqual([]);
  });

  it("ignores an announcement that carries no provider, names a wallet with no name, and stops listening afterwards", async () => {
    const win = new FakeWindow();
    const good = provider(() => []);
    win.addEventListener("eip6963:requestProvider", () => {
      win.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "bad" }, provider: {} } }));
      win.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: {}, provider: good } }));
    });
    const found = await discoverWallets(win, 5);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: "wallet-1", name: "Browser wallet" });
    win.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "late", name: "Late" }, provider: good } }));
    expect(found).toHaveLength(1);
  });

  it("does nothing a visitor did not ask for: a window is only listened to and asked to announce", async () => {
    const win = new FakeWindow();
    const wallet = provider(() => []);
    win.announcers = [{ uuid: "u", name: "W", provider: wallet }];
    await discoverWallets(win, 5);
    expect(wallet.calls).toEqual([]);
  });
});

describe("asking a wallet", () => {
  it("asks for accounts and takes the first, as an address", async () => {
    const wallet = provider(() => [ADDRESS, "0x" + "1".repeat(40)]);
    expect(await requestAddress(wallet)).toBe(ADDRESS);
    expect(wallet.calls).toEqual([{ method: "eth_requestAccounts", params: [] }]);
  });

  it("refuses an answer that is not an account", async () => {
    for (const answer of [[], null, "0x1234", [7], ["not an address"]]) {
      await expect(requestAddress(provider(() => answer)), JSON.stringify(answer)).rejects.toThrow(/did not share an account/);
    }
  });

  it("asks for a signature with the message as the hex of its UTF-8 bytes and the account, and returns it", async () => {
    const signature = `0x${"ab".repeat(65)}`;
    const wallet = provider(() => signature);
    expect(await signMessage(wallet, "nooscape.si wants you\né", ADDRESS)).toBe(signature);
    expect(wallet.calls).toEqual([{ method: "personal_sign", params: [utf8Hex("nooscape.si wants you\né"), ADDRESS] }]);
    expect(utf8Hex("aé")).toBe("0x61c3a9");
    expect(utf8Hex("")).toBe("0x");
  });

  it("refuses a signature that is not hex, and an account that is not an address, before asking", async () => {
    await expect(signMessage(provider(() => "not hex"), "m", ADDRESS)).rejects.toThrow(/did not return a signature/);
    await expect(signMessage(provider(() => null), "m", ADDRESS)).rejects.toThrow(/did not return a signature/);
    const never = provider(() => "0x00");
    await expect(signMessage(never, "m", "0x1234")).rejects.toThrow(/not an account/);
    expect(never.calls).toEqual([]);
  });

  it("only ever asks for the two things on its list", () => {
    expect([...WALLET_METHODS]).toEqual(["eth_requestAccounts", "personal_sign"]);
  });
});

describe("what a visitor is told when a wallet refuses", () => {
  it("is plain words: declined, a request already open, or could not, and never the wallet's own text", () => {
    expect(walletErrorMessage({ code: 4001, message: "User rejected the request." })).toBe("You declined in your wallet. Nothing was signed.");
    expect(walletErrorMessage({ code: "ACTION_REJECTED" })).toBe("You declined in your wallet. Nothing was signed.");
    expect(walletErrorMessage({ code: -32002, message: "Request of type 'wallet_requestPermissions' already pending" })).toBe("Your wallet already has a request open. Open it and answer it.");
    expect(walletErrorMessage(new Error("something about https://secret.example/key"))).toBe("Your wallet could not do that. Nothing was signed.");
    expect(walletErrorMessage("x")).toBe("Your wallet could not do that. Nothing was signed.");
    expect(walletErrorMessage(new Error("The wallet did not share an account."))).toBe("The wallet did not share an account.");
  });
});

describe("the log", () => {
  it("is quiet: nothing is written to the console while a wallet is found and asked", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map(method => vi.spyOn(console, method).mockImplementation(() => {}));
    try {
      const win = new FakeWindow();
      win.announcers = [{ uuid: "u", name: "W", provider: provider(() => [ADDRESS]) }];
      const [wallet] = await discoverWallets(win, 5);
      await requestAddress(wallet!.provider);
    } finally {
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
      }
    }
  });
});
