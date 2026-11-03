import { drawing } from "./drawings";

// The general icon set for the screens themselves: tiles, section headings,
// buttons, empty states, statuses. The drawings are in drawings.jsx.
//
// The menu's marks (menuIcons.jsx, drawn by the staff app's NavIcon) and these
// are one set of names: a name this set lacks is drawn from the menu's, so a
// menu entry's mark on a screen (a page's More menu, a section's heading) is
// never blank. Same rules: a 24 grid, stroked in currentColor so an icon takes
// the colour of whatever it sits in (a red alert, an orange tile, a muted
// table cell) with no second rule, and hidden from screen readers unless it is
// given a `title` — the words beside it already say what it means.
//
//   <Icon name="money" />                 18 px, decorative
//   <Icon name="alert" size={16} />
//   <Icon name="trash" title="Delete" />  announced, for an icon-only button
//   <Icon name={look.icon} fallback="store" />  a name from data, with a stand-in

// An unknown name draws nothing rather than throwing: a typo costs an icon,
// never the page. `fallback` names one to draw instead (an icon set in data,
// such as a business type's, that this version does not have yet).
export default function Icon({ name, fallback, size = 18, strokeWidth = 2, title, className = "", style }) {
  const path = drawing(name) || (fallback ? drawing(fallback) : null);

  if (!path) {
    return null;
  }

  return (
    <svg
      className={`icon ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      role={title ? "img" : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : "true"}
      focusable="false"
    >
      {title && <title>{title}</title>}
      {path}
    </svg>
  );
}

// The product's mark: modules of every shape, white on the brand colour. Used
// wherever no business is open (the sign-in page, the chooser, the platform
// console, a page not found), so the product looks like one thing wherever
// someone meets it. The same tile carries another mark where a place has its
// own: `icon` (the restaurant's cloche, a workspace's own), and `color` for a
// business's accent in place of the brand's.
//
//   <BrandMark />                                  the product
//   <BrandMark icon="cloche" />                    the restaurant's screens
//   <BrandMark icon="dumbbell" color="#be123c" />  a gym, in its accent
export function BrandMark({ size = 34, icon = "brand", color = null, className = "" }) {
  return (
    <span
      className={`brand-mark ${color ? "has-color" : ""} ${className}`.replace(/\s+/g, " ").trim()}
      style={{ "--mark-size": `${size}px`, ...(color ? { "--mark-color": color } : {}) }}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 24 24"
        width="60%"
        height="60%"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        focusable="false"
      >
        {drawing(icon) || drawing("brand")}
      </svg>
    </span>
  );
}
