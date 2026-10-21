/**
 * The address of Arc's node, shared by the two things that read it: the payment code, which asks it whether a smart-contract wallet
 * signed a payment, and the ERC-8004 identity pass on Arc (docs/multichain-erc8004-2026-10-20.md). Arc has no variable of its own: the
 * node is the operator's, already reached through `X402_RPC`, and the identity pass reads the same setting so that one address is
 * kept in one place.
 *
 * The address may carry a key, so it is secret. Nothing here puts it, or any part of it, in an error, and nothing that calls these
 * functions may put it in a log, a message or a record. The host name alone (no port, path or key) is what a source row keeps.
 *
 * The rule is the one `loadX402` has always applied: the value is trimmed, an empty one is not set, and a set one must be an https
 * address. This file holds that rule so both readers agree on it. It depends on nothing else of the payment settings, so the
 * identity pass works while payments are paused or not configured.
 */

export type ArcRpcSetting = { state: "unset" } | { state: "invalid" } | { state: "set"; url: string };

/** What `X402_RPC` holds. */
export function readArcRpc(env: NodeJS.ProcessEnv = process.env): ArcRpcSetting {
  const value = (env.X402_RPC ?? "").trim();
  if (!value) return { state: "unset" };
  let secure = false;
  try {
    secure = new URL(value).protocol === "https:";
  } catch {
    // not an address
  }
  return secure ? { state: "set", url: value } : { state: "invalid" };
}

/** The node's https address, or null when `X402_RPC` is unset or is not an https address. Secret: it may carry a key. */
export function arcRpcUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const setting = readArcRpc(env);
  return setting.state === "set" ? setting.url : null;
}

/** The node's host name in lower case, with no port, path or key, or null when there is no usable address. */
export function arcRpcHost(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = arcRpcUrl(env);
  return url === null ? null : new URL(url).hostname.toLowerCase();
}
