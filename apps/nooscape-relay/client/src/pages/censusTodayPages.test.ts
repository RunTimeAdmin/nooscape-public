import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { describe, expect, it, vi } from "vitest";
import type { CensusChain, CensusToday } from "@shared/censusToday";

/**
 * Every registry census report carries the Today block, right after the lines that say when it was measured, and the block has a line
 * for each line of the report's first table. The lines are matched by label, so a label that is changed on a page and not here would
 * drop its line without a word; the row counts below are what keep each page's table and the block together.
 */
const mocks = vi.hoisted(() => ({ requested: [] as string[] }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    liveData: {
      censusToday: {
        useQuery: (input: { chain: CensusChain }) => {
          mocks.requested.push(input.chain);
          const figures = { onChain: 1_001, stored: 1_002, overflow: 1_003, listed: 1_004, wallets: 1_005, withHttpsHost: 1_006, hosts: 1_007, profileLinks: 1_008 };
          return { data: { today: { chain: input.chain, asOf: "2026-11-07T01:02:03.000Z", figures, heldOut: null, ratings: null } satisfies CensusToday } };
        },
      },
    },
  },
  ownRequest: { trpc: { context: { ownRequest: true } } },
}));

import ArcRegistryReport from "./ArcRegistryReport";
import BnbRegistryReport from "./BnbRegistryReport";
import ArcRegistryReport20261106 from "./ArcRegistryReport20261106";
import BaseRegistryReport from "./BaseRegistryReport";
import EthereumRegistryReport from "./EthereumRegistryReport";
import GnosisRegistryReport from "./GnosisRegistryReport";
import MonadRegistryReport from "./MonadRegistryReport";
import RobinhoodRegistryReport from "./RobinhoodRegistryReport";

const PAGES: ReadonlyArray<{ name: string; chain: CensusChain; page: ComponentType; measuredOn: string; lines: number }> = [
  { name: "Arc, 2026-10-20", chain: "arc", page: ArcRegistryReport, measuredOn: "2026-10-20", lines: 6 },
  { name: "Arc, 2026-11-06", chain: "arc", page: ArcRegistryReport20261106, measuredOn: "2026-11-06", lines: 8 },
  { name: "Base", chain: "base", page: BaseRegistryReport, measuredOn: "2026-10-21", lines: 6 },
  { name: "Ethereum", chain: "ethereum", page: EthereumRegistryReport, measuredOn: "2026-10-28", lines: 8 },
  { name: "Monad", chain: "monad", page: MonadRegistryReport, measuredOn: "2026-11-01", lines: 8 },
  { name: "Gnosis", chain: "gnosis", page: GnosisRegistryReport, measuredOn: "2026-11-06", lines: 8 },
  { name: "Robinhood Chain", chain: "robinhood", page: RobinhoodRegistryReport, measuredOn: "2026-10-20", lines: 4 },
  { name: "BNB Chain", chain: "bnb", page: BnbRegistryReport, measuredOn: "2026-10-16", lines: 1 },
];

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const render = (page: ComponentType) =>
  renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Router, { ssrPath: "/field/x", children: createElement(page) })));

describe("the census reports and their Today block", () => {
  it.each(PAGES)("$name asks for its own chain and shows a line for each line of its first table, dated as the report is", ({ chain, page, measuredOn, lines }) => {
    mocks.requested.length = 0;

    const markup = render(page);

    expect(mocks.requested).toEqual([chain]);
    expect(markup).toContain(`data-census-today="${chain}"`);
    const block = markup.slice(markup.indexOf('data-census-today'));
    const body = block.slice(0, block.indexOf("</section>"));
    expect(body).toContain(`The report below is a measurement of ${measuredOn}`);
    // One row of the body for each line of the report's own table, and each carries today's count and a change.
    const rows = body.match(/<tr>/g) ?? [];
    expect(rows.length).toBe(lines);
    expect(body).toMatch(/1,00\d/);
  });

  it.each(PAGES)("$name puts the block directly after the lines that say when it was measured", ({ page }) => {
    const markup = render(page);

    const afterDates = markup.slice(markup.indexOf("</dl>") + "</dl>".length);
    // The first section after the lines that say when it was measured is the Today block's own.
    expect(afterDates.indexOf("<section")).toBeGreaterThan(-1);
    expect(afterDates.slice(afterDates.indexOf("<section"))).toMatch(/^<section aria-labelledby="census-today" data-census-today=/);
    expect(markup.indexOf("Counted from")).toBeLessThan(markup.indexOf("data-census-today"));
  });

  it("explains the host cap under Base's table, where the report was measured before the rows past it were cleared, and nowhere else", () => {
    for (const { page, chain } of PAGES) {
      const body = text(render(page));
      expect(body.includes("has capped the rows it stores for one host name"), chain).toBe(chain === "base");
    }
    expect(text(render(BaseRegistryReport))).toContain("Those registrations were not lost: they are counted and not stored.");
  });

  it("reads the lines of Robinhood Chain's table by the words that page uses", () => {
    const body = render(RobinhoodRegistryReport);

    expect(body).toContain("Entries the directory shows");
    expect(body).toContain("Entries with an https link");
    expect(body).toMatch(/Entries the directory shows<\/th><td[^>]*>[\d,]+<\/td><td[^>]*>1,004<\/td>/);
    expect(body).toMatch(/Entries with an https link<\/th><td[^>]*>[\d,]+<\/td><td[^>]*>1,006<\/td>/);
  });

  it("is absent where there is no query client, which leaves the reports as the report tests render them", () => {
    for (const { page, chain } of PAGES) {
      const markup = renderToStaticMarkup(createElement(Router, { ssrPath: "/field/x", children: createElement(page) }));
      expect(markup, chain).not.toContain("census-today");
    }
  });
});
