import api from "../../../../services/api";

// The staff inbox for QR orders and calls from tables.

export const listTableRequests = async (filters = {}) =>
  (await api.get("/table-requests", { params: filters })).data.data;

export const getTableRequestSummary = async () =>
  (await api.get("/table-requests/summary")).data.data;

// These return the whole response: the message says what happened, in words
// a captain can read at a glance ("Accepted — ORD-0142 opened for table T4").
export const acceptTableRequest = async (id) =>
  (await api.post(`/table-requests/${id}/accept`)).data;

export const rejectTableRequest = async (id, reason) =>
  (await api.post(`/table-requests/${id}/reject`, { reason })).data;

export const acknowledgeTableRequest = async (id) =>
  (await api.post(`/table-requests/${id}/acknowledge`)).data;

export const completeTableRequest = async (id) =>
  (await api.post(`/table-requests/${id}/done`)).data;

export const getTableRequestSettings = async () =>
  (await api.get("/table-requests/settings")).data.data;

export const updateTableRequestSettings = async (payload) =>
  (await api.put("/table-requests/settings", payload)).data.data;

// Everything an earlier day left waiting: QR orders rejected with the
// reason, calls closed (orders.manage).
export const closeEarlierTableRequests = async (reason) =>
  (await api.post("/table-requests/close-earlier", { reason })).data;
