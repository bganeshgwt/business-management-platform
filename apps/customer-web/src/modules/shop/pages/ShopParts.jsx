import { useEffect, useId, useRef, useState } from "react";
import Icon from "@bmp/ui/Icon";
import { money } from "@bmp/shared/format";
import { uploadUrl } from "../../../shared/publicClient";
import { initials, telHref } from "../../../shared/guestWords";

// The small pieces every page of the online shop uses: the product photo in
// its fixed box, prices with the MRP, the stepper, the shop's policy, a
// bottom sheet, the calm "not taking orders" page and a ticking clock.

// A cart, drawn here (the shared icon set has none).
export function CartGlyph({ size = 18 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="9" cy="20" r="1.4" />
      <circle cx="18" cy="20" r="1.4" />
      <path d="M2 3h3l2.6 12.2a1.6 1.6 0 0 0 1.6 1.3h8.7a1.6 1.6 0 0 0 1.5-1.2L21.5 7H6.1" />
    </svg>
  );
}

const TINTS = ["teal", "amber", "violet", "rose", "blue", "green", "orange", "indigo", "cyan"];
const tintOf = (name) => TINTS[[...String(name || "")].reduce((sum, char) => sum + char.charCodeAt(0), 0) % TINTS.length];

// A product's photo in a square box of its own, so the grid never jumps as
// photos arrive: the small one in the grid, the large one on the item's
// page, each loaded only as it comes into view. No photo (or one that will
// not load): a calm tile with the product's initials.
export function ItemPhoto({ photo, name, large = false }) {
  const [broken, setBroken] = useState(false);
  const path = photo ? (large ? photo.large : photo.small) : null;
  return (
    <span className={`sp-photo ${large ? "is-large" : ""}`} data-tint={tintOf(name)}>
      {path && !broken ? (
        <img src={uploadUrl(path)} alt="" loading={large ? "eager" : "lazy"} decoding="async" width={large ? 1080 : 400} height={large ? 1080 : 400}
          onError={() => setBroken(true)} />
      ) : (
        <span className="sp-photo-initials" aria-hidden="true">{initials(name) || <Icon name="box" size={22} />}</span>
      )}
    </span>
  );
}

// A price, with the MRP struck through and the saving when the price is below it.
export function Price({ price, mrp, unit = null, weighed = false, size = "md" }) {
  const saving = mrp && mrp > price ? mrp - price : 0;
  return (
    <span className={`sp-price is-${size}`}>
      <strong>{money(price)}</strong>
      {weighed && unit && <span className="sp-per">/{unit}</span>}
      {saving > 0 && (
        <>
          <s aria-label={`MRP ${money(mrp)}`}>{money(mrp)}</s>
          <span className="sp-save">Save {money(saving)}</span>
        </>
      )}
    </span>
  );
}

export function Stepper({ value, label, onDown, onUp, canUp = true, small = false }) {
  return (
    <span className={`g-stepper sp-stepper ${small ? "is-small" : ""}`}>
      <button type="button" onClick={onDown} aria-label="One less">
        <Icon name="minus" size={16} />
      </button>
      <span aria-live="polite">{label ?? value}</span>
      <button type="button" onClick={onUp} disabled={!canUp} aria-label="One more">
        <Icon name="plus" size={16} />
      </button>
    </span>
  );
}

// A bottom sheet on a phone, a dialog on a wider screen. Escape and the
// backdrop close it; focus goes in when it opens and back when it closes.
export function Sheet({ title, onClose, children, footer = null, wide = false }) {
  const id = useId();
  const panel = useRef(null);
  useEffect(() => {
    const before = document.activeElement;
    panel.current?.focus();
    const onKey = (event) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("sp-locked");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("sp-locked");
      if (before && typeof before.focus === "function") before.focus();
    };
  }, [onClose]);
  return (
    <div className="sp-sheet-layer">
      <button type="button" className="sp-sheet-backdrop" aria-label="Close" onClick={onClose} tabIndex={-1} />
      <section className={`sp-sheet ${wide ? "is-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} ref={panel}>
        <header className="sp-sheet-head">
          <span className="sp-sheet-grip" aria-hidden="true" />
          <h2 id={`${id}-title`}>{title}</h2>
          <button type="button" className="g-round" onClick={onClose} aria-label="Close">
            <Icon name="x" size={18} />
          </button>
        </header>
        <div className="sp-sheet-body">{children}</div>
        {footer && <footer className="sp-sheet-foot">{footer}</footer>}
      </section>
    </div>
  );
}

// The shop's return, refund, exchange, warranty and delivery terms: on every page.
export function PolicyLink({ policy, name }) {
  const [open, setOpen] = useState(false);
  if (!policy) return null;
  return (
    <>
      <button type="button" className="sp-policy-link" onClick={() => setOpen(true)}>
        <Icon name="file" size={15} /> Returns, refunds &amp; delivery
      </button>
      {open && (
        <Sheet title={`${name ? `${name}: ` : ""}returns, refunds & delivery`} onClose={() => setOpen(false)}>
          <div className="sp-policy">
            {String(policy).split(/\n{2,}/).map((part) => <p key={part.slice(0, 40)}>{part}</p>)}
          </div>
        </Sheet>
      )}
    </>
  );
}

// The calm page of a shop that is not taking online orders now: why, and its phone.
export function NotTaking({ card, shop }) {
  const call = telHref(card?.location?.phone);
  return (
    <section className="sp-calm" aria-labelledby="sp-calm-title">
      <span className="sp-calm-mark" aria-hidden="true">
        <Icon name="store" size={30} />
      </span>
      <h1 id="sp-calm-title">{card?.name ? `${card.name} is not taking online orders now` : "Not taking online orders now"}</h1>
      <p>{shop?.message || "Please call the shop to order."}</p>
      {call && (
        <a className="g-primary" href={call}>
          <Icon name="phone" size={17} /> Call {card.location.phone}
        </a>
      )}
      {card?.location?.address && <p className="sp-calm-address">{[card.location.address, card.location.city, card.location.postalCode].filter(Boolean).join(", ")}</p>}
    </section>
  );
}

