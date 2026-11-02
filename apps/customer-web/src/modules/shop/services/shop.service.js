import { publicClient } from "../../../shared/publicClient";

// A shop's online shop for its guests (API.md › Public guest pages › Online
// shop): /api/public/shop, no login. The shop by its link's token, an order by
// the guest's own token. A status answer carries `live` beside its data.
const api = publicClient("/shop");

const data = (response) => response.data.data;
// A status answer: the order, the shop's card, and the live key beside them.
const followed = (response) => ({ ...response.data.data, live: response.data.live || null });

export const getShop = (token) => api.get(`/${token}`).then(data);

export const getItems = (token, { q = "", category = "", country = "", sort = "", page = 1 } = {}, signal) =>
  api
    .get(`/${token}/items`, { params: { ...(q ? { q } : {}), ...(category ? { category } : {}), ...(country ? { country } : {}), ...(sort ? { sort } : {}), page }, signal })
    .then(data);

export const getItem = (token, productId) => api.get(`/${token}/items/${productId}`).then(data);

export const checkCart = (token, body) => api.post(`/${token}/cart`, body).then(data);

export const placeOrder = (token, body) => api.post(`/${token}/orders`, body).then(followed);

export const getOrder = (guestToken) => api.get(`/status/${guestToken}`).then(followed);

export const cancelOrder = (guestToken) => api.post(`/status/${guestToken}/cancel`, {}).then(followed);

export const changeOrder = (guestToken) => api.post(`/status/${guestToken}/change`, {}).then(followed);

export const answerChange = (guestToken, changeId, accept) => api.post(`/status/${guestToken}/changes/${changeId}`, { accept }).then(followed);

export const reportProblem = (guestToken, body) => api.post(`/status/${guestToken}/complaints`, body).then(followed);
