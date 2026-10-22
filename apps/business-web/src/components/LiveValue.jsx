import useLiveChange from "../hooks/useLiveChange";

// A live figure that shows when it changes: the old value slides out, the
// new one slides in (up when it rose, down when it fell), and a soft
// highlight fades behind it. Nothing happens on the first render, on a
// refresh that brings the same value, or with reduced motion — then the new
// value is simply there. It never counts through invented amounts.
//
//   <LiveValue value={money(total)} />                    text is compared
//   <LiveValue value={total}>{money(total)}</LiveValue>   raw number compared,
//                                                         formatted text shown
//   <LiveValue value={count} align="end" tone="success" />
//
// value     what is compared (number or string). Pass the raw number where
//           you have it; "₹1,200" also works.
// children  what is shown, when it differs from `value` (text or element).
// align     "start" (default) or "end" for a right-aligned column, so the old
//           value leaves from the same edge the new one sits on.
// tone      the highlight's colour: primary (default) | success | warning |
//           danger | info | neutral.
//
// The old value is drawn by CSS (::before), not as text in the page, so a
// screen reader or a test reading the figure only ever finds the new one.
export default function LiveValue({ value, children, align = "start", tone, className = "" }) {
  const shown = children === undefined ? value : children;
  const live = useLiveChange(value, { display: shown });
  const swapping = live.changed && live.previous !== null;

  const classes = [
    "live-value",
    live.changed ? `is-changed is-${live.direction}` : "",
    swapping ? "is-swapping" : "",
    align === "end" ? "is-end" : "",
    tone ? `live-tone-${tone}` : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={classes} data-live-previous={swapping ? live.previous : undefined}>
      <span
        className="live-value-now"
        key={live.version}
        onAnimationEnd={(event) => {
          if (event.animationName.startsWith("motion-live-in")) {
            live.settle();
          }
        }}
      >
        {shown}
      </span>
    </span>
  );
}
