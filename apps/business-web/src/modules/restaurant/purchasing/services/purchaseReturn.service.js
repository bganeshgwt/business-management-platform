import api from "../../../../services/api";

// Purchase returns
export const listPurchaseReturns = async (filters = {}) =>
  (await api.get("/purchase-returns", { params: filters })).data.data;

export const getPurchaseReturn = async (id) =>
  (await api.get(`/purchase-returns/${id}`)).data.data;

export const createPurchaseReturn = async (payload) =>
  (await api.post("/purchase-returns", payload)).data.data;

// Corrects the credit (prices, date, reason) with a reason for the change.
export const updatePurchaseReturn = async (id, payload) =>
  (await api.put(`/purchase-returns/${id}`, payload)).data.data;

export const voidPurchaseReturn = async (id, reason) =>
  (await api.post(`/purchase-returns/${id}/void`, { reason })).data.data;

// The most a return with no bill may credit for one item from one supplier,
// and the GST rates it may carry: { maxUnitPrice, rates, basis }.
export const getReturnCreditLimit = async (supplierId, itemId) =>
  (await api.get("/purchase-returns/credit-limit", { params: { supplierId, itemId } })).data.data;

// Supplier payments and what is still owed. Takes a supplier id (as before)
// or a filter object.
export const listSupplierPayments = async (filters) =>
  (
    await api.get("/purchase-returns/payments", {
      params: filters && typeof filters === "object" ? filters : { supplierId: filters },
    })
  ).data.data;

export const createSupplierPayment = async (payload) =>
  (await api.post("/purchase-returns/payments", payload)).data.data;

export const updateSupplierPayment = async (id, payload) =>
  (await api.put(`/purchase-returns/payments/${id}`, payload)).data.data;

export const voidSupplierPayment = async (id, reason) =>
  (await api.post(`/purchase-returns/payments/${id}/void`, { reason })).data.data;

export const getOutstanding = async () =>
  (await api.get("/purchase-returns/outstanding")).data.data;

export const getSupplierStatement = async (params) =>
  (await api.get("/purchase-returns/statement", { params })).data.data;
