import api from "../../../services/api";

// Your plan's calls to the API, for an owner: a business's
// (/api/businesses/:id/plan) and the signed-in restaurant's (/api/plan), one
// service on the server. The plan and its dates, the choice for the next
// period, orders, the payment's reference and the invoices.

// Business Admin's business, or (no business id) the signed-in restaurant's.
export const planBase = (businessId) => (businessId ? `/businesses/${businessId}/plan` : "/plan");

// { plan, selection, entitled, catalogue, openOrder, orders, payments, invoices, payTo, company, gstRate }
export const getPlan = async (businessId, signal) => (await api.get(planBase(businessId), { signal })).data.data;

// { planCode, billingPeriod, addons }: what the next order is made of.
export const saveSelection = async (businessId, body) => (await api.put(`${planBase(businessId)}/selection`, body)).data.data;

// { kind: "subscription" } or { kind: "add_on", modules }, with stateCode when the business has no state yet.
export const makeOrder = async (businessId, body) => (await api.post(`${planBase(businessId)}/orders`, body)).data.data;

// { method, reference, paidOn }: the owner has paid the order.
export const sendPayment = async (businessId, orderId, body) => (await api.post(`${planBase(businessId)}/orders/${orderId}/payments`, body)).data.data;

export const getInvoice = async (businessId, invoiceId) => (await api.get(`${planBase(businessId)}/invoices/${invoiceId}`)).data.data;
