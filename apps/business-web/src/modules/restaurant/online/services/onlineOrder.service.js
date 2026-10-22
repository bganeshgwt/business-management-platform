import api from "../../../../services/api";

// The restaurant's own online ordering links (SW-A-22): the staff's settings
// for each selling point's link, and the address a link opens. The page the
// guest orders on, and its calls, are the guest site's (apps/customer-web,
// modules/online-order).

// The page a link opens, built from the restaurant's guest web address when
// it has one (Service settings), else the guest site's own address.
export const onlineOrderUrl = (base, token) => `${String(base || "").replace(/\/+$/, "")}/online/${token}`;

const SETTINGS = "/orders/service-settings/online-ordering";

export const listOnlineLinks = async () => (await api.get(SETTINGS)).data.data;

// These return the whole response: the message says what happened.
export const updateOnlineLink = async (id, payload) => (await api.put(`${SETTINGS}/${id}`, payload)).data;

export const replaceOnlineLink = async (id) => (await api.post(`${SETTINGS}/${id}/new-link`)).data;
