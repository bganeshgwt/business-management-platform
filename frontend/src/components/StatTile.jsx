import { useLayoutEffect, useRef } from "react";
import { Link } from "react-router-dom";
import Icon from "./Icon";
import LiveValue from "./LiveValue";
import { moneyExact, moneyWhole } from "../services/format";

// One figure, said the same way on every screen: a quiet label, the number
// large and in tabular digits, an icon in the tile's tone, and a line under it
// for the detail behind the number or how it moved.
//
//   <StatTile icon="money" tone="primary" label="Sales today" value="₹53,04,269"
//             delta={12.4} deltaLabel="vs last Wednesday" to="/reports" />
//
// tone     primary | success | warning | danger | info | neutral (default)
// value    what to show, already formatted (money(), count() …)
// of       a quieter "of 22" after the value, for "17 of 22 tables"
// note     a line of detail under the value
// delta    a number (a percentage change) or a ready-made string such as
//          "+₹1,200". Up is drawn ▲ in green and down ▼ in red — the arrow is
//          the signal, the colour only a hint, so a colourblind manager reads
//          it too. Pass `invertDelta` where up is bad (costs, waste, voids).
// to       makes the whole tile a link; onClick makes it a button instead
//          (with both, a link whose plain click onClick handles).
// size     "sm" for a denser row of tiles inside a card.
// money    a number instead of `value`: shown as whole rupees (₹14,27,790 —
//          a row of tiles never mixes paise with whole figures), with the
//          exact amount in the tooltip. `currency` changes the ₹.
// exact    the precise figure for the tooltip when `value` is rounded.
// loading  draws a skeleton bar in place of the figure (not "—", which
//          means "no value").
//
// A figure never breaks over two lines: when it is wider than the tile (a
// crore on a phone) its type shrinks until it fits.

// Shrinks the figure's type until it fits on one line in its tile.
function useFitText(ref, content) {
  useLayoutEffect(() => {
    const node = ref.current;

    if (!node || typeof ResizeObserver === "undefined") {
      return undefined;
    }

    let frame = 0;
    const fit = () => {
      node.style.fontSize = "";
      const room = node.clientWidth;
      const needed = node.scrollWidth;

      if (room > 0 && needed > room + 1) {
        const size = parseFloat(getComputedStyle(node).fontSize);
        node.style.fontSize = `${Math.max(size * 0.55, Math.floor(((size * room) / needed) * 10) / 10)}px`;
      }
    };

    fit();
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    observer.observe(node);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [ref, content]);
}
const deltaDirection = (delta) => {
  if (typeof delta === "number") {
    return delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  }

  const text = String(delta).trim();

  if (/^[+▲↑]/.test(text)) {
    return "up";
  }

  return /^[-−▼↓]/.test(text) ? "down" : "flat";
};

const deltaText = (delta) => {
  if (typeof delta !== "number") {
    return String(delta).replace(/^[+\-−▲▼↑↓]\s*/, "");
  }

  const size = Math.abs(delta);
  return `${size >= 10 ? Math.round(size) : Math.round(size * 10) / 10}%`;
};

export default function StatTile({
  icon,
  tone = "neutral",
  value,
  of,
  label,
  note,
  delta,
  deltaLabel,
  invertDelta = false,
  to,
  onClick,
  title,
  size,
  className = "",
  children,
  money,
  currency = "₹",
  exact,
  loading = false,
}) {
  const valueRef = useRef(null);
  const hasMoney = money !== undefined && money !== null && money !== "" && !Number.isNaN(Number(money));
  const shownValue = hasMoney ? moneyWhole(money, currency) : value;
  const exactText = exact ?? (hasMoney && moneyExact(money, currency) !== `${shownValue}.00` ? moneyExact(money, currency) : undefined);
  const tooltip = title ?? (exactText ? (typeof label === "string" ? `${label}: ${exactText}` : String(exactText)) : undefined);
  useFitText(valueRef, typeof shownValue === "string" || typeof shownValue === "number" ? String(shownValue) : null);

  const hasDelta = delta !== undefined && delta !== null && delta !== "";
  const direction = hasDelta ? deltaDirection(delta) : "flat";
  const good = direction === "flat" ? "flat" : (direction === "up") !== invertDelta ? "good" : "bad";

  const classes = [
    "stat-tile",
    `tone-${tone}`,
    size === "sm" ? "stat-tile-sm" : "",
    to || onClick ? "is-interactive" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const body = (
    <>
      <span className="stat-tile-top">
        <span className="stat-tile-label">{label}</span>
        {icon && (
          <span className="stat-tile-icon">
            {typeof icon === "string" ? <Icon name={icon} size={size === "sm" ? 16 : 18} /> : icon}
          </span>
        )}
      </span>

      {/* A figure that changes while the screen is open slides to its new
          value with a soft highlight (LiveValue); on the first render, or a
          refresh that brings the same number, nothing moves. */}
      <span className="stat-tile-value" ref={valueRef} aria-busy={loading || undefined}>
        {loading ? (
          <span className="screen-skeleton-block stat-tile-skeleton" aria-label="Loading" />
        ) : typeof shownValue === "string" || typeof shownValue === "number" ? (
          <LiveValue value={shownValue} />
        ) : (
          shownValue
        )}
        {!loading && of !== undefined && of !== null && <span className="stat-tile-of">{of}</span>}
      </span>

      {(hasDelta || note) && (
        <span className="stat-tile-foot">
          {hasDelta && (
            <span className={`stat-delta is-${good}`}>
              <span aria-hidden="true">{direction === "up" ? "▲" : direction === "down" ? "▼" : "•"}</span>
              <span className="sr-only">{direction === "up" ? "Up " : direction === "down" ? "Down " : "No change "}</span>
              {deltaText(delta)}
            </span>
          )}
          {hasDelta && deltaLabel && <span className="stat-tile-note">{deltaLabel}</span>}
          {note && <span className="stat-tile-note">{note}</span>}
        </span>
      )}

      {children}
    </>
  );

  // Both given: a real link (Ctrl/middle-click open the page in a new tab)
  // whose plain click the screen handles itself — the dashboard opens its
  // detail panel. onClick calls event.preventDefault() to stay put.
  if (to) {
    return (
      <Link to={to} className={classes} title={tooltip} onClick={onClick}>
        {body}
      </Link>
    );
  }

  if (onClick) {
    return (
      <button type="button" className={classes} onClick={onClick} title={tooltip}>
        {body}
      </button>
    );
  }

  return (
    <div className={classes} title={tooltip}>
      {body}
    </div>
  );
}
