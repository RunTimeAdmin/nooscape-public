/**
 * Whether something opaque covers the whole page. Deep Space does: its overlay is fixed over the viewport and the page behind it is
 * `visibility: hidden`. The page's animation loops (the map, the hero canvas, the owl) stop for a hidden tab and for a map scrolled out
 * of view, but not for that, so they went on drawing what no one could see. The home page sets this while Deep Space is open; each
 * loop reads it and listens for a change.
 */
let covered = false;
const listeners = new Set<() => void>();

export function pageCovered(): boolean {
  return covered;
}

/** Set by the page that puts the cover up and takes it down. Listeners run when the value changes. */
export function setPageCovered(next: boolean): void {
  if (covered === next) return;
  covered = next;
  for (const listener of Array.from(listeners)) listener();
}

/** Calls `listener` when the cover goes up or comes down. Returns the function that stops listening. */
export function onPageCoverChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
