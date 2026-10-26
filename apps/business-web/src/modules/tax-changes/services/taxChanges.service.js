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
});

export const menuChanges = () => ({
  list: async (signal) => (await api.get("/menu/tax-changes", { signal })).data.data,
  preview: async (body) => (await api.post("/menu/tax-changes/preview", body)).data.data,
  schedule: async (body) => (await api.post("/menu/tax-changes", body)).data.data,
  detail: async (changeId, signal) => (await api.get(`/menu/tax-changes/${changeId}`, { signal })).data.data,
  cancel: async (changeId, reason) => (await api.post(`/menu/tax-changes/${changeId}/cancel`, { reason })).data.data,
  cancelItem: async (changeId, itemId, reason) => (await api.post(`/menu/tax-changes/${changeId}/items/${itemId}/cancel`, { reason })).data.data,
  history: async (productId, signal) => (await api.get(`/menu/products/${productId}/tax-history`, { signal })).data.data,
});
