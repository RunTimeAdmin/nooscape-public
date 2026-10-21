/**
 * Where the owl appears. Only the home page for now: it is the one page with the
 * Owl guide switch, so a visitor can always turn it off, and the one page with
 * anything for it to scan. The operator console never has an owl.
 */
const OWL_ROUTES: readonly string[] = ["/"];

export function owlAllowedOn(path: string): boolean {
  return OWL_ROUTES.includes(path);
}
