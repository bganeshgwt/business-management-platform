import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "@bmp/ui/Icon";

// "Columns": which columns show, how tall rows are, and a way back to the
// list as it was designed. A small non-modal panel drawn on document.body
// (like ActionMenu) so the grid's own sideways scrolling never clips it.
// Escape or a click elsewhere closes it; focus goes back to the button.

const PANEL_WIDTH = 264;

export default function GridColumnMenu({ items, density, onToggle, onDensity, onReset }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const panelId = useId();

  const visibleCount = items.filter((item) => !item.hidden).length;

  const close = (restoreFocus = true) => {
    setOpen(false);

    if (restoreFocus) {
      triggerRef.current?.focus();
    }
  };

  const show = () => {
    const box = triggerRef.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(box.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - 8));
    setPlace({ top: box.bottom + 6, left, maxHeight: Math.max(220, window.innerHeight - box.bottom - 18) });
    setOpen(true);
  };

  // Open upwards when there is no room below (a short grid low on the page).
  useLayoutEffect(() => {
    if (!open || !panelRef.current || !triggerRef.current) {
      return;
    }

    const box = triggerRef.current.getBoundingClientRect();
    const height = panelRef.current.offsetHeight;

    if (box.bottom + 6 + height > window.innerHeight - 8 && box.top - 6 - height > 8) {
      panelRef.current.style.top = `${box.top - 6 - height}px`;
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    panelRef.current?.querySelector("input:not(:disabled), button")?.focus({ preventScroll: true });

    const onPointerDown = (event) => {
      if (!panelRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };

    const onAway = (event) => {
      if (event.type === "scroll" && panelRef.current?.contains(event.target)) {
        return;
      }

      setOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onAway, true);
    window.addEventListener("resize", onAway);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onAway, true);
      window.removeEventListener("resize", onAway);
    };
  }, [open]);

  const onPanelKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }

    // Tabbing past either end leaves the panel the way it came in: back to
    // the button, rather than off into the browser's own toolbar.
    if (event.key === "Tab") {
      const focusable = [...panelRef.current.querySelectorAll("input:not(:disabled), button:not(:disabled)")];
      const edge = event.shiftKey ? focusable[0] : focusable[focusable.length - 1];

      if (document.activeElement === edge) {
        event.preventDefault();
        close();
      }
    }
  };

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={`button button-secondary dg-tool ${open ? "is-open" : ""}`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="dialog"
        onClick={() => (open ? close() : show())}
      >
        <Icon name="sliders" size={15} />
        <span className="dg-tool-word">Columns</span>
      </button>

      {open &&
        place &&
        createPortal(
          <div
            id={panelId}
            ref={panelRef}
            className="dg-menu"
            role="dialog"
            aria-label="Columns and row height"
            style={{ top: place.top, left: place.left, width: PANEL_WIDTH, maxHeight: place.maxHeight }}
            onKeyDown={onPanelKeyDown}
          >
            <fieldset className="dg-menu-group">
              <legend>Show columns</legend>
              {items.map((item) => (
                <label key={item.key} className={`dg-menu-check ${item.hideable ? "" : "is-fixed"}`}>
                  <input
                    type="checkbox"
                    checked={!item.hidden}
                    // The column that names each row, and the last one left,
                    // always stay: a list of nothing is not a list.
                    disabled={!item.hideable || (!item.hidden && visibleCount <= 1)}
                    onChange={() => onToggle(item.key)}
                  />
                  <span>{item.label}</span>
                  {!item.hideable && <span className="dg-menu-note">always shown</span>}
                </label>
              ))}
            </fieldset>

            <fieldset className="dg-menu-group">
              <legend>Row height</legend>
              <div className="segmented dg-menu-density" role="radiogroup" aria-label="Row height">
                {[
                  ["comfortable", "Comfortable"],
                  ["compact", "Compact"],
                ].map(([value, word]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={density === value}
                    className={`segment ${density === value ? "is-active" : ""}`}
                    onClick={() => onDensity(value)}
                  >
                    {word}
                  </button>
                ))}
              </div>
            </fieldset>

            <button
              type="button"
              className="button button-ghost dg-menu-reset"
              onClick={() => {
                onReset();
                close();
              }}
            >
              <Icon name="undo" size={15} /> Reset layout
            </button>
          </div>,
          document.body
        )}
    </>
  );
}
