import { useLayoutEffect, useRef } from "react";
import { MOTION, motionAllowed, play } from "../components/motion";

// The sidebar's own motion, run by the app layout:
//
//   * When a menu group opens or closes (by a click, or because the page
//     you moved to lives in another group), the groups below glide to their
//     new place instead of jumping. A group that opens is uncovered from the
//     top down in step with that glide — like a drawer sliding open — so the
//     heading of the group below never sits over its new links; the links
//     themselves slide in (motion.css).
//   * The active marker — the bar on the left of the current page's link —
//     slides from the page you were on to the one you are on.
//
// Both are "FLIP" moves: the layout changes at once, and each moved thing is
// drawn from where it was back to where it now is, with transform only. The
// positions are recorded after every change (and on scroll), so the next
// change knows where things were. Typing in "Jump to…" never animates.
// How long a group takes to glide to its new place.
const GLIDE_MS = 280;

const measure = (sidebar, filter) => {
  const top = sidebar.getBoundingClientRect().top;
  const scroll = sidebar.scrollTop;
  // Positions within the sidebar's content, so scrolling does not change them.
  const place = (node) => node.getBoundingClientRect().top - top + scroll;

  const sections = new Map();
  for (const node of sidebar.querySelectorAll(".nav-section[data-section]")) {
    sections.set(node.dataset.section, { node, top: place(node), height: node.getBoundingClientRect().height });
  }

  const bars = new Map();
  for (const node of sidebar.querySelectorAll(".nav-link.active")) {
    const scope = node.closest(".quick-access") ? "quick" : "all";
    if (!bars.has(scope)) {
      bars.set(scope, { node, top: place(node), to: node.getAttribute("href") });
    }
  }

  return { sections, bars, scroll, filter };
};

export default function useSidebarMotion(sidebarRef, { pathname, layoutKey, filter }) {
  const last = useRef(null);

  useLayoutEffect(() => {
    const sidebar = sidebarRef.current;

    if (!sidebar) {
      return undefined;
    }

    const onScroll = () => {
      if (last.current) {
        last.current.scroll = sidebar.scrollTop;
      }
    };

    sidebar.addEventListener("scroll", onScroll, { passive: true });
    return () => sidebar.removeEventListener("scroll", onScroll);
  }, [sidebarRef]);

  useLayoutEffect(() => {
    const sidebar = sidebarRef.current;

    // Folded away on a phone: nothing to see, nothing to remember.
    if (!sidebar || sidebar.getClientRects().length === 0) {
      last.current = null;
      return;
    }

    // Start from still positions: finish any glide that is still running.
    for (const animation of sidebar.getAnimations({ subtree: true })) {
      if (animation.id === "sidebar-flip") {
        animation.cancel();
      }
    }

    const next = measure(sidebar, filter);
    const previous = last.current;
    last.current = next;

    if (!previous || previous.filter !== filter || filter.trim() !== "" || !motionAllowed()) {
      return;
    }

    // Visual movement: where it was on screen, minus where it now is.
    const moved = (before, after) => before.top - previous.scroll - (after.top - next.scroll);
    const carried = new Map();

    for (const [key, after] of next.sections) {
      const before = previous.sections.get(key);
      const delta = before ? moved(before, after) : 0;
      const grown = before ? after.height - before.height : 0;

      if (Math.abs(delta) >= 1) {
        carried.set(after.node, delta);
        const animation = play(after.node, [{ transform: `translateY(${delta}px)` }, { transform: "none" }], {
          duration: GLIDE_MS,
        });
        if (animation) animation.id = "sidebar-flip";
      }

      // A group that opened: its new part is hidden at first and uncovered
      // from the top down exactly as fast as the groups below glide out of
      // the way (same length, same curve), so they never overlap. Only its
      // lower edge is clipped — the active marker can still be seen
      // travelling in from a link above. Only clip-path moves: the links are
      // in their places from the start, and each takes clicks as soon as it
      // is uncovered (all of them within 0.28 s).
      if (grown >= 1) {
        const animation = play(
          after.node,
          [{ clipPath: `inset(-100vh -100vw ${grown}px -100vw)` }, { clipPath: "inset(-100vh -100vw 0px -100vw)" }],
          { duration: GLIDE_MS }
        );
        if (animation) animation.id = "sidebar-flip";
      }
    }

    for (const [scope, after] of next.bars) {
      const before = previous.bars.get(scope);

      if (!before || before.to === after.to) {
        continue;
      }

      // The link may be riding along with its group's glide; the marker only
      // adds the rest of the distance.
      const own = moved(before, after) - (carried.get(after.node.closest(".nav-section")) || 0);

      if (Math.abs(own) >= 1) {
        const animation = play(after.node, [{ transform: `translateY(${own}px)` }, { transform: "none" }], {
          duration: MOTION.slide + 40,
          pseudoElement: "::before",
        });
        if (animation) animation.id = "sidebar-flip";
      }
    }
  }, [sidebarRef, pathname, layoutKey, filter]);
}
