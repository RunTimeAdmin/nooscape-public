import { Link } from "wouter";
import { Term } from "@/components/Term";
import { FLEET_OVERLAP_NOTE, fleetFact, fleetKindLabel, fleetNotProved, fleetOverlapNote, shortWallet } from "@shared/mapFleets";
import { publisherStateExplanations, tierExplanations } from "@/lib/evidenceExplain";
import { CHAIN_STYLE, chainStyleKey, isAcknowledged, isFleet, markerPath, tierColor, type ConstellationNode, type EvidenceState, type SelectionKind } from "./constellationModel";

type Props = {
  node: ConstellationNode | null;
  evidence: EvidenceState;
  /** Why this record is on the card: pinned by the visitor, under the scan, or where the map opens. */
  kind?: SelectionKind | null;
  onUnpin?: () => void;
};

const EYEBROW: Record<SelectionKind, string> = { pinned: "Pinned record", scanned: "Reviewed record", featured: "Where the map opens" };
/** What an acknowledged entry is, in place of a tier and its sentence: the directory lists it, and Nooscape has not reviewed it. */
const ACKNOWLEDGED_SENTENCE = "The directory lists this registration, and the map shows it as one of a fixed sample picked by a rule that ignores quality. Nooscape has not reviewed it and holds no evidence tier for it. Acknowledgement is never endorsement.";

/**
 * What Nooscape holds about the selected record, and nothing it does not. The tier is the record's own reviewed
 * tier with its matching sentence; the rest is read from the signed evidence envelope. There is no score, and no
 * verdict on whether the agent is any good.
 */
export function CheckCard({ node, evidence, kind = "scanned", onUnpin }: Props) {
  if (!node) {
    return (
      <div data-owl-avoid="" className="rounded-2xl border border-white/[0.09] bg-[#090D10]/85 p-5">
        <p className="font-mono text-xs uppercase tracking-[.17em] text-ns-ink-dim">Check card</p>
        <p className="mt-3 text-sm leading-6 text-[#A9B8AE]">No reviewed records are available right now, so there is nothing to select.</p>
      </div>
    );
  }
  if (isFleet(node)) return <FleetCard node={node} kind={kind} onUnpin={onUnpin} />;
  const acknowledged = isAcknowledged(node);
  const tier = tierExplanations[node.tier];
  const chain = CHAIN_STYLE[chainStyleKey(node)];
  return (
    <div data-owl-avoid="" className="rounded-2xl border bg-[#090D10]/85 p-5" style={{ borderColor: `${tierColor(node.tier)}55` }}>
      {/* The font is set on the row because a button takes its font from its parent: index.css resets it with an unlayered rule that beats any utility on the button itself. */}
      <div className="flex items-start justify-between gap-3 font-mono text-xs">
        <p className="uppercase tracking-[.17em]" style={{ color: tierColor(node.tier) }}>
          {acknowledged ? (kind === "pinned" ? "Pinned entry" : "Acknowledged, not reviewed") : EYEBROW[kind ?? "scanned"]}
        </p>
        {kind === "pinned" && onUnpin && (
          <button type="button" onClick={onUnpin} className="-m-2 min-h-11 rounded-full px-3 uppercase tracking-[.12em] text-ns-ink-dim hover:text-ns-ink focus-visible:text-ns-ink">
            Unpin
          </button>
        )}
      </div>
      <h3 className="mt-2 text-lg font-medium leading-6 text-[#F2FFF5]">{node.name}</h3>
      <p className="font-mono text-xs text-ns-ink-dim">{acknowledged ? `${node.handle || "no link host recorded"} · ${node.protocol}` : `${node.handle} · ${node.protocol}`}</p>
      {kind === "featured" && (
        <p className="mt-2 text-xs leading-5 text-ns-ink-dim">Shown first because it has the highest evidence tier on this map. It is where to start, not an endorsement.</p>
      )}

      <div className="mt-4">
        <p className="font-mono text-xs uppercase tracking-[.14em] text-ns-ink-dim">
          {acknowledged ? <Term k="acknowledgement">Acknowledged</Term> : <Term k="tier">Evidence tier</Term>}
        </p>
        <p className="mt-1 text-sm font-medium text-[#DFFFF0]">{acknowledged ? "Not reviewed, no evidence tier" : (tier?.label ?? node.tier)}</p>
        {acknowledged ? <p className="mt-1 text-xs leading-5 text-[#A9B8AE]">{ACKNOWLEDGED_SENTENCE}</p> : tier && <p className="mt-1 text-xs leading-5 text-[#A9B8AE]">{tier.sentence}</p>}
      </div>

      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-t border-white/[0.08] pt-4 font-mono text-xs">
        <dt className="text-ns-ink-dim">Chain</dt>
        <dd className="flex items-center gap-2 text-[#DFFFF0]">
          <svg aria-hidden="true" viewBox="-1.5 -1.5 3 3" className="size-3 shrink-0">
            {/* Hollow for an acknowledged entry, as on the map. */}
            <path d={markerPath(chain.shape)} fill={acknowledged ? "none" : chain.color} stroke={acknowledged ? chain.color : "none"} strokeWidth={0.35} />
          </svg>
          {chain.label}
        </dd>
        {acknowledged ? null : evidence.status === "ready" ? (
          <>
            <dt className="text-ns-ink-dim">Publisher</dt>
            <dd className="text-[#DFFFF0]" title={publisherStateExplanations[evidence.publisher]}>{evidence.publisher}</dd>
            <dt className="text-ns-ink-dim">Observations</dt>
            <dd className="text-[#DFFFF0]">{evidence.observations} retained</dd>
            {evidence.provenance && (
              <>
                <dt className="text-ns-ink-dim">Provenance</dt>
                <dd className="text-[#DFFFF0]">{evidence.provenance}</dd>
              </>
            )}
            {evidence.source && (
              <>
                <dt className="text-ns-ink-dim">Source</dt>
                <dd className="break-words text-[#DFFFF0]">{evidence.source}</dd>
              </>
            )}
          </>
        ) : (
          <dd className="col-span-2 text-ns-ink-dim">{evidence.status === "unavailable" ? "The signed evidence could not be read right now." : "Reading the signed evidence…"}</dd>
        )}
      </dl>

      <Link href={`/agents/${encodeURIComponent(node.id)}`} className="mt-5 inline-flex min-h-11 items-center gap-1 font-mono text-xs uppercase tracking-[.12em] text-[#BFFF76] hover:underline">
        {acknowledged ? "View entry →" : "View record →"}
      </Link>
    </div>
  );
}

/**
 * What a fleet light stands for, and nothing it does not: a group of BNB Chain registrations that share one fact, or the
 * registrations one owner wallet holds on Solana, with its count, the same fact said in words, and what that fact does not show. It is a group and not an agent, so there is no
 * tier, no evidence and no record to link to, and the words never grade.
 */
function FleetCard({ node, kind, onUnpin }: { node: ConstellationNode; kind: SelectionKind | null; onUnpin?: () => void }) {
  const fleet = node.fleet;
  const chain = CHAIN_STYLE[chainStyleKey(node)];
  return (
    <div data-owl-avoid="" className="rounded-2xl border bg-[#090D10]/85 p-5" style={{ borderColor: `${chain.color}55` }}>
      <div className="flex items-start justify-between gap-3 font-mono text-xs">
        <p className="uppercase tracking-[.17em]" style={{ color: chain.color }}>
          {kind === "pinned" ? "Pinned group" : "Group of registrations"}
        </p>
        {kind === "pinned" && onUnpin && (
          <button type="button" onClick={onUnpin} className="-m-2 min-h-11 rounded-full px-3 uppercase tracking-[.12em] text-ns-ink-dim hover:text-ns-ink focus-visible:text-ns-ink">
            Unpin
          </button>
        )}
      </div>
      <h3 className="mt-2 break-words text-lg font-medium leading-6 text-[#F2FFF5]" title={fleet?.wallet ?? undefined}>{node.name}</h3>
      <p className="font-mono text-xs text-ns-ink-dim">{fleet ? `${fleetKindLabel(fleet)}${fleet.name && (fleet.kind === "shared_link" || fleet.kind === "template") ? " · the name they record" : ""}` : node.handle}</p>
      {fleet && (
        <p className="mt-3 flex items-baseline gap-2">
          <strong className="font-mono text-2xl leading-none tracking-[-.04em] text-[#F2FFF5]">{fleet.count.toLocaleString("en-US")}</strong>
          <span className="text-xs text-[#A9B8AE]">registrations</span>
        </p>
      )}
      {fleet && <p className="mt-3 text-sm leading-6 text-[#DFFFF0]">{fleetFact(fleet)}</p>}
      <div className="mt-4 border-t border-white/[0.08] pt-4">
        <p className="font-mono text-xs uppercase tracking-[.14em] text-ns-ink-dim">What this does not show</p>
        <p className="mt-1 text-xs leading-5 text-[#A9B8AE]">{fleet ? fleetNotProved(fleet) : ""}</p>
        <p className="mt-2 text-xs leading-5 text-[#A9B8AE]">A group is not an agent and is not reviewed. Nooscape holds no evidence tier for it and draws none of its registrations. {fleet ? fleetOverlapNote(fleet) : FLEET_OVERLAP_NOTE}</p>
      </div>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-t border-white/[0.08] pt-4 font-mono text-xs">
        <dt className="text-ns-ink-dim">Chain</dt>
        <dd className="flex items-center gap-2 text-[#DFFFF0]">
          <svg aria-hidden="true" viewBox="-1.5 -1.5 3 3" className="size-3 shrink-0">
            {fleet?.chain === "base" ? <path d={markerPath("cross")} fill="none" stroke={chain.color} strokeWidth={0.35} /> : fleet?.chain === "ethereum" ? <path d={markerPath("pentagon")} fill="none" stroke={chain.color} strokeWidth={0.35} /> : fleet?.chain === "arc" ? <path d={markerPath("dome")} fill="none" stroke={chain.color} strokeWidth={0.35} /> : fleet?.chain === "solana" ? <path d={markerPath("diamond")} fill="none" stroke={chain.color} strokeWidth={0.35} /> : fleet?.chain === "robinhood" ? <path d="M0 -1.25L1.08 -0.625L1.08 0.625L0 1.25L-1.08 0.625L-1.08 -0.625Z" fill="none" stroke={chain.color} strokeWidth={0.35} /> : <circle r="1.2" fill="none" stroke={chain.color} strokeWidth={0.35} />}
          </svg>
          {chain.label}
        </dd>
        {fleet?.wallet && (
          <>
            <dt className="text-ns-ink-dim">{fleet.chain === "solana" ? "Owner wallet" : fleet.chain === "robinhood" || fleet.chain === "arc" || fleet.chain === "base" || fleet.chain === "ethereum" ? "Registering wallet" : "Wallet"}</dt>
            <dd className="break-all text-[#DFFFF0]" title={fleet.wallet}>
              <span aria-hidden="true">{shortWallet(fleet.wallet)}</span>
              <span className="sr-only">{fleet.wallet}</span>
            </dd>
          </>
        )}
        {fleet && fleet.wallets !== null && fleet.kind !== "wallet" && (
          <>
            <dt className="text-ns-ink-dim">Wallets</dt>
            <dd className="text-[#DFFFF0]">{fleet.wallets.toLocaleString("en-US")} registered them</dd>
          </>
        )}
      </dl>
      {fleet && (
        <Link href={`/chains/${fleet.chain}`} className="mt-4 inline-flex min-h-11 items-center gap-2 text-sm text-[#DFFFF0] underline underline-offset-4 hover:text-white">
          Open the {chain.label} page <span aria-hidden="true">&rarr;</span>
        </Link>
      )}
    </div>
  );
}
