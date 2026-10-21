import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The scan map draws the records Nooscape has reviewed, and beside them one other thing: a fixed sample of the
 * registrations the directory lists on BNB Chain, drawn hollow, counted and named apart, and never given a tier or
 * evidence (docs/approvals/2026-10-15-informational-use-and-bnb-map.md). A browser would be needed to test the drawing,
 * so this guards where its data comes from and what it is allowed to say.
 */
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const home = read("../Home.tsx");
const hero = read("./LandingHero.tsx");
const card = read("../../components/home/CheckCard.tsx");
const constellation = read("../../components/home/AgentConstellation.tsx");

describe("the scan map on Home", () => {
  it("is fed the live public records, never the illustrative seed agents", () => {
    expect(home).toContain("<LandingHero records={liveRecords}");
    expect(home).not.toMatch(/<LandingHero[^>]*seed/i);
  });

  it("is given no individual BNB Chain registration: the page reads none for the map and hands none to it", () => {
    // PR-B3 replaced the fixed hollow sample (liveData.mapAcknowledged) with groups of registrations (liveData.mapFleets). The
    // endpoint and the hero's way of drawing a sample are still there; the page no longer asks for one.
    expect(home).not.toContain("mapAcknowledged");
    expect(home).not.toContain("acknowledged={");
    // The map waits for the groups so the page below does not shift when they arrive, and the read is not retried so a failure does not hold the map back.
    expect(home).toContain('status={liveRecordsQuery.isLoading || mapFleetsQuery.isLoading ? "loading"');
    expect(home).toContain('{ enabled: view === "home", retry: false,');
  });

  it("still says in words what a hollow square is, should a sample ever be handed to it, and draws an entry once", () => {
    expect(hero).toContain("acknowledgedRecords(acknowledged)");
    expect(hero).toContain("Hollow squares are BNB Chain registrations the directory lists and Nooscape has not reviewed");
    expect(hero).toContain("picked by a fixed rule that ignores quality.");
    // An entry that is also a reviewed record is drawn once, as the record.
    expect(hero).toContain("reviewed.has(entry.agentId)");
  });

  it("draws such an entry as an outline, counts it apart in the key, and reads no evidence for it", () => {
    expect(constellation).toMatch(/if \(isAcknowledged\(node\)\) \{\s*context\.lineWidth = 0\.4;\s*context\.stroke\(MARKERS\[style\.shape\]\);/);
    expect(hero).toContain("acknowledgedLegendEntries(nodes)");
    expect(hero).toMatch(/of \{\(acknowledged\?\.listed \?\? entry\.count\)\.toLocaleString\("en-US"\)\} acknowledged/);
    expect(hero).toContain("node !== null && !isAcknowledged(node)");
    // The tiers listed under the map are the reviewed records' tiers only.
    expect(hero).toContain("if (!isAcknowledged(candidate) && !isFleet(candidate)) counts.set(candidate.tier");
  });

  it("gives such an entry a card with no tier, no evidence and no verdict, that says what it is", () => {
    expect(card).toContain("Not reviewed, no evidence tier");
    expect(card).toContain("Nooscape has not reviewed it and holds no evidence tier for it. Acknowledgement is never endorsement.");
    expect(card).toContain('"Acknowledged, not reviewed"');
    expect(card).toContain("View entry");
  });

  it("loads after the first paint, behind a placeholder that holds its place", () => {
    expect(home).toContain('lazy(() => import("./home/LandingHero"))');
    expect(home).toMatch(/<Suspense fallback=\{<div className="mb-5 h-\[520px\]"/);
  });

  it("draws nothing in place of records it does not have", () => {
    expect(hero).toContain("Nothing is drawn in their place.");
    expect(hero).toContain('status !== "ready" || nodes.length === 0');
  });

  it("reads the evidence only for the record on the card, once the selection has settled", () => {
    expect(hero).toContain("enabled: settledId !== null && settledId === shownId");
  });

  it("shows a tier only from the record's own tier, with its matching sentence, and never a score", () => {
    expect(card).toContain("tierExplanations[node.tier]");
    expect(card).toContain("tier.sentence");
    // Comments may say there is no score; the markup must not show one.
    expect(card.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/score|trust %|rating/i);
    expect(hero).toContain("nothing here is a score.");
  });

  it("links to the record's own page", () => {
    expect(card).toContain("/agents/${encodeURIComponent(node.id)}");
  });

  it("keeps its animation frame loop free of layout reads", () => {
    const loop = constellation.slice(constellation.indexOf("const draw = "), constellation.indexOf("frame = requestAnimationFrame(draw);"));
    expect(loop.length).toBeGreaterThan(200);
    expect(loop).not.toMatch(/getBoundingClientRect|offsetWidth|offsetHeight|clientWidth|clientHeight|getComputedStyle/);
  });
});

describe("selecting on the scan map", () => {
  it("never leaves the card empty: the pinned record, else the scanned one, else the featured one", () => {
    expect(hero).toContain("currentSelection(nodes, pinnedId, scannedId)");
    expect(hero).toContain("selectedId={shownId}");
    expect(hero).toContain("kind={selection.kind}");
  });

  it("lets a click or tap pin a record and the card unpin it", () => {
    expect(constellation).toContain('canvas.addEventListener("click", onClick)');
    expect(constellation).toContain("pin(hit.id === pinned ? null : hit.id)");
    expect(hero).toContain("onUnpin={() => setPinnedId(null)}");
    expect(card).toContain("Unpin");
  });

  it("finds the record under the pointer through a grid, within a radius that is at least 24px and at least 44px on a touch screen", () => {
    const radius = /const SCAN_RADIUS = \{ fine: (\d+), coarse: (\d+) \} as const;/.exec(constellation);
    expect(radius).not.toBeNull();
    expect(Number(radius![1])).toBeGreaterThanOrEqual(24);
    expect(Number(radius![2])).toBeGreaterThanOrEqual(44);
    expect(constellation).toContain("nearestNodeInGrid(");
    const loop = constellation.slice(constellation.indexOf("const draw = "), constellation.indexOf("frame = requestAnimationFrame(draw);"));
    expect(loop).not.toContain("buildNodeGrid(");
  });

  it("moves between records with the arrow keys, pins with Enter, and clears with Escape, only while focus is on the list", () => {
    expect(constellation).toContain("neighborInDirection(nodes, current, ARROWS[event.key]!, aspect)");
    expect(constellation).toContain('<ul ref={listRef} className="sr-only" aria-label="Records and groups on the map" onKeyDown={move}>');
    expect(constellation).toContain("onClick={() => onPin(node.id === pinnedId ? null : node.id)}");
    expect(constellation).toContain("aria-pressed={node.id === pinnedId}");
    const escape = constellation.slice(constellation.indexOf('event.key === "Escape"'), constellation.indexOf("const summary"));
    expect(escape).toContain("onPin(null)");
    expect(escape).toContain("onScan(null)");
  });

  it("shows the keyboard focus on the map itself, and says how to use the map in words", () => {
    expect(constellation).toContain("focus-within:shadow-[0_0_0_2px_var(--ns-radar)]");
    expect(constellation).toContain('aria-describedby="map-keys"');
    expect(constellation).toContain('id="map-keys"');
  });

  it("colours a record by its chain and marks it with the chain's own shape", () => {
    expect(constellation).toContain("CHAIN_STYLE[chainStyleKey(node)]");
    expect(constellation).toContain("context.fill(MARKERS[style.shape])");
    expect(hero).toContain("legendEntries(nodes)");
    expect(hero).toContain("markerPath(entry.shape)");
  });

  it("rings the record on the card in the brand colour, the same as the --ns-radar token", () => {
    const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8").toLowerCase();
    const ring = /const SELECTED_RING = "(#[0-9a-fA-F]{6})";/.exec(constellation)?.[1]?.toLowerCase();
    expect(ring).toBeDefined();
    expect(css).toContain(`--ns-radar: ${ring};`);
  });

  it("draws its labels at 12px or more, truncated, with the chain named in words", () => {
    const size = /context\.font = '(\d+)px/.exec(constellation)?.[1];
    expect(Number(size)).toBeGreaterThanOrEqual(12);
    expect(constellation).toContain("truncateLabel(node.name, 24)");
    expect(constellation).toContain("CHAIN_STYLE[chainStyleKey(node)].label.toUpperCase()");
  });

  it("says why the featured record is first, and that it is not an endorsement", () => {
    expect(card).toContain("It is where to start, not an endorsement.");
    expect(card).toContain('featured: "Where the map opens"');
  });
});

/**
 * The BNB Chain fleet lights (docs/bsc-fleet-lights-2026-10-16.md): one large circle for a group of registrations that share
 * a wallet, a link, a host or a template, with its count. A browser would be needed to test the drawing, so this guards where
 * its data comes from and what it is allowed to say.
 */
describe("the BNB fleet lights on the scan map", () => {
  const cardSource = card.replace(/\/\*[\s\S]*?\*\//g, "");
  const fleetCard = cardSource.slice(cardSource.indexOf("function FleetCard"));

  it("reads the groups from the one endpoint that returns them, waits for them with the rest, and does not retry", () => {
    expect(home).toContain("trpc.liveData.mapFleets.useQuery(undefined, { enabled: view === \"home\", retry: false,");
    expect(home).toContain("fleets={mapFleetsQuery.data ?? null}");
    expect(hero).toContain("fleetRecords(fleets, arcFleets)");
    expect(hero).toContain("...lights");
  });

  it("asks for no evidence for a light and tells the owl nothing about it", () => {
    expect(hero).toContain("node !== null && !isAcknowledged(node) && !isFleet(node)");
    expect(hero).toContain("if (node && (isAcknowledged(node) || isFleet(node))) return { status: \"idle\" };");
    expect(read("../../components/home/landingFacts.ts")).toContain('if (!node || node.kind === "fleet") return null;');
  });

  it("draws a light as one circle with its count under it, and never as a dot of a record", () => {
    expect(constellation).toContain("fleetReach(node.fleet)");
    expect(constellation).toContain("compactCount(node.fleet?.count ?? 0)");
    expect(constellation).toMatch(/for \(const node of current\) \{\s*if \(isFleet\(node\)\) continue;/);
    // The faint links join the dots only.
    expect(constellation).toContain("nearestLinks(nodes.filter(node => !isFleet(node)), aspect)");
  });

  it("gives a light a card with the shared fact, what it does not show, and no tier, no evidence and no record to open", () => {
    expect(card).toContain("if (isFleet(node)) return <FleetCard");
    expect(fleetCard).toContain("fleetFact(fleet)");
    expect(fleetCard).toContain("fleetNotProved(fleet)");
    expect(fleetCard).toContain("FLEET_OVERLAP_NOTE");
    expect(fleetCard).toContain("A group is not an agent and is not reviewed.");
    // The only link is to the chain's own page. No light opens an agent, an entry or a record.
    expect(fleetCard.match(/<Link/g)).toHaveLength(1);
    expect(fleetCard).toContain("href={`/chains/${fleet.chain}`}");
    expect(fleetCard).not.toContain("/agents/");
    expect(fleetCard).not.toMatch(/tierExplanations|evidence\./);
    expect(fleetCard).not.toMatch(/scam|fraud|fake|spam|sybil|malicious|suspicious|score|rank|trust/i);
  });

  it("says under the map how many groups are drawn of how many there are, and that no registration is", () => {
    expect(hero).toContain("fleetsCaption(fleets)");
    expect(hero).toContain("groups · {lightCount} of");
  });
});

/**
 * The Solana owner-wallet lights (docs/solana-lights-2026-10-18.md): one large diamond for a wallet a registry records for 100
 * or more entries, from the same endpoint as the BNB Chain groups. This guards where they come from and what they are allowed
 * to say; their placement and wording are in constellationModel.test.ts and server/mapFleets.test.ts.
 */
describe("the Solana owner-wallet lights on the scan map", () => {
  const cardSource = card.replace(/\/\*[\s\S]*?\*\//g, "");
  const fleetCard = cardSource.slice(cardSource.indexOf("function FleetCard"));

  it("come from the same endpoint and the same node kind, so they ask for no evidence and tell the owl nothing", () => {
    expect(read("../../components/home/constellationModel.ts")).toContain("...(sample?.solana?.fleets ?? [])");
    expect(hero).toContain("fleetRecords(fleets, arcFleets)");
    expect(hero).toContain("if (node && (isAcknowledged(node) || isFleet(node))) return { status: \"idle\" };");
  });

  it("are drawn as a diamond in the chain's colour, so a circle is BNB Chain and a diamond is Solana", () => {
    expect(constellation).toContain("const shape = fleetShape(node.fleet);");
    expect(constellation).toContain("lightOutline(context, x, y, radius, shape);");
    expect(constellation).toContain("const [red, green, blue] = rgbOf(style.color);");
  });

  it("say on the card that the wallet is the owner a registry records today, with what that does not show", () => {
    expect(fleetCard).toContain("fleetKindLabel(fleet)");
    expect(fleetCard).toContain('fleet.chain === "solana" ? "Owner wallet" : fleet.chain === "robinhood" || fleet.chain === "arc" ? "Registering wallet" : "Wallet"');
    expect(fleetCard).toContain("fleetOverlapNote(fleet)");
    expect(fleetCard).not.toMatch(/scam|fraud|fake|spam|sybil|malicious|suspicious|score|rank|trust/i);
  });

  it("are counted, captioned and keyed apart from the BNB Chain groups, and the caption links the Solana census", () => {
    expect(hero).toContain("solanaLightsCaption(fleets.solana)");
    expect(hero).toContain("owner wallets · {solanaLightCount} of");
    expect(hero).toContain('href="/field/solana-registries-2026-10-18"');
  });
});

/**
 * The Robinhood Chain registering-wallet lights (docs/robinhood-lights-2026-10-19.md): one large hexagon for a wallet the
 * directory records against 100 or more entries, from the same endpoint as the other lights. This guards where they come from
 * and what they are allowed to say; their placement and wording are in constellationModel.test.ts and server/mapFleets.test.ts.
 */
describe("the Robinhood Chain registering-wallet lights on the scan map", () => {
  const cardSource = card.replace(/\/\*[\s\S]*?\*\//g, "");
  const fleetCard = cardSource.slice(cardSource.indexOf("function FleetCard"));

  it("come from the same endpoint and the same node kind, so they ask for no evidence and tell the owl nothing", () => {
    expect(read("../../components/home/constellationModel.ts")).toContain("...(sample?.robinhood?.fleets ?? [])");
    expect(hero).toContain("fleetRecords(fleets, arcFleets)");
  });

  it("are drawn as a hexagon in the chain's colour, so a circle is BNB Chain, a diamond is Solana and a hexagon is Robinhood Chain", () => {
    expect(constellation).toContain('if (shape === "hexagon") {');
    expect(constellation).toContain("const [red, green, blue] = rgbOf(style.color);");
  });

  it("say on the card that the wallet is the registering wallet, with what that does not show", () => {
    expect(fleetCard).toContain("fleetNotProved(fleet)");
    expect(fleetCard).toContain("Registering wallet");
    expect(fleetCard).not.toMatch(/scam|fraud|fake|spam|sybil|malicious|suspicious|score|rank|trust/i);
  });

  it("are counted, captioned and keyed apart from the BNB Chain groups and the Solana owner wallets", () => {
    expect(hero).toContain("robinhoodLightsCaption(fleets.robinhood)");
    expect(hero).toContain("registering wallets · {robinhoodLightCount} of");
  });
});

/**
 * The Arc lights (docs/arc-lights-2026-10-20.md): one large dome for each of the largest groups of the Arc page, from the registry rows,
 * while Arc's switch is on. This guards where they come from and what they are allowed to say; their placement and wording are in
 * constellationModel.test.ts and server/mapFleets.test.ts.
 */
describe("the Arc lights on the scan map", () => {
  const cardSource = card.replace(/\/\*[\s\S]*?\*\//g, "");
  const fleetCard = cardSource.slice(cardSource.indexOf("function FleetCard"));

  it("are read only while Arc's switch is on in the build, are not waited for and are not retried, so a failed read leaves the map as it was", () => {
    expect(home).toContain('trpc.liveData.registryFleets.useQuery({ chain: "arc" }, { enabled: view === "home" && featureOn("chain_arc", import.meta.env.VITE_FEATURES), retry: false,');
    expect(home).toContain("arcFleets={arcFleetsQuery.data ?? null}");
    const status = home.slice(home.indexOf("<LandingHero"), home.indexOf("/>", home.indexOf("<LandingHero")));
    expect(status).not.toContain("arcFleetsQuery.isLoading");
  });

  it("come from the same node kind as the other lights, so they ask for no evidence and tell the owl nothing", () => {
    expect(read("../../components/home/constellationModel.ts")).toContain("...arcLights(arc)");
    expect(hero).toContain("fleetRecords(fleets, arcFleets)");
    expect(hero).toContain("...lights");
  });

  it("are drawn as a dome in Arc's colour, so a circle is BNB Chain, a diamond is Solana, a hexagon is Robinhood Chain and a dome is Arc", () => {
    expect(constellation).toContain('if (shape === "dome") {');
    expect(constellation).toContain("context.arc(x, y + reach * 0.5, reach, Math.PI, 0);");
    expect(constellation).toContain("const [red, green, blue] = rgbOf(style.color);");
  });

  it("say on the card that the wallet is the registering wallet, with what that does not show, and link the Arc page", () => {
    expect(fleetCard).toContain("fleetNotProved(fleet)");
    expect(fleetCard).toContain('fleet?.chain === "arc" ? <path d={markerPath("dome")}');
    expect(fleetCard).toContain('fleet.chain === "robinhood" || fleet.chain === "arc" ? "Registering wallet"');
    expect(fleetCard).toContain("href={`/chains/${fleet.chain}`}");
  });

  it("have a key entry and a caption of their own, drawn only when there are domes", () => {
    expect(hero).toContain("arcLightCount > 0 && arcFleets");
    expect(hero).toContain("groups · {arcLightCount} of");
    expect(hero).toContain("arcLightsCaption(arcFleets, arcLightCount)");
    expect(hero).toContain("{arcNote && <p");
  });
});
