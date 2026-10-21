import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { placeBubble } from "./owlAvoid";
import { useOwlFacts } from "./owlFacts";
import { DISMISS_QUIET_MS, HOLD_MAX_MS, nextLine, SETTLE_MS, SHOW_MS, SPEAK_GAP_MS, type Line } from "./owlLines";
import type { Rest } from "./useOwlRig";
import { readAvoidRects } from "./owlWorld";

type Props = {
  /** Where the owl is at rest, or null. It speaks only from a perch beside the records. */
  rest: Rest | null;
  /** A touch screen: the owl says nothing there. */
  coarse: boolean;
};

type Shown = { text: string; left: number; top: number };

/**
 * The owl's note about the record on the Check card. Which line, and whether there is one, is decided by owlLines
 * from the facts the page gives the owl, so it says only what the record holds. It speaks from the perch beside the
 * records after it has been at rest a moment: one line each time it settles there, and another if what the card shows
 * changes, never the same line twice about one record, at most once in eight seconds, for six seconds (longer while
 * the pointer is on it or its button has focus, but twenty at most), and never about a record that has been dismissed
 * for a minute. It is
 * placed where nothing it must not cover is, or not at all. The text is read out politely by a live region of its own, which is always on the
 * page; the note itself is for the eye.
 */
export function OwlBubble({ rest, coarse }: Props) {
  const facts = useOwlFacts();
  const [pending, setPending] = useState<Line | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [live, setLive] = useState("");
  const bubble = useRef<HTMLDivElement>(null);
  const memory = useRef({ lastSpokeAt: null as number | null, said: new Map<string, string[]>(), quiet: new Map<string, number>() });
  const timers = useRef({ speak: 0, hide: 0 });
  // The record the note on screen is about.
  const noteKey = useRef<string | null>(null);

  const hide = useCallback(() => {
    window.clearTimeout(timers.current.hide);
    noteKey.current = null;
    setShown(null);
    setPending(null);
    setLive("");
  }, []);

  // A note stays six seconds, and while the pointer is on it or its button has focus it waits, so there is time to
  // read it and to reach the button, but never more than HOLD_MAX_MS: it always goes by itself. A pointer on the
  // note does not draw the owl away (useOwlRig).
  const arm = useCallback(() => {
    window.clearTimeout(timers.current.hide);
    timers.current.hide = window.setTimeout(hide, SHOW_MS);
  }, [hide]);
  const hold = useCallback(() => {
    window.clearTimeout(timers.current.hide);
    timers.current.hide = window.setTimeout(hide, HOLD_MAX_MS);
  }, [hide]);

  const dismiss = useCallback(() => {
    if (facts) memory.current.quiet.set(facts.key, performance.now() + DISMISS_QUIET_MS);
    hide();
  }, [facts, hide]);

  // When the owl is at rest beside the records and the rules allow it, pick the next line and have it measured.
  useEffect(() => {
    window.clearTimeout(timers.current.speak);
    if (!rest || rest.topic !== "records" || !facts || coarse) {
      hide();
      return;
    }
    // A note is about the record it was said of: when the card moves to another, it goes.
    if (noteKey.current !== null && noteKey.current !== facts.key) hide();
    const memoryNow = memory.current;
    const attempt = () => {
      const now = performance.now();
      const wait = Math.max(
        SETTLE_MS - (now - rest.since),
        memoryNow.lastSpokeAt === null ? 0 : SPEAK_GAP_MS - (now - memoryNow.lastSpokeAt),
        (memoryNow.quiet.get(facts.key) ?? 0) - now,
        0,
      );
      if (wait > 0) {
        timers.current.speak = window.setTimeout(attempt, wait + 20);
        return;
      }
      const line = nextLine(facts, new Date(), memoryNow.said.get(facts.key) ?? []);
      if (line) setPending(line);
    };
    attempt();
    return () => window.clearTimeout(timers.current.speak);
  }, [rest, facts, coarse, hide]);

  // The line is on the page, hidden, so its size is known; then it goes where nothing it must not cover is, or is not said.
  useLayoutEffect(() => {
    if (!pending || !rest || !facts || !bubble.current) return;
    const place = placeBubble({
      owl: rest.box,
      bubble: { width: bubble.current.offsetWidth, height: bubble.current.offsetHeight },
      rects: readAvoidRects(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    setPending(null);
    if (!place) return;
    const memoryNow = memory.current;
    memoryNow.said.set(facts.key, [...(memoryNow.said.get(facts.key) ?? []), pending.id]);
    memoryNow.lastSpokeAt = performance.now();
    noteKey.current = facts.key;
    setShown({ text: pending.text, left: place.left, top: place.top });
    setLive(pending.text);
    arm();
  }, [pending, rest, facts, arm]);

  useEffect(() => {
    if (!shown) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [shown, dismiss]);

  useEffect(() => {
    const current = timers.current;
    return () => {
      window.clearTimeout(current.speak);
      window.clearTimeout(current.hide);
    };
  }, []);

  const text = shown?.text ?? pending?.text ?? null;
  return (
    <>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {live}
      </div>
      {text !== null && (
        <div ref={bubble} className="owl-bubble" data-owl-note="" onPointerEnter={hold} onPointerLeave={arm} onFocus={hold} onBlur={arm} style={{ left: shown?.left ?? 0, top: shown?.top ?? 0, visibility: shown ? "visible" : "hidden" }}>
          <span aria-hidden="true">{text}</span>
          <button type="button" onClick={dismiss} aria-label="Dismiss the Owl's note" className="owl-bubble-x">
            ×
          </button>
        </div>
      )}
    </>
  );
}
