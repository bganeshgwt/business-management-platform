// The parts of the row-action menu that are arithmetic rather than markup:
// where it opens, and how the arrow keys move through it. Kept apart from the
// component so both can be read — and tested — on their own.

export const MENU_WIDTH = 190;
const ITEM_HEIGHT = 34;
const EDGE_GAP = 8;

// The next stop in the given direction. Separators and disabled entries are
// skipped rather than focused, and both ends wrap, which is what a menu does.
// Returns where it started if nothing is selectable, so this cannot spin.
export const nextIndex = (items, from, step) => {
  const count = items.length;

  for (let moved = 1; moved <= count; moved += 1) {
    const at = (((from + step * moved) % count) + count) % count;

    if (!items[at].separator && !items[at].disabled) {
      return at;
    }
  }

  return from;
};

export const firstIndex = (items) => nextIndex(items, -1, 1);
export const lastIndex = (items) => nextIndex(items, 0, -1);

// Opens downward unless the menu would fall off the bottom, in which case it
// opens upward. Coordinates are for position: fixed, measured against the
// viewport, because the menu is drawn in a portal rather than inside the row.
export const placeMenu = (rect, itemCount, viewport) => {
  const height = itemCount * ITEM_HEIGHT + 12;
  const roomBelow = viewport.height - rect.bottom;
  const dropUp = roomBelow < height + EDGE_GAP && rect.top > height + EDGE_GAP;

  // Right edges aligned, because the trigger sits at the end of the row; then
  // pulled back inside the window if that would hang off either edge.
  const left = Math.max(
    EDGE_GAP,
    Math.min(rect.right - MENU_WIDTH, viewport.width - MENU_WIDTH - EDGE_GAP)
  );

  return {
    left,
    top: dropUp ? rect.top - height - 4 : rect.bottom + 4,
    dropUp,
  };
};
