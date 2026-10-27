import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onPageCoverChange, pageCovered, setPageCovered } from "./pageCover";

/**
 * The flag Deep Space sets while it covers the page, and the three animation loops behind it that read it. There is no browser test
 * runner in the repo, so the loops are held by their source; a run in a real browser (idle CPU with Deep Space closed and open) checked
 * that they stop and start.
 */
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");

afterEach(() => setPageCovered(false));

describe("the page cover flag", () => {
  it("is down until something sets it, and stays as it was set", () => {
    expect(pageCovered()).toBe(false);
    setPageCovered(true);
    expect(pageCovered()).toBe(true);
    setPageCovered(false);
    expect(pageCovered()).toBe(false);
  });

  it("tells its listeners when the value changes and not when it is set to what it already is", () => {
    const listener = vi.fn();
    const stop = onPageCoverChange(listener);
    setPageCovered(false);
    expect(listener).not.toHaveBeenCalled();
    setPageCovered(true);
    setPageCovered(true);
    expect(listener).toHaveBeenCalledTimes(1);
    setPageCovered(false);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stops telling a listener once it has stopped listening, even from inside a notification", () => {
    const calls: string[] = [];
    const stopFirst = onPageCoverChange(() => {
      calls.push("first");
      stopFirst();
    });
    const stopSecond = onPageCoverChange(() => calls.push("second"));
    setPageCovered(true);
    setPageCovered(false);
    expect(calls).toEqual(["first", "second", "second"]);
    stopSecond();
  });
});

describe("what reads it", () => {
  it("has the home page raise it while Deep Space is open and drop it when the page goes", () => {
    const home = read("../pages/Home.tsx");
    expect(home).toContain('import { setPageCovered } from "@/lib/pageCover";');
    expect(home).toMatch(/useEffect\(\(\) => \{\n\s+setPageCovered\(deepSpaceOpen\);\n\s+return \(\) => setPageCovered\(false\);\n\s+\}, \[deepSpaceOpen\]\);/);
  });

  it("draws the map at most 30 times a second, and not while the tab is hidden, the map is off screen or Deep Space covers the page", () => {
    const map = read("../components/home/AgentConstellation.tsx");
    expect(map).toContain("const FRAME_MS = 1000 / 30;");
    expect(map).toContain("if (visible && !document.hidden && !pageCovered() && now - drawnAt >= FRAME_MS - 4) {");
    expect(map).toContain("drawnAt = now;");
  });

  it("stops the hero canvas under the cover and starts it again when the cover comes down", () => {
    const canvas = read("../components/home/NoosphereBackdrop.tsx");
    expect(canvas).toContain("const shouldRun = onScreen && !document.hidden && !reduced && !pageCovered();");
    expect(canvas).toContain("const uncover = onPageCoverChange(sync);");
    expect(canvas).toMatch(/document\.removeEventListener\("visibilitychange", sync\);\n\s+uncover\(\);/);
  });

  it("stops the owl's loop under the cover and starts it again when the cover comes down", () => {
    const owl = read("../components/owl/useOwlRig.ts");
    expect(owl).toContain("if (document.hidden || pageCovered()) {");
    expect(owl).toContain("const uncover = onPageCoverChange(sync);");
    expect(owl).toContain("if (!document.hidden && !pageCovered()) begin();");
    expect(owl).toMatch(/document\.removeEventListener\("visibilitychange", sync\);\n\s+uncover\(\);/);
  });
});
