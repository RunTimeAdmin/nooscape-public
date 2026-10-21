import { describe, expect, it } from "vitest";
import type { PublicCatch } from "@shared/owlsCatch";
import {
  agentPath,
  ARCHIVE_PATH,
  cardState,
  catchPath,
  catchUrl,
  dateLabel,
  isToday,
  LINKS_SHOWN,
  linkedAgents,
  QUIET_COPY,
  SITE_ORIGIN,
  shareHref,
  shareText,
  type TodaysCatchPayload,
} from "./owlsCatchModel";

/**
 * What the Owl's Catch card and pages say and link to. The catch's own words come from the server, built from the
 * stored facts; these tests are about what the page does with them: which state it is in, the links it builds, and
 * that it never fills a gap with something it made up.
 */
const catchOf = (over: Partial<PublicCatch> = {}): PublicCatch => ({
  date: "2026-10-15",
  rule: "fleet",
  headline: "One registering wallet is recorded against 5,593 identities.",
  detail: "Wallet 0x62d3…575c. A registering wallet shows who registered, not who holds or runs the agents.",
  howWeKnow: "Chosen on 2026-10-15 (UTC) by a fixed rule, not by hand.",
  agents: Array.from({ length: 8 }, (_, index) => ({ id: `id-${index}`, name: `Agent ${index}` })),
  selectedAt: "2026-10-15T00:15:02.000Z",
  ...over,
});
const payload = (over: Partial<TodaysCatchPayload> = {}): TodaysCatchPayload => ({ date: "2026-10-15", status: "selected", today: catchOf(), latest: catchOf(), ...over });
const read = (data: TodaysCatchPayload | undefined, over: Partial<{ isLoading: boolean; isError: boolean }> = {}) => cardState({ isLoading: false, isError: false, data, ...over });

describe("the day's label and the links", () => {
  it("writes a date the way people read it, and returns anything else as it came", () => {
    expect(dateLabel("2026-10-15")).toBe("15 Oct 2026");
    expect(dateLabel("2026-01-05")).toBe("5 Jan 2026");
    expect(dateLabel("2026-12-31")).toBe("31 Dec 2026");
    expect(dateLabel("2026-13-01")).toBe("2026-13-01");
    expect(dateLabel("yesterday")).toBe("yesterday");
  });

  it("points a catch's address at the production site, under /catch", () => {
    expect(ARCHIVE_PATH).toBe("/catch");
    expect(catchPath("2026-10-15")).toBe("/catch/2026-10-15");
    expect(SITE_ORIGIN).toBe("https://nooscape.si");
    expect(catchUrl("2026-10-15")).toBe("https://nooscape.si/catch/2026-10-15");
  });

  it("links an identity by its id, safely encoded", () => {
    expect(agentPath("3d1f49bd-2d41-47d8-bf12-65d299fde22d")).toBe("/agents/3d1f49bd-2d41-47d8-bf12-65d299fde22d");
    expect(agentPath("a/b?c")).toBe("/agents/a%2Fb%3Fc");
  });

  it("links the first few identities, in the order the catch stored them", () => {
    expect(LINKS_SHOWN).toBe(5);
    const shown = linkedAgents(catchOf());
    expect(shown.map(agent => agent.id)).toEqual(["id-0", "id-1", "id-2", "id-3", "id-4"]);
    expect(linkedAgents(catchOf({ agents: [] }))).toEqual([]);
    expect(linkedAgents(catchOf({ agents: [{ id: "only", name: "Only one" }] }))).toHaveLength(1);
  });

  it("knows which catch is the one chosen for today", () => {
    expect(isToday(catchOf(), "2026-10-15")).toBe(true);
    expect(isToday(catchOf(), "2026-10-16")).toBe(false);
  });
});

describe("sharing on X", () => {
  it("starts a post with the day and the headline and links to the day's page, with no script and no SDK", () => {
    const view = catchOf();
    expect(shareText(view)).toBe("The Owl's Catch, 15 Oct 2026: One registering wallet is recorded against 5,593 identities.");
    expect(shareHref(view)).toBe(
      "https://x.com/intent/post?text=The%20Owl's%20Catch%2C%2015%20Oct%202026%3A%20One%20registering%20wallet%20is%20recorded%20against%205%2C593%20identities.&url=https%3A%2F%2Fnooscape.si%2Fcatch%2F2026-10-15",
    );
  });

  it("encodes what a headline could hold, so the link cannot be broken or extended by it", () => {
    const href = shareHref(catchOf({ headline: "a&b=c#d" }));
    const query = new URL(href).searchParams;
    expect(query.get("text")).toBe("The Owl's Catch, 15 Oct 2026: a&b=c#d");
    expect(query.get("url")).toBe("https://nooscape.si/catch/2026-10-15");
    expect([...query.keys()]).toEqual(["text", "url"]);
  });

  it("fits in a post: the day and a headline are far under the limit", () => {
    expect(shareText(catchOf()).length + 24).toBeLessThan(280);
  });
});

describe("the card's states", () => {
  it("is loading while the read is, whatever it holds", () => {
    expect(read(undefined, { isLoading: true })).toEqual({ kind: "loading" });
  });

  it("shows the catch when the day has one", () => {
    expect(read(payload())).toEqual({ kind: "catch", view: catchOf() });
  });

  it("says there is no catch today, and offers the newest that was found", () => {
    const latest = catchOf({ date: "2026-10-12", headline: "An earlier finding." });
    expect(read(payload({ status: "none", today: null, latest }))).toEqual({ kind: "quiet", reason: "none", latest });
    expect(QUIET_COPY.none.title).toBe("No catch today");
  });

  it("says today's catch is not chosen yet before the first check of the day", () => {
    expect(read(payload({ status: "pending", today: null }))).toMatchObject({ kind: "quiet", reason: "pending" });
    expect(QUIET_COPY.pending.title).toBe("Today's catch is not chosen yet");
  });

  it("says it cannot read the catch when the read failed or the server could not, and shows nothing in its place", () => {
    expect(read(undefined, { isError: true })).toEqual({ kind: "quiet", reason: "unavailable", latest: null });
    // A later read that failed does not leave the earlier catch up as if it were current.
    expect(read(payload(), { isError: true })).toEqual({ kind: "quiet", reason: "unavailable", latest: null });
    expect(read(undefined)).toEqual({ kind: "quiet", reason: "unavailable", latest: null });
    expect(read(payload({ status: "unavailable", today: null, latest: catchOf() }))).toEqual({ kind: "quiet", reason: "unavailable", latest: null });
  });

  it("never shows an empty day as a catch: a day that says it has one but holds none is unreadable", () => {
    expect(read(payload({ status: "selected", today: null }))).toMatchObject({ kind: "quiet", reason: "unavailable" });
  });

  it("states what is true in each quiet state, with no example, no figure and no long dash", () => {
    for (const [reason, copy] of Object.entries(QUIET_COPY)) {
      expect(copy.title.length, reason).toBeGreaterThan(5);
      expect(`${copy.title} ${copy.detail}`, reason).not.toMatch(new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]|\\d"));
    }
  });
});
