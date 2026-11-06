import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { API_LICENSE } from "./apiLicense";
import { API_V1_SPEC } from "./apiV1Spec";

const DEED = "https://creativecommons.org/licenses/by/4.0/";
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

/**
 * The data license is stated in four places that must agree: the license object every answer and webhook carries, the OpenAPI document, the
 * Developers page (its sample answer and its text) and the Terms. This holds them together, so a change to one that leaves another behind fails here.
 */
describe("the data license (docs/data-license-2026-11-06.md)", () => {
  it("is CC BY 4.0, and the attribution line is the credit it asks for: where the data is from, the license's name and the link to it", () => {
    expect(API_LICENSE.name).toBe("CC BY 4.0");
    expect(API_LICENSE.attribution).toContain("Nooscape (https://nooscape.si)");
    expect(API_LICENSE.attribution).toContain("CC BY 4.0");
    expect(API_LICENSE.attribution).toContain(DEED);
  });

  it("no longer calls itself provisional or forbids resale, which the license allows with credit", () => {
    const text = JSON.stringify(API_LICENSE).toLowerCase();
    expect(text).not.toContain("provisional");
    expect(text).not.toContain("resell");
  });

  it("says what it does not cover and that the Terms still set the limits, and points at the Terms", () => {
    expect(API_LICENSE.notes).toContain("Text that registrants published is theirs");
    expect(API_LICENSE.notes).toContain("rate limits");
    expect(API_LICENSE.url).toBe("https://nooscape.si/terms");
  });

  it("is the license the OpenAPI document names, with the link to the license", () => {
    expect(API_V1_SPEC.info.license).toEqual({ name: API_LICENSE.name, url: DEED });
  });

  it("is the license the Developers page shows in its sample answer and says in its text", () => {
    const page = read("../client/src/pages/DeveloperApi.tsx");
    for (const field of ["name", "attribution", "notes"] as const) expect(page, field).toContain(API_LICENSE[field]);
    expect(page.toLowerCase()).not.toContain("provisional");
    expect(page.toLowerCase()).not.toContain("resell");
  });

  it("is stated in the Terms with the link to the license and the line the API gives, beside the scraping limit", () => {
    const terms = read("../client/src/pages/Terms.tsx");
    expect(terms).toContain("CC BY 4.0");
    expect(terms).toContain(DEED);
    expect(terms).toContain("license.attribution");
    expect(terms).toContain("scrape Nooscape or reach it by automated means beyond the published rate limits");
    expect(terms.toLowerCase()).not.toContain("provisional");
  });
});
