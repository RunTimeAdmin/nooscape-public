import { useEffect, useState } from "react";

/**
 * The value, but only after it has stopped changing for `delayMs`. A search box
 * that sent a request per keystroke sent up to nine for one typed word, each
 * costing the server a second or more; this sends one when the typing pauses.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}
