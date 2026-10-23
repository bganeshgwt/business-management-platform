import api from "../../../../services/api";

export const getBusinessDay = async () => (await api.get("/business-day")).data.data;

// Past days between two dates, a page at a time: { items, total, page, pageSize }.
export const listBusinessDays = async ({ from, to, page, pageSize } = {}) =>
  (await api.get("/business-day/days", { params: { from: from || undefined, to: to || undefined, page, pageSize } })).data
    .data;

export const openBusinessDay = async (payload) =>
  (await api.post("/business-day/open", payload)).data.data;

// Closing may need a manager's approval: `headers` carries the one-time
// approval token when withApproval (services/approval.js) retries.
export const closeBusinessDay = async (payload, headers = {}) =>
  (await api.post("/business-day/close", payload, { headers })).data.data;

// What the close dialog shows before the count: what the drawer should hold
// (left out for a blind counter), card and UPI totals to tick, and what is in
// the way of closing.
export const getClosePreview = async () => (await api.get("/business-day/close-preview")).data.data;

// The close checked before a manager is asked for a PIN. A refusal comes
// back as { refused: { message, reason, ... } } in a 200.
export const checkCloseBusinessDay = async (payload) =>
  (await api.post("/business-day/close/check", payload)).data.data;

export const reopenBusinessDay = async (id, reason) =>
  (await api.post(`/business-day/${id}/reopen`, { reason })).data.data;

// The rules for opening and counting.
export const saveCashRules = async (payload) => (await api.put("/business-day/rules", payload)).data.data;

// Cash drawers per shift.
export const listDrawers = async () => (await api.get("/business-day/drawers")).data.data;
export const startDrawer = async (payload) => (await api.post("/business-day/drawers", payload)).data.data;
export const closeDrawer = async (id, payload) =>
  (await api.post(`/business-day/drawers/${id}/close`, payload)).data.data;

// An X report: one drawer, or one cashier's day.
export const getXReport = async ({ drawerId, cashierId } = {}) =>
  (await api.get("/business-day/x-report", { params: { drawerId, cashierId } })).data.data;

// Cash in or out of a drawer. A cashier records one with a manager's PIN
// (the approval rides in `headers`).
export const recordCashMovement = async (payload, headers = {}) =>
  (await api.post("/business-day/movements", payload, { headers })).data.data;

export const cancelCashMovement = async (id, reason, headers = {}) =>
  (await api.post(`/business-day/movements/${id}/cancel`, { reason }, { headers })).data.data;
