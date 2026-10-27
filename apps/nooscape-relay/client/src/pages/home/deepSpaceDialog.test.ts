import { readFileSync } from "node:fs";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { mapLiveRecord } from "./atlasModel";
import DeepSpaceMap from "./DeepSpace";

/**
 * Deep Space and the record drawer used to say role="dialog" aria-modal="true" and do nothing a dialog does: focus did not move in, was
 * not kept in and was not given back, and the two search fields were named by the key hint beside them ("ESC", "⌘ K"). Deep Space is now
 * a Radix modal dialog and the drawer a Radix dialog that does not block the map. The server render below holds what the markup says; what
 * Radix does with focus and the Escape key was run in a real browser (there is no browser test runner in the repo).
 */
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const deep = read("./DeepSpace.tsx");
const field = read("./FieldView.tsx");
const home = read("../Home.tsx");

const noop = () => {};
const agent = mapLiveRecord({
  agentId: "agent-1",
  displayName: "Agent One",
  handle: "agent-one",
  primaryCapability: "Search",
  untrustedSummary: null,
  protocols: '["a2a"]',
  publisherState: "unverified",
  evidenceTier: "tier_2",
  sourceCount: 1,
  lastObservedAt: "2026-10-13T12:00:00.000Z",
});
const props = {
  opener: { current: null },
  agents: [agent],
  allAgents: [agent],
  selected: agent,
  onSelect: noop,
  onClose: noop,
  zoom: 1,
  pan: { x: 0, y: 0 },
  onZoom: noop,
  onPan: noop,
  onReset: noop,
  ingress: null,
  showIngress: false,
  history: [],
  evidence: undefined,
  evidenceLoading: false,
  evidenceAsOf: null,
  frameworks: ["All protocols"],
  frameworkFilter: "All protocols",
  onFrameworkFilter: noop,
  sortMode: "network" as const,
  onSortMode: noop,
  onShare: async () => {},
  shareState: "idle" as const,
  agentSearch: "",
  onAgentSearch: noop,
  searchOpen: false,
  onSearchOpen: noop,
  searchRef: createRef<HTMLInputElement>(),
  suggestions: [],
  onLocateAgent: noop,
  drawerOpen: false,
  onCloseDrawer: noop,
  pinned: false,
  onPin: noop,
  onOpenComparison: noop,
  compareCount: 0,
  onDownloadEvidence: noop,
  directoryTotal: 0,
  directoryHits: undefined,
  directoryWallets: undefined,
  pinPulseId: null,
  comparisonPulse: false,
  pinnedIds: [],
  spotlight: null,
  trustedOnly: false,
  onTrustedOnly: noop,
  publisherStateFilter: "all" as const,
  onPublisherStateFilter: noop,
};
const count = (text: string, part: string) => text.split(part).length - 1;

describe("Deep Space as a dialog", () => {
  const markup = renderToStaticMarkup(createElement(DeepSpaceMap, props));

  it("is one dialog, named as before, with its visible heading as the title Radix looks for", () => {
    expect(count(markup, 'role="dialog"')).toBe(1);
    expect(markup).toContain('aria-label="Nooscape deep space map"');
    expect(markup).toContain('data-state="open"');
    expect(markup).toMatch(/<h2 class="text-sm font-medium text-\[#EDF9EF\]" id="radix-[^"]+">Semantic agent field<\/h2>/);
  });

  it("has a search field named for what it does, and not by the key hint beside it", () => {
    expect(markup).toContain('aria-label="Locate an agent by name, domain, mint, or capability"');
    expect(markup).toContain("<kbd>ESC</kbd>");
  });

  it("keeps the close button and carries no hand-written dialog attributes", () => {
    expect(markup).toContain("Close</button>");
    expect(deep).not.toContain('role="dialog"');
    expect(deep).not.toContain('aria-modal="true"');
  });

  it("shows the record drawer as a second dialog inside it, named for the agent, when it is open", () => {
    const open = renderToStaticMarkup(createElement(DeepSpaceMap, { ...props, drawerOpen: true }));
    expect(count(open, 'role="dialog"')).toBe(2);
    expect(open).toContain('aria-label="Agent One signal record"');
    expect(open).toMatch(/<aside[^>]*class="agent-activity-drawer"/);
    expect(open).toMatch(/<h2 id="radix-[^"]+">Agent One<\/h2>/);
  });

  it("draws what is passed as its children inside the dialog, after the drawer", () => {
    const open = renderToStaticMarkup(createElement(DeepSpaceMap, { ...props, drawerOpen: true }, createElement("section", { "aria-label": "Pinned agent comparison" })));
    expect(open.indexOf("agent-activity-drawer")).toBeLessThan(open.indexOf("Pinned agent comparison"));
    expect(open.indexOf("Pinned agent comparison")).toBeLessThan(open.lastIndexOf("</div>"));
  });
});

describe("what the dialogs do with the keyboard and with focus", () => {
  it("closes Deep Space on Escape unless the search is open, which the page closes first", () => {
    expect(deep).toContain("onEscapeKeyDown={event => { if (searchOpen) event.preventDefault(); }}");
    expect(home).toContain('if (event.key === "Escape") {');
    expect(home).toContain("setSearchOpen(false);");
  });

  it("gives focus back to what had it when each opened, because neither has a trigger for Radix to return it to", () => {
    // The map's control is noted by Home before the page behind it is hidden (a hidden control loses focus); the drawer notes its own.
    expect(home).toContain("const deepSpaceOpener = useRef<Element | null>(null);");
    expect(home).toContain("if (deepSpaceOpen) deepSpaceOpener.current = document.activeElement;");
    expect(home).toMatch(/useLayoutEffect\(\(\) => \{\n\s+if \(deepSpaceOpen\) deepSpaceOpener\.current/);
    expect(home).toContain("<DeepSpaceMap opener={deepSpaceOpener} ");
    expect(deep).toContain("onCloseAutoFocus={giveFocusBackTo(() => opener.current)}");
    expect(deep).toContain("const [opener] = useState(() => (typeof document === \"undefined\" ? null : document.activeElement));");
    expect(deep).toContain("onCloseAutoFocus={giveFocusBackTo(() => opener)}");
    expect(deep).toContain("if (target.isConnected && document.activeElement !== target) target.focus();");
    // The controls of the page behind have a transition on every property, so one just uncovered is still hidden when the dialog is gone.
    expect(deep).toContain("window.requestAnimationFrame(() => {\n      focus();\n      window.setTimeout(focus, 250);");
  });

  it("leaves the map usable beside the drawer: it does not block and a click outside does not close it", () => {
    expect(deep).toContain("<DialogPrimitive.Root open modal={false}");
    expect(deep).toContain("onInteractOutside={event => event.preventDefault()}");
  });

  it("asks Home for the comparison panel as a child of Deep Space, so it is inside the dialog's focus trap", () => {
    expect(deep).toContain("{children}");
    expect(home).toContain("{comparisonOpen && <Suspense fallback={null}><AgentComparisonPanel ");
    expect(home).not.toMatch(/deepSpaceOpen && comparisonOpen/);
  });
});

describe("the other search field and the agent page", () => {
  it("names the full field's search for what it does", () => {
    expect(field).toContain('aria-label="Search the field by capability, protocol, or handle"');
  });

  it("says so on the agent page when the read fails, instead of drawing nothing under the header", () => {
    const page = read("../DirectoryAgent.tsx");
    expect(page).toContain("{profileQuery.isError && !profile && (");
    expect(page).toContain('<div role="alert"');
    expect(page).toContain("onClick={() => void profileQuery.refetch()}");
    expect(page).toContain("which is not the same as the record not existing");
  });
});
