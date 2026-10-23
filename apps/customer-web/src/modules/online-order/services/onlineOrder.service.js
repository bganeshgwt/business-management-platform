import axios from "axios";

// The restaurant's own online ordering page: the guest's calls. The
// staff's settings for each selling point's link stay in the staff app
// (apps/business-web, modules/restaurant/online).
//
// An axios instance of its own, with no interceptors (like the QR page's): a
// staff token must never ride along on a public request, and nothing a guest
// does may sign a member of staff out.
const BASE = String(import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

const publicApi = axios.create({
  baseURL: `${BASE}/public/online`,
  timeout: 15000,
});

const at = (token) => `/${encodeURIComponent(token)}`;

export const getOnlineMenu = async (token, service) =>
  (await publicApi.get(`${at(token)}/menu`, { params: service ? { service } : {} })).data.data;

// { guestToken, order }
export const placeOnlineOrder = async (token, payload) =>
  (await publicApi.post(`${at(token)}/orders`, payload)).data.data;

export const getOnlineOrder = async (token, guestToken) =>
  (await publicApi.get(`${at(token)}/orders/${encodeURIComponent(guestToken)}`)).data.data;

export const cancelOnlineOrder = async (token, guestToken) =>
  (await publicApi.post(`${at(token)}/orders/${encodeURIComponent(guestToken)}/cancel`)).data.data;
