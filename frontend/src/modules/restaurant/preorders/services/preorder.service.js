import api from "../../../../services/api";

// Pre-orders: cakes and party orders for a later day (feature "preorders").
// filters: { status: open | all | booked | in_production | ready | collected | cancelled, from, to, search }
export const listPreorders = async (filters = {}) => (await api.get("/preorders", { params: filters })).data.data;
export const getBakeList = async (day) => (await api.get("/preorders/bake-list", { params: { day } })).data.data;
export const createPreorder = async (payload) => (await api.post("/preorders", payload)).data;
export const takePreorderAdvance = async (id, payload) => (await api.post(`/preorders/${id}/advance`, payload)).data;
export const setPreorderStatus = async (id, status) => (await api.post(`/preorders/${id}/status`, { status })).data.data;
export const cancelPreorder = async (id, reason) => (await api.post(`/preorders/${id}/cancel`, { reason })).data;
// Handed over: { preorder, orderId, orderNumber } — the takeaway order to bill.
export const collectPreorder = async (id) => (await api.post(`/preorders/${id}/collect`, {})).data;
