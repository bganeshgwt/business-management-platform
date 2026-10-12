import axios from "axios";

// Calls made by a guest at a table, who is never signed in.
//
// A separate axios instance on purpose, with no interceptors. The staff one
// attaches the saved login token to every request and logs the browser out on
// a 401 — on a shared tablet a staff token must never ride along on a public
// request, and nothing a guest does may sign a member of staff out.
const BASE = String(import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

const guestApi = axios.create({
  baseURL: `${BASE}/public`,
  timeout: 15000,
});

const at = (token) => `/tables/${encodeURIComponent(token)}`;

// Dish photos are served beside the API, not under it.
export const dishImageUrl = (relativePath) =>
  relativePath ? `${BASE.replace(/\/api$/, "")}/uploads/${relativePath}` : null;

export const getGuestMenu = async (token) => (await guestApi.get(`${at(token)}/menu`)).data.data;

export const placeGuestOrder = async (token, payload) =>
  (await guestApi.post(`${at(token)}/orders`, payload)).data.data;

export const getGuestRequests = async (token, ids) =>
  (await guestApi.get(`${at(token)}/requests`, { params: { ids: ids.join(",") } })).data.data;

export const cancelGuestRequest = async (token, id) =>
  (await guestApi.post(`${at(token)}/requests/${id}/cancel`)).data.data;

// Returns the whole response: its message is the sentence the guest reads.
export const callStaff = async (token, payload) =>
  (await guestApi.post(`${at(token)}/calls`, payload)).data;

export const sendGuestFeedback = async (token, payload) =>
  (await guestApi.post(`${at(token)}/feedback`, payload)).data;

export const guestErrorMessage = (error) => {
  if (error.response?.data?.message) {
    return error.response.data.message;
  }

  return "We couldn't reach the restaurant just now. Check your connection and try again.";
};

// The id a submission carries so that a double tap, or a retry after the
// connection dropped, is recognised as the same order. crypto.randomUUID only
// exists on https or localhost; a phone on the restaurant's own Wi-Fi may be
// on plain http, where getRandomValues still works.
export const newClientKey = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};
