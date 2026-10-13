import api from './api';

// Business Admin API (/api/businesses). The business ID always travels in the
// URL; the server checks the membership, the module and the permission on
// every call, so nothing here is trusted for access.

export const listBusinesses = async () => (await api.get('/businesses')).data.data;
export const provisionBusinesses = async () => (await api.post('/businesses/development-demos', {})).data.data;
export const linkRestaurant = async () => (await api.post('/businesses/link-restaurant', {})).data.data;
// An owner adds another business of their own (any type but restaurant).
export const createBusiness = async (body) => (await api.post('/businesses', body)).data.data;
export const businessContext = async (businessId, signal) => (await api.get(`/businesses/${businessId}/context`, { signal })).data.data;
// Remembers this business as the one the person last opened.
export const openBusiness = async (businessId) => (await api.post(`/businesses/${businessId}/open`, {})).data.data;
export const businessRead = async (businessId, path, params, signal) =>
  (await api.get(`/businesses/${businessId}/${path}`, { params, signal })).data.data;
export const businessWrite = async (businessId, path, body, method = 'post') =>
  (await api[method](`/businesses/${businessId}/${path}`, body)).data.data;

// Pickers load all pages explicitly rather than silently losing records past 100.
export async function businessOptions(businessId, path, signal, params = {}) {
  const result = [];
  for (let offset = 0; ; offset += 100) {
    const page = await businessRead(businessId, path, { ...params, limit: 100, offset }, signal);
    result.push(...page.items);
    if (result.length >= page.total || !page.items.length) return result;
  }
}
