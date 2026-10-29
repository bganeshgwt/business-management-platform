import api from "../../../services/api";
import { businessRead, businessWrite } from "../../../services/business.service";

// GST rate changes by date, through either front door of one API
// (backend modules/tax-changes): a shop's catalogue items under
// /api/businesses/:id/tax-changes, a restaurant's dishes under
// /api/menu/tax-changes. The screens take one of these and work the same way.

export const shopChanges = (businessId) => ({
  preview: (body) => businessWrite(businessId, "tax-changes/preview", body),
  schedule: (body) => businessWrite(businessId, "tax-changes", body),
  detail: (changeId, signal) => businessRead(businessId, `tax-changes/${changeId}`, undefined, signal),
  cancel: (changeId, reason) => businessWrite(businessId, `tax-changes/${changeId}/cancel`, { reason }),
  cancelItem: (changeId, itemId, reason) => businessWrite(businessId, `tax-changes/${changeId}/items/${itemId}/cancel`, { reason }),
  history: (skuId, signal) => businessRead(businessId, `catalog/${skuId}/tax-history`, undefined, signal),
  // A notification's list of HSN / SAC codes and their rates.
  importPreview: (body) => businessWrite(businessId, "tax-changes/import/preview", body),
  importSchedule: (body) => businessWrite(businessId, "tax-changes/import", body),
  // Rates kept in settings (a fashion shop's GST by price, a lodge's room-night slabs).
  settings: (signal) => businessRead(businessId, "tax-changes/settings", undefined, signal),
  scheduleSetting: (body) => businessWrite(businessId, "tax-changes/settings", body),
  cancelSetting: (changeId, reason) => businessWrite(businessId, `tax-changes/settings/${changeId}/cancel`, { reason }),
});

export const menuChanges = () => ({
  list: async (signal) => (await api.get("/menu/tax-changes", { signal })).data.data,
  preview: async (body) => (await api.post("/menu/tax-changes/preview", body)).data.data,
  schedule: async (body) => (await api.post("/menu/tax-changes", body)).data.data,
  detail: async (changeId, signal) => (await api.get(`/menu/tax-changes/${changeId}`, { signal })).data.data,
  cancel: async (changeId, reason) => (await api.post(`/menu/tax-changes/${changeId}/cancel`, { reason })).data.data,
  cancelItem: async (changeId, itemId, reason) => (await api.post(`/menu/tax-changes/${changeId}/items/${itemId}/cancel`, { reason })).data.data,
  history: async (productId, signal) => (await api.get(`/menu/products/${productId}/tax-history`, { signal })).data.data,
  importPreview: async (body) => (await api.post("/menu/tax-changes/import/preview", body)).data.data,
  importSchedule: async (body) => (await api.post("/menu/tax-changes/import", body)).data.data,
  // The restaurant's default GST rate (its advances' GST).
  settings: async (signal) => (await api.get("/menu/tax-changes/settings", { signal })).data.data,
  scheduleSetting: async (body) => (await api.post("/menu/tax-changes/settings", body)).data.data,
  cancelSetting: async (changeId, reason) => (await api.post(`/menu/tax-changes/settings/${changeId}/cancel`, { reason })).data.data,
});
