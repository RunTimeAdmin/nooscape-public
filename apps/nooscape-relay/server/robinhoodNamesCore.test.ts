import { describe, expect, it } from "vitest";
import { ROBINHOOD_IDENTITY_REGISTRY } from "./ingestion/robinhood";
import { RESOLUTION_FAILED_MAX_ATTEMPTS, RESOLUTION_NO_NAME_MAX_ATTEMPTS } from "./ingestion/registrationFetch";
import {
  NAME_RETRY_AFTER_MS,
  NAME_URI_MAX_CHARS,
  nameableRecord,
  namesToRead,
  overlayResolvedNames,
  ROBINHOOD_EXTERNAL_PREFIX,
  SHOWN_NAME_MAX_CHARS,
  uriHashOf,
  type NameableRecord,
  type PriorAttempt,
} from "./robinhoodNamesCore";

/** The pure rules of the Robinhood name reads. The database and fetch parts are in robinhoodNames.integration.test.ts. */
const CID = "QmcsZip4oMCkS8UhrXDmG2Bo1WMaJzbQa35RX2h5QRn1xx";
/** A reviewed Robinhood record's public summary, as the live site serves it for a record whose registration carries a link. */
const summary = (id: number | string, uri: string) =>
  `Registered as agent ${id} in the Robinhood Chain ERC-8004 identity registry (eip155:4663, AgentIdentity/AGENT). Registry-recorded URI at registration: ${uri} Nooscape retained the registration event; ownership, URI, and self-asserted metadata remain unverified assertions.`;
const record = (id: number, uri: string, overrides: Partial<{ agentId: string; displayName: string; untrustedSummary: string | null }> = {}) => ({
  agentId: `agent-${id}`,
  displayName: `Agent #${id}`,
  untrustedSummary: summary(id, uri),
  ...overrides,
});

describe("which records have a link to read", () => {
  it("finds a placeholder name and the https link the summary names", () => {
    const target = nameableRecord(record(8631, "https://musegod.example/muse/98.json"));
    expect(target).toEqual({
      agentId: "agent-8631",
      externalKey: `${ROBINHOOD_EXTERNAL_PREFIX}8631`,
      uri: "https://musegod.example/muse/98.json",
      kind: "web",
      uriHash: uriHashOf("https://musegod.example/muse/98.json"),
    });
  });

  it("finds an ipfs link that has a CID in it, and no other ipfs link", () => {
    expect(nameableRecord(record(8627, `ipfs://${CID}`))).toMatchObject({ kind: "ipfs", uri: `ipfs://${CID}` });
    expect(nameableRecord(record(8627, `ipfs://${CID}/metadata.json`))).toMatchObject({ kind: "ipfs" });
    expect(nameableRecord(record(8627, "ipfs://placeholder/7"))).toBeNull();
    expect(nameableRecord(record(8627, "ipfs://"))).toBeNull();
  });

  it("leaves alone a link that is not https or ipfs, and a link too long for the table", () => {
    expect(nameableRecord(record(1, "http://plain.example/a.json"))).toBeNull();
    expect(nameableRecord(record(1, "data:application/json;base64,eyJuYW1lIjoiQSJ9"))).toBeNull();
    expect(nameableRecord(record(1, "ftp://x.example/a"))).toBeNull();
    const long = `https://long.example/${"a".repeat(NAME_URI_MAX_CHARS)}`;
    expect(nameableRecord(record(1, long))).toBeNull();
    expect(nameableRecord(record(1, `https://ok.example/${"a".repeat(NAME_URI_MAX_CHARS - 19)}`))).not.toBeNull();
  });

  it("leaves alone a record that has a name of its own, no recorded link, or is not a Robinhood registration", () => {
    expect(nameableRecord(record(5, "https://a.example/x.json", { displayName: "Passkeys" }))).toBeNull();
    expect(nameableRecord(record(5, "https://a.example/x.json", { displayName: "agent #5" }))).toBeNull();
    expect(nameableRecord(record(5, "https://a.example/x.json", { untrustedSummary: null }))).toBeNull();
    const noLink = "Registered as agent 5 in the Robinhood Chain ERC-8004 identity registry (eip155:4663, AgentIdentity/AGENT). No URI was set at registration, so no self-description is available. Nooscape retained the registration event.";
    expect(nameableRecord(record(5, "x", { untrustedSummary: noLink }))).toBeNull();
    const other = summary(5, "https://a.example/x.json").replace("Robinhood Chain ERC-8004 identity registry", "BNB Smart Chain ERC-8004 identity registry");
    expect(nameableRecord(record(5, "x", { untrustedSummary: other }))).toBeNull();
  });

  it("will not borrow another registration's link: the number in the name is the agent id the summary names", () => {
    expect(nameableRecord(record(8631, "https://a.example/x.json", { untrustedSummary: summary(8632, "https://a.example/x.json") }))).toBeNull();
  });

  it("keys the registration as the directory does, and hashes the link as the Solana pass does", () => {
    expect(ROBINHOOD_EXTERNAL_PREFIX).toBe(`eip155:4663:${ROBINHOOD_IDENTITY_REGISTRY}:`);
    expect(uriHashOf("https://a.example/x.json")).toMatch(/^[0-9a-f]{64}$/);
    expect(uriHashOf("a")).toBe("ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
  });
});

describe("which links to read this run", () => {
  const target = (id: number): NameableRecord => ({ agentId: `agent-${id}`, externalKey: `${ROBINHOOD_EXTERNAL_PREFIX}${id}`, uri: `https://a.example/${id}.json`, kind: "web", uriHash: uriHashOf(`https://a.example/${id}.json`) });
  const now = Date.UTC(2026, 9, 17, 12, 0, 0);
  const old = new Date(now - NAME_RETRY_AFTER_MS - 1000);
  const recent = new Date(now - NAME_RETRY_AFTER_MS + 60_000);
  const limits = { failed: RESOLUTION_FAILED_MAX_ATTEMPTS, noName: RESOLUTION_NO_NAME_MAX_ATTEMPTS };
  const priors = (entries: Array<[NameableRecord, PriorAttempt]>) => new Map(entries.map(([candidate, prior]) => [candidate.uriHash, prior]));

  it("takes a link never tried, in agent order, and no more than the limit", () => {
    const list = [target(8700), target(9), target(8631)];
    expect(namesToRead(list, new Map(), now, 10, limits).map(item => item.agentId)).toEqual(["agent-9", "agent-8631", "agent-8700"]);
    expect(namesToRead(list, new Map(), now, 2, limits).map(item => item.agentId)).toEqual(["agent-9", "agent-8631"]);
    expect(namesToRead(list, new Map(), now, 0, limits)).toEqual([]);
  });

  it("never reads a resolved link again", () => {
    const a = target(1);
    expect(namesToRead([a], priors([[a, { status: "resolved", attempts: 1, lastAttemptAt: old }]]), now, 10, limits)).toEqual([]);
  });

  it("tries a link that did not answer again after six hours, up to the Solana reader's five tries", () => {
    const a = target(1);
    expect(namesToRead([a], priors([[a, { status: "failed", attempts: 1, lastAttemptAt: recent }]]), now, 10, limits)).toEqual([]);
    expect(namesToRead([a], priors([[a, { status: "failed", attempts: 1, lastAttemptAt: old }]]), now, 10, limits)).toEqual([a]);
    expect(namesToRead([a], priors([[a, { status: "failed", attempts: RESOLUTION_FAILED_MAX_ATTEMPTS - 1, lastAttemptAt: old }]]), now, 10, limits)).toEqual([a]);
    expect(namesToRead([a], priors([[a, { status: "failed", attempts: RESOLUTION_FAILED_MAX_ATTEMPTS, lastAttemptAt: old }]]), now, 10, limits)).toEqual([]);
  });

  it("confirms a file with no name once more, and then leaves it", () => {
    const a = target(1);
    expect(namesToRead([a], priors([[a, { status: "no_name", attempts: 1, lastAttemptAt: old }]]), now, 10, limits)).toEqual([a]);
    expect(namesToRead([a], priors([[a, { status: "no_name", attempts: 1, lastAttemptAt: recent }]]), now, 10, limits)).toEqual([]);
    expect(namesToRead([a], priors([[a, { status: "no_name", attempts: RESOLUTION_NO_NAME_MAX_ATTEMPTS, lastAttemptAt: old }]]), now, 10, limits)).toEqual([]);
  });
});

describe("laying a read name over the placeholder", () => {
  const link = "https://musegod.example/muse/98.json";
  const READ_AT = "2026-10-17T12:00:00.000Z";
  const resolved = (name: string, readAt: string | null = READ_AT) => new Map([[uriHashOf(link), { name, readAt }]]);

  it("replaces the placeholder of the record whose link was read, says when it was read, and changes nothing else about it", () => {
    const input = record(8631, link);
    const [shown] = overlayResolvedNames([input], resolved("Gelato · muse #98"));
    expect(shown).toEqual({ ...input, displayName: "Gelato · muse #98", nameReadAt: READ_AT });
    expect(input.displayName).toBe("Agent #8631");
    expect("nameReadAt" in input).toBe(false);
  });

  it("gives no read date to a record that did not get a name, and none when the time was not recorded", () => {
    const named = record(1, link, { displayName: "Mark" });
    expect("nameReadAt" in overlayResolvedNames([named], resolved("Gelato"))[0]!).toBe(false);
    const [shown] = overlayResolvedNames([record(2, link)], resolved("Gelato", null));
    expect(shown!.displayName).toBe("Gelato");
    expect("nameReadAt" in shown!).toBe(false);
  });

  it("leaves a record whose link was not read, a record with a name of its own, and a link another record names", () => {
    const named = record(1, link, { displayName: "Mark" });
    const unread = record(2, "https://other.example/2.json");
    const [a, b] = overlayResolvedNames([named, unread], resolved("Gelato"));
    expect(a).toBe(named);
    expect(b).toBe(unread);
  });

  it("returns the records unchanged when nothing was read", () => {
    const input = [record(1, link)];
    const output = overlayResolvedNames(input, new Map());
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
  });

  it("cleans the name like every public name and cuts it, and shows nothing for a name that cleans to nothing", () => {
    expect(overlayResolvedNames([record(1, link)], resolved("  Tin​sel\u0007   Bot  "))[0]!.displayName).toBe("Tinsel Bot");
    expect(overlayResolvedNames([record(1, link)], resolved("x".repeat(500)))[0]!.displayName).toBe("x".repeat(SHOWN_NAME_MAX_CHARS));
    expect(overlayResolvedNames([record(1, link)], resolved(" ​\u0007 "))[0]!.displayName).toBe("Agent #1");
  });
});
