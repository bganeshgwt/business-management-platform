import api from "../../../services/api";

// The platform console's operations (/api/users/platform), for the platform's
// own super admin: the company's settings and the price list, a business's
// plan and its time, payments to confirm and the invoice register. The list of
// businesses and a new business are in platform.service.js.
const P = "/users/platform";
const data = (response) => response.data.data;

export const consoleSettings = async () => data(await api.get(`${P}/settings`));
export const saveConsoleSettings = async (body) => data(await api.put(`${P}/settings`, body));
export const consolePrices = async () => data(await api.get(`${P}/prices`));
export const saveConsolePrices = async (body) => data(await api.put(`${P}/prices`, body));

export const consoleBusiness = async (id) => data(await api.get(`${P}/businesses/${id}`));
export const setConsoleSelection = async (id, body) => data(await api.put(`${P}/businesses/${id}/selection`, body));
export const giveConsoleTime = async (id, body) => data(await api.post(`${P}/businesses/${id}/given-time`, body));
export const giveConsoleAddons = async (id, body) => data(await api.post(`${P}/businesses/${id}/given-addons`, body));
export const makeConsoleOrder = async (id, body) => data(await api.post(`${P}/businesses/${id}/orders`, body));
export const recordConsolePayment = async (id, body) => data(await api.post(`${P}/businesses/${id}/payments`, body));

export const consolePayments = async (params) => data(await api.get(`${P}/payments`, { params }));
export const confirmConsolePayment = async (id) => data(await api.post(`${P}/payments/${id}/confirm`, {}));
export const rejectConsolePayment = async (id, reason) => data(await api.post(`${P}/payments/${id}/reject`, { reason }));

export const consoleInvoices = async (params) => data(await api.get(`${P}/invoices`, { params }));
export const consoleInvoice = async (id) => data(await api.get(`${P}/invoices/${id}`));
export const issueConsoleTaxInvoice = async (orderId) => data(await api.post(`${P}/orders/${orderId}/tax-invoice`, {}));
