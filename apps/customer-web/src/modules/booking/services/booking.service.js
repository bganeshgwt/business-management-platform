import axios from "axios";

// Calls made by a guest booking a table online, who is never signed
// in. Its own axios instance with no interceptors, like the QR ordering one: a
// staff token saved in this browser must never ride along on a public request,
// and nothing a guest does may sign a member of staff out.
const BASE = String(import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

const bookingApi = axios.create({
  baseURL: `${BASE}/public/booking`,
  timeout: 15000,
});

const at = (token) => `/${encodeURIComponent(token)}`;

export const getBookingPage = async (token) => (await bookingApi.get(at(token))).data.data;

export const getBookingTimes = async (token, date, party) =>
  (await bookingApi.get(`${at(token)}/times`, { params: { date, party } })).data.data;

// Returns the whole response: its message is the sentence the guest reads.
export const requestBooking = async (token, payload) =>
  (await bookingApi.post(`${at(token)}/requests`, payload)).data;

export const getMyBooking = async (guestToken) =>
  (await bookingApi.get(`/status/${encodeURIComponent(guestToken)}`)).data.data;

export const cancelMyBooking = async (guestToken) =>
  (await bookingApi.post(`/status/${encodeURIComponent(guestToken)}/cancel`)).data;

export const bookingErrorMessage = (error) =>
  error.response?.data?.message ||
  "We couldn't reach the restaurant just now. Check your connection and try again.";

// The guest's own bookings on this phone, so reopening the booking link can
// say "you already asked for Saturday". A convenience only: a private window
// or blocked storage simply forgets them, and the status link still works.
const MINE = "book.mine";

export const rememberMine = (linkToken, guestToken) => {
  try {
    const all = JSON.parse(window.localStorage.getItem(MINE) || "{}");
    const list = [guestToken, ...(all[linkToken] || []).filter((item) => item !== guestToken)].slice(0, 5);
    window.localStorage.setItem(MINE, JSON.stringify({ ...all, [linkToken]: list }));
  } catch {
    // Storage refused: nothing to remember.
  }
};

export const mineFor = (linkToken) => {
  try {
    return JSON.parse(window.localStorage.getItem(MINE) || "{}")[linkToken] || [];
  } catch {
    return [];
  }
};
