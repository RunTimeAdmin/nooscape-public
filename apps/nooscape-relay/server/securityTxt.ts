import type { Express } from "express";

/** Where a vulnerability report goes. SECURITY.md names the same address, and a test keeps the two together. */
export const SECURITY_CONTACT = "mailto:security@nooscape.si";

/** How far ahead the published Expires date is set. RFC 9116 asks for less than a year. */
export const SECURITY_TXT_VALID_DAYS = 180;

/**
 * The text of /.well-known/security.txt (RFC 9116). Expires is worked out from the clock, so the file is always valid
 * and never needs a yearly edit; a researcher who finds the file stale would otherwise have no way to tell whether the
 * address still works.
 */
export function securityTxt(now = new Date()): string {
  const expires = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + SECURITY_TXT_VALID_DAYS)).toISOString();
  return [
    `Contact: ${SECURITY_CONTACT}`,
    `Expires: ${expires}`,
    "Preferred-Languages: en",
    "Canonical: https://nooscape.si/.well-known/security.txt",
    "",
  ].join("\n");
}

/**
 * Serves it. It is a route and not a file in the build because the static handler skips dot-directories, and because of
 * the date above. Mount it before the static files and the client's catch-all.
 */
export function registerSecurityTxt(app: Express) {
  app.get("/.well-known/security.txt", (_req, res) => {
    res.type("text/plain; charset=utf-8").set("Cache-Control", "public, max-age=3600").send(securityTxt());
  });
}
