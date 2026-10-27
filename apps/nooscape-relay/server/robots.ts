import type { SafeFetchReason, SafeFetchResult } from "./safeFetch";

/**
 * robots.txt, read the way RFC 9309 says, for the one visitor that asks: Nooscape-Checker. A host that tells automated
 * visitors to stay away is not asked anything by a check; that is how a host opts out, and the page the user agent names
 * says so.
 *
 * - The group that names this visitor ("Nooscape-Checker" or "Nooscape", with or without a version) is used; failing
 *   that, the group for every visitor (`*`). A visitor with no group is allowed everything.
 * - Within a group the rule with the longest matching pattern wins, and an Allow wins a tie. `*` in a pattern matches
 *   any run of characters and a trailing `$` anchors the end. An empty Disallow disallows nothing.
 * - robots.txt that is there and says nothing about this visitor allows it. One that is missing (any 4xx) allows it. One
 *   that cannot be read (a 5xx, no answer, longer than what is read) allows nothing until it can: the check is not made.
 */

/** The names this visitor answers to in a User-agent line, lower case. */
const OUR_NAMES = ["nooscape-checker", "nooscape"];

type RobotsRule = { allow: boolean; pattern: string };
type RobotsGroup = { agents: string[]; rules: RobotsRule[] };
type RobotsRules = RobotsGroup[];

/** Groups of User-agent lines, each with its Allow and Disallow rules. Anything else in the file is ignored. */
export function parseRobots(text: string): RobotsRules {
  const groups: RobotsRules = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (line === "" || colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      // Consecutive User-agent lines share one group; one after a rule starts the next.
      if (current === null || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.split("/")[0]!.trim().toLowerCase());
      lastWasAgent = true;
    } else if (field === "allow" || field === "disallow") {
      lastWasAgent = false;
      // A rule before any User-agent line belongs to no one, and an empty value allows or disallows nothing.
      if (current !== null && value !== "") current.rules.push({ allow: field === "allow", pattern: canonical(value) });
    }
    // Any other record (Crawl-delay, Sitemap) is ignored. It does not end a run of User-agent lines (RFC 9309, 2.2.4).
  }
  // Only the groups that can apply to this visitor are kept: a file written for a hundred other crawlers is not held in memory.
  return groups.filter(group => group.agents.some(agent => agent === "*" || OUR_NAMES.includes(agent)));
}

/**
 * Percent-escapes written one way on both sides of a comparison, as RFC 9309 asks: hex in upper case, an escape of a
 * letter, digit or one of `-._~` as that character, and a character outside ASCII as its UTF-8 escapes. Without this a
 * path spelled `/%70rivate` would slip past `Disallow: /private`.
 */
function canonical(text: string): string {
  return text
    .replace(/[^\x00-\x7f]+/g, run => Array.from(Buffer.from(run, "utf8"), byte => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join(""))
    .replace(/%([0-9a-f]{2})/gi, (_, hex: string) => {
      const character = String.fromCharCode(parseInt(hex, 16));
      return /[A-Za-z0-9\-._~]/.test(character) ? character : `%${hex.toUpperCase()}`;
    });
}

/**
 * A pattern as a test on a path: `*` is any run of characters, a trailing `$` is the end, everything else is itself.
 * It is not a regular expression on purpose. The pattern comes from a host we do not control, the path from a
 * registration we do not control either, and a regular expression with many `*` can be made to take hours on a long path.
 * Each part between the stars is looked for once, at its earliest place after the one before, so the work is bounded by
 * the length of the path times the length of the pattern.
 */
function matcher(pattern: string): (path: string) => boolean {
  const anchored = pattern.endsWith("$");
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  const first = parts[0]!;
  const last = parts.length > 1 ? parts[parts.length - 1]! : null;
  const middle = parts.slice(1, -1);
  return path => {
    if (!path.startsWith(first)) return false;
    if (last === null) return anchored ? path.length === first.length : true;
    let position = first.length;
    for (const part of middle) {
      const found = path.indexOf(part, position);
      if (found < 0) return false;
      position = found + part.length;
    }
    if (!anchored) return path.indexOf(last, position) >= 0;
    return path.length - last.length >= position && path.endsWith(last);
  };
}

/** Whether this visitor may fetch `path` (the path and query of the URL), under these rules. */
export function robotsAllows(rules: RobotsRules, path: string): boolean {
  const ours = rules.filter(group => group.agents.some(agent => OUR_NAMES.includes(agent)));
  const chosen = ours.length > 0 ? ours : rules.filter(group => group.agents.includes("*"));
  const target = canonical(path);
  let best: { length: number; allow: boolean } | null = null;
  for (const group of chosen) {
    for (const rule of group.rules) {
      if (!matcher(rule.pattern)(target)) continue;
      const length = rule.pattern.length;
      if (best === null || length > best.length || (length === best.length && rule.allow && !best.allow)) best = { length, allow: rule.allow };
    }
  }
  return best === null ? true : best.allow;
}

type RobotsDecision =
  | { allowed: true }
  | { allowed: false; reason: "robots_disallowed" | "robots_unavailable" | "budget_exhausted"; detail: string; cause?: SafeFetchReason };

type Entry = { until: number; rules: RobotsRules | null; unavailable: { detail: string; cause?: SafeFetchReason } | null };

/** The most robots.txt is read. A file longer than this is treated as unreadable, so a rule past the cut is never missed. */
export const ROBOTS_MAX_BYTES = 64 * 1024;
/** The most rules read for this visitor. A file with more is treated like one that is too long, so memory is bounded however many hosts are remembered. */
export const ROBOTS_MAX_RULES = 1000;
/**
 * The most pattern characters read for this visitor, counted after percent-escapes are written out (a character outside
 * ASCII becomes nine). Rules alone do not bound memory: one rule can be as long as the file.
 */
export const ROBOTS_MAX_PATTERN_CHARS = 32 * 1024;

/**
 * A look at a host's robots.txt before the first thing is asked of it, remembered for a day (a file that could not be
 * read, for ten minutes). `fetchRobots` is how the file is fetched, and it should go through safeFetch.
 */
export function createRobotsGate(options: {
  fetchRobots: (url: string) => Promise<SafeFetchResult>;
  now?: () => number;
  ttlMs?: number;
  unavailableTtlMs?: number;
  maxHosts?: number;
}) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  const unavailableTtlMs = options.unavailableTtlMs ?? 10 * 60 * 1000;
  const maxHosts = options.maxHosts ?? 1000;
  const remembered = new Map<string, Entry>();
  const loading = new Map<string, Promise<Entry>>();

  const load = async (host: string): Promise<Entry> => {
    const answer = await options.fetchRobots(`https://${host}/robots.txt`);
    const at = now();
    if (!answer.ok) {
      return { until: at + unavailableTtlMs, rules: null, unavailable: { detail: `robots.txt could not be read (${answer.reason})`, cause: answer.reason } };
    }
    if (answer.status >= 200 && answer.status < 300) {
      if (answer.truncated) return { until: at + unavailableTtlMs, rules: null, unavailable: { detail: "robots.txt is longer than what is read" } };
      const rules = parseRobots(answer.body.toString("utf8"));
      let ruleCount = 0;
      let patternChars = 0;
      for (const group of rules) {
        for (const rule of group.rules) {
          ruleCount += 1;
          patternChars += rule.pattern.length;
        }
      }
      if (ruleCount > ROBOTS_MAX_RULES || patternChars > ROBOTS_MAX_PATTERN_CHARS) {
        return { until: at + unavailableTtlMs, rules: null, unavailable: { detail: "robots.txt has more rules than are read" } };
      }
      return { until: at + ttlMs, rules, unavailable: null };
    }
    // Missing: allowed. Broken, or a host that is asking us to slow down (429), or anything else: not allowed until it can be read.
    if (answer.status >= 400 && answer.status < 500 && answer.status !== 429) return { until: at + ttlMs, rules: [], unavailable: null };
    return { until: at + unavailableTtlMs, rules: null, unavailable: { detail: `robots.txt answered ${answer.status}` } };
  };

  const entryFor = async (host: string): Promise<Entry | { transient: RobotsDecision }> => {
    const known = remembered.get(host);
    if (known && known.until > now()) return known;
    let pending = loading.get(host);
    if (!pending) {
      pending = load(host).finally(() => loading.delete(host));
      loading.set(host, pending);
    }
    const entry = await pending;
    // A run that has spent its fetches learns nothing about the host, so it is not remembered as one that cannot be read.
    if (entry.unavailable?.cause === "budget_exhausted") return { transient: { allowed: false, reason: "budget_exhausted", detail: "this run has used its fetches", cause: "budget_exhausted" } };
    if (remembered.size >= maxHosts) remembered.delete(remembered.keys().next().value as string);
    remembered.set(host, entry);
    return entry;
  };

  return {
    /** Whether this URL may be fetched, by what its host's robots.txt says. */
    async check(url: URL): Promise<RobotsDecision> {
      const entry = await entryFor(url.hostname);
      if ("transient" in entry) return entry.transient;
      if (entry.unavailable) return { allowed: false, reason: "robots_unavailable", detail: entry.unavailable.detail, cause: entry.unavailable.cause };
      if (entry.rules !== null && !robotsAllows(entry.rules, `${url.pathname}${url.search}`)) {
        return { allowed: false, reason: "robots_disallowed", detail: "the host's robots.txt asks automated visitors not to fetch this path" };
      }
      return { allowed: true };
    },
  };
}
