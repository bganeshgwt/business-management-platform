import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import AddonChoiceRules from "../../../../components/AddonChoiceRules";
import ComboChoicePicker from "../../../../components/ComboChoicePicker";
import { comboError, comboExtra, comboKey, comboParts } from "../../../../services/comboChoices";
import { choiceError } from "../../../../services/addonChoices";
import { dishImageUrl, guestErrorMessage, newClientKey } from "../../crm/services/guest.service";
import {
  cancelOnlineOrder,
  getOnlineMenu,
  getOnlineOrder,
  placeOnlineOrder,
} from "../services/onlineOrder.service";
import { money } from "../../../../services/format";
import "../../../../styles/guest.css";
import "../styles/online-order.css";

// The restaurant's own online ordering page (SW-A-22): /online/<link>, and
// each order's own status page, /online/<link>/status/<guest token>.
//
// A guest here is at home or at the office, on a phone, deciding between us
// and an app. So: the takeaway or delivery price is the price (packing
// shown), the delivery charge and the minimum are said before checkout, the
// kitchen's hours are on the page, a sold-out dish says so, and after
// ordering the page follows the order — Sent, Accepted, Ready, then Out for
// delivery or Ready for pickup — so nobody has to phone to ask. Nothing is
// cooked until the restaurant accepts the order, and the page says so.
// Paying online is not offered until a payment gateway is connected: the
// page says that too, rather than showing a button that pretends.

// How often a status page asks: quickly while the restaurant has yet to
// answer, then at the pace of a kitchen.
const POLL_WAITING = 8000;
const POLL_COOKING = 20000;
// Orders this phone follows, for "Your orders": a day's worth.
const TRACK_HOURS = 24;

const FOOD_LABELS = { veg: "Vegetarian", non_veg: "Non-vegetarian", egg: "Contains egg" };
const SERVICE_LABELS = { takeaway: "Takeaway", delivery: "Delivery" };
const PAYMENT_LABELS = { pay_at_pickup: "Pay when you collect", cash_on_delivery: "Cash on delivery" };

// ---------------------------------------------------------------- storage

// Per phone, per link: the cart, the guest's details and the orders this
// phone is following. Storage may be blocked (private mode); the visit still
// works, it just is not remembered.
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
    // Blocked or full.
  }
};

const cartKey = (token) => `rmp_online_cart_${token}`;
const trackKey = (token) => `rmp_online_orders_${token}`;
const PROFILE_KEY = "rmp_online_profile";

const loadTracked = (token) => {
  const cutoff = Date.now() - TRACK_HOURS * 3600 * 1000;
  const list = readStore(trackKey(token), []);

  return Array.isArray(list)
    ? list.filter((entry) => entry && /^[a-f0-9]{48}$/.test(entry.guestToken || "") && Number(entry.at) > cutoff)
    : [];
};

// ---------------------------------------------------------------- small pieces

const ICONS = {
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35",
  bag: "M6 7h12l1 14H5zM9 7V6a3 3 0 0 1 6 0v1",
  close: "M18 6 6 18M6 6l12 12",
  check: "M20 6 9 17l-5-5",
  clock: "M12 6v6l4 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  chef: "M6 13.87A4 4 0 0 1 7.41 6a5.11 5.11 0 0 1 1.05-1.54 5 5 0 0 1 7.08 0A5.11 5.11 0 0 1 16.59 6 4 4 0 0 1 18 13.87V21H6zM6 17h12",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  sparkle: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4z",
  alert: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01",
  pause: "M10 4H6v16h4zM18 4h-4v16h4z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  chevron: "M9 18l6-6-6-6",
  heart: "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21.2l8.8-8.8a5.5 5.5 0 0 0 0-7.8z",
  bell: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0",
  scooter: "M5 17a2 2 0 1 0 4 0 2 2 0 1 0-4 0M15 17a2 2 0 1 0 4 0 2 2 0 1 0-4 0M9 17h6M7 15l2-6h4l2 6M13 9h3l2 4",
  store: "M3 9l1.5-5h15L21 9M3 9h18v2a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0zM5 13v8h14v-8M10 21v-5h4v5",
  phone: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z",
  pin: "M12 22s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  wallet: "M3 7h15a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H3zM3 7l12-4v4M16 13.5h.01",
  card: "M2 6h20v12H2zM2 10h20M6 15h4",
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

function FoodMark({ type }) {
  return (
    <span className={`g-food g-food-${type}`} role="img" aria-label={FOOD_LABELS[type] || type}>
      <span />
    </span>
  );
}

const placeholderFor = (categoryName = "") => {
  const name = categoryName.toLowerCase();

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

// One portion as configured for this service: the size or dish price (an
// offer replaces it outright), the add-ons, and the packing the restaurant
// charges per portion on a parcel.
const portionPrice = (dish, variantId, modifierIds, { regular = false } = {}) => {
  const variant = variantId ? dish.variants.find((option) => option.id === variantId) : null;
  const base = variant
    ? regular ? variant.price : variant.offerPrice ?? variant.price
    : regular ? dish.price : dish.offerPrice ?? dish.price;
  const addOns = dish.modifiers
    .filter((modifier) => modifierIds.includes(modifier.id))
    .reduce((sum, modifier) => sum + modifier.price, 0);

  return Math.round((base + addOns) * 100) / 100;
};

const cardPrice = (dish) => {
  if (dish.variants.length === 0) {
    return { now: dish.offerPrice ?? dish.price, was: dish.offerPrice !== null ? dish.price : null, from: false };
  }

  const cheapest = [...dish.variants].sort((a, b) => (a.offerPrice ?? a.price) - (b.offerPrice ?? b.price))[0];

  return {
    now: cheapest.offerPrice ?? cheapest.price,
    was: cheapest.offerPrice !== null ? cheapest.price : null,
    from: dish.variants.length > 1,
  };
};

const isCustomisable = (dish) =>
  dish.variants.length > 0 ||
  dish.modifiers.length > 0 ||
  (dish.addonGroups || []).length > 0 ||
  (dish.comboChoiceGroups || []).length > 0;

const lineIdentity = (line) =>
  [
    line.dishId,
    line.variantId || "",
    [...line.modifierIds].sort((a, b) => a - b).join("."),
    (line.notes || "").trim(),
    comboKey(line.comboSelections),
  ].join("|");

// "7:00 pm" from "19:00".
const twelveHour = (clock) => {
  const [hours, minutes] = String(clock).split(":").map(Number);

  return `${hours % 12 || 12}:${String(minutes).padStart(2, "0")} ${hours >= 12 ? "pm" : "am"}`;
};

const clockTime = (value) => new Date(value).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });

const summarise = (items) => {
  const names = items.map((item) => `${item.quantity} × ${item.name}`);
  return names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2} more` : names.join(", ");
};

// ---------------------------------------------------------------- sheets

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
      <button type="button" onClick={() => onChange(value - 1)} disabled={value <= min} aria-label={`One less ${label}`}>
        <Icon name="minus" size={16} />
      </button>
      <span aria-live="polite">{value}</span>
      <button type="button" onClick={() => onChange(value + 1)} disabled={value >= max} aria-label={`One more ${label}`}>
        <Icon name="plus" size={16} />
      </button>
    </div>
  );
}

function DishSheet({ dish, categoryName, currency, onClose, onAdd, canOrder }) {
  const defaultVariant = dish.variants.find((variant) => variant.isDefault) || dish.variants[0] || null;
  const [variantId, setVariantId] = useState(defaultVariant ? defaultVariant.id : null);
  const [modifierIds, setModifierIds] = useState([]);
  const [comboSelections, setComboSelections] = useState([]);
  const [notes, setNotes] = useState("");
  const [quantity, setQuantity] = useState(1);

  const each =
    portionPrice(dish, variantId, modifierIds) + comboExtra(dish.comboChoiceGroups, comboSelections) + dish.packagingCharge;
  const toggle = (id) =>
    setModifierIds((current) => (current.includes(id) ? current.filter((one) => one !== id) : [...current, id]));
  const blocked =
    !canOrder ||
    dish.soldOut ||
    Boolean(choiceError(dish.addonGroups, modifierIds)) ||
    Boolean(comboError(dish.comboChoiceGroups, comboSelections));

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
            disabled={blocked}
            onClick={() => onAdd({ dish, variantId, modifierIds, comboSelections, notes: notes.trim(), quantity })}
          >
            {dish.soldOut
              ? dish.notNow ? "Not served now" : "Sold out"
              : `Add to order · ${money(each * quantity, currency)}`}
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
      {dish.packagingCharge > 0 && (
        <p className="oo-packing-note">
          <Icon name="bag" size={14} /> Includes {money(dish.packagingCharge, currency)} packing per portion
        </p>
      )}

      {dish.includes.length > 0 && (
        <div className="g-block">
          <h3>What's in the box</h3>
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
                  disabled={variant.soldOut}
                  onChange={() => setVariantId(variant.id)}
                />
                <span className="g-option-name">
                  {variant.name}
                  {variant.soldOut ? " · sold out" : ""}
                </span>
                <span className="g-option-price">
                  {variant.offerPrice !== null && <s>{money(variant.price, currency)}</s>}
                  {money(variant.offerPrice ?? variant.price, currency)}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <AddonChoiceRules groups={dish.addonGroups} selectedIds={modifierIds} modifiers={dish.modifiers} />
      <ComboChoicePicker
        groups={dish.comboChoiceGroups}
        value={comboSelections}
        onChange={setComboSelections}
        currency={currency}
      />
      {dish.modifiers.length > 0 && (
        <fieldset className="g-block">
          <legend>
            Add-ons{" "}
            <span className="g-optional">
              {(dish.addonGroups || []).some((group) => group.min > 0) ? "Required choices below" : "Optional"}
            </span>
          </legend>
          <div className="g-options">
            {dish.modifiers.map((modifier) => (
              <label key={modifier.id} className={`g-option ${modifierIds.includes(modifier.id) ? "is-on" : ""}`}>
                <input type="checkbox" checked={modifierIds.includes(modifier.id)} onChange={() => toggle(modifier.id)} />
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

// ---------------------------------------------------------------- the cart and checkout

// What the guest will pay, as far as the page can tell before the server
// prices it: the dishes with packing, and the delivery charge by the Website
// channel's rule. GST is added on the bill when prices exclude it.
const cartFigures = (lines, service, delivery) => {
  const food = Math.round(lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0) * 100) / 100;
  const packing = Math.round(lines.reduce((sum, line) => sum + line.packing * line.quantity, 0) * 100) / 100;
  const charged = service === "delivery" && delivery.charge > 0;
  const free = charged && delivery.freeAbove !== null && food >= delivery.freeAbove;
  const charge = charged && !free ? delivery.charge : 0;
  const short = charged && !free && delivery.freeAbove !== null ? delivery.freeAbove - food : null;

  return { food, packing, charge, free, short, total: Math.round((food + charge) * 100) / 100 };
};

function CartPanel({
  lines,
  currency,
  menu,
  service,
  profile,
  setProfile,
  note,
  setNote,
  onQuantity,
  onPlace,
  placing,
  error,
  inSheet,
}) {
  const { ordering, delivery, restaurant } = menu;
  const figures = cartFigures(lines, service, delivery);
  const count = lines.reduce((sum, line) => sum + line.quantity, 0);
  const minimum = service === "delivery" ? ordering.minDeliveryOrder : 0;
  const belowMinimum = minimum > 0 && figures.food < minimum;
  const payment = ordering.paymentModes[0];

  if (lines.length === 0) {
    return (
      <div className="g-cart-empty">
        <span className="g-cart-empty-mark">
          <Icon name="bag" size={28} />
        </span>
        <p className="g-strong">Your order is empty</p>
        <p className="g-muted">
          Tap ADD on any dish. The restaurant confirms every order before it starts cooking.
        </p>
      </div>
    );
  }

  return (
    <div className="g-cart">
      {!inSheet && (
        <div className="g-cart-title">
          <h2>Your order</h2>
          <span className={`oo-service-tag is-${service}`}>
            <Icon name={service === "delivery" ? "scooter" : "store"} size={14} />
            {SERVICE_LABELS[service]}
          </span>
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
              <span className="g-cart-line-price">{money(line.unitPrice * line.quantity, currency)}</span>
            </div>
            <Stepper small value={line.quantity} onChange={(next) => onQuantity(line.key, next)} label={line.name} />
          </li>
        ))}
      </ul>

      <dl className="g-totals oo-totals">
        <div>
          <dt>
            Item total <span className="g-muted">({count} {count === 1 ? "item" : "items"})</span>
          </dt>
          <dd>{money(figures.food, currency)}</dd>
        </div>
        {figures.packing > 0 && (
          <div className="oo-sub">
            <dt>of which packing</dt>
            <dd>{money(figures.packing, currency)}</dd>
          </div>
        )}
        {service === "delivery" && (
          <div>
            <dt>Delivery charge</dt>
            <dd>{figures.charge > 0 ? money(figures.charge, currency) : <span className="oo-free">Free</span>}</dd>
          </div>
        )}
        <div className="oo-grand">
          <dt>To pay (estimate)</dt>
          <dd>{money(figures.total, currency)}</dd>
        </div>
      </dl>
      {figures.short !== null && figures.short > 0 && (
        <p className="oo-hint">
          <Icon name="sparkle" size={14} /> Add {money(figures.short, currency)} more for free delivery.
        </p>
      )}
      {figures.free && (
        <p className="oo-hint is-good">
          <Icon name="check" size={14} /> You get free delivery on this order.
        </p>
      )}
      <p className="g-muted g-small">
        {restaurant.taxMode === "inclusive" ? "Prices include GST." : "GST is added on the bill."} The restaurant's bill
        has the exact amount.
      </p>

      <div className="oo-checkout">
        <h3>Your details</h3>
        <div className="g-two">
          <label className="g-field">
            <span>Your name</span>
            <input
              value={profile.name}
              maxLength={80}
              autoComplete="name"
              placeholder="For the order"
              onChange={(event) => setProfile({ ...profile, name: event.target.value })}
            />
          </label>
          <label className="g-field">
            <span>Mobile</span>
            <input
              value={profile.mobile}
              maxLength={16}
              inputMode="tel"
              autoComplete="tel"
              placeholder="10-digit mobile"
              onChange={(event) => setProfile({ ...profile, mobile: event.target.value })}
            />
          </label>
        </div>
        {service === "delivery" && (
          <>
            <label className="g-field">
              <span>Delivery address</span>
              <textarea
                rows={2}
                maxLength={500}
                value={profile.address}
                autoComplete="street-address"
                placeholder="House or flat, building, street and area"
                onChange={(event) => setProfile({ ...profile, address: event.target.value })}
              />
            </label>
            <label className="g-field">
              <span>
                Landmark <em>optional</em>
              </span>
              <input
                value={profile.landmark}
                maxLength={200}
                placeholder="Near the temple, opposite the park gate…"
                onChange={(event) => setProfile({ ...profile, landmark: event.target.value })}
              />
            </label>
            {ordering.deliveryArea && (
              <p className="oo-hint">
                <Icon name="pin" size={14} /> Delivery area: {ordering.deliveryArea}
              </p>
            )}
          </>
        )}
        <label className="g-field">
          <span>
            Note for the restaurant <em>optional</em>
          </span>
          <textarea
            rows={2}
            maxLength={200}
            value={note}
            placeholder="Allergies, extra cutlery, ring the bell twice…"
            onChange={(event) => setNote(event.target.value)}
          />
          <small className="g-count">{note.length}/200</small>
        </label>

        <fieldset className="oo-pay">
          <legend>How you'll pay</legend>
          <label className="oo-pay-option is-on">
            <input type="radio" name="payment" checked readOnly />
            <Icon name="wallet" size={18} />
            <span className="g-grow">
              <strong>{PAYMENT_LABELS[payment]}</strong>
              <small className="g-muted">
                {payment === "cash_on_delivery" ? "Cash or UPI to the rider at your door." : "Cash, card or UPI at the counter."}
              </small>
            </span>
          </label>
          <label className="oo-pay-option is-off">
            <input type="radio" name="payment" disabled />
            <Icon name="card" size={18} />
            <span className="g-grow">
              <strong>Pay online</strong>
              <small className="g-muted">{ordering.onlinePayment.note}</small>
            </span>
            <span className="oo-soon">Coming soon</span>
          </label>
        </fieldset>
      </div>

      {belowMinimum && (
        <p className="g-notice">
          The minimum for delivery is {money(minimum, currency)}. Add {money(minimum - figures.food, currency)} more, or
          choose takeaway.
        </p>
      )}
      {error && (
        <p className="g-error" role="alert">
          <Icon name="alert" size={16} /> {error}
        </p>
      )}
      {!ordering.enabled && ordering.reason && <p className="g-notice">{ordering.reason}</p>}

      <button
        type="button"
        className="g-primary g-block-button"
        disabled={placing || !ordering.enabled || belowMinimum}
        onClick={onPlace}
      >
        {placing ? "Sending to the restaurant…" : `Place ${service} order · ${money(figures.total, currency)}`}
      </button>
      <p className="g-muted g-small g-center">The restaurant confirms your order before it starts cooking.</p>
    </div>
  );
}

// ---------------------------------------------------------------- the status page

const STATUS_ICON = {
  sent: "send",
  accepted: "chef",
  ready: "bell",
  out: "scooter",
  delivered: "heart",
  collected: "heart",
  rejected: "alert",
  cancelled: "close",
};

function StatusPage({ token, guestToken }) {
  const [order, setOrder] = useState(null);
  const [error, setError] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(null);

  useEffect(() => {
    let alive = true;
    let timer = null;

    const load = () => {
      if (document.visibilityState === "hidden" && latest.current) {
        return Promise.resolve();
      }

      return getOnlineOrder(token, guestToken)
        .then((data) => {
          if (!alive) return;
          latest.current = data;
          setOrder(data);
          setError("");
        })
        .catch((err) => {
          if (!alive) return;
          setNotFound(err.response?.status === 404);
          setError(guestErrorMessage(err));
        });
    };

    const schedule = () => {
      if (!alive || (latest.current && latest.current.final)) return;
      const waiting = !latest.current || latest.current.stage === "sent";
      timer = setTimeout(() => load().then(schedule), waiting ? POLL_WAITING : POLL_COOKING);
    };

    load().then(schedule);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [token, guestToken, attempt]);

  useEffect(() => {
    if (order) {
      document.title = `${order.label.split(" — ")[0]} · ${order.restaurant.name}`;
    }
  }, [order]);

  const cancel = async () => {
    setCancelling(true);
    setCancelError("");

    try {
      const updated = await cancelOnlineOrder(token, guestToken);
      latest.current = updated;
      setOrder(updated);
    } catch (err) {
      setCancelError(guestErrorMessage(err));
    } finally {
      setCancelling(false);
    }
  };

  if (!order) {
    if (error) {
      return (
        <div className="guest-app guest-center">
          <div className="g-problem">
            <span className="g-problem-mark">
              <Icon name="alert" size={34} />
            </span>
            <h1>{notFound ? "We couldn't find this order" : "Something went wrong"}</h1>
            <p>{notFound ? "The link may be incomplete. Please call the restaurant if you need help." : error}</p>
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
        <div className="g-shell oo-status-shell">
          <div className="g-skeleton-hero skeleton" />
        </div>
      </div>
    );
  }

  const currency = order.restaurant.currencySymbol;
  const reached = order.steps.findIndex((step) => step.key === order.stage);
  const tone =
    order.stage === "rejected"
      ? "is-bad"
      : order.stage === "cancelled"
        ? "is-muted"
        : order.stage === "sent"
          ? "is-waiting"
          : "is-good";

  return (
    <div className="guest-app">
      <header className="g-topbar">
        <div className="g-topbar-inner">
          <span className="g-monogram" aria-hidden="true">
            {order.restaurant.name
              .split(/\s+/)
              .slice(0, 2)
              .map((word) => word[0])
              .join("")
              .toUpperCase()}
          </span>
          <div className="g-topbar-title">
            <strong>{order.restaurant.name}</strong>
            <span>{order.restaurant.placeName || "Online order"}</span>
          </div>
          {order.restaurant.phone && (
            <a className="g-pill" href={`tel:${order.restaurant.phone.replace(/[^\d+]/g, "")}`}>
              <Icon name="phone" size={16} />
              <span className="g-hide-narrow">Call us</span>
            </a>
          )}
        </div>
      </header>

      <div className="g-shell oo-status-shell">
        <section className="oo-status-card">
          <p className="oo-status-kicker">
            <span className={`oo-service-tag is-${order.serviceType}`}>
              <Icon name={order.serviceType === "delivery" ? "scooter" : "store"} size={14} />
              {SERVICE_LABELS[order.serviceType]}
            </span>
            {order.orderNumber && (
              <span className="oo-order-no">
                Order {order.orderNumber}
                {order.tokenNo ? ` · Token ${order.tokenNo}` : ""}
              </span>
            )}
          </p>

          <div className="g-status">
            <div className={`g-status-badge ${tone}`}>
              <span className={`g-status-icon ${order.stage === "sent" ? "is-pulsing" : ""}`}>
                <Icon name={STATUS_ICON[order.stage] || "clock"} size={30} />
              </span>
              <h3>{order.label}</h3>
              {order.detail && <p>{order.detail}</p>}
            </div>

            {reached >= 0 && (
              <ol className={`g-steps oo-steps-${order.steps.length}`} aria-label="Order progress">
                {order.steps.map((step, index) => (
                  <li key={step.key} className={index <= reached ? "is-done" : index === reached + 1 ? "is-now" : ""}>
                    <span className="g-step-dot">{index <= reached ? <Icon name="check" size={12} /> : null}</span>
                    <span>{step.label}</span>
                  </li>
                ))}
              </ol>
            )}

            {!order.final && (
              <p className="g-muted g-small g-center oo-live">
                <span className="oo-live-dot" aria-hidden="true" /> This page updates by itself.
              </p>
            )}

            <div className="g-status-items">
              <h4>
                {order.itemCount} {order.itemCount === 1 ? "item" : "items"} · ordered at {clockTime(order.createdAt)}
              </h4>
              <ul>
                {order.items.map((item, index) => (
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
              <dl className="oo-status-sums">
                <div>
                  <dt>Items</dt>
                  <dd>{money(order.itemsTotal, currency)}</dd>
                </div>
                {order.serviceType === "delivery" && (
                  <div>
                    <dt>Delivery charge</dt>
                    <dd>{order.deliveryCharge > 0 ? money(order.deliveryCharge, currency) : "Free"}</dd>
                  </div>
                )}
                <div className="oo-grand">
                  <dt>To pay · {PAYMENT_LABELS[order.paymentMode]}</dt>
                  <dd>{money(order.total, currency)}</dd>
                </div>
              </dl>
              {order.address && (
                <p className="oo-address">
                  <Icon name="pin" size={15} />
                  <span>
                    {order.address}
                    {order.landmark ? ` · ${order.landmark}` : ""}
                  </span>
                </p>
              )}
              {order.notes && <p className="g-note-inline">Your note: “{order.notes}”</p>}
            </div>

            {cancelError && (
              <p className="g-error" role="alert">
                <Icon name="alert" size={16} /> {cancelError}
              </p>
            )}

            <div className="g-status-actions">
              {order.canCancel && (
                <button type="button" className="g-secondary" onClick={cancel} disabled={cancelling}>
                  {cancelling ? "Cancelling…" : "Cancel this order"}
                </button>
              )}
              <Link to={`/online/${token}`} className="g-primary g-grow oo-link-button">
                {order.final ? "Order again" : "Back to the menu"}
              </Link>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the menu page

function MenuPage({ token }) {
  const navigate = useNavigate();
  const [menu, setMenu] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [service, setService] = useState(() => readStore(`${cartKey(token)}_service`, null));

  const [search, setSearch] = useState("");
  const [vegOnly, setVegOnly] = useState(false);
  const [activeCategory, setActiveCategory] = useState(null);

  const [cart, setCart] = useState(() => {
    const saved = readStore(cartKey(token), []);
    return Array.isArray(saved) ? saved : [];
  });
  const [note, setNote] = useState("");
  const [profile, setProfile] = useState(() => ({
    name: "",
    mobile: "",
    address: "",
    landmark: "",
    ...readStore(PROFILE_KEY, {}),
  }));
  const [placing, setPlacing] = useState(false);
  const [cartError, setCartError] = useState("");
  const clientKeyRef = useRef(null);

  const [tracked] = useState(() => loadTracked(token));
  const [trackedOrders, setTrackedOrders] = useState({});
  const [sheet, setSheet] = useState(null);

  const sectionRefs = useRef(new Map());
  const tabRefs = useRef(new Map());
  const toolbarRef = useRef(null);
  const jumpRef = useRef(null);

  // ---------------------------------------------------------------- loading

  useEffect(() => {
    let alive = true;

    getOnlineMenu(token, service)
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
  }, [token, service, attempt]);

  useEffect(() => {
    if (menu) {
      document.title = `Order online · ${menu.place.name || menu.restaurant.name}`;
    }
  }, [menu]);

  useEffect(() => writeStore(cartKey(token), cart), [token, cart]);
  useEffect(() => writeStore(PROFILE_KEY, profile), [profile]);
  useEffect(() => {
    if (service) writeStore(`${cartKey(token)}_service`, service);
  }, [token, service]);

  // A changed order is a different order, so it gets a new idempotency key;
  // the same one sent again after a failed attempt keeps its key.
  useEffect(() => {
    clientKeyRef.current = null;
  }, [cart, note, service]);

  // The orders this phone placed from this link, for "Your orders".
  const trackedTokens = tracked.map((entry) => entry.guestToken).join(",");

  useEffect(() => {
    if (!trackedTokens) return undefined;
    let alive = true;

    Promise.all(
      trackedTokens
        .split(",")
        .slice(0, 5)
        .map((guestToken) =>
          getOnlineOrder(token, guestToken)
            .then((order) => [guestToken, order])
            .catch(() => null)
        )
    ).then((rows) => {
      if (!alive) return;
      setTrackedOrders(Object.fromEntries(rows.filter(Boolean)));
    });

    return () => {
      alive = false;
    };
  }, [token, trackedTokens]);

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
    if (!menu) return [];

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

  // The tab of the section being read (see the QR page for the reasoning).
  useEffect(() => {
    if (visibleCategories.length === 0) return undefined;

    let frame = 0;

    const pickActive = () => {
      frame = 0;
      if (jumpRef.current !== null) return;

      const bar = toolbarRef.current;
      const line = (bar ? bar.getBoundingClientRect().bottom : 170) + 24;
      const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      let current = visibleCategories[0].id;

      for (const category of visibleCategories) {
        const section = sectionRefs.current.get(category.id);
        if (!section) continue;
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
      if (!frame) frame = requestAnimationFrame(pickActive);
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
    window.clearTimeout(jumpRef.current);
    jumpRef.current = window.setTimeout(() => {
      jumpRef.current = null;
    }, 900);

    if (section) section.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // ---------------------------------------------------------------- the cart

  // Lines are stored as choices only; names and prices come from the menu as
  // it is now, for the service chosen — switching to delivery re-prices the
  // cart — and a dish that has since sold out drops out.
  const cartLines = useMemo(
    () =>
      cart
        .map((line) => {
          const found = dishById.get(line.dishId);

          if (!found || found.dish.soldOut) return null;

          const { dish } = found;
          const variant = line.variantId ? dish.variants.find((option) => option.id === line.variantId) : null;

          if ((line.variantId && (!variant || variant.soldOut)) || (!line.variantId && dish.variants.length > 0)) {
            return null;
          }

          const modifierIds = line.modifierIds.filter((id) => dish.modifiers.some((modifier) => modifier.id === id));
          const extra = comboExtra(dish.comboChoiceGroups, line.comboSelections);

          return {
            ...line,
            modifierIds,
            name: dish.name,
            foodType: dish.foodType,
            variantName: variant ? variant.name : null,
            modifierNames: [
              ...dish.modifiers.filter((modifier) => modifierIds.includes(modifier.id)).map((m) => m.name),
              ...comboParts(dish.comboChoiceGroups, line.comboSelections).map((p) => `${p.groupName}: ${p.name}`),
            ],
            packing: dish.packagingCharge,
            unitPrice: portionPrice(dish, line.variantId, modifierIds) + extra + dish.packagingCharge,
          };
        })
        .filter(Boolean),
    [cart, dishById]
  );

  const currentService = menu ? menu.ordering.service : service;
  const droppedFromCart = menu ? cart.length - cartLines.length : 0;
  const cartCount = cartLines.reduce((sum, line) => sum + line.quantity, 0);
  const figures = menu ? cartFigures(cartLines, currentService, menu.delivery) : null;

  const countInCart = (dishId) =>
    cartLines.filter((line) => line.dishId === dishId).reduce((sum, line) => sum + line.quantity, 0);

  const addLine = ({ dish, variantId, modifierIds, notes, quantity, comboSelections = [] }) => {
    const incoming = { dishId: dish.id, variantId: variantId || null, modifierIds, notes: notes || "", comboSelections };
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

  const plainLine = (dishId) =>
    cartLines.find((line) => line.dishId === dishId && !line.variantId && line.modifierIds.length === 0 && !line.notes);

  const tapAdd = (dish, categoryName) => {
    if (isCustomisable(dish)) {
      setSheet({ type: "dish", dish, categoryName });
      return;
    }

    addLine({ dish, variantId: null, modifierIds: [], notes: "", quantity: 1 });
  };

  const placeOrder = useCallback(async () => {
    if (!clientKeyRef.current) {
      clientKeyRef.current = newClientKey();
    }

    setPlacing(true);
    setCartError("");

    try {
      const result = await placeOnlineOrder(token, {
        clientKey: clientKeyRef.current,
        service: currentService,
        paymentMode: currentService === "delivery" ? "cash_on_delivery" : "pay_at_pickup",
        items: cartLines.map((line) => ({
          productId: line.dishId,
          variantId: line.variantId,
          modifierIds: line.modifierIds,
          comboSelections: line.comboSelections || [],
          quantity: line.quantity,
          notes: line.notes || null,
        })),
        notes: note.trim() || null,
        guestName: profile.name.trim(),
        guestMobile: profile.mobile.trim(),
        address: currentService === "delivery" ? profile.address.trim() : null,
        landmark: currentService === "delivery" ? profile.landmark.trim() || null : null,
      });

      writeStore(trackKey(token), [
        { guestToken: result.guestToken, at: Date.now() },
        ...loadTracked(token).filter((entry) => entry.guestToken !== result.guestToken),
      ].slice(0, 10));
      setCart([]);
      setNote("");
      clientKeyRef.current = null;
      navigate(`/online/${token}/status/${result.guestToken}`);
    } catch (error) {
      setCartError(guestErrorMessage(error));
    } finally {
      setPlacing(false);
    }
  }, [token, currentService, cartLines, note, profile, navigate]);

  // ---------------------------------------------------------------- render

  if (!menu) {
    if (loadError) {
      return (
        <div className="guest-app guest-center">
          <div className="g-problem">
            <span className="g-problem-mark">
              <Icon name="alert" size={34} />
            </span>
            <h1>{notFound ? "We couldn't find this ordering page" : "Something went wrong"}</h1>
            <p>{loadError}</p>
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

  const { restaurant, ordering, delivery, hours, place } = menu;
  const currency = restaurant.currencySymbol;
  const title = place.name ? `${restaurant.name} · ${place.name}` : restaurant.name;
  const monogram = restaurant.name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
  const trackedList = tracked.map((entry) => ({ ...entry, order: trackedOrders[entry.guestToken] })).filter((e) => e.order);
  const liveCount = trackedList.filter((entry) => !entry.order.final).length;

  const cartPanelProps = {
    lines: cartLines,
    currency,
    menu,
    service: currentService,
    profile,
    setProfile,
    note,
    setNote,
    onQuantity: setLineQuantity,
    onPlace: placeOrder,
    placing,
    error: cartError,
  };

  return (
    <div className={`guest-app oo-app ${cartCount > 0 ? "has-cartbar" : ""}`}>
      <header className="g-topbar">
        <div className="g-topbar-inner">
          <span className="g-monogram" aria-hidden="true">
            {monogram}
          </span>
          <div className="g-topbar-title">
            <strong>{restaurant.name}</strong>
            <span>{place.name ? `${place.name} · Order online` : "Order online"}</span>
          </div>
          {trackedList.length > 0 && (
            <button type="button" className="g-pill" onClick={() => setSheet({ type: "orders" })}>
              <Icon name="list" size={16} />
              <span className="g-hide-narrow">Your orders</span>
              {liveCount > 0 && <span className="g-pill-count">{liveCount}</span>}
            </button>
          )}
          {place.phone && (
            <a className="g-pill g-pill-accent" href={`tel:${place.phone.replace(/[^\d+]/g, "")}`}>
              <Icon name="phone" size={16} />
              <span className="g-hide-narrow">Call</span>
            </a>
          )}
        </div>
      </header>

      <div className="g-shell">
        <section className="g-hero oo-hero">
          <div className="g-hero-text">
            <p className="g-hero-kicker">Order online for {ordering.services.length > 1 ? "takeaway or delivery" : SERVICE_LABELS[ordering.services[0]].toLowerCase()}</p>
            <h1>{title}</h1>
            {place.address && (
              <p className="oo-hero-line">
                <Icon name="pin" size={15} /> {place.address}
              </p>
            )}
            {ordering.note && <p className="g-hero-note">{ordering.note}</p>}
          </div>

          <div className="oo-service" role="radiogroup" aria-label="Takeaway or delivery">
            {ordering.services.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={currentService === option}
                className={`oo-service-button ${currentService === option ? "is-on" : ""}`}
                onClick={() => setService(option)}
              >
                <Icon name={option === "delivery" ? "scooter" : "store"} size={22} />
                <span>
                  <strong>{SERVICE_LABELS[option]}</strong>
                  <small>
                    {option === "delivery"
                      ? `About ${ordering.deliveryMinutes} min to your door`
                      : `Ready in about ${ordering.pickupMinutes} min`}
                  </small>
                </span>
              </button>
            ))}
          </div>

          <ul className="oo-facts">
            <li>
              <Icon name="clock" size={15} />
              {hours.known
                ? hours.today.length > 0
                  ? `Today ${hours.today.map((period) => `${twelveHour(period.opensAt)} – ${twelveHour(period.closesAt)}`).join(", ")}`
                  : "Closed today"
                : "Open while the kitchen is open"}
            </li>
            {currentService === "delivery" && (
              <li>
                <Icon name="scooter" size={15} />
                {delivery.charge > 0
                  ? `Delivery ${money(delivery.charge, currency)}${delivery.freeAbove !== null ? ` · free above ${money(delivery.freeAbove, currency)}` : ""}`
                  : "Free delivery"}
              </li>
            )}
            {currentService === "delivery" && ordering.minDeliveryOrder > 0 && (
              <li>
                <Icon name="bag" size={15} />
                Minimum {money(ordering.minDeliveryOrder, currency)}
              </li>
            )}
            <li>
              <Icon name="wallet" size={15} />
              {currentService === "delivery" ? "Cash on delivery" : "Pay when you collect"}
            </li>
          </ul>
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
                    `${offer.name} — ${offer.dishCount} ${offer.dishCount === 1 ? "dish" : "dishes"} at special prices until ${twelveHour(offer.endsAt)}`
                )
                .join(" · ")}
            </span>
          </div>
        )}

        {droppedFromCart > 0 && (
          <div className="g-banner is-paused" role="status">
            <Icon name="alert" size={18} />
            <span>
              {droppedFromCart === 1 ? "A dish" : `${droppedFromCart} dishes`} in your order {droppedFromCart === 1 ? "isn't" : "aren't"}{" "}
              available right now and {droppedFromCart === 1 ? "was" : "were"} left out.
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
                <p className="g-strong">
                  {menu.categories.length === 0
                    ? "The menu is being updated. Please check back shortly."
                    : `No dishes match “${search || (vegOnly ? "Veg only" : "")}”`}
                </p>
                {menu.categories.length > 0 && (
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
                )}
              </div>
            )}

            {visibleCategories.map((category) => (
              <section
                key={category.id}
                id={`menu-${category.id}`}
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
                            {dish.offerName && (
                              <span className="g-offer-tag">
                                <Icon name="sparkle" size={12} /> Offer
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
                          {dish.packagingCharge > 0 && (
                            <span className="oo-packing">+ {money(dish.packagingCharge, currency)} packing</span>
                          )}
                          {dish.description && <span className="g-dish-desc">{dish.description}</span>}
                        </button>

                        <div className="g-dish-side">
                          <DishPicture dish={dish} categoryName={category.name} />
                          {dish.soldOut ? (
                            <span className="g-soldout">{dish.notNow ? "Not now" : "Sold out"}</span>
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
                            <span className="g-custom-note">{inCart > 0 ? `${inCart} in your order` : "Customisable"}</span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}

            <footer className="g-footer">
              <p>{title}</p>
              <p>
                Prices in {currency} for {currentService}. Every order is confirmed by the restaurant before it is cooked.
              </p>
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
            <span className="g-cartbar-total">{money(figures.total, currency)}</span>
            <span className="g-cartbar-go">
              Checkout <Icon name="chevron" size={18} />
            </span>
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
        <Sheet title="Your order" subtitle={`${SERVICE_LABELS[currentService]} · ${title}`} onClose={() => setSheet(null)}>
          <CartPanel {...cartPanelProps} inSheet />
        </Sheet>
      )}

      {sheet && sheet.type === "orders" && (
        <Sheet title="Your orders" subtitle="Placed from this phone" onClose={() => setSheet(null)}>
          <ul className="g-requests">
            {trackedList.map(({ guestToken, order }) => (
              <li key={guestToken}>
                <Link to={`/online/${token}/status/${guestToken}`} className="oo-order-row">
                  <span className={`g-request-icon is-${order.stage}`}>
                    <Icon name={STATUS_ICON[order.stage] || "clock"} size={18} />
                  </span>
                  <span className="g-grow">
                    <strong>
                      {SERVICE_LABELS[order.serviceType]} · {order.itemCount} {order.itemCount === 1 ? "item" : "items"}
                    </strong>
                    <span className="g-muted g-small">
                      {clockTime(order.createdAt)} · {summarise(order.items)}
                    </span>
                  </span>
                  <span className={`g-stage is-${order.stage}`}>{order.label.split(" — ")[0]}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Sheet>
      )}
    </div>
  );
}

export default function OnlineOrderPage() {
  const params = useParams();
  const status = /^status\/([a-f0-9]{48})$/.exec(params["*"] || "");

  if (status) {
    return <StatusPage token={params.token} guestToken={status[1]} />;
  }

  return <MenuPage key={params.token} token={params.token} />;
}
