import type { IncomingHttpHeaders } from "node:http";
import { isForbiddenIp } from "./netGuard";

/**
 * How one request reached the app, from the app's side. The per-address rate
 * limit keys on `req.ip`, which Express derives from X-Forwarded-For and the
 * `trust proxy` hop count. Behind a CDN and a reverse proxy a wrong hop count
 * makes `req.ip` the proxy's address for every visitor, and the limit of 600
 * requests per 5 minutes is then shared by all of them. Nothing outside the app
 * can tell which it is, so the operator console shows this for the operator's
 * own request.
 */
type ClientAddressCheck = {
  /** The address the per-address limits key on (Express's req.ip). */
  address: string;
  /** Proxy hops the app trusts (`trust proxy`), or null when the setting is not a hop count. */
  trustedHops: number | null;
  /** Entries in the X-Forwarded-For header this request arrived with. The operator's browser sends none, so each entry was added by a proxy. */
  forwardedForEntries: number;
  /** The address is private, loopback, or otherwise not a visitor's: it belongs to a proxy. */
  addressIsInternal: boolean;
  /** False when the counts or the address show the limit may be keyed on a proxy. True is not proof: the operator still compares the address with their own. */
  looksRight: boolean;
  note: string;
};

/** req.ip can be an IPv4-mapped IPv6 form of a public address, which netGuard (built for fetch targets) rejects whole. */
function isInternalAddress(address: string) {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return isForbiddenIp(mapped ? mapped[1]! : address);
}

function countForwardedFor(header: IncomingHttpHeaders["x-forwarded-for"]) {
  const joined = Array.isArray(header) ? header.join(",") : (header ?? "");
  return joined.split(",").filter(entry => entry.trim() !== "").length;
}

const entries = (count: number) => `${count} forwarded-for ${count === 1 ? "entry" : "entries"}`;
const proxies = (count: number) => `${count} ${count === 1 ? "proxy" : "proxies"}`;

export function describeClientAddress(request: {
  ip?: string | undefined;
  headers: IncomingHttpHeaders;
  app: { get(setting: string): unknown };
}): ClientAddressCheck {
  const address = request.ip ?? "unknown";
  const forwardedForEntries = countForwardedFor(request.headers["x-forwarded-for"]);
  const setting = request.app.get("trust proxy");
  const trustedHops = typeof setting === "number" ? setting : null;
  const addressIsInternal = isInternalAddress(address);
  const check = { address, trustedHops, forwardedForEntries, addressIsInternal };

  if (addressIsInternal) {
    return {
      ...check,
      looksRight: false,
      note: "This is a private address, so it belongs to a proxy in front of the app, not to a visitor. Every visitor would share it, and so would the per-address limits.",
    };
  }
  if (trustedHops === null) {
    return {
      ...check,
      looksRight: false,
      note: "The app's proxy setting is not a hop count, so it cannot be compared with the forwarded-for entries. Check that the address is your own.",
    };
  }
  if (forwardedForEntries > trustedHops) {
    return {
      ...check,
      looksRight: false,
      note: `The request carries ${entries(forwardedForEntries)} but the app trusts ${proxies(trustedHops)}, so the address is probably a proxy's, not yours. The proxy setting should be ${forwardedForEntries}.`,
    };
  }
  if (forwardedForEntries < trustedHops) {
    return {
      ...check,
      looksRight: false,
      note: `The app trusts ${proxies(trustedHops)} but the request carries ${entries(forwardedForEntries)}, so some proxy in front does not pass the visitor's address on. The address is the earliest one on the request. Check that it is your own.`,
    };
  }
  return {
    ...check,
    looksRight: true,
    note: `${entries(forwardedForEntries)}, ${proxies(trustedHops)} trusted. If the address is your own public one, visitors are told apart. To be sure, open this page from another network and check that it shows a different address.`,
  };
}
