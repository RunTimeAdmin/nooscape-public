/**
 * A reference policy for the pre-flight check (docs/preflight-integration-brief-2026-11-05.md).
 *
 * The check answers with dated facts and no verdict. What a fact means for your payment, your route or your hire is your
 * decision, so the policy lives in your code. This is one way to write it: thresholds you can change (the Policy below) and a
 * result of "proceed" or "ask a person". "Proceed" means this policy found nothing to ask about. It does not mean that the agent
 * is safe, and a flag that is not present is not a finding either.
 *
 * Run it with Node 22.18 or later, which runs TypeScript directly (a warning about that is expected):
 *   node examples/preflight-policy.ts search <host>                                      free, no key
 *   NOOSCAPE_API_KEY=... node examples/preflight-policy.ts check <wallet address | https address>
 * The check needs a Pro key, or $0.01 a call over x402 with no key. This file does not pay.
 */
import { pathToFileURL } from "node:url";

const API = "https://nooscape.si/api/v1";
const TIMEOUT_MS = 10_000;

/** The parts of a check answer this policy reads. A flag's `present` is null when it is not measured for this agent, which is not the same as none. */
export type CheckData = {
  results: Array<{
    agent: { name: string | null };
    flags: {
      first_seen: { present: boolean | null; first_seen_at: string | null; days_since_first_seen: number | null };
      ownership_changes: { present: boolean | null; changes_recorded: number | null };
      revoked_feedback: { present: boolean | null; rating_count: number | null; revoked_count: number | null; revoked_share: number | null };
      fleet: { present: boolean | null; same_host_others: number | null };
    };
  }>;
};

/** Yours to choose. Each line asks a person first when its fact reaches the number. */
export type Policy = {
  /** Nooscape first saw the listing fewer than this many days ago. It is not when the agent was registered. */
  newerThanDays: number;
  /** This many ownership changes, or more, are recorded. */
  ownershipChangesFrom: number;
  /** This share of the ratings (0 to 1), or more, was later revoked by the rater. */
  revokedShareFrom: number;
  /** This many other listings, or more, share the agent's host. Anyone can register an agent that names a host, so this count can be raised from outside: it asks a person to look and proves nothing. */
  sameHostFrom: number;
  /** The agent is not listed (the check answers 404, or 200 with an empty list). That says nothing about the agent. */
  whenNotListed: "ask a person" | "proceed";
};

export const DEFAULT_POLICY: Policy = { newerThanDays: 30, ownershipChangesFrom: 1, revokedShareFrom: 0.2, sameHostFrom: 10, whenNotListed: "ask a person" };

export type Decision = { action: "proceed" | "ask a person"; reasons: string[]; notMeasured: string[] };

const FLAG_NAMES = { first_seen: "first seen", ownership_changes: "ownership changes", revoked_feedback: "revoked feedback", fleet: "fleet size" } as const;

/** Which facts make your system ask a person first. Nooscape says none of these is a finding. */
export function reasonsToAsk(data: CheckData, policy: Policy = DEFAULT_POLICY): string[] {
  const reasons: string[] = [];
  for (const { agent, flags } of data.results) {
    const who = agent.name ?? "an unnamed listing";
    const days = flags.first_seen.days_since_first_seen;
    if (days !== null && days < policy.newerThanDays) reasons.push(`${who}: first seen ${days} days ago (${flags.first_seen.first_seen_at})`);
    const changes = flags.ownership_changes.changes_recorded;
    if (changes !== null && changes >= policy.ownershipChangesFrom) reasons.push(`${who}: ${changes} ownership change(s) recorded`);
    const share = flags.revoked_feedback.revoked_share;
    if (share !== null && share >= policy.revokedShareFrom) reasons.push(`${who}: ${flags.revoked_feedback.revoked_count} of ${flags.revoked_feedback.rating_count} ratings were revoked by the rater`);
    const sameHost = flags.fleet.same_host_others;
    if (sameHost !== null && sameHost >= policy.sameHostFrom) reasons.push(`${who}: ${sameHost} other listings share its host`);
  }
  return reasons;
}

/** The flags that are not measured for an agent. A missing measurement is not a clean result, so it is listed and not counted either way. */
function notMeasured(data: CheckData): string[] {
  return data.results.flatMap(({ agent, flags }) =>
    (Object.keys(FLAG_NAMES) as Array<keyof typeof FLAG_NAMES>)
      .filter(key => flags[key].present === null)
      .map(key => `${agent.name ?? "an unnamed listing"}: ${FLAG_NAMES[key]} is not measured for this agent`),
  );
}

/** What to do with a check answer: null is the 404 of an agent that is not listed. */
export function decide(data: CheckData | null, policy: Policy = DEFAULT_POLICY): Decision {
  if (data === null || data.results.length === 0) {
    const note = "not listed by any registry Nooscape reads, which says nothing about the agent";
    return policy.whenNotListed === "ask a person" ? { action: "ask a person", reasons: [note], notMeasured: [] } : { action: "proceed", reasons: [], notMeasured: [note] };
  }
  const reasons = reasonsToAsk(data, policy);
  return { action: reasons.length > 0 ? "ask a person" : "proceed", reasons, notMeasured: notMeasured(data) };
}

/** Free, no key: the listings that registered an agent at this host. */
export async function listedFor(host: string) {
  const response = await fetch(`${API}/agents/search?host=${encodeURIComponent(host)}&limit=10`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Nooscape answered ${response.status}`);
  const { data } = await response.json();
  return data.results as Array<{ chain: string; agent_id: string; name: string | null; registrant: string | null; first_seen_at: string }>;
}

/** The pre-flight check. Give exactly one of agent, wallet or url (only the url's host is used, and nothing is fetched from it). Null when the agent is not listed. */
export async function check(subject: { agent: { chain: string; id: string } } | { wallet: string } | { url: string }, key: string): Promise<CheckData | null> {
  const response = await fetch(`${API}/check`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(subject),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  // 401 a wrong key, 402 no key and no payment, 403 a tier that does not open the check, 429 over the limit, 503 not readable now. What each means
  // for your system is your decision. This one throws, and main() below asks a person.
  if (!response.ok) throw new Error(`Nooscape answered ${response.status}`);
  return (await response.json()).data as CheckData;
}

async function main(args: string[]): Promise<number> {
  const [command, subject] = args;
  if (command === "search" && subject) {
    const found = await listedFor(subject);
    console.log(`${found.length} listing(s) registered at ${subject}:`);
    for (const item of found) console.log(`  ${item.name ?? "(unnamed)"}  ${item.chain}:${item.agent_id}  first seen ${item.first_seen_at}`);
    return 0;
  }
  if (command === "check" && subject) {
    const key = process.env.NOOSCAPE_API_KEY;
    if (!key) {
      console.error("The check needs a Pro key in NOOSCAPE_API_KEY, or $0.01 a call over x402 (this example does not pay). The free search needs neither.");
      return 2;
    }
    let decision: Decision;
    try {
      decision = decide(await check(subject.startsWith("http") ? { url: subject } : { wallet: subject }, key));
    } catch (error) {
      decision = { action: "ask a person", reasons: [`the check could not be read (${(error as Error).message})`], notMeasured: [] };
    }
    console.log(decision.action === "proceed" ? "proceed: this policy found nothing to ask about. That is not a finding that the agent is safe." : "ask a person:");
    for (const line of decision.reasons) console.log(`  ${line}`);
    for (const line of decision.notMeasured) console.log(`  (${line})`);
    return decision.action === "proceed" ? 0 : 1;
  }
  console.error("usage:\n  node examples/preflight-policy.ts search <host>\n  NOOSCAPE_API_KEY=... node examples/preflight-policy.ts check <wallet address | https address>");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
