// Formatting and fixed lists shared by the stock and purchasing screens.
import { dayMonth } from "@bmp/shared/dates";

const QUANTITY = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 });

// 12.5 kg, 30,000 ml — never 12.500000001.
export const qty = (value, unit) =>
  `${QUANTITY.format(Math.round(Number(value || 0) * 1000) / 1000)}${unit ? ` ${unit}` : ""}`;

// A quantity also shown in packs when the item has one: "30,000 ml (2 tins)".
export const inPacks = (value, packs = []) => {
  const pack = [...packs].sort((a, b) => b.size - a.size).find((p) => Number(value) >= p.size);

  if (!pack) {
    return null;
  }

  const count = Math.round((Number(value) / pack.size) * 100) / 100;

  return `${QUANTITY.format(count)} × ${pack.name}`;
};

export const PO_STATUS = {
  draft: { label: "Draft", tone: "muted" },
  // Over the approval limit (Settings → Stock & purchasing): not sent yet.
  pending_approval: { label: "Waiting for approval", tone: "warning" },
  ordered: { label: "Ordered", tone: "info" },
  partial: { label: "Part received", tone: "warning" },
  received: { label: "Received", tone: "success" },
  // Violet, not the brand orange: orange sat too close to Cancelled's red
  // down a list of orders.
  closed: { label: "Closed short", tone: "violet" },
  cancelled: { label: "Cancelled", tone: "danger" },
};

export const GST_RATES = [0, 5, 12, 18, 28, 40];

export const PAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "upi", label: "UPI" },
  { value: "bank", label: "Bank transfer" },
  { value: "cheque", label: "Cheque" },
  { value: "card", label: "Card" },
  { value: "other", label: "Other" },
];

export const methodLabel = (value) => (PAYMENT_METHODS.find((m) => m.value === value) || {}).label || value;

// "2026-09-24" → "24 Sep 2026", for people rather than databases (the app's
// month names: the browser's en-IN writes "Sept").
export const niceDate = (value) => {
  if (!value) {
    return "—";
  }

  return dayMonth(String(value).slice(0, 10), { year: true }) || value;
};

// A price per unit of stock. Most are whole paise (₹336.00 a kg), but an item
// bought in packs costs fractions of a paisa per unit — a ₹2,150 tin of
// 15,000 ml is ₹0.1433 a ml — and showing that as ₹0.14 is 2% off every
// recipe that uses it. Up to four decimals, only when there are any.
const UNIT_PRICE_2 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const UNIT_PRICE_4 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 4 });

export const unitMoney = (value, currency = "₹") => {
  const amount = Number(value || 0);
  const wholePaise = Math.abs(Math.round(amount * 100) - amount * 100) < 1e-6;

  return `${currency}${(wholePaise ? UNIT_PRICE_2 : UNIT_PRICE_4).format(amount)}`;
};

// A price typed into a box: all the decimals it has, up to eight, without
// trailing zeros — "0.14333333", "150".
export const priceText = (value) =>
  value === null || value === undefined || value === "" ? "" : String(Math.round(Number(value) * 1e8) / 1e8);

// A money figure that can go below zero, written the way people write it:
// −₹1,414.88, not ₹-1,414.88.
export const signedMoney = (value, currency = "₹", exact = false) => {
  const amount = Math.round(Number(value || 0) * 100) / 100;
  const whole = !exact && Math.round(Math.abs(amount) * 100) % 100 === 0;
  const text = new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(Math.abs(amount));

  return `${amount < 0 ? "−" : ""}${currency}${text}`;
};

// The stores the "Where stock is kept" dialog lists: the main store, every
// open outlet, and a closed outlet only while stock still sits on its shelf
// (so it is not forgotten there). A closed outlet with an empty shelf is
// nothing anyone can act on, and nothing can be sent to it.
export const storesWorthListing = (stores) =>
  stores.filter((store) => !store.outletId || store.status === "active" || Number(store.itemsHeld) > 0);
