import { useCallback, useState } from "react";

// How one person likes one list laid out — column widths, hidden columns,
// row height, rows per page — kept in this browser under the grid's id.
//
// Storage can be missing (a private window), full, or blocked by policy. Any
// of those simply means the layout is not remembered: every read and write is
// wrapped, and the grid works the same without it.

const PREFIX = "rmp.grid.";
const VERSION = 1;

const read = (id) => {
  if (!id) {
    return {};
  }

  try {
    const saved = JSON.parse(window.localStorage.getItem(PREFIX + id) || "null");
    return saved && typeof saved === "object" && saved.v === VERSION ? saved : {};
  } catch {
    return {};
  }
};

const write = (id, layout) => {
  if (!id) {
    return;
  }

  try {
    window.localStorage.setItem(PREFIX + id, JSON.stringify({ ...layout, v: VERSION }));
  } catch {
    // Not remembered this time; nothing on screen depends on it.
  }
};

// The rows-per-page this viewer last chose on the grid `id`, for a page that
// pages on the server and wants to ask the API for the right number from the
// first request (the grid would otherwise ask again once it has mounted).
//   const [limit, setLimit] = useState(() => rememberedPageSize("activity-log", 25));
export const rememberedPageSize = (id, fallback = 25, sizes = [25, 50, 100]) => {
  const saved = read(id).pageSize;
  return sizes.includes(saved) ? saved : fallback;
};

export default function useGridLayout(id) {
  const [layout, setLayout] = useState(() => read(id));

  // update({ density: "compact" }) merges; update((current) => next) replaces.
  const update = useCallback(
    (change) => {
      setLayout((current) => {
        const next = typeof change === "function" ? change(current) : { ...current, ...change };
        write(id, next);
        return next;
      });
    },
    [id]
  );

  return [layout, update];
}
