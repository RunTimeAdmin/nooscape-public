import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FLEET_MIN } from "@shared/noosphere";
import { bscExternalKey } from "./ingestion/bscChain";
import { agentIdOfKey, CLUSTER_MIN, ENDPOINT_HOST_RULE, endpointHostGroups, evidenceFromFile, evidenceFromUri, groupEvidence, isReadStatus, TEMPLATE_MIN, templateLabelMember, type EndpointHostRow, type EvidenceRow } from "./bscClusters";

/** The pure rules of the BNB clustering. The database and chain parts are in bscClusteringRun.integration.test.ts. */
const inline = (record: Record<string, unknown>) => `data:application/json;base64,${Buffer.from(JSON.stringify(record)).toString("base64")}`;
const WALLET = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const key = (n: number) => bscExternalKey(`${n}`);

describe("the bars", () => {
  it("are the fleet minimum and two listed entries", () => {
    expect(CLUSTER_MIN).toBe(FLEET_MIN);
    expect(TEMPLATE_MIN).toBe(2);
  });
});

describe("the evidence a link gives", () => {
  it("reads inline JSON: the template key and the host of the first agent address", () => {
    const uri = inline({ name: "Trader Bot 7", description: "Swaps tokens", services: [{ name: "A2A", endpoint: "https://bots.example.io/a2a" }] });
    const facts = evidenceFromUri(uri, "7");
    expect(facts.readStatus).toBe("inline");
    expect(facts.endpointHost).toBe("bots.example.io");
    expect(facts.templateKey).toMatch(/^[0-9a-f]{16}$/);
  });

  it("gives two registrations of one text on one host the same key, and any difference another", () => {
    const base = { description: "Swaps tokens", services: [{ name: "web", endpoint: "https://bots.example.io/a" }] };
    const a = evidenceFromUri(inline({ ...base, name: "Trader Bot 7" }), "7");
    const b = evidenceFromUri(inline({ ...base, name: "trader bot 12", image: "https://x.example/i.png" }), "12");
    const c = evidenceFromUri(inline({ ...base, name: "Trader Bot 7", description: "Swaps coins" }), "9");
    expect(a.templateKey).toBe(b.templateKey);
    expect(a.templateKey).not.toBe(c.templateKey);
    expect(a.profileUriHash).not.toBe(b.profileUriHash);
  });

  it("does not read a web or ipfs link, and says it did not", () => {
    for (const uri of ["https://a.example.io/agent.json", "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"]) {
      expect(evidenceFromUri(uri, "1")).toMatchObject({ readStatus: "link_not_read", templateKey: null, endpointHost: null });
    }
  });

  it("marks inline JSON that does not parse as unreadable, and keeps the hash of what it was given", () => {
    const facts = evidenceFromUri("data:application/json,%7Bnot-json", "1");
    expect(facts).toMatchObject({ readStatus: "unreadable", templateKey: null });
    expect(facts.profileUriHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("has a key for a registration with a name and no address", () => {
    expect(evidenceFromUri(inline({ name: "Lone Agent" }), "3")).toMatchObject({ readStatus: "inline", endpointHost: null, templateKey: expect.stringMatching(/^[0-9a-f]{16}$/) });
  });
});

describe("gate G1 over the listed entries", () => {
  const row = (n: number, overrides: Partial<EvidenceRow> = {}): EvidenceRow => ({ externalKey: key(n), registrant: WALLET(n), readStatus: "inline", templateKey: `k${n}`, ...overrides });

  it("calls an entry with a key of its own independent, two with one key a template group, and an unread one unread", () => {
    const { byKey, templates } = groupEvidence(
      [row(1, { templateKey: "same" }), row(2, { templateKey: "same" }), row(3), row(4, { readStatus: "link_not_read", templateKey: null }), row(5, { readStatus: "unreadable", templateKey: null })],
      new Map()
    );
    expect(Object.fromEntries(Array.from(byKey, ([id, value]) => [id, [value.g1, value.templateSize]]))).toEqual({
      [key(1)]: ["template_group", 2],
      [key(2)]: ["template_group", 2],
      [key(3)]: ["independent", 1],
      [key(4)]: ["unread", 1],
      [key(5)]: ["unread", 1],
    });
    expect(templates).toEqual([{ key: "same", members: [key(1), key(2)] }]);
  });

  it("does not group unread entries by a template key they may carry", () => {
    const { byKey } = groupEvidence([row(1, { templateKey: "same" }), row(2, { templateKey: "same", readStatus: "link_not_read" })], new Map());
    expect(byKey.get(key(1))?.g1).toBe("independent");
    expect(byKey.get(key(2))?.g1).toBe("unread");
  });

  it("makes a wallet with the fleet minimum a fleet, read or not, and records the wallet's count", () => {
    const sizes = new Map([[WALLET(1), FLEET_MIN], [WALLET(2), FLEET_MIN - 1], [WALLET(3), FLEET_MIN + 20]]);
    const { byKey, walletFleets } = groupEvidence([row(1), row(2), row(3, { readStatus: "link_not_read", templateKey: null })], sizes);
    expect(byKey.get(key(1))).toEqual({ g1: "wallet_fleet", templateSize: 1, walletRegistrations: FLEET_MIN });
    expect(byKey.get(key(2))).toEqual({ g1: "independent", templateSize: 1, walletRegistrations: FLEET_MIN - 1 });
    expect(byKey.get(key(3))?.g1).toBe("wallet_fleet");
    expect(walletFleets.map(group => group.key)).toEqual([WALLET(1), WALLET(3)]);
  });

  it("matches the measurement: the same inputs give B1's counts", () => {
    // 3 entries of one template, 2 of another, 5 alone: 5 entries in 2 groups, 5 independent.
    const rows = [1, 2, 3].map(n => row(n, { templateKey: "a" })).concat([4, 5].map(n => row(n, { templateKey: "b" })), [6, 7, 8, 9, 10].map(n => row(n)));
    const { byKey, templates } = groupEvidence(rows, new Map());
    const values = Array.from(byKey.values());
    expect(templates.length).toBe(2);
    expect(values.filter(value => value.g1 === "template_group").length).toBe(5);
    expect(values.filter(value => value.g1 === "independent").length).toBe(5);
  });
});

describe("the agent id in a directory key", () => {
  it("is read from a BNB key and from nothing else", () => {
    expect(agentIdOfKey(bscExternalKey("123456"))).toBe("123456");
    expect(agentIdOfKey("eip155:1:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432:7")).toBeNull();
    expect(agentIdOfKey("eip155:56:0xabc:7")).toBeNull();
    expect(agentIdOfKey("eip155:56:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432:-1")).toBeNull();
    expect(agentIdOfKey("eip155:56:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432:7; DROP")).toBeNull();
  });
});

describe("a template group's label", () => {
  const member = (n: number, displayName: string) => ({ externalKey: key(n), displayName });
  const members = [member(9, "Trader Bot 9"), member(10, "Trader Bot 10"), member(2, "Trader Bot 2"), member(1, "Agent #1")];

  it("is the name of the lowest agent id that has one, compared as a number", () => {
    expect(templateLabelMember(members)?.displayName).toBe("Trader Bot 2");
  });

  it("does not depend on the order the members come in", () => {
    const orders = [members, [...members].reverse(), [members[2]!, members[0]!, members[3]!, members[1]!], [members[1]!, members[3]!, members[0]!, members[2]!]];
    for (const order of orders) expect(templateLabelMember(order)?.displayName).toBe("Trader Bot 2");
  });

  it("is nothing when no member has a name of its own, and leaves the list as it was", () => {
    expect(templateLabelMember([member(1, "Agent #1"), member(2, "Agent #2")])).toBeUndefined();
    const list = [...members];
    templateLabelMember(list);
    expect(list.map(entry => entry.externalKey)).toEqual(members.map(entry => entry.externalKey));
  });
});

describe("the endpoint-host rule", () => {
  const row = (n: number, host: string | null, overrides: Partial<EndpointHostRow> = {}): EndpointHostRow => ({ registrant: WALLET(n), readStatus: "inline", endpointHost: host, ...overrides });
  const many = (count: number, host: string, from = 1) => Array.from({ length: count }, (_, index) => row(from + index, host));

  it("is version 1 of 2026-10-17, at the fleet bar", () => {
    expect(ENDPOINT_HOST_RULE).toEqual({ version: "endpoint-host/1", date: "2026-10-17", min: FLEET_MIN });
  });

  it("stores a host at the bar and not one below it, in host order, with the entries and the wallets behind it", () => {
    const rows = [...many(50, "b.example.io", 1), ...many(49, "c.example.io", 100), ...many(51, "a.example.io", 200)];
    expect(endpointHostGroups(rows)).toEqual([
      { host: "a.example.io", listedCount: 51, walletCount: 51 },
      { host: "b.example.io", listedCount: 50, walletCount: 50 },
    ]);
  });

  it("counts a wallet once however many entries it has on the host", () => {
    const rows = [...many(50, "a.example.io", 1), row(1, "a.example.io"), row(1, "a.example.io")];
    expect(endpointHostGroups(rows)).toEqual([{ host: "a.example.io", listedCount: 52, walletCount: 50 }]);
  });

  it("counts only entries read from the link itself, and only those that declare a host", () => {
    const rows = [...many(49, "a.example.io", 1), row(500, "a.example.io", { readStatus: "link_not_read" }), row(501, "a.example.io", { readStatus: "unreadable" }), row(502, null), row(503, null, { readStatus: "link_not_read" })];
    expect(endpointHostGroups(rows)).toEqual([]);
    expect(endpointHostGroups([...rows, row(504, "a.example.io")])).toEqual([{ host: "a.example.io", listedCount: 50, walletCount: 50 }]);
  });

  it("takes the bar as an argument for a test, and finds nothing in no rows", () => {
    expect(endpointHostGroups(many(3, "a.example.io"), 3)).toEqual([{ host: "a.example.io", listedCount: 3, walletCount: 3 }]);
    expect(endpointHostGroups([])).toEqual([]);
  });
});

describe("who reads the endpoint-host groups", () => {
  it("is the clustering step alone: the map, the key's total and every page read bsc_clusters only, so the groups draw no light", () => {
    const readers: string[] = [];
    for (const root of ["server", "client/src", "shared"]) {
      for (const name of readdirSync(root, { recursive: true }) as string[]) {
        if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
        const file = path.join(root, name).replace(/\\/g, "/");
        if (/bscEndpointHostGroups|bsc_endpoint_host_groups/.test(readFileSync(file, "utf8"))) readers.push(file);
      }
    }
    // dbMigrations.ts only names the table in the comment on the manual list.
    expect(readers.sort()).toEqual(["server/bscClusteringRun.ts", "server/dbMigrations.ts"]);
  });
});

describe("the registration file behind a web or ipfs link", () => {
  const file = (record: Record<string, unknown>) => JSON.stringify(record);
  const HASH = "a".repeat(64);

  it("gives the evidence of an entry the same template key and host as the same registration held inline", () => {
    const record = { name: "Trader Bot 7", description: "Swaps tokens", services: [{ name: "web", endpoint: "https://bots.example.io/api" }] };
    const fetched = evidenceFromFile(file(record), "7", HASH);
    const inlineFacts = evidenceFromUri(inline(record), "7");
    expect(fetched).toMatchObject({ readStatus: "fetched", endpointHost: "bots.example.io", profileUriHash: HASH });
    expect(fetched.templateKey).toBe(inlineFacts.templateKey);
    expect(fetched.endpointHost).toBe(inlineFacts.endpointHost);
  });

  it("is a file that is not a registration when it does not parse or is not an object, and keeps the hash", () => {
    for (const text of ["<html>not json</html>", "[1,2,3]", "42", ""]) {
      expect(evidenceFromFile(text, "7", HASH), text.slice(0, 12)).toEqual({ readStatus: "link_unparsed", templateKey: null, endpointHost: null, profileUriHash: HASH });
    }
  });

  it("is read when it carries no name and no description, and has no template key to compare", () => {
    expect(evidenceFromFile(file({ services: [] }), "7", HASH)).toMatchObject({ readStatus: "fetched", templateKey: null });
  });

  it("counts as read in gate G1 beside an inline registration, so a file and an inline entry with one template are a template group", () => {
    expect(isReadStatus("inline")).toBe(true);
    expect(isReadStatus("fetched")).toBe(true);
    for (const status of ["link_not_read", "link_failed_1", "link_unparsed_2", "link_not_fetchable", "unreadable", ""]) expect(isReadStatus(status), status).toBe(false);
    const row = (n: number, overrides: Partial<EvidenceRow> = {}): EvidenceRow => ({ externalKey: key(n), registrant: WALLET(n), readStatus: "inline", templateKey: `k${n}`, ...overrides });
    const { byKey, templates } = groupEvidence([row(1, { templateKey: "same" }), row(2, { readStatus: "fetched", templateKey: "same" }), row(3, { readStatus: "fetched", templateKey: "alone" }), row(4, { readStatus: "link_failed_2", templateKey: null })], new Map());
    expect(Object.fromEntries(Array.from(byKey, ([id, value]) => [id, value.g1]))).toEqual({
      [key(1)]: "template_group",
      [key(2)]: "template_group",
      [key(3)]: "independent",
      [key(4)]: "unread",
    });
    expect(templates).toEqual([{ key: "same", members: [key(1), key(2)] }]);
  });

  it("counts toward the endpoint-host rule like an inline registration, and a file that was not read does not", () => {
    const rows: EndpointHostRow[] = [
      ...Array.from({ length: 30 }, (_, i) => ({ registrant: WALLET(i), readStatus: "inline", endpointHost: "platform.example.io" })),
      ...Array.from({ length: 20 }, (_, i) => ({ registrant: WALLET(100 + i), readStatus: "fetched", endpointHost: "platform.example.io" })),
      ...Array.from({ length: 5 }, (_, i) => ({ registrant: WALLET(200 + i), readStatus: "link_unparsed_1", endpointHost: "platform.example.io" })),
    ];
    expect(endpointHostGroups(rows)).toEqual([{ host: "platform.example.io", listedCount: 50, walletCount: 50 }]);
    expect(endpointHostGroups(rows.slice(0, 49))).toEqual([]);
  });
});
