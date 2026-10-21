import { useMediaQuery } from "./useMediaQuery";

/** True when the visitor has asked their system for less motion. */
export function useReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}
