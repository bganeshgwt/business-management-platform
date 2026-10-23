import { useLayoutEffect, useState } from "react";

// The width of the grid itself, not of the window: the same list is a full
// page on a laptop, half a split screen, or a dialog 560px wide, and it turns
// into cards by the room it actually has.
//
// The first guess is the window (right on a phone, so a phone never draws a
// table first); the real width is read before the first paint and then
// followed by a ResizeObserver. offsetWidth rather than a bounding box, so a
// dialog scaling in does not read as a narrower grid for a moment.
export default function useContainerWidth(ref) {
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 1024 : window.innerWidth));

  useLayoutEffect(() => {
    const node = ref.current;

    if (!node) {
      return undefined;
    }

    const measure = () => {
      const next = node.offsetWidth;

      if (next > 0) {
        setWidth(next);
      }
    };

    measure();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(node);

    return () => observer.disconnect();
  }, [ref]);

  return width;
}
