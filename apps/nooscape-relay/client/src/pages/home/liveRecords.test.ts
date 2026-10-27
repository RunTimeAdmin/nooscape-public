import { readFileSync } from "node:fs";
import { replaceEqualDeep } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { recordsWithIsoDates } from "./liveRecords";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const record = (agentId: string, lastObservedAt: Date | string) => ({ agentId, displayName: `Agent ${agentId}`, sourceCount: 1, lastObservedAt });

describe("the public records with their dates as text", () => {
  it("turns each Date into ISO text and leaves every other field as it was", () => {
    const answer = recordsWithIsoDates({ records: [record("a", new Date("2026-10-13T12:00:00.000Z")), record("b", "2026-10-14T00:00:00.000Z")] });
    expect(answer.records).toEqual([
      { agentId: "a", displayName: "Agent a", sourceCount: 1, lastObservedAt: "2026-10-13T12:00:00.000Z" },
      { agentId: "b", displayName: "Agent b", sourceCount: 1, lastObservedAt: "2026-10-14T00:00:00.000Z" },
    ]);
  });

  it("does not throw on a Date that does not read, which would fail the whole read", () => {
    const answer = recordsWithIsoDates({ records: [record("a", new Date("not a time"))] });
    expect(answer.records[0].lastObservedAt).toBe("");
  });

  it("is what lets structural sharing return the old answer when a poll brings nothing new", () => {
    const poll = () => ({ records: [record("a", new Date("2026-10-13T12:00:00.000Z")), record("b", new Date("2026-10-14T00:00:00.000Z"))] });
    // The raw answers: two reads of the same data are new objects at every level, because a Date is not compared.
    const rawFirst = poll();
    expect(replaceEqualDeep(rawFirst, poll())).not.toBe(rawFirst);
    // Selected: the same data is the same object, and a changed record is the only part that is new.
    const first = recordsWithIsoDates(poll());
    expect(replaceEqualDeep(first, recordsWithIsoDates(poll()))).toBe(first);
    const changed = poll();
    changed.records[1] = record("b", new Date("2026-10-15T00:00:00.000Z"));
    const next = replaceEqualDeep(first, recordsWithIsoDates(changed));
    expect(next).not.toBe(first);
    expect(next.records[0]).toBe(first.records[0]);
    expect(next.records[1].lastObservedAt).toBe("2026-10-15T00:00:00.000Z");
  });

  it("is the select of the home page's records read, and the page's default for no records is one array", () => {
    const home = read("../Home.tsx");
    expect(home).toContain("trpc.liveData.publicRecords.useQuery(undefined, { ...LIVE_POLL, select: recordsWithIsoDates })");
    expect(home).toContain("liveRecordsQuery.data?.records ?? NO_RECORDS");
    expect(home).not.toContain("liveRecordsQuery.data?.records ?? []");
  });
});

describe("the link in the address bar", () => {
  it("is applied once, when the records first arrive, and not again when they change", () => {
    const home = read("../Home.tsx");
    const effect = home.slice(home.indexOf("const linkApplied = useRef(false);"), home.indexOf("A link that arrives with a hash"));
    expect(effect).toContain("if (linkApplied.current || agents.length === 0) return;");
    expect(effect).toContain("linkApplied.current = true;");
    // The guard comes before the address bar is read, so a later change of the records reads nothing.
    expect(effect.indexOf("linkApplied.current = true;")).toBeLessThan(effect.indexOf("new URL(window.location.href)"));
  });

  it("opens Deep Space from the hash when the page opens, without waiting for the records", () => {
    const home = read("../Home.tsx");
    expect(home).toMatch(/useEffect\(\(\) => \{\n\s+if \(window\.location\.hash === "#deep-space"\) setDeepSpace\(true\);\n\s+\}, \[\]\);/);
  });
});
