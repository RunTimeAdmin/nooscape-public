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
    expect(markup).toContain('href="/field/arc-registry-2026-10-20"');
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

  it("words the Arc event rail's missing feed as Arc's, and does not borrow BNB Chain's census sentence", () => {
    const markup = renderToStaticMarkup(createElement(ChainEventRail, { chain: "arc", events: [], activeId: null, playing: false, onSelect: noop, onTogglePlayback: noop, motionReduced: false, status: "unsupported", coverage: "Global feed not published" }));
    expect(markup).toContain("No global Arc activity feed is published. No event is shown in its place. Select an entry to see the events recorded for it.");
    expect(markup).not.toMatch(/BNB|census/);
    expect(markup).toContain("Arc");
  });
});
