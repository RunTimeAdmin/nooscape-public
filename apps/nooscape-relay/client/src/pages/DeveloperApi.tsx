import { useMemo, useState } from "react";
import {
  ArrowUpRight,
  Braces,
  Check,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  FileCheck2,
  Fingerprint,
  Loader2,
  Network,
  Radio,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { extraChainsOn, EXTRA_CHAIN_LABEL } from "@shared/chains";
import { tierLines, KEYS_PATH } from "@/lib/apiKeysFlow";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

// Ethereum, Base and Arc are served only while their switch is on when the client is built (shared/features.ts). The server reads the same list.
const EXTRA_CHAINS_ON = extraChainsOn(import.meta.env.VITE_FEATURES);

type PublisherValidation = {
  status: "allowlisted" | "expired" | "revoked" | "unverified";
  publisherName: string | null;
  publicKeyFingerprint: string | null;
  verifiedAt: string | null;
  statusChangedAt: string | null;
};

type EvidenceEnvelope = {
  agentId: string;
  observedAt: string;
  sequence: number;
  algorithm: string;
  integrityHash: string;
  signatureAlgorithm: string;
  signature: string;
  entries: Array<{ id: string; event: string; source: string; observedAt: string }>;
  publisherValidation?: PublisherValidation;
};

type SnippetLanguage = "cURL" | "JavaScript";

const sections = [
  { id: "quickstart", label: "Quickstart", icon: Terminal },
  { id: "rest", label: "REST API v1", icon: Code2 },
  { id: "trust", label: "Evidence tiers", icon: Network },
  { id: "methodology", label: "Tier scale", icon: ShieldCheck },
  { id: "evidence", label: "Evidence relay", icon: Fingerprint },
  { id: "verification", label: "Verify payloads", icon: ShieldCheck },
] as const;

const recordResponseExample = `{
  "agentId": "9c1f4e7a-2b6d-4e8f-a3c5-7d0b1e9f2a64",
  "displayName": "Example Research Agent",
  "handle": "example-research-agent",
  "primaryCapability": "market research and synthesis",
  "untrustedSummary": "Source-reported self-description, sanitized and served as an explicit untrusted claim.",
  "protocols": "a2a",
  "publisherState": "unverified",
  "evidenceTier": "tier_2",
  "sourceCount": 1,
  "lastObservedAt": "2026-10-08T11:20:00.000Z"
}`;

const restResponseExample = `{
  "api_version": "v1",
  "as_of": "2026-10-18T12:00:00.000Z",
  "source": {
    "kind": "registry",
    "chain": "robinhood",
    "chain_id": 4663,
    "registry": "erc8004",
    "registry_address": "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    "key": "eip155:4663:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432:7",
    "first_seen_at": "2026-10-01T00:00:00.000Z",
    "last_seen_at": "2026-10-18T12:00:00.000Z",
    "mint_block": 123456
  },
  "license": {
    "name": "Nooscape data, provisional terms",
    "url": "https://nooscape.si/terms",
    "attribution": "Data from Nooscape (https://nooscape.si).",
    "notes": "Attribution is required. Do not resell bulk copies."
  },
  "data": {
    "chain": "robinhood",
    "agent_id": "7",
    "registry": "erc8004",
    "name": "Example Research Agent",
    "registrant": "0x14791697260e4c9a71f18484c9f997b308e59325",
    "locator_host": "agent.example",
    "evidence": {
      "layer": "acknowledged",
      "level": null,
      "label": null,
      "read_at": null,
      "statement": "Acknowledged means a source listed this agent. It is not a review, a tier or an endorsement."
    },
    "claim": null
  }
}`;

export default function DeveloperApi() {
  const records = trpc.liveData.publicRecords.useQuery(undefined, { refetchOnWindowFocus: false });
  const agents = records.data?.records ?? [];
  const [agentId, setAgentId] = useState("");
  const selectedAgentId = agentId || agents[0]?.agentId || "";
  const evidence = trpc.atlas.evidence.useQuery({ agentId: selectedAgentId }, { enabled: selectedAgentId.length > 0, refetchOnWindowFocus: false });
  const envelope: EvidenceEnvelope | undefined = evidence.data;
  const baseUrl = typeof window === "undefined" ? "https://nooscape.si" : window.location.origin;
  const evidenceInput = useMemo(() => JSON.stringify({ json: { agentId: selectedAgentId } }), [selectedAgentId]);

  const overviewCurl = `curl "${baseUrl}/api/trpc/liveData.publicRecords"`;
  const overviewJs = `const response = await fetch("${baseUrl}/api/trpc/liveData.publicRecords");
const { result } = await response.json();
const { records } = result.data.json;

for (const record of records) {
  console.log(record.handle, record.evidenceTier, record.publisherState);
}`;
  const restAgentCurl = `curl "${baseUrl}/api/v1/agents/robinhood/7"`;
  const restAgentJs = `const response = await fetch("${baseUrl}/api/v1/agents/robinhood/7");
if (response.status === 429) {
  const wait = Number(response.headers.get("Retry-After"));
  // Wait that many seconds, then try again.
}
const { as_of, source, license, data } = await response.json();

console.log(data.name, data.evidence.statement, "as of", as_of);
console.log(license.attribution); // show this where you use the data`;
  const restSearchCurl = `curl -G "${baseUrl}/api/v1/agents/search" \\
  --data-urlencode "q=research" \\
  --data-urlencode "chain=robinhood" \\
  --data-urlencode "limit=5"`;
  const restSearchJs = `const url = new URL("${baseUrl}/api/v1/agents/search");
url.searchParams.set("owner", "0x14791697260e4c9a71f18484c9f997b308e59325");
const { data } = await (await fetch(url)).json();

for (const result of data.results) {
  console.log(result.chain, result.agent_id, result.name);
}`;
  const restBatchCurl = `curl -X POST "${baseUrl}/api/v1/agents/batch" \\
  -H "Authorization: Bearer $NOOSCAPE_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"agents":[{"chain":"robinhood","id":"7"},{"chain":"bnb","id":"9"}]}'`;
  const restBatchJs = `const response = await fetch("${baseUrl}/api/v1/agents/batch", {
  method: "POST",
  headers: { Authorization: "Bearer " + process.env.NOOSCAPE_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ agents: [{ chain: "robinhood", id: "7" }, { chain: "bnb", id: "9" }] }),
});
const { data } = await response.json();

for (const item of data.results) {
  console.log(item.chain, item.id, item.status, item.agent?.name ?? item.error.message);
}`;
  const restCheckCurl = `curl -X POST "${baseUrl}/api/v1/check" \\
  -H "Authorization: Bearer $NOOSCAPE_PRO_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"agent":{"chain":"robinhood","id":"7"}}'`;
  const restCheckJs = `const response = await fetch("${baseUrl}/api/v1/check", {
  method: "POST",
  headers: { Authorization: "Bearer " + process.env.NOOSCAPE_PRO_KEY, "Content-Type": "application/json" },
  // One of agent, wallet or url. A url is matched by its host only; nothing is fetched.
  body: JSON.stringify({ wallet: "0x14791697260e4c9a71f18484c9f997b308e59325", chain: "robinhood" }),
});
const { data } = await response.json();

for (const { agent, flags } of data.results) {
  console.log(agent.agent_id, flags.fleet.listed_by_same_wallet, flags.ownership_changes.changes_recorded);
}`;
  const evidenceCurl = `curl -G "${baseUrl}/api/trpc/atlas.evidence" \\
  --data-urlencode 'input=${evidenceInput}'`;
  const evidenceJs = `const agentId = "${selectedAgentId}";
const input = encodeURIComponent(JSON.stringify({ json: { agentId } }));
const response = await fetch(
  "${baseUrl}/api/trpc/atlas.evidence?input=" + input,
);
const { result } = await response.json();
const envelope = result.data.json;`;
  const verifyCurl = `jq -n --slurpfile packet ./packet.json \\
  '{json:{packet:$packet[0]}}' | \\
  curl -sS -X POST "${baseUrl}/api/trpc/atlas.verifyEvidence" \\
    -H "content-type: application/json" --data-binary @-`;
  const verifyJs = `const response = await fetch(
  "${baseUrl}/api/trpc/atlas.verifyEvidence",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ json: { packet } }),
  },
);
const { result } = await response.json();
const verdict = result.data.json;

console.log(verdict.valid, verdict.hashValid, verdict.signatureValid);`;

  return (
    <main className="developer-page min-h-screen bg-[#06070B] text-[#EAF7EE]">
      <div className="developer-grid" />
      <header className="developer-header">
        <a href="/" className="developer-brand" aria-label="Return to Nooscape Atlas">
          <span className="developer-mark"><Network size={17} /></span>
          <span><strong>NOOSCAPE</strong><em>Developer surface</em></span>
        </a>
        <nav className="developer-header-nav" aria-label="Developer navigation">
          <a href="/verify"><ShieldCheck size={14} /> Verify a packet</a>
          <a href="/"><ChevronLeft size={14} /> Atlas</a>
        </nav>
      </header>

      <div className="developer-layout">
        <aside className="developer-sidebar">
          <p className="developer-sidebar-kicker">API reference / v0</p>
          <nav aria-label="API reference sections">
            {sections.map(({ id, label, icon: Icon }, index) => (
              <a key={id} href={`#${id}`} className={cn("developer-nav-link", index === 0 && "developer-nav-active")}>
                <Icon size={14} /><span>{label}</span><ChevronRight size={13} />
              </a>
            ))}
          </nav>
          <div className="developer-side-note">
            <Radio size={13} />
            <div><strong>Public read access</strong><span>No API key for the public tier. 30 requests a minute.</span></div>
          </div>
          <div className="developer-side-status">
            <span><i /> Transport</span><strong>REST v1 and tRPC / JSON</strong>
            <span><i /> Reviewed index</span><strong>{records.data ? `${records.data.records.length} public records` : "Loading"}</strong>
          </div>
        </aside>

        <article className="developer-content">
          <section className="developer-hero" id="quickstart">
            <p className="developer-eyebrow"><span /> NOOSCAPE PUBLIC API</p>
            <h1>Query the <span>evidence graph.</span></h1>
            <p>Use the public Nooscape transport to retrieve the reviewed agent directory, evidence tiers, publisher-key states, and signed evidence envelopes. Records enter only through approved sources and explicitly reviewed runs, and every tier upgrade is operator-gated and time-boxed.</p>
            <div className="developer-hero-meta">
              <span><Code2 size={15} /> JSON over HTTP</span><span><Fingerprint size={15} /> Ed25519 envelopes</span><span><Network size={15} /> Public reads</span>
            </div>
          </section>

          <section className="developer-callout">
            <div><ShieldCheck size={18} /><span><strong>Interpretation boundary</strong> An <code>evidenceTier</code> names the highest evidence level a record has cleared under a published, versioned scale — not a score, and not a guarantee of safety, performance, identity ownership, or real-world completion. Always inspect <code>publisherState</code> and the underlying evidence events.</span></div>
            <a href="/verify">Open verifier <ArrowUpRight size={14} /></a>
          </section>

          <section className="developer-section" id="rest">
            <SectionHeader eyebrow="00 / REST API v1" title="Look an agent up by chain and id" detail="JSON under /api/v1 that reads the record and changes none of it, for the Robinhood Chain, BNB Smart Chain and Solana registries. No key for the public tier; a free key raises the limits and opens a few more calls. Every answer says when it was read, where from and under what terms." />
            <div className="developer-callout">
              <div><ShieldCheck size={18} /><span><strong>What this API will not do</strong> Payment never changes a record, a tier or an evidence level. Agents here are acknowledged, not reviewed: they have no tier and the API gives no verdict. Text an owner wrote is shown only as the owner&rsquo;s word. A hidden or withdrawn record is never served. The one thing a key can write is its own watchlist and webhook.</span></div>
              <a href="/api/v1/openapi.json">OpenAPI document <ArrowUpRight size={14} /></a>
            </div>

            <EndpointCard method="GET" path="/api/v1/agents/{chain}/{id}" label="Public · 30 a minute" />
            <p className="developer-body-copy">One agent. <code>chain</code> is <code>robinhood</code>, <code>bnb</code> or <code>solana</code>. On the first two, <code>id</code> is the registry token id (digits only); on Solana it is the address. If more than one Solana registry lists an address the answer is 409 and names them; add <code>registry=</code> to choose.</p>
            {EXTRA_CHAINS_ON.length > 0 && (
              <p className="developer-body-copy">
                {EXTRA_CHAINS_ON.map((chain, index) => (
                  <span key={chain}>{index > 0 && ", "}<code>{chain}</code> ({EXTRA_CHAIN_LABEL[chain]})</span>
                ))}{" "}
                {EXTRA_CHAINS_ON.length === 1 ? "is" : "are"} served too, as BNB Smart Chain is: <code>id</code> is the registry token id (digits only), only the registrations that pass the chain&rsquo;s published listing rules are listed, and one that is held out is not judged. An agent there is acknowledged, with no registration read and no tier. The watchlist and the webhook cover {EXTRA_CHAINS_ON.length === 1 ? "it" : "them"} too.
              </p>
            )}
            <SnippetTabs curl={restAgentCurl} javascript={restAgentJs} />
            <JsonResponseExample code={restResponseExample} title="Example answer" note="An example, trimmed. Not a real agent." />
            <SchemaPanel title="Every answer" rows={[
              ["api_version", "string", "Always v1 here. A change that breaks a caller will be a new version."],
              ["as_of", "ISO 8601", "For an agent: when Nooscape last saw it at its source. For a search: when the search ran."],
              ["source", "object", "Where the record was read from: the chain, the registry, the key it is stored under, when it was first and last seen, and the mint block where known."],
              ["license", "object", "The terms the data is offered under, and the attribution line to show where you use it. Provisional."],
              ["data", "object", "The agent, or the page of search results."],
            ]} />
            <SchemaPanel title="An agent" rows={[
              ["evidence", "object", "layer is always acknowledged. On BNB Smart Chain, level is checked_unproven or not_checked: whether Nooscape has read the entry's registration, never whether the agent is any good. The statement says what the layer does not mean."],
              ["name, registrant, locator_host", "string", "As the registrant published them. They are the registrant's words, cleaned of control and invisible characters."],
              ["related", "object | null", "How many other listed agents share this one's wallet, name or host. A fact about the listing, not about intent."],
              ["activity, ratings, twin", "object | null", "Chain activity, a summary of recorded ratings (Robinhood Chain) and the same identity on another chain. null means not measured, never zero."],
              ["claim", "object | null", "The claim in force. owner_text is what the owner wrote, labelled as the owner's word, and is null while the claim is on hold."],
            ]} />

            <EndpointCard method="GET" path="/api/v1/agents/search" label="Public · 30 a minute" />
            <p className="developer-body-copy">Search by name, host, registry key or wallet. Give exactly one of <code>q</code>, <code>owner</code> or <code>host</code>. Results are newest first. <code>owner</code> and <code>host</code> are exact filters over the page the search returns.</p>
            <SnippetTabs curl={restSearchCurl} javascript={restSearchJs} />
            <SchemaPanel title="Search parameters" rows={[
              ["q", "string", "A name, a host, a registry key or a wallet. Two to 64 characters."],
              ["owner", "address", "The registering wallet, in full."],
              ["host", "host name", "The locator host, in full."],
              ["chain", "enum", `${["robinhood", "bnb", "solana", ...EXTRA_CHAINS_ON].join(" | ")}. Limits the search to that chain's registries.`],
              ["limit", "integer", "1 to 25. Default 10."],
            ]} />

            <EndpointCard method="POST" path="/api/v1/agents/batch" label="Key · counts as one request" />
            <p className="developer-body-copy">Up to 25 agents in one request. The body is JSON with an <code>agents</code> list of <code>chain</code> and <code>id</code> (and <code>registry</code> on Solana). Each agent gets its own result and status, in the order asked, so one that is not listed does not spoil the rest. A hidden or withdrawn record is a 404 here too.</p>
            <SnippetTabs curl={restBatchCurl} javascript={restBatchJs} />

            <EndpointCard method="GET" path="/api/v1/agents/{chain}/{id}/history" label="Key" />
            <p className="developer-body-copy">An agent&rsquo;s registry events (up to 24, oldest first, with a flag when there may be more) and the public history of its claims. Text an owner removed from view, or that belongs to a claim on hold, shows as <code>withheld</code> and is never given.</p>

            <EndpointCard method="GET" path="/api/v1/usage" label="Key" />
            <p className="developer-body-copy">What the key has used today against its day, and the last 30 days by endpoint. Counts reach it within about half a minute.</p>

            <EndpointCard method="POST" path="/api/v1/check" label="Pro key, or pay per call · a key's call counts as one request" />
            <p className="developer-body-copy">Facts about a listing before you rely on it. Give one of <code>agent</code> (<code>chain</code> and <code>id</code>), <code>wallet</code> or <code>url</code>. A url is matched by its host alone and nothing is fetched. For each listing it returns the evidence level, four dated flags and the sources they were read from. There is no score and no verdict: a flag that is present is a fact to weigh and not a finding. A wallet or a url answers for the listings it matches exactly, newest first, up to 10. A Free or Builder key is refused with 403 <code>tier_required</code>. With no key, where pay per call is on, the check can be paid for as it is made: see Pay per call (x402) below.</p>
            <SnippetTabs curl={restCheckCurl} javascript={restCheckJs} />
            <SchemaPanel title="The four flags" rows={[
              ["present", "true | false | null", "true: Nooscape has recorded one. false: it has recorded none. null: not measured for this agent, which is not the same as none. A fact about Nooscape's records, never a finding."],
              ["first_seen", "object", "When Nooscape first saw the listing, not when the agent was registered. present is true when that was under 30 days ago."],
              ["ownership_changes", "object", "Transfers Nooscape recorded, apart from the platform hand-outs made just after a mint. EVM registries are placed by block, because the ledger holds blocks and not clocks, with the distance from the ledger's head. Robinhood Chain adds block days (864,000 blocks, a proxy). Solana is dated by when Nooscape recorded the transfer, which is no later than the transfer."],
              ["revoked_feedback", "object", "Ratings recorded against the agent and how many the rater later revoked, as a share. Robinhood Chain only. It does not say whether a rating was fair."],
              ["fleet", "object", "Listings one wallet registered, this agent included, and the other agents that share its host and name. A fleet means identities registered by one wallet, and nothing more."],
            ]} />

            <SchemaPanel title="Keys" rows={[
              ["Authorization", "header", "Send Authorization: Bearer <key>. A key that is wrong is refused with 401 and does not fall back to the public limit. Get a free key at the keys page."],
              ["No key", "30 a minute", "From one address. The public tier."],
              ...tierLines().map(tier => [tier.label, tier.line, tier.tier === "free" ? "Self-serve. Up to three live keys for one email." : "Arranged by email. No prices are set yet."] as [string, string, string]),
              ["300 a minute", "per address", "The most one address can ask with keys, whatever their tiers."],
              ["Unchanged", "the answers", "A key changes how much you can ask and which calls are open. The same agent is answered the same way with a free key, a paid key and no key."],
            ]} />
            <p className="developer-body-copy"><a href={KEYS_PATH}>Get a free key, see its use, or end it <ArrowUpRight size={14} /></a></p>

            <SchemaPanel title="Pay per call (x402)" rows={[
              ["When", "no key", "Only where it is switched on, which /api/v1 says: a lookup past the free 30 a minute, and the check (POST /api/v1/check). Everything else is limited (429) or needs a key (401) as before, and a request that carries a key is never asked to pay."],
              ["The ask", "402", "The answer is 402 with the price in the body and in a PAYMENT-REQUIRED header (x402 version 2, base64 JSON), with one set of terms for each network that takes payment: USDC on Base (eip155:8453) where it is offered, and USDC on Arc (eip155:5042). Each is the exact scheme with the amount in base units (5000 is $0.005, six decimals) and the receiving address, which is the same on both. Pay on either; the index lists them under networks."],
              ["Paying", "PAYMENT-SIGNATURE", "Sign a USDC transfer authorization (EIP-3009) from your wallet to that address and send it, base64 encoded, in a PAYMENT-SIGNATURE header with the same request. It must be valid for at least 15 seconds and at most 10 minutes. From a regular wallet, or from a deployed smart-contract wallet where the index lists smart_contract under wallets (Base takes regular wallets only): the chain is asked whether the wallet's own code (ERC-1271) accepts the signature before anything is charged, a wallet has one payment going at a time, and a wallet that is not deployed yet is refused. A wallet that holds less USDC than the price is refused before the payment is sent on, and one wallet may start 60 new payments a minute."],
              ["The answer", "PAYMENT-RESPONSE", "The same answer a Pro key gets, with a PAYMENT-RESPONSE header: base64 JSON with the settlement transaction, the network and the payer. Never cached."],
              ["Charged once", "per request", "A payment is charged only for an answer that was built and delivered: not found, a bad request, a failed read or a check that matches no listing costs nothing. A payment belongs to the request it was sent with. Send the same request with the same payment again (twice more, within its validity) and it is answered again with no second charge. For a different request it is refused."],
              ["503", "unavailable", "The payment has not settled yet. Send the same request with the same payment again: you are charged once. error.payment_id is the id to quote to us if you were charged and not served. This version has no refunds."],
              ["Unchanged", "the answers", "Paying changes how you ask and nothing about what is said. Nooscape never holds your funds: the transfer is from your wallet to the receiving address, and a facilitator submits it: Circle's on Arc and Coinbase's on Base."],
            ]} />
            <p className="developer-body-copy">What Nooscape keeps about a payment is on the <a href="/privacy">Privacy</a> page, and the terms are on the <a href="/terms">Terms</a> page.</p>

            <SchemaPanel title="Watchlist and webhook (Builder or Pro key)" rows={[
              ["POST /api/v1/watches", "key", "Watch up to 25 listings in one call and 100 in all. The body is JSON with an agents list of chain and id (and registry on Solana), and each agent gets its own result. GET lists them with whether each is in the public view, and DELETE /api/v1/watches/{nooscape_id} removes one. Only what is recorded after a listing is added is sent."],
              ["PUT /api/v1/webhook", "https address", "Set the one address that events go to: https, a public name, no user name, no password and no port. It is saved and sent a test (type ping) at once, and the answer says what the test got. GET shows it with its signing secret, DELETE removes it, POST /api/v1/webhook/rotate-secret gives a new secret, and GET /api/v1/webhook/deliveries shows the last 20 events and what became of each. Changes are limited to 6 a minute."],
              ["Events", "type", "ownership.changed, feedback.added, feedback.revoked, claim.changed, listing.removed and listing.restored. Each says which listing and when, in the words this API already uses: a transfer's wallets and transaction, that a rating was added or taken back (Robinhood Chain only, and no more than that, because this API gives counts), the kind of claim change and which field, and never what an owner wrote. A removal says that a listing left the public view, and not why."],
              ["Verifying", "X-Nooscape-Signature", "t=<seconds>,v1=<hex>, where the hex is the HMAC-SHA256 of the timestamp, a dot and the raw body, under your signing secret (whsec_). Refuse a timestamp that is more than a few minutes old. X-Nooscape-Delivery and the body's id name the delivery."],
              ["Delivery", "at least once", "Any 2xx answer is a success, and a redirect is a failure. A failed try is tried again after 1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours, and then given up. Events can arrive late, more than once or out of order: use id to ignore a repeat and created_at to order them. After 20 failed tries in a row the webhook is turned off until you set it again. Events are kept for 30 days."],
              ["Not a guarantee", "convenience", "An event says what Nooscape recorded and when. It is not a promise that nothing else changed: the API is the record. What is kept about a webhook is on the Privacy page."],
            ]} />
            <p className="developer-body-copy">Webhooks are switched on by the operator and answer 503 until then.</p>

            <SchemaPanel title="Limits and errors" rows={[
              ["30 a minute", "per address", "Without a key. Every response carries X-RateLimit-Limit and X-RateLimit-Remaining. With a key, the response also carries X-Api-Tier and X-Quota-Limit, X-Quota-Remaining and X-Quota-Reset for the day. A browser on another site may read the API."],
              ["400", "bad_request", "The message names the parameter that is wrong."],
              ["401", "invalid_key | key_required", "The key is not valid or has been ended, or the call needs a key and none was sent."],
              ["402", "payment required", "Where pay per call is on: no key past the free limit, or the check with no key, or a payment that was not taken. The body is the price and how to pay it. Nothing was charged."],
              ["403", "tier_required", "The key is valid but its tier does not open this endpoint. The answer names the tier that does."],
              ["404", "not_found", "Nothing listed matches. A hidden, withdrawn or closed record looks the same as one that was never listed."],
              ["409", "ambiguous", "More than one Solana registry lists the address. Add registry=."],
              ["429", "rate_limited | quota_exceeded", "rate_limited: wait Retry-After seconds. quota_exceeded: the key has used its day, and Retry-After is the time until 00:00 UTC."],
              ["503", "unavailable", "The data, or the keys, cannot be read now. Wait Retry-After seconds."],
            ]} />
            <p className="developer-body-copy">Show the attribution line from <code>license</code> where you use the data, and do not resell bulk copies. These are provisional terms: see the <a href="/terms">Terms</a>, which also bar scraping beyond the published limits. A final data license will replace them.</p>
          </section>

          <section className="developer-section" id="trust">
            <SectionHeader eyebrow="01 / Evidence tiers" title="List public agent records" detail="Read the reviewed records: evidence tier, publisher-key state, and approved-source metadata for every published agent." />
            <EndpointCard method="GET" path="/api/trpc/liveData.publicRecords" label="Public · no input" />
            <p className="developer-body-copy">The transport returns a tRPC envelope. Read the records from <code>result.data.json.records</code>. A record appears here only when its source is approved and its retained observation belongs to an explicitly reviewed run; unreviewed runs stay withheld.</p>
            <SnippetTabs curl={overviewCurl} javascript={overviewJs} />
            <SchemaPanel title="Public record" rows={[
              ["agentId", "string", "Stable Atlas agent identifier."],
              ["displayName", "string", "Name served by the approved source; an untrusted public claim. For a reviewed Robinhood Chain record whose source recorded only a number, it can be the name Nooscape read from the record's registration link, and then nameReadAt is present."],
              ["handle", "string", "URL-safe agent label."],
              ["primaryCapability", "string | null", "Primary advertised capability, scoped to the serving source."],
              ["untrustedSummary", "string | null", "Source-reported self-description; sanitized, served as an explicit untrusted claim, never a Nooscape statement."],
              ["protocols", "string", "Advertised protocol or registry the record was observed through."],
              ["publisherState", "enum", "allowlisted | expired | revoked | unverified"],
              ["evidenceTier", "enum", "tier_2 | tier_3 | tier_4 evidence level under the current scale version."],
              ["sourceCount", "number", "Approved sources backing this agent."],
              ["lastObservedAt", "ISO 8601", "Time of the approved observation that produced this record."],
              ["nameReadAt", "ISO 8601 | absent", "Present only when displayName was read from the record's registration link and not from the retained observation: the time it was read."],
            ]} />
          </section>

          <section className="developer-section trust-methodology" id="methodology">
            <SectionHeader eyebrow="01A / Tier scale" title="Evidence tiers, not scores." detail="One published, versioned scale — evidence-tier-v1 (2026-10-08). A tier names the highest evidence level a record has cleared; it is never a blended score." />
            <div className="methodology-boundary">
              <div><span className="methodology-state-dot" /><p><strong>Served verbatim</strong><em>Card fields are the source&rsquo;s own words, stored as untrusted claims and returned as such.</em></p></div>
              <ChevronRight size={18} />
              <div><span className="methodology-state-dot methodology-state-live" /><p><strong>Raised only by evidence</strong><em>Operator-gated observations — approved sources, reviewed runs, domain control, publisher keys — are the only things that move a tier.</em></p></div>
            </div>

            <div className="methodology-flow" aria-label="Evidence-tier escalation flow">
              <div><b>01</b><span>Approved source</span><em>cards · registries · signed observations, never an open crawl</em></div>
              <i /><div><b>02</b><span>Reviewed run</span><em>one bounded read; only an explicitly approved run becomes public</em></div>
              <i /><div><b>03</b><span>Operator verification</span><em>domain-control proof or an allowlisted publisher key</em></div>
              <i /><div><b>04</b><span>Read-time enforcement</span><em>validity windows and card pins checked fail-closed on every fetch</em></div>
            </div>

            <JsonResponseExample code={recordResponseExample} />

            <div className="methodology-tiers" aria-label="Evidence tier scale (evidence-tier-v1)">
              <article><span>tier_2</span><strong>Approved record</strong><p>Metadata from an approved source, served through an explicitly reviewed run. The baseline every public record starts from.</p><em>Baseline</em></article>
              <article><span>tier_3</span><strong>Domain-control verified</strong><p>The agent&rsquo;s own domain served a one-time proof. Valid for a 90-day window; a recheck re-fetches the live proof and renews or revokes it, and a changed public card breaks the pin.</p><em>Consent-gated · expires</em></article>
              <article><span>tier_4</span><strong>Publisher-key allowlisted</strong><p>A rotation-bound publisher key is allowlisted for this agent. It identifies the publisher, never the quality of the service.</p><em>Operator allowlist</em></article>
              <article className="methodology-tier-flagged"><span>tier_0 · tier_1</span><strong>Reserved</strong><p>Not assigned in the current scale version. No record can claim them, and no self-reported signal can reach them.</p><em>Unassigned</em></article>
            </div>

            <div className="methodology-gates">
              <div className="methodology-gate-panel"><p>What each tier requires</p><ul><li><Check size={13} /> Approved source plus an explicitly approved run — the tier_2 baseline</li><li><Check size={13} /> Domain control proven by a live HTTPS proof file — tier_3</li><li><Check size={13} /> A rotation-bound key on the operator allowlist — tier_4</li><li><Check size={13} /> A validity window that is rechecked and enforced fail-closed</li></ul></div>
              <div className="methodology-gate-panel methodology-penalty-panel"><p>What revokes or blocks a tier</p><ul><li><span>×</span> A failed recheck revokes tier_3 back to tier_2 evidence</li><li><span>×</span> A changed public card breaks the domain pin until re-verified</li><li><span>×</span> Revoked or expired publisher keys lower publisherState</li><li><span>×</span> Self-reported or unreviewed metadata never raises a tier</li></ul></div>
            </div>

            <div className="methodology-api-note"><Fingerprint size={15} /><p><strong>For API consumers:</strong> treat <code>evidenceTier</code> as a categorical evidence level and filter on the tiers your own policy requires. Check <code>publisherState</code>, read the evidence events behind a record, and never rank by an implied score.</p></div>
          </section>

          <section className="developer-section" id="evidence">
            <SectionHeader eyebrow="02 / Evidence relay" title="Fetch an integrity-addressed envelope" detail="Request the most recent signed envelope for a known Atlas agent ID." />
            <EndpointCard method="GET" path="/api/trpc/atlas.evidence" label="Public · query input required" />
            <div className="developer-input-card">
              <div><label htmlFor="agent-picker">Live request builder</label><p>Select a published agent to update the executable request.</p></div>
              <select id="agent-picker" value={selectedAgentId} onChange={event => setAgentId(event.target.value)} disabled={records.isLoading || agents.length === 0}>
                {agents.length === 0 ? <option value="">No public records available</option> : agents.map(candidate => <option key={candidate.agentId} value={candidate.agentId}>{candidate.displayName} · {candidate.agentId}</option>)}
              </select>
            </div>
            <SnippetTabs curl={evidenceCurl} javascript={evidenceJs} />
            <div className="developer-param"><span>input</span><code>{evidenceInput}</code><em>URL-encode this JSON object as the query parameter value.</em></div>
            <SchemaPanel title="Signed evidence envelope" rows={[
              ["agentId", "string", "Agent requested by the caller."],
              ["observedAt", "ISO 8601", "Time at which the relay assembled this envelope."],
              ["integrityHash", "SHA-256 hex", "Digest of the canonical payload."],
              ["signature", "base64", "Ed25519 signature over UTF-8 canonicalPayload."],
              ["relayPublicKeyPem", "PEM", "Public key required for independent signature verification."],
              ["relayKeyId", "string", "Id of the signing key. Match it and relayPublicKeyPem to an entry in /.well-known/nooscape-keys.json. Active and retired keys are trusted for packets signed before the change; a revoked key is not."],
              ["publisherValidation", "object", "Publisher-key state captured inside the signed canonical payload."],
              ["entries", "array", "Observed activity records with source and proof reference."],
            ]} />
          </section>

          <section className="developer-section" id="verification">
            <SectionHeader eyebrow="03 / Verification" title="Verify before you trust" detail="A valid signature proves the signer produced the unchanged canonical payload. It does not establish every underlying real-world claim." />
            <EndpointCard method="POST" path="/api/trpc/atlas.verifyEvidence" label="Public · exported packet required" />
            <p className="developer-body-copy">Export a packet from the Atlas drawer or assemble one using the envelope response. Send the exact exported packet object as <code>packet</code>; the procedure returns individual hash, signature, and embedded-key checks along with the aggregate <code>valid</code> verdict and a <code>keyStatus</code> (active, retired, revoked or unknown).</p>
            <SnippetTabs curl={verifyCurl} javascript={verifyJs} />
            <div className="developer-verify-grid">
              <div className="developer-step"><b>01</b><div><strong>Hash canonicalPayload</strong><span>Compute SHA-256 over the UTF-8 bytes of <code>canonicalPayload</code> and compare it to <code>integrityHash</code>.</span></div></div>
              <div className="developer-step"><b>02</b><div><strong>Verify Ed25519 signature</strong><span>Verify the base64-decoded <code>signature</code> against the exact UTF-8 canonical payload using <code>relayPublicKeyPem</code>.</span></div></div>
              <div className="developer-step"><b>03</b><div><strong>Evaluate provenance</strong><span>Inspect each entry’s source, proof reference, publisher-key status, and observation time against your own policy.</span></div></div>
            </div>
            <div className="developer-live-proof">
              <div className="developer-live-proof-head"><span><FileCheck2 size={15} /> Live envelope preview</span><button type="button" onClick={() => evidence.refetch()} disabled={evidence.isFetching}>{evidence.isFetching ? <Loader2 className="animate-spin" size={13} /> : <Radio size={13} />}{evidence.isFetching ? "Refreshing" : "Refresh"}</button></div>
              {envelope ? <div className="developer-live-proof-grid"><ProofDatum label="Agent" value={envelope.agentId} /><ProofDatum label="Sequence" value={`#${envelope.sequence}`} /><ProofDatum label="Digest" value={`${envelope.integrityHash.slice(0, 16)}…`} mono /><ProofDatum label="Signature" value={envelope.signatureAlgorithm} /><ProofDatum label="Entries" value={`${envelope.entries.length} observations`} /><ProofDatum label="Publisher" value={envelope.publisherValidation?.status ?? "unverified"} /></div> : <div className="developer-live-proof-empty">{evidence.isLoading ? <><Loader2 className="animate-spin" size={16} /> Resolving public evidence relay…</> : "Evidence preview is unavailable."}</div>}
            </div>
          </section>

          <section className="developer-footer-card">
            <div><p className="developer-eyebrow"><span /> BUILD WITH NOOSCAPE</p><h2>Machine-readable discovery needs verifiable context.</h2><p>Live ingestion is on: records enter through approved sources and reviewed runs, and every tier upgrade is operator-gated, validity-windowed, and versioned under the published scale.</p></div>
            <a href="/" className="developer-return">Explore the Atlas <ArrowUpRight size={15} /></a>
          </section>
        </article>
      </div>
    </main>
  );
}

function SectionHeader({ eyebrow, title, detail }: { eyebrow: string; title: string; detail: string }) {
  return <header className="developer-section-header"><p>{eyebrow}</p><h2>{title}</h2><span>{detail}</span></header>;
}

function EndpointCard({ method, path, label }: { method: string; path: string; label: string }) {
  return <div className="developer-endpoint"><span>{method}</span><code>{path}</code><em>{label}</em></div>;
}

function SnippetTabs({ curl, javascript }: { curl: string; javascript: string }) {
  const [language, setLanguage] = useState<SnippetLanguage>("cURL");
  const [copied, setCopied] = useState(false);
  const code = language === "cURL" ? curl : javascript;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return <div className="developer-code-block"><header><div>{(["cURL", "JavaScript"] as SnippetLanguage[]).map(item => <button type="button" key={item} onClick={() => setLanguage(item)} className={cn(language === item && "developer-code-active")}>{item}</button>)}</div><button type="button" onClick={copy} aria-label="Copy code example">{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? "Copied" : "Copy"}</button></header><pre><code>{code}</code></pre></div>;
}

function SchemaPanel({ title, rows }: { title: string; rows: Array<[string, string, string]> }) {
  return <section className="developer-schema"><header><Braces size={15} /><span>{title}</span></header><div>{rows.map(([field, type, detail]) => <div key={field} className="developer-schema-row"><code>{field}</code><em>{type}</em><p>{detail}</p></div>)}</div></section>;
}

function JsonResponseExample({ code, title = "Public record shape", note = "Served live by liveData.publicRecords" }: { code: string; title?: string; note?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return <section className="methodology-json-example"><header><div><span><Braces size={15} /> {title}</span><em>{note}</em></div><button type="button" onClick={copy}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? "Copied" : "Copy JSON"}</button></header><div className="methodology-json-body">{code.split("\n").map((line, index) => <JsonLine key={`${index}-${line}`} number={index + 1} line={line} />)}</div><footer><Fingerprint size={13} /> <span><strong>Scale-stable contract:</strong> every tier-raising verification records its scale version (evidence-tier-v1) with the evidence event, so a historical tier decision remains explainable.</span></footer></section>;
}

function JsonLine({ number, line }: { number: number; line: string }) {
  const field = line.match(/^(\s*)("[^"]+")(\s*:\s*)(.*?)(,?)$/);
  if (!field) return <div className="methodology-json-line"><i>{number}</i><code>{line}</code></div>;
  const [, indent, key, separator, rawValue, comma] = field;
  const valueClass = rawValue.startsWith('"') ? "json-value-string" : rawValue === "true" || rawValue === "false" ? "json-value-boolean" : "json-value-number";
  return <div className="methodology-json-line"><i>{number}</i><code>{indent}<span className="json-key">{key}</span>{separator}<span className={valueClass}>{rawValue}</span>{comma}</code></div>;
}

function ProofDatum({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div><span>{label}</span><strong className={mono ? "developer-mono" : undefined}>{value}</strong></div>;
}
