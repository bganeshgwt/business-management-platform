import api from "../../../../services/api";

// filters: status ("unpaid,partial"), search (bill or order number, guest
// name, 4+ digits of a mobile), from / to (business dates), orderId, limit.
export const listBills = async (filters = {}) => (await api.get("/bills", { params: filters })).data.data;

export const getBill = async (id) => (await api.get(`/bills/${id}`)).data.data;

export const createBill = async (payload) => (await api.post("/bills", payload)).data.data;

// A change to a bill not yet settled: { discountCode }, { loyaltyPoints },
// { manualDiscount: { type, value }, itemDiscounts: [...], discountReason,
// discountNote }, { serviceCharge: { waive, reason } }, { complimentary:
// { reason, note } }. The bill keeps its number. A change that needs a
// manager (a discount above the till's cap, a no-charge bill, lowering a bill
// already printed) opens the PIN prompt by itself (services/api.js) and is
// sent again with the approval.
export const adjustBill = async (billId, payload, headers = {}) =>
  (await api.patch(`/bills/${billId}/adjust`, payload, { headers })).data.data;

// The same change checked, not made: { approval: null } when the person may
// do it themselves, or { approval: { permission, scope, action } } — the
// manager's approval it needs, tied to exactly these facts — so the PIN is
// asked for before the change is sent. Reasons, coupon and points are
// checked here too (a 400 with a sentence).
export const checkAdjust = async (billId, payload) =>
  (await api.post(`/bills/${billId}/adjust/check`, payload)).data.data;

// Puts the bill on a guest's or company's account (dues) instead of taking
// the money: { customerId, note }. { customerId: null } takes it off again.
// Needs customers.credit or a manager's PIN tied to the bill, the guest and
// the amount; the account's limit is checked before anyone is asked.
export const putBillOnAccount = async (billId, payload, headers = {}) =>
  (await api.patch(`/bills/${billId}/account`, payload, { headers })).data.data;

export const addPayment = async (billId, payload) => (await api.post(`/bills/${billId}/payments`, payload)).data.data;

// Refund and void may need a manager's approval: `headers` carries the
// one-time approval token when withApproval (services/approval.js) retries.
//
// payload: { amount, refundMethod, reason, reversePoints?, items?: [{ orderItemId, quantity }] }
export const addRefund = async (billId, payload, headers = {}) =>
  (await api.post(`/bills/${billId}/refunds`, payload, { headers })).data;

export const voidBill = async (billId, reason, headers = {}) =>
  (await api.patch(`/bills/${billId}/void`, { reason }, { headers })).data.data;

// The day's takings for the outlet in the top bar. With no arguments: the
// one business day the counter is trading — the outlet's own, or the main
// counter's with All outlets picked — which is what the Business day screen
// opens and closes. The Bills screen passes { scope: "restaurant" }: with All
// outlets picked, every day open in the restaurant (each outlet trades its
// own), added up and listed in `days`.
export const getDaySummary = async (params = { scope: "counter" }) =>
  (await api.get("/bills/day-summary", { params })).data.data;

// Discount and no-charge reasons, and how much the person at the till may
// take off on their own.
export const getTillOptions = async () => (await api.get("/bills/till-options")).data.data;

export const listCreditNotes = async (filters = {}) =>
  (await api.get("/bills/credit-notes", { params: filters })).data.data;

// What is still unbilled on an order
export const getBillableItems = async (orderId) => (await api.get(`/bills/billable/${orderId}`)).data.data;

// Records a print and returns the bill as it must be printed: its print count,
// and copy "original" or "duplicate". A reprint needs bills.reprint or a
// manager (the prompt opens by itself).
export const registerPrint = async (billId, headers = {}) =>
  (await api.post(`/bills/${billId}/print`, null, { headers })).data.data;

// --- Guest and company accounts (dues) -------------------------------------

// Every account and what it owes (aged), and the unpaid bills on no account.
export const getDues = async () => (await api.get("/bills/accounts/dues")).data.data;

// Opens an account or changes it: { creditLimit, creditDays, status, notes }.
export const saveAccount = async (customerId, payload) =>
  (await api.put(`/bills/accounts/${customerId}`, payload)).data;

// { from, to } — business dates; left out, the whole history.
export const getStatement = async (customerId, range = {}) =>
  (await api.get(`/bills/accounts/${customerId}/statement`, { params: range })).data.data;

export const getAccountBills = async (customerId) =>
  (await api.get(`/bills/accounts/${customerId}/open-bills`)).data.data;

// Money received against an account: { amount, paymentMethod, transactionRef,
// billIds? }. Paid onto the oldest bills first unless bills are named.
export const collectOnAccount = async (customerId, payload) =>
  (await api.post(`/bills/accounts/${customerId}/collect`, payload)).data;

// A company's GSTIN on the bill (a B2B tax invoice). The reports module keeps
// the buyer; the till writes it the moment the guest asks.
export const setBillBuyer = async (billId, payload) =>
  (await api.put(`/reports/gst/bills/${billId}/recipient`, payload)).data.data;

export const clearBillBuyer = async (billId) => (await api.delete(`/reports/gst/bills/${billId}/recipient`)).data;

// What returning `quantity` of a bill line gives back (its value after
// discount, its share of service charge, GST and cess), to the paisa — the
// same working the server uses, so the refund asked for is exactly right.
const partOf = (paise, quantity, before, returning) =>
  Math.round((paise * (before + returning)) / quantity) - Math.round((paise * before) / quantity);

export const returnValueOf = (item, returning) => {
  if (!item || item.taxableValue === null || item.taxableValue === undefined || !(returning > 0)) {
    return 0;
  }

  const paise = (value) => Math.round(Number(value || 0) * 100);
  const total =
    partOf(paise(item.taxableValue), item.quantity, item.returnedQuantity || 0, returning) +
    partOf(paise(item.taxAmount), item.quantity, item.returnedQuantity || 0, returning) +
    partOf(paise(item.cessAmount), item.quantity, item.returnedQuantity || 0, returning);

  return total / 100;
};

// --- Billing and payments build --------------------------------------------

// Corrects how one payment was taken while its day is open:
// { paymentMethod, paymentTypeId?, transactionRef?, reason }. Needs
// bills.payment_correct or a manager's PIN tied to the bill, the payment, its
// amount and both methods (the prompt opens by itself).
export const correctPayment = async (billId, paymentId, payload, headers = {}) =>
  (await api.patch(`/bills/${billId}/payments/${paymentId}`, payload, { headers })).data.data;

// Payments whose method was corrected: { from, to, page, pageSize }.
export const listCorrections = async (params = {}) =>
  (await api.get("/bills/payment-corrections", { params })).data.data;

// Advances and deposits held for guests.
// params: { status: "held" | "all", customerId, search, from, to, page, pageSize }
export const listAdvances = async (params = {}) => (await api.get("/bills/advances", { params })).data.data;

export const getAdvance = async (id) => (await api.get(`/bills/advances/${id}`)).data.data;

// A guest's advances still holding money, for "Pay from advance". With an
// order, the advance taken on that pickup order comes first.
export const getHeldAdvances = async (customerId, orderId) =>
  (await api.get(`/bills/advances/held/${customerId}`, { params: orderId ? { orderId } : {} })).data.data;

// The advances taken ahead on one pickup order.
export const getOrderAdvances = async (orderId) => (await api.get(`/bills/advances/order/${orderId}`)).data.data;

// { customerId, amount, paymentMethod, paymentTypeId?, transactionRef?, purpose?, reservationId?, orderId? }
export const takeAdvance = async (payload) => (await api.post("/bills/advances", payload)).data;

// { amount, refundMethod, paymentTypeId?, transactionRef?, reason } — needs
// advances.refund or a manager's PIN tied to the advance and the amount.
export const refundAdvance = async (id, payload, headers = {}) =>
  (await api.post(`/bills/advances/${id}/refunds`, payload, { headers })).data;

// GSTR-1 tables 11A and 11B for a period: { from, to }.
export const getAdvanceGst = async (params = {}) => (await api.get("/bills/advances/gst", { params })).data.data;
