import { describe, expect, it } from "vitest";
import { placeholderSaidName } from "./ingestion/saidChain";
import type { DirectoryEntryDraft } from "./ingestion/types";
import { entryNameNote, SHOWN_NAME_MAX_CHARS, uriHashOf } from "./robinhoodNamesCore";
import { applySaidNames, queuedAt, readableLink, SAID_PLACEHOLDER_PATTERN, saidLinksToQueue, type SaidNameLink } from "./saidNamesCore";

const OWNER = "9XfABd6H8P2PLF7UjLk95WaPcdDqVi6714HRS1fsA6cj";
const CID = "QmcsZip4oMCkS8UhrXDmG2Bo1WMaJzbQa35RX2h5QRn1xx";
const card = (owner: string) => `https://api.saidprotocol.com/api/cards/${owner}.json`;
const link = (externalKey: string, uri: string, createdAtSeconds: number): SaidNameLink => ({ externalKey, uri, createdAtSeconds });

describe("the placeholder", () => {
  it("matches the name the pass gives an identity, for any owner wallet", () => {
    const pattern = new RegExp(SAID_PLACEHOLDER_PATTERN);
    for (const owner of [OWNER, "1nhWwCU1MvoVX7xHAoNfDaCfiLyRhKaP7KhBqdPCT1d", "A".repeat(44), "z".repeat(44)]) expect(placeholderSaidName(owner)).toMatch(pattern);
  });

  it("does not match a name that was read, or the other registries' placeholders", () => {
    const pattern = new RegExp(SAID_PLACEHOLDER_PATTERN);
    for (const name of ["Kirby", "MEME Factory", "SAID agent", "SAID agent 9Xf", "SAID agent 9XfABd6H8", "SAID agents 9XfABd6H", "Agent #12", "SAID agent 9XfABd6!"]) expect(name).not.toMatch(pattern);
  });
});

describe("which links are readable", () => {
  it("is an https address, or an ipfs address with a CID, that fits the column", () => {
    expect(readableLink(card(OWNER))).toBe("web");
    expect(readableLink(`ipfs://${CID}`)).toBe("ipfs");
    expect(readableLink(`https://example.com/${"a".repeat(600)}`)).toBeNull();
  });

  it("leaves out http, other schemes, an ipfs address with no CID, and nothing at all", () => {
    for (const uri of ["http://api.saidprotocol.com/api/cards/x.json", "ftp://example.com/a", "data:application/json,{}", "ipfs://not-a-cid", "", "javascript:alert(1)"]) expect(readableLink(uri), uri).toBeNull();
  });
});

describe("the links to queue", () => {
  it("are newest first, and ranked in that order", () => {
    const rows = saidLinksToQueue([link("old", card("old"), 100), link("new", card("new"), 300), link("mid", card("mid"), 200)], new Set());
    expect(rows.map(row => [row.externalKey, row.rank])).toEqual([["new", 0], ["mid", 1], ["old", 2]]);
    expect(rows[0]).toMatchObject({ uriKind: "web", uri: card("new"), uriHash: uriHashOf(card("new")) });
  });

  it("leaves out a link an earlier pass queued, one the reader cannot ask, and a repeat of a link", () => {
    const known = new Set([uriHashOf(card("seen"))]);
    const rows = saidLinksToQueue(
      [link("seen", card("seen"), 500), link("http", "http://example.com/a.json", 400), link("shared-1", "https://cards.example/shared.json", 300), link("shared-2", "https://cards.example/shared.json", 200), link("ipfs", `ipfs://${CID}`, 100)],
      known
    );
    expect(rows.map(row => row.externalKey)).toEqual(["shared-1", "ipfs"]);
    expect(rows.map(row => row.uriKind)).toEqual(["web", "ipfs"]);
    expect(rows.map(row => row.rank)).toEqual([0, 1]);
  });

  it("order identities registered in the same second by owner, so the order is the same on every pass", () => {
    const rows = saidLinksToQueue([link("b", card("b"), 5), link("a", card("a"), 5)], new Set());
    expect(rows.map(row => row.externalKey)).toEqual(["a", "b"]);
  });

  it("queues nothing for no links", () => {
    expect(saidLinksToQueue([], new Set())).toEqual([]);
  });

  it("dates a queued link from the start of time, in its rank order, so the oldest-first read takes the newest identity first", () => {
    expect(queuedAt(0).getTime()).toBe(1000);
    expect(queuedAt(3).getTime()).toBe(4000);
    expect(queuedAt(-2).getTime()).toBe(1000);
    // Whatever its rank, a link never tried is due at once: far older than the six hours a failed one waits.
    expect(Date.now() - queuedAt(50_000).getTime()).toBeGreaterThan(6 * 60 * 60 * 1000);
  });
});

describe("laying names over the pass's drafts", () => {
  const draft = (owner: string, uri: string): DirectoryEntryDraft => ({
    externalKey: owner,
    displayName: placeholderSaidName(owner),
    locatorHost: "api.saidprotocol.com",
    registrant: owner,
    accountPubkey: "P".repeat(44),
    profileUriHash: uriHashOf(uri),
    sourceSignalNote: "SAID registry account (layout v3, registered 2026-03-03) · badge: no · chain facts as recorded, not scored",
  });

  it("gives a draft the name read from its link, with the sentence that says where it came from and when", () => {
    const drafts = [draft(OWNER, card(OWNER))];
    const [named] = applySaidNames(drafts, new Map([[uriHashOf(card(OWNER)), { name: "Kirby", readOn: "2026-10-18" }]]));
    expect(named!.displayName).toBe("Kirby");
    expect(named!.sourceSignalNote).toBe(`${drafts[0]!.sourceSignalNote}${entryNameNote("2026-10-18")}`);
    expect(named!.sourceSignalNote).toContain("it is the registrant's own claim");
    // The other facts of the draft are the pass's, and untouched.
    expect(named).toMatchObject({ externalKey: OWNER, registrant: OWNER, locatorHost: "api.saidprotocol.com", profileUriHash: drafts[0]!.profileUriHash });
  });

  it("does not change the drafts it was given, and leaves a draft with no name read as it was", () => {
    const named = draft(OWNER, card(OWNER));
    const other = draft("other", card("other"));
    const before = JSON.stringify([named, other]);
    const out = applySaidNames([named, other], new Map([[named.profileUriHash!, { name: "Kirby", readOn: "2026-10-18" }]]));
    expect(JSON.stringify([named, other])).toBe(before);
    expect(out[1]).toBe(other);
    expect(out[1]!.displayName).toBe(placeholderSaidName("other"));
  });

  it("gives an identity that has changed its link no name until the new link is read", () => {
    const resolved = new Map([[uriHashOf(card(OWNER)), { name: "Kirby", readOn: "2026-10-18" }]]);
    const [moved] = applySaidNames([draft(OWNER, "https://elsewhere.example/card.json")], resolved);
    expect(moved!.displayName).toBe(placeholderSaidName(OWNER));
  });

  it("cleans a name and cuts it to the length that is shown, and leaves the placeholder when a name cleans to nothing", () => {
    const uri = card(OWNER);
    const hash = uriHashOf(uri);
    const [long] = applySaidNames([draft(OWNER, uri)], new Map([[hash, { name: `  ${"N".repeat(300)}​ `, readOn: "2026-10-18" }]]));
    expect(long!.displayName).toBe("N".repeat(SHOWN_NAME_MAX_CHARS));
    const [empty] = applySaidNames([draft(OWNER, uri)], new Map([[hash, { name: " ​\u0007 ", readOn: "2026-10-18" }]]));
    expect(empty!.displayName).toBe(placeholderSaidName(OWNER));
    expect(empty!.sourceSignalNote).not.toContain("registrant's own claim");
  });

  it("keeps the note within the column", () => {
    const uri = card(OWNER);
    const long = { ...draft(OWNER, uri), sourceSignalNote: "x".repeat(500) };
    const [named] = applySaidNames([long], new Map([[uriHashOf(uri), { name: "Kirby", readOn: "2026-10-18" }]]));
    expect(named!.sourceSignalNote!.length).toBe(512);
  });

  it("returns a copy, with nothing changed, when no name has been read", () => {
    const drafts = [draft(OWNER, card(OWNER))];
    const out = applySaidNames(drafts, new Map());
    expect(out).toEqual(drafts);
    expect(out).not.toBe(drafts);
  });
});
