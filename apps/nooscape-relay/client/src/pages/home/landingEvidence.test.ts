import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The funnel and the fleet cards must show only what the server reported, in words
 * the data supports. A browser would be needed to test the drawing, so this guards
 * where the data comes from and what the copy is allowed to say.
 */
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const home = read("../Home.tsx");
const noise = read("../../components/home/NoiseFunnel.tsx");
const fleet = read("../../components/home/FleetCards.tsx");
const countUp = read("../../components/home/CountUp.tsx");
const chains = read("../../components/home/ChainTabs.tsx");
const notes = read("../../components/home/FieldNotes.tsx");
const notesModel = read("../../components/home/fieldNotesModel.ts");
const how = read("../../components/home/HowItWorks.tsx");
const indexHtml = read("../../../index.html");

describe("the funnel and fleet cards on Home", () => {
  it("are fed the funnel steps and wallet census Home already reads, and load after the first paint", () => {
    expect(home).toContain('lazy(() => import("./home/LandingEvidence"))');
    expect(home).toContain("funnelSteps={funnelSteps}");
    expect(home).toContain("wallets={directoryWalletCensus?.wallets ?? []}");
    expect(home).toMatch(/<Suspense fallback=\{<div className="mb-5 h-\[420px\]"/);
  });

  it("show a step the server has not measured as not measured yet, never as a zero", () => {
    expect(noise).toContain("row.value === null");
    expect(noise).toContain("not measured yet");
    expect(noise).toContain('"?"');
  });

  it("keep every row in the page from the first paint, for a screen reader and for a page that is never scrolled, and only move the bars", () => {
    const markup = strip(noise);
    expect(markup).not.toMatch(/<li[^>]*aria-hidden/);
    expect(markup).toContain("rows.map(row => {");
    expect(markup).not.toMatch(/revealed|data-shown|stepsShown/);
  });

  it("draw nothing in place of counts they do not have", () => {
    expect(noise).toContain("cannot be read right now");
    expect(fleet).toContain("Nothing is drawn in their place.");
    expect(fleet).toContain('status === "ready" && cards.length > 0');
  });

  it("call a wallet a registering wallet, and never an operator or a rating", () => {
    const copy = strip(fleet);
    expect(copy).toContain("registering wallet");
    expect(copy).not.toMatch(/operator|score|rating|trusted|verified/i);
    expect(copy).toContain("not a verdict");
  });

  it("show the chain figures the server reports, and nothing worked out in the browser", () => {
    const markup = strip(chains);
    expect(markup).toContain("trpc.liveData.chainStats.useQuery");
    expect(markup).not.toMatch(/\.reduce\(|Math\./);
    expect(home).toContain("bnbProfile={bnbRegistry");
  });

  it("disable a chain that is not indexed, say a figure is not measured instead of showing a zero, and draw nothing without figures", () => {
    const markup = strip(chains);
    expect(markup).toContain('disabled={tabState(byChain(chain)) !== "ready"}');
    expect(markup).toContain("not indexed yet");
    expect(markup).toContain("not measured here");
    expect(markup).toContain("Nothing is drawn in their place.");
    expect(markup).toContain('value === null ?');
  });

  it("list only the events the activity feeds return, worded by the kind the feed gives, with no invented kinds or example events", () => {
    const markup = strip(notes);
    const model = strip(notesModel);
    expect(markup).toContain("trpc.liveData.directoryActivityFeed.useQuery");
    expect(markup).toContain("trpc.liveData.directorySolanaActivity.useQuery");
    expect(markup).toContain("(robinhoodPayload?.feed ?? []).map(robinhoodNote)");
    expect(markup).toContain("(solanaPayload?.feed ?? []).map(solanaNote)");
    expect(markup).toContain("asOfLabel(robinhoodPayload?.totals?.measuredThroughBlock ?? null)");
    expect(model).toContain("chainActivityEventLabel(event.kind, event.isHandout)");
    expect(model).toContain("solanaActivityEventLabel(event.kind, event.protocol)");
    expect(markup).not.toMatch(/example|fleet detected|revoked|copy-paste|Math\.random/i);
    expect(model).not.toMatch(/example|fleet detected|revoked|copy-paste|Math\.random/i);
  });

  it("ask for the Solana feed only once the reader switches to it, so the front page makes no extra request", () => {
    expect(strip(notes)).toContain('enabled: chain === "solana"');
  });

  it("are not a live region, can be paused, and draw nothing in place of events they do not have", () => {
    const markup = strip(notes);
    expect(markup).toContain('aria-live="off"');
    expect(markup).toContain("aria-pressed={frozen !== null}");
    expect(markup).toContain("Nothing is drawn in its place.");
    expect(home).not.toContain("<FieldNotes");
    expect(read("./LandingEvidence.tsx")).toContain("<FieldNotes />");
  });

  it("explain how it works in plain steps that carry no figure and no claim of a check that is not made", () => {
    const markup = strip(how);
    expect(markup).not.toMatch(/\d[\d,.]*\s*(%|records|agents|chains|sources)|score\b.*\d/i);
    expect(markup).not.toMatch(/\bverified\b|\btrusted\b|\bsafe\b|background check/i);
    expect(markup).toContain('<Link href="/about"');
    expect(markup).toContain('<Link href="/verify"');
    expect(markup).toContain('<Term k="tier">tier</Term>');
    expect(read("./LandingEvidence.tsx")).toContain("<HowItWorks />");
  });

  it("describe the social card as it is now, in both the Open Graph and Twitter tags", () => {
    expect(indexHtml.match(/an owl in a cap and goggles/g)).toHaveLength(2);
    expect(indexHtml).not.toContain("luminous green observatory nexus");
    expect(indexHtml).toContain('property="og:image:width" content="1200"');
    expect(indexHtml).toContain('property="og:image:height" content="630"');
  });

  it("count up without being announced, and are the plain value with reduced motion", () => {
    const markup = strip(countUp);
    expect(markup).not.toMatch(/aria-live/);
    expect(markup).toContain('<span aria-hidden="true">');
    expect(markup).toContain('<span className="sr-only">{value.toLocaleString()}</span>');
    expect(markup).toContain("reduced || !counting ? value : display");
    expect(markup).toContain("if (seen.current && !reduced) run(value)");
    // It is its value from the first paint, and starts a little before it is on screen, or before the first paint when it already is.
    expect(markup).toContain("if (box.bottom > 0 && box.top < window.innerHeight + 120) {");
    expect(markup).toContain('{ rootMargin: "0px 0px 120px 0px" },');
    expect(markup).toContain("useLayoutEffect(() => {");
  });
});
