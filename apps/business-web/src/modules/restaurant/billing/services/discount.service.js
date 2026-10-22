import api from "../../../../services/api";

export const listDiscounts = async () => (await api.get("/discounts")).data.data;

export const createDiscount = async (payload) => (await api.post("/discounts", payload)).data.data;

export const updateDiscount = async (id, payload) =>
  (await api.put(`/discounts/${id}`, payload)).data.data;

export const deleteDiscount = async (id) => (await api.delete(`/discounts/${id}`)).data;

// Given away at the till. No dates: the business day the till is on (the
// answer says which dates it used). page and pageSize page the bill-by-bill
// list; the totals always cover the whole period.
export const listGiven = async ({ from, to, page, pageSize } = {}) =>
  (await api.get("/discounts/given", { params: { from: from || undefined, to: to || undefined, page, pageSize } })).data.data;
