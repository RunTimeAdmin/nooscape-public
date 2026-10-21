import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { countUpValue } from "./noiseModel";

type Props = { value: number; durationMs?: number; className?: string };

/**
 * A figure that is its value from the first paint, counts up to it from nothing just
 * before it is on screen, and glides to a new value when a poll or the page changes
 * it. A page that is never scrolled, or is read without scripts or with reduced
 * motion, shows every figure complete. Assistive technology is given the final figure
 * in text and never hears the count (the animated digits are hidden from it, and
 * nothing is a live region).
 */
export function CountUp({ value, durationMs = 1100, className }: Props) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const [counting, setCounting] = useState(false);
  const [display, setDisplay] = useState(0);
  const shown = useRef(0);
  const seen = useRef(false);
  const latest = useRef(value);
  const frame = useRef(0);

  const run = (to: number) => {
    cancelAnimationFrame(frame.current);
    const from = shown.current;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = (now - start) / durationMs;
      const next = countUpValue(from, to, progress);
      shown.current = next;
      setDisplay(next);
      if (progress < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  };

  useEffect(() => {
    latest.current = value;
    if (seen.current && !reduced) run(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, reduced]);

  // The count starts a little before the figure is on screen (a figure that is already in view starts before the first
  // paint), so it is never seen at its value and then at nothing. Until then it is its value.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || reduced) return;
    const begin = () => {
      seen.current = true;
      shown.current = 0;
      setCounting(true);
      setDisplay(0);
      run(latest.current);
    };
    const box = element.getBoundingClientRect();
    if (box.bottom > 0 && box.top < window.innerHeight + 120) {
      begin();
      return () => cancelAnimationFrame(frame.current);
    }
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting) && !seen.current) {
          observer.disconnect();
          begin();
        }
      },
      { rootMargin: "0px 0px 120px 0px" },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  return (
    <span ref={ref} className={className}>
      <span aria-hidden="true">{(reduced || !counting ? value : display).toLocaleString()}</span>
      <span className="sr-only">{value.toLocaleString()}</span>
    </span>
  );
}
