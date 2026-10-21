import { describe, expect, it } from "vitest";
import { NAME_URI_MAX_CHARS, ENTRY_PLACEHOLDER_PATTERN, entryNameNote, entryUriFacts, linkHost, pickBalanced, uriHashOf } from "./robinhoodNamesCore";

/** The pure rules of the entries part of the Robinhood name step. The database and chain parts are in robinhoodEntryNames.integration.test.ts. */
const CID = "QmcsZip4oMCkS8UhrXDmG2Bo1WMaJzbQa35RX2h5QRn1xx";
const inline = (record: Record<string, unknown>) => `data:application/json;base64,${Buffer.from(JSON.stringify(record)).toString("base64")}`;

describe("what a tokenURI is", () => {
  it("is no link when it is empty, or when the read failed or did not decode, and both hash as the empty link", () => {
    expect(entryUriFacts("")).toEqual({ kind: "empty", uriHash: uriHashOf("") });
    expect(entryUriFacts(null)).toEqual({ kind: "empty", uriHash: uriHashOf("") });
    expect(uriHashOf("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("is a link to read when it is an https address, or an ipfs address with a CID", () => {
    expect(entryUriFacts("https://registrations.example/robinhood/8631.json")).toEqual({ kind: "web", uriHash: uriHashOf("https://registrations.example/robinhood/8631.json"), uri: "https://registrations.example/robinhood/8631.json" });
    expect(entryUriFacts(`ipfs://${CID}`)).toMatchObject({ kind: "ipfs", uri: `ipfs://${CID}` });
    expect(entryUriFacts(`ipfs://${CID}/metadata.json`)).toMatchObject({ kind: "ipfs" });
  });

  it("is left alone when it is an http address, another scheme, an ipfs address with no CID, or too long for the table", () => {
    for (const uri of ["http://plain.example/a.json", "ftp://x.example/a", "ipfs://placeholder/7", "ipfs://", "not a link at all", `https://long.example/${"a".repeat(NAME_URI_MAX_CHARS)}`]) {
      expect(entryUriFacts(uri), uri.slice(0, 40)).toEqual({ kind: "other", uriHash: uriHashOf(uri) });
    }
  });

  it("is decoded in place when it is inline JSON, with the name it carries, or none when it does not parse or has no name", () => {
    expect(entryUriFacts(inline({ name: "Tinsel Bot", description: "x" }))).toMatchObject({ kind: "inline", name: "Tinsel Bot" });
    expect(entryUriFacts(inline({ description: "no name" }))).toMatchObject({ kind: "inline", name: null });
    expect(entryUriFacts("data:application/json,%7Bnot-json")).toMatchObject({ kind: "inline", name: null });
  });
});

describe("pacing the reads", () => {
  const link = (host: string, n: number) => ({ uri: `https://${host}/${n}.json`, kind: "web" as const, n });
  const ipfs = (n: number) => ({ uri: `ipfs://${CID}/${n}`, kind: "ipfs" as const, n });

  it("names the host a read is addressed to: the web host, lower case, and one name for everything asked of the gateway", () => {
    expect(linkHost("https://Registrations.Example/robinhood/1.json", "web")).toBe("registrations.example");
    expect(linkHost(`ipfs://${CID}`, "ipfs")).toBe("ipfs");
    expect(linkHost("not a url", "web")).toBe("");
  });

  it("takes at most the limit, in the order given", () => {
    const list = [1, 2, 3, 4, 5].map(n => link(`h${n}.example`, n));
    expect(pickBalanced(list, 3, 6).map(item => item.n)).toEqual([1, 2, 3]);
    expect(pickBalanced(list, 0, 6)).toEqual([]);
  });

  it("takes at most a few from any one host, so one platform does not use the whole run and the other hosts are not starved behind it", () => {
    const big = Array.from({ length: 20 }, (_, i) => link("platform.example", i));
    const small = [link("small-a.example", 100), link("small-b.example", 101)];
    const picked = pickBalanced([...big, ...small], 10, 6);
    expect(picked.filter(item => item.uri.includes("platform.example")).length).toBe(6);
    expect(picked.map(item => item.n)).toEqual([0, 1, 2, 3, 4, 5, 100, 101]);
  });

  it("counts every ipfs link as one host, since they are all asked of the same gateway", () => {
    const picked = pickBalanced(Array.from({ length: 10 }, (_, i) => ipfs(i)), 10, 4);
    expect(picked.length).toBe(4);
  });
});

describe("the entry's note and its placeholder", () => {
  it("says when the name was read and that it is the registrant's own claim", () => {
    expect(entryNameNote("2026-10-17")).toBe(" Its name was read from its registration link on 2026-10-17; it is the registrant's own claim.");
  });

  it("matches the placeholder of a registration and nothing else", () => {
    const pattern = new RegExp(ENTRY_PLACEHOLDER_PATTERN);
    for (const name of ["Agent #8623", "Agent #0", "Agent #123456"]) expect(pattern.test(name), name).toBe(true);
    for (const name of ["agent #8623", "Agent 8623", "Agent #", "Agent #12a", "Agent #1 two", "Mark", " Agent #1"]) expect(pattern.test(name), name).toBe(false);
  });
});
