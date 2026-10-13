import api from "../../../services/api";

// The platform console (the platform's own super admin only).
export const listPlatformRestaurants = async (params) =>
  (await api.get("/users/platform/restaurants", { params })).data.data;
export const createPlatformRestaurant = async (payload) => (await api.post("/users/platform/restaurants", payload)).data;
export const setPlatformRestaurantStatus = async (id, status) =>
  (await api.put(`/users/platform/restaurants/${id}/status`, { status })).data;
export const listPlatformAdmins = async (id) => (await api.get(`/users/platform/restaurants/${id}/admins`)).data.data;
export const resetPlatformAdminPassword = async (id, userId, password) =>
  (await api.post(`/users/platform/restaurants/${id}/admin-password`, { userId, password })).data;

// Platform › Businesses: every business type but restaurant.
export const listPlatformBusinesses = async (params) => (await api.get("/users/platform/businesses", { params })).data.data;
export const createPlatformBusiness = async (payload) => (await api.post("/users/platform/businesses", payload)).data.data;
export const setPlatformBusinessStatus = async (id, status) => (await api.put(`/users/platform/businesses/${id}/status`, { status })).data.data;
export const resetPlatformBusinessOwner = async (id, userId, password) =>
  (await api.post(`/users/platform/businesses/${id}/owner-password`, { userId, password })).data.data;
