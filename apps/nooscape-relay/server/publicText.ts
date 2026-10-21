/**
 * Presentation hygiene for source-served (untrusted) public fields.
 *
 * Public records carry text an external source wrote about itself. It is served
 * as an untrusted claim, so it must never smuggle invisible formatting:
 * control characters, zero-width joiners, bidirectional overrides, and soft
 * hyphens are flattened or stripped before the text reaches the public API.
 * Kept pure and dependency-free so the public read path stays unit-testable.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/g;
const INVISIBLE_CHARACTERS = /[\u00AD\u200B-\u200D\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/g;
const VERSION_LIKE = /^\d+(?:\.\d+)+$/;

export function sanitizePublicText(value: string | null | undefined, maxLength = 8_000): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(CONTROL_CHARACTERS, " ")
    .replace(INVISIBLE_CHARACTERS, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, maxLength) : null;
}

/**
 * A bare protocol version is metadata, never a capability. Catalog records
 * without a category previously leaked `protocol_version` values (`1.0`,
 * `0.3.0`, …) into the capability field through a positional fallback; those
 * values are suppressed for presentation until the next reviewed re-projection
 * replaces the stored snapshot.
 */
export function sanitizePrimaryCapability(value: string | null | undefined, maxLength = 160): string | null {
  const cleaned = sanitizePublicText(value, maxLength);
  return cleaned !== null && VERSION_LIKE.test(cleaned) ? null : cleaned;
}
