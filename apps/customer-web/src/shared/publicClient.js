import axios from "axios";

// A guest page's calls to the API (docs/ARCHITECTURE.md › Build a guest page
// for a business).
//
//   const api = publicClient("/appointments");   // → <API>/public/appointments
//
// Each guest module makes its own client with this, never the staff app's:
// no interceptors, no login token. On a shared tablet a staff member's saved
// token must never ride along on a public request, and nothing a guest does
// may sign a member of staff out. The API answers /api/public from any web
// address, so a business can point its own domain at the guests' site.

// The API's address with no slash at its end (VITE_API_BASE_URL, required by
// vite.config.js): "https://api.example.com/api", or "/api" behind one address.
export const API_BASE = String(import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

export const publicClient = (base = "") =>
  axios.create({
    baseURL: `${API_BASE}/public${base ? `/${String(base).replace(/^\/+|\/+$/g, "")}` : ""}`,
    timeout: 15000,
  });

// An uploaded picture (a product's photo), served beside the API.
export const uploadUrl = (relativePath) => (relativePath ? `${API_BASE.replace(/\/api$/, "")}/uploads/${relativePath}` : null);

// What went wrong, in the guest's words: the API's own sentence when it gave
// one (every refusal of a guest route is written for the guest), else what
// the guest can do about the connection.
export function guestErrorMessage(error, who = "the business") {
  const said = error && error.response && error.response.data && error.response.data.message;

  if (said) {
    return said;
  }

  if (error && error.code === "ECONNABORTED") {
    return `${capitalise(who)} is taking too long to answer. Check your connection and try again.`;
  }

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "You seem to be offline. Check your connection and try again.";
  }

  return `We couldn't reach ${who} just now. Check your connection and try again.`;
}

const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// The reason a refusal gives (not_taking_orders, full …), or null.
export const refusalReason = (error) => (error && error.response && error.response.data && error.response.data.data && error.response.data.data.reason) || null;

// The id a submission carries so that a double tap, or a retry after the
// connection dropped, is recognised as the same one (the API's clientKey).
// crypto.randomUUID exists only on https or localhost; a phone on a shop's
// own Wi-Fi may be on plain http, where getRandomValues still works.
export const newClientKey = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};
