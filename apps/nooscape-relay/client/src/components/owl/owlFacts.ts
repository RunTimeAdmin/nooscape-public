import { useSyncExternalStore } from "react";
import type { OwlFacts } from "./owlLines";

/**
 * What the page tells the owl about the record on its Check card: one slot, which the scan map's section sets and the
 * owl's speech bubble reads. The owl is told facts, not words: what it may say is decided by owlLines from these.
 */
let current: OwlFacts | null = null;
const listeners = new Set<() => void>();

const same = (a: OwlFacts | null, b: OwlFacts | null) => {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (Object.keys({ ...a, ...b }) as Array<keyof OwlFacts>).every(name => a[name] === b[name]);
};

export function setOwlFacts(next: OwlFacts | null) {
  if (same(current, next)) return;
  current = next;
  listeners.forEach(listener => listener());
}

export const getOwlFacts = () => current;

export function subscribeOwlFacts(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const useOwlFacts = () => useSyncExternalStore(subscribeOwlFacts, getOwlFacts, () => null);
