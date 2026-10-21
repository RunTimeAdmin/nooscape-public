/**
 * Shared address guard for the approved-fetch boundary. Every fetch that
 * targets an operator-approved or publisher-controlled name — the ingestion
 * adapters and domain-control verification — resolves DNS first and rejects
 * any answer in private, loopback, link-local, multicast, reserved, or
 * metadata space. This module is the single copy of that policy: the IPv6
 * check covers every textual form (dotted or hex IPv4-mapped, link-local
 * fe80::/10, NAT64, 6to4, Teredo), and unparseable input fails closed.
 */

import { isIP } from "node:net";

/**
 * IPv4 special-purpose space that must never be reachable through the fetch
 * boundary: "this network", private use, CGNAT, loopback, link-local
 * (including the 169.254.169.254 metadata service), the 192.0.0.0/24 and
 * 198.18.0.0/15 protocol/benchmark blocks, and multicast/reserved space.
 */
export function isForbiddenIpv4(address: string) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some(value => Number.isNaN(value))) return true;
  const [first, second, third] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

/** Parses any textual IPv6 form (including embedded IPv4) into eight groups. */
function ipv6Groups(address: string) {
  let text = address.toLowerCase();
  if (text.includes(".")) {
    const lastColon = text.lastIndexOf(":");
    const embedded = text.slice(lastColon + 1).split(".").map(Number);
    if (embedded.length !== 4 || embedded.some(value => Number.isNaN(value) || value < 0 || value > 255)) return null;
    text = `${text.slice(0, lastColon + 1)}${((embedded[0] << 8) | embedded[1]).toString(16)}:${((embedded[2] << 8) | embedded[3]).toString(16)}`;
  }

  const parts = text.split("::");
  if (parts.length > 2) return null;
  const groupsOf = (value: string) =>
    value === ""
      ? []
      : value.split(":").map(part => (/^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : Number.NaN));
  const head = groupsOf(parts[0]);
  const tail = parts.length === 2 ? groupsOf(parts[1]) : [];
  if ([...head, ...tail].some(group => Number.isNaN(group))) return null;
  if (parts.length === 1) return head.length === 8 ? head : null;
  if (head.length + tail.length > 7) return null;
  return [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail];
}

/**
 * True for every IPv6 form that could reach non-public space: unspecified,
 * loopback, IPv4-compatible, IPv4-mapped (dotted or hex), NAT64 (well-known
 * and local-use), 6to4, Teredo, documentation, unique-local (fc00::/7),
 * link-local (fe80::/10), site-local (fec0::/10), and multicast space.
 * Unparseable values fail closed.
 */
export function isForbiddenIp(address: string) {
  const kind = isIP(address);
  if (kind === 4) return isForbiddenIpv4(address);
  if (kind !== 6) return true;

  const groups = ipv6Groups(address);
  if (!groups) return true;
  const [first, second] = groups;

  if (groups.slice(0, 6).every(group => group === 0)) return true; // ::, ::1, ::a.b.c.d
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) return true; // ::ffff:0:0/96
  if (first === 0x0064 && second === 0xff9b) return true; // 64:ff9b::/96 and 64:ff9b:1::/48
  if (first === 0x2002) return true; // 6to4
  if (first === 0x2001 && second === 0x0000) return true; // Teredo
  if (first === 0x2001 && second === 0x0db8) return true; // documentation

  const uniqueLocal = (first & 0xfe00) === 0xfc00;
  const linkLocal = (first & 0xffc0) === 0xfe80;
  const siteLocal = (first & 0xffc0) === 0xfec0;
  const multicast = (first & 0xff00) === 0xff00;
  return uniqueLocal || linkLocal || siteLocal || multicast;
}

/**
 * Rejects names that cannot be public DNS hostnames: loopback names, .local /
 * .internal suffixes, and bare IP literals in any textual form.
 */
export function isClearlyUnsafeHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    isIP(normalized) !== 0
  );
}
