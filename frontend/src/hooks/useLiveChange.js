import { useCallback, useState } from "react";
import { motionAllowed } from "../components/motion";
import { now, settledSince } from "../components/arrival";

// Notices when a live figure changes after it was first shown.
//
//   const live = useLiveChange(order.total);
//   live.version    0 on the first render; +1 each time the value changes
//   live.changed    version > 0
//   live.direction  "up" | "down" — for numbers, or text with digits in it
//   live.previous   the text shown before the change, while it slides out
//                   (null once settled, and always null with reduced motion)
//   live.settle()   call when the slide-in ends, to drop `previous`
//
// `value` is what is compared: a number or a string (the raw amount is best;
// a formatted "₹1,200" works too). `display` is what was on screen, if that
// differs — its text is what slides out.
//
// Arriving from nothing is not a change: null, a placeholder such as "—" or
// "…", or any text without a figure in it → a value (a screen that has just
// loaded) does not animate, so a figure only moves when it really moved.
// "₹1,200" → "₹1,350" is a change; "—" → "₹1,350" is not. It never counts
// through made-up in-between amounts.
//
// Nor is a change from 0 while the screen is still loading. Some screens
// count 0 while their list is on its way; "0" → "42" then is the data
// arriving, not a figure moving. A change from 0 only moves once the
// requests that were running when the figure appeared have been answered
// and the app has been quiet for a moment (components/arrival.js). A change
// between two real figures ("₹1,200" → "₹1,350") always moves.
//
// Most screens want <LiveValue>, which is built on this.
const numberOf = (value) => {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value !== "string") {
    return Number.NaN;
  }

  const cleaned = value.replace(/−/g, "-").replace(/[^0-9.-]/g, "");
  return cleaned && cleaned !== "-" && cleaned !== "." ? Number(cleaned) : Number.NaN;
};

const textOf = (value) => (typeof value === "string" || typeof value === "number" ? String(value) : null);

export default function useLiveChange(value, { display } = {}) {
  const text = textOf(display === undefined ? value : display);
  const [state, setState] = useState(() => ({
    value,
    text,
    previous: null,
    version: 0,
    direction: "up",
    // When the figure first appeared, and whether its screen has finished
    // loading since then.
    born: now(),
    settled: false,
  }));
  let current = state;

  if (!Object.is(state.value, value)) {
    const before = numberOf(state.value);
    const after = numberOf(value);
    // A 0 is what a screen counts before its list has arrived, so a change
    // from 0 is only a change once the screen has finished loading.
    const settled = state.settled || (before === 0 && settledSince(state.born));
    const arriving = before === 0 && !settled;

    if (!Number.isFinite(before) || !Number.isFinite(after) || arriving) {
      // Loading ("—", "…", nothing yet), gone, or the screen's data still
      // arriving: take the new value quietly. Only a figure that becomes
      // another figure is a change worth showing.
      current = { ...state, value, text, previous: null, settled };
    } else {
      current = {
        ...state,
        value,
        text,
        previous: motionAllowed() ? state.text : null,
        version: state.version + 1,
        direction: after < before ? "down" : "up",
        settled: true,
      };
    }

    setState(current);
  } else if (state.text !== text) {
    // Same value, said differently (a currency or format change): no motion.
    current = { ...state, text };
    setState(current);
  }

  const settle = useCallback(
    () => setState((now) => (now.previous === null ? now : { ...now, previous: null })),
    []
  );

  return {
    version: current.version,
    changed: current.version > 0,
    direction: current.direction,
    previous: current.previous,
    settle,
  };
}
