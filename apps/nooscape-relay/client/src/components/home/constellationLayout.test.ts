import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerLayout, layoutInput, type LayoutRequest } from "./constellationLayout";
import { layoutNodes, type ConstellationNode, type ConstellationRecord } from "./constellationModel";

/** The map's layout runs in a worker (constellationLayout.ts, useConstellationLayout.ts). It must place every node exactly where the page used to. */
const record = (id: string, protocols = '["a2a"]'): ConstellationRecord => ({ agentId: id, displayName: `Agent ${id}`, handle: `@${id}`, protocols, evidenceTier: "tier_2" });
const light = (id: string, count: number): ConstellationRecord => ({
  agentId: id,
  displayName: `Group ${id}`,
  handle: "",
  protocols: '["erc8004_bsc"]',
  evidenceTier: "fleet",
  kind: "fleet",
  fleet: { chain: "bnb", kind: "wallet", key: id, label: `Group ${id}`, count } as never,
});
const records = [...Array.from({ length: 60 }, (_, i) => record(`agent-${i}`)), light("g1", 400), light("g2", 90), light("g3", 30)];

describe("the worker's answer", () => {
  it("is exactly the layout the page used to work out itself", () => {
    for (const aspect of [0.75, 1.6, 2, 3]) {
      const reply = answerLayout({ id: 7, records: layoutInput(records), aspect });
      expect(reply.id).toBe(7);
      expect(reply.nodes).toEqual(layoutNodes(records, aspect));
    }
  });

  it("is sent only what the layout reads, as plain data", () => {
    const rich = { ...record("x"), lastObservedAt: new Date(), sourceCount: 3, summary: () => "not cloneable" } as ConstellationRecord;
    const [sent] = layoutInput([rich]);
    expect(Object.keys(sent!).sort()).toEqual(["agentId", "displayName", "evidenceTier", "fleet", "handle", "kind", "protocols"]);
    expect(structuredClone(sent)).toEqual(sent);
  });

  it("is what the worker file answers with", () => {
    const worker = readFileSync(new URL("./constellationLayout.worker.ts", import.meta.url), "utf8");
    expect(worker).toContain("self.postMessage(answerLayout(event.data))");
    // The worker bundle carries the layout only: no React.
    expect(readFileSync(new URL("./constellationLayout.ts", import.meta.url), "utf8")).not.toContain("react");
  });
});

/** A stand-in for the browser's Worker: it keeps what it was sent, and a test answers for it. */
class FakeWorker {
  static made: FakeWorker[] = [];
  sent: LayoutRequest[] = [];
  terminated = false;
  listeners: Record<string, Array<(event: { data?: unknown }) => void>> = {};
  constructor() {
    FakeWorker.made.push(this);
  }
  postMessage(request: LayoutRequest) {
    this.sent.push(request);
  }
  terminate() {
    this.terminated = true;
  }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  removeEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter(other => other !== listener);
  }
  answer(request: LayoutRequest) {
    for (const listener of this.listeners.message ?? []) listener({ data: answerLayout(request) });
  }
  fail() {
    for (const listener of this.listeners.error ?? []) listener({});
  }
}

describe("asking the worker", () => {
  beforeEach(() => {
    FakeWorker.made = [];
    vi.resetModules();
    vi.stubGlobal("Worker", FakeWorker);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hands back the worker's nodes, and nothing for another request's answer", async () => {
    const { requestLayout } = await import("./useConstellationLayout");
    const got: ConstellationNode[][] = [];
    requestLayout(records, 2, nodes => got.push(nodes));
    const worker = FakeWorker.made[0]!;
    expect(worker.sent).toHaveLength(1);
    worker.answer({ ...worker.sent[0]!, id: 999 });
    expect(got).toHaveLength(0);
    worker.answer(worker.sent[0]!);
    expect(got).toEqual([layoutNodes(records, 2)]);
  });

  it("stops a busy worker and starts a fresh one for a newer request, so stale work never queues", async () => {
    const { requestLayout } = await import("./useConstellationLayout");
    const got: number[] = [];
    requestLayout(records, 2, () => got.push(2));
    requestLayout(records, 1, () => got.push(1));
    expect(FakeWorker.made).toHaveLength(2);
    expect(FakeWorker.made[0]!.terminated).toBe(true);
    FakeWorker.made[1]!.answer(FakeWorker.made[1]!.sent[0]!);
    expect(got).toEqual([1]);
    // Once it has answered, the next request reuses it.
    requestLayout(records, 3, () => got.push(3));
    expect(FakeWorker.made).toHaveLength(2);
  });

  it("lays out on the page when the worker fails, and from then on", async () => {
    const { requestLayout } = await import("./useConstellationLayout");
    const got: ConstellationNode[][] = [];
    requestLayout(records, 2, nodes => got.push(nodes));
    FakeWorker.made[0]!.fail();
    expect(got).toEqual([layoutNodes(records, 2)]);
    requestLayout(records, 3, nodes => got.push(nodes));
    expect(FakeWorker.made).toHaveLength(1);
    expect(got[1]).toEqual(layoutNodes(records, 3));
  });

  it("lays out on the page where there is no worker", async () => {
    vi.stubGlobal("Worker", undefined);
    const { requestLayout } = await import("./useConstellationLayout");
    const got: ConstellationNode[][] = [];
    requestLayout(records, 2, nodes => got.push(nodes));
    expect(got).toEqual([layoutNodes(records, 2)]);
  });
});
