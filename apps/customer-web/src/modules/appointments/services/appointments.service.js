import { API_BASE, publicClient } from "../../../shared/publicClient";

// A guest's calls for online booking (/api/public/appointments): the booking
// link's page, its free days and times, booking, and the guest's own booking
// by its guest token. Its own client, with no login token (shared/publicClient).
const api = publicClient("/appointments");
const at = (token) => `/${encodeURIComponent(token)}`;
const mine = (guestToken) => `/status/${encodeURIComponent(guestToken)}`;
const choice = ({ services = [], person = "any" } = {}) => ({ services: services.join(","), person });

export const getPage = async (token) => (await api.get(at(token))).data.data;
export const getDays = async (token, selection) => (await api.get(`${at(token)}/days`, { params: choice(selection) })).data.data;
export const getTimes = async (token, selection, date) => (await api.get(`${at(token)}/times`, { params: { ...choice(selection), date } })).data.data;

// The whole answer: its message, the booking (data) and `live`.
export const book = async (token, body) => (await api.post(`${at(token)}/bookings`, body)).data;

// { booking, live }: the guest's booking, and the guest live key its page follows it with (null once nothing more can happen).
export const getMine = async (guestToken) => {
  const body = (await api.get(mine(guestToken))).data;
  return { booking: body.data, live: body.live || null };
};
export const cancelMine = async (guestToken) => (await api.post(`${mine(guestToken)}/cancel`, {})).data;
export const changeDays = async (guestToken) => (await api.get(`${mine(guestToken)}/days`)).data.data;
export const changeTimes = async (guestToken, date) => (await api.get(`${mine(guestToken)}/times`, { params: { date } })).data.data;
export const moveMine = async (guestToken, body) => (await api.post(`${mine(guestToken)}/move`, body)).data;
export const calendarUrl = (guestToken) => `${API_BASE}/public/appointments${mine(guestToken)}/calendar.ics`;

// The UPI app link that pays the advance (upi://pay), with the amount and a note the business recognises.
export const upiPayLink = ({ upiId, payee, amount, note }) =>
  `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payee || "")}&am=${Number(amount).toFixed(2)}&cu=INR&tn=${encodeURIComponent(note)}`;

// The guest's own bookings on this phone, so /appointments can list them and a
// guest finds a booking again. A convenience only: a private window or blocked
// storage forgets them, and the booking's own link still works.
const MINE = "appointments.mine";

export function rememberMine(entry) {
  try {
    const list = JSON.parse(window.localStorage.getItem(MINE) || "[]");
    const next = [{ ...entry, savedAt: new Date().toISOString() }, ...list.filter((item) => item.guestToken !== entry.guestToken)].slice(0, 20);
    window.localStorage.setItem(MINE, JSON.stringify(next));
  } catch {
    // Storage refused: nothing to remember.
  }
}

export function allMine() {
  try {
    const list = JSON.parse(window.localStorage.getItem(MINE) || "[]");
    return Array.isArray(list) ? list.filter((item) => item && typeof item.guestToken === "string") : [];
  } catch {
    return [];
  }
}

export function forgetMine(guestToken) {
  try {
    window.localStorage.setItem(MINE, JSON.stringify(allMine().filter((item) => item.guestToken !== guestToken)));
  } catch {
    // Nothing kept.
  }
}
