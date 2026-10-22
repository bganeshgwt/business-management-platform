import { useEffect, useLayoutEffect, useRef } from "react";

// Keeps keyboard focus inside a dialog while it is open — the rule every
// modal layer (Modal, ConfirmDialog, SidePanel) shares:
//
//   const box = useRef(null);
//   const { onKeyDown, isTop } = useFocusTrap(box, open, { initialFocus: "field" });
//   <div ref={box} role="dialog" tabIndex={-1} onKeyDown={onKeyDown}>…</div>
//
// - On open focus moves in: to the first form field ("field", the default
//   for forms — falling back to the dialog itself), the first control
//   ("first") or the dialog box ("container").
//   An element marked data-autofocus wins over all of these.
// - Tab from the last control comes back to the first (and Shift+Tab the
//   other way); focus that wanders onto the page behind is brought back.
// - On close focus goes back to whatever opened it.
//
// Layers stack: a ConfirmDialog opened from a form dialog is the top layer,
// and only the top layer traps, takes Escape (isTop()) or pulls focus back.
// Other kinds of overlay — the manager-PIN prompt, the lock screen, menus
// and pickers rendered on <body> — are left alone when they take focus.

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const FIELDS = 'input:not([disabled]):not([type="hidden"]):not([readonly]), select:not([disabled]), textarea:not([disabled]):not([readonly])';

// Focus may go here without the trap pulling it back.
const ALLOWED_OUTSIDE =
  ".acc-overlay, .acc-lock, .action-menu, .dg-colmenu, [role='menu'], [role='listbox'], .search-picker-list, .toaster, [data-focus-trap-allow]";

export const focusableIn = (root) =>
  Array.from(root.querySelectorAll(FOCUSABLE)).filter(
    (node) => node.offsetParent !== null || node === document.activeElement || getComputedStyle(node).position === "fixed"
  );

// The open layers, oldest first. Module scope: one stack for the page.
const stack = [];

const visible = (node) => node && (node.offsetParent !== null || getComputedStyle(node).position === "fixed");

export default function useFocusTrap(ref, active = true, { initialFocus = "field", returnFocus = true } = {}) {
  const token = useRef(null);
  if (token.current === null) {
    token.current = {};
  }

  const isTop = () => stack[stack.length - 1] === token.current;

  // Who opened the layer, read while rendering — before a field inside it
  // takes focus with autoFocus (which happens before any effect runs).
  const openerRef = useRef(null);
  const wasActive = useRef(false);
  if (active && !wasActive.current && typeof document !== "undefined") {
    const current = document.activeElement;
    openerRef.current = current instanceof HTMLElement && current !== document.body ? current : null;
  }
  wasActive.current = active;

  // Join the stack, move focus in; on close leave it and give focus back.
  useLayoutEffect(() => {
    if (!active) {
      return undefined;
    }

    const me = token.current;
    stack.push(me);
    const node = ref.current;
    const opener =
      openerRef.current && !(node && node.contains(openerRef.current))
        ? openerRef.current
        : document.activeElement instanceof HTMLElement && !(node && node.contains(document.activeElement))
          ? document.activeElement
          : null;

    if (node && !node.contains(document.activeElement)) {
      const marked = node.querySelector("[data-autofocus]");
      let target = null;

      if (marked && visible(marked)) {
        target = marked;
      } else if (initialFocus === "field") {
        target = Array.from(node.querySelectorAll(FIELDS)).find(visible) || null;
      } else if (initialFocus === "first") {
        target = focusableIn(node).find((item) => !item.classList.contains("modal-close")) || null;
      }

      (target || node).focus({ preventScroll: true });
    }

    return () => {
      const index = stack.lastIndexOf(me);
      if (index !== -1) {
        stack.splice(index, 1);
      }

      if (!returnFocus || !opener || !opener.isConnected) {
        return;
      }

      // Only when focus is still in (or lost from) the layer: a click that
      // closed it by moving elsewhere keeps its own focus.
      const current = document.activeElement;
      if (!current || current === document.body || (node && node.contains(current))) {
        opener.focus({ preventScroll: true });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Focus that wanders onto the page behind comes back.
  useEffect(() => {
    if (!active) {
      return undefined;
    }

    const onFocusIn = (event) => {
      const node = ref.current;
      const target = event.target;

      if (!node || !isTop() || !(target instanceof Node) || node.contains(target)) {
        return;
      }

      if (target instanceof Element && target.closest(ALLOWED_OUTSIDE)) {
        return;
      }

      node.focus({ preventScroll: true });
    };

    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const onKeyDown = (event) => {
    if (event.key !== "Tab" || !ref.current || !isTop()) {
      return;
    }

    const items = focusableIn(ref.current);

    if (items.length === 0) {
      event.preventDefault();
      return;
    }

    const first = items[0];
    const last = items[items.length - 1];

    if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return { onKeyDown, isTop };
}
