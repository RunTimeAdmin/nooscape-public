/**
 * The license the data is offered under, in every API answer and every webhook: CC BY 4.0 for the facts and records Nooscape produces,
 * decided 2026-11-06 (docs/data-license-2026-11-06.md). The attribution line carries the license's name and its link, so copying the line
 * is the credit the license asks for. `url` is the Terms, which state the license beside the rate limits.
 */
export const API_LICENSE = {
  name: "CC BY 4.0",
  url: "https://nooscape.si/terms",
  attribution: "Data from Nooscape (https://nooscape.si), licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).",
  notes:
    "Attribution is required. The facts and records Nooscape produces are licensed under CC BY 4.0: copy, share and adapt them, commercially too, with that credit. Text that registrants published is theirs and is shown as published. The Terms still set the rate limits for reading the data from this service.",
} as const;
