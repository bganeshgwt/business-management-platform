import api from "../../../../services/api";
import { queryClient, sessionScope } from "../../../../services/queryClient";

// After a save the kept settings are thrown away, so the next read is fresh.
const forgetSettings = (result) => {
  queryClient.removeQueries({ queryKey: ["settings"] });
  return result;
};

export const getRestaurant = async () => (await api.get("/restaurants/current")).data.data;

export const updateRestaurant = async (payload) =>
  forgetSettings((await api.put("/restaurants/current", payload)).data.data);

const fetchSettings = async () => (await api.get("/restaurants/current/settings")).data.data;

// The settings (currency, time zone, receipt and tax set-up) change rarely but
// nearly every screen reads them. They are read once and kept for five
// minutes in the shared memory (services/queryClient.js), per signed-in
// person's restaurant; saving here clears it. Each caller gets its own copy,
// so a screen editing its form can never change what another screen reads.
export const settingsQuery = () => ({
  queryKey: ["settings", sessionScope()[0]],
  queryFn: fetchSettings,
  staleTime: 5 * 60 * 1000,
});

export const getSettings = async () => structuredClone(await queryClient.fetchQuery(settingsQuery()));

export const updateSettings = async (payload) =>
  forgetSettings((await api.put("/restaurants/current/settings", payload)).data.data);

// What the bill numbers of the main counter and each outlet look like:
// [{ outletId, name, series, example, derived, sharedWith, lastNumber }].
export const getInvoiceSeries = async () => (await api.get("/restaurants/current/invoice-series")).data.data;

// Outlets with their invoice series and the real next bill number of each
// ({ invoiceSeries: { series, nextNumber, issued, sharedWith } }), for the
// Outlets page; needs only outlets.view.
export const listOutletsWithSeries = async () => (await api.get("/outlets", { params: { series: 1 } })).data.data;

// Place names a time zone may be set to, with their offset from UTC.
export const listTimezones = async () => (await api.get("/restaurants/current/timezones")).data.data;

// How much each role may take off a bill at the till on its own.
export const getDiscountLimits = async () =>
  (await api.get("/restaurants/current/discount-limits")).data.data;

// limits: [{ roleId, maxPercent }]; a maxPercent of null takes the cap off.
export const saveDiscountLimits = async (limits) =>
  (await api.put("/restaurants/current/discount-limits", { limits })).data.data;

export const getBusinessHours = async () =>
  (await api.get("/restaurants/current/business-hours")).data.data;

export const updateBusinessHours = async (days) =>
  (await api.put("/restaurants/current/business-hours", { days })).data.data;

// Owner-named payment types under a method (meal cards, cheques, PhonePe…).
export const listPaymentTypes = async () => (await api.get("/restaurants/current/payment-types")).data.data;

// { paymentMethod, name, needsReference, status, sortOrder }
export const createPaymentType = async (payload) =>
  (await api.post("/restaurants/current/payment-types", payload)).data;

// { name, needsReference, status, sortOrder } — the method never changes.
export const updatePaymentType = async (id, payload) =>
  (await api.put(`/restaurants/current/payment-types/${id}`, payload)).data;

export const deletePaymentType = async (id) => (await api.delete(`/restaurants/current/payment-types/${id}`)).data;
