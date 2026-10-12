import api from "../../../services/api";

export const listRoles = async () => (await api.get("/roles")).data.data;

export const listPermissions = async () => (await api.get("/roles/permissions")).data.data;

export const createRole = async (payload) => (await api.post("/roles", payload)).data.data;

export const updateRole = async (id, payload) => (await api.put(`/roles/${id}`, payload)).data.data;

// Makes this restaurant's own copy of a role (usually a built-in one), and
// optionally moves everyone who has the original onto the copy.
export const copyRole = async (id, payload) => (await api.post(`/roles/${id}/copy`, payload)).data;

export const deleteRole = async (id) => (await api.delete(`/roles/${id}`)).data;
