import api from "../../../../services/api";

// Every report reads the outlet chosen in the top bar (the X-Outlet-Id header
// api.js adds), so a branch's figures are its own. The answer says which
// outlet and dates it covers (outletName, from, to). A closed outlet is not in
// the top bar; its history is read by passing `outletId` with the range.
const get = async (path, params) => (await api.get(`/reports/${path}`, { params })).data.data;

export const getDashboard = async () => get("dashboard");
// Every live block the dashboard shows, in one answer:
// { serverTime, blocks: { tables: { data } | { error, status }, ... } }.
// Blocks the person may not read are left out by the server.
export const getDashboardLive = async (blocks) => get("dashboard/live", { blocks: blocks.join(",") });
// { businessDate, dayOpen, calendarDate, timezone } — "today" for the reports,
// readable by anyone who may open a report.
export const getTradingDay = async () => get("trading-day");
export const getSalesReport = async (range) => get("sales", range);
export const getItemReport = async (range) => get("items", range);
// Dish profitability: sales before GST, food cost and what each dish leaves.
export const getProfitabilityReport = async (range) => get("profitability", range);
export const getDiscountReport = async (range) => get("discounts", range);
export const getStaffReport = async (range) => get("staff", range);
// Who took the orders (captains and waiters), beside who billed them.
export const getWaiterReport = async (range) => get("waiters", range);
export const getCancellationReport = async (range) => get("cancellations", range);
export const getConsumptionReport = async (range) => get("consumption", range);
export const getOutletReport = async (filters) => get("outlets", filters);
// Either the internal day id or, far more usefully to a person, the date.
export const getDayEndReport = async (params) => get("day-end", params || undefined);

// The GST filing pack: register, GSTR-1 tables, credit notes, documents.
export const getGstReport = async (range) => get("gst", range);

// A buyer's GSTIN written on one bill makes it a B2B invoice.
export const setBillRecipient = async (billId, payload) =>
  (await api.put(`/reports/gst/bills/${billId}/recipient`, payload)).data;
export const clearBillRecipient = async (billId) =>
  (await api.delete(`/reports/gst/bills/${billId}/recipient`)).data;

// { from, to, basis: "consumption" | "purchases" }
export const getProfitLoss = async (params) => get("profit-loss", params);
export const getExpenseReport = async (range) => get("expenses", range);
// The accountant's day book, as vouchers a Tally operator can import.
export const getDayBook = async (range) => get("day-book", range);
// { from, to, discountPercent?, discountAmount? }
export const getTheftReport = async (params) => get("theft", params);
