/**
 * What the owner of an agent may write about it once the claim is made (docs/claims-2026-10-18.md): a display name, a website, a
 * description and a few links, and nothing else. Never a tier, a publisher state, a rating, a fleet, whether the entry is listed
 * or where it sits. Pure and shared, so the server that checks the words and any page that previews them agree.
 *
 * The text is the owner's own claim and is shown as such. The checks here are about size and shape: control and invisible
 * characters out (the caller's `sanitize`), https links only, no credentials, no address literal, no local name.
 */

export const CLAIM_FIELDS = ["name", "website", "description", "links"] as const;
export type ClaimField = (typeof CLAIM_FIELDS)[number];

export const CLAIM_LIMITS = { name: 120, website: 300, description: 1000, link: 300, links: 5 } as const;

/** What an owner has set. A field the owner has not set is null (an empty list for the links). */
export type ClaimProfile = { name: string | null; website: string | null; description: string | null; links: string[] };
export const EMPTY_CLAIM_PROFILE: ClaimProfile = { name: null, website: null, description: null, links: [] };

/** What an edit asks for: only the fields it names. `null` (or an empty list for the links) clears a field. */
export type ClaimEdit = { name?: string | null; website?: string | null; description?: string | null; links?: string[] };

/** The same text, made safe for public pages by the caller: control and invisible characters out, cut to a length. */
export type Sanitize = (text: string, maxLength: number) => string | null;

export type ClaimEditResult = { ok: true; fields: ClaimEdit } | { ok: false; field: ClaimField; message: string };

/** The names a link host must not have: a local name is never a public website. */
const LOCAL_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".corp", ".intranet"];

/** A link as it will be stored, or null when it is not one the site will show: https, a real public name, no credentials, no fragment. */
export function normalizeClaimUrl(value: string): string | null {
  const text = value.trim();
  if (text.length === 0 || text.length > CLAIM_LIMITS.link) return null;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return null;
  const host = parsed.hostname.toLowerCase();
  // An address literal (the URL parser writes every IPv4 form as dotted decimal and brackets an IPv6 one) and a name without a dot or
  // with a local suffix are never a public site. No Node module here: the page that previews an edit uses this file too.
  // A name that ends in a dot (the root, written out) is refused too: the URL parser keeps the dot, so "localhost." would slip past a suffix check.
  const literal = host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  if (host.length === 0 || host.endsWith(".") || literal || !host.includes(".") || LOCAL_SUFFIXES.some(suffix => host.endsWith(suffix))) return null;
  if (parsed.port !== "" && parsed.port !== "443") return null;
  parsed.hash = "";
  const href = parsed.href;
  return href.length <= CLAIM_LIMITS.link ? href : null;
}

const fail = (field: ClaimField, message: string): ClaimEditResult => ({ ok: false, field, message });

/**
 * The edit as it will be applied: each named field cleaned and checked, the rest untouched. An edit that names no field, or whose
 * words are empty after cleaning, is not an edit.
 */
export function normalizeClaimEdit(input: ClaimEdit, sanitize: Sanitize): ClaimEditResult {
  const fields: ClaimEdit = {};
  for (const field of CLAIM_FIELDS) {
    if (!(field in input) || input[field] === undefined) continue;
    const value = input[field];
    if (field === "links") {
      const list = value as string[] | null;
      if (list === null || list.length === 0) {
        fields.links = [];
        continue;
      }
      if (!Array.isArray(list) || list.length > CLAIM_LIMITS.links) return fail("links", `At most ${CLAIM_LIMITS.links} links.`);
      const cleaned: string[] = [];
      for (const item of list) {
        const url = typeof item === "string" ? normalizeClaimUrl(item) : null;
        if (url === null) return fail("links", "Each link must be an https address on a public site.");
        if (!cleaned.includes(url)) cleaned.push(url);
      }
      fields.links = cleaned;
      continue;
    }
    if (value === null) {
      fields[field] = null;
      continue;
    }
    if (typeof value !== "string") return fail(field, "Text is expected.");
    if (field === "website") {
      const url = normalizeClaimUrl(value);
      if (url === null) return fail("website", "The website must be an https address on a public site.");
      fields.website = url;
      continue;
    }
    // Too long is an error and not a silent cut: what the owner signs is what the site shows.
    if (value.trim().length > CLAIM_LIMITS[field]) return fail(field, `At most ${CLAIM_LIMITS[field]} characters.`);
    const text = sanitize(value, CLAIM_LIMITS[field]);
    // Text that is nothing once cleaned clears the field, which is the owner's plain intent for an empty box.
    fields[field] = text === null || text.length === 0 ? null : text;
  }
  if (Object.keys(fields).length === 0) return fail("name", "Name at least one field to change.");
  return { ok: true, fields };
}

/**
 * The edit as the text the owner signs a hash of: the named fields only, in a fixed order, as JSON. Two edits that say the same
 * give the same text, so the signature commits to exactly what is applied.
 */
export function canonicalClaimEdit(fields: ClaimEdit): string {
  const ordered: Record<string, unknown> = {};
  for (const field of CLAIM_FIELDS) if (field in fields && fields[field] !== undefined) ordered[field] = fields[field];
  return JSON.stringify(ordered);
}

/** The profile after an edit: each named field replaced, the rest kept. */
export function applyClaimEdit(profile: ClaimProfile, fields: ClaimEdit): ClaimProfile {
  return {
    name: fields.name !== undefined ? fields.name : profile.name,
    website: fields.website !== undefined ? fields.website : profile.website,
    description: fields.description !== undefined ? fields.description : profile.description,
    links: fields.links !== undefined ? fields.links : profile.links,
  };
}

/** The fields an edit would change, with the old and the new value of each as text (the links as a JSON list), for the public log. */
export function claimEditChanges(profile: ClaimProfile, fields: ClaimEdit): Array<{ field: ClaimField; oldValue: string | null; newValue: string | null }> {
  const after = applyClaimEdit(profile, fields);
  const changes: Array<{ field: ClaimField; oldValue: string | null; newValue: string | null }> = [];
  for (const field of CLAIM_FIELDS) {
    if (fields[field] === undefined) continue;
    const before = field === "links" ? (profile.links.length > 0 ? JSON.stringify(profile.links) : null) : profile[field];
    const now = field === "links" ? (after.links.length > 0 ? JSON.stringify(after.links) : null) : after[field];
    if (before !== now) changes.push({ field, oldValue: before, newValue: now });
  }
  return changes;
}
