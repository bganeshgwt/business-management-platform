import api from "../../../../services/api";
import { businessRead, businessWrite } from "../../../../services/business.service";

// The online shop for staff (API.md › Online shop): /api/businesses/:id/online-shop.
const at = (path) => `online-shop/${path}`;

export const shopSettings = (businessId, signal) => businessRead(businessId, at("settings"), undefined, signal);
export const saveShopSettings = (businessId, locationId, body) => businessWrite(businessId, at(`settings/${locationId}`), body, "put");
export const newShopLink = (businessId, locationId) => businessWrite(businessId, at(`settings/${locationId}/new-link`), {});

export const shopItems = (businessId, params, signal) => businessRead(businessId, at("items"), params, signal);
export const shopItem = (businessId, productId, signal) => businessRead(businessId, at(`items/${productId}`), undefined, signal);
export const saveShopItem = (businessId, productId, body) => businessWrite(businessId, at(`items/${productId}`), body, "put");
export const removeShopPhoto = (businessId, productId) => businessWrite(businessId, at(`items/${productId}/photo`), undefined, "delete");
// A product's photo: the large one and the small one the browser made (multipart).
export const uploadShopPhoto = async (businessId, productId, { large, small }) => {
  const form = new FormData();
  form.append("image", large, large.name || "photo.jpg");
  if (small) form.append("thumb", small, small.name || "photo-small.jpg");
  return (await api.post(`/businesses/${businessId}/${at(`items/${productId}/photo`)}`, form)).data.data;
};
export const hiddenCategories = (businessId, signal) => businessRead(businessId, at("categories"), undefined, signal);
export const setCategoryOnline = (businessId, categoryId, hidden) => businessWrite(businessId, at(`categories/${categoryId}`), { hidden }, "put");

export const blockedMobiles = (businessId, signal) => businessRead(businessId, at("blocked"), undefined, signal);
export const blockMobile = (businessId, body) => businessWrite(businessId, at("blocked"), body);
export const liftBlock = (businessId, blockId) => businessWrite(businessId, at(`blocked/${blockId}/lift`), {});

export const onlineBoard = (businessId, params, signal) => businessRead(businessId, at("orders"), params, signal);
export const onlineOrder = (businessId, orderId, signal) => businessRead(businessId, at(`orders/${orderId}`), undefined, signal);
export const orderAction = (businessId, orderId, action, body = {}) => businessWrite(businessId, at(`orders/${orderId}/${action}`), body);
export const editLine = (businessId, orderId, lineId, body) => businessWrite(businessId, at(`orders/${orderId}/lines/${lineId}`), body, "patch");
export const replaceLine = (businessId, orderId, lineId, body) => businessWrite(businessId, at(`orders/${orderId}/lines/${lineId}/replace`), body);
export const removeLine = (businessId, orderId, lineId, body = {}) => businessWrite(businessId, at(`orders/${orderId}/lines/${lineId}/remove`), body);
export const addLine = (businessId, orderId, body) => businessWrite(businessId, at(`orders/${orderId}/lines`), body);
export const answerByPhone = (businessId, orderId, changeId, accepted) => businessWrite(businessId, at(`orders/${orderId}/changes/${changeId}/answer`), { accepted });

export const complaints = (businessId, params, signal) => businessRead(businessId, at("complaints"), params, signal);
export const complaintAction = (businessId, complaintId, action, body) => businessWrite(businessId, at(`complaints/${complaintId}/${action}`), body);
export const onlineReport = (businessId, params, signal) => businessRead(businessId, at("report"), params, signal);
