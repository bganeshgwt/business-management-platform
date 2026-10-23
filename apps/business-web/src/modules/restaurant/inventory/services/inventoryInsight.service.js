import api from "../../../../services/api";

// Wastage
export const getWastageReport = async (filters = {}) =>
  (await api.get("/inventory-insights/wastage", { params: filters })).data.data;

// The wastage log a page at a time ({ items, total, reversed, limit, offset }),
// so the grid pages through every entry rather than the newest few hundred.
export const getWastageEntries = async (filters = {}) =>
  (await api.get("/inventory-insights/wastage/entries", { params: filters })).data.data;

// A wastage entry, through the item's own address. Over the write-off limit a
// manager's PIN is asked for: `headers` carries the one-time approval
// (services/approval.js withApproval), tied to this item as well as the amount.
export const logItemWastage = async (itemId, payload, headers = {}) =>
  (await api.post(`/inventory-insights/items/${itemId}/wastage`, payload, { headers })).data;

export const reverseWastage = async (id, note) =>
  (await api.post(`/inventory-insights/wastage/${id}/reverse`, { note })).data;

// Reorder suggestions
export const getReorderPlan = async (horizon) =>
  (await api.get("/inventory-insights/reorder", { params: { horizon } })).data.data;

export const createDraftOrder = async (payload) =>
  (await api.post("/inventory-insights/reorder/draft-orders", payload)).data;

// Dish wasted: a finished dish written off by its recipe.
export const getDishWasteOptions = async () => (await api.get("/inventory-insights/dish-waste/options")).data.data;
export const listDishWaste = async (params = {}) =>
  (await api.get("/inventory-insights/dish-waste", { params })).data.data;
export const getDishWaste = async (id) => (await api.get(`/inventory-insights/dish-waste/${id}`)).data.data;
export const logDishWaste = async (payload, headers = {}) =>
  (await api.post("/inventory-insights/dish-waste", payload, { headers })).data;
export const reverseDishWaste = async (id, note) =>
  (await api.post(`/inventory-insights/dish-waste/${id}/reverse`, { note })).data;

// Write-offs and approvals by person (the stock side of theft control).
export const getWriteoffControl = async (params = {}) =>
  (await api.get("/inventory-insights/control", { params })).data.data;
