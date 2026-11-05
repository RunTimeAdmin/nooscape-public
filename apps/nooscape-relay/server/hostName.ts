/**
 * How a host name is written down and compared. No imports: the ingestion adapters, the directory reads and the check endpoint all
 * use it, and they must agree.
 *
 * The URL parser keeps the root label of a fully qualified name: `new URL("https://api.example./").hostname` is `api.example.`, and
 * it keeps more than one dot, and the escaped (`%2E`) and full-width (U+3002) spellings give the same thing. A host stored that way
 * was a different string from the same host without the dot, so it escaped the suppressed-domain rule, split the per-host counts
 * the listing rules and the row cap use, and could not be found by its own address in a check (outside audit 2026-11-05, findings
 * R16 and R19).
 */

/**
 * What a host name is, whatever else a URL parser lets through: labels of letters, digits, hyphens and underscores, none starting or
 * ending with a hyphen, separated by single dots; or an IPv6 address in brackets, as the parser writes it.
 */
const HOST_SHAPE = /^(?:[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*|\[[0-9a-f:.]+\])$/;

/**
 * The host as the directory stores and compares it: lower case, with every trailing dot removed. Null when nothing is left, when the
 * name is longer than a host name can be (the columns that hold it are 255 characters), or when it is not a host name at all. A URL
 * parser accepts more than names: the closing bracket and full stop that a feed copied from a sentence give `api.example.com).`, which
 * was stored as a host and can be neither fetched nor matched; a name with an empty label or a label that starts with a hyphen is the
 * same. A host that is not a name is no locator.
 */
export function canonicalHost(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  return host.length <= 255 && HOST_SHAPE.test(host) ? host : null;
}

/** True when `host` is `domain` or a subdomain of it, whatever case and trailing dots the host was written with. */
export function hostIsUnder(host: string | null | undefined, domain: string): boolean {
  if (!host) return false;
  const normalized = host.trim().toLowerCase().replace(/\.+$/, "");
  return normalized === domain || normalized.endsWith(`.${domain}`);
}
