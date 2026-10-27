import { intersects, overlaps, type Point, type Rect } from "./owlAvoid";
import { perchedBox, perchPoint, type OwlSize } from "./owlRig";

/**
 * What the page says about where the owl may be, read from its marks:
 *
 *   `data-owl-avoid`          a box the owl must not cover (text, cards, controls). `data-owl-avoid="fixed"` is one that
 *                             stays where it is on screen as the page scrolls (the header).
 *   `data-owl-perch`          a box reserved for the owl to stand in. It stands on the middle of the box's bottom edge.
 *
 * The boxes are read once and again when the page changes size or its elements change (at most four times a second) and
 * every second and a half, kept in page coordinates, and turned into screen coordinates each frame from the scroll
 * position, so scrolling costs no reads.
 */
type Stored = Rect & { fixed: boolean };
type StoredPerch = Stored & { topic: string | null };

/** A perch: where the owl's feet rest, and what it is beside (`data-owl-topic`), if the page says. */
export type Perch = Point & { topic: string | null };

type OwlWorld = {
  /** Reads the marks again. */
  refresh: () => void;
  /** The boxes to avoid, in screen pixels now, those near the screen only. */
  rects: () => Rect[];
  /** The feet position on each perch, in screen pixels now. With `onlyOnScreen`, only the perches whose owl would be entirely visible and clear of every avoid box. */
  perches: (onlyOnScreen: boolean) => Perch[];
  dispose: () => void;
};

/** The boxes the owl must not cover, read from the page once, in screen pixels now. */
export function readAvoidRects(): Rect[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-owl-avoid]"), element => element.getBoundingClientRect())
    .filter(box => box.width >= 1 && box.height >= 1)
    .map(box => ({ left: box.left, top: box.top, right: box.right, bottom: box.bottom }));
}

const NEAR_PX = 400;

export function createOwlWorld(size: OwlSize): OwlWorld {
  let avoid: Stored[] = [];
  let perches: StoredPerch[] = [];

  const read = (element: Element, fixed: boolean): Stored | null => {
    const box = element.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return null;
    const dx = fixed ? 0 : window.scrollX;
    const dy = fixed ? 0 : window.scrollY;
    return { left: box.left + dx, top: box.top + dy, right: box.right + dx, bottom: box.bottom + dy, fixed };
  };

  const refresh = () => {
    avoid = Array.from(document.querySelectorAll<HTMLElement>("[data-owl-avoid]"), element => read(element, element.dataset.owlAvoid === "fixed")).filter((item): item is Stored => item !== null);
    perches = Array.from(document.querySelectorAll<HTMLElement>("[data-owl-perch]"), element => {
      const box = read(element, false);
      return box ? { ...box, topic: element.dataset.owlTopic ?? null } : null;
    }).filter((item): item is StoredPerch => item !== null);
  };

  const onScreen = (item: Stored): Rect => {
    const dx = item.fixed ? 0 : -window.scrollX;
    const dy = item.fixed ? 0 : -window.scrollY;
    return { left: item.left + dx, top: item.top + dy, right: item.right + dx, bottom: item.bottom + dy };
  };

  const rects = () => {
    const view = { left: -NEAR_PX, top: -NEAR_PX, right: window.innerWidth + NEAR_PX, bottom: window.innerHeight + NEAR_PX };
    return avoid.map(onScreen).filter(item => intersects(item, view));
  };

  const perchesNow = (onlyOnScreen: boolean): Perch[] => {
    const points = perches.map(item => ({ ...perchPoint(onScreen(item)), topic: item.topic }));
    if (!onlyOnScreen) return points;
    const blocked = rects();
    return points.filter(point => {
      const box = perchedBox(point, size);
      return box.left >= 0 && box.top >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight && !overlaps(point, size, blocked, 0);
    });
  };

  let queued = 0;
  const later = () => {
    if (queued) return;
    queued = window.requestAnimationFrame(() => {
      queued = 0;
      refresh();
    });
  };
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(later);
  observer?.observe(document.body);
  // A tooltip or a card that loads comes without the page changing size, so changes to the page's elements count too, at most four times a second.
  let settling = 0;
  const changed = () => {
    if (settling) return;
    settling = window.setTimeout(() => {
      settling = 0;
      refresh();
    }, 250);
  };
  const mutations = typeof MutationObserver === "undefined" ? null : new MutationObserver(changed);
  mutations?.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", later);
  const timer = window.setInterval(refresh, 1_500);
  refresh();

  return {
    refresh,
    rects,
    perches: perchesNow,
    dispose: () => {
      window.cancelAnimationFrame(queued);
      window.clearTimeout(settling);
      window.clearInterval(timer);
      window.removeEventListener("resize", later);
      observer?.disconnect();
      mutations?.disconnect();
    },
  };
}
