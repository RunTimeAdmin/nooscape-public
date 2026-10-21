import { afterEach, describe, expect, it, vi } from "vitest";
import type { IngestionSource } from "../../drizzle/schema";
import { uriHashOf } from "../robinhoodNamesCore";
import { buildSaidDirectoryDraft, decodeSaidIdentity, SAID_CHAIN_SOURCE_KEY } from "./saidChain";
import { fetchSaidPass } from "./saidPass";
import { SAID_ACCOUNTS, SAID_TX_LOGS } from "./saidTxFixtures";

/**
 * End-to-end test of one SAID pass on REAL mainnet bytes: the account bytes
 * and the transaction logs come from the live chain (saidTxFixtures.ts), and
 * only the JSON-RPC transport is stubbed. It exercises the whole path the
 * runner depends on: enumeration, strict decode, diff against prior directory
 * state, signature scan, transaction walk, instruction match, and the shape of
 * the resulting snapshot.
 */
const NOW_MS = Date.UTC(2026, 9, 13);
const source = {
  id: "00000000-0000-4000-8000-0000000000a1",
  sourceKey: SAID_CHAIN_SOURCE_KEY,
  protocol: "solana_said",
  state: "active",
  executionPolicy: "manual_only",
  cursor: "said:1",
} as unknown as IngestionSource;

const moved = SAID_ACCOUNTS.v3_authority_moved!;
const residue = SAID_ACCOUNTS.v3_residue!;
const staked = SAID_ACCOUNTS.v3_staked!;

const entries = (...accounts: Array<{ pda: string; b64: string }>) => accounts.map(a => ({ pubkey: a.pda, account: { data: [a.b64, "base64"] } }));

function stubRpc(routes: { slot?: number; accounts: unknown[]; signatures?: Record<string, string[]>; logs?: Record<string, string[] | null>; unreadable?: string[] }) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const fetchMock = vi.fn(async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body) as { method: string; params: unknown[]; id: number };
    calls.push({ method: body.method, params: body.params });
    let result: unknown;
    let error: { code: number; message: string } | undefined;
    if (body.method === "getSlot") result = routes.slot ?? 456_000_000;
    else if (body.method === "getProgramAccounts") result = routes.accounts;
    else if (body.method === "getSignaturesForAddress") result = (routes.signatures?.[body.params[0] as string] ?? []).map(signature => ({ signature, err: null }));
    else if (body.method === "getTransaction") {
      if (routes.unreadable?.includes(body.params[0] as string)) error = { code: -32015, message: "Transaction version (1) is not supported by the requesting client." };
      const logs = routes.logs?.[body.params[0] as string];
      result = logs ? { meta: { logMessages: logs } } : null;
    } else throw new Error(`unexpected ${body.method}`);
    return {
      ok: true,
      headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, ...(error ? { error } : { result }) }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const priorOf = (account: { b64: string; pda: string }, overrides: { registrant?: string | null; profileUriHash?: string | null } = {}) => {
  const id = decodeSaidIdentity(account.pda, new Uint8Array(Buffer.from(account.b64, "base64")), NOW_MS);
  return { registrant: overrides.registrant === undefined ? id.authority : overrides.registrant, profileUriHash: overrides.profileUriHash === undefined ? buildSaidDirectoryDraft(id).profileUriHash! : overrides.profileUriHash };
};
const ownerOf = (account: { b64: string; pda: string }) => decodeSaidIdentity(account.pda, new Uint8Array(Buffer.from(account.b64, "base64")), NOW_MS).owner;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchSaidPass on real mainnet bytes", () => {
  it("anchors a real registration, a real authority transfer, and a real metadata edit, each to its own transaction", async () => {
    const reg = SAID_TX_LOGS["RegisterAgent+GetVerified"]!;
    const transfer = SAID_TX_LOGS["TransferAuthority"]!;
    const update = SAID_TX_LOGS["UpdateAgent"]!;
    const calls = stubRpc({
      accounts: entries(moved, residue, staked),
      signatures: {
        // moved: a LinkWallet after the transfer is newer noise; the real TransferAuthority is behind it.
        [moved.pda]: [SAID_TX_LOGS["LinkWallet"]!.signature, transfer.signature],
        // residue is new to the directory (a registration); its real register tx is the oldest.
        [residue.pda]: [update.signature, reg.signature],
        // staked is unchanged: it must cost no attribution call at all.
      },
      logs: {
        [SAID_TX_LOGS["LinkWallet"]!.signature]: SAID_TX_LOGS["LinkWallet"]!.logs,
        [transfer.signature]: transfer.logs,
        [update.signature]: update.logs,
        [reg.signature]: reg.logs,
      },
    });

    // moved: the directory last acknowledged its owner as the registrant, so the authority change is a transfer.
    const prior = new Map([
      [ownerOf(moved), priorOf(moved, { registrant: moved.owner })],
      [ownerOf(staked), priorOf(staked)],
      // residue has no prior row: a registration.
    ]);
    const snapshot = await fetchSaidPass({ source, seed: false, prior, rpcUrl: "https://rpc.test", nowMs: NOW_MS, pacingMs: 0 });

    const byKey = Object.fromEntries(snapshot.events.map(e => [`${e.kind}:${e.externalKey}`, e]));
    expect(Object.keys(byKey).sort()).toEqual([`register:${residue.owner}`, `transfer:${moved.owner}`].sort());
    expect(byKey[`transfer:${moved.owner}`]).toMatchObject({ transactionSignature: transfer.signature, fromOwner: moved.owner, toOwner: moved.authority });
    expect(byKey[`register:${residue.owner}`]).toMatchObject({ transactionSignature: reg.signature, fromOwner: null, toOwner: residue.authority });
    expect(snapshot.unanchoredCount).toBe(0);
    expect(snapshot.deferredCount).toBe(0);
    // Every identity is upserted, including the unchanged one.
    expect(snapshot.drafts.map(d => d.externalKey).sort()).toEqual([moved.owner, residue.owner, staked.owner].sort());
    // The name step's queue gets each of those identities' own metadata link, in the same order as the drafts, and each draft's hash is that link's.
    expect(snapshot.links.map(link => link.externalKey)).toEqual(snapshot.drafts.map(d => d.externalKey));
    expect(snapshot.links.every(link => link.uri.length > 0 && link.createdAtSeconds > 0)).toBe(true);
    expect(snapshot.links.map(link => uriHashOf(link.uri))).toEqual(snapshot.drafts.map(d => d.profileUriHash));
    expect(snapshot.enumeratedCount).toBe(3);
    // The unchanged identity cost no signature scan.
    expect(calls.filter(c => c.method === "getSignaturesForAddress").map(c => c.params[0]).sort()).toEqual([moved.pda, residue.pda].sort());
  });

  it("asks for transactions up to version 1 and skips one it cannot read, anchoring to the next", async () => {
    // A version 1 transaction answered with error -32015 used to fail the pass; it is skipped now, like a pruned one.
    const reg = SAID_TX_LOGS["RegisterAgent+GetVerified"]!;
    const update = SAID_TX_LOGS["UpdateAgent"]!;
    const calls = stubRpc({
      accounts: entries(residue),
      signatures: { [residue.pda]: [update.signature, reg.signature] },
      logs: { [update.signature]: update.logs, [reg.signature]: reg.logs },
      unreadable: [update.signature],
    });
    const snapshot = await fetchSaidPass({ source, seed: false, prior: new Map(), rpcUrl: "https://rpc.test", nowMs: NOW_MS, pacingMs: 0 });
    expect(snapshot.events).toEqual([expect.objectContaining({ kind: "register", externalKey: residue.owner, transactionSignature: reg.signature })]);
    expect(snapshot.unanchoredCount).toBe(0);
    const requests = calls.filter(call => call.method === "getTransaction");
    expect(requests.length).toBe(2);
    for (const request of requests) expect(request.params[1]).toEqual({ encoding: "json", maxSupportedTransactionVersion: 1 });
  });

  it("anchors a real metadata edit when the directory's prior hash differs", async () => {
    const update = SAID_TX_LOGS["UpdateAgent"]!;
    stubRpc({
      accounts: entries(residue),
      signatures: { [residue.pda]: [update.signature] },
      logs: { [update.signature]: update.logs },
    });
    const prior = new Map([[residue.owner, priorOf(residue, { profileUriHash: "0".repeat(64) })]]);
    const snapshot = await fetchSaidPass({ source, seed: false, prior, rpcUrl: "https://rpc.test", nowMs: NOW_MS, pacingMs: 0 });
    expect(snapshot.events).toEqual([expect.objectContaining({ kind: "profile_update", externalKey: residue.owner, transactionSignature: update.signature })]);
  });

  it("the seed pass is a plain inventory: no signature scan, no transaction read, no events", async () => {
    const calls = stubRpc({ accounts: entries(moved, residue, staked) });
    const snapshot = await fetchSaidPass({ source, seed: true, prior: new Map(), rpcUrl: "https://rpc.test", nowMs: NOW_MS, pacingMs: 0 });
    expect(snapshot.events).toEqual([]);
    expect(snapshot.drafts).toHaveLength(3);
    expect(calls.map(c => c.method).sort()).toEqual(["getProgramAccounts", "getSlot"]);
  });

  it("a change it cannot anchor is adopted into the directory with no ledger row and is counted, not failed", async () => {
    // The only transaction on the PDA is an UpdateAgent, but the directory saw an authority change.
    const update = SAID_TX_LOGS["UpdateAgent"]!;
    stubRpc({ accounts: entries(moved), signatures: { [moved.pda]: [update.signature] }, logs: { [update.signature]: update.logs } });
    const prior = new Map([[moved.owner, priorOf(moved, { registrant: moved.owner })]]);
    const snapshot = await fetchSaidPass({ source, seed: false, prior, rpcUrl: "https://rpc.test", nowMs: NOW_MS, pacingMs: 0 });
    expect(snapshot.events).toEqual([]);
    expect(snapshot.unanchoredCount).toBe(1);
    expect(snapshot.drafts.map(d => d.externalKey)).toEqual([moved.owner]);
    expect(snapshot.drafts[0]!.registrant).toBe(moved.authority);
  });

  it("counts requests across the enumeration and the attribution walk", async () => {
    const reg = SAID_TX_LOGS["RegisterAgent+GetVerified"]!;
    stubRpc({ accounts: entries(residue), signatures: { [residue.pda]: [reg.signature] }, logs: { [reg.signature]: reg.logs } });
    const snapshot = await fetchSaidPass({ source, seed: false, prior: new Map(), rpcUrl: "https://rpc.test", nowMs: NOW_MS, pacingMs: 0 });
    // getSlot + getProgramAccounts + one signature scan + one transaction read.
    expect(snapshot.requestCount).toBe(4);
  });
});
