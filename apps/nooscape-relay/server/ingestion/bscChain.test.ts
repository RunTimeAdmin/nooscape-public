import { describe, expect, it } from "vitest";
import {
  BSC_CHAIN_ID,
  BSC_DEPLOY_BLOCK,
  BSC_IDENTITY_REGISTRY,
  BSC_IDENTITY_TOPIC_FILTER,
  BSC_MAX_LOG_RANGE,
  BSC_MAX_WINDOW_LOGS,
  BSC_REGISTERED_TOPIC,
  BSC_TRANSFER_TOPIC,
  BSC_URI_UPDATED_TOPIC,
  BscRegistryValidationError,
  bscCursorFor,
  bscDirectoryDraft,
  bscExternalKey,
  bscHasProfileLink,
  bscUriFacts,
  decodeBscRegisteredLog,
  decodeBscUriUpdatedLog,
  parseBscCursor,
  parseBscWindowLogs,
  planBscWindows,
} from "./bscChain";
import { BNB_FETCH_SENTENCE } from "../bscSourceNote";
import { BSC_FIXTURE_MINTS, BSC_FIXTURE_REGISTERED, BSC_FIXTURE_SECONDARY, BSC_FIXTURE_URI_UPDATES } from "./bscFixtures";
import {
  decodeTransferActivityLog,
  ROBINHOOD_IDENTITY_REGISTRY,
  ROBINHOOD_REGISTERED_TOPIC,
  ROBINHOOD_TRANSFER_TOPIC,
  ROBINHOOD_URI_UPDATED_TOPIC,
} from "./robinhood";

/**
 * The BNB Smart Chain identity pass's pure core, checked against real registry
 * logs from the verified Phase 0 pull. Expected values in the fixtures come
 * from an independent Python decode, so these tests compare the adapter with
 * something other than itself.
 */
const WIDE = { fromBlock: 0, toBlock: Number.MAX_SAFE_INTEGER };

describe("constants", () => {
  it("shares the registry address and event topics with Robinhood Chain, which runs the same contract", () => {
    expect(BSC_IDENTITY_REGISTRY.toLowerCase()).toBe(ROBINHOOD_IDENTITY_REGISTRY.toLowerCase());
    expect(BSC_REGISTERED_TOPIC).toBe(ROBINHOOD_REGISTERED_TOPIC);
    expect(BSC_TRANSFER_TOPIC).toBe(ROBINHOOD_TRANSFER_TOPIC);
    expect(BSC_URI_UPDATED_TOPIC).toBe(ROBINHOOD_URI_UPDATED_TOPIC);
    expect(BSC_IDENTITY_TOPIC_FILTER).toEqual([[BSC_REGISTERED_TOPIC, BSC_TRANSFER_TOPIC, BSC_URI_UPDATED_TOPIC]]);
  });

  it("pins the chain, the deploy block, and the provider's range ceiling", () => {
    expect(BSC_CHAIN_ID).toBe(56);
    expect(BSC_DEPLOY_BLOCK).toBe(79_027_268);
    expect(BSC_MAX_LOG_RANGE).toBe(50_000);
    expect(bscExternalKey("373566")).toBe("eip155:56:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432:373566");
  });
});

describe("cursor", () => {
  it("starts a fresh source at the deploy block", () => {
    for (const cursor of [null, "", "   "]) expect(parseBscCursor(cursor)).toEqual({ nextBlock: BSC_DEPLOY_BLOCK });
  });

  it("round-trips a persisted position", () => {
    expect(parseBscCursor(bscCursorFor(127_000_000))).toEqual({ nextBlock: 127_000_000 });
    expect(parseBscCursor(` ${bscCursorFor(BSC_DEPLOY_BLOCK)} `)).toEqual({ nextBlock: BSC_DEPLOY_BLOCK });
  });

  it("fails closed on anything that is not an in-bounds position", () => {
    for (const cursor of ["bsc:", "bsc:abc", "bsc:-5", "rb:5000", "fw:85000000#0x" + "0a".repeat(32), "bsc:79027267", "bsc:99999999999999999999", "garbage"]) {
      expect(() => parseBscCursor(cursor)).toThrow(BscRegistryValidationError);
    }
  });
});

describe("window planning", () => {
  it("tiles ascending windows no wider than the provider ceiling, with no gap and no overlap", () => {
    const windows = planBscWindows(BSC_DEPLOY_BLOCK, BSC_DEPLOY_BLOCK + 173_456, 100);
    expect(windows[0]).toEqual({ from: BSC_DEPLOY_BLOCK, to: BSC_DEPLOY_BLOCK + 49_999 });
    expect(windows.at(-1)).toEqual({ from: BSC_DEPLOY_BLOCK + 150_000, to: BSC_DEPLOY_BLOCK + 173_456 });
    for (let index = 1; index < windows.length; index += 1) expect(windows[index]!.from).toBe(windows[index - 1]!.to + 1);
    for (const window of windows) expect(window.to - window.from + 1).toBeLessThanOrEqual(BSC_MAX_LOG_RANGE);
  });

  it("stops at the window budget and resumes exactly where it stopped", () => {
    const first = planBscWindows(BSC_DEPLOY_BLOCK, 127_000_000, 3);
    expect(first).toHaveLength(3);
    const next = planBscWindows(first.at(-1)!.to + 1, 127_000_000, 3);
    expect(next[0]!.from).toBe(BSC_DEPLOY_BLOCK + 150_000);
  });

  it("is empty when caught up and one block wide when exactly one block remains", () => {
    expect(planBscWindows(127_000_001, 127_000_000, 10)).toEqual([]);
    expect(planBscWindows(127_000_000, 127_000_000, 10)).toEqual([{ from: 127_000_000, to: 127_000_000 }]);
  });

  it("covers the whole range from deploy to a 2026-10 head in the number of calls the provider ceiling implies", () => {
    const windows = planBscWindows(BSC_DEPLOY_BLOCK, 127_478_516, 100_000);
    expect(windows).toHaveLength(Math.ceil((127_478_516 - BSC_DEPLOY_BLOCK + 1) / BSC_MAX_LOG_RANGE));
    // 48,451,249 blocks at 50,000 per call.
    expect(windows).toHaveLength(970);
  });
});

describe("Registered decoding against real registry logs", () => {
  for (const [name, { log, expected }] of Object.entries(BSC_FIXTURE_REGISTERED)) {
    it(`decodes the ${name} registration to exactly the facts the independent decode found`, () => {
      const registration = decodeBscRegisteredLog(log, WIDE);
      expect(registration).not.toBeNull();
      expect([registration!.agentId, registration!.owner, registration!.blockNumber, registration!.logIndex]).toEqual([
        expected.agentId,
        expected.owner,
        expected.blockNumber,
        expected.logIndex,
      ]);
      expect(registration!.uri.length).toBe(expected.uriLength);
      const facts = bscUriFacts(registration!.uri);
      expect(facts.uriKind).toBe(expected.uriKind);
      expect(facts.profileUriHash).toBe(expected.profileUriHash);
      expect(facts.locatorHost).toBe(expected.locatorHost);
      expect(facts.inlineName).toBe(expected.inlineName);
      expect(facts.truncated).toBe(expected.truncated);
    });

    it(`builds a facts-only directory row for the ${name} registration`, () => {
      const draft = bscDirectoryDraft(decodeBscRegisteredLog(log, WIDE)!);
      expect(draft.externalKey).toBe(`eip155:56:${BSC_IDENTITY_REGISTRY}:${expected.agentId}`);
      expect(draft.displayName).toBe(expected.inlineName ?? `Agent #${expected.agentId}`);
      expect(draft.locatorHost).toBe(expected.locatorHost);
      expect(draft.registrant).toBe(expected.owner);
      expect(draft.profileUriHash).toBe(expected.profileUriHash);
      expect(draft.sourceSignalNote!.length).toBeLessThanOrEqual(512);
      expect(draft.displayName.length).toBeLessThanOrEqual(255);
      // The note states what was and was not done; it never carries the URI itself.
      expect(draft.sourceSignalNote).toContain("current ownership is not verified");
      expect(draft.sourceSignalNote).not.toContain("data:application");
      expect(draft.sourceSignalNote).not.toContain("https://");
    });
  }

  it("keeps agent 0, which an earlier `id <= 0` guard once dropped on the Robinhood adapter", () => {
    const registration = decodeBscRegisteredLog(BSC_FIXTURE_REGISTERED.agent_zero!.log, WIDE);
    expect(registration!.agentId).toBe("0");
    expect(bscDirectoryDraft(registration!).externalKey).toBe(`eip155:56:${BSC_IDENTITY_REGISTRY}:0`);
  });

  it("says what each URI kind means, and what the pass does with a link, without claiming a fetch that did not happen", () => {
    const note = (name: string) => bscDirectoryDraft(decodeBscRegisteredLog(BSC_FIXTURE_REGISTERED[name]!.log, WIDE)!).sourceSignalNote!;
    // The pass reads chain data and, for a listed entry's https or ipfs link, the file behind it; a one-off census had read some links earlier without recording which.
    expect(note("evoevo_https")).toContain(`a web link. ${BNB_FETCH_SENTENCE}`);
    expect(note("ipfs")).toContain(`an IPFS reference. ${BNB_FETCH_SENTENCE}`);
    expect(note("other_scheme")).toContain(`an unrecognized scheme. ${BNB_FETCH_SENTENCE}`);
    expect(note("evoevo_https")).not.toContain("Nooscape did not fetch it");
    expect(note("empty")).toContain("No URI was set at registration");
    expect(note("ave_template")).toContain("the name is self-asserted");
    expect(note("inline_no_name")).toContain("it carries no name");
    expect(note("inline_unparsable")).toContain("inline JSON that could not be parsed");
    expect(note("long_uri")).toContain("exceeded the 8 KiB derived-view bound");
  });

  it("treats the two big templates as the byte-identical groups they are", () => {
    const hash = (name: string) => bscUriFacts(decodeBscRegisteredLog(BSC_FIXTURE_REGISTERED[name]!.log, WIDE)!.uri).profileUriHash;
    expect(hash("ave_template")).not.toBe(hash("debot_template"));
    // Two registrations of one template, many blocks apart, share one fold key: here the same log decoded twice,
    // and the independent hash in the fixture is what makes it a real, stable identifier.
    expect(hash("ave_template")).toBe(BSC_FIXTURE_REGISTERED.ave_template!.expected.profileUriHash);
  });
});

describe("which registrations carry a usable profile link", () => {
  const born = (name: string) => bscDirectoryDraft(decodeBscRegisteredLog(BSC_FIXTURE_REGISTERED[name]!.log, WIDE)!).listing;

  it.each(["evoevo_https", "termix_https", "other_https", "ipfs", "inline_no_name", "inline_urlencoded", "debot_template", "ave_template", "agent_zero"])(
    "%s is born pending: a web link, an IPFS reference, or inline JSON that parsed",
    name => {
      expect(born(name)).toBe(3);
    }
  );

  it.each(["empty", "other_scheme", "inline_unparsable", "long_uri"])(
    "%s is born excluded: there is nothing for the listing rules to compare",
    name => {
      expect(born(name)).toBe(0);
    }
  );

  it("decides from the URI bytes alone, and the draft and the URI-update path agree", () => {
    const json = (value: unknown) => `data:application/json;base64,${Buffer.from(JSON.stringify(value)).toString("base64")}`;
    expect(bscHasProfileLink(bscUriFacts(""))).toBe(false);
    expect(bscHasProfileLink(bscUriFacts("ftp://files.example/agent.json"))).toBe(false);
    expect(bscHasProfileLink(bscUriFacts("data:application/json;base64,!!!not-base64-json"))).toBe(false);
    expect(bscHasProfileLink(bscUriFacts("https://agent.example.com/card.json"))).toBe(true);
    expect(bscHasProfileLink(bscUriFacts("ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"))).toBe(true);
    expect(bscHasProfileLink(bscUriFacts(json({ name: "Real Agent", services: [] })))).toBe(true);
    expect(bscHasProfileLink(bscUriFacts(json({ description: "no name is fine" })))).toBe(true);
  });
});

describe("rejections", () => {
  const good = BSC_FIXTURE_REGISTERED.evoevo_https!.log;
  const b = (expected = BSC_FIXTURE_REGISTERED.evoevo_https!.expected.blockNumber) => ({ fromBlock: expected, toBlock: expected });

  it("accepts the untouched log inside its exact window", () => {
    expect(decodeBscRegisteredLog(good, b())).not.toBeNull();
  });

  const mutations: Array<[string, (log: Record<string, unknown>) => unknown]> = [
    ["a different contract address", log => ({ ...log, address: "0x" + "11".repeat(20) })],
    ["a removed (reorged) log", log => ({ ...log, removed: true })],
    ["a different event topic", log => ({ ...log, topics: ["0x" + "22".repeat(32), ...(log.topics as string[]).slice(1)] })],
    ["a missing owner topic", log => ({ ...log, topics: (log.topics as string[]).slice(0, 2) })],
    ["a malformed agent id topic", log => ({ ...log, topics: [(log.topics as string[])[0], "0x12", (log.topics as string[])[2]] })],
    ["a malformed transaction hash", log => ({ ...log, transactionHash: "0xabc" })],
    ["data that is not an ABI string", log => ({ ...log, data: "0x1234" })],
    ["data that is not hex", log => ({ ...log, data: "not hex" })],
    ["a missing block number", log => ({ ...log, blockNumber: undefined })],
    ["a non-object", () => "log"],
    ["null", () => null],
  ];
  for (const [label, mutate] of mutations) {
    it(`rejects ${label}`, () => {
      expect(decodeBscRegisteredLog(mutate(good as Record<string, unknown>), b())).toBeNull();
    });
  }

  it("rejects a log outside the window it was fetched for", () => {
    const expected = BSC_FIXTURE_REGISTERED.evoevo_https!.expected.blockNumber;
    expect(decodeBscRegisteredLog(good, { fromBlock: expected + 1, toBlock: expected + 10 })).toBeNull();
    expect(decodeBscRegisteredLog(good, { fromBlock: expected - 10, toBlock: expected - 1 })).toBeNull();
  });
});

describe("Transfer and URIUpdated against real logs", () => {
  it("keys a mint to the BNB chain and records who received it", () => {
    for (const [id, log] of Object.entries(BSC_FIXTURE_MINTS)) {
      const event = decodeTransferActivityLog(log, WIDE, { chainId: 56, registry: BSC_IDENTITY_REGISTRY });
      expect(event).toMatchObject({ kind: "mint", externalKey: `eip155:56:${BSC_IDENTITY_REGISTRY}:${id}` });
      expect(event!.fromAddress).toBe("0x" + "0".repeat(40));
    }
  });

  it("records a real change of hands as a secondary transfer between two wallets", () => {
    const window = parseBscWindowLogs([BSC_FIXTURE_SECONDARY], WIDE);
    expect(window.activity).toHaveLength(1);
    expect(window.activity[0]).toMatchObject({ kind: "secondary", externalKey: `eip155:56:${BSC_IDENTITY_REGISTRY}:729`, blockNumber: 79_944_767 });
    expect(window.activity[0]!.fromAddress).not.toBe("0x" + "0".repeat(40));
    expect(window.activity[0]!.toAddress).not.toBeNull();
  });

  for (const fixture of BSC_FIXTURE_URI_UPDATES) {
    it(`decodes the agent ${fixture.agentId} URI update (${fixture.newKind}) to the facts the independent decode found`, () => {
      const update = decodeBscUriUpdatedLog(fixture.log, WIDE)!;
      expect(update.externalKey).toBe(`eip155:56:${BSC_IDENTITY_REGISTRY}:${fixture.agentId}`);
      expect([update.blockNumber, update.logIndex]).toEqual([fixture.blockNumber, fixture.logIndex]);
      expect(update.event).toMatchObject({ kind: "uri_update", fromAddress: null, toAddress: null });
      const facts = bscUriFacts(update.uri!);
      expect(facts.uriKind).toBe(fixture.newKind);
      expect(facts.locatorHost).toBe(fixture.locatorHost);
      expect(facts.profileUriHash).toBe(fixture.profileUriHash);
    });
  }

  it("still counts an update whose new URI cannot be decoded, but carries no URI for the entry", () => {
    const update = decodeBscUriUpdatedLog({ ...BSC_FIXTURE_URI_UPDATES[0]!.log, data: "0x" }, WIDE)!;
    expect(update.uri).toBeNull();
    expect(update.event.kind).toBe("uri_update");
  });
});

describe("one window", () => {
  const reg = (name: string) => BSC_FIXTURE_REGISTERED[name]!.log;

  it("sorts what it returns into chain order, whatever order the provider sent", () => {
    const logs = [BSC_FIXTURE_URI_UPDATES[1]!.log, reg("ave_template"), BSC_FIXTURE_MINTS["6"]!, reg("empty"), BSC_FIXTURE_URI_UPDATES[0]!.log];
    const parsed = parseBscWindowLogs(logs, WIDE);
    expect(parsed.registrations.map(r => r.agentId)).toEqual(["6", "12244"]);
    expect(parsed.activity.map(e => [e.kind, e.blockNumber])).toEqual([
      ["mint", 79_258_145],
      ["uri_update", 79_258_254],
      ["uri_update", 79_991_968],
    ]);
    expect(parsed.uriUpdates.map(u => u.blockNumber)).toEqual([79_258_254, 79_991_968]);
  });

  it("counts what it cannot use and never stores it", () => {
    const junk = [{ ...reg("empty"), address: "0x" + "33".repeat(20) }, { ...reg("empty"), removed: true }, "nope", null, { topics: [] }];
    const parsed = parseBscWindowLogs([reg("empty"), BSC_FIXTURE_MINTS["6"]!, ...junk], WIDE);
    expect(parsed).toMatchObject({ discoveredCount: 7, rejectedCount: 5 });
    expect(parsed.registrations).toHaveLength(1);
    expect(parsed.activity).toHaveLength(1);
  });

  it("refuses a response that is not an array, or larger than the approved bound", () => {
    expect(() => parseBscWindowLogs({ result: [] }, WIDE)).toThrow(BscRegistryValidationError);
    expect(() => parseBscWindowLogs(new Array(BSC_MAX_WINDOW_LOGS + 1).fill(null), WIDE)).toThrow(/exceeds the approved bound/);
  });

  it("applies a registration before the update that follows it in the same window", () => {
    // Agent 6 registers with no URI at block 79,258,145 and sets an IPFS one at 79,258,254.
    const parsed = parseBscWindowLogs([BSC_FIXTURE_URI_UPDATES[0]!.log, reg("empty")], WIDE);
    expect(parsed.registrations[0]!.blockNumber).toBeLessThan(parsed.uriUpdates[0]!.blockNumber);
    expect(bscUriFacts(parsed.registrations[0]!.uri).uriKind).toBe("empty");
    expect(bscUriFacts(parsed.uriUpdates[0]!.uri!).uriKind).toBe("ipfs");
  });
});
