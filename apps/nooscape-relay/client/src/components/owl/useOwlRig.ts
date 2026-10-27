import { useEffect, type RefObject } from "react";
import { useOwl } from "@/contexts/OwlContext";
import { onPageCoverChange, pageCovered } from "@/lib/pageCover";
import { chooseTarget, overlaps, owlOpacity, type Rect } from "./owlAvoid";
import { createOwlState, OWL_SIZE, perchedBox, poseTransforms, stepOwl, type OwlSize } from "./owlRig";
import { createOwlWorld, type Perch } from "./owlWorld";

/** The owl has come to rest on a perch: which topic the perch is beside, the box the owl fills there, and when it settled. */
export type Rest = { topic: string | null; box: Rect; since: number };

type Options = {
  boxRef: RefObject<HTMLDivElement | null>;
  reducedMotion: boolean;
  coarse: boolean;
  /** Called when the owl comes to rest on a perch, and with null when it leaves. */
  onRest?: (rest: Rest | null) => void;
};

const nearest = (points: readonly Perch[], from: { x: number; y: number }): Perch | null => {
  let best: Perch | null = null;
  let least = Infinity;
  for (const point of points) {
    const gap = Math.hypot(point.x - from.x, point.y - from.y);
    if (gap < least) {
      least = gap;
      best = point;
    }
  }
  return best;
};

/**
 * Runs the owl: one animation frame loop that steps the rig and writes each part's `style.transform` straight to
 * the DOM. Nothing is read back from the layout except the page's own marks (owlWorld) and no React state changes,
 * so the owl costs no renders. The loop stops when the tab is hidden, while Deep Space covers the page, and when the owl is unmounted.
 *
 * The owl follows the pointer, but not over what the page marks `data-owl-avoid`: there it goes to the nearest clear
 * place, or to a perch (`data-owl-perch`) when none is near or the pointer has been still for a moment. Until the
 * pointer first moves, and for good with reduced motion, it stays on its perch. Where it must pass over something
 * it fades, and where nowhere on screen is clear it is out of sight. While the owl has a note up
 * (`data-owl-note`), the pointer asks nothing of it: it stays where it is until the note is gone. While a field
 * marked `data-owl-search` has focus its radar eye turns.
 */
export function useOwlRig({ boxRef, reducedMotion, coarse, onRest }: Options) {
  const { position, scanning } = useOwl();

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const part = (name: string) => box.querySelector<SVGGraphicsElement>(`[data-owl="${name}"]`);
    const parts = (name: string) => Array.from(box.querySelectorAll<SVGGraphicsElement>(`[data-owl="${name}"]`));
    const root = part("root");
    const body = part("body");
    const head = part("head");
    const pupil = part("pupil");
    const tail = part("tail");
    const feet = part("feet");
    const sweep = part("sweep");
    const wings = parts("wing");
    const lids = parts("lid");
    if (!root || !body || !head || !pupil || !tail || !feet || !sweep) return;

    const size: OwlSize = coarse ? OWL_SIZE.coarse : OWL_SIZE.fine;
    const world = createOwlWorld(size);
    const view = () => ({ width: window.innerWidth, height: window.innerHeight });

    // Where the pointer is and how long it has been still. Until it first moves, the owl keeps to its perch.
    const pointer = { x: window.innerWidth * 0.7, y: window.innerHeight * 0.4 };
    let pointerSeen = false;
    let movedAt = performance.now();
    const onPointer = (event: PointerEvent) => {
      // While the owl has a note up, a pointer asks nothing of it: it finishes what it is saying, where it is, so the
      // pointer can reach the note and its button.
      const speaking = document.querySelector("[data-owl-note]") !== null;
      pointer.x = speaking ? state.x : event.clientX;
      pointer.y = speaking ? state.y : event.clientY;
      pointerSeen = true;
      movedAt = performance.now();
    };
    // A touch screen has no hovering cursor: the owl goes where a finger lands.
    const pointerEvent = coarse ? "pointerdown" : "pointermove";
    window.addEventListener(pointerEvent, onPointer, { passive: true });

    // The radar eye turns while a search field has focus. Asked of the page each frame, not of focus events, which a page that is not itself in focus never sends.
    const searching = () => document.activeElement instanceof Element && document.activeElement.matches("[data-owl-search]");

    const home = nearest(world.perches(false), pointer);
    const start = home ?? chooseTarget({ pointer, owl: pointer, idleMs: 0, rects: world.rects(), perches: [], size, viewport: view() }).target;
    const state = createOwlState(start.x, start.y);

    let frame = 0;
    let last = 0;
    let wasSeeing = false;
    let coveringMs = 0;
    let shown = -1;
    let restingSince: number | null = null;
    let reported: string | null | undefined;
    const step = (now: number) => {
      const here = { x: state.x, y: state.y };
      const rects = world.rects();
      const perch = nearest(world.perches(false), here);
      let target: { x: number; y: number };
      let onPerch = false;
      let stranded = false;
      let restPerch: Perch | null = null;
      const frameMs = now - last;
      if (reducedMotion) {
        // A perched owl stays perched, wherever the page has scrolled the perch.
        target = perch ?? here;
        onPerch = perch !== null;
        restPerch = perch;
      } else if (!pointerSeen && perch) {
        target = perch;
        onPerch = true;
        restPerch = perch;
      } else {
        const perches = world.perches(true);
        const choice = chooseTarget({ pointer, owl: here, idleMs: pointerSeen ? now - movedAt : 0, rects, perches, size, viewport: view(), busy: scanning.current });
        target = choice.target;
        onPerch = choice.kind === "perch";
        restPerch = choice.perch === null ? null : (perches[choice.perch] ?? null);
        // Nowhere on screen is clear: it stays where it is, and out of sight if that is over text.
        stranded = choice.kind === "hold";
      }
      const seeing = scanning.current || searching();
      const pose = stepOwl(state, { dtMs: now - last, nowMs: now, target, reducedMotion, scanning: seeing, size, onPerch });
      last = now;
      const css = poseTransforms(pose);
      box.style.transform = css.box;
      root.style.transform = css.root;
      body.style.transform = css.body;
      head.style.transform = css.head;
      pupil.style.transform = css.pupil;
      tail.style.transform = css.tail;
      feet.style.transform = css.feet;
      sweep.style.transform = css.sweep;
      for (const wing of wings) wing.style.transform = css.wings;
      for (const lid of lids) lid.style.transform = css.lids;
      if (seeing !== wasSeeing) {
        wasSeeing = seeing;
        box.dataset.scanning = String(seeing);
      }
      // Passing over something it must not cover, the owl fades; held there, or with nowhere clear to be, it is gone until it is clear.
      const covering = overlaps({ x: state.x, y: state.y }, size, rects, 0);
      coveringMs = covering ? coveringMs + Math.min(frameMs, 50) : 0;
      const opacity = owlOpacity({ covering, coveringMs, stranded });
      if (opacity !== shown) {
        shown = opacity;
        box.style.opacity = String(opacity);
      }
      // At rest on a perch: said once when it settles, and again, as null, when it leaves.
      const settled = restPerch !== null && state.mode === "perched" && Math.hypot(state.x - target.x, state.y - target.y) < 4;
      if (settled && restPerch) {
        restingSince ??= now;
        if (reported !== restPerch.topic) {
          reported = restPerch.topic;
          onRest?.({ topic: restPerch.topic, box: perchedBox(target, size), since: restingSince });
        }
      } else if (restingSince !== null) {
        restingSince = null;
        reported = undefined;
        onRest?.(null);
      }
      position.current.x = state.x;
      position.current.y = state.y;
      frame = requestAnimationFrame(step);
    };
    const begin = () => {
      last = performance.now();
      frame = requestAnimationFrame(step);
    };
    // The loop runs while the tab shows and nothing covers the page: under Deep Space the owl is behind an opaque overlay.
    const sync = () => {
      if (document.hidden || pageCovered()) {
        cancelAnimationFrame(frame);
        frame = 0;
      } else if (!frame) begin();
    };
    document.addEventListener("visibilitychange", sync);
    const uncover = onPageCoverChange(sync);
    if (!document.hidden && !pageCovered()) begin();

    return () => {
      cancelAnimationFrame(frame);
      world.dispose();
      window.removeEventListener(pointerEvent, onPointer);
      document.removeEventListener("visibilitychange", sync);
      uncover();
      if (restingSince !== null) onRest?.(null);
    };
  }, [boxRef, coarse, reducedMotion, position, scanning, onRest]);
}
