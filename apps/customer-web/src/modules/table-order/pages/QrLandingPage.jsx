import AddonChoiceRules from "@bmp/ui/menu/AddonChoiceRules";
import ComboChoicePicker from '@bmp/ui/menu/ComboChoicePicker';
import {comboKey,comboError,comboExtra,comboParts} from '@bmp/shared/menu/comboChoices';
import {choiceError} from "@bmp/shared/menu/addonChoices";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  callStaff,
  cancelGuestRequest,
  dishImageUrl,
  getGuestMenu,
  getGuestRequests,
  guestErrorMessage,
  newClientKey,
  placeGuestOrder,
  sendGuestFeedback,
} from "../services/tableOrder.service";
import { money } from "@bmp/shared/format";
import { ForgetDetails, PrivacyNote } from "../../privacy/GuestPrivacy";
import "../../../styles/guest.css";

// Where a printed table QR code lands: the restaurant's face to its guests.
//
// A guest here is never signed in and is usually on a phone, one-handed, in a
// dim room, on patchy Wi-Fi. So: big targets, prices that are the prices, a
// cart that survives a reload, a status screen that says what is happening,
// and "call a waiter" never more than one tap away. Nothing a guest does here
// reaches the kitchen until a member of staff accepts it — the page says so,
// so nobody sits waiting for food that has not been confirmed.

// How often the phone asks after orders and calls still in progress: every
// few seconds while the staff have yet to answer — that is the wait a guest
// sits watching — and less often once the kitchen has it. A meal is an hour
// of asking, and every phone on the restaurant's Wi-Fi shares one address's
// allowance on the server.
const POLL_WAITING = 6000;
const POLL_COOKING = 20000;
// Requests older than this are yesterday's dinner, not this visit's.
const TRACK_HOURS = 8;
// A guest waiting this long for staff to confirm is offered a waiter.
const SLOW_CONFIRM_MS = 3 * 60 * 1000;

const FOOD_LABELS = { veg: "Vegetarian", non_veg: "Non-vegetarian", egg: "Contains egg" };

const CALLS = [
  { type: "call_waiter", label: "Call waiter", busy: "Waiter called", icon: "bell" },
  { type: "bill", label: "Request bill", busy: "Bill requested", icon: "receipt" },
  { type: "water", label: "Water please", busy: "Water coming", icon: "drop" },
];

const OTHER_SUGGESTIONS = [
  "Extra napkins",
  "A high chair",
  "Extra cutlery",
  "Please clean the table",
  "Pack the leftovers",
];

// ---------------------------------------------------------------- storage

// Per phone, per table: the cart and the requests this phone is following.
// Storage may be blocked (private mode), in which case it simply is not kept.
const readStore = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

const writeStore = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Blocked or full: this visit still works, it just is not remembered.
  }
};

const cartKey = (token) => `rmp_guest_cart_${token}`;
const trackKey = (token) => `rmp_guest_requests_${token}`;
const feedbackKey = (token) => `rmp_guest_feedback_${token}`;
const PROFILE_KEY = "rmp_guest_profile";

const loadTracked = (token) => {
  const cutoff = Date.now() - TRACK_HOURS * 3600 * 1000;
  const list = readStore(trackKey(token), []);

  return Array.isArray(list)
    ? list.filter((entry) => entry && Number(entry.id) > 0 && Number(entry.at) > cutoff)
    : [];
};

// ---------------------------------------------------------------- small pieces

const ICONS = {
  bell: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0",
  receipt: "M5 2h14v20l-3-2-2 2-2-2-2 2-2-2-3 2zM9 7h6M9 11h6M9 15h4",
  drop: "M12 2.7s6 6.3 6 11.3a6 6 0 0 1-12 0c0-5 6-11.3 6-11.3z",
  dots: "M5 12h.01M12 12h.01M19 12h.01",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35",
  bag: "M6 7h12l1 14H5zM9 7V6a3 3 0 0 1 6 0v1",
  close: "M18 6 6 18M6 6l12 12",
  check: "M20 6 9 17l-5-5",
  clock: "M12 6v6l4 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  chef: "M6 13.87A4 4 0 0 1 7.41 6a5.11 5.11 0 0 1 1.05-1.54 5 5 0 0 1 7.08 0A5.11 5.11 0 0 1 16.59 6 4 4 0 0 1 18 13.87V21H6zM6 17h12",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  star: "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z",
  sparkle: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4z",
  alert: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01",
  pause: "M10 4H6v16h4zM18 4h-4v16h4z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  chevron: "M9 18l6-6-6-6",
  qrOff: "M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h2v2h-2zM19 19h2v2h-2zM2 2l20 20",
  heart: "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21.2l8.8-8.8a5.5 5.5 0 0 0 0-7.8z",
  // Placeholders for a dish without a photo, chosen from its category.
  cloche: "M3 18h18M5 18a7 7 0 0 1 14 0M12 11V9M10.5 9h3",
  bowl: "M3 11h18a9 7 0 0 1-18 0zM8 7.5c0-1 1-1.5 1-2.5M12 7.5c0-1 1-1.5 1-2.5M16 7.5c0-1 1-1.5 1-2.5",
  glass: "M7 3h10l-1.6 17.1a1 1 0 0 1-1 .9H9.6a1 1 0 0 1-1-.9zM7.5 8h9M14 3l2.5-2",
  sweet: "M8 11l4 10 4-10M7 11a5 5 0 0 1 10 0z",
  bread: "M4 13c0-4 3.6-7 8-7s8 3 8 7-3.6 5-8 5-8-1-8-5zM9 11.5l1 1M13 10l1 1M11.5 14l1 1M15.5 13l.5.5",
  flame:
    "M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z",
};

function Icon({ name, size = 20, className = "" }) {
  return (
    <svg
      className={`g-icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

// The square-and-dot every Indian menu uses: green for vegetarian, brown-red
// triangle for non-vegetarian, amber for egg. Colour and shape, and a label
// for a screen reader.
function FoodMark({ type }) {
  return (
    <span className={`g-food g-food-${type}`} role="img" aria-label={FOOD_LABELS[type] || type}>
      <span />
    </span>
  );
}

const placeholderFor = (categoryName = "") => {
  const name = categoryName.toLowerCase();

  // Whole words: "Biryani & Rice" must not match "ice" and land among desserts.
  if (/\b(breads?|naans?|rotis?|parathas?|kulchas?)\b/.test(name)) return "bread";
  if (/\b(biryanis?|rice|pulao|soups?|dals?)\b/.test(name)) return "bowl";
  if (/\b(beverages?|drinks?|juices?|lassis?|shakes?|mocktails?|coffee|teas?|bar)\b/.test(name)) return "glass";
  if (/\b(desserts?|sweets?|ice creams?|kulfi)\b/.test(name)) return "sweet";
  if (/\b(starters?|tandoor|tandoori|kebabs?|grill|appeti[sz]ers?|snacks?)\b/.test(name)) return "flame";

  return "cloche";
};

function DishPicture({ dish, categoryName, large = false }) {
  const [broken, setBroken] = useState(false);
  const url = dishImageUrl(dish.image);

  if (url && !broken) {
    return (
      <img
        className={`g-dish-photo ${large ? "is-large" : ""}`}
        src={url}
        alt=""
        loading="lazy"
        onError={() => setBroken(true)}
      />
    );
  }

  return (
    <span className={`g-dish-photo g-dish-placeholder g-tint-${dish.foodType} ${large ? "is-large" : ""}`}>
      <Icon name={placeholderFor(categoryName)} size={large ? 56 : 34} />
    </span>
  );
}

// ---------------------------------------------------------------- prices

// The price a guest pays for one of this dish, as configured. Offer prices
// replace the menu price outright (they are not discounts), add-ons go on top.
const unitPrice = (dish, variantId, modifierIds) => {
  const variant = variantId ? dish.variants.find((option) => option.id === variantId) : null;
  const base = variant ? variant.offerPrice ?? variant.price : dish.offerPrice ?? dish.price;
  const addOns = dish.modifiers
    .filter((modifier) => modifierIds.includes(modifier.id))
    .reduce((sum, modifier) => sum + modifier.price, 0);

  return Math.round((base + addOns) * 100) / 100;
};

// The same, without any running offer: shown struck through beside it.
const regularPrice = (dish, variantId, modifierIds) => {
  const variant = variantId ? dish.variants.find((option) => option.id === variantId) : null;
  const base = variant ? variant.price : dish.price;
  const addOns = dish.modifiers
    .filter((modifier) => modifierIds.includes(modifier.id))
    .reduce((sum, modifier) => sum + modifier.price, 0);

  return Math.round((base + addOns) * 100) / 100;
};

// What the card shows: the cheapest way to have the dish, and what it costs
// without the offer if one is running.
const cardPrice = (dish) => {
  if (dish.variants.length === 0) {
    return {
      now: dish.offerPrice ?? dish.price,
      was: dish.offerPrice !== null ? dish.price : null,
      from: false,
    };
  }

  const cheapest = [...dish.variants].sort(
    (a, b) => (a.offerPrice ?? a.price) - (b.offerPrice ?? b.price)
  )[0];

  return {
    now: cheapest.offerPrice ?? cheapest.price,
    was: cheapest.offerPrice !== null ? cheapest.price : null,
    from: dish.variants.length > 1,
  };
};

// The card's offer tag says what is on offer. An offer on one size only is
// named ("Offer on Full"), because the card's "from" price is the cheapest
// size, which may not be the one on offer.
const offerTag = (dish) => {
  if (dish.offerPrice !== null) {
    return "Offer";
  }

  const onOffer = dish.variants.filter((variant) => variant.offerPrice !== null);

  if (onOffer.length === 0) {
    return null;
  }

  return onOffer.length === dish.variants.length
    ? "Offer"
    : `Offer on ${onOffer.map((variant) => variant.name).join(" / ")}`;
};

const isCustomisable = (dish) => dish.variants.length > 0 || dish.modifiers.length > 0 || (dish.addonGroups||[]).length>0 || (dish.comboChoiceGroups||[]).length>0;

const lineIdentity = (line) =>
  [line.dishId, line.variantId || "", [...line.modifierIds].sort((a, b) => a - b).join("."), (line.notes || "").trim(),comboKey(line.comboSelections)].join("|");

const greeting = () => {
  const hour = new Date().getHours();

  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";

  return "Good evening";
};

const clockTime = (value) =>
  new Date(value).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });

const endsAt = (text) => {
  if (!text) return "";
  const [hours, minutes] = text.split(":").map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
};

const summarise = (items) => {
  const names = items.map((item) => `${item.quantity} × ${item.name}`);
  return names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2} more` : names.join(", ");
};

// ---------------------------------------------------------------- sheets

// A panel that slides up from the bottom on a phone and sits in the middle on
// a larger screen. Escape and the backdrop close it; the page behind it does
// not scroll while it is open.
function Sheet({ title, subtitle, onClose, children, footer, tone = "" }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    const previous = document.body.style.overflow;

    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div className="g-sheet-backdrop" onMouseDown={onClose}>
      <section
        className={`g-sheet ${tone}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="g-sheet-grip" aria-hidden="true" />
        <header className="g-sheet-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" className="g-round" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="g-sheet-body">{children}</div>
        {footer && <footer className="g-sheet-foot">{footer}</footer>}
      </section>
    </div>
  );
}

function Stepper({ value, onChange, min = 0, max = 20, label, small = false }) {
  return (
    <div className={`g-stepper ${small ? "is-small" : ""}`} role="group" aria-label={label}>
      <button
        type="button"
        onClick={() => onChange(value - 1)}
        disabled={value <= min}
        aria-label={`One less ${label}`}
      >
        <Icon name="minus" size={16} />
      </button>
      <span aria-live="polite">{value}</span>
      <button
        type="button"
        onClick={() => onChange(value + 1)}
        disabled={value >= max}
        aria-label={`One more ${label}`}
      >
        <Icon name="plus" size={16} />
      </button>
    </div>
  );
}

// Choosing a size, add-ons and a note for one dish.
function DishSheet({ dish, categoryName, currency, onClose, onAdd, canOrder }) {
  const defaultVariant = dish.variants.find((variant) => variant.isDefault) || dish.variants[0] || null;
  const [variantId, setVariantId] = useState(defaultVariant ? defaultVariant.id : null);
  const [modifierIds, setModifierIds] = useState([]);
  const [comboSelections,setComboSelections]=useState([]);
  const [notes, setNotes] = useState("");
  const [quantity, setQuantity] = useState(1);

  const each = unitPrice(dish, variantId, modifierIds)+comboExtra(dish.comboChoiceGroups,comboSelections);
  const toggle = (id) =>
    setModifierIds((current) =>
      current.includes(id) ? current.filter((one) => one !== id) : [...current, id]
    );

  return (
    <Sheet
      title={dish.name}
      onClose={onClose}
      tone="is-dish"
      footer={
        <div className="g-add-row">
          <Stepper value={quantity} onChange={setQuantity} min={1} label={dish.name} />
          <button
            type="button"
            className="g-primary g-grow"
            disabled={!canOrder || dish.soldOut || Boolean(choiceError(dish.addonGroups,modifierIds)) || Boolean(comboError(dish.comboChoiceGroups,comboSelections))}
            onClick={() => onAdd({ dish, variantId, modifierIds, comboSelections, notes: notes.trim(), quantity })}
          >
            {dish.soldOut ? "Sold out" : `Add to order · ${money(each * quantity, currency)}`}
          </button>
        </div>
      }
    >
      <div className="g-dish-hero">
        <DishPicture dish={dish} categoryName={categoryName} large />
      </div>
      <div className="g-dish-intro">
        <FoodMark type={dish.foodType} />
        <span className="g-muted">{FOOD_LABELS[dish.foodType]}</span>
        {dish.offerName && (
          <span className="g-offer-tag">
            <Icon name="sparkle" size={13} /> {dish.offerName}
          </span>
        )}
      </div>
      {dish.description && <p className="g-dish-text">{dish.description}</p>}

      {dish.includes.length > 0 && (
        <div className="g-block">
          <h3>What's on the plate</h3>
          <ul className="g-includes">
            {dish.includes.map((part) => (
              <li key={`${part.name}-${part.variant || ""}`}>
                {part.quantity > 1 ? `${part.quantity} × ` : ""}
                {part.name}
                {part.variant ? ` (${part.variant})` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {dish.variants.length > 0 && (
        <fieldset className="g-block">
          <legend>
            Choose a size <span className="g-required">Required</span>
          </legend>
          <div className="g-options">
            {dish.variants.map((variant) => (
              <label key={variant.id} className={`g-option ${variantId === variant.id ? "is-on" : ""}`}>
                <input
                  type="radio"
                  name={`size-${dish.id}`}
                  checked={variantId === variant.id}
                  onChange={() => setVariantId(variant.id)}
                />
                <span className="g-option-name">{variant.name}</span>
                <span className="g-option-price">
                  {variant.offerPrice !== null && <s>{money(variant.price, currency)}</s>}
                  {money(variant.offerPrice ?? variant.price, currency)}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <AddonChoiceRules groups={dish.addonGroups} selectedIds={modifierIds} modifiers={dish.modifiers}/>
      <ComboChoicePicker groups={dish.comboChoiceGroups} value={comboSelections} onChange={setComboSelections} currency={currency}/>
      {dish.modifiers.length > 0 && (
        <fieldset className="g-block">
          <legend>
            Add-ons <span className="g-optional">{(dish.addonGroups||[]).some(g=>g.min>0)?"Required choices below":"Optional"}</span>
          </legend>
          <div className="g-options">
            {dish.modifiers.map((modifier) => (
              <label key={modifier.id} className={`g-option ${modifierIds.includes(modifier.id) ? "is-on" : ""}`}>
                <input
                  type="checkbox"
                  checked={modifierIds.includes(modifier.id)}
                  onChange={() => toggle(modifier.id)}
                />
                <span className="g-option-name">{modifier.name}</span>
                <span className="g-option-price">
                  {modifier.price > 0 ? `+ ${money(modifier.price, currency)}` : "Free"}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <label className="g-block g-field">
        <span>Note for the chef</span>
        <textarea
          rows={2}
          maxLength={200}
          value={notes}
          placeholder="e.g. less spicy, no onion"
          onChange={(event) => setNotes(event.target.value)}
        />
        <small className="g-count">{notes.length}/200</small>
      </label>
    </Sheet>
  );
}

// The cart: on a phone in a sheet, on a tablet or laptop beside the menu.
function CartPanel({
  lines,
  currency,
  restaurant,
  tableNo,
  note,
  setNote,
  profile,
  setProfile,
  onQuantity,
  onPlace,
  placing,
  error,
  ordering,
  inSheet,
  privacy,
  onForget,
}) {
  const total = lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  const count = lines.reduce((sum, line) => sum + line.quantity, 0);

  if (lines.length === 0) {
    return (
      <div className="g-cart-empty">
        <span className="g-cart-empty-mark">
          <Icon name="bag" size={28} />
        </span>
        <p className="g-strong">Your order is empty</p>
        <p className="g-muted">Tap ADD on any dish. Staff confirm every order before it goes to the kitchen.</p>
      </div>
    );
  }

  return (
    <div className="g-cart">
      {!inSheet && (
        <div className="g-cart-title">
          <h2>Your order</h2>
          <span className="g-muted">Table {tableNo}</span>
        </div>
      )}
      <ul className="g-cart-lines">
        {lines.map((line) => (
          <li key={line.key}>
            <FoodMark type={line.foodType} />
            <div className="g-cart-line-text">
              <span className="g-strong">{line.name}</span>
              {(line.variantName || line.modifierNames.length > 0) && (
                <span className="g-muted g-small">
                  {[line.variantName, ...line.modifierNames].filter(Boolean).join(" · ")}
                </span>
              )}
              {line.notes && <span className="g-note-inline">“{line.notes}”</span>}
              <span className="g-cart-line-price">
                {money(line.unitPrice * line.quantity, currency)}
                {line.regularPrice > line.unitPrice && (
                  <s>{money(line.regularPrice * line.quantity, currency)}</s>
                )}
              </span>
            </div>
            <Stepper
              small
              value={line.quantity}
              onChange={(next) => onQuantity(line.key, next)}
              label={line.name}
            />
          </li>
        ))}
      </ul>

      <label className="g-field">
        <span>Anything we should know?</span>
        <textarea
          rows={2}
          maxLength={200}
          value={note}
          placeholder="Allergies, a birthday, bring the starters first…"
          onChange={(event) => setNote(event.target.value)}
        />
        <small className="g-count">{note.length}/200</small>
      </label>

      <div className="g-two">
        <label className="g-field">
          <span>
            Your name <em>optional</em>
          </span>
          <input
            value={profile.name}
            maxLength={80}
            autoComplete="given-name"
            placeholder="So we can greet you"
            onChange={(event) => setProfile({ ...profile, name: event.target.value })}
          />
        </label>
        <label className="g-field">
          <span>
            Mobile <em>optional</em>
          </span>
          <input
            value={profile.mobile}
            maxLength={16}
            inputMode="tel"
            autoComplete="tel"
            placeholder="For your bill"
            onChange={(event) => setProfile({ ...profile, mobile: event.target.value })}
          />
        </label>
      </div>
      {(profile.name || profile.mobile || privacy) && (
        <>
          <PrivacyNote privacy={privacy} restaurantName={restaurant.name} purpose="Your name and mobile, if you give them, are for this order and your bill." />
          {(profile.name || profile.mobile) && <ForgetDetails onForget={onForget} />}
        </>
      )}

      <dl className="g-totals">
        <div>
          <dt>
            Item total <span className="g-muted">({count} {count === 1 ? "item" : "items"})</span>
          </dt>
          <dd>{money(total, currency)}</dd>
        </div>
        <p className="g-muted g-small">
          {restaurant.taxMode === "inclusive" ? "Prices include GST." : "GST is added to your bill."}
          {restaurant.serviceChargePercentage > 0
            ? ` A ${restaurant.serviceChargePercentage}% service charge applies.`
            : ""}{" "}
          The final amount is on your bill.
        </p>
      </dl>

      {error && (
        <p className="g-error" role="alert">
          <Icon name="alert" size={16} /> {error}
        </p>
      )}

      {!ordering.enabled && ordering.reason && <p className="g-notice">{ordering.reason}</p>}

      <button
        type="button"
        className="g-primary g-block-button"
        disabled={placing || !ordering.enabled}
        onClick={onPlace}
      >
        {placing ? "Sending to staff…" : `Place order · ${money(total, currency)}`}
      </button>
      <p className="g-muted g-small g-center">Our staff confirm every order before it goes to the kitchen.</p>
    </div>
  );
}

const ORDER_STEPS = [
  { stage: "sent", label: "Sent" },
  { stage: "accepted", label: "Accepted" },
  { stage: "ready", label: "Ready" },
  { stage: "served", label: "Served" },
];

const STATUS_ICON = {
  sent: "send",
  accepted: "chef",
  ready: "bell",
  served: "heart",
  rejected: "alert",
  cancelled: "close",
  acknowledged: "check",
  done: "check",
};

function StatusView({ request, currency, onCancel, cancelling, onCallWaiter, onClose, now }) {
  const isOrder = request.type === "order";
  // Everything up to the current stage has happened; the next step is the
  // one the guest is waiting for.
  const reached = ORDER_STEPS.findIndex((step) => step.stage === request.stage);
  const waitingFor = reached + 1;
  const waitingLong =
    isOrder && request.stage === "sent" && now - new Date(request.createdAt).getTime() > SLOW_CONFIRM_MS;
  const tone =
    request.stage === "rejected"
      ? "is-bad"
      : ["cancelled"].includes(request.stage)
        ? "is-muted"
        : request.stage === "sent"
          ? "is-waiting"
          : "is-good";

  return (
    <div className="g-status">
      <div className={`g-status-badge ${tone}`}>
        <span className={`g-status-icon ${request.stage === "sent" ? "is-pulsing" : ""}`}>
          <Icon name={STATUS_ICON[request.stage] || "clock"} size={30} />
        </span>
        <h3>{request.label}</h3>
        {request.detail && <p>{request.detail}</p>}
        {request.orderNumber && <p className="g-small">Order {request.orderNumber}</p>}
      </div>

      {isOrder && reached >= 0 && (
        <ol className="g-steps" aria-label="Order progress">
          {ORDER_STEPS.map((step, index) => (
            <li
              key={step.stage}
              className={index <= reached ? "is-done" : index === waitingFor ? "is-now" : ""}
            >
              <span className="g-step-dot">{index <= reached ? <Icon name="check" size={12} /> : null}</span>
              <span>{step.label}</span>
            </li>
          ))}
        </ol>
      )}

      {waitingLong && (
        <div className="g-notice g-notice-row">
          <span>Taking longer than usual? A waiter can confirm it for you.</span>
          <button type="button" className="g-secondary" onClick={onCallWaiter}>
            Call waiter
          </button>
        </div>
      )}

      {isOrder && request.items.length > 0 && (
        <div className="g-status-items">
          <h4>
            {request.itemCount} {request.itemCount === 1 ? "item" : "items"} · sent at {clockTime(request.createdAt)}
          </h4>
          <ul>
            {request.items.map((item, index) => (
              <li key={`${item.name}-${index}`}>
                <FoodMark type={item.foodType} />
                <span className="g-grow">
                  {item.quantity} × {item.name}
                  {item.variant ? ` (${item.variant})` : ""}
                  {item.modifiers.length > 0 && <small className="g-muted"> + {item.modifiers.join(", ")}</small>}
                  {item.notes && <small className="g-note-inline"> “{item.notes}”</small>}
                </span>
                <span>{money(item.lineTotal, currency)}</span>
              </li>
            ))}
          </ul>
          <p className="g-status-total">
            <span>Item total</span>
            <strong>{money(request.itemsTotal, currency)}</strong>
          </p>
          {request.notes && <p className="g-note-inline">Your note: “{request.notes}”</p>}
        </div>
      )}

      {!isOrder && request.notes && <p className="g-note-inline">You asked: “{request.notes}”</p>}

      <div className="g-status-actions">
        {request.canCancel && (
          <button type="button" className="g-secondary" onClick={onCancel} disabled={cancelling}>
            {cancelling ? "Cancelling…" : isOrder ? "Cancel this order" : "Cancel request"}
          </button>
        )}
        <button type="button" className="g-primary g-grow" onClick={onClose}>
          {isOrder && request.stage !== "rejected" ? "Back to the menu" : "Done"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the page

export default function QrLandingPage() {
  const { token } = useParams();

  const [menu, setMenu] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const [search, setSearch] = useState("");
  const [vegOnly, setVegOnly] = useState(false);
  const [activeCategory, setActiveCategory] = useState(null);

  const [cart, setCart] = useState(() => {
    const saved = readStore(cartKey(token), []);
    return Array.isArray(saved) ? saved : [];
  });
  const [orderNote, setOrderNote] = useState("");
  const [profile, setProfile] = useState(() => ({ name: "", mobile: "", ...readStore(PROFILE_KEY, {}) }));
  const [placing, setPlacing] = useState(false);
  const [cartError, setCartError] = useState("");
  const clientKeyRef = useRef(null);

  const [tracked, setTracked] = useState(() => loadTracked(token));
  const [requests, setRequests] = useState({});
  const requestsRef = useRef({});
  const [now, setNow] = useState(() => Date.now());

  const [sheet, setSheet] = useState(null);
  const [toast, setToast] = useState(null);
  const [calling, setCalling] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [otherText, setOtherText] = useState("");

  const [rating, setRating] = useState(0);
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackState, setFeedbackState] = useState(() =>
    readStore(feedbackKey(token), null) ? "sent" : "idle"
  );
  const [feedbackError, setFeedbackError] = useState("");

  const sectionRefs = useRef(new Map());
  const tabRefs = useRef(new Map());
  const toolbarRef = useRef(null);
  const jumpRef = useRef(null);

  // ---------------------------------------------------------------- loading

  useEffect(() => {
    let alive = true;

    getGuestMenu(token)
      .then((data) => {
        if (!alive) return;
        setMenu(data);
        setLoadError("");
        setNotFound(false);
        setActiveCategory((current) => current ?? (data.categories[0] ? data.categories[0].id : null));
      })
      .catch((error) => {
        if (!alive) return;
        setNotFound(error.response?.status === 404);
        setLoadError(guestErrorMessage(error));
      });

    return () => {
      alive = false;
    };
  }, [token, attempt]);

  useEffect(() => {
    if (menu) {
      document.title = `${menu.restaurant.name} · Table ${menu.table.tableNo}`;
    }
  }, [menu]);

  // The cart and the guest's details survive a reload or a locked screen.
  useEffect(() => writeStore(cartKey(token), cart), [token, cart]);
  useEffect(() => writeStore(trackKey(token), tracked), [token, tracked]);
  useEffect(() => writeStore(PROFILE_KEY, profile), [profile]);

  // A changed cart is a different order, so it gets a new idempotency key. An
  // unchanged cart sent again after a failed attempt keeps its key, so if the
  // first attempt did arrive, the retry is recognised rather than doubled.
  useEffect(() => {
    clientKeyRef.current = null;
  }, [cart, orderNote]);

  useEffect(() => {
    requestsRef.current = requests;
  }, [requests]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(tick);
  }, []);

  // Following up on this phone's requests: all of them once, then only the
  // ones still moving, while the page is in view — quickly while one waits
  // for the staff, slowly while the kitchen cooks.
  const trackedIds = useMemo(() => tracked.map((entry) => entry.id).join(","), [tracked]);

  useEffect(() => {
    if (!menu || !trackedIds) {
      return undefined;
    }

    let alive = true;
    let timer = null;
    const ids = trackedIds.split(",").map(Number);
    // What this loop last heard, so the next wait is chosen from the answer
    // just received rather than from state React has not rendered yet.
    const latest = { ...requestsRef.current };

    const refresh = (onlyOpen) => {
      const wanted = onlyOpen ? ids.filter((id) => !latest[id] || !latest[id].final) : ids;

      if (document.visibilityState === "hidden" || wanted.length === 0) {
        return Promise.resolve();
      }

      return getGuestRequests(token, wanted)
        .then((rows) => {
          if (!alive) return;

          // A request the restaurant no longer shows this table — from an
          // earlier sitting, once the table has paid up — is dropped from
          // this phone's list too.
          const returned = new Set(rows.map((row) => row.id));
          const gone = wanted.filter((id) => !returned.has(id));

          for (const row of rows) {
            latest[row.id] = row;
          }

          setRequests((current) => {
            const next = { ...current };
            for (const row of rows) {
              next[row.id] = row;
            }
            for (const id of gone) {
              delete next[id];
            }
            return next;
          });

          if (gone.length > 0) {
            setTracked((current) => current.filter((entry) => !gone.includes(entry.id)));
          }
        })
        .catch(() => undefined);
    };

    const schedule = () => {
      if (!alive) return;

      const open = ids.filter((id) => !latest[id] || !latest[id].final);
      const waitingOnStaff = open.some((id) => !latest[id] || latest[id].stage === "sent");

      timer = setTimeout(
        () => refresh(true).then(schedule),
        waitingOnStaff ? POLL_WAITING : POLL_COOKING
      );
    };

    refresh(false).then(schedule);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [token, menu, trackedIds]);

  useEffect(() => {
    if (!toast) {
      return undefined;
    }

    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  // ---------------------------------------------------------------- the menu, filtered

  const dishById = useMemo(() => {
    const map = new Map();

    for (const category of menu ? menu.categories : []) {
      for (const dish of category.dishes) {
        map.set(dish.id, { dish, categoryName: category.name });
      }
    }

    return map;
  }, [menu]);

  const visibleCategories = useMemo(() => {
    if (!menu) {
      return [];
    }

    const term = search.trim().toLowerCase();

    return menu.categories
      .map((category) => ({
        ...category,
        dishes: category.dishes.filter(
          (dish) =>
            (!vegOnly || dish.foodType === "veg") &&
            (!term ||
              dish.name.toLowerCase().includes(term) ||
              (dish.description || "").toLowerCase().includes(term))
        ),
      }))
      .filter((category) => category.dishes.length > 0);
  }, [menu, search, vegOnly]);

  // Which category is being read, for the tab strip: the last section whose
  // heading has reached the bottom of the sticky search-and-tabs bar — the
  // one the guest is looking at, not merely the first one partly on screen.
  // At the very end of the page the last sections may never climb that high,
  // so there it is the last one whose heading is in the top of the view.
  // Worked out on scroll, once a frame, and set from that callback, never
  // while rendering.
  useEffect(() => {
    if (visibleCategories.length === 0) {
      return undefined;
    }

    let frame = 0;

    const pickActive = () => {
      frame = 0;

      // A tapped tab wins while the page glides to its section.
      if (jumpRef.current !== null) {
        return;
      }

      const bar = toolbarRef.current;
      const line = (bar ? bar.getBoundingClientRect().bottom : 170) + 24;
      const atEnd =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      let current = visibleCategories[0].id;

      for (const category of visibleCategories) {
        const section = sectionRefs.current.get(category.id);

        if (!section) {
          continue;
        }

        const top = section.getBoundingClientRect().top;

        if (top <= line || (atEnd && top < window.innerHeight * 0.6)) {
          current = category.id;
        } else {
          break;
        }
      }

      setActiveCategory(current);
    };

    const onScroll = () => {
      if (!frame) {
        frame = requestAnimationFrame(pickActive);
      }
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    onScroll();

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [visibleCategories]);

  useEffect(() => {
    const tab = tabRefs.current.get(activeCategory);

    if (tab && tab.parentElement) {
      const strip = tab.parentElement;
      strip.scrollTo({ left: tab.offsetLeft - strip.clientWidth / 2 + tab.clientWidth / 2, behavior: "smooth" });
    }
  }, [activeCategory]);

  const jumpTo = (categoryId) => {
    const section = sectionRefs.current.get(categoryId);

    setActiveCategory(categoryId);
    // Long enough for a smooth scroll to land; the tapped tab stays lit
    // rather than flickering through every section on the way.
    window.clearTimeout(jumpRef.current);
    jumpRef.current = window.setTimeout(() => {
      jumpRef.current = null;
    }, 900);

    if (section) {
      section.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  // ---------------------------------------------------------------- the cart

  // Lines are stored as choices only; names and prices come from the menu as
  // it is now, so a reload after happy hours ends shows the real price, and a
  // dish that has since sold out drops out of the cart instead of failing later.
  const cartLines = useMemo(
    () =>
      cart
        .map((line) => {
          const found = dishById.get(line.dishId);

          if (!found || found.dish.soldOut) {
            return null;
          }

          const { dish } = found;
          const variant = line.variantId ? dish.variants.find((option) => option.id === line.variantId) : null;

          if ((line.variantId && !variant) || (!line.variantId && dish.variants.length > 0)) {
            return null;
          }

          const modifierIds = line.modifierIds.filter((id) => dish.modifiers.some((modifier) => modifier.id === id));

          return {
            ...line,
            modifierIds,
            name: dish.name,
            foodType: dish.foodType,
            variantName: variant ? variant.name : null,
            modifierNames: [...dish.modifiers.filter((modifier) => modifierIds.includes(modifier.id)).map((m) => m.name),...comboParts(dish.comboChoiceGroups,line.comboSelections).map(p=>`${p.groupName}: ${p.name}`)],
            unitPrice: unitPrice(dish, line.variantId, modifierIds)+comboExtra(dish.comboChoiceGroups,line.comboSelections),
            regularPrice: regularPrice(dish, line.variantId, modifierIds)+comboExtra(dish.comboChoiceGroups,line.comboSelections),
          };
        })
        .filter(Boolean),
    [cart, dishById]
  );

  const droppedFromCart = menu ? cart.length - cartLines.length : 0;
  const cartCount = cartLines.reduce((sum, line) => sum + line.quantity, 0);
  const cartTotal = cartLines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);

  const countInCart = (dishId) =>
    cartLines.filter((line) => line.dishId === dishId).reduce((sum, line) => sum + line.quantity, 0);

  const addLine = ({ dish, variantId, modifierIds, notes, quantity, comboSelections=[] }) => {
    const incoming = { dishId: dish.id, variantId: variantId || null, modifierIds, notes: notes || "",comboSelections };
    const identity = lineIdentity(incoming);

    setCart((current) => {
      const same = current.find((line) => lineIdentity(line) === identity);

      if (same) {
        return current.map((line) =>
          line === same ? { ...line, quantity: Math.min(20, line.quantity + quantity) } : line
        );
      }

      return [...current, { ...incoming, key: `${identity}#${Date.now()}`, quantity: Math.min(20, quantity) }];
    });
    setCartError("");
  };

  const setLineQuantity = (key, quantity) =>
    setCart((current) =>
      quantity <= 0
        ? current.filter((line) => line.key !== key)
        : current.map((line) => (line.key === key ? { ...line, quantity: Math.min(20, quantity) } : line))
    );

  // The quick "+ / −" on a plain dish's card works on its one plain line.
  const plainLine = (dishId) =>
    cartLines.find((line) => line.dishId === dishId && !line.variantId && line.modifierIds.length === 0 && !line.notes);

  const tapAdd = (dish, categoryName) => {
    if (isCustomisable(dish)) {
      setSheet({ type: "dish", dish, categoryName });
      return;
    }

    addLine({ dish, variantId: null, modifierIds: [], notes: "", quantity: 1 });
  };

  const track = useCallback((request) => {
    setRequests((current) => ({ ...current, [request.id]: request }));
    setTracked((current) =>
      current.some((entry) => entry.id === request.id)
        ? current
        : [{ id: request.id, at: Date.now() }, ...current].slice(0, 30)
    );
  }, []);

  const placeOrder = async () => {
    if (!clientKeyRef.current) {
      clientKeyRef.current = newClientKey();
    }

    setPlacing(true);
    setCartError("");

    try {
      const request = await placeGuestOrder(token, {
        clientKey: clientKeyRef.current,
        items: cartLines.map((line) => ({
          productId: line.dishId,
          variantId: line.variantId,
          modifierIds: line.modifierIds,
          comboSelections: line.comboSelections || [],
          quantity: line.quantity,
          notes: line.notes || null,
        })),
        notes: orderNote.trim() || null,
        guestName: profile.name.trim() || null,
        guestMobile: profile.mobile.trim() || null,
      });

      track(request);
      setCart([]);
      setOrderNote("");
      clientKeyRef.current = null;
      setSheet({ type: "status", id: request.id });
    } catch (error) {
      setCartError(guestErrorMessage(error));
    } finally {
      setPlacing(false);
    }
  };

  // ---------------------------------------------------------------- calls and feedback

  const openCallOf = (type) =>
    Object.values(requests).find(
      (request) => request.type === type && !request.final && tracked.some((entry) => entry.id === request.id)
    );

  const call = async (type, message) => {
    setCalling(type);

    try {
      const response = await callStaff(token, { type, message: message || null, clientKey: newClientKey() });
      track(response.data);
      setToast({ title: "Someone is on the way", message: response.message, tone: "good" });
      setSheet((current) => (current && ["help", "other"].includes(current.type) ? null : current));
      setOtherText("");
    } catch (error) {
      setToast({ title: "That didn't go through", message: guestErrorMessage(error), tone: "bad" });
    } finally {
      setCalling("");
    }
  };

  const cancelRequest = async (id) => {
    setCancelling(true);

    try {
      const updated = await cancelGuestRequest(token, id);
      setRequests((current) => ({ ...current, [id]: updated }));
    } catch (error) {
      setToast({ title: "Couldn't cancel", message: guestErrorMessage(error), tone: "bad" });
    } finally {
      setCancelling(false);
    }
  };

  const submitFeedback = async () => {
    setFeedbackState("sending");
    setFeedbackError("");

    try {
      await sendGuestFeedback(token, {
        rating,
        comment: feedbackText.trim() || null,
        name: profile.name.trim() || null,
        mobile: profile.mobile.trim() || null,
      });
      writeStore(feedbackKey(token), Date.now());
      setFeedbackState("sent");
    } catch (error) {
      setFeedbackError(guestErrorMessage(error));
      setFeedbackState("idle");
    }
  };

  // ---------------------------------------------------------------- render

  if (!menu) {
    if (loadError) {
      return (
        <div className="guest-app guest-center">
          <div className="g-problem">
            <span className="g-problem-mark">
              <Icon name={notFound ? "qrOff" : "alert"} size={34} />
            </span>
            <h1>{notFound ? "We couldn't find this table" : "Something went wrong"}</h1>
            <p>
              {notFound
                ? "This QR code may be out of date. Please ask a member of staff — they'll be happy to take your order."
                : loadError}
            </p>
            {!notFound && (
              <button type="button" className="g-primary" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </button>
            )}
          </div>
        </div>
      );
    }

    return (
      <div className="guest-app" aria-busy="true">
        <div className="g-skeleton-hero skeleton" />
        <div className="g-shell">
          {[0, 1, 2, 3].map((n) => (
            <div key={n} className="g-skeleton-card">
              <span className="skeleton" />
              <span className="skeleton" />
              <span className="skeleton" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const { restaurant, table, ordering } = menu;
  const currency = restaurant.currencySymbol;
  const trackedRequests = tracked.map((entry) => requests[entry.id]).filter(Boolean);
  const liveCount = trackedRequests.filter((request) => !request.final).length;
  const statusRequest = sheet && sheet.type === "status" ? requests[sheet.id] : null;
  const place = [table.floorName, table.areaName].filter(Boolean).join(" · ");
  const monogram = restaurant.name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();

  const cartPanelProps = {
    lines: cartLines,
    currency,
    restaurant,
    tableNo: table.tableNo,
    note: orderNote,
    setNote: setOrderNote,
    profile,
    setProfile,
    onQuantity: setLineQuantity,
    onPlace: placeOrder,
    placing,
    error: cartError,
    ordering,
    privacy: menu.privacy || null,
    onForget: () => setProfile({ name: "", mobile: "" }),
  };

  return (
    <div className={`guest-app ${cartCount > 0 ? "has-cartbar" : ""}`}>
      <header className="g-topbar">
        <div className="g-topbar-inner">
          <span className="g-monogram" aria-hidden="true">
            {monogram}
          </span>
          <div className="g-topbar-title">
            <strong>{restaurant.name}</strong>
            <span>Table {table.tableNo}</span>
          </div>
          {trackedRequests.length > 0 && (
            <button type="button" className="g-pill" onClick={() => setSheet({ type: "requests" })}>
              <Icon name="list" size={16} />
              <span className="g-hide-narrow">Your orders</span>
              {liveCount > 0 && <span className="g-pill-count">{liveCount}</span>}
            </button>
          )}
          {ordering.callsEnabled && (
            <button type="button" className="g-pill g-pill-accent" onClick={() => setSheet({ type: "help" })}>
              <Icon name="bell" size={16} />
              <span>Call staff</span>
            </button>
          )}
        </div>
      </header>

      <div className="g-shell">
        <section className="g-hero">
          <div className="g-hero-text">
            <p className="g-hero-kicker">{greeting()}</p>
            <h1>Welcome to {restaurant.name}</h1>
            <p className="g-hero-table">
              <span className="g-table-chip">Table {table.tableNo}</span>
              {place && <span>{place}</span>}
            </p>
            {ordering.note && <p className="g-hero-note">{ordering.note}</p>}
          </div>

          <div className="g-hero-seat" aria-hidden="true">
            <span className="g-hero-seat-ring">
              <strong>{table.tableNo}</strong>
            </span>
            <span>Your table</span>
          </div>

          {ordering.callsEnabled && (
            <div className="g-quick" role="group" aria-label="Ask the staff">
              {CALLS.map((option) => {
                const open = openCallOf(option.type);

                return (
                  <button
                    key={option.type}
                    type="button"
                    className={`g-quick-button ${open ? "is-open" : ""}`}
                    onClick={() => call(option.type)}
                    disabled={calling === option.type}
                  >
                    <span className="g-quick-icon">
                      <Icon name={option.icon} size={22} />
                    </span>
                    <span>{calling === option.type ? "Sending…" : open ? option.busy : option.label}</span>
                  </button>
                );
              })}
              <button type="button" className="g-quick-button" onClick={() => setSheet({ type: "other" })}>
                <span className="g-quick-icon">
                  <Icon name="dots" size={22} />
                </span>
                <span>Something else</span>
              </button>
            </div>
          )}
        </section>

        {!ordering.enabled && (
          <div className="g-banner is-paused" role="status">
            <Icon name="pause" size={18} />
            <span>{ordering.reason} You can still browse the menu.</span>
          </div>
        )}

        {menu.offers.length > 0 && (
          <div className="g-banner is-offer">
            <Icon name="sparkle" size={18} />
            <span>
              {menu.offers
                .map(
                  (offer) =>
                    `${offer.name} — ${offer.dishCount} ${offer.dishCount === 1 ? "dish" : "dishes"} at special prices until ${endsAt(offer.endsAt)}`
                )
                .join(" · ")}
            </span>
          </div>
        )}

        {droppedFromCart > 0 && (
          <div className="g-banner is-paused" role="status">
            <Icon name="alert" size={18} />
            <span>
              {droppedFromCart === 1 ? "A dish" : `${droppedFromCart} dishes`} in your order sold out and{" "}
              {droppedFromCart === 1 ? "was" : "were"} removed.
            </span>
          </div>
        )}

        <div className="g-layout">
          <main className="g-menu">
            <div className="g-toolbar" ref={toolbarRef}>
              <div className="g-search-row">
                <label className="g-search">
                  <Icon name="search" size={18} />
                  <input
                    type="search"
                    value={search}
                    placeholder="Search dishes"
                    aria-label="Search dishes"
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className={`g-veg-toggle ${vegOnly ? "is-on" : ""}`}
                  aria-pressed={vegOnly}
                  onClick={() => setVegOnly((value) => !value)}
                >
                  <FoodMark type="veg" />
                  <span>
                    Veg<span className="g-hide-narrow"> only</span>
                  </span>
                  <span className="g-switch" aria-hidden="true" />
                </button>
              </div>
              {visibleCategories.length > 0 && (
                <nav className="g-tabs" aria-label="Menu sections">
                  {visibleCategories.map((category) => (
                    <button
                      key={category.id}
                      type="button"
                      ref={(element) => {
                        if (element) tabRefs.current.set(category.id, element);
                        else tabRefs.current.delete(category.id);
                      }}
                      className={`g-tab ${activeCategory === category.id ? "is-active" : ""}`}
                      onClick={() => jumpTo(category.id)}
                    >
                      {category.name}
                      <span>{category.dishes.length}</span>
                    </button>
                  ))}
                </nav>
              )}
            </div>

            {visibleCategories.length === 0 && (
              <div className="g-empty">
                <Icon name="search" size={28} />
                <p className="g-strong">No dishes match “{search || (vegOnly ? "Veg only" : "")}”</p>
                <button
                  type="button"
                  className="g-secondary"
                  onClick={() => {
                    setSearch("");
                    setVegOnly(false);
                  }}
                >
                  Show the whole menu
                </button>
              </div>
            )}

            {visibleCategories.map((category) => (
              <section
                key={category.id}
                id={`menu-${category.id}`}
                data-category={category.id}
                className="g-section"
                ref={(element) => {
                  if (element) sectionRefs.current.set(category.id, element);
                  else sectionRefs.current.delete(category.id);
                }}
              >
                <h2 className="g-section-title">
                  {category.name}
                  <span>{category.dishes.length}</span>
                </h2>
                {category.description && <p className="g-muted g-section-text">{category.description}</p>}

                <ul className="g-dishes">
                  {category.dishes.map((dish) => {
                    const price = cardPrice(dish);
                    const inCart = countInCart(dish.id);
                    const plain = plainLine(dish.id);
                    const customisable = isCustomisable(dish);

                    return (
                      <li key={dish.id} className={`g-dish ${dish.soldOut ? "is-soldout" : ""}`}>
                        <button
                          type="button"
                          className="g-dish-main"
                          onClick={() => setSheet({ type: "dish", dish, categoryName: category.name })}
                          aria-label={`${dish.name}, details`}
                        >
                          <span className="g-dish-head">
                            <FoodMark type={dish.foodType} />
                            {offerTag(dish) && (
                              <span className="g-offer-tag">
                                <Icon name="sparkle" size={12} /> {offerTag(dish)}
                              </span>
                            )}
                            {dish.isCombo && <span className="g-combo-tag">Combo</span>}
                          </span>
                          <span className="g-dish-name">{dish.name}</span>
                          <span className="g-dish-price">
                            {price.from && <span className="g-from">from</span>}
                            <strong>{money(price.now, currency)}</strong>
                            {price.was !== null && <s>{money(price.was, currency)}</s>}
                          </span>
                          {dish.description && <span className="g-dish-desc">{dish.description}</span>}
                          {dish.includes.length > 0 && (
                            <span className="g-dish-desc">
                              {dish.includes.map((part) => part.name).join(" · ")}
                            </span>
                          )}
                        </button>

                        <div className="g-dish-side">
                          <DishPicture dish={dish} categoryName={category.name} />
                          {dish.soldOut ? (
                            <span className="g-soldout">Sold out</span>
                          ) : plain && !customisable ? (
                            <div className="g-add-stepper">
                              <Stepper
                                small
                                value={plain.quantity}
                                onChange={(next) => setLineQuantity(plain.key, next)}
                                label={dish.name}
                              />
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="g-add"
                              disabled={!ordering.enabled}
                              onClick={() => tapAdd(dish, category.name)}
                            >
                              ADD
                              {customisable && <Icon name="plus" size={12} />}
                            </button>
                          )}
                          {customisable && !dish.soldOut && (
                            <span className="g-custom-note">
                              {inCart > 0 ? `${inCart} in your order` : "Customisable"}
                            </span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}

            <section className="g-feedback" aria-labelledby="feedback-title">
              {feedbackState === "sent" ? (
                <div className="g-feedback-done">
                  <span className="g-feedback-mark">
                    <Icon name="heart" size={26} />
                  </span>
                  <div>
                    <h2 id="feedback-title">Thank you for your feedback</h2>
                    <p className="g-muted">It goes straight to the manager. We hope to see you again soon.</p>
                  </div>
                </div>
              ) : (
                <>
                  <h2 id="feedback-title">How was everything?</h2>
                  <p className="g-muted">Tell the manager directly — it takes ten seconds.</p>
                  <div className="g-stars" role="radiogroup" aria-label="Your rating">
                    {[1, 2, 3, 4, 5].map((value) => (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={rating === value}
                        aria-label={`${value} ${value === 1 ? "star" : "stars"}`}
                        className={`g-star ${value <= rating ? "is-on" : ""}`}
                        onClick={() => setRating(value)}
                      >
                        <Icon name="star" size={30} />
                      </button>
                    ))}
                  </div>
                  {rating > 0 && (
                    <div className="g-feedback-form">
                      <label className="g-field">
                        <span>{rating >= 4 ? "What did you enjoy?" : "What could we do better?"}</span>
                        <textarea
                          rows={3}
                          maxLength={500}
                          value={feedbackText}
                          placeholder={rating >= 4 ? "The biryani, the service…" : "We read every word"}
                          onChange={(event) => setFeedbackText(event.target.value)}
                        />
                      </label>
                      {feedbackError && <p className="g-error">{feedbackError}</p>}
                      <button
                        type="button"
                        className="g-primary"
                        disabled={feedbackState === "sending"}
                        onClick={submitFeedback}
                      >
                        {feedbackState === "sending" ? "Sending…" : "Send feedback"}
                      </button>
                    </div>
                  )}
                </>
              )}
            </section>

            <footer className="g-footer">
              <p>
                {restaurant.name} · Table {table.tableNo}
              </p>
              <p>Prices in {currency}. Every order is confirmed by our staff.</p>
            </footer>
          </main>

          <aside className="g-aside" aria-label="Your order">
            <CartPanel {...cartPanelProps} inSheet={false} />
          </aside>
        </div>
      </div>

      {cartCount > 0 && (
        <div className="g-cartbar">
          <button type="button" onClick={() => setSheet({ type: "cart" })}>
            <span className="g-cartbar-count">
              <Icon name="bag" size={18} />
              {cartCount} {cartCount === 1 ? "item" : "items"}
            </span>
            <span className="g-cartbar-total">{money(cartTotal, currency)}</span>
            <span className="g-cartbar-go">
              View order <Icon name="chevron" size={18} />
            </span>
          </button>
        </div>
      )}

      {toast && (
        <div className={`g-toast is-${toast.tone}`} role="status">
          <span className="g-toast-icon">
            <Icon name={toast.tone === "good" ? "check" : "alert"} size={18} />
          </span>
          <div>
            <strong>{toast.title}</strong>
            {toast.message && <p>{toast.message}</p>}
          </div>
          <button type="button" className="g-round" onClick={() => setToast(null)} aria-label="Dismiss">
            <Icon name="close" size={16} />
          </button>
        </div>
      )}

      {sheet && sheet.type === "dish" && (
        <DishSheet
          key={sheet.dish.id}
          dish={sheet.dish}
          categoryName={sheet.categoryName}
          currency={currency}
          canOrder={ordering.enabled}
          onClose={() => setSheet(null)}
          onAdd={(choice) => {
            addLine(choice);
            setSheet(null);
          }}
        />
      )}

      {sheet && sheet.type === "cart" && (
        <Sheet title="Your order" subtitle={`Table ${table.tableNo}`} onClose={() => setSheet(null)}>
          <CartPanel {...cartPanelProps} inSheet />
        </Sheet>
      )}

      {sheet && sheet.type === "status" && statusRequest && (
        <Sheet
          title={statusRequest.type === "order" ? "Your order" : "Your request"}
          subtitle={`Table ${table.tableNo}`}
          onClose={() => setSheet(null)}
        >
          <StatusView
            request={statusRequest}
            currency={currency}
            now={now}
            cancelling={cancelling}
            onCancel={() => cancelRequest(statusRequest.id)}
            onCallWaiter={() => call("call_waiter")}
            onClose={() => setSheet(null)}
          />
        </Sheet>
      )}

      {sheet && sheet.type === "requests" && (
        <Sheet title="Your orders & requests" subtitle={`From this phone · Table ${table.tableNo}`} onClose={() => setSheet(null)}>
          <ul className="g-requests">
            {trackedRequests.map((request) => (
              <li key={request.id}>
                <button type="button" onClick={() => setSheet({ type: "status", id: request.id })}>
                  <span className={`g-request-icon is-${request.stage}`}>
                    <Icon name={STATUS_ICON[request.stage] || "clock"} size={18} />
                  </span>
                  <span className="g-grow">
                    <strong>
                      {request.type === "order"
                        ? `Order · ${request.itemCount} ${request.itemCount === 1 ? "item" : "items"}`
                        : CALLS.find((option) => option.type === request.type)?.label || "Request"}
                    </strong>
                    <span className="g-muted g-small">
                      {clockTime(request.createdAt)}
                      {request.type === "order" && request.items.length > 0 ? ` · ${summarise(request.items)}` : ""}
                      {request.type === "other" && request.notes ? ` · ${request.notes}` : ""}
                    </span>
                  </span>
                  <span className={`g-stage is-${request.stage}`}>{request.label.split(" — ")[0]}</span>
                </button>
              </li>
            ))}
          </ul>
        </Sheet>
      )}

      {sheet && sheet.type === "help" && (
        <Sheet title="How can we help?" subtitle={`We'll send someone to table ${table.tableNo}`} onClose={() => setSheet(null)}>
          <div className="g-help-grid">
            {CALLS.map((option) => (
              <button
                key={option.type}
                type="button"
                className="g-help-button"
                disabled={calling === option.type}
                onClick={() => call(option.type)}
              >
                <span className="g-quick-icon">
                  <Icon name={option.icon} size={24} />
                </span>
                <span>{calling === option.type ? "Sending…" : option.label}</span>
              </button>
            ))}
            <button type="button" className="g-help-button" onClick={() => setSheet({ type: "other" })}>
              <span className="g-quick-icon">
                <Icon name="dots" size={24} />
              </span>
              <span>Something else</span>
            </button>
          </div>
        </Sheet>
      )}

      {sheet && sheet.type === "other" && (
        <Sheet
          title="What do you need?"
          subtitle={`We'll pass it to the staff at table ${table.tableNo}`}
          onClose={() => setSheet(null)}
          footer={
            <button
              type="button"
              className="g-primary g-block-button"
              disabled={!otherText.trim() || calling === "other"}
              onClick={() => call("other", otherText.trim())}
            >
              {calling === "other" ? "Sending…" : "Send to staff"}
            </button>
          }
        >
          <div className="g-chips">
            {OTHER_SUGGESTIONS.map((text) => (
              <button
                key={text}
                type="button"
                className={`g-chip ${otherText === text ? "is-on" : ""}`}
                onClick={() => setOtherText(text)}
              >
                {text}
              </button>
            ))}
          </div>
          <label className="g-field">
            <span>Or tell us in your own words</span>
            <textarea
              rows={3}
              maxLength={120}
              value={otherText}
              placeholder="e.g. Could we move to a table by the window?"
              onChange={(event) => setOtherText(event.target.value)}
            />
            <small className="g-count">{otherText.length}/120</small>
          </label>
        </Sheet>
      )}
    </div>
  );
}
