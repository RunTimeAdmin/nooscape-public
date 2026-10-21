import { formatWhen } from "@/lib/checkText";
import { HISTORY_LABEL, HISTORY_NOTE, historyLine, historySummary } from "@/lib/claimFlow";
import { trpc } from "@/lib/trpc";

/**
 * The public history of an entry's claims (docs/claims-2026-10-18.md): every claim, edit, hold, end and removal, newest first, with the
 * time and the signing wallet. The server sends it without the text of an edit that was removed or whose claim is on hold, so what
 * this shows for those is that a change was made. It is plain text from the server and says nothing the server did not send. It shows
 * nothing while there is no history, and nothing when claims are not available.
 */
const note = "max-w-2xl text-sm leading-6 text-ns-ink-dim";

export function ClaimHistory({ entryId }: { entryId: string }) {
  const history = trpc.claim.history.useQuery({ entryId }, { refetchOnWindowFocus: false, retry: false });
  const data = history.data;
  if (history.isError || !data || !data.available || !data.claimable || data.items.length === 0) return null;
  return (
    <details className="group rounded-xl border border-[var(--ns-glass-border)] bg-white/[.02] p-4">
      <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ns-radar">
        <span className="eyebrow">{HISTORY_LABEL}</span>
        <span className="font-mono text-xs text-ns-ink-dim">
          {historySummary(data.items.length)}
          {data.truncated ? ", newest first, older ones not shown" : ""}
        </span>
      </summary>
      <p className={`${note} mt-3`}>{HISTORY_NOTE}</p>
      <ol className="mt-4 space-y-4">
        {data.items.map(item => {
          const line = historyLine(item);
          return (
            <li key={item.seq} className="min-w-0">
              <p className="font-mono text-xs text-ns-ink">
                {line.title} <span className="ml-2 text-ns-ink-dim">{formatWhen(item.occurredAt)}</span>
              </p>
              {line.change && <p className="mt-1 whitespace-pre-line break-words text-sm leading-6 text-ns-ink-dim">{line.change}</p>}
              {line.signed && <p className="mt-1 break-all font-mono text-xs leading-5 text-ns-ink-dim">{line.signed}</p>}
            </li>
          );
        })}
      </ol>
    </details>
  );
}
