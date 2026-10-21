import { useEffect, useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";
import usePresence from "../hooks/usePresence";
import "../styles/side-panel.css";

// A panel that slides in from the right over the screen, for the detail
// behind something on it, without leaving it: the dashboard's "show me the
// 4 late tickets" opens here instead of on the kitchen screen.
//
//   <SidePanel open={Boolean(key)} title="Kitchen tickets late" count={4}
//              rule="Tickets not ready 20 minutes after they were sent"
//              icon="chef" onClose={close} footer={<Link …>Open full page</Link>}>
//     …a DataGrid…
//   </SidePanel>
//
// Desktop: a drawer about 760px wide over a dimmed page. Phones (≤640px):
// a full-screen sheet. Escape, the dimmed page and the × close it; focus moves
// into it on open, Tab stays inside it, and focus goes back to whatever opened
// it on close. Dialogs opened from inside it (a bill, the manager PIN) sit on
// top of it, and Escape then closes only them.
//
// Rendered on <body> (a portal), so nothing on the page can clip it. A dialog
// opened from the panel's content must also go to <body>: the drawer moves in
// with a transform, and a transformed box would trap a fixed dialog inside it.
//
// open     whether it shows; it slides out for a moment after this turns false
// title    the heading; `count` is drawn after it as a quiet badge
// rule     one line saying exactly what is counted
// toolbar  a row under the heading (segmented views, a date)
// footer   the bar along the bottom ("Open full page →")
const LAYERS_ABOVE = ".modal-backdrop, .acc-overlay, .acc-lock, .confirm-backdrop";

const focusable = (root) =>
  Array.from(
    root.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((node) => node.offsetParent !== null || node === document.activeElement);

// wide: nearly the whole screen, for a full working screen opened over a
// page (the business Overview opens Quick bill or a purchase this way).
export default function SidePanel({ open, title, count, rule, icon, toolbar, footer, onClose, children, label, wide = false }) {
  const presence = usePresence(open, 200);
  const drawer = useRef(null);
  const returnTo = useRef(null);
  const closeRef = useRef(onClose);
  const titleId = useId();
  const ruleId = useId();

  useLayoutEffect(() => {
    closeRef.current = onClose;
  });

  // Where focus was when the panel opened, to give it back on close.
  useLayoutEffect(() => {
    if (!open) {
      return undefined;
    }

    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = drawer.current;

    if (node && !node.contains(document.activeElement)) {
      node.focus({ preventScroll: true });
    }

    return () => {
      const back = returnTo.current;
      returnTo.current = null;

      // Only when focus is still in (or lost from) the panel: a click that
      // closed it by moving elsewhere keeps its own focus.
      if (back && back.isConnected) {
        const active = document.activeElement;

        if (!active || active === document.body || (node && node.contains(active))) {
          back.focus({ preventScroll: true });
        }
      }
    };
  }, [open]);

  // Escape closes the panel, unless a dialog opened from it is on top: then
  // that dialog takes the key (it closes itself on the same press).
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const onKeyDown = (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }

      if (document.querySelector(LAYERS_ABOVE)) {
        return;
      }

      // An open column menu or action menu inside the panel closes first.
      if (event.target instanceof Element && event.target.closest(".action-menu, .dg-colmenu, [role='menu']")) {
        return;
      }

      closeRef.current();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Focus stays inside: Tab from the last control comes back to the first,
  // and focus that wanders onto the page behind is brought back (a dialog
  // above the panel keeps its own).
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const onFocusIn = (event) => {
      const node = drawer.current;
      const target = event.target;

      if (!node || !(target instanceof Node) || node.contains(target)) {
        return;
      }

      if (target instanceof Element && target.closest(`${LAYERS_ABOVE}, [role='dialog'], [role='menu'], .dg-colmenu`)) {
        return;
      }

      node.focus({ preventScroll: true });
    };

    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [open]);

  // The page behind does not scroll under the panel.
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const root = document.documentElement;
    root.classList.add("has-side-panel");
    return () => root.classList.remove("has-side-panel");
  }, [open]);

  const onKeyDown = (event) => {
    if (event.key !== "Tab" || !drawer.current) {
      return;
    }

    const items = focusable(drawer.current);

    if (items.length === 0) {
      event.preventDefault();
      return;
    }

    const first = items[0];
    const last = items[items.length - 1];

    if (event.shiftKey && (document.activeElement === first || document.activeElement === drawer.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!presence.mounted || typeof document === "undefined") {
    return null;
  }

  const leaving = presence.leaving;

  return createPortal(
    <div
      className={`side-panel-root ${leaving ? "is-leaving" : ""}`}
      data-motion-layer
      aria-hidden={leaving || undefined}
      inert={leaving || undefined}
    >
      <div className="side-panel-backdrop" onMouseDown={() => closeRef.current()} aria-hidden="true" />
      <aside
        ref={drawer}
        className={`side-panel ${wide ? "is-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={rule ? ruleId : undefined}
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="side-panel-head">
          {icon && (
            <span className="side-panel-icon" aria-hidden="true">
              <Icon name={icon} size={18} />
            </span>
          )}
          <div className="side-panel-titles">
            {/* The title first, the count after it as a quiet badge: "Floor 25",
                not "122 Floor". */}
            <h2 id={titleId} className="side-panel-title">
              <span>{title}</span>
              {count !== undefined && count !== null && (
                <span className="side-panel-count" data-testid="side-panel-count">
                  {count}
                </span>
              )}
            </h2>
            {rule && (
              <p id={ruleId} className="side-panel-rule">
                {rule}
              </p>
            )}
          </div>
          <button type="button" className="icon-button modal-close" onClick={() => closeRef.current()} aria-label="Close">
            <Icon name="x" size={18} />
          </button>
        </header>
        {toolbar && <div className="side-panel-tools">{toolbar}</div>}
        <div className="side-panel-body">{children}</div>
        {footer && <footer className="side-panel-foot">{footer}</footer>}
      </aside>
    </div>,
    document.body
  );
}
