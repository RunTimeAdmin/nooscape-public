/**
 * The host an address names, in lower case, or null when it names none: not a URL, no host, or longer than the column that keeps it. A catalog
 * record keeps this beside its public snapshot, so a registry run can tell which party another source's public record already holds.
 */
export function partyHostOf(address: string | null | undefined): string | null {
  if (!address) return null;
  try {
    const host = new URL(address).hostname.toLowerCase();
    return host.length > 0 && host.length <= 255 ? host : null;
  } catch {
    return null;
  }
}
