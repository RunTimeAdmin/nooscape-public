import { OperatorKeys } from "@/components/apikeys/OperatorKeys";
import { OperatorPayments, PaymentsAlert } from "@/components/apikeys/OperatorPayments";
import { OperatorClaims } from "@/components/claim/OperatorClaims";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { identityWalkOffered, reputationWalkMode } from "@/lib/walkModes";
import { featureOn } from "@shared/features";
import { Activity, Check, Coins, Copy, Database, ExternalLink, FileX, Globe, KeyRound, Layers3, Loader2, LogOut, Pause, Play, Plus, RadioTower, RefreshCw, ShieldAlert, ShieldCheck, Star, Undo2, X } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { Link } from "wouter";

// A chain besides BNB Chain is staged from this page only while its switch is on in the build (shared/features.ts), so a chain that is
// off has no button here as it has no tab, no route and no run. The server refuses to stage or run it too.
const CHAIN_ON = {
  eth: featureOn("chain_ethereum", import.meta.env.VITE_FEATURES),
  base: featureOn("chain_base", import.meta.env.VITE_FEATURES),
  arc: featureOn("chain_arc", import.meta.env.VITE_FEATURES),
};

function formatDate(value: Date | null) {
  return value ? new Date(value).toLocaleString() : "Not yet";
}

function protocolLabel(protocol: string) {
  if (protocol === "catalog") return "Catalog";
  if (protocol === "census") return "Census";
  if (protocol === "solana_registry") return "Solana registry";
  if (protocol === "solana_8004") return "8004 Solana registry";
  if (protocol === "solana_said") return "SAID Solana registry";
  if (protocol === "erc8004") return "ERC-8004 registry";
  if (protocol === "erc8004_bsc") return "BNB Chain ERC-8004 registry";
  if (protocol === "erc8004_eth") return "Ethereum ERC-8004 registry";
  if (protocol === "erc8004_base") return "Base ERC-8004 registry";
  if (protocol === "erc8004_arc") return "Arc ERC-8004 registry";
  if (protocol === "erc8004_reputation") return "ERC-8004 reputation";
  if (protocol === "usdg_settlement") return "USDG settlements";
  return protocol.toUpperCase();
}

function challengeState(state: string, expiresAt: Date, verificationExpiresAt: Date | null = null, revokedAt: Date | null = null) {
  if (revokedAt) return "revoked";
  if (state === "pending" && new Date(expiresAt) <= new Date()) return "expired";
  if (state === "verified" && verificationExpiresAt && new Date(verificationExpiresAt) <= new Date()) return "lapsed";
  return state;
}

function cardPinStatusLabel(status: "current" | "changed" | "unpinned") {
  if (status === "current") return "Pinned to the current public card.";
  if (status === "changed") return "Card changed since verification — the read path serves Tier 2 until a recheck.";
  return "No verified card fingerprint yet.";
}

type IssuedChallenge = {
  id: string;
  expiresAt: Date;
  proofUrl: string;
  token: string;
  instructions: string;
};

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  async function copyValue() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }
  return (
    <div className="source-ops-copy-field">
      <p>
        <span>{label}</span>
        <Button type="button" size="sm" variant="ghost" onClick={copyValue}>
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} {copied ? "Copied" : "Copy"}
        </Button>
      </p>
      <code>{value}</code>
    </div>
  );
}

export default function SourceOperations() {
  const utils = trpc.useUtils();
  const operatorQuery = trpc.operator.status.useQuery(undefined, { retry: false });
  const isOperator = operatorQuery.data?.authenticated === true;
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [rootUrl, setRootUrl] = useState("");
  const [scheduleMinutes, setScheduleMinutes] = useState("15");
  const [notice, setNotice] = useState<string | null>(null);
  const [challengeAgentId, setChallengeAgentId] = useState("");
  const [challengeDomainRoot, setChallengeDomainRoot] = useState("");
  const [issuedChallenge, setIssuedChallenge] = useState<IssuedChallenge | null>(null);
  const [withdrawAgentId, setWithdrawAgentId] = useState("");
  const [withdrawReason, setWithdrawReason] = useState("");
  const [verifySourceId, setVerifySourceId] = useState<string | null>(null);

  const sourcesQuery = trpc.liveData.admin.sources.useQuery(undefined, {
    enabled: isOperator,
    retry: false,
  });

  const recordsQuery = trpc.liveData.publicRecords.useQuery(undefined, {
    enabled: isOperator,
    retry: false,
  });

  const clientAddressQuery = trpc.operator.clientAddress.useQuery(undefined, {
    enabled: isOperator,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const clientAddress = clientAddressQuery.data;

  const challengesQuery = trpc.liveData.admin.domainChallenges.useQuery(undefined, {
    enabled: isOperator,
    retry: false,
  });

  const withdrawalsQuery = trpc.liveData.admin.recordWithdrawals.useQuery(undefined, {
    enabled: isOperator,
    retry: false,
  });

  const verifyQuery = trpc.liveData.admin.verifySourceEvidenceBatch.useQuery(
    { sourceId: verifySourceId ?? "" },
    { enabled: isOperator && verifySourceId !== null, retry: false }
  );
  const verifyData = verifyQuery.data;

  const refresh = () => {
    void operatorQuery.refetch();
    void utils.liveData.admin.sources.invalidate();
    void utils.liveData.admin.domainChallenges.invalidate();
    void utils.liveData.admin.recordWithdrawals.invalidate();
  };
  const loginMutation = trpc.operator.login.useMutation({
    onSuccess: result => {
      setToken("");
      setNotice(`Operator session established for ${result.operatorName}.`);
      refresh();
    },
    onError: error => setNotice(error.message),
  });
  const logoutMutation = trpc.operator.logout.useMutation({
    onSuccess: () => {
      setNotice("Operator session ended.");
      refresh();
    },
  });
  const registerMutation = trpc.liveData.admin.registerA2aSource.useMutation({
    onSuccess: () => {
      setLabel("");
      setRootUrl("");
      setNotice("Source registered in review. An operator must explicitly approve it before any fetch can occur.");
      refresh();
    },
    onError: error => setNotice(error.message),
  });
  const decideMutation = trpc.liveData.admin.decideSource.useMutation({
    onSuccess: () => refresh(),
    onError: error => setNotice(error.message),
  });
  const runMutation = trpc.liveData.admin.runSource.useMutation({
    onSuccess: result => {
      setNotice(result.nextCursor?.startsWith("bf:")
        ? `Backfill window acknowledged into the master directory; walk position saved at ${result.nextCursor}. Reviewed records unchanged.`
        : result.nextCursor?.startsWith("rb:")
          ? `Registrant window filled into the master directory; walk position saved at ${result.nextCursor}. Reviewed records unchanged.`
          : result.nextCursor?.startsWith("ac:")
            ? `Chain-activity window acknowledged into the activity ledger; walk position saved at ${result.nextCursor}. Reviewed records unchanged.`
            : result.nextCursor?.startsWith("us:")
              ? `Settlement window acknowledged into the settlement ledger (${result.acceptedCount} measured, ${result.rejectedCount} unresolvable); walk position saved at ${result.nextCursor}. Reviewed records unchanged.`
              : result.nextCursor?.startsWith("sync2:")
                ? `Solana chain pass acknowledged (${result.acceptedCount} entries refreshed, ${result.rejectedCount} unparseable); inventory position saved at ${result.nextCursor}. Chain facts only — reviewed records unchanged.`
                : result.nextCursor?.startsWith("s8004:")
                  ? `8004 chain pass acknowledged (${result.acceptedCount} entries refreshed, ${result.rejectedCount} non-agent accounts counted); inventory position saved at ${result.nextCursor}. Chain facts only — reviewed records unchanged.`
                  : result.nextCursor?.startsWith("said:")
                  ? `SAID chain pass acknowledged (${result.acceptedCount} identities refreshed of ${result.discoveredCount} enumerated, ${result.rejectedCount} previously acknowledged identities missing from the listing); inventory position saved at ${result.nextCursor}. Chain facts only; reviewed records unchanged.`
                  : `Bounded source run completed: ${result.acceptedCount} accepted record${result.acceptedCount === 1 ? "" : "s"}.`);
      refresh();
    },
    onError: error => setNotice(error.message),
  });
  const registerApprovedMutation = trpc.liveData.admin.registerApprovedPublicSource.useMutation({
    onSuccess: result => {
      setNotice(result.created ? "Approved public source staged for review. No network fetch occurred." : "This approved public source is already in the registry.");
      refresh();
    },
    onError: error => setNotice(error.message),
  });

  const issueChallengeMutation = trpc.liveData.admin.issueDomainChallenge.useMutation({
    onSuccess: result => {
      setChallengeAgentId("");
      setChallengeDomainRoot("");
      setIssuedChallenge(result);
      setNotice("Challenge issued. Hand the one-time token to the domain operator — Nooscape stores only its digest and cannot show it again.");
      refresh();
    },
    onError: error => setNotice(error.message),
  });
  const verifyChallengeMutation = trpc.liveData.admin.verifyDomainChallenge.useMutation({
    onSuccess: result => {
      setIssuedChallenge(null);
      setNotice(`Domain control verified for ${result.domain}. Evidence tier is now ${result.evidenceTier} until ${formatDate(result.verificationExpiresAt)}; publisher state remains ${result.publisherState}.`);
      void utils.liveData.publicRecords.invalidate();
      void utils.liveData.admin.domainChallenges.invalidate();
    },
    onError: error => setNotice(error.message),
  });
  const recheckMutation = trpc.liveData.admin.recheckDomainVerification.useMutation({
    onSuccess: result => {
      setNotice(
        result.outcome === "renewed"
          ? `Live proof re-fetched for ${result.domain}. ${result.evidenceTier} renewed until ${formatDate(result.verificationExpiresAt)}.`
          : `Recheck failed for ${result.domain} (${result.reason ?? "unknown error"}). The record returns to ${result.evidenceTier} evidence until a new challenge succeeds.`
      );
      void utils.liveData.publicRecords.invalidate();
      void utils.liveData.admin.domainChallenges.invalidate();
    },
    onError: error => setNotice(error.message),
  });

  const projectMutation = trpc.liveData.admin.decideProjection.useMutation({
    onSuccess: result => {
      setNotice(result.approvedRunId ? `Public projection bound to reviewed run ${result.approvedRunId.slice(0, 8)}.` : "Public projection revoked.");
      refresh();
      void utils.liveData.publicRecords.invalidate();
      void utils.liveData.publicCoverage.invalidate();
    },
    onError: error => setNotice(error.message),
  });

  const withdrawMutation = trpc.liveData.admin.withdrawRecord.useMutation({
    onSuccess: () => {
      setWithdrawAgentId("");
      setWithdrawReason("");
      setNotice("Record withdrawn from the public census. The source, its approved run, and retained evidence are unchanged; the withdrawal is evidence-recorded and reversible.");
      void utils.liveData.publicRecords.invalidate();
      void utils.liveData.publicCoverage.invalidate();
      void utils.liveData.admin.recordWithdrawals.invalidate();
    },
    onError: error => setNotice(error.message),
  });
  const reinstateMutation = trpc.liveData.admin.reinstateRecord.useMutation({
    onSuccess: () => {
      setNotice("Record reinstated. Visibility re-resolves through the reviewed-run gate.");
      void utils.liveData.publicRecords.invalidate();
      void utils.liveData.publicCoverage.invalidate();
      void utils.liveData.admin.recordWithdrawals.invalidate();
    },
    onError: error => setNotice(error.message),
  });

  const agentNameById = useMemo(() => {
    const map = new Map<string, { displayName: string; handle: string }>();
    for (const record of recordsQuery.data?.records ?? []) {
      map.set(record.agentId, { displayName: record.displayName, handle: record.handle });
    }
    return map;
  }, [recordsQuery.data?.records]);

  const tierTwoAgents = useMemo(
    () =>
      (recordsQuery.data?.records ?? [])
        .filter(record => record.evidenceTier === "tier_2")
        .sort((first, second) => first.displayName.localeCompare(second.displayName)),
    [recordsQuery.data?.records]
  );

  const servedRecords = useMemo(
    () =>
      (recordsQuery.data?.records ?? [])
        .slice()
        .sort((first, second) => first.displayName.localeCompare(second.displayName)),
    [recordsQuery.data?.records]
  );

  const pendingChallenges = useMemo(
    () =>
      (challengesQuery.data?.challenges ?? []).filter(
        challenge => challenge.state === "pending" && new Date(challenge.expiresAt) > new Date()
      ),
    [challengesQuery.data?.challenges]
  );

  const pendingReviews = useMemo(
    () => sourcesQuery.data?.reviews.filter(review => review.status === "pending") ?? [],
    [sourcesQuery.data?.reviews]
  );

  const projectionBySource = useMemo(
    () => new Map((sourcesQuery.data?.projections ?? []).map(projection => [projection.sourceId, projection] as const)),
    [sourcesQuery.data?.projections]
  );

  const latestRunBySource = useMemo(() => new Map(Object.entries(sourcesQuery.data?.latestRuns ?? {})), [sourcesQuery.data?.latestRuns]);

  const approvedRunBySource = useMemo(() => new Map(Object.entries(sourcesQuery.data?.approvedRuns ?? {})), [sourcesQuery.data?.approvedRuns]);

  const verifyProblemChecks = useMemo(
    () => (verifyData?.checks ?? []).filter(check => !check.hashMatches || check.retentionMode !== "GOVERNANCE" || !check.retainUntil),
    [verifyData]
  );

  const verifyEarliestRetainUntil = useMemo(() => {
    const retained = (verifyData?.checks ?? [])
      .map(check => check.retainUntil)
      .filter((value): value is Date => Boolean(value));
    return retained.length ? new Date(Math.min(...retained.map(value => new Date(value).getTime()))) : null;
  }, [verifyData]);

  function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(null);
    loginMutation.mutate({ token });
  }

  function submitSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(null);
    registerMutation.mutate({ label, rootUrl, scheduleMinutes: Number(scheduleMinutes) });
  }

  function submitChallenge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(null);
    if (!challengeAgentId) return;
    issueChallengeMutation.mutate({ agentId: challengeAgentId, domainRoot: challengeDomainRoot });
  }

  function submitWithdrawal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(null);
    if (!withdrawAgentId) return;
    withdrawMutation.mutate({ agentId: withdrawAgentId, reason: withdrawReason });
  }

  if (operatorQuery.isLoading) {
    return <main className="source-ops-shell"><Loader2 className="h-5 w-5 animate-spin text-lime-300" /></main>;
  }

  if (!operatorQuery.data?.configured) {
    return (
      <main className="source-ops-shell">
        <section className="source-ops-empty">
          <ShieldAlert className="h-8 w-8 text-amber-300" />
          <p className="eyebrow">Operator access</p>
          <h1>Production operator authentication is not configured.</h1>
          <p>Source operations stay unavailable until a server-only operator token is configured.</p>
          <Link href="/">Return to the observatory</Link>
        </section>
      </main>
    );
  }

  if (!isOperator) {
    return (
      <main className="source-ops-shell">
        <section className="source-ops-empty">
          <KeyRound className="h-8 w-8 text-lime-300" />
          <p className="eyebrow">Operator access</p>
          <h1>Unlock the source control plane.</h1>
          <p>Enter the server-issued operator token. It is checked on the server and stays only in this browser session.</p>
          {notice ? <div className="source-ops-notice" role="status">{notice}</div> : null}
          <form onSubmit={submitLogin} className="source-ops-form source-ops-login-form">
            <div>
              <Label htmlFor="operator-token">Operator token</Label>
              <Input id="operator-token" type="password" autoComplete="current-password" value={token} onChange={event => setToken(event.target.value)} required minLength={32} />
            </div>
            <Button type="submit" disabled={loginMutation.isPending}>
              {loginMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              Establish session
            </Button>
          </form>
          <Link href="/">Return to the observatory</Link>
        </section>
      </main>
    );
  }

  return (
    <main className="source-ops-shell">
      <header className="source-ops-header">
        <div>
          <p className="eyebrow"><RadioTower className="h-3.5 w-3.5" /> Ingestion control plane</p>
          <h1>Approved-source registry</h1>
          <p>Stage a permitted source, review its host boundary, then run one bounded observation. Public visibility binds to an explicitly approved run, so every later run stays withheld until it is reviewed.</p>
        </div>
        <div className="source-ops-header-actions">
          <Button size="sm" variant="ghost" onClick={() => logoutMutation.mutate()} disabled={logoutMutation.isPending}><LogOut className="h-3.5 w-3.5" /> End session</Button>
          <Link href="/" className="source-ops-back">Return to map <ExternalLink className="h-3.5 w-3.5" /></Link>
        </div>
      </header>

      <PaymentsAlert />

      <section className="source-ops-safety" aria-label="Ingestion safeguards">
        <span><Check className="h-4 w-4" /> HTTPS only</span>
        <span><Check className="h-4 w-4" /> Private-network blocks</span>
        <span><Check className="h-4 w-4" /> Protocol-specific payload caps</span>
        <span><Check className="h-4 w-4" /> Redirects refused</span>
        <span><Pause className="h-4 w-4" /> Scheduled runs are review-gated</span>
      </section>

      {clientAddress ? (
        <section className={`source-ops-request-path${clientAddress.looksRight ? "" : " source-ops-request-path-check"}`} aria-label="Request path">
          <p><Globe className="h-4 w-4" /> Your address as the server sees it: <code>{clientAddress.address}</code></p>
          <p>{clientAddress.note}</p>
        </section>
      ) : null}

      {notice ? <div className="source-ops-notice" role="status">{notice}</div> : null}

      <div className="source-ops-grid">
        <section className="source-ops-panel">
          <div className="source-ops-panel-title">
            <div className="source-ops-icon"><Plus className="h-4 w-4" /></div>
            <div><p className="eyebrow">A2A pilot</p><h2>Register a permitted domain</h2></div>
          </div>
          <form onSubmit={submitSource} className="source-ops-form">
            <div><Label htmlFor="source-label">Source label</Label><Input id="source-label" value={label} onChange={event => setLabel(event.target.value)} placeholder="Partner A2A pilot" required minLength={3} maxLength={160} /></div>
            <div><Label htmlFor="source-root">Approved HTTPS root</Label><Input id="source-root" value={rootUrl} onChange={event => setRootUrl(event.target.value)} placeholder="https://agent.example.org" inputMode="url" required /><p className="source-ops-help">Nooscape will only request <code>/.well-known/agent-card.json</code> on this hostname after approval.</p></div>
            <div><Label htmlFor="source-cadence">Future cadence (minutes)</Label><Input id="source-cadence" type="number" min="5" max="1440" value={scheduleMinutes} onChange={event => setScheduleMinutes(event.target.value)} required /></div>
            <Button type="submit" disabled={registerMutation.isPending}>{registerMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}Stage for review</Button>
          </form>
        </section>

        <section className="source-ops-panel source-ops-readiness">
          <div className="source-ops-panel-title">
            <div className="source-ops-icon"><RadioTower className="h-4 w-4" /></div>
            <div><p className="eyebrow">Reviewed public feeds</p><h2>Stage a fixed source</h2></div>
          </div>
          <p className="mt-3 text-sm leading-6 text-[#9fb2a6]">These routes are fixed in server code, not supplied by the browser. Each still requires activation, a bounded first run, raw-object review, and a projection decision.</p>
          <div className="mt-4 grid gap-2">
            <Button type="button" variant="outline" onClick={() => registerApprovedMutation.mutate({ source: "agenstry" })} disabled={registerApprovedMutation.isPending}>
              <RadioTower className="h-4 w-4" /> Stage Agenstry catalog
            </Button>
            <Button type="button" variant="outline" onClick={() => registerApprovedMutation.mutate({ source: "agentEconomy" })} disabled={registerApprovedMutation.isPending}>
              <Database className="h-4 w-4" /> Stage Agent Economy census
            </Button>
            <Button type="button" variant="outline" onClick={() => registerApprovedMutation.mutate({ source: "metaplex" })} disabled={registerApprovedMutation.isPending}>
              <Layers3 className="h-4 w-4" /> Stage Metaplex Solana registry · manual only
            </Button>
            <Button type="button" variant="outline" onClick={() => registerApprovedMutation.mutate({ source: "solana8004" })} disabled={registerApprovedMutation.isPending}>
              <Activity className="h-4 w-4" /> Stage 8004 Solana registry · manual only
            </Button>
            <Button type="button" variant="outline" onClick={() => registerApprovedMutation.mutate({ source: "said" })} disabled={registerApprovedMutation.isPending}>
              <Activity className="h-4 w-4" /> Stage SAID Solana registry · manual only
            </Button>
            <Button type="button" variant="outline" onClick={() => registerApprovedMutation.mutate({ source: "bsc" })} disabled={registerApprovedMutation.isPending}>
              <Globe className="h-4 w-4" /> Stage BNB Chain ERC-8004 registry · manual only
            </Button>
            {CHAIN_ON.eth ? (
              <Button type="button" variant="outline" onClick={() => registerApprovedMutation.mutate({ source: "ethereum" })} disabled={registerApprovedMutation.isPending}>
                <Globe className="h-4 w-4" /> Stage Ethereum ERC-8004 registry · manual only
              </Button>
            ) : null}
            {CHAIN_ON.base ? (
              <Button type="button" variant="outline" onClick={() => registerApprovedMutation.mutate({ source: "base" })} disabled={registerApprovedMutation.isPending}>
                <Globe className="h-4 w-4" /> Stage Base ERC-8004 registry · manual only
              </Button>
            ) : null}
            {CHAIN_ON.arc ? (
              <Button type="button" variant="outline" onClick={() => registerApprovedMutation.mutate({ source: "arc" })} disabled={registerApprovedMutation.isPending}>
                <Globe className="h-4 w-4" /> Stage Arc ERC-8004 registry · manual only
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={() => registerApprovedMutation.mutate({ source: "robinhood" })} disabled={registerApprovedMutation.isPending}>
              <Globe className="h-4 w-4" /> Stage Robinhood ERC-8004 registry · manual only
            </Button>
            <Button type="button" variant="outline" onClick={() => registerApprovedMutation.mutate({ source: "usdgSettlements" })} disabled={registerApprovedMutation.isPending}>
              <Coins className="h-4 w-4" /> Stage Robinhood USDG settlements · manual only
            </Button>
            <Button type="button" variant="outline" onClick={() => registerApprovedMutation.mutate({ source: "robinhoodReputation" })} disabled={registerApprovedMutation.isPending}>
              <Star className="h-4 w-4" /> Stage Robinhood ERC-8004 reputation registry · manual only
            </Button>
          </div>
        </section>

        <section className="source-ops-panel source-ops-readiness">
          <div className="source-ops-panel-title"><div className="source-ops-icon"><Database className="h-4 w-4" /></div><div><p className="eyebrow">Launch gate</p><h2>What makes an observation live?</h2></div></div>
          <ol><li><span>01</span> Operator stages a permitted source.</li><li><span>02</span> Operator approves its exact hostname boundary.</li><li><span>03</span> One bounded protocol-specific read is recorded.</li><li><span>04</span> Raw payload hash and evidence event persist.</li><li><span>05</span> Only reviewed agent records can feed the map.</li><li><span>06</span> The public set binds to the latest explicitly approved run.</li></ol>
          <p className="source-ops-warning">Do not activate a source without written permission to index its public metadata.</p>
        </section>
      </div>

      <div className="source-ops-grid">
        <section className="source-ops-panel">
          <div className="source-ops-panel-title">
            <div className="source-ops-icon"><Globe className="h-4 w-4" /></div>
            <div><p className="eyebrow">Tier 3 pathway</p><h2>Verify domain control</h2></div>
          </div>
          <form onSubmit={submitChallenge} className="source-ops-form">
            <div>
              <Label htmlFor="challenge-agent">Tier 2 agent</Label>
              <Select value={challengeAgentId} onValueChange={setChallengeAgentId}>
                <SelectTrigger id="challenge-agent" className="source-ops-select">
                  <SelectValue placeholder="Select an asserted agent" />
                </SelectTrigger>
                <SelectContent>
                  {tierTwoAgents.map(agent => (
                    <SelectItem key={agent.agentId} value={agent.agentId}>{agent.displayName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="source-ops-help">Only a domain already asserted by this agent&rsquo;s identity or endpoint records is accepted.</p>
            </div>
            <div>
              <Label htmlFor="challenge-domain">Asserted HTTPS domain root</Label>
              <Input id="challenge-domain" value={challengeDomainRoot} onChange={event => setChallengeDomainRoot(event.target.value)} placeholder="https://nooscape.si" inputMode="url" required />
              <p className="source-ops-help">The proof lands at <code>/.well-known/nooscape-domain-verification/</code> and must be served within 48 hours.</p>
            </div>
            <Button type="submit" disabled={issueChallengeMutation.isPending || !challengeAgentId}>
              {issueChallengeMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              Issue 48-hour challenge
            </Button>
          </form>
          {issuedChallenge ? (
            <div className="source-ops-dossier" role="status">
              <div className="source-ops-dossier-header">
                <span><ShieldCheck className="h-3.5 w-3.5" /> One-time proof dossier</span>
                <em>expires {formatDate(issuedChallenge.expiresAt)}</em>
              </div>
              <CopyField label="Bearer token · shown once" value={issuedChallenge.token} />
              <CopyField label="Proof location" value={issuedChallenge.proofUrl} />
              <p>{issuedChallenge.instructions}</p>
              <p className="source-ops-dossier-warning">Tier 3 records domain control only. It never verifies publisher identity, capability claims, or service behavior.</p>
            </div>
          ) : null}
        </section>

        <section className="source-ops-panel source-ops-readiness">
          <div className="source-ops-panel-title"><div className="source-ops-icon"><ShieldCheck className="h-4 w-4" /></div><div><p className="eyebrow">Evidence boundary</p><h2>What Tier 3 means</h2></div></div>
          <ol><li><span>01</span> The agent already projects as Tier 2 with an asserted domain.</li><li><span>02</span> A challenge issues a one-time token inside a 48-hour window.</li><li><span>03</span> The domain operator publishes the exact token at the proof location.</li><li><span>04</span> One bounded HTTPS fetch compares the served proof bytes.</li><li><span>05</span> The read model upgrades to Tier 3 for a 90-day validity window; publisher state stays unverified.</li><li><span>06</span> A recheck re-fetches the live proof to renew the window; any failure — or a changed card — returns the record to Tier 2.</li></ol>
          <p className="source-ops-warning">Issue a challenge only with the domain operator&rsquo;s written permission. Domain control is not publisher identity verification and must never be presented as one.</p>
        </section>
      </div>

      <div className="source-ops-grid">
        <section className="source-ops-panel">
          <div className="source-ops-panel-title">
            <div className="source-ops-icon"><FileX className="h-4 w-4" /></div>
            <div><p className="eyebrow">Census governance</p><h2>Withdraw a record</h2></div>
          </div>
          <form onSubmit={submitWithdrawal} className="source-ops-form">
            <div>
              <Label htmlFor="withdraw-agent">Served record</Label>
              <Select value={withdrawAgentId} onValueChange={setWithdrawAgentId}>
                <SelectTrigger id="withdraw-agent" className="source-ops-select">
                  <SelectValue placeholder="Select a served record" />
                </SelectTrigger>
                <SelectContent>
                  {servedRecords.map(record => (
                    <SelectItem key={record.agentId} value={record.agentId}>{record.displayName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="source-ops-help">Only a record currently served by the reviewed-run gate can be withdrawn.</p>
            </div>
            <div>
              <Label htmlFor="withdraw-reason">Reason (recorded as evidence)</Label>
              <Input id="withdraw-reason" value={withdrawReason} onChange={event => setWithdrawReason(event.target.value)} placeholder="Operator rationale for the withdrawal" required minLength={12} maxLength={1000} />
            </div>
            <Button type="submit" disabled={withdrawMutation.isPending || !withdrawAgentId}>
              {withdrawMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileX className="h-4 w-4" />}
              Withdraw from the public census
            </Button>
          </form>
        </section>

        <section className="source-ops-panel source-ops-readiness">
          <div className="source-ops-panel-title"><div className="source-ops-icon"><ShieldAlert className="h-4 w-4" /></div><div><p className="eyebrow">Scope boundary</p><h2>What withdrawal is not</h2></div></div>
          <ol><li><span>01</span> It hides one record from the served census; the source, its approved run, and every retained observation stay untouched.</li><li><span>02</span> It never deletes evidence — the decision itself is recorded as an immutable evidence event with the operator&rsquo;s reason.</li><li><span>03</span> It is reversible: a reinstate restores visibility through the reviewed-run gate.</li><li><span>04</span> It is per-record; it does not revoke a source projection and it does not merge identities.</li><li><span>05</span> It is not a quality verdict by itself; the recorded reason is the written rationale.</li><li><span>06</span> The census audit mirrors this ledger, so a withheld record never reappears in an audit run.</li></ol>
          <p className="source-ops-warning">Prefer projection revocation when an entire source is in question. Withdrawal is for a single record that must leave the public census without altering source evidence.</p>
        </section>
      </div>

      <section className="source-ops-list">
        <div className="source-ops-list-header"><div><p className="eyebrow">Registry state</p><h2>Sources and review decisions</h2></div><span>{pendingReviews.length} review{pendingReviews.length === 1 ? "" : "s"} pending</span></div>
        {sourcesQuery.isLoading ? <div className="source-ops-loading"><Loader2 className="h-4 w-4 animate-spin" /> Loading persistent source registry…</div> : sourcesQuery.error ? <div className="source-ops-loading source-ops-error">{sourcesQuery.error.message}</div> : sourcesQuery.data?.sources.length ? (
          <div className="source-ops-table-wrap"><table className="source-ops-table"><thead><tr><th>Source</th><th>Boundary</th><th>State</th><th>Freshness</th><th>Projection</th><th>Action</th></tr></thead><tbody>{sourcesQuery.data.sources.map(source => {
            const projection = projectionBySource.get(source.id);
            const latestRun = latestRunBySource.get(source.id);
            const approvedRun = approvedRunBySource.get(source.id);
            const projectionState = projection?.state ?? "review";
            const projectionClass = projectionState === "public" ? "active" : projectionState === "revoked" ? "rejected" : "review";
            const approvedRunLabel = projection?.approvedRunId ? `approved run ${projection.approvedRunId.slice(0, 8)}${approvedRun?.finishedAt ? ` · ${formatDate(approvedRun.finishedAt)}` : ""}` : "no approved run";
            return <tr key={source.id}><td><strong>{source.label}</strong><span>{protocolLabel(source.protocol)} · {source.executionPolicy === "manual_only" ? "manual only" : `every ${source.scheduleMinutes}m`}</span></td><td><code>{source.allowedHostname}</code><span>{source.failureCount} failed run{source.failureCount === 1 ? "" : "s"}</span>{source.lastError ? <span title={source.lastError}>last error: {source.lastError.slice(0, 200)}</span> : null}</td><td><span className={`source-state source-state-${source.state}`}>{source.state}</span></td><td><span>{formatDate(source.lastSuccessfulAt)}</span><span>{source.executionPolicy === "manual_only" ? "not schedulable" : `next: ${formatDate(source.nextRunAt)}`}</span></td><td><span className={`source-state source-state-${projectionClass}`}>{projectionState}</span><span>{approvedRunLabel}</span>{latestRun && latestRun.id !== projection?.approvedRunId ? <span>{latestRun.linkedRecordCount} record{latestRun.linkedRecordCount === 1 ? "" : "s"} in the latest run await review</span> : null}</td><td><div className="source-ops-actions">{source.state === "review" ? <Button size="sm" onClick={() => decideMutation.mutate({ sourceId: source.id, decision: "active", rationale: "Approved Nooscape operator pilot source." })} disabled={decideMutation.isPending}><Check className="h-3.5 w-3.5" /> Approve</Button> : null}{source.state === "active" && source.protocol !== "usdg_settlement" && source.protocol !== "erc8004_reputation" && source.protocol !== "solana_8004" && source.protocol !== "solana_said" && source.protocol !== "erc8004_bsc" ? <Button size="sm" variant="outline" onClick={() => runMutation.mutate({ sourceId: source.id })} disabled={runMutation.isPending}><Play className="h-3.5 w-3.5" /> Run once</Button> : null}{source.state === "active" && source.protocol === "erc8004" && identityWalkOffered(source.cursor, "backfill") ? <Button size="sm" variant="outline" onClick={() => runMutation.mutate({ sourceId: source.id, mode: "backfill" })} disabled={runMutation.isPending}><Undo2 className="h-3.5 w-3.5" /> Backfill window</Button> : null}{source.state === "active" && source.protocol === "erc8004" && identityWalkOffered(source.cursor, "registrants") ? <Button size="sm" variant="outline" onClick={() => runMutation.mutate({ sourceId: source.id, mode: "registrants" })} disabled={runMutation.isPending}><Database className="h-3.5 w-3.5" /> Fill registrants</Button> : null}{source.state === "active" && source.protocol === "erc8004" && identityWalkOffered(source.cursor, "activity") ? <Button size="sm" variant="outline" onClick={() => runMutation.mutate({ sourceId: source.id, mode: "activity" })} disabled={runMutation.isPending}><Activity className="h-3.5 w-3.5" /> Fill activity</Button> : null}{source.state === "active" && source.protocol === "usdg_settlement" ? <Button size="sm" variant="outline" onClick={() => runMutation.mutate({ sourceId: source.id })} disabled={runMutation.isPending}><Coins className="h-3.5 w-3.5" /> Fill settlements</Button> : null}{source.state === "active" && source.protocol === "erc8004_reputation" && reputationWalkMode(source.cursor) !== "activity" ? <Button size="sm" variant="outline" onClick={() => runMutation.mutate({ sourceId: source.id, mode: "backfill" })} disabled={runMutation.isPending}><Undo2 className="h-3.5 w-3.5" /> Backfill window</Button> : null}{source.state === "active" && source.protocol === "erc8004_reputation" && reputationWalkMode(source.cursor) !== "backfill" ? <Button size="sm" variant="outline" onClick={() => runMutation.mutate({ sourceId: source.id, mode: "activity" })} disabled={runMutation.isPending}><Star className="h-3.5 w-3.5" /> Fill ratings</Button> : null}{source.state === "active" && (source.protocol === "solana_registry" || source.protocol === "solana_said") ? <Button size="sm" variant="outline" onClick={() => runMutation.mutate({ sourceId: source.id, mode: "activity" })} disabled={runMutation.isPending}><Activity className="h-3.5 w-3.5" /> Fill chain state</Button> : null}{source.state === "active" && source.protocol === "solana_8004" ? <Button size="sm" variant="outline" onClick={() => runMutation.mutate({ sourceId: source.id, mode: "activity" })} disabled={runMutation.isPending}><Activity className="h-3.5 w-3.5" /> Run chain pass</Button> : null}{source.state === "active" && (source.protocol === "erc8004_bsc" || source.protocol === "erc8004_eth" || source.protocol === "erc8004_base" || source.protocol === "erc8004_arc") ? <Button size="sm" variant="outline" onClick={() => runMutation.mutate({ sourceId: source.id, mode: "activity" })} disabled={runMutation.isPending}><Activity className="h-3.5 w-3.5" /> Run chain pass</Button> : null}{latestRun ? <Button size="sm" variant="outline" onClick={() => setVerifySourceId(source.id)}><ShieldCheck className="h-3.5 w-3.5" /> Verify evidence</Button> : null}{source.state === "active" && latestRun && latestRun.id !== projection?.approvedRunId ? <Button size="sm" variant="outline" onClick={() => projectMutation.mutate({ sourceId: source.id, decision: "public", rationale: `Approved reviewed run ${latestRun.id.slice(0, 8)} for ${source.label}.`, runId: latestRun.id })} disabled={projectMutation.isPending}><Globe className="h-3.5 w-3.5" /> Publish reviewed run</Button> : null}{projectionState === "public" ? <Button size="sm" variant="ghost" onClick={() => projectMutation.mutate({ sourceId: source.id, decision: "revoked", rationale: `Revoked public projection for ${source.label}.` })} disabled={projectMutation.isPending}><X className="h-3.5 w-3.5" /> Revoke public</Button> : null}{source.state === "paused" ? <Button size="sm" variant="ghost" onClick={() => decideMutation.mutate({ sourceId: source.id, decision: "active", rationale: "Resumed by an operator." })} disabled={decideMutation.isPending}><Play className="h-3.5 w-3.5" /> Resume</Button> : null}{source.state === "active" ? <Button size="sm" variant="ghost" onClick={() => decideMutation.mutate({ sourceId: source.id, decision: "paused", rationale: "Paused by an operator." })} disabled={decideMutation.isPending}><Pause className="h-3.5 w-3.5" /> Pause</Button> : null}{source.state === "review" ? <Button size="sm" variant="ghost" onClick={() => decideMutation.mutate({ sourceId: source.id, decision: "rejected", rationale: "Rejected by an operator." })} disabled={decideMutation.isPending}><X className="h-3.5 w-3.5" /> Reject</Button> : null}</div></td></tr>;
          })}</tbody></table></div>
        ) : <div className="source-ops-loading">No production sources are registered. The public map remains in seed mode.</div>}
      </section>

      {verifySourceId ? (
        <section className="source-ops-list">
          <div className="source-ops-list-header">
            <div><p className="eyebrow">Evidence review</p><h2>Complete-run batch evidence review</h2></div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => void verifyQuery.refetch()} disabled={verifyQuery.isFetching}>
                {verifyQuery.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Re-run check
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setVerifySourceId(null)}><X className="h-3.5 w-3.5" /> Close</Button>
            </div>
          </div>
          {verifyQuery.isLoading ? (
            <div className="source-ops-loading"><Loader2 className="h-4 w-4 animate-spin" /> Re-reading the latest completed run&rsquo;s stored objects…</div>
          ) : verifyQuery.error ? (
            <div className="source-ops-loading source-ops-error">{verifyQuery.error.message}</div>
          ) : verifyData ? (
            <div className="source-ops-review">
              <div className="source-ops-review-summary">
                <span className={`source-state source-state-${verifyData.allHashesMatch ? "verified" : "failed"}`}>{verifyData.allHashesMatch ? "all sha-256 match" : "hash mismatch detected"}</span>
                <span className={`source-state source-state-${verifyData.allGovernanceLocked ? "verified" : "failed"}`}>{verifyData.allGovernanceLocked ? "governance lock on every object" : "retention gap detected"}</span>
                <span className={`source-state source-state-${verifyProblemChecks.length === 0 ? "verified" : "failed"}`}>{verifyProblemChecks.length === 0 ? "zero problem entries" : `${verifyProblemChecks.length} problem ${verifyProblemChecks.length === 1 ? "entry" : "entries"}`}</span>
              </div>
              <dl className="source-ops-review-meta">
                <div><dt>Source</dt><dd><strong>{verifyData.source.label}</strong><code>{verifyData.source.hostname}</code></dd></div>
                <div><dt>Run</dt><dd>{verifyData.run ? <><code>{verifyData.run.id.slice(0, 8)}</code><span>{verifyData.run.trigger} · finished {formatDate(verifyData.run.finishedAt)}</span></> : <span>No completed run record.</span>}</dd></div>
                <div><dt>Run window</dt><dd>{verifyData.run ? `${verifyData.run.discoveredCount} discovered · ${verifyData.run.acceptedCount} accepted · ${verifyData.run.rejectedCount} rejected` : "Not available"}</dd></div>
                <div><dt>Objects checked</dt><dd>{verifyData.count}<span>retained observations of this run</span></dd></div>
                <div><dt>Earliest retain until</dt><dd>{verifyEarliestRetainUntil ? formatDate(verifyEarliestRetainUntil) : "No retention date found"}</dd></div>
              </dl>
              <div className="source-ops-review-checks">
                <table className="source-ops-table">
                  <thead><tr><th>Agent</th><th>Canonical locator</th><th>Integrity</th><th>Retention</th><th>Retain until</th></tr></thead>
                  <tbody>
                    {verifyData.checks.map(check => (
                      <tr key={check.observationId}>
                        <td><strong>{check.agentId ? agentNameById.get(check.agentId)?.displayName ?? `agent ${check.agentId.slice(0, 8)}` : "unbound observation"}</strong><span>observation {check.observationId.slice(0, 8)}</span></td>
                        <td><code className="source-ops-proof-url" title={check.canonicalLocator}>{check.canonicalLocator}</code></td>
                        <td><span className={`source-state source-state-${check.hashMatches ? "verified" : "failed"}`}>{check.hashMatches ? "sha-256 ok" : "mismatch"}</span><span>{check.byteLength.toLocaleString()} bytes</span></td>
                        <td><span className={`source-state source-state-${check.retentionMode === "GOVERNANCE" && check.retainUntil ? "verified" : "failed"}`}>{check.retentionMode ?? "none"}</span></td>
                        <td><span>{check.retainUntil ? formatDate(check.retainUntil) : "missing"}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {verifyProblemChecks.length ? (
                <p className="source-ops-review-note">Problem entries are flagged in the Integrity and Retention columns. Do not publish this run until every check passes.</p>
              ) : (
                <p className="source-ops-review-note">Read-only check: the complete latest completed run was re-read server-side — every stored object&rsquo;s SHA-256 recomputed and its Object Lock retention read. Nothing was written, and public projection stays a separate explicit decision.</p>
              )}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="source-ops-list">
        <div className="source-ops-list-header"><div><p className="eyebrow">Tier 3 pathway</p><h2>Domain verification challenges</h2></div><span>{pendingChallenges.length} pending</span></div>
        {challengesQuery.isLoading ? <div className="source-ops-loading"><Loader2 className="h-4 w-4 animate-spin" /> Loading challenge ledger…</div> : challengesQuery.error ? <div className="source-ops-loading source-ops-error">{challengesQuery.error.message}</div> : challengesQuery.data?.challenges.length ? (
          <div className="source-ops-table-wrap"><table className="source-ops-table"><thead><tr><th>Agent</th><th>Domain and proof</th><th>State</th><th>Window</th><th>Action</th></tr></thead><tbody>{challengesQuery.data.challenges.map(challenge => {
            const state = challengeState(challenge.state, challenge.expiresAt, challenge.verificationExpiresAt, challenge.revokedAt);
            const agent = agentNameById.get(challenge.agentId);
            const verificationActive = challenge.state === "verified" && !challenge.revokedAt;
            return <tr key={challenge.id}><td><strong>{agent?.displayName ?? "Unknown agent"}</strong><span>{agent?.handle ?? challenge.agentId}</span></td><td><code>{challenge.domain}</code><span className="source-ops-proof-url" title={challenge.proofUrl}>{challenge.proofUrl}</span></td><td><span className={`source-state source-state-${state}`}>{state}</span>{challenge.proofHash ? <span>proof sha-256 {challenge.proofHash.slice(0, 12)}…</span> : null}{challenge.cardPinStatus ? <span>{cardPinStatusLabel(challenge.cardPinStatus)}</span> : null}</td><td><span>issued {formatDate(challenge.createdAt)}</span>{challenge.revokedAt ? <span>revoked {formatDate(challenge.revokedAt)}</span> : challenge.verifiedAt ? <span>verified {formatDate(challenge.verifiedAt)} · valid until {formatDate(challenge.verificationExpiresAt)}{challenge.recheckedAt ? ` · rechecked ${formatDate(challenge.recheckedAt)}` : ""}</span> : <span>{state === "expired" ? "expired" : "expires"} {formatDate(challenge.expiresAt)}</span>}</td><td><div className="source-ops-actions">{state === "pending" ? <Button size="sm" onClick={() => verifyChallengeMutation.mutate({ challengeId: challenge.id })} disabled={verifyChallengeMutation.isPending}><ShieldCheck className="h-3.5 w-3.5" /> Verify now</Button> : null}{verificationActive ? <Button size="sm" variant="outline" onClick={() => recheckMutation.mutate({ challengeId: challenge.id })} disabled={recheckMutation.isPending}><RefreshCw className="h-3.5 w-3.5" /> Recheck</Button> : null}</div></td></tr>;
          })}</tbody></table></div>
        ) : <div className="source-ops-loading">No domain verification challenges have been issued. Tier 3 upgrades begin with a consenting domain operator.</div>}
      </section>

      <section className="source-ops-list">
        <div className="source-ops-list-header"><div><p className="eyebrow">Census governance</p><h2>Withdrawn records</h2></div><span>{withdrawalsQuery.data?.withdrawals.length ?? 0} withdrawn</span></div>
        {withdrawalsQuery.isLoading ? <div className="source-ops-loading"><Loader2 className="h-4 w-4 animate-spin" /> Loading the withdrawal ledger…</div> : withdrawalsQuery.error ? <div className="source-ops-loading source-ops-error">{withdrawalsQuery.error.message}</div> : withdrawalsQuery.data?.withdrawals.length ? (
          <div className="source-ops-table-wrap"><table className="source-ops-table"><thead><tr><th>Record</th><th>Reason</th><th>Withdrawn</th><th>Action</th></tr></thead><tbody>{withdrawalsQuery.data.withdrawals.map(withdrawal => (
            <tr key={withdrawal.agentId}><td><strong>{withdrawal.displayName}</strong><span>{withdrawal.handle ?? withdrawal.agentId}</span></td><td><span>{withdrawal.reason}</span></td><td><span>{formatDate(withdrawal.decidedAt)}</span></td><td><div className="source-ops-actions"><Button size="sm" variant="outline" onClick={() => reinstateMutation.mutate({ agentId: withdrawal.agentId, reason: "Reinstated after operator review." })} disabled={reinstateMutation.isPending}><Undo2 className="h-3.5 w-3.5" /> Reinstate</Button></div></td></tr>
          ))}</tbody></table></div>
        ) : <div className="source-ops-loading">No records are withdrawn. Every gated record is served.</div>}
      </section>
      <OperatorClaims />
      <OperatorKeys />
      <OperatorPayments />
    </main>
  );
}
