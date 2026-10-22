import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "@bmp/ui/Icon";

// Type to find, arrows to move, Enter to pick: the one control for choosing
// an item, a customer, a supplier, a member of staff or a variant out of a
// list too long for a <select>. Usage and examples: SCRATCH/pro/G/COMPONENTS.md.
//
//   <SearchPicker label="Customer" value={customer} onChange={setCustomer}
//                 options={customers} getLabel={(c) => c.name}
//                 getDescription={(c) => balanceText(c.balance)} />
//
//   <SearchPicker label="Add item" search={(q, { signal }) => findItems(q, signal)}
//                 onChange={addLine} clearOnSelect placeholder="Name, code or barcode" />
//
// Options come either from `options` (filtered here: every typed word must
// appear in the label, description or getKeywords text) or from
// `search(query, { signal })`, an async function returning an array (called
// after `debounce` ms; a newer query cancels the older one).
//
// value / onChange  the chosen option object (null when cleared).
// getKey            a stable key (default o.id ?? o.value ?? label).
// getLabel          the text in the input once chosen (default o.label ?? o.name).
// getDescription    a quieter second line (balance, stock, code).
// getKeywords       extra text to match (code, barcode, phone).
// isDisabled        options shown greyed and not pickable (out of stock).
// renderOption      (option, { active, selected }) => node, for a custom row.
// clearOnSelect     empty the box after a pick and keep focus (adding lines).
// onCreate / createLabel  a last row "Add “Ravi”" when nothing fits exactly.
// minChars          characters before an async search runs (default 1; 0
//                   searches on focus); local options always show on focus.
// clearable         an × to clear the choice (default true).
// name              also renders <input type="hidden" name value=key> for forms.
// label             a visible label above (a .field); or `aria-label`.
// hint / error      as in FormField; `required` marks it for assistive tech.
// limit             rows shown at most (default 50) — "Keep typing" below.
//
// Keyboard: ↓/↑ move (and open), Home/End, Enter picks, Escape closes the
// list (a second Escape clears the text), Tab leaves without picking.

const defaultKey = (option) => option?.id ?? option?.value ?? option?.key ?? option?.label ?? option?.name;
const defaultLabel = (option) => (option == null ? "" : String(option.label ?? option.name ?? option.title ?? ""));

const fold = (text) =>
  String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");

export default function SearchPicker({
  value = null,
  onChange,
  options,
  search,
  getKey = defaultKey,
  getLabel = defaultLabel,
  getDescription,
  getKeywords,
  isDisabled,
  renderOption,
  placeholder = "Type to search…",
  emptyText = "Nothing matches",
  loadingText = "Searching…",
  minChars,
  debounce = 250,
  limit = 50,
  clearOnSelect = false,
  clearable = true,
  onCreate,
  createLabel = (query) => `Add “${query}”`,
  disabled = false,
  autoFocus = false,
  required = false,
  name,
  id,
  label,
  hint,
  error,
  className = "",
  inputClassName = "",
  "aria-label": ariaLabel,
  onQueryChange,
}) {
  const ownId = useId();
  const inputId = id || `${ownId}-input`;
  const listId = `${ownId}-list`;
  const hintId = `${ownId}-hint`;
  const errorId = `${ownId}-error`;
  const input = useRef(null);
  const list = useRef(null);
  const wrap = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [typing, setTyping] = useState(false);
  const [active, setActive] = useState(0);
  const [remote, setRemote] = useState({ query: null, items: [], loading: false, error: "" });
  const [place, setPlace] = useState(null);
  const threshold = minChars ?? (search ? 1 : 0);

  const shownText = typing || clearOnSelect ? query : value ? getLabel(value) : query;

  // --- results -------------------------------------------------------------
  const localResults = useMemo(() => {
    if (!options) {
      return [];
    }

    const words = fold(query).split(/\s+/).filter(Boolean);

    if (!typing || words.length === 0) {
      return options;
    }

    return options.filter((option) => {
      const haystack = fold(
        [getLabel(option), getDescription ? getDescription(option) : "", getKeywords ? getKeywords(option) : ""].join(" ")
      );
      return words.every((word) => haystack.includes(word));
    });
  }, [options, query, typing, getLabel, getDescription, getKeywords]);

  useEffect(() => {
    if (!search || !open) {
      return undefined;
    }

    const text = typing ? query.trim() : "";

    if (text.length < threshold) {
      setRemote({ query: null, items: [], loading: false, error: "" });
      return undefined;
    }

    const controller = new AbortController();
    setRemote((state) => ({ ...state, loading: true, error: "" }));
    const timer = setTimeout(async () => {
      try {
        const found = await search(text, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setRemote({ query: text, items: Array.isArray(found) ? found : [], loading: false, error: "" });
        }
      } catch (err) {
        if (!controller.signal.aborted && err?.name !== "CanceledError" && err?.name !== "AbortError") {
          setRemote({ query: text, items: [], loading: false, error: err?.message || "Could not search" });
        }
      }
    }, text ? debounce : 0);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `search` is often an inline function; the query is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, typing, open, threshold, debounce, Boolean(search)]);

  const all = search ? remote.items : localResults;
  const results = all.slice(0, limit);
  const more = all.length - results.length;
  const trimmed = query.trim();
  const exactMatch = results.some((option) => fold(getLabel(option)) === fold(trimmed));
  const showCreate = Boolean(onCreate && typing && trimmed && !exactMatch);
  const rows = showCreate ? [...results, { __create: trimmed }] : results;
  const waiting = search && (remote.loading || (typing && trimmed.length >= threshold && remote.query !== trimmed));
  const tooShort = search && (!typing || trimmed.length < threshold) && threshold > 0;

  useEffect(() => {
    setActive((index) => (index >= rows.length ? Math.max(0, rows.length - 1) : index));
  }, [rows.length]);

  // --- the list sits on <body>, under (or above) the box ----------------------
  const measure = useCallback(() => {
    const box = input.current?.getBoundingClientRect();

    if (!box) {
      return;
    }

    const below = window.innerHeight - box.bottom;
    const above = box.top;
    const up = below < 240 && above > below;
    const room = Math.max(160, Math.min(320, (up ? above : below) - 12));

    setPlace({
      left: Math.max(8, Math.min(box.left, window.innerWidth - Math.max(box.width, 260) - 8)),
      width: Math.max(box.width, Math.min(260, window.innerWidth - 16)),
      top: up ? undefined : box.bottom + 4,
      bottom: up ? window.innerHeight - box.top + 4 : undefined,
      maxHeight: room,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      return undefined;
    }

    measure();
    const onMove = (event) => {
      if (list.current && event.target instanceof Node && list.current.contains(event.target)) {
        return;
      }
      measure();
    };
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, measure]);

  // A click anywhere else closes the list.
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const onDown = (event) => {
      const target = event.target;
      if (wrap.current?.contains(target) || list.current?.contains(target)) {
        return;
      }
      setOpen(false);
      setTyping(false);
    };

    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open]);

  // The active row stays in view.
  useEffect(() => {
    if (!open || !list.current) {
      return;
    }
    list.current.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  // --- choosing ------------------------------------------------------------
  const choose = (row) => {
    if (!row) {
      return;
    }

    if (row.__create !== undefined) {
      onCreate(row.__create);
    } else {
      if (isDisabled?.(row)) {
        return;
      }
      onChange?.(row);
    }

    setTyping(false);
    setQuery("");
    onQueryChange?.("");
    setActive(0);

    if (clearOnSelect) {
      setOpen(true);
      input.current?.focus();
    } else {
      setOpen(false);
    }
  };

  const onKeyDown = (event) => {
    if (disabled) {
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) {
          setOpen(true);
        } else {
          setActive((index) => Math.min(rows.length - 1, index + 1));
        }
        break;
      case "ArrowUp":
        event.preventDefault();
        if (!open) {
          setOpen(true);
        } else {
          setActive((index) => Math.max(0, index - 1));
        }
        break;
      case "Home":
        if (open && rows.length) {
          event.preventDefault();
          setActive(0);
        }
        break;
      case "End":
        if (open && rows.length) {
          event.preventDefault();
          setActive(rows.length - 1);
        }
        break;
      case "Enter":
        if (open && rows[active] && !waiting) {
          event.preventDefault();
          choose(rows[active]);
        } else if (open && waiting) {
          // A scanner types the code and Enter faster than the search runs.
          event.preventDefault();
        }
        break;
      case "Escape":
        if (open) {
          event.preventDefault();
          setOpen(false);
          setTyping(false);
        } else if (query) {
          event.preventDefault();
          setQuery("");
          onQueryChange?.("");
        }
        break;
      case "Tab":
        setOpen(false);
        setTyping(false);
        break;
      default:
    }
  };

  const clear = () => {
    onChange?.(null);
    setQuery("");
    setTyping(false);
    onQueryChange?.("");
    input.current?.focus();
  };

  useEffect(() => {
    if (autoFocus) {
      input.current?.focus();
    }
  }, [autoFocus]);

  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;
  const activeId = open && rows[active] ? `${listId}-${active}` : undefined;

  const box = (
    <div
      ref={wrap}
      className={`search-picker ${open ? "is-open" : ""} ${value && !clearOnSelect ? "has-value" : ""} ${className}`.trim()}
    >
      <span className="search-picker-icon" aria-hidden="true">
        <Icon name="search" size={16} />
      </span>
      <input
        ref={input}
        id={inputId}
        type="text"
        role="combobox"
        className={`search-picker-input ${inputClassName}`.trim()}
        autoComplete="off"
        spellCheck={false}
        value={shownText}
        placeholder={value && clearOnSelect ? getLabel(value) : placeholder}
        disabled={disabled}
        aria-label={label ? undefined : ariaLabel || placeholder}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-invalid={error ? true : undefined}
        aria-required={required || undefined}
        aria-describedby={describedBy}
        onChange={(event) => {
          setQuery(event.target.value);
          setTyping(true);
          setOpen(true);
          setActive(0);
          onQueryChange?.(event.target.value);
        }}
        onFocus={(event) => {
          if (!clearOnSelect && value) {
            event.target.select();
          }
        }}
        onClick={() => !disabled && setOpen(true)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // Leaving the box without picking puts the chosen value back.
          setTimeout(() => {
            if (!wrap.current?.contains(document.activeElement) && !list.current?.contains(document.activeElement)) {
              setOpen(false);
              setTyping(false);
            }
          }, 0);
        }}
      />
      {clearable && value && !clearOnSelect && !disabled && (
        <button type="button" className="search-picker-clear" onClick={clear} aria-label="Clear" tabIndex={-1}>
          <Icon name="x" size={14} />
        </button>
      )}
      {name && <input type="hidden" name={name} value={value ? String(getKey(value)) : ""} />}
    </div>
  );

  const listbox =
    open && place && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={list}
            className="search-picker-list"
            style={{ left: place.left, width: place.width, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight }}
            onMouseDown={(event) => event.preventDefault()}
          >
            <ul id={listId} role="listbox" aria-label={typeof label === "string" ? label : ariaLabel || "Results"}>
              {rows.map((row, index) => {
                const creating = row.__create !== undefined;
                const off = !creating && Boolean(isDisabled?.(row));
                const selected = !creating && value != null && getKey(value) === getKey(row);
                return (
                  <li
                    key={creating ? "__create" : String(getKey(row))}
                    id={`${listId}-${index}`}
                    data-index={index}
                    role="option"
                    aria-selected={index === active}
                    aria-disabled={off || undefined}
                    className={`search-picker-option ${index === active ? "is-active" : ""} ${selected ? "is-selected" : ""} ${
                      off ? "is-disabled" : ""
                    } ${creating ? "is-create" : ""}`}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(row)}
                  >
                    {creating ? (
                      <span className="search-picker-label">
                        <Icon name="plus" size={14} /> {createLabel(row.__create)}
                      </span>
                    ) : renderOption ? (
                      renderOption(row, { active: index === active, selected })
                    ) : (
                      <>
                        <span className="search-picker-label">{getLabel(row)}</span>
                        {getDescription && <span className="search-picker-desc">{getDescription(row)}</span>}
                      </>
                    )}
                    {selected && (
                      <span className="search-picker-tick" aria-hidden="true">
                        <Icon name="check" size={14} />
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {rows.length === 0 && (
              <p className="search-picker-note" role="status">
                {waiting ? loadingText : remote.error ? remote.error : tooShort ? `Type ${threshold === 1 ? "a letter" : `${threshold} letters`} to search` : emptyText}
              </p>
            )}
            {rows.length > 0 && waiting && <p className="search-picker-note">{loadingText}</p>}
            {more > 0 && <p className="search-picker-note">{more} more — keep typing to narrow it down</p>}
          </div>,
          document.body
        )
      : null;

  if (!label && !hint && !error) {
    return (
      <>
        {box}
        {listbox}
      </>
    );
  }

  return (
    <div className={`field search-picker-field ${error ? "has-error" : ""}`}>
      {label && (
        <label htmlFor={inputId} className="field-label">
          {label}
        </label>
      )}
      {box}
      {listbox}
      {error && (
        <small id={errorId} className="field-error" role="alert">
          {error}
        </small>
      )}
      {hint && (
        <small id={hintId} className="muted field-hint">
          {hint}
        </small>
      )}
    </div>
  );
}
