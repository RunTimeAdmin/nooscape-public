import { useEffect, useRef, useState } from "react";
import { throttleDelay } from "./constellationModel";
import { Defined } from "./Defined";

/** How often the status may be announced to a screen reader. The display itself updates at once. */
const ANNOUNCE_GAP_MS = 1_200;

/** The text, but no more often than every `gapMs`: a scan that sweeps across many dots would otherwise talk over itself. */
function useThrottledText(text: string, gapMs: number) {
  const [shown, setShown] = useState(text);
  const lastShownAt = useRef(0);
  useEffect(() => {
    const timer = setTimeout(() => {
      lastShownAt.current = Date.now();
      setShown(text);
    }, throttleDelay(lastShownAt.current, Date.now(), gapMs));
    return () => clearTimeout(timer);
  }, [text, gapMs]);
  return shown;
}

/**
 * The scanner's status display: two lines about the record being scanned, politely announced and throttled, and under
 * them, when there is one, the Owl's last sweep, which is a fact about the reads and not about the record, so it is
 * plain text that is never announced as it changes.
 */
export function ScanStatusLine({ lines, sweep = null }: { lines: [string, string]; sweep?: string | null }) {
  const announcement = useThrottledText(lines.join(". "), ANNOUNCE_GAP_MS);
  return (
    <div data-owl-avoid="" className="rounded-xl border border-[#BFFF76]/20 bg-[#02070A] px-4 py-3 font-mono text-[12px] leading-5 text-[#9EF5B7]">
      <div aria-hidden="true">
        <p className="truncate">{lines[0]}</p>
        <p className="truncate text-[#6FA582]">{lines[1]}</p>
      </div>
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
      {sweep && (
        <p className="mt-2 border-t border-[#BFFF76]/15 pt-2 text-[#6FA582]">
          <Defined k="owlsLastSweep" text={sweep} />
        </p>
      )}
    </div>
  );
}
