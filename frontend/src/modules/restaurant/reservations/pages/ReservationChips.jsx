// Small marks shared by the reservation screens: icons, status and live chips.

import Icon from "../../../../components/Icon";
import { STATUS } from "./reservationFormat";

// ---------------------------------------------------------------- icons

// Every mark comes from the shared icon set but one: the door a walk-in comes
// through, which the shared set does not carry.
const DOOR = (
  <>
    <path d="M13 4h3a2 2 0 0 1 2 2v14M2 20h3M13 20h9" />
    <path d="M10 12v.01M13 4.6v16.8a.6.6 0 0 1-.8.6L5 20V5.6a1 1 0 0 1 .7-1L12.2 3a.6.6 0 0 1 .8.6z" />
  </>
);

// The page's older names for marks the shared set has under its own name.
const SHARED_NAME = { note: "clipboard", left: "chevron-left", right: "chevron-right", hourglass: "timer" };

export function Glyph({ name, size = 16 }) {
  if (name !== "door") {
    return <Icon name={SHARED_NAME[name] || name} size={size} className="rsv-icon" />;
  }

  return (
    <svg
      className="icon rsv-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {DOOR}
    </svg>
  );
}

export function StatusChip({ status }) {
  return <span className={`rsv-chip rsv-tone-${status}`}>{STATUS[status].label}</span>;
}

export function LiveChip({ live }) {
  if (!live) {
    return null;
  }

  const tone = { late: "late", missed: "no_show", due: "due" }[live.key] || "soon";

  return <span className={`rsv-chip rsv-tone-${tone}`}>{live.label}</span>;
}
