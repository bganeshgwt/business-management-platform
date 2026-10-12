import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import Icon from "./Icon";
import usePresence from "../hooks/usePresence";
import useBusiness from "../hooks/useBusiness";
import { TYPE_ICONS } from "../services/businessNav";
import "../styles/business-switcher.css";

// The business switcher in the header. Lists every business this person is a
// member of, with its type, and opens the one picked: the signed-in
// restaurant opens the restaurant admin as it always has, any other business
// opens its own Business Admin. Shown only to someone with a membership.
export default function BusinessSwitcher() {
  const { businesses, current, switchTo, directory } = useBusiness();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const panel = usePresence(open, 130);
  const ref = useRef(null);
  const searchRef = useRef(null);
  const listId = useId();

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onPointer = (event) => {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    searchRef.current?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const groups = useMemo(() => {
    const term = query.trim().toLowerCase();
    const matches = businesses.filter((b) => !term || `${b.name} ${b.type_name} ${b.code}`.toLowerCase().includes(term));
    return [
      ["Restaurants", matches.filter((b) => b.business_type === "restaurant")],
      ["Other businesses", matches.filter((b) => b.business_type !== "restaurant")],
    ].filter(([, list]) => list.length > 0);
  }, [businesses, query]);

  if (!directory || businesses.length === 0) {
    return null;
  }

  const pick = (business) => {
    setOpen(false);
    setQuery("");
    if (business.id !== current?.id) switchTo(business);
  };

  const label = current ? current.name : "Choose a business";
  return (
    <div className="bsw" ref={ref}>
      <button
        type="button"
        className={`bsw-trigger ${open ? "is-open" : ""}`}
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Business: ${label}. Switch business`}
      >
        <span className={`bsw-type bsw-type-${current?.business_type || "none"}`} aria-hidden="true">
          <Icon name={TYPE_ICONS[current?.business_type] || "store"} size={16} />
        </span>
        <span className="bsw-text">
          <span className="bsw-name">{label}</span>
          <small>{current ? current.type_name : `${businesses.length} businesses`}</small>
        </span>
        <Icon name="chevrons-up-down" size={14} className="bsw-caret" />
      </button>

      {panel.mounted && (
        <div className={`bsw-panel ${panel.leaving ? "is-leaving" : ""}`} inert={panel.leaving || undefined}>
          <div className="bsw-search">
            <Icon name="search" size={15} />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a business"
              aria-label="Find a business"
              aria-controls={listId}
            />
          </div>
          <div className="bsw-list" id={listId} role="listbox" aria-label="Your businesses">
            {groups.map(([title, list]) => (
              <div key={title} role="group" aria-label={title}>
                <p className="bsw-group">{title}</p>
                {list.map((business) => {
                  const blocked = business.business_type === "restaurant" && !business.is_signed_in_restaurant;
                  const selected = business.id === current?.id;
                  return (
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      key={business.id}
                      className={`bsw-option ${selected ? "is-current" : ""}`}
                      disabled={blocked}
                      title={blocked ? "This restaurant opens when you sign in to it" : undefined}
                      onClick={() => pick(business)}
                    >
                      <span className={`bsw-type bsw-type-${business.business_type}`} aria-hidden="true">
                        <Icon name={TYPE_ICONS[business.business_type] || "store"} size={16} />
                      </span>
                      <span className="bsw-option-text">
                        <strong>{business.name}</strong>
                        <small>
                          {business.type_name} · {business.role_name}
                          {blocked ? " · sign in to that restaurant to open it" : ""}
                        </small>
                      </span>
                      {selected && <Icon name="check" size={16} className="bsw-check" />}
                    </button>
                  );
                })}
              </div>
            ))}
            {groups.length === 0 && <p className="muted small bsw-empty">No business matches “{query}”.</p>}
          </div>
          <Link className="bsw-all" to="/business-admin?all=1" onClick={() => setOpen(false)}>
            <Icon name="grid" size={15} /> All businesses
          </Link>
        </div>
      )}
    </div>
  );
}
