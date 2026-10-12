import api from "../../../../services/api";

export const listPurchaseOrders = async (filters = {}) =>
  (await api.get("/purchase-orders", { params: filters })).data.data;

export const getPurchaseOrder = async (id) => (await api.get(`/purchase-orders/${id}`)).data.data;

export const createPurchaseOrder = async (payload) =>
  (await api.post("/purchase-orders", payload)).data.data;

// A draft can be edited until it is marked ordered.
export const updatePurchaseOrder = async (id, payload) =>
  (await api.put(`/purchase-orders/${id}`, payload)).data.data;

// "closed" ends a part-received order short; the reason is kept on it.
export const setPurchaseOrderStatus = async (id, status, reason) =>
  (await api.patch(`/purchase-orders/${id}/status`, { status, ...(reason ? { reason } : {}) }))
    .data.data;

// An order over the approval limit waits for an approver. Approving or
// sending it back needs "Approve purchase orders over the limit" or a
// manager's PIN; `headers` carries the one-time approval.
export const approvePurchaseOrder = async (id, note, headers = {}) =>
  (await api.post(`/purchase-orders/${id}/approve`, { note: note || null }, { headers })).data;
export const sendBackPurchaseOrder = async (id, note, headers = {}) =>
  (await api.post(`/purchase-orders/${id}/reject`, { note }, { headers })).data;

// Takes the lines alone (as before) or a whole delivery: the supplier's bill
// number, the prices billed, what was turned away, and how it was paid.
export const receivePurchaseOrder = async (id, delivery) =>
  (
    await api.post(
      `/purchase-orders/${id}/receive`,
      Array.isArray(delivery) ? { lines: delivery } : delivery
    )
  ).data.data;

export const deletePurchaseOrder = async (id) => (await api.delete(`/purchase-orders/${id}`)).data;

// Purchase bills: every delivery, with or without an order
export const listPurchaseBills = async (filters = {}) =>
  (await api.get("/purchase-orders/receipts", { params: filters })).data.data;
export const getPurchaseBill = async (id) =>
  (await api.get(`/purchase-orders/receipts/${id}`)).data.data;
export const createPurchaseBill = async (payload) =>
  (await api.post("/purchase-orders/receipts", payload)).data.data;
// A bill that was paid needs the pay-suppliers right to void (the payment is
// voided with it); `headers` carries a manager's approval when asked for.
export const voidPurchaseBill = async (id, reason, headers = {}) =>
  (await api.post(`/purchase-orders/receipts/${id}/void`, { reason }, { headers })).data.data;

// The accountant's purchase register
export const getPurchaseRegister = async (params = {}) =>
  (await api.get("/purchase-orders/register", { params })).data.data;

// The supplier's paper bill on a purchase bill (photos or PDFs), read through
// the session as a Blob: never on a public link.
export const purchaseBillFiles = (billId) => ({
  list: async () => (await api.get(`/purchase-orders/receipts/${billId}/attachments`)).data.data,
  upload: async (file) => {
    const form = new FormData();
    form.append("file", file);
    return (await api.post(`/purchase-orders/receipts/${billId}/attachments`, form)).data.data;
  },
  fetchFile: async (id) =>
    (await api.get(`/purchase-orders/receipts/${billId}/attachments/${id}`, { responseType: "blob" })).data,
  remove: async (id) => (await api.delete(`/purchase-orders/receipts/${billId}/attachments/${id}`)).data.data,
});
