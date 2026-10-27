/**
 * The note under evidence that comes from an earlier read. The relay envelope is read when Deep Space or the field view opens and
 * then once a minute. When a read fails the query keeps the last good envelope, and the page says when that was, instead of showing
 * it as fresh or taking it away.
 */
export function staleSince(read: { isRefetchError: boolean; dataUpdatedAt: number }): number | null {
  return read.isRefetchError && read.dataUpdatedAt > 0 ? read.dataUpdatedAt : null;
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function asOfSentence(at: number, format: (at: number) => string = clock): string {
  return `As of ${format(at)}. The latest read failed, so this is the last envelope that was read.`;
}

export function EvidenceAsOf({ at }: { at: number | null }) {
  if (at === null) return null;
  return (
    <p role="status" className="evidence-as-of mt-3 rounded-lg border border-[#E6C87A]/30 bg-[#E6C87A]/[0.06] px-3 py-2 text-xs leading-4 text-[#F0DFA8]">
      {asOfSentence(at)}
    </p>
  );
}
