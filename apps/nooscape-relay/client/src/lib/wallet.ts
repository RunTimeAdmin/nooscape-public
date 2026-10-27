/**
 * The browser wallet, as far as "Claim this agent" uses it (docs/claims-2026-10-18.md): find the wallets in the page (EIP-6963, then
 * the older `window.ethereum`), ask one for its account, and ask it to sign one message with `personal_sign`. That is all.
 *
 * It asks for no transaction, no gas, no approval and no network change, and it cannot: every request goes through `ask`, which
 * refuses any method that is not on a list of two. It stores nothing in the browser. It reads no balance and no other account. It does
 * nothing until a visitor presses a button, so a page that never offers a claim never touches a wallet.
 *
 * Pure of the page: it takes the window it is given, so it is tested with a fake one.
 */

/** The two things this code ever asks a wallet. A test fails if the client names any other wallet method. */
export const WALLET_METHODS = ["eth_requestAccounts", "personal_sign"] as const;
type WalletMethod = (typeof WALLET_METHODS)[number];

/** The part of an EIP-1193 provider this code uses. */
export type Eip1193Provider = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

export type WalletInfo = { id: string; name: string; provider: Eip1193Provider };

/** The part of the window this code uses: events, and the older single provider. */
export type WalletWindow = EventTarget & { ethereum?: unknown };

const isProvider = (value: unknown): value is Eip1193Provider => typeof value === "object" && value !== null && typeof (value as { request?: unknown }).request === "function";

/** How long to wait for wallets to announce themselves. They answer at once; the wait is for a slow extension. */
const DISCOVERY_WAIT_MS = 300;

/**
 * The wallets in this page. A wallet that follows EIP-6963 announces itself when asked, with a name; a page with only the older
 * `window.ethereum` gets one entry for it. Duplicates (the same wallet announcing twice) are dropped by their id.
 */
export function discoverWallets(win: WalletWindow, waitMs: number = DISCOVERY_WAIT_MS): Promise<WalletInfo[]> {
  return new Promise(resolve => {
    const found = new Map<string, WalletInfo>();
    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<{ info?: { uuid?: unknown; name?: unknown }; provider?: unknown }>).detail;
      if (!detail || !isProvider(detail.provider)) return;
      const id = typeof detail.info?.uuid === "string" && detail.info.uuid.length > 0 ? detail.info.uuid : `wallet-${found.size + 1}`;
      const name = typeof detail.info?.name === "string" && detail.info.name.trim().length > 0 ? detail.info.name.trim().slice(0, 40) : "Browser wallet";
      if (!found.has(id)) found.set(id, { id, name, provider: detail.provider });
    };
    win.addEventListener("eip6963:announceProvider", onAnnounce);
    win.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      win.removeEventListener("eip6963:announceProvider", onAnnounce);
      if (found.size === 0 && isProvider(win.ethereum)) found.set("window.ethereum", { id: "window.ethereum", name: "Browser wallet", provider: win.ethereum });
      resolve(Array.from(found.values()));
    }, waitMs);
  });
}

/** The only door to a wallet: a method that is not on the list of two is refused before it is sent. */
async function ask(provider: Eip1193Provider, method: WalletMethod, params: unknown[]): Promise<unknown> {
  if (!(WALLET_METHODS as readonly string[]).includes(method)) throw new Error("This code does not ask a wallet for that.");
  return provider.request({ method, params });
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The account the wallet shares when the visitor allows it: the first one, as an address. */
export async function requestAddress(provider: Eip1193Provider): Promise<string> {
  const accounts = await ask(provider, "eth_requestAccounts", []);
  const first = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof first !== "string" || !ADDRESS.test(first)) throw new Error("The wallet did not share an account.");
  return first;
}

/** The text as the 0x hex of its UTF-8 bytes, the form `personal_sign` takes everywhere. */
export function utf8Hex(text: string): string {
  return `0x${Array.from(new TextEncoder().encode(text), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Asks the wallet to sign the message with the account. The wallet shows the whole message and the visitor decides. */
export async function signMessage(provider: Eip1193Provider, message: string, address: string): Promise<string> {
  if (!ADDRESS.test(address)) throw new Error("That is not an account.");
  const signature = await ask(provider, "personal_sign", [utf8Hex(message), address]);
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) throw new Error("The wallet did not return a signature.");
  return signature;
}

/** What to tell a visitor when the wallet refuses or fails, in plain words and never the wallet's own text. */
export function walletErrorMessage(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === 4001 || code === "ACTION_REJECTED") return "You declined in your wallet. Nothing was signed.";
  if (code === -32002) return "Your wallet already has a request open. Open it and answer it.";
  if (error instanceof Error && /did not share an account|did not return a signature|not an account/.test(error.message)) return error.message;
  return "Your wallet could not do that. Nothing was signed.";
}
