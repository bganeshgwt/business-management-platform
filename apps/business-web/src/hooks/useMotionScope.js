import { useLayoutEffect, useRef } from "react";
import { MOTION, motionAllowed, play } from "../components/motion";

// The motion that every screen gets without a line of its own, set up once
// by the app layout around the page area:
//
//   1. Page transition — when the route changes, the page area fades and
//      rises in. The top bar and sidebar stay still.
//   2. Entrances — the page header, stat tiles, cards, table rows and the
//      shared list rows cascade in, a few dozen milliseconds apart, the first
//      time they appear on screen: when a screen opens, or as the result of
//      something the person just did (a click, Enter). A background refresh
//      never replays them — a figure that changes there is <LiveValue>'s job.
//      What arrives below the fold just appears.
//   3. Sliding indicators — on segmented controls (.segmented > .segment),
//      tab rows (.tab-row > .tab) and any bar marked data-motion-tabs, the
//      selected pill glides from the old choice to the new one.
//   4. Still ground for dialogs — a dialog or other full-screen layer that
//      opens while the page (or a card around it) is still moving in makes
//      that movement finish at once, so the layer covers the whole screen
//      from its first frame instead of sitting on the page area and jumping.
//
// How the cascade works: a MutationObserver on the page area marks elements
// inserted while an "entrance window" is open with data-motion-enter and a
// --motion-delay; motion.css animates [data-motion-enter]. The window opens
// on a route change (a few seconds, for the data to arrive) and briefly on
// each click, Enter/Space or choice in a select inside the page — never for
// a click into a text field or for typing. The mark is removed when the
// animation ends. An element that already has an animation of its own (a
// page's "new ticket" flash) is left alone.

// What cascades. Pages can opt more in with class="motion-item" or a
// data-motion-item attribute; data-motion-skip on a container opts out.
const ENTER_SELECTOR = [
  ".page-header",
  ".stat-tile",
  ".card",
  ".tile",
  ".table > tbody > tr",
  ".attention-row",
  ".empty-state",
  ".floor-table",
  ".open-orders > li",
  ".motion-item",
  "[data-motion-item]",
].join(", ");

const BLOCK_SELECTOR = ".card, .tile";
const ENTER_NAMES = new Set(["motion-rise", "motion-row-in"]);
// No more than this many items move per insertion.
const MAX_ITEMS = 30;
// Only what is on screen when it arrives moves; anything further than this
// beyond the edge of the window simply appears. Nobody sees an entrance below
// the fold, and a moving element there would switch off the browser's scroll
// anchoring — content loading higher up would then push the view about.
const SCREEN_MARGIN = 48;
// How many candidates are measured per insertion before giving up (a list of
// thousands of rows only needs its first screenful looked at).
const MAX_CHECKS = 400;
// The cascade steps up to this many items, then the rest arrive together.
const MAX_STEPS = 8;
const ROUTE_WINDOW_MS = 4000;
const ACTION_WINDOW_MS = 2500;

// The selected pill of a tab bar or segmented control.
const TAB_ITEM = ".segmented > .segment, .tab-row > .tab, [data-motion-tabs] > *";

// Layers that cover the whole screen (position: fixed) and can be drawn
// inside the page area: a dialog's dimmed backdrop, the till's bottom sheet,
// the kitchen's full-screen mode, toasts. While anything around such a layer
// is moving — the page area rising in, a card cascading in — the browser
// measures the layer against that moving box instead of the screen: the dim
// would cover only the page area and the dialog sit low, then jump into
// place when the movement ended. So when one appears, everything around it
// comes to rest first (bringToRest). Pages can mark their own full-screen
// layers with data-motion-layer.
const SCREEN_LAYERS = [
  ".modal-backdrop",
  ".pos-sheet",
  ".kds.is-focus",
  ".kds-toast",
  ".dlv-toast",
  ".g-sheet-backdrop",
  ".g-cartbar",
  ".g-toast",
  "[data-motion-layer]",
].join(", ");

// How long after something starts to move it may still be moving: the
// longest cascade (8 steps, then the entrance itself), with a margin.
const SETTLE_MS = (MAX_STEPS + 1) * MOTION.stagger + MOTION.enter + 80;

// A screen layer among freshly added nodes, if there is one. The known
// layers are found by class; an unknown one is caught by its computed
// position, looked up only for the first few nodes (a burst of a thousand
// table rows is not a dialog opening).
const LOOKUPS = 24;

const findLayer = (nodes) => {
  let lookups = 0;

  for (const node of nodes) {
    if (!(node instanceof Element)) {
      continue;
    }

    if (node.matches(SCREEN_LAYERS)) {
      return node;
    }

    const inside = node.querySelector(SCREEN_LAYERS);

    if (inside) {
      return inside;
    }

    if (lookups < LOOKUPS) {
      lookups += 1;

      if (window.getComputedStyle(node).position === "fixed") {
        return node;
      }
    }
  }

  return null;
};

const MOVES_THE_BOX = /^(transform|translate|scale|rotate|filter|perspective)$/;

const movesTheBox = (animation) => {
  try {
    return (
      animation.effect.getTiming().iterations !== Infinity &&
      animation.effect.getKeyframes().some((frame) => Object.keys(frame).some((key) => MOVES_THE_BOX.test(key)))
    );
  } catch {
    return false;
  }
};

// Everything between a screen layer and the page area's scroller stops
// moving at once — an entrance mark is dropped, the page area's rise and any
// other movement of a box around it is finished — so the layer is measured
// against the screen from its very first frame. This runs before the browser
// paints the layer; the page under it simply skips the last few pixels of
// its rise as the dialog's dim starts to cover it.
const bringToRest = (layer, scroller) => {
  for (let node = layer.parentElement; node && node !== scroller; node = node.parentElement) {
    if (node.hasAttribute("data-motion-enter")) {
      node.removeAttribute("data-motion-enter");
      node.style.removeProperty("--motion-delay");
    }

    for (const animation of node.getAnimations()) {
      if (movesTheBox(animation)) {
        try {
          animation.finish();
        } catch {
          // Already gone.
        }
      }
    }
  }
};

const isTypingTarget = (node) =>
  node instanceof Element && node.closest("input, textarea, select, [contenteditable='true']") !== null;

// Fields that take typed text. A click or tap into one of them (or on its
// label) is the start of typing, not an action: it must not open an entrance
// window, or a list narrowed by the next few keystrokes — its rows, its
// "nothing matches" — would rise in under the person's fingers.
const TEXT_ENTRY = [
  "textarea",
  "[contenteditable='']",
  "[contenteditable='true']",
  "input:not([type])",
  "input[type='text']",
  "input[type='search']",
  "input[type='email']",
  "input[type='number']",
  "input[type='tel']",
  "input[type='url']",
  "input[type='password']",
].join(", ");

const isTextEntry = (node) => {
  if (!(node instanceof Element)) {
    return false;
  }

  if (node.closest(TEXT_ENTRY)) {
    return true;
  }

  const control = node.closest("label")?.control;
  return Boolean(control && control.matches(TEXT_ENTRY));
};

const hasOwnAnimation = (node) => {
  const name = window.getComputedStyle(node).animationName;
  return Boolean(name) && name !== "none";
};

const onScreen = (node) => {
  const box = node.getBoundingClientRect();

  return (
    (box.width > 0 || box.height > 0) &&
    box.bottom > -SCREEN_MARGIN &&
    box.top < window.innerHeight + SCREEN_MARGIN
  );
};

// Marks the elements in `roots` that should cascade in, in document order.
// Returns how many were marked.
const markEntrances = (roots) => {
  let step = 0;
  let count = 0;
  let checks = 0;

  for (const root of roots) {
    if (!(root instanceof Element) || root.closest("[data-motion-skip]")) {
      continue;
    }

    const found = root.matches(ENTER_SELECTOR) ? [root] : [];
    found.push(...root.querySelectorAll(ENTER_SELECTOR));

    for (const node of found) {
      if (count >= MAX_ITEMS || checks >= MAX_CHECKS) {
        return count;
      }

      if (node.hasAttribute("data-motion-enter") || node.closest("[data-motion-skip]")) {
        continue;
      }

      checks += 1;

      if (!onScreen(node)) {
        continue;
      }

      // A card inside a card that is already rising would rise twice.
      if (node.matches(BLOCK_SELECTOR) && node.parentElement?.closest("[data-motion-enter]")?.matches(BLOCK_SELECTOR)) {
        continue;
      }

      if (hasOwnAnimation(node)) {
        continue;
      }

      node.style.setProperty("--motion-delay", `${Math.min(step, MAX_STEPS) * MOTION.stagger}ms`);
      node.setAttribute("data-motion-enter", "");
      step += 1;
      count += 1;
    }
  }

  return count;
};

const clearEntrance = (event) => {
  const node = event.target;

  if (event.pseudoElement || !ENTER_NAMES.has(event.animationName) || !node.hasAttribute?.("data-motion-enter")) {
    return;
  }

  node.removeAttribute("data-motion-enter");
  node.style.removeProperty("--motion-delay");
};

const isActive = (node) =>
  node.classList.contains("is-active") ||
  node.classList.contains("active") ||
  node.getAttribute("aria-selected") === "true" ||
  node.getAttribute("aria-checked") === "true";

const wasActive = (record) => {
  if (record.attributeName === "class") {
    return /(^|\s)(is-active|active)(\s|$)/.test(record.oldValue || "");
  }

  return record.oldValue === "true";
};

// Moves the new pill so it starts exactly over the old one, then lets it go.
const slidePill = (from, to) => {
  if (window.getComputedStyle(to, "::before").content === "none") {
    return;
  }

  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();

  if (!a.width || !b.width || !a.height || !b.height) {
    return;
  }

  const dx = a.left - b.left;
  const dy = a.top - b.top;
  const sx = a.width / b.width;
  const sy = a.height / b.height;

  play(
    to,
    [{ transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, { transform: "none" }],
    { duration: MOTION.slide, pseudoElement: "::before" }
  );
};

const slideTabs = (records) => {
  if (!motionAllowed()) {
    return;
  }

  // Each element once, remembering whether it was the selected one.
  const touched = new Map();

  for (const record of records) {
    const node = record.target;

    if (node.nodeType === 1 && node.matches(TAB_ITEM)) {
      touched.set(node, touched.get(node) || wasActive(record));
    }
  }

  if (touched.size < 2) {
    return;
  }

  const bars = new Map();

  for (const [node, was] of touched) {
    const list = bars.get(node.parentElement) || [];
    list.push({ node, was });
    bars.set(node.parentElement, list);
  }

  for (const items of bars.values()) {
    const to = items.find((item) => !item.was && isActive(item.node));
    const from = items.find((item) => item.was && !isActive(item.node));

    if (to && from) {
      slidePill(from.node, to.node);
    }
  }
};

export default function useMotionScope(scrollRef, contentRef, routeKey) {
  const windowUntil = useRef(0);
  // Until when something in the page area may still be moving (the page
  // rising in, a cascade), so a screen layer that appears meanwhile can be
  // given a still page to sit on.
  const movingUntil = useRef(0);

  // Entrances: watch the page area for new content while a window is open.
  useLayoutEffect(() => {
    const root = scrollRef.current;

    if (!root || typeof MutationObserver === "undefined") {
      return undefined;
    }

    const observer = new MutationObserver((records) => {
      const now = performance.now();
      const entering = now <= windowUntil.current;

      if ((!entering && now > movingUntil.current) || !motionAllowed()) {
        return;
      }

      const added = [];

      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1 && node.isConnected) {
            added.push(node);
          }
        }
      }

      if (added.length === 0) {
        return;
      }

      if (entering && markEntrances(added) > 0) {
        movingUntil.current = Math.max(movingUntil.current, now + SETTLE_MS);
      }

      // A dialog (or another full-screen layer) opening while things move —
      // a quick click just after a page change, or a page that opens a
      // dialog by itself as soon as its data arrives.
      if (now <= movingUntil.current) {
        const layer = findLayer(added);

        if (layer) {
          bringToRest(layer, root);
        }
      }
    });

    const open = (ms) => {
      windowUntil.current = Math.max(windowUntil.current, performance.now() + ms);
    };
    // A click on a button, a tab, a pager, a select — not into a text field.
    const onPointer = (event) => {
      if (!isTextEntry(event.target)) {
        open(ACTION_WINDOW_MS);
      }
    };
    // Typing into a search box filters a list; rows reappearing on every
    // keystroke should not dance, so only activation keys count.
    const onKey = (event) => {
      if ((event.key === "Enter" || event.key === " ") && !isTypingTarget(event.target)) {
        open(ACTION_WINDOW_MS);
      }
    };
    // A choice made in a select, a date or a tick box is an action too, even
    // when the list of options stayed open longer than the click's window.
    const onChange = (event) => {
      if (!isTextEntry(event.target)) {
        open(ACTION_WINDOW_MS);
      }
    };

    observer.observe(root, { childList: true, subtree: true });
    root.addEventListener("pointerdown", onPointer, true);
    root.addEventListener("keydown", onKey, true);
    root.addEventListener("change", onChange, true);
    root.addEventListener("animationend", clearEntrance);
    root.addEventListener("animationcancel", clearEntrance);

    return () => {
      observer.disconnect();
      root.removeEventListener("pointerdown", onPointer, true);
      root.removeEventListener("keydown", onKey, true);
      root.removeEventListener("change", onChange, true);
      root.removeEventListener("animationend", clearEntrance);
      root.removeEventListener("animationcancel", clearEntrance);
    };
  }, [scrollRef]);

  // Page transition, and a fresh entrance window for the new page.
  useLayoutEffect(() => {
    const node = contentRef.current;
    const now = performance.now();
    windowUntil.current = now + ROUTE_WINDOW_MS;

    if (!node || !motionAllowed()) {
      return undefined;
    }

    // What is already on screen (the first page after signing in, or a
    // screen that rendered in the same commit as the route change).
    const marked = markEntrances([node]);

    // A dialog or full-screen layer already open on the new page brings its
    // own entrance; the page under it arrives still, so the layer is
    // measured against the screen — and drawn over the top bar — from its
    // first frame. (Even a fade alone would hold it under the top bar.)
    const layer = node.querySelector(SCREEN_LAYERS);

    if (layer) {
      bringToRest(layer, scrollRef.current);
      movingUntil.current = Math.max(movingUntil.current, marked > 0 ? now + SETTLE_MS : 0);
      return undefined;
    }

    movingUntil.current = Math.max(movingUntil.current, now + Math.max(MOTION.page + 80, marked > 0 ? SETTLE_MS : 0));

    const animation = play(
      node,
      [
        { opacity: 0, transform: "translateY(10px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: MOTION.page }
    );

    return () => animation?.cancel();
  }, [contentRef, scrollRef, routeKey]);

  // Sliding indicators, anywhere in the document (dialogs are often portals).
  useLayoutEffect(() => {
    if (typeof MutationObserver === "undefined") {
      return undefined;
    }

    const observer = new MutationObserver(slideTabs);
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ["class", "aria-selected", "aria-checked"],
    });

    return () => observer.disconnect();
  }, []);
}
