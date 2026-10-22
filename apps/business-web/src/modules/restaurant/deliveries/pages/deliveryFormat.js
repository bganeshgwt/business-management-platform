import { durationMinutes } from "@bmp/shared/format";

// Words, times and money shared by the delivery screens.

import { money } from "@bmp/shared/format";

// ---------------------------------------------------------------- vocabulary

export const STATUS = {
  pending: { label: "New", tone: "new" },
  preparing: { label: "Cooking", tone: "cooking" },
  ready: { label: "Packed", tone: "ready" },
  out_for_delivery: { label: "On the road", tone: "road" },
  delivered: { label: "Delivered", tone: "done" },
  cancelled: { label: "Cancelled", tone: "cancelled" },
};

// The five steps a delivery walks through, for the progress line on a card.
export const STEPS = [
  { key: "pending", label: "Placed" },
  { key: "preparing", label: "Cooking" },
  { key: "ready", label: "Packed" },
  { key: "out_for_delivery", label: "On the road" },
  { key: "delivered", label: "Delivered" },
];

export const PRE_DISPATCH = ["pending", "preparing", "ready"];

export const CHANNEL_TYPES = [
  { value: "own", label: "Own riders", hint: "Your own delivery team takes it to the door" },
  { value: "aggregator", label: "Aggregator", hint: "Swiggy, Zomato and the like — they send the order, and usually the rider" },
  { value: "phone", label: "Phone", hint: "Called in by the guest, delivered by you" },
  { value: "website", label: "Website", hint: "Your own online ordering page" },
];

export const TYPE_LABEL = Object.fromEntries(CHANNEL_TYPES.map((type) => [type.value, type.label]));

export const COLORS = ["orange", "red", "amber", "green", "teal", "blue", "violet", "pink", "slate"];

export const PAYMENT_METHOD = { cash: "cash", card: "card", upi: "UPI", online: "online", wallet: "wallet", other: "other" };

export const CANCEL_REASONS = [
  "Guest cancelled",
  "Cancelled on the partner app",
  "Guest unreachable / address not found",
  "Item ran out",
  "No rider available",
];

export const ETAS = [20, 25, 30, 35, 40, 45, 50, 60, 75, 90];

// ---------------------------------------------------------------- time

export const minutesSince = (iso, now) => Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));

// "8 min", "1h 05m", "12 days" (the app's shared duration words).
export const duration = (minutes) => {
  if (minutes === null || minutes === undefined) {
    return "—";
  }

  if (minutes < 60) {
    return `${minutes} min`;
  }

  return durationMinutes(minutes);
};

export const clockOf = (iso, timezone) => {
  if (!iso) {
    return "";
  }

  try {
    return new Date(iso)
      .toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: timezone })
      .replace(/\s?(AM|PM)$/i, (match) => ` ${match.trim().toLowerCase()}`);
  } catch {
    return new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  }
};

export const longDate = (date) =>
  date
    ? new Date(`${date}T00:00:00Z`).toLocaleDateString("en-IN", {
        weekday: "long",
        day: "numeric",
        month: "long",
        timeZone: "UTC",
      })
    : "";

// Green while there is time, amber once it has to leave now, red past the
// promise. The same thresholds the server uses for the bell.
export const slaTone = (minutes, board) => {
  if (minutes > board.slaMinutes) return "late";
  if (minutes >= board.warnMinutes) return "warn";
  return "ok";
};

export const initials = (name) =>
  String(name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

export const digitsOf = (text) => String(text || "").replace(/\D/g, "");

// A headline tile in whole rupees: ₹12,26,770 rather than ₹12,26,769.57,
// which is too wide for a tile and too precise to read at a glance.
export const rupees = (value, currency) => money(Math.round(Number(value || 0)), currency);
