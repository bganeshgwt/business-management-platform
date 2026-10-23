import { useEffect, useState } from "react";
import { motionAllowed } from "../components/motion";

// Keeps a closing menu or panel on screen for a short exit animation.
//
//   const panel = usePresence(open);
//   {panel.mounted && (
//     <div className={`menu ${panel.leaving ? "is-leaving" : ""}`}
//          aria-hidden={panel.leaving || undefined} inert={panel.leaving || undefined}>
//
// While it is leaving it must be inert and hidden from assistive technology
// (as above) and its CSS sets pointer-events: none, so nothing waits for the
// animation: the page underneath takes clicks straight away, and nothing can
// find the closing copy. Opening again during the exit simply keeps it.
//
// Only for something the component itself opens and closes, and only one at
// a time (a bell's panel, the account menu). With reduced motion, or a
// `duration` of 0, it closes at once.
export default function usePresence(open, duration = 140) {
  const [state, setState] = useState(open ? "open" : "closed");
  let current = state;

  // Derived from `open` during render (React's "adjusting state when a prop
  // changes" pattern), so the first frame after a change is already right.
  if (open && state !== "open") {
    current = "open";
    setState(current);
  } else if (!open && state === "open") {
    current = duration > 0 && motionAllowed() ? "leaving" : "closed";
    setState(current);
  }

  useEffect(() => {
    if (current !== "leaving") {
      return undefined;
    }

    const timer = window.setTimeout(() => setState("closed"), duration);
    return () => window.clearTimeout(timer);
  }, [current, duration]);

  return { mounted: current !== "closed", leaving: current === "leaving" };
}
