import { useEffect, useId, useRef, useState } from "react";
import Icon from "@bmp/ui/Icon";
import GuestAvatar from "./GuestAvatar";
import { searchGuests } from "../services/crm.service";
import { getErrorMessage } from "../../../../services/api";
import { tagLabel } from "../../../../services/guestBook";

// Picks one guest from the whole guest book by searching the server.
//
// The feedback and complaint forms used to load "all customers" into a plain
// dropdown, which was really the first 500 by name: a restaurant a year into
// loyalty has thousands, and most of them could not be picked. This asks the
// server as you type, shows the few best matches and how many there are, and
// works with the keyboard.
//
//   value     the chosen guest ({ id, name, mobileDisplay, ... }) or null
//   onChange  called with a guest, or null when cleared
//   exclude   an id that may not be picked (the record being merged into)
//   noMatch   what to try when nothing matches. The feedback and complaint
//             forms have name and mobile boxes below for a walk-in; the merge
//             dialog does not, so it says something else.
export default function GuestPicker({
  value,
  onChange,
  label = "Guest",
  placeholder = "Name, mobile, company or GSTIN",
  exclude = null,
  autoFocus = false,
  hint,
  noMatch = "Check the spelling, or leave this empty and type their name below.",
}) {
  const [term, setTerm] = useState("");
  const [result, setResult] = useState(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const requestRef = useRef(0);
  const listId = useId();

  // Asked a quarter of a second after typing stops, so a cashier typing a
  // ten-digit number sends one request, not ten. A slower earlier answer
  // arriving after a newer one is ignored.
  useEffect(() => {
    const text = term.trim();

    if (!text) {
      return undefined;
    }

    const request = requestRef.current + 1;
    requestRef.current = request;

    const timer = setTimeout(() => {
      searchGuests(text, 8)
        .then((data) => {
          if (requestRef.current === request) {
            setResult(data);
            setError("");
            setActive(0);
          }
        })
        .catch((err) => {
          if (requestRef.current === request) {
            setResult(null);
            setError(getErrorMessage(err));
          }
        })
        .finally(() => {
          if (requestRef.current === request) {
            setSearching(false);
          }
        });
    }, 250);

    return () => clearTimeout(timer);
  }, [term]);

  const matches = (result ? result.items : []).filter((guest) => guest.id !== exclude);

  const type = (event) => {
    const next = event.target.value;
    setTerm(next);
    setOpen(true);

    if (next.trim()) {
      setSearching(true);
    } else {
      requestRef.current += 1;
      setResult(null);
      setSearching(false);
    }
  };

  const pick = (guest) => {
    onChange(guest);
    setTerm("");
    setResult(null);
    setOpen(false);
  };

  const onKeyDown = (event) => {
    if (!open || matches.length === 0) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => (current + 1) % matches.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => (current - 1 + matches.length) % matches.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(matches[Math.min(active, matches.length - 1)]);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  if (value) {
    return (
      <div className="field crm-picker">
        <span>{label}</span>
        <div className="crm-picked">
          <GuestAvatar guest={value} />
          <span className="crm-picked-text">
            <strong>{value.name}</strong>
            <span className="muted small">
              {[value.mobileDisplay, value.visits !== undefined ? `${value.visits} visits` : null]
                .filter(Boolean)
                .join(" · ") || "No mobile on file"}
            </span>
          </span>
          <button type="button" className="button button-ghost button-sm" onClick={() => onChange(null)}>
            Change
          </button>
        </div>
      </div>
    );
  }

  const text = term.trim();
  const shown = matches.length;
  const total = result ? result.total - (result.items.length - matches.length) : 0;

  return (
    <div className="field crm-picker">
      <label htmlFor={`${listId}-input`}>{label}</label>
      <span className="input-with-icon">
        <Icon name="search" size={16} className="input-icon" />
        <input
          id={`${listId}-input`}
          value={term}
          onChange={type}
          onKeyDown={onKeyDown}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          autoFocus={autoFocus}
          autoComplete="off"
          role="combobox"
          aria-expanded={open && shown > 0}
          aria-controls={listId}
          aria-autocomplete="list"
        />
      </span>
      {hint && !text && <small className="muted">{hint}</small>}

      {open && text && (
        <div className="crm-picker-drop">
          {searching && !result ? (
            <p className="muted small crm-picker-note">Searching…</p>
          ) : error ? (
            <p className="small text-danger crm-picker-note">{error}</p>
          ) : shown === 0 ? (
            <p className="muted small crm-picker-note">
              No guest matches “{text}”. {noMatch}
            </p>
          ) : (
            <>
              <ul className="crm-picker-list" id={listId} role="listbox">
                {matches.map((guest, index) => (
                  <li key={guest.id} role="option" aria-selected={index === active}>
                    <button
                      type="button"
                      className={index === active ? "is-active" : ""}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => pick(guest)}
                    >
                      <GuestAvatar guest={guest} />
                      <span className="crm-picker-text">
                        <span className="crm-picker-name">
                          {guest.name}
                          {guest.tags.slice(0, 2).map((tag) => (
                            <span key={tag} className={`crm-tag crm-tag-${tag}`}>
                              {tagLabel(tag)}
                            </span>
                          ))}
                        </span>
                        <span className="muted small">
                          {[guest.mobileDisplay || "No mobile", `${guest.visits} visits`, guest.status === "inactive" ? "inactive" : null]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {total > shown && (
                <p className="muted small crm-picker-note">
                  {shown} of {total} guests match. Type more of the name or number to narrow it.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
