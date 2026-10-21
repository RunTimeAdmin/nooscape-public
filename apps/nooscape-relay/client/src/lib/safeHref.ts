/**
 * The only way a stored address becomes a link. React escapes text but not a `javascript:` or `data:` address in an
 * href, and the locators the relay shows come from ingestion sources whose values a registrant controls. Returns the
 * normalized address of an https URL with a host and no embedded credentials, or null, in which case the caller shows
 * no link at all.
 */
export function safeHttpsHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}
