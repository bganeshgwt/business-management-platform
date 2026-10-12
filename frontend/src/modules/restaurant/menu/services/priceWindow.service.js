import api from "../../../../services/api";

// Happy hour and other timed prices. A price is for one dish in one size; a
// window can be tied to one outlet or run at every outlet.

export const listPriceWindows = async (filters = {}) =>
  (await api.get("/menu/price-windows", { params: filters })).data.data;

export const getPriceWindow = async (id) => (await api.get(`/menu/price-windows/${id}`)).data.data;

export const createPriceWindow = async (payload) =>
  (await api.post("/menu/price-windows", payload)).data.data;

export const updatePriceWindow = async (id, payload) =>
  (await api.put(`/menu/price-windows/${id}`, payload)).data.data;

// items: [{ productId, productVariantId (null for the dish sold without a
// size), price }]. The list is saved whole.
export const savePriceWindowItems = async (id, items) =>
  (await api.put(`/menu/price-windows/${id}/items`, { items })).data.data;

export const deletePriceWindow = async (id) => (await api.delete(`/menu/price-windows/${id}`)).data;
