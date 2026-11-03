import { drawing } from "@bmp/ui/drawings";

// One small mark per menu entry: the sidebar's, the pinned pages' and a page's
// tabs'. The drawings are the shared set's (@bmp/ui menuIcons.jsx): the menu's
// own where it has one, else the screens' (a pill, a car), so an entry may name
// either.
//
// Everything is stroked in currentColor, so an icon takes the colour of the
// link it sits in — including the accent when that link is the page you are
// on — with no second rule to keep in step.
export default function NavIcon({ name }) {
  const shape = drawing(name, { menu: true });

  if (!shape) {
    return null;
  }

  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      // The label is right beside it; a screen reader should not hear both.
      aria-hidden="true"
      focusable="false"
    >
      {shape}
    </svg>
  );
}
