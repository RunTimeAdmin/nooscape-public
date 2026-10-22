import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { usdOf } from "@shared/usdc";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";

/**
 * The operator's view of pay per call (docs/data-access-2026-10-19.md, stage D4): whether it is on, what it is set to, what came in over
 * the last seven days, the payments not yet resolved (to look at by hand: this version has no refunds), and the newest payments. Reads
 * only, except that a payment the facilitator never decided can be set aside once he has looked at it. Shown on the operator page only.
 * A banner at the top of the page says when any payment has been unresolved for over an hour, so they do not pile up unseen.
 */
type PaymentRow = {
  id: string;
  paymentId: string;
  endpoint: string;
  payer: string;
  amount: number;
  status: string;
  transaction: string | null;
  reason: string | null;
  sends: number;
  serves: number;
  createdAt: Date;
};

const dollars = usdOf;
const when = (value: Date) => new Date(value).toLocaleString();

const STATE_TEXT: Record<string, string> = {
  not_configured: "Off. The settings are not set in the host's environment.",
  no_table: "Waiting for migration 0044. The settings are set, but the payments table does not exist yet, so nothing is offered.",
  paused: "Paused. No new payment is taken; one already recorded is still resolved.",
  on: "On. A caller with no key may pay for a lookup past the free limit and for the check.",
};

function Rows({ rows, onClose, closing }: { rows: PaymentRow[]; onClose?: (row: PaymentRow) => void; closing?: boolean }) {
  return (
    <div className="source-ops-table-wrap">
      <table className="source-ops-table">
        <thead>
          <tr><th>When</th><th>For</th><th>Payer</th><th>Status</th><th>Transaction</th>{onClose ? <th>Action</th> : null}</tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.id}>
              <td><span>{when(row.createdAt)}</span></td>
              <td><strong>{row.endpoint === "check" ? "Check" : "Lookup"}</strong><span>{dollars(row.amount)}</span></td>
              <td><span style={{ overflowWrap: "anywhere" }}>{row.payer}</span></td>
              <td><strong>{row.status}</strong><span style={{ overflowWrap: "anywhere" }}>{row.reason ?? `sent ${row.sends}, served ${row.serves}`}</span><span style={{ overflowWrap: "anywhere" }}>{row.paymentId}</span></td>
              <td><span style={{ overflowWrap: "anywhere" }}>{row.transaction ?? "none yet"}</span></td>
              {onClose ? <td><Button type="button" size="sm" variant="outline" disabled={closing} onClick={() => onClose(row)}>Set aside</Button></td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A line at the top of the operator page when any payment has been unresolved for over an hour. Nothing when there is none. */
export function PaymentsAlert() {
  const status = trpc.apiPayments.status.useQuery(undefined, { retry: false, refetchOnWindowFocus: false });
  const data = status.data;
  const stale = data && "stale" in data ? data.stale : 0;
  if (stale === 0) return null;
  return (
    <div className="source-ops-notice" role="alert">
      {stale} {stale === 1 ? "payment has" : "payments have"} not settled for over an hour. <a href="#pay-per-call">Look at {stale === 1 ? "it" : "them"} under Pay per call.</a>
    </div>
  );
}

export function OperatorPayments() {
  const utils = trpc.useUtils();
  const status = trpc.apiPayments.status.useQuery(undefined, { retry: false, refetchOnWindowFocus: false });
  const [notice, setNotice] = useState<string | null>(null);
  const close = trpc.apiPayments.close.useMutation({
    onSuccess: () => {
      setNotice("Set aside.");
      void utils.apiPayments.status.invalidate();
    },
    onError: error => setNotice(error.message),
  });
  const setAside = (row: PaymentRow) => {
    const note = window.prompt(`Check the transaction first. What did you find for ${row.paymentId}? (3 to 120 characters, kept with the payment)`);
    if (note === null || note.trim().length < 3) return;
    if (!window.confirm(`Set aside ${row.paymentId}? It stays in the ledger as closed and is never sent or served again. A caller who was charged is yours to deal with by hand.`)) return;
    close.mutate({ id: row.id, note: note.trim().slice(0, 120) });
  };
  const data = status.data;
  const detailed = data && "summary" in data ? data : null;

  return (
    <section className="source-ops-list" id="pay-per-call" aria-label="Pay per call">
      <div className="source-ops-list-header">
        <div><p className="eyebrow">REST API</p><h2>Pay per call</h2></div>
        <Button type="button" size="sm" variant="outline" disabled={status.isFetching} onClick={() => void status.refetch()}>
          {status.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Refresh
        </Button>
      </div>
      {status.isLoading ? <div className="source-ops-loading"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div> : null}
      {status.error ? <div className="source-ops-loading source-ops-error">{status.error.message}</div> : null}
      {notice ? <div className="source-ops-notice" role="status">{notice}</div> : null}
      {data ? (
        <div className="source-ops-loading" style={{ display: "block", overflowWrap: "anywhere" }}>
          <p><strong>{STATE_TEXT[data.state]}</strong></p>
          {"networks" in data ? <p>{data.networks.join(" and ")}. Pays to <code>{data.payTo}</code>. Lookup {dollars(data.prices.lookup)}, check {dollars(data.prices.check)}.</p> : null}
        </div>
      ) : null}
      {detailed ? (
        <>
          <div className="source-ops-loading" style={{ display: "block" }}>
            <p>
              Last {detailed.windowDays} days:{" "}
              {detailed.summary.length === 0 ? "no payments." : detailed.summary.map(item => `${item.count} ${item.status}${item.status === "paid" ? ` (${dollars(item.amount)})` : ""}`).join(", ") + "."}
            </p>
          </div>
          <div className="source-ops-list-header"><div><h3>Not yet resolved</h3></div><span>{detailed.unresolved.total}{detailed.stale > 0 ? `, ${detailed.stale} for over ${detailed.staleAfterMinutes} minutes` : ""}</span></div>
          {detailed.unresolved.rows.length > 0 ? (
            <>
              <div className="source-ops-loading">These may have settled. Check the transaction on the explorer before doing anything. A payment that settled and was not served is for you to decide by hand, since this version has no refunds. One that did not settle needs nothing. Once you have looked, set it aside so it stops counting.</div>
              <Rows rows={detailed.unresolved.rows as PaymentRow[]} onClose={setAside} closing={close.isPending} />
            </>
          ) : <div className="source-ops-loading">None. Every payment recorded was settled, refused or set aside.</div>}
          <div className="source-ops-list-header"><div><h3>Newest</h3></div><span>{detailed.recent.length} shown</span></div>
          {detailed.recent.length > 0 ? <Rows rows={detailed.recent as PaymentRow[]} /> : <div className="source-ops-loading">No payment yet.</div>}
        </>
      ) : null}
    </section>
  );
}
