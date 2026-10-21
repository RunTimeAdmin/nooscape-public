import { useLayoutEffect, useState } from "react";

/**
 * The size of an element in pixels, kept up to date while it is on the page. Give the first value to the element's
 * `ref` (it is a callback, so an element that appears later is picked up when it does). The size is 0 by 0 until the
 * element has been measured.
 */
export function useElementSize() {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    if (!element) return;
    const read = () => {
      const box = element.getBoundingClientRect();
      const next = { width: Math.round(box.width), height: Math.round(box.height) };
      setSize(previous => (previous.width === next.width && previous.height === next.height ? previous : next));
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return [setElement, size] as const;
}
