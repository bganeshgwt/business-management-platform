import { useEffect, useId, useLayoutEffect, useRef } from "react";
import Icon from "./Icon";
import { leaveBackdrop } from "./motion";
import useFocusTrap from "../hooks/useFocusTrap";

// A simple dialog used by every add/edit form. Escape closes it, and clicking
// the dark background closes it too.
//
// Optional, for new screens: `description` (a line under the title), `icon`
// (an Icon name beside it) and `footer` (buttons in a bar along the bottom).
// Existing forms that end in their own .form-actions get the same bar look
// from the stylesheet, so nothing had to change to use it.
//
// Keyboard (hooks/useFocusTrap): focus moves to the first field on open (or
// to an element marked data-autofocus; `initialFocus="container"` keeps it
// on the dialog), Tab stays inside the dialog, and focus goes back to the
// button that opened it on close. A dialog opened on top of another one
// takes Escape and Tab for itself. `dismissible={false}` (e.g. while a save
// is running) ignores Escape and the backdrop; the × still shows, disabled.
//
// Layout: the title bar stays put, the body scrolls, and the form's last
// .form-actions row (or `footer`) sticks to the bottom, so Save is always in
// reach. Under 640px wide the dialog is a full-screen sheet.
//
// Motion (motion.css): the backdrop fades in with its blur and the dialog
// scales and rises in. On close the dialog goes at once — the page behind is
// usable immediately — and the dimmed backdrop fades away for a moment
// behind it (an empty layer that takes no clicks).
export default function Modal({
  title,
  onClose,
  children,
  width = 520,
  description,
  icon,
  footer,
  initialFocus = "field",
  dismissible = true,
  className = "",
}) {
  const box = useRef(null);
  const headingId = useId();
  const descriptionId = useId();
  const closeRef = useRef(onClose);
  const dismissRef = useRef(dismissible);

  useLayoutEffect(() => {
    closeRef.current = onClose;
    dismissRef.current = dismissible;
  });

  // On a phone, jumping into the first field throws the keyboard over the
  // form before it has been read: there the dialog itself takes focus.
  const coarse = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
  const { onKeyDown, isTop } = useFocusTrap(box, true, { initialFocus: coarse ? "container" : initialFocus });

  useEffect(() => {
    const onDocumentKeyDown = (event) => {
      if (event.key !== "Escape" || event.defaultPrevented || !isTop()) {
        return;
      }

      // The manager-PIN prompt or the lock screen above this dialog takes it.
      if (document.querySelector(".acc-overlay, .acc-lock")) {
        return;
      }

      // An open menu or picker list inside the dialog closes first.
      if (event.target instanceof Element && event.target.closest("[role='menu'], .action-menu, .search-picker.is-open")) {
        return;
      }

      if (dismissRef.current) {
        closeRef.current();
      }
    };

    document.addEventListener("keydown", onDocumentKeyDown);
    return () => document.removeEventListener("keydown", onDocumentKeyDown);
    // isTop reads a ref-backed stack; it never changes identity in a way that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The fading backdrop left behind on close. In development React rehearses
  // an unmount and remount straight after the first mount; the remount takes
  // back the backdrop that rehearsal left, before anything is painted.
  const ghost = useRef(null);
  useLayoutEffect(() => {
    ghost.current?.();
    ghost.current = null;
    return () => {
      ghost.current = leaveBackdrop();
    };
  }, []);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && dismissRef.current) {
          closeRef.current();
        }
      }}
    >
      <div
        ref={box}
        className={`modal ${className}`.trim()}
        style={{ maxWidth: width }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          {icon && (
            <span className="modal-head-icon" aria-hidden="true">
              <Icon name={icon} size={18} />
            </span>
          )}
          <div className="modal-head-text">
            <h2 id={headingId}>{title}</h2>
            {description && (
              <p id={descriptionId} className="muted small">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            className="icon-button modal-close"
            onClick={() => dismissRef.current && closeRef.current()}
            disabled={!dismissible}
            aria-label="Close"
          >
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
