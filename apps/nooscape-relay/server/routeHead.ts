import express, { type Request, type Response, type Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { listedChainLabel, listedChainOf } from "@shared/chains";
import { SITE_ORIGIN, type PageMeta } from "@shared/owlsCatch";
import { injectHead } from "./catchPage";
import { isCircuitOpenError } from "./dbBreaker";
import { getAgentDirectoryEntry, listLiveAtlasRecords } from "./db";
import { isClientRoutePath } from "./clientRoutes";
import { sanitizePublicText } from "./publicText";

/**
 * The head of every page the app routes, for a crawler that runs no script (the one behind a post on X, a chat's link
 * preview, a search engine). The site is a single page app, so before this the shell's head went out for every address:
 * the homepage's title, and a canonical link and `og:url` that said the page was the homepage. A shared link to a report
 * previewed as the homepage, and the sitemap listed eleven pages that each said they were a copy of the first.
 *
 * Each routed page now gets its own title, description, address and robots rule, written into the shell before it is sent,
 * the way `catchPages` does for /catch. Only the title, the description, the card text and the canonical address change,
 * and the card itself for the pages that have one of their own (the three chain pages): every other page keeps the site's
 * card, and no script is touched, so the policy hashes derived from the shell still match.
 *
 * - The fixed pages come from the table below. A test fails when a route is added to the client without a line here.
 * - /agents/:id reads the agent's name (a reviewed record, or an entry of the directory) through a short cache, so a
 *   crawler that fetches many ids does not read the database each time. Reviewed records may be indexed. An acknowledged
 *   entry may not (`noindex, follow`): it is one of a quarter of a million thin pages, acknowledged and never reviewed, and
 *   the sitemap has never listed them. An address with no agent behind it is kept out of search too.
 * - The homepage keeps the shell's own head, which is right for it. A path the app cannot route is the fallback's, with
 *   its real 404. If the agent cannot be read the ordinary shell is sent, because the server cannot tell which it is.
 */

const INDEXED = "index, follow, max-image-preview:large";
const NOT_INDEXED = "noindex, follow";
const OPERATOR_ONLY = "noindex, nofollow";

/** A page's own card: a 1200 by 630 PNG in client/public, and the words that describe it for a reader who cannot see it. */
type Card = { file: string; alt: string };
type Head = { title: string; description: string; robots?: string; image?: Card };

const PROMISES = "No scores for sale. No rankings for hire.";

/** The fixed pages, by address. Plain sentences, none longer than a search result shows, none a claim the page does not make. */
export const ROUTE_HEADS: Record<string, Head> = {
  "/field": {
    title: "The field, in full",
    description: "The capability terrain, the evidence filter, what nobody can measure yet, the settlement rail and the search that finds an agent in the Deep map.",
  },
  "/chains/robinhood": {
    title: "Robinhood Chain agent registry",
    description: "Explore reviewed records, the wallets that registered most of the registry, and measured identity events on Robinhood Chain. Character movement is illustrative, not agent activity.",
    image: {
      file: "nooscape-card-chain-robinhood.png",
      alt: `Nooscape, World 01, Robinhood Chain: hexagon formations and small scouts on orbit rings, beside the words The orbital field, A new sky for agent identities, the note Illustration, not agent activity, and the line ${PROMISES}`,
    },
  },
  "/chains/solana": {
    title: "Solana agent registries",
    description: "Explore identity records and anchored registration events across Solana's three mapped registries. Events are not conversations.",
    image: {
      file: "nooscape-card-chain-solana.png",
      alt: `Nooscape, World 02, Solana: three registry lanes, Metaplex, 8004 and SAID, with diamond formations and small scouts, beside the words The prism garden, Three registries. One living field, the note Illustration, not agent activity, and the line ${PROMISES}`,
    },
  },
  "/chains/arc": {
    title: "Arc agent registry",
    description: "Explore the entries listed on Arc and the groups of registrations that share a wallet, a link or a host. A group is not an agent. Character movement is illustrative, not agent activity.",
    image: {
      file: "nooscape-card-chain-arc.png",
      alt: `Nooscape, World 04, Arc: four arched platforms, same wallet, same host, same profile link and entries, the first three with dome formations and the last with small scouts, beside the words The glass harbor, A new registry, read in full, the note Illustration, not agent activity, and the line ${PROMISES}`,
    },
  },
  "/chains/base": {
    title: "Base registry groups",
    description: "Explore the groups of Base registrations that share a wallet, a link or a host. A group is not an agent, and a registration is not an endorsement.",
    image: {
      file: "nooscape-card-chain-base.png",
      alt: `Nooscape, World 05, Base: three platforms, same host, same profile link and same wallet, each with cross formations, beside the words The open shore, A busy registry, read in groups, the note Illustration, not agent activity, and the line ${PROMISES}`,
    },
  },
  "/field/arc-registry-2026-10-20": {
    title: "Arc registry census, 2026-10-20",
    description: "A dated count of the ERC-8004 identity registry on Arc as the directory holds it: who registered, what the listing rules held out and what the chain records. Counts only, with no agent, wallet or host named.",
  },
  "/field/base-registry-2026-10-21": {
    title: "Base registry census, 2026-10-21",
    description: "A dated count of the ERC-8004 identity registry on Base as the directory holds it: who registered, what the listing rules held out, what the chain records and when. Counts only, with no agent, wallet or host named.",
  },
  "/chains/bnb": {
    title: "BNB Chain registry groups",
    description: "Explore the groups of BNB Chain registrations that share a wallet, a link, a host or a template. A group is not an agent, and a registration is not an endorsement.",
    image: {
      file: "nooscape-card-chain-bnb.png",
      alt: `Nooscape, World 03, BNB Chain: four platforms, same host, same profile link, same wallet and same template, each with disc formations, beside the words The amber foundry, Groups, not agents, the note Illustration, not agent activity, and the line ${PROMISES}`,
    },
  },
  "/field/bnb-registry-2026-10-16": {
    title: "BNB Chain registry census, 2026-10-16",
    description: "A dated census of the BNB Chain ERC-8004 identity registry: what fills it, and how much of it is shared templates, platform issuers and repeated links. Counts over recorded facts, not a score.",
  },
  "/field/bnb-ratings-2026-10-16": {
    title: "BNB Chain rating census, 2026-10-16",
    description: "A dated census of the ratings written to the BNB Chain ERC-8004 reputation registry: how many there are, how they are spread across raters, and how many carry one repeated value. Not a score.",
  },
  "/field/solana-registries-2026-10-18": {
    title: "Solana registry census, 2026-10-18",
    description: "A dated census of the SAID, 8004 and Metaplex registries on Solana as the directory holds them: size, wallets, links, host names and what each records. Counts over recorded facts, not a score.",
  },
  "/field/robinhood-registry-2026-10-20": {
    title: "Robinhood Chain registry census, 2026-10-20",
    description: "A dated census of the ERC-8004 identity registry on Robinhood Chain as the directory holds it: size, registering wallets, host names, names and what the chain records for each entry. Counts over recorded facts, not a score.",
  },
  "/developers": {
    title: "Developer API",
    description: "The public Nooscape API: reviewed agent records, evidence tiers, publisher-key states and signed evidence envelopes, read as JSON over HTTP.",
  },
  "/developers/keys": {
    title: "API keys",
    description: "Make a free Nooscape API key, see what it has used, or end it. A key raises how much you can ask. It never changes what the API says about an agent.",
  },
  "/verify": {
    title: "Verify an evidence packet",
    description: "Check that a Nooscape evidence packet was signed by a Nooscape relay key in the published manifest and has not been altered since. It does not show that an agent is real or safe.",
  },
  "/sources": {
    title: "Source status",
    description: "Every approved source, with its lifecycle and how fresh it is. No raw payloads, operator identities or storage locations are shown.",
  },
  "/context": {
    title: "Ecosystem context",
    description: "A small view of aggregate activity from an approved public census. It is context for discovery, not a trust score, a valuation or a claim about any agent.",
  },
  "/about": {
    title: "What Nooscape is and is not",
    description: "Nooscape is an open agent observatory and the evidence layer for agent trust. It watches registries it does not run, and labels each record by how much has been checked. It does not run agents or route value.",
  },
  "/changes": {
    title: "What changed",
    description: "Every ownership and profile event the activity walk has covered on the ERC-8004 identity registry: mints, hand-outs from the minting wallet, later changes of hands and profile-link edits.",
  },
  "/checker": {
    title: "Nooscape-Checker",
    description: "If you found Nooscape-Checker in your server logs: it is the user agent of Nooscape, an open observatory of AI agents. This page says what it asks for, how it behaves and how to make it stop.",
  },
  "/disputes": {
    title: "Disputes",
    description: "Think Nooscape got something wrong? A record says what a source published and that Nooscape retained it on a date. If a record is wrong, or should not be shown, tell us.",
  },
  "/privacy": {
    title: "Privacy",
    description: "What Nooscape keeps about the people who visit it, and what it publishes about wallets and registries.",
  },
  "/terms": {
    title: "Terms",
    description: "Nooscape is an open agent observatory. It reads records from approved sources and keeps a signed copy of what was observed. How you may read it, link to it and use its public API.",
  },
  "/contact": {
    title: "Contact",
    description: "Where to write to Nooscape about a wrong record, a privacy question, a security report or support.",
  },
  "/admin/sources": {
    title: "Source control",
    description: "Operator sign-in for the source control plane. This is not a public page.",
    robots: OPERATOR_ONLY,
  },
  "/404": {
    title: "Page not found",
    description: "There is no page at this address.",
    robots: NOT_INDEXED,
  },
};

/** Addresses the table does not need: the homepage keeps the shell's own head, and /catch has `catchPages`. */
export const ROUTES_WITH_THEIR_OWN_HEAD: readonly string[] = ["/", "/catch"];

const metaOf = (pathname: string, head: Head): PageMeta => ({
  title: `${head.title} | Nooscape`,
  heading: head.title,
  description: head.description,
  url: `${SITE_ORIGIN}${pathname}`,
  robots: head.robots ?? INDEXED,
  ...(head.image ? { image: { url: `${SITE_ORIGIN}/${head.image.file}`, alt: head.image.alt } } : {}),
});

/** What the head says about an agent: its name, whether it is a reviewed record, and the chain it is on when it is on one. */
export type AgentHeadFacts = { name: string; reviewed: boolean; chain: string | null };

export function agentMeta(id: string, facts: AgentHeadFacts | null): PageMeta {
  const url = `${SITE_ORIGIN}/agents/${encodeURIComponent(id)}`;
  if (!facts) {
    return { title: "Agent | Nooscape", heading: "Agent", description: "No agent was found at this address.", url, robots: NOT_INDEXED };
  }
  const description = facts.reviewed
    ? `${facts.name} is a reviewed record in the Nooscape directory, with the evidence it was read from kept and signed. A tier is a level of evidence, not a score.`
    : `${facts.name} is an acknowledged entry in the Nooscape directory${facts.chain ? `, registered on ${facts.chain}` : ""}. Acknowledged is not reviewed, and never an endorsement.`;
  return { title: `${facts.name} | Nooscape`, heading: facts.name, description, url, robots: facts.reviewed ? INDEXED : NOT_INDEXED };
}

export type RouteHeadDeps = { readAgent: (id: string) => Promise<AgentHeadFacts | null> };

/** The column an entry's id is held in is 36 characters wide, so a longer id cannot be an entry. */
const ENTRY_ID_MAX_CHARS = 36;
const SHOWN_NAME_MAX_CHARS = 120;
const cleanName = (raw: string) => sanitizePublicText(raw, SHOWN_NAME_MAX_CHARS) ?? "Agent";
/** The chain a protocol is on, as the site names it, or null for a protocol on none (a locator protocol). */
const chainLabelOf = (protocol: string) => {
  const chain = listedChainOf(protocol);
  return chain ? listedChainLabel(chain) : null;
};

/** An id is looked up as a directory entry first (one row by its key), then as a reviewed record (the live records, which is the heavier read). */
async function readAgentFromDatabase(id: string): Promise<AgentHeadFacts | null> {
  if (id.length <= ENTRY_ID_MAX_CHARS) {
    const entry = await getAgentDirectoryEntry(id);
    if (entry) return { name: cleanName(entry.displayName), reviewed: false, chain: chainLabelOf(entry.protocol) };
  }
  const record = (await listLiveAtlasRecords()).find(item => item.agentId === id);
  return record ? { name: cleanName(record.displayName), reviewed: true, chain: null } : null;
}

const AGENT_CACHE_MS = 60_000;
const AGENT_CACHE_KEYS = 1_000;

/** The database read behind /agents/:id, held for a minute per id (an unknown id too), so a crawler cannot make it a read per request. */
export function cachedAgentReader(read: (id: string) => Promise<AgentHeadFacts | null>, now: () => number = Date.now): (id: string) => Promise<AgentHeadFacts | null> {
  const held = new Map<string, { until: number; facts: AgentHeadFacts | null }>();
  return async id => {
    const at = now();
    const hit = held.get(id);
    if (hit && hit.until > at) return hit.facts;
    const facts = await read(id);
    if (held.size >= AGENT_CACHE_KEYS) held.clear();
    held.set(id, { until: at + AGENT_CACHE_MS, facts });
    return facts;
  };
}

const exactPath = (req: Request) => (req.originalUrl || "").split("?")[0]!;

/** Routes for the fixed pages and /agents/:id, to mount after the static files and `catchPages`, and before the fallback. */
export function routeHeads(distPath: string, deps: RouteHeadDeps = { readAgent: cachedAgentReader(readAgentFromDatabase) }): Router {
  const router = express.Router();
  let shell: string | null = null;
  const readShell = () => (shell ??= fs.readFileSync(path.resolve(distPath, "index.html"), "utf8"));
  const send = (res: Response, meta: PageMeta) => {
    res.status(200).set("Cache-Control", "public, max-age=60").send(injectHead(readShell(), meta));
  };

  // `use`, not `get("*")`: Express decodes a wildcard's path itself and answers a malformed percent sequence with an error page,
  // where the fallback would have sent the ordinary shell. GET and HEAD only, like `get`.
  router.use(async (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    try {
      const pathname = exactPath(req);
      const head = ROUTE_HEADS[pathname];
      if (head && isClientRoutePath(pathname)) return send(res, metaOf(pathname, head));
      const segment = /^\/agents\/([^/]+)$/.exec(pathname)?.[1];
      if (segment === undefined) return next();
      let id: string;
      try {
        id = decodeURIComponent(segment);
      } catch {
        return next();
      }
      let facts: AgentHeadFacts | null;
      try {
        facts = await deps.readAgent(id);
      } catch (error) {
        if (!isCircuitOpenError(error)) console.warn("[RouteHead] The agent could not be read; sending the ordinary page.");
        return next();
      }
      send(res, agentMeta(id, facts));
    } catch {
      next();
    }
  });

  return router;
}
