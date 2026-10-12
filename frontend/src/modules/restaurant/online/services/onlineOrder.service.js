import axios from "axios";
import api from "../../../../services/api";

// The restaurant's own online ordering page (SW-A-22): the guest's calls, and
// the staff's settings for each selling point's link.
//
// The guest's calls use an axios instance of their own, with no interceptors
// (like the QR page's): a staff token must never ride along on a public
// request, and nothing a guest does may sign a member of staff out.
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

// The page a link opens, built from the restaurant's guest web address when
// it has one (Service settings), else this screen's own address.
export const onlineOrderUrl = (base, token) => `${String(base || "").replace(/\/+$/, "")}/online/${token}`;

// ---------------------------------------------------------------- staff

const SETTINGS = "/orders/service-settings/online-ordering";

export const listOnlineLinks = async () => (await api.get(SETTINGS)).data.data;

// These return the whole response: the message says what happened.
export const updateOnlineLink = async (id, payload) => (await api.put(`${SETTINGS}/${id}`, payload)).data;

export const replaceOnlineLink = async (id) => (await api.post(`${SETTINGS}/${id}/new-link`)).data;
