import api from "../../../../services/api";

// Units (kg, litre, piece)
export const listUnits = async () => (await api.get("/inventory/units")).data.data;
export const createUnit = async (payload) => (await api.post("/inventory/units", payload)).data.data;
export const updateUnit = async (id, payload) =>
  (await api.put(`/inventory/units/${id}`, payload)).data.data;
export const deleteUnit = async (id) => (await api.delete(`/inventory/units/${id}`)).data;

// Items
export const listInventoryItems = async (filters = {}) =>
  (await api.get("/inventory/items", { params: filters })).data.data;
export const createInventoryItem = async (payload) =>
  (await api.post("/inventory/items", payload)).data.data;
export const updateInventoryItem = async (id, payload) =>
  (await api.put(`/inventory/items/${id}`, payload)).data.data;
export const deleteInventoryItem = async (id) => (await api.delete(`/inventory/items/${id}`)).data;

// Packs an item is bought in (a 15 L tin, a tray of 30), replaced as a list.
export const saveItemPacks = async (id, packs) =>
  (await api.put(`/inventory/items/${id}/packs`, { packs })).data.data;

// Stock movements
export const listStockMovements = async (filters = {}) =>
  (await api.get("/inventory/movements", { params: filters })).data.data;
export const stockIn = async (payload) =>
  (await api.post("/inventory/movements/in", payload)).data.data;
// Over the write-off limit a manager's PIN is asked for; `headers` carries
// the one-time approval (services/approval.js withApproval).
export const stockOut = async (payload, headers = {}) =>
  (await api.post("/inventory/movements/out", payload, { headers })).data.data;

// Moving stock between the main store and an outlet
export const transferStock = async (payload) =>
  (await api.post("/inventory/movements/transfer", payload)).data.data;

export const getStockBalances = async (itemId) =>
  (await api.get(`/inventory/items/${itemId}/balances`)).data.data;

// Stores: the main store and the outlets that keep their own stock
export const listStores = async () => (await api.get("/inventory/stores")).data.data;
export const setOutletOwnStore = async (outletId, ownStore) =>
  (await api.put(`/inventory/stores/${outletId}`, { ownStore })).data;

// Closing stock on a date
export const getStockValuation = async (params = {}) =>
  (await api.get("/inventory/valuation", { params })).data.data;

// Stock counts
export const listStockCounts = async (params = {}) =>
  (await api.get("/inventory/counts", { params })).data.data;
export const getStockCount = async (id) => (await api.get(`/inventory/counts/${id}`)).data.data;
export const createStockCount = async (payload) =>
  (await api.post("/inventory/counts", payload)).data.data;
export const saveStockCountLines = async (id, payload) =>
  (await api.put(`/inventory/counts/${id}/lines`, payload)).data.data;
export const postStockCount = async (id) => (await api.post(`/inventory/counts/${id}/post`)).data.data;
export const cancelStockCount = async (id) =>
  (await api.post(`/inventory/counts/${id}/cancel`)).data.data;
export const getCountVariance = async (params = {}) =>
  (await api.get("/inventory/counts/variance", { params })).data.data;

export const getInventoryRecipe = async (id) => (await api.get(`/inventory/items/${id}/recipe`)).data.data;
export const saveInventoryRecipe = async (id, lines) => (await api.put(`/inventory/items/${id}/recipe`, { lines })).data.data;
// Without params: the latest 200 as a list. With { from, to, page, pageSize }:
// one page { items, total, page, pageSize, totalCost }.
export const listProductionBatches = async (params) =>
  (await api.get("/inventory/production", params ? { params } : undefined)).data.data;
// A type-ahead item picker: the first matches for what was typed.
export const searchInventoryItems = async (q, { signal, limit = 20 } = {}) =>
  (await api.get("/inventory/items", { params: { q, limit }, signal })).data.data;
export const createProductionBatch = async (payload) => (await api.post("/inventory/production", payload)).data.data;

// Batches & expiry: ?show= all | expiring | soon | expired | unknown |
// used_after_expiry, ?store= main | an outlet id.
export const listBatches = async (params = {}) => (await api.get("/inventory/batches", { params })).data.data;

// Stock → Stock & purchasing settings: the approval limits and how transfers land.
export const getStockSettings = async () => (await api.get("/inventory/settings")).data.data;
export const saveStockSettings = async (payload) => (await api.put("/inventory/settings", payload)).data;

// Transfer notes between stores, and indents (an outlet asking for stock).
export const listTransfers = async (params = {}) => (await api.get("/inventory/transfers", { params })).data.data;
export const getTransfer = async (id) => (await api.get(`/inventory/transfers/${id}`)).data.data;
export const sendTransfer = async (payload) => (await api.post("/inventory/transfers", payload)).data;
export const receiveTransfer = async (id, payload) => (await api.post(`/inventory/transfers/${id}/receive`, payload)).data;
export const cancelTransfer = async (id, reason) => (await api.post(`/inventory/transfers/${id}/cancel`, { reason })).data;
export const listIndents = async (params = {}) => (await api.get("/inventory/indents", { params })).data.data;
export const getIndent = async (id) => (await api.get(`/inventory/indents/${id}`)).data.data;
export const createIndent = async (payload) => (await api.post("/inventory/indents", payload)).data;
export const fulfilIndent = async (id, payload) => (await api.post(`/inventory/indents/${id}/fulfil`, payload)).data;
export const closeIndent = async (id, reason) => (await api.post(`/inventory/indents/${id}/close`, { reason })).data;
export const withdrawIndent = async (id, reason) => (await api.post(`/inventory/indents/${id}/cancel`, { reason })).data;

// Stock items from a spreadsheet: a check first (dryRun), then the import.
export const getStockImportGuide = async () => (await api.get("/inventory/items/import-guide")).data.data;
export const importStockItems = async (payload) => (await api.post("/inventory/items/import", payload)).data;
