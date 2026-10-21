import { describe, expect, it } from "vitest";
import {
  attributeSaidEvents,
  classifySaidDiff,
  extractSaidInstructions,
  SAID_CHAIN_MAX_EVENTS_PER_PASS,
  SAID_IDENTITY_TX_FETCH_CAP,
  SAID_PASS_TX_FETCH_BUDGET,
  SAID_SIGNATURE_SCAN_LIMIT,
  saidInstructionsMatch,
  successfulSaidSignatures,
  type SaidClassification,
  type SaidPriorEntry,
} from "./saidActivity";
import { buildSaidDirectoryDraft, SAID_PROGRAM, type SaidIdentity } from "./saidChain";
import { SAID_TX_LOGS } from "./saidTxFixtures";

/**
 * The transaction logs below are REAL mainnet transactions (see
 * saidTxFixtures.ts). `instructions` on each came from an independent Python
 * parse of the same logs, so the TypeScript parser is checked against a second
 * implementation and not against itself.
 */
const identity = (owner: string, overrides: Partial<SaidIdentity> = {}): SaidIdentity => ({
  account: `pda-${owner}`,
  owner,
  authority: owner,
  layoutVersion: 3,
  uri: `https://api.saidprotocol.com/api/cards/${owner}`,
  createdAtSeconds: 1_790_000_000,
  isVerified: true,
  verifiedAtSeconds: 1_790_000_000,
  stakeLamports: BigInt(0),
  slashCount: 0,
  tailResidue: false,
  ...overrides,
});
const hashOf = (id: SaidIdentity) => buildSaidDirectoryDraft(id).profileUriHash!;
const priorFor = (id: SaidIdentity, overrides: Partial<SaidPriorEntry> = {}): SaidPriorEntry => ({
  registrant: id.authority,
  profileUriHash: hashOf(id),
  ...overrides,
});

describe("extractSaidInstructions on real mainnet logs", () => {
  for (const [label, tx] of Object.entries(SAID_TX_LOGS)) {
    it(`parses ${label} to the independently derived instruction list`, () => {
      expect(extractSaidInstructions(tx.logs)).toEqual(tx.instructions);
    });
  }

  it("sees both instructions of a combined register-and-verify transaction", () => {
    expect(extractSaidInstructions(SAID_TX_LOGS["RegisterAgent+GetVerified"]!.logs)).toEqual(["RegisterAgent", "GetVerified"]);
  });

  it("ignores another program's instruction lines and anything the SAID program only reaches by CPI", () => {
    const other = "11111111111111111111111111111111";
    const logs = [
      `Program ${other} invoke [1]`,
      "Program log: Instruction: RegisterAgent",
      `Program ${other} success`,
      `Program ${SAID_PROGRAM} invoke [1]`,
      `Program ${other} invoke [2]`,
      "Program log: Instruction: TransferAuthority",
      `Program ${other} success`,
      "Program log: Instruction: UpdateAgent",
      `Program ${SAID_PROGRAM} success`,
    ];
    expect(extractSaidInstructions(logs)).toEqual(["UpdateAgent"]);
  });

  it("returns nothing for missing or malformed logs", () => {
    expect(extractSaidInstructions(null)).toEqual([]);
    expect(extractSaidInstructions("nope")).toEqual([]);
    expect(extractSaidInstructions([1, null, {}])).toEqual([]);
  });
});

describe("saidInstructionsMatch", () => {
  it("matches only the instruction that makes the change", () => {
    expect(saidInstructionsMatch("register", ["RegisterAgent", "GetVerified"])).toBe(true);
    expect(saidInstructionsMatch("register", ["SponsorRegister"])).toBe(true);
    expect(saidInstructionsMatch("register", ["RegisterAndStake"])).toBe(true);
    expect(saidInstructionsMatch("profile_update", ["UpdateAgent"])).toBe(true);
    expect(saidInstructionsMatch("transfer", ["TransferAuthority"])).toBe(true);
    // The noise that also touches an identity's PDA proves nothing.
    for (const noise of ["SubmitAnchor", "Stake", "LinkWallet", "UnlinkWallet", "GetVerified", "SubmitFeedback"]) {
      expect(saidInstructionsMatch("register", [noise])).toBe(false);
      expect(saidInstructionsMatch("profile_update", [noise])).toBe(false);
      expect(saidInstructionsMatch("transfer", [noise])).toBe(false);
    }
    expect(saidInstructionsMatch("transfer", ["UpdateAgent"])).toBe(false);
  });
});

describe("successfulSaidSignatures", () => {
  it("keeps successful signatures in order and skips failed or malformed entries", () => {
    const sig = (c: string) => c.repeat(88);
    expect(
      successfulSaidSignatures([
        { signature: sig("a"), err: null },
        { signature: sig("b"), err: { InstructionError: [0, "x"] } },
        { signature: "short", err: null },
        null,
        { signature: sig("c") },
      ])
    ).toEqual([sig("a"), sig("c")]);
    expect(() => successfulSaidSignatures({})).toThrow(/did not return a list/);
  });
});

describe("classifySaidDiff", () => {
  const a = identity("AAAA");
  const b = identity("BBBB");

  it("the seed pass is a plain inventory with no events", () => {
    const result = classifySaidDiff({ seed: true, identities: [a, b], prior: new Map() });
    expect(result.plain).toEqual([a, b]);
    expect(result.eventful).toEqual([]);
  });

  it("an identity with no prior row registers", () => {
    const result = classifySaidDiff({ seed: false, identities: [a], prior: new Map() });
    expect(result.eventful).toHaveLength(1);
    expect(result.eventful[0]!.events).toEqual([{ kind: "register", fromOwner: null, toOwner: "AAAA" }]);
  });

  it("an unchanged identity is a plain upsert", () => {
    const result = classifySaidDiff({ seed: false, identities: [a], prior: new Map([["AAAA", priorFor(a)]]) });
    expect(result.plain).toEqual([a]);
    expect(result.eventful).toEqual([]);
  });

  it("a different authority is a transfer, from the prior registrant to the new authority", () => {
    const moved = identity("AAAA", { authority: "NEWAUTH" });
    const result = classifySaidDiff({ seed: false, identities: [moved], prior: new Map([["AAAA", priorFor(a)]]) });
    expect(result.eventful[0]!.events).toEqual([{ kind: "transfer", fromOwner: "AAAA", toOwner: "NEWAUTH" }]);
  });

  it("a different metadata URI is a profile_update", () => {
    const edited = identity("AAAA", { uri: "https://elsewhere.example/card.json" });
    const result = classifySaidDiff({ seed: false, identities: [edited], prior: new Map([["AAAA", priorFor(a)]]) });
    expect(result.eventful[0]!.events).toEqual([{ kind: "profile_update", fromOwner: null, toOwner: "AAAA" }]);
  });

  it("a transfer and an edit on the same identity are two events", () => {
    const both = identity("AAAA", { authority: "NEWAUTH", uri: "https://elsewhere.example/card.json" });
    const result = classifySaidDiff({ seed: false, identities: [both], prior: new Map([["AAAA", priorFor(a)]]) });
    expect(result.eventful[0]!.events.map(e => e.kind)).toEqual(["transfer", "profile_update"]);
  });

  it("adopts silently when the prior row was never chain-acknowledged (null registrant) or has no URI hash", () => {
    const moved = identity("AAAA", { authority: "NEWAUTH", uri: "https://elsewhere.example/card.json" });
    expect(classifySaidDiff({ seed: false, identities: [moved], prior: new Map([["AAAA", { registrant: null, profileUriHash: null }]]) }).plain).toEqual([moved]);
    const edited = identity("AAAA", { uri: "https://elsewhere.example/card.json" });
    expect(classifySaidDiff({ seed: false, identities: [edited], prior: new Map([["AAAA", priorFor(a, { profileUriHash: null })]]) }).plain).toEqual([edited]);
  });

  it("badge, stake, and slash changes fire no event: the note refreshes and that is all", () => {
    const staked = identity("AAAA", { isVerified: false, stakeLamports: BigInt(100_000_000), slashCount: 1 });
    const result = classifySaidDiff({ seed: false, identities: [staked], prior: new Map([["AAAA", priorFor(a)]]) });
    expect(result.plain).toEqual([staked]);
    expect(result.eventful).toEqual([]);
  });

  it("defers every eventful identity past the per-pass event cap, in owner order, without losing the first ones", () => {
    const many = Array.from({ length: SAID_CHAIN_MAX_EVENTS_PER_PASS + 5 }, (_v, i) => identity(`OWNER${String(i).padStart(3, "0")}`));
    const result = classifySaidDiff({ seed: false, identities: many, prior: new Map() });
    expect(result.eventful).toHaveLength(SAID_CHAIN_MAX_EVENTS_PER_PASS);
    expect(result.deferredByCap).toBe(5);
    expect(result.eventful[0]!.identity.owner).toBe("OWNER000");
    expect(result.plain).toEqual([]);
  });
});

/** A scripted RPC: signatures per address and logs per signature, counting every call. */
function rpc(options: { signatures: Record<string, string[]>; logs: Record<string, string[] | null> }) {
  const calls = { signatures: 0, transactions: 0 };
  const call = async (method: string, params: unknown[]) => {
    if (method === "getSignaturesForAddress") {
      calls.signatures += 1;
      return (options.signatures[params[0] as string] ?? []).map(signature => ({ signature, err: null }));
    }
    if (method === "getTransaction") {
      calls.transactions += 1;
      const logs = options.logs[params[0] as string];
      return logs === undefined || logs === null ? null : { meta: { logMessages: logs } };
    }
    throw new Error(`unexpected method ${method}`);
  };
  return { call, calls };
}
const sig = (n: number) => String(n).padStart(88, "x");
const logsFor = (...names: string[]) => [`Program ${SAID_PROGRAM} invoke [1]`, ...names.map(n => `Program log: Instruction: ${n}`), `Program ${SAID_PROGRAM} success`];
const eventful = (id: SaidIdentity, ...kinds: Array<"register" | "transfer" | "profile_update">): SaidClassification["eventful"][number] => ({
  identity: id,
  events: kinds.map(kind => ({ kind, fromOwner: kind === "transfer" ? id.owner : null, toOwner: id.authority })),
});

describe("attributeSaidEvents", () => {
  it("anchors a change to the newest matching transaction, skipping the noise newer than it", async () => {
    const id = identity("AAAA");
    const { call } = rpc({
      signatures: { [id.account]: [sig(3), sig(2), sig(1)] },
      logs: { [sig(3)]: logsFor("SubmitAnchor"), [sig(2)]: logsFor("UpdateAgent"), [sig(1)]: logsFor("RegisterAgent") },
    });
    const result = await attributeSaidEvents({ eventful: [eventful(id, "profile_update")], slot: 999, call });
    expect(result.events).toEqual([{ kind: "profile_update", externalKey: "AAAA", transactionSignature: sig(2), slot: 999, fromOwner: null, toOwner: "AAAA" }]);
    expect(result.upserts).toEqual([id]);
    expect(result.unanchoredCount).toBe(0);
    expect(result.deferredByBudgetCount).toBe(0);
  });

  it("anchors two kinds on one identity from one signature scan, and shares a transaction between them", async () => {
    const id = identity("AAAA", { authority: "NEWAUTH" });
    const { call, calls } = rpc({
      signatures: { [id.account]: [sig(2), sig(1)] },
      logs: { [sig(2)]: logsFor("TransferAuthority", "UpdateAgent"), [sig(1)]: logsFor("RegisterAgent") },
    });
    const result = await attributeSaidEvents({ eventful: [eventful(id, "transfer", "profile_update")], slot: 5, call });
    expect(result.events.map(e => [e.kind, e.transactionSignature])).toEqual([
      ["transfer", sig(2)],
      ["profile_update", sig(2)],
    ]);
    expect(calls.signatures).toBe(1);
    expect(calls.transactions).toBe(1);
  });

  it("anchors a registration using real mainnet logs", async () => {
    const real = SAID_TX_LOGS["RegisterAgent+GetVerified"]!;
    const id = identity("REALOWNER", { account: real.pda });
    const { call } = rpc({ signatures: { [real.pda]: [real.signature] }, logs: { [real.signature]: real.logs } });
    const result = await attributeSaidEvents({ eventful: [eventful(id, "register")], slot: 1, call });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.transactionSignature).toBe(real.signature);
  });

  it("adopts a change it cannot match without a ledger row, and counts it (a real UpdateAgent is not a TransferAuthority)", async () => {
    const real = SAID_TX_LOGS["UpdateAgent"]!;
    const id = identity("REALOWNER", { account: real.pda, authority: "NEWAUTH" });
    const { call } = rpc({ signatures: { [real.pda]: [real.signature] }, logs: { [real.signature]: real.logs } });
    const result = await attributeSaidEvents({ eventful: [eventful(id, "transfer")], slot: 1, call });
    expect(result.events).toEqual([]);
    expect(result.upserts).toEqual([id]);
    expect(result.unanchoredCount).toBe(1);
  });

  it("adopts unanchored when an identity has no usable signatures at all", async () => {
    const id = identity("AAAA");
    const { call } = rpc({ signatures: {}, logs: {} });
    const result = await attributeSaidEvents({ eventful: [eventful(id, "register")], slot: 1, call });
    expect(result.unanchoredCount).toBe(1);
    expect(result.upserts).toEqual([id]);
  });

  it("skips a pruned transaction (null result) and keeps walking", async () => {
    const id = identity("AAAA");
    const { call } = rpc({ signatures: { [id.account]: [sig(2), sig(1)] }, logs: { [sig(2)]: null, [sig(1)]: logsFor("RegisterAgent") } });
    const result = await attributeSaidEvents({ eventful: [eventful(id, "register")], slot: 1, call });
    expect(result.events.map(e => e.transactionSignature)).toEqual([sig(1)]);
  });

  it("a spammed identity cannot wedge the pass: its change is adopted unanchored after the per-identity cap, and the identity after it is still attributed", async () => {
    const spammed = identity("AAAA", { authority: "NEWAUTH" });
    const clean = identity("BBBB");
    // 25 newest signatures are SubmitAnchor noise; the real transfer is older than the scan.
    const noise = Array.from({ length: SAID_SIGNATURE_SCAN_LIMIT }, (_v, i) => sig(1000 + i));
    const logs: Record<string, string[]> = { [sig(1)]: logsFor("RegisterAgent") };
    for (const s of noise) logs[s] = logsFor("SubmitAnchor");
    const { call, calls } = rpc({ signatures: { [spammed.account]: noise, [clean.account]: [sig(1)] }, logs });
    const result = await attributeSaidEvents({ eventful: [eventful(spammed, "transfer"), eventful(clean, "register")], slot: 7, call });
    expect(result.unanchoredCount).toBe(1);
    expect(result.upserts.map(i => i.owner)).toEqual(["AAAA", "BBBB"]);
    expect(result.events.map(e => e.externalKey)).toEqual(["BBBB"]);
    expect(result.deferredByBudgetCount).toBe(0);
    // The spammed identity cost at most the per-identity cap of reads, not 25. The
    // bound is a literal on purpose: comparing against the exported constant would
    // pass whatever the constant was changed to.
    expect(calls.transactions).toBeLessThanOrEqual(8 + 1);
  });

  it("pins the bounds the pass design relies on", () => {
    expect(SAID_IDENTITY_TX_FETCH_CAP).toBe(8);
    expect(SAID_PASS_TX_FETCH_BUDGET).toBe(40);
    expect(SAID_SIGNATURE_SCAN_LIMIT).toBe(25);
    expect(SAID_CHAIN_MAX_EVENTS_PER_PASS).toBe(25);
  });

  it("defers an identity whose walk the pass budget interrupts part-way, and the one after it, but keeps the finished ones", async () => {
    // Thirteen identities each anchor after 3 reads (39 total), so the fourteenth is
    // cut off mid-walk by the 40-read pass budget and the fifteenth is never reached.
    const ids = Array.from({ length: 15 }, (_v, i) => identity(`OWNER${String(i).padStart(2, "0")}`, { authority: "NEWAUTH" }));
    const signatures: Record<string, string[]> = {};
    const logs: Record<string, string[]> = {};
    ids.forEach((id, index) => {
      const list = [sig(index * 10 + 3), sig(index * 10 + 2), sig(index * 10 + 1)];
      signatures[id.account] = list;
      logs[list[0]!] = logsFor("SubmitAnchor");
      logs[list[1]!] = logsFor("SubmitAnchor");
      logs[list[2]!] = logsFor("TransferAuthority");
    });
    const { call, calls } = rpc({ signatures, logs });
    const result = await attributeSaidEvents({ eventful: ids.map(id => eventful(id, "transfer")), slot: 1, call });
    expect(result.upserts).toHaveLength(13);
    expect(result.events).toHaveLength(13);
    expect(result.deferredByBudgetCount).toBe(2);
    expect(result.upserts.map(i => i.owner)).not.toContain("OWNER13");
    expect(result.upserts.map(i => i.owner)).not.toContain("OWNER14");
    expect(calls.transactions).toBe(40);
  });

  it("defers identities the pass budget did not reach (no upsert, no event) while completing the ones it did", async () => {
    // Each identity needs the cap to give up on, so the pass budget runs out part-way through.
    const count = 7;
    const ids = Array.from({ length: count }, (_v, i) => identity(`OWNER${i}`, { authority: "NEWAUTH" }));
    const signatures: Record<string, string[]> = {};
    const logs: Record<string, string[]> = {};
    ids.forEach((id, index) => {
      const list = Array.from({ length: SAID_SIGNATURE_SCAN_LIMIT }, (_x, j) => sig(index * 100 + j));
      signatures[id.account] = list;
      for (const s of list) logs[s] = logsFor("SubmitAnchor");
    });
    const { call, calls } = rpc({ signatures, logs });
    const result = await attributeSaidEvents({ eventful: ids.map(id => eventful(id, "transfer")), slot: 1, call });
    expect(calls.transactions).toBeLessThanOrEqual(SAID_PASS_TX_FETCH_BUDGET);
    expect(result.deferredByBudgetCount).toBeGreaterThan(0);
    // Deferred identities are neither upserted nor evented, so the next pass re-detects them.
    expect(result.upserts.length + result.deferredByBudgetCount).toBe(count);
    expect(result.upserts.length).toBeGreaterThan(0);
  });
});
