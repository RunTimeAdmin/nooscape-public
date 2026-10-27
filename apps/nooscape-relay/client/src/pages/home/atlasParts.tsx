// The pieces of the field that the full field page and Deep Space both draw. Loaded with whichever of them is asked for first.
import { type CSSProperties, useEffect, useState } from "react";
import { EvidenceAsOf } from "@/components/home/EvidenceAsOf";
import type { PublisherState } from "@/lib/evidenceReadout";
import { DUST_PARTICLE_LIMIT } from "@/lib/topology";
import { cn } from "@/lib/utils";
import { BadgeCheck, Check, CircleDot, Clock3, Fingerprint, Radio, ShieldX } from "lucide-react";
import { type AtlasAgent, type EvidenceEnvelope, type IngestionEvent, type PublisherValidation, formatObservedTime, publisherStateMeta, tones } from "./atlasModel";

export function LiveEvidenceFeed({ evidence, loading, asOf }: { evidence: EvidenceEnvelope | undefined; loading: boolean; asOf: number | null }) {
  const verification = useEvidenceVerification(evidence);
  return <section className="live-evidence-feed"><div className="live-evidence-header"><span><Radio size={13} /> Live evidence relay</span><em>{verification === "verified" ? "integrity confirmed" : loading ? "refreshing" : "awaiting envelope"}</em></div><EvidenceAsOf at={asOf} />{evidence?.entries.slice(0, 3).map(entry => <div key={entry.id} className="live-evidence-row"><i /><div><strong>{entry.event}</strong><span>{formatObservedTime(entry.observedAt)} · {entry.source}</span></div><Check size={13} /></div>)}{evidence && <EvidenceIntegrity evidence={evidence} verification={verification} compact />}</section>;
}

export function EvidenceIntegrity({ evidence, verification, compact = false }: { evidence: EvidenceEnvelope; verification: "checking" | "verified" | "mismatch" | "unavailable"; compact?: boolean }) {
  return <div className={cn("evidence-integrity", compact && "evidence-integrity-compact")}><span>{verification === "verified" ? <Check size={12} /> : <Fingerprint size={12} />}{evidence.signatureAlgorithm} signed · seq {evidence.sequence}</span><code>{evidence.integrityHash.slice(0, compact ? 14 : 24)}…</code><em>{evidence.algorithm} digest · {evidence.relayMode}</em></div>;
}

export function useEvidenceVerification(evidence: EvidenceEnvelope | undefined) {
  const [status, setStatus] = useState<"checking" | "verified" | "mismatch" | "unavailable">("unavailable");
  useEffect(() => {
    if (!evidence || !window.crypto?.subtle) { setStatus("unavailable"); return; }
    let active = true;
    setStatus("checking");
    window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(evidence.canonicalPayload)).then(buffer => {
      const actual = Array.from(new Uint8Array(buffer)).map(byte => byte.toString(16).padStart(2, "0")).join("");
      if (active) setStatus(actual === evidence.integrityHash ? "verified" : "mismatch");
    }).catch(() => { if (active) setStatus("unavailable"); });
    return () => { active = false; };
  }, [evidence]);
  return status;
}

export function PublisherStateIcon({ state, size = 13 }: { state: PublisherState; size?: number }) {
  if (state === "allowlisted") return <BadgeCheck size={size} />;
  if (state === "expired") return <Clock3 size={size} />;
  if (state === "revoked") return <ShieldX size={size} />;
  return <CircleDot size={size} />;
}

export function PublisherBadge({ validation, compact = false }: { validation: PublisherValidation; compact?: boolean }) {
  const meta = publisherStateMeta[validation.status];
  const source = validation.publisherName ?? meta.detail;
  return <span className={cn("publisher-state-badge", `publisher-state-${validation.status}`, compact && "publisher-state-badge-compact")} title={`${meta.label}: ${source}${validation.publicKeyFingerprint ? ` · ${validation.publicKeyFingerprint}` : ""}`}><PublisherStateIcon state={validation.status} size={compact ? 12 : 14} /><span>{compact ? meta.label : `Publisher ${meta.label.toLowerCase()}`}</span>{!compact && <em>{source}</em>}</span>;
}

// Ambient background representation for records outside the featured crew.
// Count is bounded by DUST_PARTICLE_LIMIT and drift animates transform only,
// so the dust never triggers layout or competes with the interactive bots.
export function FieldDust({ agents }: { agents: readonly AtlasAgent[] }) {
  const motes = agents.slice(0, DUST_PARTICLE_LIMIT);
  if (motes.length === 0) return null;
  return <div className="field-dust" aria-hidden="true">{motes.map(agent => {
    let hash = 11;
    for (const character of agent.id) hash = (hash * 33 + character.charCodeAt(0)) >>> 0;
    return <span
      key={agent.id}
      className="dust-mote"
      style={{
        "--tone": tones[agent.capability] ?? "#BFFF76",
        left: `${agent.position.x}%`,
        top: `${agent.position.y}%`,
        "--delay": `${(hash % 90) / 10}s`,
        "--drift": `${((hash >> 3) % 14) - 7}px`,
        opacity: 0.2 + ((hash >> 5) % 5) / 10,
      } as CSSProperties}
    />;
  })}</div>;
}

export function IngressNode({ event, deep = false, sceneWidth = 0 }: { event: IngestionEvent; deep?: boolean; sceneWidth?: number }) {
  // The label goes beside the node on the side with more room and is cut to fit. Where the map's width is not known (the Deep map), it goes to the left on the right of the map.
  const x = (event.position.x / 100) * sceneWidth;
  const roomRight = sceneWidth - x - 30;
  const roomLeft = x - 30;
  const flip = sceneWidth > 0 ? roomRight < 200 && roomLeft > roomRight : event.position.x > 55;
  const labelWidth = sceneWidth > 0 ? Math.min(220, Math.max(105, Math.floor(flip ? roomLeft : roomRight))) : undefined;
  return <div key={event.id} className={cn("ingress-node", deep && "ingress-node-deep", flip && "ingress-node-flip")} style={{ left: `${event.position.x}%`, top: `${event.position.y}%`, "--ingress-tone": event.tone } as CSSProperties}><span className="ingress-trail" /><span className="ingress-core" /><span className="ingress-label" style={labelWidth ? { maxWidth: labelWidth } : undefined}><strong>{event.agent}</strong><em>NEW / {event.protocol}</em></span></div>;
}

export function SignalCell({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="signal-cell"><span>{label}</span><strong className={mono ? "font-mono" : ""}>{value}</strong></div>;
}
