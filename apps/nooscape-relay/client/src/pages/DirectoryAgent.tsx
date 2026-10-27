import { useEffect, type ReactNode } from "react";
import { ExternalLink, Search, ShieldCheck } from "lucide-react";
import { Link, useRoute } from "wouter";
import { featureOn } from "@shared/features";
import { AgentBotAvatar } from "@/components/AgentBotAvatar";
import { Term } from "@/components/Term";
import { ClaimPanel } from "@/components/claim/ClaimPanel";
import { claimChainLabel } from "@/lib/claimFlow";
import { trpc } from "@/lib/trpc";
import { checkSentence, formatWhen, type AgentCheck } from "@/lib/checkText";
import { directoryProtocolLabel, lookalikeLine } from "@/lib/directoryProtocols";
import { registrationReadLine, type RegistrationRead } from "@/lib/registrationReadText";
import {
  acknowledgedExplanation,
  chainActivityEventLabel,
  chainActivityExplanation,
  handoutExplanation,
  lookalikeExplanation,
  publisherStateExplanations,
  registrantExplanationFor,
  registrantLabel,
  registrantNarrationFor,
  sharedWalletNoun,
  registryRatingsEventLabel,
  registryRatingsExplanation,
  tierExplanations,
  timelineEventLabel,
} from "@/lib/evidenceExplain";

// "Claim this agent" is built and stays off until VITE_FEATURES names it when the client is built (shared/features.ts).
const CLAIMS_ON = featureOn("claims", import.meta.env.VITE_FEATURES);

// The acknowledged layer never assigns trust, so the avatar tone is protocol-
// derived: a stable, honest color rather than a capability or tier signal.
const protocolTones: Record<string, string> = {
  a2a: "#BFFF76",
  anp: "#66E8FF",
  agntcy: "#66E8FF",
  erc8004: "#C3A6FF",
  catalog: "#BFFF76",
  census: "#66E8FF",
  solana_registry: "#66E8FF",
  solana_8004: "#66E8FF",
  solana_said: "#5CF2C8",
  solana_agenc: "#FF8FB8",
  erc8004_bsc: "#F5C451",
  erc8004_eth: "#7DD3FC",
  erc8004_base: "#3B82F6",
  erc8004_arc: "#ACC6E9",
};

function protocolLabel(protocol: string) {
  return directoryProtocolLabel(protocol);
}

function parseProtocols(raw: string) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function formatDate(value: Date | null) {
  return value ? new Date(value).toLocaleString() : "Not recorded";
}

// Exact decimal shift of a rater-submitted score, mirrored from
// server/ratingsSurface.ts (the client can't import server modules):
// string math over the stored decimal, never a float.
function formatRatingValue(valueRaw: string, valueDecimals: number): string {
  const decimals = Number.isFinite(valueDecimals) && valueDecimals > 0 ? Math.floor(valueDecimals) : 0;
  const negative = valueRaw.startsWith("-");
  const magnitude = negative ? valueRaw.slice(1) : valueRaw;
  const digits = /^\d+$/.test(magnitude) ? magnitude : "0";
  let text: string;
  if (decimals === 0) {
    text = digits;
  } else if (digits.length <= decimals) {
    text = `0.${"0".repeat(decimals - digits.length)}${digits}`;
  } else {
    const point = digits.length - decimals;
    text = `${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  return `${negative && digits !== "0" ? "-" : ""}${text}`;
}

// The public record contract served by liveData.publicRecords / agentProfile.
type ReviewedRecord = {
  agentId: string;
  displayName: string;
  handle: string;
  primaryCapability: string | null;
  untrustedSummary: string | null;
  protocols: string;
  publisherState: string;
  evidenceTier: string;
  sourceCount: number;
  lastObservedAt: Date;
  /** Present only when the name was read from the record's registration link and laid over a placeholder number: the day it was read. */
  nameReadAt?: string;
};

type TimelineEvent = {
  eventType: string;
  description: string | null;
  observedAt: Date;
};

type AcknowledgedEntry = {
  id: string;
  displayName: string;
  locatorHost: string | null;
  protocol: string;
  sourceSignalNote: string | null;
  registrant: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  // Fold hints: other acknowledged entries sharing this one's registering
  // wallet, exact name, or locator host. Absent when the counts can't be read:
  // grouping facts, never identity or quality.
  related?: { sameWallet: number; sameName: number; sameHost: number };
  // Chain-activity facts decoded from the registry: ownership timing only.
  // Absent while the activity read can't run (migration pending); once read,
  // counts stay null until the activity walk has covered this entry:
  // "not measured yet", never a false zero.
  activity?: {
    mintBlock: number | null;
    secondaryTransferCount: number | null;
    handoutCount: number | null;
    uriUpdateCount: number | null;
    events: Array<{
      kind: string;
      blockNumber: number;
      transactionHash: string;
      logIndex: number;
      fromAddress: string | null;
      toAddress: string | null;
      isHandout?: boolean;
    }>;
  } | null;
  // Census-exact on-chain feedback counter read from the 8004 AgentAccount
  // (8004 pass). Absent or null for other protocols and rows the pass has
  // not covered yet; a self-reported registry counter, never a Nooscape
  // rating.
  feedbackCount?: number | null;
  // Chain-linked twin from the 8004 metadata pass: another acknowledged
  // entry whose external key this entry's on-chain metadata references
  // exactly once across the directory. Null when unlinked or when the
  // linkage tables can't be read (migration pending).
  twin?: {
    entryId: string;
    displayName: string;
    protocol: string;
    linkedProtocol: string;
    metadataKey: string;
    linkedExternalKey: string;
  } | null;
  // Chain-recorded feedback events from the ERC-8004 reputation registry
  // (Robinhood Chain ledger). Absent or null for every other protocol and
  // while the ledger can't be read; records are shown as submitted on-chain,
  // never a Nooscape rating.
  ratings?: {
    measuredThroughBlock: number | null;
    totalEvents: number;
    ratingCount: number;
    activeRatingCount: number;
    revokedCount: number;
    responseCount: number;
    events: Array<{
      kind: string;
      blockNumber: number;
      transactionHash: string;
      logIndex: number;
      clientAddress: string;
      feedbackIndex: number | null;
      valueRaw: string | null;
      valueDecimals: number | null;
      tag1: string | null;
      tag2: string | null;
      revoked: boolean;
    }>;
  } | null;
  // A BNB entry only: whether Nooscape has read its registration, and when (docs/approvals/2026-10-18-bnb-checked-unproven.md).
  // Absent for every other protocol, and null when the read cannot be answered, in which case the page says nothing.
  registrationRead?: RegistrationRead | null;
};

const card ="rounded-2xl border border-[var(--ns-glass-border)] bg-[var(--ns-glass)] p-5 sm:p-6";
const note = "max-w-2xl text-sm leading-6 text-ns-ink-dim";
const mono = "break-all font-mono text-xs leading-5 text-ns-ink-dim";
const chip = "rounded-full border border-[var(--ns-glass-border)] bg-white/[.04] px-2.5 py-1 font-mono text-xs uppercase tracking-[.1em] text-ns-ink";
const pill = "inline-flex min-h-11 items-center gap-2 rounded-full border border-ns-radar/40 bg-ns-radar/10 px-4 font-mono text-xs uppercase tracking-[.14em] text-ns-radar transition hover:bg-ns-radar hover:text-ns-void focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ns-radar";

/** One part of the record: a heading, and what the record holds for it. */
function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className={card}>
      <h3 id={id} className="text-lg font-medium tracking-[-.02em] text-[#F2FFF5]">{title}</h3>
      <div className="mt-4 space-y-5">{children}</div>
    </section>
  );
}

function Facts({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-4">{children}</dl>;
}

function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-1 break-words font-mono text-sm text-ns-ink">{children}</dd>
    </div>
  );
}

/** A small heading over a paragraph or list inside a section. */
function Part({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div>
      <p className="eyebrow">{label}</p>
      <div className="mt-2 space-y-2">{children}</div>
    </div>
  );
}

/** A BNB entry's registration read, in one of two plain forms on every BNB entry: no colour, no count, nothing from the file. */
function RegistrationReadPart({ read }: { read: RegistrationRead }) {
  const line = registrationReadLine(read, read.checked ? formatWhen(read.readAt) : "");
  return (
    <Part label="Registration read">
      <p className="text-sm font-medium text-ns-ink">{line.title}</p>
      <p className={note}>{line.body}</p>
    </Part>
  );
}

function Dot({ color }: { color: string }) {
  return <span aria-hidden="true" className="mt-2 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color, boxShadow: `0 0 10px ${color}` }} />;
}

export default function DirectoryAgent() {
  const [match, params] = useRoute("/agents/:id");
  const id = match ? (params.id ?? "") : "";
  const profileQuery = trpc.liveData.agentProfile.useQuery(
    { id },
    { enabled: id.length > 0, refetchOnWindowFocus: false }
  );
  const profile = profileQuery.data;
  const record: ReviewedRecord | null = profile?.record ?? null;
  const entry: AcknowledgedEntry | null = profile?.entry ?? null;
  const timeline: TimelineEvent[] = profile?.timeline ?? [];
  const checks: AgentCheck[] = profile?.checks ?? [];

  useEffect(() => {
    const before = document.title;
    const name = record?.displayName ?? entry?.displayName;
    document.title = name ? `${name} | Nooscape` : "Agent | Nooscape";
    return () => {
      document.title = before;
    };
  }, [record, entry]);

  const reviewedTone = record ? (protocolTones[parseProtocols(record.protocols)[0]] ?? "#BFFF76") : "#BFFF76";
  const tone = record ? reviewedTone : entry ? (protocolTones[entry.protocol] ?? "#BFFF76") : "#BFFF76";
  // Fold hints are optional by contract: an absent `related` means the counts
  // could not be read, which renders as "not measured" rather than a false zero.
  const related = entry?.related ?? null;
  const lookalikeTotal = related ? related.sameWallet + related.sameName + related.sameHost : 0;
  const ratings = entry?.ratings ?? null;
  const hasFeedback = typeof entry?.feedbackCount === "number" || ratings !== null;

  return (
    <main className="relative min-h-screen overflow-x-hidden bg-ns-void text-ns-ink">
      <header className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-5 py-5">
        <Link href="/" className="inline-flex min-h-11 items-center gap-3 text-sm font-semibold uppercase tracking-[.29em] text-[#F1FFF3]">
          <img src="/favicon.svg" alt="" width="32" height="32" className="h-8 w-8 rounded-xl" />
          Nooscape
        </Link>
        <Link href="/" className="inline-flex min-h-11 items-center font-mono text-xs uppercase tracking-[.14em] text-ns-radar underline underline-offset-4 hover:text-ns-ink">
          Back to the Noosphere
        </Link>
      </header>

      <div className="mx-auto max-w-4xl px-5 pb-16 pt-4">
        {profileQuery.isLoading && (
          <div className={`${card} text-center`}>
            <p className="eyebrow">Checking the agent index…</p>
          </div>
        )}

        {profileQuery.isError && !profile && (
          <div role="alert" className={`${card} text-center`}>
            <p className="eyebrow">The agent index did not answer</p>
            <h1 className="mt-2 text-2xl font-medium tracking-[-.03em] text-[#F2FFF5]">This record could not be read just now</h1>
            <p className={`${note} mx-auto mt-3`}>The read failed, which is not the same as the record not existing. Nothing about it has been guessed. Try again in a moment.</p>
            <button type="button" onClick={() => void profileQuery.refetch()} className={`${pill} mt-6`}>Try again</button>
          </div>
        )}

        {!profileQuery.isLoading && profile?.kind === "none" && (
          <div className={`${card} text-center`}>
            <p className="eyebrow">No agent found</p>
            <h1 className="mt-2 text-2xl font-medium tracking-[-.03em] text-[#F2FFF5]">That identifier isn't in the reviewed records or the acknowledgement index</h1>
            <p className={`${note} mx-auto mt-3`}>It may not exist yet, or the index is briefly unreachable. Public reads fail closed rather than guess. The catalogue search from the observatory covers every agent Nooscape has seen.</p>
            <Link href="/" className={`${pill} mt-6`}><Search size={14} aria-hidden="true" /> Search the catalogue</Link>
          </div>
        )}

        {(record || entry) && (
          <>
            <p className="eyebrow"><Term k="dossier">Dossier</Term></p>
            <div className="mt-3 flex flex-col gap-5 sm:flex-row sm:items-center">
              <span className="grid h-24 w-24 shrink-0 place-items-center rounded-2xl border border-[var(--ns-glass-border)] bg-ns-night p-3">
                <AgentBotAvatar agentId={record ? record.agentId : (entry?.id ?? "")} tone={tone} />
              </span>
              <div className="min-w-0">
                <h1 className="break-words text-3xl font-medium leading-tight tracking-[-.04em] text-[#F2FFF5] sm:text-4xl">{record ? record.displayName : entry?.displayName}</h1>
                {record && <p className="mt-1 font-mono text-xs text-ns-ink-dim">@{record.handle}</p>}
                {record?.nameReadAt && <p className="mt-1 text-xs leading-5 text-ns-ink-dim">This name was read from the agent&rsquo;s registration link on {formatWhen(record.nameReadAt)}. It is the registrant&rsquo;s own claim, and the record&rsquo;s evidence still shows the number.</p>}
                <p className="mt-2 flex items-center gap-2 font-mono text-xs uppercase tracking-[.14em] text-ns-radar">
                  <span className="pulse-dot" aria-hidden="true" />
                  {record ? "Reviewed record · source-scoped" : <><Term k="acknowledgement">Acknowledged</Term> · not reviewed</>}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {record
                    ? parseProtocols(record.protocols).map(protocol => <span key={protocol} className={chip}>{protocolLabel(protocol)}</span>)
                    : entry && <span className={chip}>{protocolLabel(entry.protocol)}</span>}
                </div>
              </div>
            </div>

            <h2 className="mt-10 text-2xl font-medium tracking-[-.03em] text-[#F2FFF5]">What the record shows</h2>
            <p className={`${note} mt-2`}>Everything Nooscape has on record for this agent, each part labelled with where it came from.</p>

            <div className="mt-6 space-y-4">
              {record && (
                <>
                  <Section id="dossier-registry" title="Registry entry">
                    <Facts>
                      <Fact label="Evidence tier">{tierExplanations[record.evidenceTier]?.label ?? record.evidenceTier}</Fact>
                      <Fact label="Publisher state">{record.publisherState}</Fact>
                      <Fact label="Sources">{record.sourceCount}</Fact>
                      <Fact label="Last observed">{formatDate(record.lastObservedAt)}</Fact>
                    </Facts>
                    <Part label="What these labels mean">
                      <p className={note}><strong className="font-medium text-ns-ink">{tierExplanations[record.evidenceTier]?.label ?? record.evidenceTier}.</strong> {tierExplanations[record.evidenceTier]?.sentence ?? "The tier scale is published as evidence-tier-v1."}</p>
                      <p className={note}><strong className="font-medium text-ns-ink">Publisher state: {record.publisherState}.</strong> {publisherStateExplanations[record.publisherState] ?? publisherStateExplanations.unverified}</p>
                    </Part>
                    {record.untrustedSummary && (
                      <Part label="Source-reported description, untrusted">
                        <p className={note}>{record.untrustedSummary}</p>
                      </Part>
                    )}
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
                      <Link href={`/?agent=${record.agentId}`} className={pill}><ShieldCheck size={14} aria-hidden="true" /> View on the map</Link>
                      <p className={mono}>record {record.agentId}</p>
                    </div>
                  </Section>

                  <Section id="dossier-timeline" title="Evidence timeline">
                    <p className={note}>Governance-authored events, newest first, written by Nooscape's ingestion and verification code and never by the agent.</p>
                    <ol className="space-y-3">
                      {timeline.length === 0 && <li className="text-sm text-ns-ink-dim">No timeline events have been published for this record yet.</li>}
                      {timeline.map((event, index) => (
                        <li key={`${event.eventType}-${index}`} className="flex gap-3">
                          <Dot color={tone} />
                          <div className="min-w-0">
                            <p className="font-mono text-xs text-ns-ink">{timelineEventLabel(event.eventType)} <span className="ml-2 text-ns-ink-dim">{formatDate(event.observedAt)}</span></p>
                            {event.description && <p className="text-sm leading-6 text-ns-ink-dim">{event.description}</p>}
                          </div>
                        </li>
                      ))}
                    </ol>
                  </Section>

                  {checks.length > 0 && (
                    <Section id="dossier-checks" title="Checks">
                      <p className={note}>Nooscape-Checker asks each https endpoint that this agent&rsquo;s approved card declares whether it answers, no more than once a day. A line is the latest ask of one host, with its date.</p>
                      <p className={note}>Any HTTP answer counts, whatever its status. The checker follows redirects, so a status can come from another host than the one named. A check that gets no answer says nothing by itself: it is a fact with its date, never a verdict. A line says failing only when the last three asks in a row got no answer, and that says nothing about why.</p>
                      <ul className="space-y-3">
                        {checks.map(check => (
                          <li key={check.host} className="flex gap-3">
                            <Dot color="#9AA8B8" />
                            <div className="min-w-0">
                              <p className="break-all font-mono text-xs text-ns-ink">{check.host}</p>
                              <p className="text-sm leading-6 text-ns-ink-dim">{checkSentence(check, formatWhen(check.checkedAt))}</p>
                            </div>
                          </li>
                        ))}
                      </ul>
                      <Link href="/checker" className="inline-flex min-h-11 items-center font-mono text-xs uppercase tracking-[.14em] text-ns-radar underline underline-offset-4 hover:text-ns-ink">
                        About Nooscape-Checker
                      </Link>
                    </Section>
                  )}
                </>
              )}

              {entry && (
                <>
                  <Section id="dossier-registry" title="Registry entry">
                    <Facts>
                      <Fact label="Protocol">{protocolLabel(entry.protocol)}</Fact>
                      <Fact label="Ledger">Acknowledgement</Fact>
                      <Fact label="First seen">{formatDate(entry.firstSeenAt)}</Fact>
                      <Fact label="Last seen">{formatDate(entry.lastSeenAt)}</Fact>
                    </Facts>
                    <Part label="Source note">
                      <p className={note}>{entry.sourceSignalNote ?? "No source note recorded for this entry."}</p>
                    </Part>
                    {entry.registrationRead && <RegistrationReadPart read={entry.registrationRead} />}
                    <Part label="Why this page is sparse">
                      <p className={note}>{acknowledgedExplanation}</p>
                      <p className={mono}>entry {entry.id}</p>
                    </Part>
                  </Section>

                  <Section id="dossier-owner" title="Owner">
                    {entry.registrant ? (
                      <Part label={registrantLabel(entry.protocol)}>
                        <p className="break-all font-mono text-sm text-ns-ink">{entry.registrant}</p>
                        <p className={note}>{registrantExplanationFor(entry.protocol)}</p>
                        {related && <p className={note}>{registrantNarrationFor(entry.protocol, related.sameWallet)}</p>}
                      </Part>
                    ) : (
                      <p className={note}>No registering wallet is recorded for this entry.</p>
                    )}
                    {entry.activity ? (
                      <Part label={<Term k="chainActivity">Chain activity</Term>}>
                        <Facts>
                          <Fact label="Minted at block">{entry.activity.mintBlock === null ? "?" : entry.activity.mintBlock.toLocaleString()}</Fact>
                          <Fact label="Changes of hands">{entry.activity.secondaryTransferCount === null ? "?" : entry.activity.secondaryTransferCount.toLocaleString()}</Fact>
                          <Fact label={<Term k="handout">Hand-outs</Term>}>{entry.activity.handoutCount === null ? "?" : entry.activity.handoutCount.toLocaleString()}</Fact>
                          <Fact label="Profile-link edits">{entry.activity.uriUpdateCount === null ? "?" : entry.activity.uriUpdateCount.toLocaleString()}</Fact>
                        </Facts>
                        {entry.activity.mintBlock === null ? (
                          <p className={note}>The activity walk hasn't reached this identity yet, so its ownership counts stay explicitly unmeasured instead of showing false zeros.</p>
                        ) : (
                          <>
                            <p className={note}>{chainActivityExplanation}</p>
                            {(entry.activity.handoutCount ?? 0) > 0 && <p className={note}>{handoutExplanation}</p>}
                          </>
                        )}
                        {entry.activity.events.length > 0 && (
                          <ol className="space-y-3">
                            {entry.activity.events.map(event => (
                              <li key={`${event.transactionHash}-${event.logIndex}`} className="flex gap-3">
                                <Dot color={tone} />
                                <div className="min-w-0">
                                  <p className="font-mono text-xs text-ns-ink">{chainActivityEventLabel(event.kind, event.isHandout)} <span className="ml-2 text-ns-ink-dim">block {event.blockNumber.toLocaleString()}</span></p>
                                  <p className={mono}>{event.transactionHash}</p>
                                </div>
                              </li>
                            ))}
                          </ol>
                        )}
                      </Part>
                    ) : (
                      <p className={note}>Chain activity is not measured for this entry.</p>
                    )}
                  </Section>

                  {CLAIMS_ON && claimChainLabel(entry.protocol) && <ClaimPanel entryId={entry.id} chainLabel={claimChainLabel(entry.protocol) ?? ""} />}

                  <Section id="dossier-host" title="Host and links">
                    <Facts>
                      <Fact label="Locator host">
                        {entry.locatorHost ? (
                          <a className="inline-flex min-h-11 items-center gap-1.5 underline decoration-ns-radar/50 underline-offset-4 transition hover:decoration-ns-radar focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ns-radar" href={`https://${entry.locatorHost}`} target="_blank" rel="noreferrer noopener">{entry.locatorHost}<ExternalLink size={14} aria-hidden="true" /></a>
                        ) : (
                          "no locator"
                        )}
                      </Fact>
                    </Facts>
                    {entry.twin && (
                      <Part label="Linked chain twin">
                        <p className={note}>
                          On-chain registry metadata for this agent references <span className="break-all font-mono text-xs text-ns-ink">{entry.twin.metadataKey}={entry.twin.linkedExternalKey}</span>. That key matches exactly one other acknowledged entry, so the two are recorded as the same identity registered on different chains. It is a chain-metadata link, never a Nooscape judgement.
                        </p>
                        <Link href={`/agents/${entry.twin.entryId}`} className={`${chip} inline-flex min-h-11 items-center hover:border-ns-radar/50 hover:text-ns-radar`}>
                          {entry.twin.displayName} · {protocolLabel(entry.twin.protocol)}
                        </Link>
                      </Part>
                    )}
                  </Section>

                  <Section id="dossier-feedback" title="Feedback">
                    {!hasFeedback && <p className={note}>Feedback is not measured for this entry.</p>}
                    {typeof entry.feedbackCount === "number" && (
                      <Part label="Registry counter">
                        <p className="font-mono text-sm text-ns-ink">{entry.feedbackCount.toLocaleString()} {entry.feedbackCount === 1 ? "rating" : "ratings"}</p>
                        <p className={note}>The counter recorded in the agent registry contract, read from chain state. It is not a Nooscape rating.</p>
                      </Part>
                    )}
                    {ratings && (
                      <Part label="Registry ratings">
                        {ratings.totalEvents === 0 ? (
                          <p className={note}>No ratings recorded for this identity yet.</p>
                        ) : (
                          <>
                            <p className="font-mono text-sm text-ns-ink">
                              {[
                                `${ratings.ratingCount.toLocaleString()} ${ratings.ratingCount === 1 ? "rating" : "ratings"}`,
                                `${ratings.revokedCount.toLocaleString()} revoked`,
                                `${ratings.responseCount.toLocaleString()} ${ratings.responseCount === 1 ? "response" : "responses"}`,
                                ratings.measuredThroughBlock === null
                                  ? null
                                  : `measured through block ${ratings.measuredThroughBlock.toLocaleString()}`,
                              ]
                                .filter((part): part is string => part !== null)
                                .join(" · ")}
                            </p>
                            <p className={note}>{registryRatingsExplanation}</p>
                            <p className={note}>Raters are unverified: Nooscape has not checked who they are.</p>
                            <ol className="space-y-3">
                              {ratings.events.map(event => (
                                <li key={`${event.transactionHash}-${event.logIndex}`} className={`flex gap-3${event.revoked ? " opacity-80" : ""}`}>
                                  <Dot color={event.revoked ? "#9AA8B8" : tone} />
                                  <div className="min-w-0">
                                    <p className="font-mono text-xs text-ns-ink">
                                      {registryRatingsEventLabel(event.kind)}
                                      {event.kind === "new_feedback" && event.valueRaw !== null && event.valueDecimals !== null && (
                                        <span className="ml-2">
                                          {formatRatingValue(event.valueRaw, event.valueDecimals)}
                                          {event.tag1 ? ` · ${event.tag1}` : ""}
                                        </span>
                                      )}
                                      {event.revoked && <span className={`${chip} ml-2 px-2 py-0.5`}>revoked</span>}
                                      <span className="ml-2 text-ns-ink-dim">block {event.blockNumber.toLocaleString()}</span>
                                    </p>
                                    <p className={mono}>by {event.clientAddress} <span className={`${chip} ml-1 px-2 py-0.5`}>unverified</span></p>
                                    <p className={mono}>{event.transactionHash}</p>
                                  </div>
                                </li>
                              ))}
                            </ol>
                          </>
                        )}
                      </Part>
                    )}
                  </Section>

                  <Section id="dossier-fleet" title="Fleet membership">
                    <Part label={<Term k="lookalike">Look-alike groups</Term>}>
                      {related ? (
                        <>
                          {lookalikeTotal === 0 ? (
                            <p className={note}>No other acknowledged entry shares this {sharedWalletNoun(entry.protocol)}, exact display name, or locator host.</p>
                          ) : (
                            <ul className="space-y-1.5">
                              {related.sameWallet > 0 && <li className="text-sm leading-6 text-ns-ink">{lookalikeLine(entry.protocol, related.sameWallet, sharedWalletNoun(entry.protocol))}</li>}
                              {related.sameName > 0 && <li className="text-sm leading-6 text-ns-ink">{related.sameName.toLocaleString()} other {related.sameName === 1 ? "entry shares" : "entries share"} this exact display name.</li>}
                              {related.sameHost > 0 && <li className="text-sm leading-6 text-ns-ink">{lookalikeLine(entry.protocol, related.sameHost, "locator host")}</li>}
                            </ul>
                          )}
                          <p className={note}>{lookalikeExplanation}</p>
                        </>
                      ) : (
                        <p className={note}>Look-alike groups are not measured for this entry right now.</p>
                      )}
                    </Part>
                    <Link href="/#fleet-heading" className="inline-flex min-h-11 items-center font-mono text-xs uppercase tracking-[.14em] text-ns-radar underline underline-offset-4 hover:text-ns-ink">
                      See Fleet sightings
                    </Link>
                  </Section>
                </>
              )}
            </div>

            <footer className="mt-10 border-t border-[var(--ns-glass-border)] pt-6">
              <p className="text-sm text-ns-ink-dim">Evidence, not a verdict. You decide.</p>
              <p className="mt-2 text-sm text-ns-ink-dim">
                Think this record is wrong? <Link href="/disputes" className="text-ns-radar underline underline-offset-4 hover:text-ns-ink">Tell us</Link>.
              </p>
            </footer>
          </>
        )}
      </div>
    </main>
  );
}
