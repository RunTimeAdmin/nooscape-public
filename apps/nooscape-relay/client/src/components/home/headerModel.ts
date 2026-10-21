/**
 * What the site header holds, decided apart from how it is drawn so the choices can be tested
 * without a browser. The bar carries three links, one button and a menu; everything else the old
 * header spread across one crowded row lives in the menu, and the status chips became lines in it.
 */
export type NavLink = { label: string; href: string };

/**
 * The links that stay in the bar. Each is an in-page anchor to a heading id, so a test can check the
 * target exists. With the "Ask the Owl" button and the More menu the bar has five things to reach.
 */
export const PRIMARY_LINKS: readonly NavLink[] = [
  { label: "Atlas", href: "#scan-field-heading" },
  { label: "Regions", href: "#chains-heading" },
  { label: "How the Owl sees", href: "#how-it-works-heading" },
];

/** Page sections that are in the menu, not the bar. */
export const MORE_ANCHORS: readonly NavLink[] = [{ label: "Field Reports", href: "#field-notes-heading" }];

/** The other pages of the site: the full field and the Owl's Catch, then the header's own links from before the menu took them. */
export const PAGE_LINKS: readonly NavLink[] = [
  { label: "The full field", href: "/field" },
  { label: "The Owl's Catch", href: "/catch" },
  { label: "API", href: "/developers" },
  { label: "Verify evidence", href: "/verify" },
  { label: "Sources", href: "/sources" },
  { label: "Context", href: "/context" },
  { label: "What Nooscape is and is not", href: "/about" },
];

/** How far the page scrolls before the header takes its glass background. */
export const SCROLL_PAST_PX = 24;

export function isScrolled(scrollY: number): boolean {
  return scrollY > SCROLL_PAST_PX;
}

export type StatusLine = { label: string; value: string };

/** What the old status chips said, as lines for the menu. Nothing is invented: a count shows only when the read has returned it. */
export function statusLines(input: { loading: boolean; recordCount: number; publicRecordCount: number | null; coveragePercent: number | null }): StatusLine[] {
  const { loading, recordCount, publicRecordCount, coveragePercent } = input;
  const two = (value: number) => String(value).padStart(2, "0");
  if (loading) {
    return [
      { label: "Live records", value: "Loading" },
      { label: "Provenance", value: "Loading" },
      { label: "Discovery", value: "Multi-protocol" },
    ];
  }
  return [
    { label: "Live records", value: recordCount > 0 ? `Observed / ${two(publicRecordCount ?? recordCount)}` : "None observed" },
    { label: "Provenance", value: recordCount > 0 ? (coveragePercent === null ? "Checking" : `${coveragePercent}% ready`) : "None observed" },
    { label: "Discovery", value: "Multi-protocol" },
  ];
}

/** The id an anchor link points at, without the hash, or null for a link that is not an in-page anchor. */
export function anchorId(href: string): string | null {
  return href.startsWith("#") && href.length > 1 ? href.slice(1) : null;
}
