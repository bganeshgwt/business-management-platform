// The "it worked" mark: a ring draws itself, the tick follows, and a soft
// burst spreads out once. For the moments that deserve a beat of their own —
// a payment taken, the business day closed, a big save — not for every form.
//
//   <SuccessCheck label="Payment received" />
//   <SuccessCheck size={40} tone="primary" label="Saved" />
//
// It plays once, when it appears (render it when the thing has happened;
// give it a new `key` to play it again). With reduced motion it is simply
// drawn. The label is what a screen reader hears; say the same in words on
// screen next to it — the mark is the feeling, the words are the fact.
//
// size   pixels across (default 56)
// tone   success (default) | primary | info | warning | danger
export default function SuccessCheck({ size = 56, tone = "success", label = "Done", className = "" }) {
  return (
    <span
      className={`success-check tone-${tone} ${className}`.trim()}
      style={{ "--check-size": `${size}px` }}
      role="img"
      aria-label={label}
    >
      <svg viewBox="0 0 52 52" aria-hidden="true" focusable="false">
        <circle className="success-check-ring" cx="26" cy="26" r="23" pathLength="1" />
        <path className="success-check-tick" d="M15.5 27.2l7 7L37 19.4" pathLength="1" />
      </svg>
    </span>
  );
}
