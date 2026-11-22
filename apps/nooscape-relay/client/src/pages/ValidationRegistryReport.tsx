import { InfoPage, headingClass, linkClass, listClass, textClass } from "@/components/InfoPage";
import { DERIVED as d, DOC, EARLIER, MEASURED, REGISTRY, RUN, SCRIPT } from "@/lib/validationRegistryReport";

/**
 * A dated count of the ERC-8004 Validation Registry on every chain that has it, read from the chains' own logs. It is a report, not a
 * directory: it lists no agent, ranks nothing, names no wallet or validator and gives no score. Every number on it comes from
 * lib/validationRegistryReport.ts, and pages/validationRegistryReport.test.ts fails if one does not.
 *
 * A chain that could not be read says so and gives no figure: not read is never the same as none.
 */
const n = (value: number) => value.toLocaleString("en-US");
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** 2026-11-20 as "20 November 2026". */
const longDate = (iso: string) => {
  const [year, month, day] = iso.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
};
/** A list of words as part of a sentence: "a", "a and b", "a, b and c". */
const and = (items: readonly string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

const cellClass = "border-b border-white/[.08] py-2.5 pr-4 align-top";
const numberClass = "border-b border-white/[.08] py-2.5 pr-4 text-right align-top font-mono tabular-nums text-ns-ink";
const headClass = "border-b border-white/[.16] py-2 pr-4 text-right font-medium";
const firstHeadClass = "border-b border-white/[.16] py-2 pr-4 font-medium";
const tableClass = "w-full min-w-[40rem] border-collapse text-left text-sm leading-6 text-ns-ink-dim";
const codeClass = "break-all font-mono text-sm text-ns-ink";

export default function ValidationRegistryReport() {
  const counted = [`${n(d.read)} were read in full`, d.notRead > 0 ? `${n(d.notRead)} could not be read` : ""].filter(Boolean);
  return (
    <InfoPage title="Validation Registry census, 2026-11-20" eyebrow={`Field note, ${longDate(RUN.date)}`} heading="The Validation Registry, counted">
      <p className={textClass}>
        ERC-8004 has three registries. The Validation Registry is where an agent&apos;s owner names a validator and asks it to check the
        agent&apos;s work, and where the validator answers. This note counts what has been written to it, on the chains Nooscape asked. It
        lists no agent, ranks nothing, names no wallet and gives no score.
      </p>

      <section aria-labelledby="vr-what">
        <h2 id="vr-what" className={headingClass}>What was counted</h2>
        <p className={textClass}>
          The registry has one address, the same on every chain that has it: <code className={codeClass}>{REGISTRY.address}</code>. On{" "}
          {longDate(RUN.date)} Nooscape read each chain&apos;s own logs for that address, from {longDate(RUN.from)} to the newest block, with no
          filter. A request is a ValidationRequest event: an owner naming a validator for one of its agents. A response is a
          ValidationResponse event: a validator answering a request. Only the events were read. No request document was fetched, and no
          validator was called.
        </p>
        <p className={textClass}>
          {n(d.asked)} chains were asked. {n(d.withRegistry)} have the registry at that address: {and(counted)}.
          {d.noRegistry > 0 ? ` ${n(d.noRegistry)} ${d.noRegistry === 1 ? "has" : "have"} no registry there.` : ""} A chain that is not in the table was not asked.
        </p>
      </section>

      <section aria-labelledby="vr-counts">
        <h2 id="vr-counts" className={headingClass}>Requests and responses, by chain</h2>
        <div className="mt-4 overflow-x-auto">
          <table className={tableClass}>
            <caption className="sr-only">Requests and responses at the Validation Registry, by chain, read on {longDate(RUN.date)}</caption>
            <thead>
              <tr className="text-ns-ink">
                <th scope="col" className={firstHeadClass}>Chain</th>
                <th scope="col" className={headClass}>Requests</th>
                <th scope="col" className={headClass}>Responses</th>
                <th scope="col" className={headClass}>Agents asked</th>
                <th scope="col" className={headClass}>Validators named</th>
                <th scope="col" className={headClass}>Validator was owner</th>
                <th scope="col" className={headClass}>Last event</th>
              </tr>
            </thead>
            <tbody>
              {MEASURED.map(row => (
                <tr key={row.key}>
                  <th scope="row" className={`${cellClass} font-normal text-ns-ink`}>{row.label}</th>
                  {row.status === "read" && row.ownerAtRequest ? (
                    <>
                      <td className={numberClass}>{n(row.requests ?? 0)}</td>
                      <td className={numberClass}>{n(row.responses ?? 0)}</td>
                      <td className={numberClass}>{n(row.agentsAsked ?? 0)}</td>
                      <td className={numberClass}>{n(row.validatorsNamed ?? 0)}</td>
                      <td className={numberClass}>{row.requests ? `${n(row.ownerAtRequest.validator)} of ${n(row.requests)}` : "none"}</td>
                      <td className={`${numberClass} whitespace-nowrap`}>{row.last ?? "none"}</td>
                    </>
                  ) : row.status === "not-read" ? (
                    <td colSpan={6} className={cellClass}>Not read. {row.reason}</td>
                  ) : (
                    <td colSpan={6} className={cellClass}>No registry at this address.{row.reason ? ` ${row.reason}` : ""}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={textClass}>
          {n(d.requests)} requests and {n(d.responses)} responses were found on the chains that were read. {n(d.chainsWithAny)} of those{" "}
          {n(d.read)} chains hold any; the other {n(d.chainsWithNone)} hold none.
        </p>
      </section>

      <section aria-labelledby="vr-who">
        <h2 id="vr-who" className={headingClass}>Who was asked</h2>
        <p className={textClass}>
          Each request names a validator. Nooscape compared that address with the owner the agent had at the block of the request. In{" "}
          {n(d.ownerNamed)} of the {n(d.requests)} requests the validator named was that owner
          {d.ownerUnknown > 0 ? `, and ${n(d.ownerUnknown)} owners could not be read at that block` : ""}. That says who was asked and
          nothing about what the validator did.
        </p>
      </section>

      <section aria-labelledby="vr-earlier">
        <h2 id="vr-earlier" className={headingClass}>Another reader&apos;s count</h2>
        <p className={textClass}>
          A reader published a count of the same registry as of {longDate(EARLIER.asOf)}, with its code and controls (
          <a href={EARLIER.url} className={linkClass} rel="noopener noreferrer">the repository</a>). Of the {n(d.agreement.compared)} chains both
          counts cover, they agree on {n(d.agreement.same)}
          {d.agreement.higher > 0 ? `, and this count is higher on ${n(d.agreement.higher)}, where requests or responses came after that date` : ""}
          {d.agreement.lower > 0 ? `, and this count is lower on ${n(d.agreement.lower)}` : ""}. Celo&apos;s figures were lower bounds there.
        </p>
      </section>

      <section aria-labelledby="vr-not">
        <h2 id="vr-not" className={headingClass}>What this does not say</h2>
        <ul className={listClass}>
          <li>A request is not a result, and a response is not an endorsement. The registry stores what its contracts were called with.</li>
          <li>A chain that was not read is not a chain with none. The table says why for each.</li>
          <li>A validator named is only an address. Nooscape did not call it and says nothing about what a validator did.</li>
          <li>
            The registry accepts a request from the agent&apos;s owner or an approved operator. This note does not say which of them asked,
            so &quot;validator was owner&quot; compares the validator with the owner only.
          </li>
          <li>Only the chains in the table were asked. This is not a count of every chain.</li>
          <li>
            Validation contracts that are not this registry are not counted. The address the reference repository lists for test networks,{" "}
            <code className={codeClass}>{REGISTRY.testnetAddress}</code>, also holds proxy code on some mainnets and is not this registry.
          </li>
        </ul>
      </section>

      <section aria-labelledby="vr-check">
        <h2 id="vr-check" className={headingClass}>Check it</h2>
        <p className={textClass}>
          The measurement record, <code className={codeClass}>{DOC}</code>, holds the method, the checks and a row for each chain. The
          script that reads the chains, <code className={codeClass}>{SCRIPT}</code>, only reads from them and writes nothing. Most chains
          were read through public nodes that need no key. Base and BNB Chain were read through archive endpoints of Nooscape&apos;s own, because
          their public nodes keep too little history. The address comes from {REGISTRY.source}.
        </p>
        <p className={textClass}>
          {d.controlsHeld
            ? `Three checks ran on every chain that was read, and all three held: the registry's code holds both event signatures, the unfiltered read returned only requests, responses and the proxy's own admin events, and the last upgrade the read saw is the implementation the proxy points to now.`
            : "Three checks ran on every chain that was read. Not all of them held on every chain; the record says where."}
        </p>
      </section>
    </InfoPage>
  );
}
