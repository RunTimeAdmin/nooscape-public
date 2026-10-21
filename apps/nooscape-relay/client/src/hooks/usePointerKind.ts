import { useMediaQuery } from "./useMediaQuery";

/** "coarse" on a touch screen (no hover, or a coarse pointer), "fine" with a mouse or trackpad. */
export function usePointerKind(): "coarse" | "fine" {
  return useMediaQuery("(hover: none), (pointer: coarse)") ? "coarse" : "fine";
}
