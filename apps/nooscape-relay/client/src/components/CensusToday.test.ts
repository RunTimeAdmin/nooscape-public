import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CensusToday as Today } from "@shared/censusToday";

/**
 * The Today block on a census page: the counts of the page's first table as the directory holds them now, beside the figures the report
 * measured and the change between. It asks for one chain's counts in a request of its own, writes what the answer holds and nothing
 * else, and fails closed to nothing: a read that has not answered, an answer with no counts, or a page rendered with no query client
 * (as the report tests render it) is the report alone.
 */
const mocks = vi.hoisted(() => ({ useQuery: vi.fn() }));
vi.mock("@/lib/trpc", () => ({
  trpc: { liveData: { censusToday: { useQuery: (...args: unknown[]) => mocks.useQuery(...args) } } },
  ownRequest: { trpc: { context: { ownRequest: true } } },
}));

import { CensusToday } from "./CensusToday";

const FIGURES = [
  ["Registrations the directory counts on the chain", 10_421],
  ["Registrations the directory has stored", 4_327],
  ["Registrations the directory lists", 144],
  ["Registering wallets", 69],
] as const;

const answer = (overrides: Partial<Today> = {}): { data: { today: Today | null } } => ({
  data: {
    today: {
      chain: "monad",
      asOf: "2026-11-07T18:47:03.000Z",
      figures: { onChain: 10_500, stored: 4_400, listed: 144, wallets: 71 },
      heldOut: { noLink: 5, grouped: 4_200, numericName: 0, pending: 3 },
      ratings: null,
      ...overrides,
    },
  },
});

const decode = (value: string) => value.replace(/&rsquo;/g, "’").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const text = (markup: string) => decode(markup.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const render = (withClient = true, note?: string) => {
  const block = createElement(CensusToday, { chain: "monad", measuredOn: "2026-11-01", figures: FIGURES, note });
  return renderToStaticMarkup(withClient ? createElement(QueryClientProvider, { client: new QueryClient() }, block) : block);
};

beforeEach(() => {
  mocks.useQuery.mockReset();
});

describe("the Today block", () => {
  it("asks for the chain's counts in a request of its own, and not again for a while", () => {
    mocks.useQuery.mockReturnValue(answer());

    render();

    expect(mocks.useQuery).toHaveBeenCalledTimes(1);
    expect(mocks.useQuery).toHaveBeenCalledWith(
      { chain: "monad" },
      expect.objectContaining({ trpc: { context: { ownRequest: true } }, staleTime: 5 * 60_000, refetchOnWindowFocus: false, retry: false })
    );
  });

  it("shows each line of the page's table with the figure measured, the count today and the change", () => {
    mocks.useQuery.mockReturnValue(answer());

    const markup = render();

    expect(markup).toContain('data-census-today="monad"');
    const body = text(markup);
    expect(body).toContain("Today");
    expect(body).toContain("The report below is a measurement of 2026-11-01 and does not change.");
    expect(body).toContain("after the registry pass that finished at 2026-11-07 18:47 UTC");
    expect(body).toContain("What was counted 2026-11-01 Today Change");
    expect(body).toContain("Registrations the directory counts on the chain 10,421 10,500 +79");
    expect(body).toContain("Registrations the directory has stored 4,327 4,400 +73");
    expect(body).toContain("Registrations the directory lists 144 144 no change");
    expect(body).toContain("Registering wallets 69 71 +2");
  });

  it("leaves out a line the answer has no count for", () => {
    mocks.useQuery.mockReturnValue(answer({ figures: { listed: 150 } }));

    const body = text(render());

    expect(body).toContain("Registrations the directory lists 144 150 +6");
    expect(body).not.toContain("Registering wallets");
    expect(body).not.toContain("counts on the chain");
  });

  it("says what is held out today, for a registry that keeps its registrations in rows, and nothing of the kind for one that does not", () => {
    mocks.useQuery.mockReturnValue(answer());
    expect(text(render())).toContain(
      "Held out of the directory today: 5 with no usable profile link, 4,200 that share a profile link, a host name or a wallet with many others, 0 with a name that is only a number, and 3 not yet sorted."
    );

    mocks.useQuery.mockReturnValue(answer({ heldOut: null }));
    expect(text(render())).not.toContain("Held out of the directory today");
  });

  it("states the ratings once the count has read the whole history, and not before", () => {
    mocks.useQuery.mockReturnValue(answer({ ratings: 9_436 }));
    expect(text(render())).toContain("The chain’s reputation registry holds 9,436 ratings, counted from its first block.");

    mocks.useQuery.mockReturnValue(answer({ ratings: null }));
    expect(text(render())).not.toContain("reputation registry");
  });

  it("does not say when the pass finished if the source has not finished one", () => {
    mocks.useQuery.mockReturnValue(answer({ asOf: null }));

    const body = text(render());

    expect(body).toContain("taken from the directory as it stands now.");
    expect(body).not.toContain("registry pass that finished at");
  });

  it("says the page's note between the table and the held-out line, and nothing of the kind when the page gives none", () => {
    mocks.useQuery.mockReturnValue(answer());

    const withNote = render(true, "The way the rows are kept changed on the day the report was measured.");
    expect(text(withNote)).toContain("The way the rows are kept changed on the day the report was measured.");
    expect(withNote.indexOf("</table>")).toBeLessThan(withNote.indexOf("The way the rows are kept changed"));
    expect(withNote.indexOf("The way the rows are kept changed")).toBeLessThan(withNote.indexOf("Held out of the directory today"));

    expect(text(render())).not.toContain("The way the rows are kept changed");
  });

  it("is nothing while the answer has not come, when it holds no counts, and when none of its counts is on the page", () => {
    mocks.useQuery.mockReturnValue({ data: undefined });
    expect(render()).toBe("");

    mocks.useQuery.mockReturnValue({ data: { today: null } });
    expect(render()).toBe("");

    mocks.useQuery.mockReturnValue(answer({ figures: { profileLinks: 5 } }));
    expect(render()).toBe("");
  });

  it("is nothing, and asks for nothing, with no query client around it", () => {
    mocks.useQuery.mockReturnValue(answer());

    expect(render(false)).toBe("");
    expect(mocks.useQuery).not.toHaveBeenCalled();
  });

  it("holds counts only: no address, no long dash", () => {
    mocks.useQuery.mockReturnValue(answer({ ratings: 9_436 }));

    const markup = render();

    expect(markup).not.toMatch(/0x[0-9a-fA-F]{6}/);
    expect(markup).not.toMatch(/https?:\/\//);
    expect(markup).not.toMatch(/[\u2013\u2014]/);
  });
});
