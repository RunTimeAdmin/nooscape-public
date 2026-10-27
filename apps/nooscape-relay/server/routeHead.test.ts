import express from "express";
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { archiveMeta, noCatchMeta } from "@shared/owlsCatch";
import { buildCspFromHtml } from "./_core/securityHeaders";
import { injectHead } from "./catchPage";
import { EXACT_CLIENT_ROUTES, FLAGGED_CLIENT_ROUTES } from "./clientRoutes";
import { CIRCUIT_OPEN_CODE } from "./dbBreaker";
import { agentMeta, cachedAgentReader, ROUTE_HEADS, ROUTES_WITH_THEIR_OWN_HEAD, routeHeads, type AgentHeadFacts } from "./routeHead";

/**
 * The head the server writes for every routed page, so a shared link or a search result reads the page it points at and
 * not the homepage. The shell is the site's real index.html with an inline script added, as the built page has one. The test
 * app's fallback is a plain `use`, not the `"*"` the server mounts: Express decodes a wildcard's path itself and errors on a
 * malformed percent sequence, which is the production fallback's own behaviour and not what is tested here.
 */
const SCRIPT = "window.__RUNTIME__ = 1;\n(function () { /* inline */ })();";
const SOURCE_SHELL = fs.readFileSync(path.resolve(import.meta.dirname, "../client/index.html"), "utf8").replace("</head>", `<script id="runtime">${SCRIPT}</script></head>`);
const INDEXED = archiveMeta().robots;
const NOT_INDEXED = noCatchMeta("2026-10-12").robots;

const tag = (html: string, pattern: RegExp) => pattern.exec(html)?.[0] ?? "";
const flat = (html: string) => html.replace(/\s+/g, " ");

describe("the table of fixed pages", () => {
  it("has a line for every route the client has, bar the two that have a head of their own, and no line for a route it does not have", () => {
    const missing = EXACT_CLIENT_ROUTES.filter(route => !ROUTES_WITH_THEIR_OWN_HEAD.includes(route) && !(route in ROUTE_HEADS));
    expect(missing, "add these routes to ROUTE_HEADS in server/routeHead.ts").toEqual([]);
    // A page behind a switch has a line too: it is served only while its switch is on.
    expect(Object.keys(ROUTE_HEADS).filter(route => !EXACT_CLIENT_ROUTES.includes(route) && !Object.values(FLAGGED_CLIENT_ROUTES).flat().includes(route))).toEqual([]);
  });

  it("writes plain sentences: a title without the site name, a description a result can show, and no long dash", () => {
    for (const [route, head] of Object.entries(ROUTE_HEADS)) {
      expect(head.title, route).not.toContain("|");
      expect(head.title.length, route).toBeGreaterThan(2);
      expect(head.title.length, route).toBeLessThanOrEqual(60);
      expect(head.description.length, route).toBeGreaterThan(30);
      expect(head.description.length, route).toBeLessThanOrEqual(230);
      expect(head.description, route).toMatch(/[.]$/);
      expect(`${head.title} ${head.description}`, route).not.toMatch(/[–—]/);
    }
  });

  it("describes each chain page without calling illustrative motion agent activity, an event a conversation or a registration an endorsement", () => {
    expect(ROUTE_HEADS["/chains/robinhood"]?.description).toContain("illustrative, not agent activity");
    expect(ROUTE_HEADS["/chains/solana"]?.description).toContain("not conversations");
    expect(ROUTE_HEADS["/chains/bnb"]?.description).toContain("A group is not an agent");
    expect(ROUTE_HEADS["/chains/bnb"]?.description).toContain("not an endorsement");
    expect(ROUTE_HEADS["/chains/arc"]?.description).toContain("A group is not an agent");
    expect(ROUTE_HEADS["/chains/arc"]?.description).toContain("illustrative, not agent activity");
    expect(ROUTE_HEADS["/chains/base"]?.description).toContain("A group is not an agent");
    expect(ROUTE_HEADS["/chains/base"]?.description).toContain("not an endorsement");
  });

  it("gives each page its own title, address and card text, and keeps its robots rule", () => {
    const html = flat(injectHead(SOURCE_SHELL, { title: "Nooscape-Checker | Nooscape", heading: "Nooscape-Checker", description: ROUTE_HEADS["/checker"]!.description, url: "https://nooscape.si/checker", robots: INDEXED }));
    expect(html).toContain("<title>Nooscape-Checker | Nooscape</title>");
    expect(tag(html, /<link rel="canonical"[^>]*>/)).toContain('href="https://nooscape.si/checker"');
    expect(tag(html, /<meta property="og:url"[^>]*>/)).toContain('content="https://nooscape.si/checker"');
  });
});

describe("the head of an agent", () => {
  const entry: AgentHeadFacts = { name: "Mesh Gate", reviewed: false, chain: "Robinhood Chain" };

  it("says what an acknowledged entry is and that it is never an endorsement, and keeps it out of search", () => {
    const meta = agentMeta("abc", entry);
    expect(meta.title).toBe("Mesh Gate | Nooscape");
    expect(meta.heading).toBe("Mesh Gate");
    expect(meta.description).toBe("Mesh Gate is an acknowledged entry in the Nooscape directory, registered on Robinhood Chain. Acknowledged is not reviewed, and never an endorsement.");
    expect(meta.url).toBe("https://nooscape.si/agents/abc");
    expect(meta.robots).toBe(NOT_INDEXED);
  });

  it("leaves the chain out for an entry that is on none", () => {
    expect(agentMeta("abc", { ...entry, chain: null }).description).toBe("Mesh Gate is an acknowledged entry in the Nooscape directory. Acknowledged is not reviewed, and never an endorsement.");
  });

  it("says a reviewed record has its evidence kept, calls a tier a level of evidence, and lets it be indexed", () => {
    const meta = agentMeta("agent-8616-3eee598fbc", { name: "Passkeys", reviewed: true, chain: null });
    expect(meta.description).toBe("Passkeys is a reviewed record in the Nooscape directory, with the evidence it was read from kept and signed. A tier is a level of evidence, not a score.");
    expect(meta.robots).toBe(INDEXED);
  });

  it("is a generic page kept out of search when no agent is behind the address, and encodes the id in the address", () => {
    const meta = agentMeta("a b/c", null);
    expect(meta.title).toBe("Agent | Nooscape");
    expect(meta.robots).toBe(NOT_INDEXED);
    expect(meta.url).toBe("https://nooscape.si/agents/a%20b%2Fc");
  });
});

describe("what changes in the shell and what must not", () => {
  const meta = agentMeta("abc", { name: "Mesh Gate", reviewed: false, chain: "Robinhood Chain" });

  it("changes the title, the description, the card text, the address and the robots rule, and nothing else", () => {
    const after = injectHead(SOURCE_SHELL, meta);
    const names = (html: string) => (html.match(/<(?:meta|link)\b[^>]*>/g) ?? []).map(found => found.replace(/\s+/g, " ").replace(/\bcontent="[^"]*"|\bhref="[^"]*"/g, "")).sort();
    expect(names(after)).toEqual(names(SOURCE_SHELL));
    expect(tag(flat(after), /<meta property="og:image"[^>]*>/)).toBe(tag(flat(SOURCE_SHELL), /<meta property="og:image"[^>]*>/));
    expect(buildCspFromHtml(after)).toEqual(buildCspFromHtml(SOURCE_SHELL));
    expect(buildCspFromHtml(after).inlineScriptHashes).toEqual([`'sha256-${createHash("sha256").update(SCRIPT, "utf8").digest("base64")}'`]);
  });

  it("escapes a name that holds markup", () => {
    const html = injectHead(SOURCE_SHELL, agentMeta("abc", { name: '<script>alert(1)</script> "x"', reviewed: false, chain: null }));
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(tag(flat(html), /<title>[^<]*<\/title>/)).toBe("<title>&lt;script&gt;alert(1)&lt;/script&gt; &quot;x&quot; | Nooscape</title>");
  });
});

describe("the card of a chain page", () => {
  const CHAINS: ReadonlyArray<readonly [route: string, name: string]> = [
    ["/chains/robinhood", "Robinhood Chain"],
    ["/chains/solana", "Solana"],
    ["/chains/bnb", "BNB Chain"],
    ["/chains/arc", "Arc"],
    ["/chains/base", "Base"],
    ["/chains/ethereum", "Ethereum"],
  ];
  const publicDir = path.resolve(import.meta.dirname, "../client/public");
  const cardOf = (route: string) => ROUTE_HEADS[route]!.image!;
  const IMAGE_TAGS = [/<meta property="og:image"[^>]*>/, /<meta property="og:image:secure_url"[^>]*>/, /<meta property="og:image:alt"[^>]*>/, /<meta name="twitter:image"[^>]*>/, /<meta name="twitter:image:alt"[^>]*>/];

  it("belongs to the six chain pages and to no other fixed page", () => {
    expect(Object.keys(ROUTE_HEADS).filter(route => ROUTE_HEADS[route]!.image).sort()).toEqual(CHAINS.map(([route]) => route).sort());
  });

  it("is a different 1200 by 630 PNG for each page, in the public folder, and not the site's own card", () => {
    const files = CHAINS.map(([route]) => cardOf(route).file);
    expect(new Set(files).size).toBe(CHAINS.length);
    const siteCard = /<meta property="og:image" content="https:[/][/]nooscape[.]si[/]([^"]+)"/.exec(SOURCE_SHELL)?.[1];
    expect(siteCard).toBe("nooscape-card-observatory.png");
    for (const file of files) {
      expect(file).toMatch(/^nooscape-card-chain-[a-z]+[.]png$/);
      expect(file).not.toBe(siteCard);
      const png = fs.readFileSync(path.join(publicDir, file));
      expect(png.subarray(1, 4).toString("latin1"), file).toBe("PNG");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], file).toEqual([1200, 630]);
      expect(png.length, `${file} is light enough for a crawler to fetch`).toBeLessThan(600_000);
    }
  });

  it("is described in words that name the chain, say the scouts are an illustration, carry the site's two promises, and hold no figure", () => {
    const barred = new RegExp(`[%${String.fromCharCode(0x2013, 0x2014)}]|[0-9]{3,}`);
    for (const [route, name] of CHAINS) {
      const { alt } = cardOf(route);
      expect(alt, route).toContain(name);
      expect(alt, route).toContain("Illustration, not agent activity");
      expect(alt, route).toContain("No scores for sale. No rankings for hire.");
      expect(alt.length, route).toBeLessThanOrEqual(420);
      // 8004 is a registry's name and not a figure.
      expect(alt.replace("8004", ""), route).not.toMatch(barred);
    }
  });

  it("is written into the five tags that carry a card, with the shell's own type, width and height left as they are", () => {
    const meta = { title: "Solana agent registries | Nooscape", heading: "Solana agent registries", description: ROUTE_HEADS["/chains/solana"]!.description, url: "https://nooscape.si/chains/solana", robots: INDEXED };
    const after = flat(injectHead(SOURCE_SHELL, { ...meta, image: { url: "https://nooscape.si/nooscape-card-chain-solana.png", alt: "A card & its words" } }));
    const before = flat(SOURCE_SHELL);
    for (const pattern of IMAGE_TAGS.slice(0, 2).concat(IMAGE_TAGS[3]!)) expect(tag(after, pattern)).toContain('content="https://nooscape.si/nooscape-card-chain-solana.png"');
    for (const pattern of [IMAGE_TAGS[2]!, IMAGE_TAGS[4]!]) expect(tag(after, pattern)).toContain('content="A card &amp; its words"');
    for (const key of ['property="og:image:type"', 'property="og:image:width"', 'property="og:image:height"', 'name="twitter:card"']) {
      expect(tag(after, new RegExp(`<meta ${key}[^>]*>`)), key).toBe(tag(before, new RegExp(`<meta ${key}[^>]*>`)));
    }
    // Nothing is added or removed, and the inline script and the policy built from it are as they were.
    const names = (html: string) => (html.match(/<(?:meta|link)\b[^>]*>/g) ?? []).map(found => found.replace(/\s+/g, " ").replace(/\bcontent="[^"]*"|\bhref="[^"]*"/g, "")).sort();
    expect(names(after)).toEqual(names(before));
    expect(buildCspFromHtml(after)).toEqual(buildCspFromHtml(before));
  });

  it("keeps the shell's own card when the page has none", () => {
    const after = flat(injectHead(SOURCE_SHELL, agentMeta("abc", { name: "Mesh Gate", reviewed: false, chain: null })));
    for (const pattern of IMAGE_TAGS) expect(tag(after, pattern)).toBe(tag(flat(SOURCE_SHELL), pattern));
  });

  it("cannot be turned into markup by its alt text", () => {
    const html = injectHead(SOURCE_SHELL, { title: "T | Nooscape", heading: "T", description: "D.", url: "https://nooscape.si/x", robots: INDEXED, image: { url: "https://nooscape.si/x.png", alt: '"><script>alert(1)</script>' } });
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("the cache in front of the agent read", () => {
  it("reads an id once a minute, holds an unknown id too, and reads again when the minute is up", async () => {
    let clock = 0;
    const reads: string[] = [];
    const read = cachedAgentReader(async id => {
      reads.push(id);
      return id === "known" ? { name: "Known", reviewed: false, chain: null } : null;
    }, () => clock);
    expect((await read("known"))?.name).toBe("Known");
    expect(await read("nobody")).toBeNull();
    expect((await read("known"))?.name).toBe("Known");
    expect(await read("nobody")).toBeNull();
    expect(reads).toEqual(["known", "nobody"]);
    clock = 61_000;
    await read("known");
    expect(reads).toEqual(["known", "nobody", "known"]);
  });

  it("gives requests that arrive while an id is being read that one read, and reads again if it failed", async () => {
    const reads: string[] = [];
    let release!: (facts: AgentHeadFacts | null) => void;
    const read = cachedAgentReader(id => {
      reads.push(id);
      return new Promise<AgentHeadFacts | null>(resolve => {
        release = resolve;
      });
    });
    const burst = [read("fresh"), read("fresh"), read("fresh")];
    release({ name: "Fresh", reviewed: false, chain: null });
    expect((await Promise.all(burst)).map(facts => facts?.name)).toEqual(["Fresh", "Fresh", "Fresh"]);
    expect(reads).toEqual(["fresh"]);

    // A failed read is not held: the next request reads again.
    let attempts = 0;
    const flaky = cachedAgentReader(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("storage down");
      return { name: "Back", reviewed: false, chain: null };
    });
    await expect(flaky("x")).rejects.toThrow("storage down");
    expect((await flaky("x"))?.name).toBe("Back");
  });

  it("does not grow without end when a crawler asks for many ids", async () => {
    const reads: string[] = [];
    const read = cachedAgentReader(async id => {
      reads.push(id);
      return null;
    });
    for (let index = 0; index < 1_001; index += 1) await read(`id-${index}`);
    await read("id-0");
    expect(reads.length).toBe(1_002);
  });
});

describe("the routes", () => {
  let dist: string;
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  let base: string;
  const reads: string[] = [];
  let facts: () => Promise<AgentHeadFacts | null> = async () => null;

  beforeAll(async () => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), "route-head-"));
    fs.writeFileSync(path.join(dist, "index.html"), SOURCE_SHELL);
    const app = express();
    app.use(
      routeHeads(dist, {
        readAgent: async id => {
          reads.push(id);
          return facts();
        },
      }),
    );
    app.use((_req, res) => {
      res.status(200).send("FALLBACK");
    });
    await new Promise<void>(resolve => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dist, { recursive: true, force: true });
  });

  afterEach(() => {
    reads.length = 0;
    facts = async () => null;
    vi.restoreAllMocks();
  });

  const get = async (pathname: string, init?: RequestInit) => {
    const response = await fetch(base + pathname, init);
    return { status: response.status, headers: response.headers, body: await response.text() };
  };

  it("serves each fixed page with its own title and address, as a page that may be cached for a minute", async () => {
    for (const route of EXACT_CLIENT_ROUTES.filter(route => route in ROUTE_HEADS)) {
      const page = await get(route);
      expect(page.status, route).toBe(200);
      expect(page.headers.get("content-type"), route).toBe("text/html; charset=utf-8");
      expect(page.headers.get("cache-control"), route).toBe("public, max-age=60");
      expect(page.body, route).toContain(`<title>${ROUTE_HEADS[route]!.title.replace(/'/g, "&#39;")} | Nooscape</title>`);
      expect(tag(page.body, /<link rel="canonical"[^>]*>/), route).toContain(`href="https://nooscape.si${route}"`);
      expect(tag(page.body, /<meta property="og:url"[^>]*>/), route).toContain(`content="https://nooscape.si${route}"`);
    }
    expect(reads).toEqual([]);
  });

  it("serves each chain page with its own card in the tags that carry it, and every other fixed page with the site's card", async () => {
    const before = flat(SOURCE_SHELL);
    const siteCard = tag(before, /<meta property="og:image"[^>]*>/);
    for (const route of EXACT_CLIENT_ROUTES.filter(route => route in ROUTE_HEADS)) {
      const html = flat((await get(route)).body);
      const card = ROUTE_HEADS[route]!.image;
      if (!card) {
        expect(tag(html, /<meta property="og:image"[^>]*>/), route).toBe(siteCard);
        expect(tag(html, /<meta name="twitter:image"[^>]*>/), route).toBe(tag(before, /<meta name="twitter:image"[^>]*>/));
        continue;
      }
      const url = `https://nooscape.si/${card.file}`;
      expect(tag(html, /<meta property="og:image"[^>]*>/), route).toContain(`content="${url}"`);
      expect(tag(html, /<meta property="og:image:secure_url"[^>]*>/), route).toContain(`content="${url}"`);
      expect(tag(html, /<meta name="twitter:image"[^>]*>/), route).toContain(`content="${url}"`);
      expect(tag(html, /<meta property="og:image:alt"[^>]*>/), route).toContain(`content="${card.alt}"`);
      expect(tag(html, /<meta name="twitter:image:alt"[^>]*>/), route).toContain(`content="${card.alt}"`);
    }
  });

  it("serves the Arc page's head only while its switch is on, and indexes it with its own card", async () => {
    const saved = process.env.VITE_FEATURES;
    try {
      delete process.env.VITE_FEATURES;
      expect((await get("/chains/arc")).body).toBe("FALLBACK");
      process.env.VITE_FEATURES = "chain_base,chain_ethereum";
      expect((await get("/chains/arc")).body).toBe("FALLBACK");
      process.env.VITE_FEATURES = "claims, chain_arc";
      const page = await get("/chains/arc");
      expect(page.status).toBe(200);
      expect(page.body).toContain("<title>Arc agent registry | Nooscape</title>");
      expect(tag(page.body, /<link rel="canonical"[^>]*>/)).toContain('href="https://nooscape.si/chains/arc"');
      expect(tag(page.body, /<meta name="robots"[^>]*>/)).toContain(`content="${INDEXED}"`);
      const card = ROUTE_HEADS["/chains/arc"]!.image!;
      const url = `https://nooscape.si/${card.file}`;
      const html = flat(page.body);
      expect(card.file).toBe("nooscape-card-chain-arc.png");
      for (const pattern of [/<meta property="og:image"[^>]*>/, /<meta property="og:image:secure_url"[^>]*>/, /<meta name="twitter:image"[^>]*>/]) expect(tag(html, pattern)).toContain(`content="${url}"`);
      for (const pattern of [/<meta property="og:image:alt"[^>]*>/, /<meta name="twitter:image:alt"[^>]*>/]) expect(tag(html, pattern)).toContain(`content="${card.alt}"`);
    } finally {
      if (saved === undefined) delete process.env.VITE_FEATURES;
      else process.env.VITE_FEATURES = saved;
    }
  });

  it("serves the Base page's head only while its switch is on, and indexes it with its own card", async () => {
    const saved = process.env.VITE_FEATURES;
    try {
      delete process.env.VITE_FEATURES;
      expect((await get("/chains/base")).body).toBe("FALLBACK");
      process.env.VITE_FEATURES = "chain_arc,chain_ethereum";
      expect((await get("/chains/base")).body).toBe("FALLBACK");
      process.env.VITE_FEATURES = "claims, chain_base";
      const page = await get("/chains/base");
      expect(page.status).toBe(200);
      expect(page.body).toContain("<title>Base registry groups | Nooscape</title>");
      expect(tag(page.body, /<link rel="canonical"[^>]*>/)).toContain('href="https://nooscape.si/chains/base"');
      expect(tag(page.body, /<meta name="robots"[^>]*>/)).toContain(`content="${INDEXED}"`);
      const card = ROUTE_HEADS["/chains/base"]!.image!;
      const url = `https://nooscape.si/${card.file}`;
      const html = flat(page.body);
      expect(card.file).toBe("nooscape-card-chain-base.png");
      for (const pattern of [/<meta property="og:image"[^>]*>/, /<meta property="og:image:secure_url"[^>]*>/, /<meta name="twitter:image"[^>]*>/]) expect(tag(html, pattern)).toContain(`content="${url}"`);
      for (const pattern of [/<meta property="og:image:alt"[^>]*>/, /<meta name="twitter:image:alt"[^>]*>/]) expect(tag(html, pattern)).toContain(`content="${card.alt}"`);
    } finally {
      if (saved === undefined) delete process.env.VITE_FEATURES;
      else process.env.VITE_FEATURES = saved;
    }
  });

  it("serves the Ethereum page's head only while its switch is on, and indexes it with its own card", async () => {
    const saved = process.env.VITE_FEATURES;
    try {
      delete process.env.VITE_FEATURES;
      expect((await get("/chains/ethereum")).body).toBe("FALLBACK");
      process.env.VITE_FEATURES = "chain_arc,chain_base";
      expect((await get("/chains/ethereum")).body).toBe("FALLBACK");
      process.env.VITE_FEATURES = "claims, chain_ethereum";
      const page = await get("/chains/ethereum");
      expect(page.status).toBe(200);
      expect(page.body).toContain("<title>Ethereum registry groups | Nooscape</title>");
      expect(tag(page.body, /<link rel="canonical"[^>]*>/)).toContain('href="https://nooscape.si/chains/ethereum"');
      expect(tag(page.body, /<meta name="robots"[^>]*>/)).toContain(`content="${INDEXED}"`);
      const card = ROUTE_HEADS["/chains/ethereum"]!.image!;
      const url = `https://nooscape.si/${card.file}`;
      const html = flat(page.body);
      expect(card.file).toBe("nooscape-card-chain-ethereum.png");
      for (const pattern of [/<meta property="og:image"[^>]*>/, /<meta property="og:image:secure_url"[^>]*>/, /<meta name="twitter:image"[^>]*>/]) expect(tag(html, pattern)).toContain(`content="${url}"`);
      for (const pattern of [/<meta property="og:image:alt"[^>]*>/, /<meta name="twitter:image:alt"[^>]*>/]) expect(tag(html, pattern)).toContain(`content="${card.alt}"`);
    } finally {
      if (saved === undefined) delete process.env.VITE_FEATURES;
      else process.env.VITE_FEATURES = saved;
    }
  });

  it("keeps the operator console and the 404 page out of search, and every other fixed page in", async () => {
    expect(tag((await get("/admin/sources")).body, /<meta name="robots"[^>]*>/)).toContain('content="noindex, nofollow"');
    expect(tag((await get("/404")).body, /<meta name="robots"[^>]*>/)).toContain(`content="${NOT_INDEXED}"`);
    expect(tag((await get("/privacy")).body, /<meta name="robots"[^>]*>/)).toContain(`content="${INDEXED}"`);
  });

  it("serves an agent with its own head, and asks for it once by the id as it arrived", async () => {
    facts = async () => ({ name: "Mesh Gate", reviewed: false, chain: "Robinhood Chain" });
    const page = await get("/agents/ac1dd8e3-2278-40e6-9e09-2b102f5504dc?utm_source=x");
    expect(page.status).toBe(200);
    expect(page.body).toContain("<title>Mesh Gate | Nooscape</title>");
    expect(tag(page.body, /<link rel="canonical"[^>]*>/)).toContain('href="https://nooscape.si/agents/ac1dd8e3-2278-40e6-9e09-2b102f5504dc"');
    expect(tag(page.body, /<meta name="robots"[^>]*>/)).toContain(`content="${NOT_INDEXED}"`);
    expect(reads).toEqual(["ac1dd8e3-2278-40e6-9e09-2b102f5504dc"]);
  });

  it("lets a reviewed record be indexed, and keeps an address with no agent behind it out of search", async () => {
    facts = async () => ({ name: "Passkeys", reviewed: true, chain: null });
    expect(tag((await get("/agents/agent-8623-f7867ea086")).body, /<meta name="robots"[^>]*>/)).toContain(`content="${INDEXED}"`);
    facts = async () => null;
    const none = await get("/agents/nobody");
    expect(none.status).toBe(200);
    expect(none.body).toContain("<title>Agent | Nooscape</title>");
    expect(tag(none.body, /<meta name="robots"[^>]*>/)).toContain(`content="${NOT_INDEXED}"`);
  });

  it("answers HEAD with the headers only", async () => {
    const head = await get("/privacy", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("leaves the homepage, /catch, a path with a trailing slash, another method and an unknown path to the ordinary fallback", async () => {
    expect((await get("/")).body).toBe("FALLBACK");
    expect((await get("/catch")).body).toBe("FALLBACK");
    expect((await get("/privacy/")).body).toBe("FALLBACK");
    expect((await get("/privacy", { method: "POST" })).body).toBe("FALLBACK");
    expect((await get("/nothing-here")).body).toBe("FALLBACK");
    expect((await get("/agents/")).body).toBe("FALLBACK");
    expect((await get("/agents/a/b")).body).toBe("FALLBACK");
    expect((await get("/agents/%E0%A4%A")).body).toBe("FALLBACK");
    expect(reads).toEqual([]);
  });

  it("sends the ordinary page, not an error, when the agent cannot be read, and says so once in the log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    facts = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:3306 password=hunter2");
    };
    const page = await get("/agents/abc");
    expect(page.status).toBe(200);
    expect(page.body).toBe("FALLBACK");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("hunter2");
  });

  it("says nothing in the log when the database breaker has already said it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    facts = async () => {
      throw Object.assign(new Error("paused"), { code: CIRCUIT_OPEN_CODE });
    };
    expect((await get("/agents/abc")).body).toBe("FALLBACK");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("a deploy with no built page", () => {
  it("falls through to the ordinary fallback rather than failing", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "route-head-empty-"));
    const app = express();
    app.use(routeHeads(empty, { readAgent: async () => null }));
    app.use((_req, res) => {
      res.status(200).send("FALLBACK");
    });
    const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect(await (await fetch(`${base}/privacy`)).text()).toBe("FALLBACK");
      expect(await (await fetch(`${base}/agents/abc`)).text()).toBe("FALLBACK");
    } finally {
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("where the routes are mounted", () => {
  it("come in serveStatic after the static files and the Catch routes and before the fallback, so a built file is never shadowed and the fallback never answers first", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "_core/vite.ts"), "utf8").split("\r\n").join("\n");
    const at = (text: string) => source.indexOf(text);
    expect(at("app.use(catchPages(distPath));")).toBeGreaterThan(-1);
    expect(at("app.use(catchPages(distPath));")).toBeLessThan(at("app.use(routeHeads(distPath));"));
    expect(at("app.use(routeHeads(distPath));")).toBeLessThan(at('app.use("*", (req, res) => {'));
  });
});
