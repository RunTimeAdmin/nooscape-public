import type { CSSProperties } from "react";
import { Link } from "wouter";
import { FLEET_NOT_PROVED, ROBINHOOD_LIGHT_MIN, ROBINHOOD_NOT_PROVED } from "@shared/mapFleets";
import { FLEET_MIN } from "@shared/noosphere";
import { CHAIN_GROUP_REPORT, formatObserved, type RegistrationShareFigures } from "@/lib/chainExplorerModel";

type Props = {
  /** Whose wallets these are. Robinhood Chain's are counted against the entries the directory lists, Arc's against every registration the registry holds. */
  chain: "robinhood" | "arc";
  share: RegistrationShareFigures;
  /** When the directory was read for the wallets and the count (ISO 8601). */
  asOf: string | null;
  selectedId: string | null;
  /** Selects the formation of a wallet, by the id the world gives it. */
  onSelect: (id: string) => void;
};

/**
 * What the Robinhood Chain page leads with: how much of the directory's list of entries a few registering wallets are recorded against, as
 * a bar and a row of wallets. One figure from one read (the wallets and the count are taken together). It is a count of entries by the
 * address that registered them, and the page says what that does not show. The Arc page has the same block over the registrations its
 * registry holds, listed or not, because on Arc the wallets that registered most are the ones the listing rules hold out.
 */
export function RegistrationShare({ chain, share, asOf, selectedId, onSelect }: Props) {
  const when = formatObserved(asOf);
  const idOf = (segmentId: string) => `group:${segmentId}`;
  const arc = chain === "arc";
  const census = arc ? CHAIN_GROUP_REPORT.arc : CHAIN_GROUP_REPORT.robinhood;
  const minimum = arc ? FLEET_MIN : ROBINHOOD_LIGHT_MIN;
  return (
    <section className="cw-share" aria-labelledby="cw-share-heading">
      <p className="cw-small-label">{arc ? "WHO REGISTERED ON ARC" : "WHO REGISTERED THE ENTRIES"}</p>
      <h2 id="cw-share-heading" className="cw-share-headline">
        <strong>{share.percent} percent</strong> of the {share.listed.toLocaleString("en-US")} {arc ? "registrations on Arc" : "entries the directory lists on Robinhood Chain"} are recorded against {share.complete ? "" : "the "}
        {share.wallets} {share.complete ? "registering" : "largest registering"} {share.wallets === 1 ? "wallet" : "wallets"}.
      </h2>
      {/* The bar is a picture of the legend below it, which holds the controls. */}
      <div className="cw-share-bar" aria-hidden="true">
        {share.segments.map((segment, index) => (
          <button
            key={segment.id}
            type="button"
            tabIndex={-1}
            className="cw-share-segment"
            data-selected={selectedId === idOf(segment.id) ? "true" : undefined}
            style={{ flexGrow: segment.count, "--cw-shade": `${100 - index * 9}%` } as CSSProperties}
            onClick={() => onSelect(idOf(segment.id))}
          />
        ))}
        {share.rest > 0 && <span className="cw-share-rest" style={{ flexGrow: share.rest }} />}
      </div>
      <ul className="cw-share-legend" aria-label="Wallets, largest first">
        {share.segments.map((segment, index) => {
          const selected = selectedId === idOf(segment.id);
          return (
            <li key={segment.id}>
              <button type="button" className="cw-share-chip" aria-pressed={selected} onClick={() => onSelect(idOf(segment.id))} title={segment.wallet ?? undefined}>
                <span className="cw-share-swatch" style={{ "--cw-shade": `${100 - index * 9}%` } as CSSProperties} aria-hidden="true" />
                <span>{segment.label.replace(/^Wallet /, "")}</span>
                <span className="cw-share-count">{segment.count.toLocaleString("en-US")}</span>
                <span className="cw-share-percent">{segment.percent}%</span>
              </button>
            </li>
          );
        })}
        {share.rest > 0 && (
          <li className="cw-share-other">
            <span className="cw-share-swatch cw-share-swatch-rest" aria-hidden="true" />
            <span>Every other wallet</span>
            <span className="cw-share-count">{share.rest.toLocaleString("en-US")}</span>
          </li>
        )}
      </ul>
      <p className="cw-share-note">
        {arc ? FLEET_NOT_PROVED.wallet : ROBINHOOD_NOT_PROVED} Shares are of the {arc ? "registrations the registry holds, listed or not" : "entries the directory lists"}{when ? `, as ${arc ? "the registry" : "it"} held them at ${when}` : ""}.
        {share.rest > 0
          ? share.complete
            ? ` The other ${share.rest.toLocaleString("en-US")} are recorded against wallets with fewer than ${minimum} each.`
            : ` The other ${share.rest.toLocaleString("en-US")} are recorded against every other wallet.`
          : ""}
        {census && (
          <>
            {" "}
            A dated count of the whole registry: <Link href={census.href} className="cw-share-link">{census.label}</Link>.
          </>
        )}
      </p>
    </section>
  );
}
