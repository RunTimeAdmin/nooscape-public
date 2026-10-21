import { Term } from "@/components/Term";
import { CountUp } from "./CountUp";
import { fleetCards, shortWallet, type FleetWallet } from "./noiseModel";

type Props = {
  wallets: readonly FleetWallet[];
  status: "loading" | "ready" | "unavailable";
};

/**
 * The registering wallets behind the most identities, as cards. "Registering wallet"
 * is the wording on purpose: a wallet here is the one a registry records against an
 * identity, which for ERC-8004 paid the registration, and it is never a verified
 * operator or a rating. The host line is a hint about where the identities point, as
 * recorded, and it is absent when no host dominates.
 */
/** On a phone the cards stack, so only the six with the longest lists show; from 640 pixels all twelve do. */
const PHONE_CARDS = 6;

export function FleetCards({ wallets, status }: Props) {
  const cards = fleetCards(wallets);
  return (
    <section aria-labelledby="fleet-heading" className="flex h-full flex-col rounded-2xl border border-white/[.1] bg-[#090D10]/80 p-5">
      <div data-owl-avoid="" className="max-w-3xl">
        <p className="eyebrow"><Term k="fleetSightings">Fleet sightings</Term></p>
        <h2 id="fleet-heading" className="mt-2 text-xl tracking-[-.04em] text-[#F1FFF3]">Same wallet, many faces</h2>
      </div>
      <p data-owl-avoid="" className="mt-2 max-w-2xl text-sm leading-6 text-ns-ink-dim">
        Grouped by <Term k="registrant">registering wallet</Term> today, with more signals to come; a long list is worth a look, not a verdict.
      </p>
      {status === "ready" && cards.length > 0 ? (
        <ul data-owl-avoid="" className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Registering wallets, largest first">
          {cards.map((card, index) => (
            <li key={card.registrant} className={`min-w-0 rounded-xl border border-[#C3A6FF]/20 bg-[#C3A6FF]/[0.04] p-4 ${index >= PHONE_CARDS ? "hidden sm:block" : ""}`}>
              <p className="font-mono text-xs text-[#D8C6FF]" title={card.registrant}>
                <span aria-hidden="true">{shortWallet(card.registrant)}</span>
                <span className="sr-only">{card.registrant}</span>
              </p>
              <p className="mt-2 flex items-baseline gap-2">
                <strong className="font-mono text-2xl leading-none tracking-[-.04em] text-[#F2FFF5]"><CountUp value={card.agentCount} /></strong>
                <span className="text-xs text-[#A9B8AE]">{card.agentCount === 1 ? "identity" : "identities"} recorded</span>
              </p>
              <div className="fleet-track" aria-hidden="true">
                <div className="fleet-fill" style={{ width: `${card.share}%` }} />
              </div>
              {card.dominantHost && <p className="mt-2 truncate font-mono text-xs text-[#819588]">mostly pointing at {card.dominantHost}</p>}
            </li>
          ))}
        </ul>
      ) : (
        <p data-owl-avoid="" className="mt-4 rounded-xl border border-white/[.08] bg-black/20 px-3.5 py-3 text-xs leading-5 text-[#8FA196]">
          {status === "loading" ? "Reading the wallet counts…" : "No wallet counts can be shown right now. Nothing is drawn in their place."}
        </p>
      )}
      <p data-owl-avoid="" className="mt-auto pt-3 text-xs leading-5 text-ns-ink-dim">
        Most ERC-8004 identities were handed out to other wallets soon after minting, so this shows who registered, not who holds or runs them.
      </p>
    </section>
  );
}
