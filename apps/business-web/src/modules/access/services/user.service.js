import api from "../../../services/api";

export const listUsers = async () => (await api.get("/users")).data.data;

export const createUser = async (payload) => (await api.post("/users", payload)).data.data;

export const updateUser = async (id, payload) => (await api.put(`/users/${id}`, payload)).data.data;

export const resetUserPassword = async (id, password) =>
  (await api.patch(`/users/${id}/password`, { password })).data;

// Personal PIN, sessions and lockouts, set by an admin
export const setUserPin = async (id, pin, confirmPin) =>
  (await api.put(`/users/${id}/pin`, { pin, confirmPin })).data;
export const clearUserPin = async (id) => (await api.delete(`/users/${id}/pin`)).data;
export const signOutUser = async (id) => (await api.post(`/users/${id}/sign-out`)).data;
export const unlockUser = async (id) => (await api.post(`/users/${id}/unlock`)).data;
export const getUserSignIns = async (id) => (await api.get(`/users/${id}/sign-ins`)).data.data;

// How a shared till behaves
export const getAccessSettings = async () => (await api.get("/users/access-settings")).data.data;
export const saveAccessSettings = async (payload) =>
  (await api.put("/users/access-settings", payload)).data.data;

// The activity log
export const getActivityLog = async (filters = {}) =>
  (await api.get("/users/activity-log", { params: filters })).data.data;
export const getActivityFacets = async () => (await api.get("/users/activity-log/facets")).data.data;
// The activity log's "Staff member" search: people in the log matching q
// ([{ id, name, entries, last_at }]); `signal` cancels an older search.
export const searchActivityPeople = async (q, { signal, limit = 20 } = {}) =>
  (await api.get("/users/activity-log/people", { params: { q: q || undefined, limit }, signal })).data.data;
// One page of an export: { items, nextCursor, total (first page only) }.
export const getActivityExportPage = async (filters = {}) =>
  (await api.get("/users/activity-log/export", { params: filters })).data.data;

// Two-step sign-in, as an admin sees it
export const resetUserTwoFactor = async (id) => (await api.post(`/users/${id}/two-factor/reset`)).data;
export const saveTwoFactorRoles = async (roleIds) => (await api.put("/users/two-factor-roles", { roleIds })).data;
