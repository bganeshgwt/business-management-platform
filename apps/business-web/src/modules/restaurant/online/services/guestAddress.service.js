import api from "../../../../services/api";

// A guest's saved delivery addresses. The list is full text for
// people who may see contact details, the label and area for others.
export const listGuestAddresses = async (customerId) =>
  (await api.get(`/crm/customers/${customerId}/addresses`)).data.data;

export const updateGuestAddress = async (customerId, id, data) =>
  (await api.put(`/crm/customers/${customerId}/addresses/${id}`, data)).data;

export const removeGuestAddress = async (customerId, id) =>
  (await api.delete(`/crm/customers/${customerId}/addresses/${id}`)).data;
