import { useCallback, useEffect, useLayoutEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { firstIndex, lastIndex, MENU_WIDTH, nextIndex, placeMenu } from "./actionMenuLogic.js";
import Icon from "./Icon";

// A "⋯" menu for the actions on a table row. Items are
// { label, onClick, danger?, disabled?, icon? } or { separator: true }.
//
// Rows with five underlined links turn the right-hand side of a long table
// into a wall of text, and put Delete one careless click from Edit. Everything
// rare goes in here instead.
//
// Two things make this fiddly enough to be worth sharing:
//
//   * The table scrolls sideways (.table-wrap has overflow-x: auto), so a menu
//     rendered inside the row would be clipped by it. It is drawn in a portal
//     on document.body and positioned against the trigger instead.
//   * A menu that cannot be driven from the keyboard is not a menu. Arrows,
//     Home/End, Escape and Tab all behave the way a menu is expected to.

//
// `text` turns the "⋯" into a labelled button ("More ▾") — the page header's
// More menu (PageHeader `more`).
export default function ActionMenu({ items, label = "More actions", text }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(null);
  const [active, setActive] = useState(-1);

  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const itemRefs = useRef([]);
  const anchorRef = useRef(null);
  const menuId = useId();

  const usable = items.filter((item) => !item.separator);

  const close = useCallback(
    ({ restoreFocus = true } = {}) => {
      setOpen(false);
      setActive(-1);

      if (restoreFocus && triggerRef.current) {
        triggerRef.current.focus();
      }
    },
    []
  );

  const show = useCallback(
    (startAt) => {
      const rect = triggerRef.current.getBoundingClientRect();
      anchorRef.current = { top: rect.top, left: rect.left };

      setPosition(
        placeMenu(rect, usable.length, {
          width: window.innerWidth,
          height: window.innerHeight,
        })
      );
      setActive(startAt);
      setOpen(true);
    },
    [usable.length]
  );

  // Long action labels wrap, so the real menu may be taller than the initial
  // estimate. Keep it inside the viewport before moving keyboard focus.
  useLayoutEffect(() => {
    if (!open || !menuRef.current || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const height = Math.min(menuRef.current.scrollHeight, window.innerHeight - 16);
    const below = window.innerHeight - rect.bottom - 8;
    const top = below >= height ? rect.bottom + 4 : Math.max(8, rect.top - height - 4);
    setPosition(current => ({ ...current, top: Math.min(top, window.innerHeight - height - 8), dropUp: below < height }));
  }, [open, usable.length]);

  // Moving focus to the item the arrow keys landed on. Opened with the mouse
  // there is no item yet, so focus goes to the menu itself — otherwise Escape
  // and the arrow keys would be typed at the trigger and never reach it.
  useEffect(() => {
    if (!open) {
      return;
    }

    if (active >= 0 && itemRefs.current[active]) {
      itemRefs.current[active].focus({ preventScroll: true });
    } else if (menuRef.current) {
      menuRef.current.focus({ preventScroll: true });
    }
  }, [open, active]);

  // Anything outside closes it: a click elsewhere, the page scrolling away
  // beneath it, or the window changing size under a fixed position.
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const onPointerDown = (event) => {
      if (
        !menuRef.current?.contains(event.target) &&
        !triggerRef.current?.contains(event.target)
      ) {
        close({ restoreFocus: false });
      }
    };

    const onAway = event => {
      if (event.type === 'scroll') {
        if (menuRef.current?.contains(event.target)) return;
        const rect = triggerRef.current?.getBoundingClientRect();
        // A pending scroll event from bringing the trigger into view is not
        // movement after the menu opened.
        if (rect && rect.top === anchorRef.current?.top && rect.left === anchorRef.current?.left) return;
      }
      close({ restoreFocus: false });
    };

    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("scroll", onAway, true);
    window.addEventListener("resize", onAway);

    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("scroll", onAway, true);
      window.removeEventListener("resize", onAway);
    };
  }, [open, close]);

  const onTriggerKeyDown = (event) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      show(firstIndex(items));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      show(lastIndex(items));
    }
  };

  const onMenuKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }

    // Tab out of a menu closes it, rather than walking through items that are
    // floating above an unrelated part of the page.
    if (event.key === "Tab") {
      close({ restoreFocus: false });
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => nextIndex(items, current, 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => nextIndex(items, current, -1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(firstIndex(items));
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(lastIndex(items));
    }
  };

  const choose = (item) => {
    close();
    item.onClick();
  };

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={text ? `button button-secondary action-menu-button ${open ? "is-open" : ""}` : `action-menu-trigger ${open ? "is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={text ? undefined : label}
        title={text ? undefined : label}
        onClick={() => (open ? close() : show(-1))}
        onKeyDown={onTriggerKeyDown}
      >
        {text ? (
          <>
            {text}
            <Icon name="chevron-down" size={14} strokeWidth={2.5} />
          </>
        ) : (
          <Icon name="more" size={18} strokeWidth={2.5} />
        )}
      </button>

      {open &&
        position &&
        createPortal(
          <div
            id={menuId}
            ref={menuRef}
            className="action-menu"
            // Which way it opened, so it grows out of the "⋯" it belongs to.
            data-placement={position.dropUp ? "up" : "down"}
            role="menu"
            aria-label={label}
            tabIndex={-1}
            style={{ top: position.top, left: position.left, width: MENU_WIDTH, maxHeight: 'calc(100dvh - 16px)', overflowY: 'auto' }}
            onKeyDown={onMenuKeyDown}
          >
            {items.map((item, index) =>
              item.separator ? (
                <div className="action-menu-separator" key={`sep-${index}`} role="separator" />
              ) : (
                <button
                  type="button"
                  key={item.label}
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  className={`action-menu-item ${item.danger ? "is-danger" : ""}`}
                  role="menuitem"
                  tabIndex={index === active ? 0 : -1}
                  disabled={item.disabled}
                  onClick={() => choose(item)}
                >
                  {/* An item may name an Icon; the label is what is read. */}
                  {item.icon && <Icon name={item.icon} size={16} className="action-menu-icon" />}
                  {item.label}
                </button>
              )
            )}
          </div>,
          document.body
        )}
    </>
  );
}
