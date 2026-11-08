import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Router } from "wouter";
import { AgentFigure, figureParts, FIGURE_BODIES, FIGURE_CROWNS, FIGURE_EYES } from "./AgentFigure";
import { FormationMark } from "./FormationMark";
import { ChainEventRail } from "./ChainEventRail";
import { RegistrationShare } from "./RegistrationShare";
import { registrationShare, type ChainWorldEvent } from "@/lib/chainExplorerModel";
import { FLEET_NOT_PROVED, ROBINHOOD_NOT_PROVED, type MapFleet } from "@shared/mapFleets";

const event: ChainWorldEvent = {
  id: "event",
  entryId: "id/with space",
  name: "Registry identity",
  protocol: "solana_said",
  kind: "transfer",
  label: "Owner / authority changed",
  height: 4242,
  heightLabel: "Observation slot",
  transaction: "recorded-signature",
  from: "actual-from",
  to: "actual-to",
  observedAt: "2026-10-19T12:00:00Z",
};
const noop = () => {};
function rail(
  status: "ready" | "unsupported" | "unavailable" | "unmeasured",
  events: ChainWorldEvent[] = [],
  motionReduced = false
) {
  return renderToStaticMarkup(
    createElement(ChainEventRail, {
      chain: "bnb",
      events,
      activeId: events[0]?.id ?? null,
      playing: false,
      onSelect: noop,
      onTogglePlayback: noop,
      motionReduced,
      status,
      coverage: "Recorded coverage",
    })
  );
}
describe("chain world components", () => {
  it("draws the same scout for the same id, a hollow dashed one for an entry that is not reviewed, and nothing that reads as colour alone", () => {
    const draw = (kind: "reviewed" | "acknowledged", agentId = "same-id") => renderToStaticMarkup(createElement(AgentFigure, { agentId, tone: "#C3F53C", kind }));
    const reviewed = draw("reviewed");
    const ack = draw("acknowledged");
    expect(reviewed).toContain('viewBox="0 0 56 64"');
    expect(reviewed).toContain('aria-hidden="true"');
    expect(draw("reviewed")).toEqual(reviewed);
    expect(ack).not.toEqual(reviewed);
    expect(ack).toContain('data-kind="acknowledged"');
    expect(ack).toContain("stroke-dasharray");
    expect(reviewed).not.toContain("stroke-dasharray");
    // One light drawing: no gradients and no ids of its own, so a crowd of them stays cheap.
    expect(reviewed).not.toContain("<defs");
    expect(reviewed).not.toContain("url(#");
  });
  it("picks a body, eyes and a crown from the id, and uses all 36 scouts", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 600; index += 1) {
      const parts = figureParts(`agent-${index}`);
      expect(parts.body).toBeLessThan(FIGURE_BODIES);
      expect(parts.eyes).toBeLessThan(FIGURE_EYES);
      expect(parts.crown).toBeLessThan(FIGURE_CROWNS);
      seen.add(`${parts.body}-${parts.eyes}-${parts.crown}`);
    }
    expect(seen.size).toBe(FIGURE_BODIES * FIGURE_EYES * FIGURE_CROWNS);
  });
  it("draws a formation in its chain's outline and sizes it by the number it is given", () => {
    const mark = (shape: "circle" | "diamond" | "hexagon" | "dome", size = 80) => renderToStaticMarkup(createElement(FormationMark, { shape, size, tone: "#F3BA2F" }));
    const shapes = (["circle", "diamond", "hexagon", "dome"] as const).map(shape => mark(shape));
    expect(new Set(shapes).size).toBe(4);
    expect(mark("dome")).toContain('data-shape="dome"');
    expect(shapes.every(markup => markup.includes('aria-hidden="true"'))).toBe(true);
    expect(mark("hexagon", 100)).toContain('width="100"');
    expect(mark("hexagon", 60)).toContain('width="60"');
  });
  it("shows only the recorded endpoints/anchor and identifies the feed as historical", () => {
    const markup = rail("ready", [event]);
    for (const fact of [
      "actual-from",
      "actual-to",
      "recorded-signature",
      "Observation slot",
      "4242",
      "HISTORICAL REPLAY · NOT LIVE",
      "Nooscape observed time",
    ])
      expect(markup).toContain(fact);
    expect(markup).toContain("/agents/id%2Fwith%20space");
    expect(markup).toContain(
      'aria-label="Select a recorded event in chronological order"'
    );
  });
  it("does not substitute zero events for an unavailable or unsupported feed", () => {
    expect(rail("unsupported")).toContain(
      "No global BNB activity feed is published."
    );
    expect(rail("unsupported")).toContain("No event is shown in its");
    expect(rail("unavailable")).toContain("Recorded activity is unavailable.");
    expect(rail("unavailable")).not.toContain("0 events in this feed");
    expect(rail("unavailable")).not.toContain("Play replay");
    expect(rail("unmeasured")).toContain(
      "No activity sample is recorded for this entry."
    );
  });
  it("disables automatic replay under reduced motion while leaving manual event selection present", () => {
    const markup = rail("ready", [event], true);
    expect(markup).toContain("Replay is disabled by reduced-motion preference");
    expect(markup).toContain('disabled=""');
    expect(markup).toContain("Select a recorded event in chronological order");
  });
});

describe("the share of the registrations the registering wallets are recorded against", () => {
  const wallet = (id: string, count: number, chain: "robinhood" | "arc"): MapFleet => ({ id, kind: "wallet", chain, name: null, wallet: `0x${id.padEnd(40, "a")}`, registry: null, count, wallets: 1 });
  const draw = (chain: "robinhood" | "arc") =>
    // The census link is a wouter Link, which needs a router to render outside a browser.
    renderToStaticMarkup(
      createElement(Router, {
        ssrPath: "/chains/test",
        children: createElement(RegistrationShare, {
          chain,
          share: registrationShare([wallet("a", 1000, chain), wallet("b", 868, chain), wallet("c", 100, chain)], 2587, 3)!,
          asOf: "2026-10-20T17:27:10Z",
          selectedId: null,
          onSelect: noop,
        }),
      })
    );

  it("says, on Arc, how much of the registry the wallets registered, over every registration the registry holds, and links the Arc census", () => {
    const markup = draw("arc");
    expect(markup).toContain("WHO REGISTERED ON ARC");
    expect(markup).toContain("<strong>76 percent</strong> of the 2,587 registrations on Arc are recorded against 3 registering wallets.");
    expect(markup).toContain("registrations the registry holds, listed or not, as the registry held them at 20 Oct 2026, 17:27 UTC.");
    expect(markup).toContain("The other 619 are recorded against wallets with fewer than 50 each.");
    expect(markup).toContain(FLEET_NOT_PROVED.wallet);
    expect(markup).toContain('href="/field/arc-registry-2026-11-06"');
    expect(markup).not.toContain("robinhood-registry");
    expect(markup).not.toMatch(/Robinhood/);
  });

  it("says on Robinhood Chain what it said before: the entries the directory lists, the wallets that hold 100 or more, and the census", () => {
    const markup = draw("robinhood");
    expect(markup).toContain("WHO REGISTERED THE ENTRIES");
    expect(markup).toContain("<strong>76 percent</strong> of the 2,587 entries the directory lists on Robinhood Chain are recorded against 3 registering wallets.");
    expect(markup).toContain("Shares are of the entries the directory lists, as it held them at 20 Oct 2026, 17:27 UTC.");
    expect(markup).toContain("fewer than 100 each");
    expect(markup).toContain(ROBINHOOD_NOT_PROVED);
    expect(markup).toContain('href="/field/robinhood-registry-2026-10-20"');
  });

  it("says a small share as what it is, not as none: tenths of a percent in the headline and under a tenth on a wallet", () => {
    // Arc on 6 November 2026: seven wallets with 50 or more registrations, 2,406 of the 385,752 the registry holds. It said "0 percent" and "0%".
    const counts = [1_000, 868, 144, 136, 102, 100, 56];
    const markup = renderToStaticMarkup(
      createElement(Router, {
        ssrPath: "/chains/test",
        children: createElement(RegistrationShare, {
          chain: "arc",
          share: registrationShare(counts.map((count, index) => wallet(`w${index}`, count, "arc")), 385_752, 7)!,
          asOf: "2026-11-06T09:07:00Z",
          selectedId: null,
          onSelect: noop,
        }),
      })
    );
    expect(markup).toContain("<strong>0.6 percent</strong> of the 385,752 registrations on Arc are recorded against 7 registering wallets.");
    expect(markup).toContain("The other 383,346 are recorded against wallets with fewer than 50 each.");
    expect(markup).toContain('class="cw-share-percent">0.3%<');
    expect(markup).toContain('class="cw-share-percent">0.2%<');
    expect(markup).toContain('class="cw-share-percent">&lt;0.1%<');
    expect(markup).not.toContain('class="cw-share-percent">0%<');
    expect(markup).not.toContain("<strong>0 percent</strong>");
  });

  describe("with registrations a host cap counted and did not store", () => {
    // Arc on 6 November 2026: 5,016 registrations stored and 380,736 counted past one host's cap, so the wallets are known for the stored ones only.
    const counts = [1_000, 868, 144, 136, 102, 100, 56];
    const arcShare = (listed: number, walletsMeetingRule: number, counted: number | null, held: number[] = counts) =>
      renderToStaticMarkup(
        createElement(Router, {
          ssrPath: "/chains/test",
          children: createElement(RegistrationShare, {
            chain: "arc",
            share: registrationShare(held.map((count, index) => wallet(`w${index}`, count, "arc")), listed, walletsMeetingRule, counted)!,
            asOf: "2026-11-06T09:07:00Z",
            selectedId: null,
            onSelect: noop,
          }),
        })
      );

    it("does not put them against wallets with fewer than 50 each, and says no wallet is recorded for them", () => {
      const markup = arcShare(385_752, 7, 380_736);
      expect(markup).toContain("Of the other 383,346, 2,610 are recorded against wallets with fewer than 50 each, and 380,736 were counted by host name and not stored, so no wallet is recorded for them.");
      expect(markup).not.toContain("The other 383,346 are recorded against wallets");
      expect(markup).toContain("Every other registration");
      expect(markup).not.toContain("Every other wallet");
      // the headline and the chips are the wallets' own figures and do not change
      expect(markup).toContain("<strong>0.6 percent</strong> of the 385,752 registrations on Arc are recorded against 7 registering wallets.");
    });

    it("says every other wallet, not wallets with fewer than 50, when more wallets meet the rule than are drawn", () => {
      expect(arcShare(385_752, 9, 380_736)).toContain("Of the other 383,346, 2,610 are recorded against every other wallet, and 380,736 were counted by host name and not stored, so no wallet is recorded for them.");
    });

    it("says the whole rest was counted when no stored registration is left over", () => {
      const markup = arcShare(1_060, 1, 1_000, [60]);
      expect(markup).toContain("The other 1,000 were counted by host name and not stored, so no wallet is recorded for them.");
      expect(markup).not.toContain("Of the other");
    });

    it("keeps the sentence it had when nothing was counted", () => {
      for (const none of [0, null]) {
        const markup = arcShare(385_752, 7, none);
        expect(markup).toContain("The other 383,346 are recorded against wallets with fewer than 50 each.");
        expect(markup).toContain("Every other wallet");
        expect(markup).not.toContain("were counted by host name");
      }
    });
  });

  it("words a share under a tenth of a percent as less than a tenth, not as zero", () => {
    const markup = renderToStaticMarkup(
      createElement(Router, {
        ssrPath: "/chains/test",
        children: createElement(RegistrationShare, { chain: "arc", share: registrationShare([wallet("a", 50, "arc")], 100_000, 1)!, asOf: "2026-11-06T09:07:00Z", selectedId: null, onSelect: noop }),
      })
    );
    expect(markup).toContain("<strong>Less than 0.1 percent</strong> of the 100,000 registrations on Arc are recorded against 1 registering wallet.");
    expect(markup).not.toContain("<strong>0 percent</strong>");
  });

  it("draws the Arc event rail from its feed: the listed entry, the block and the coverage, and never says the feed is missing", () => {
    const arcEvent: ChainWorldEvent = { ...event, id: "erc8004_arc:0xabc:1", entryId: "arc-entry-1", name: "Agent #7", protocol: "erc8004_arc", kind: "register", label: "Identity registered", height: 29085340, heightLabel: "Block", transaction: "0xabc", from: null, to: "0xowner", observedAt: null };
    const draw = (events: ChainWorldEvent[], status: "ready" | "unavailable" = "ready") =>
      renderToStaticMarkup(createElement(ChainEventRail, { chain: "arc", events, activeId: null, playing: false, onSelect: noop, onTogglePlayback: noop, motionReduced: false, status, coverage: "Listed entries · measured through block 29,085,340" }));
    const markup = draw([arcEvent]);
    for (const fact of ["Listed entries · measured through block 29,085,340", "Agent #7", "Identity registered", "29085340", "1 events in this feed", "/agents/arc-entry-1"]) expect(markup).toContain(fact);
    expect(markup).not.toMatch(/Global feed unavailable|No global Arc|Select an entry/);
    // A feed with nothing in it is not a zero count, and it is not a missing feed either.
    const empty = draw([]);
    expect(empty).toContain("No recorded activity in this feed. This is not a live zero.");
    expect(empty).not.toMatch(/Global feed unavailable|No global Arc|Select an entry|0 events in this feed/);
    expect(draw([], "unavailable")).toContain("Recorded activity is unavailable. No event count is shown in its place.");
  });

  it("words the Ethereum event rail's missing feed as Ethereum's, with no census to point at and no entry to select", () => {
    const markup = renderToStaticMarkup(createElement(ChainEventRail, { chain: "ethereum", events: [], activeId: null, playing: false, onSelect: noop, onTogglePlayback: noop, motionReduced: false, status: "unsupported", coverage: "Global feed not published" }));
    expect(markup).toContain("No global Ethereum activity feed is published. No event is shown in its place.");
    expect(markup).not.toMatch(/BNB|Base|Arc|census|Select an entry/);
    expect(markup).toContain("Ethereum");
  });

  it("words the Monad event rail's missing feed as Monad's, with no census to point at and no entry to select", () => {
    const markup = renderToStaticMarkup(createElement(ChainEventRail, { chain: "monad", events: [], activeId: null, playing: false, onSelect: noop, onTogglePlayback: noop, motionReduced: false, status: "unsupported", coverage: "Global feed not published" }));
    expect(markup).toContain("No global Monad activity feed is published. No event is shown in its place.");
    expect(markup).not.toMatch(/BNB|Base|Arc|census|Select an entry/);
    expect(markup).toContain("Monad");
  });

  it("words the Gnosis event rail's missing feed as Gnosis's, with no census to point at and no entry to select", () => {
    const markup = renderToStaticMarkup(createElement(ChainEventRail, { chain: "gnosis", events: [], activeId: null, playing: false, onSelect: noop, onTogglePlayback: noop, motionReduced: false, status: "unsupported", coverage: "Global feed not published" }));
    expect(markup).toContain("No global Gnosis activity feed is published. No event is shown in its place.");
    expect(markup).not.toMatch(/BNB|Base|Arc|Monad|census|Select an entry/);
    expect(markup).toContain("Gnosis");
  });
});
