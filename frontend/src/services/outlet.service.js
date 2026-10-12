import api from "./api";

export const listOutlets = async () => (await api.get("/outlets")).data.data;

export const createOutlet = async (payload) => (await api.post("/outlets", payload)).data.data;

export const updateOutlet = async (id, payload) =>
  (await api.put(`/outlets/${id}`, payload)).data.data;

export const deleteOutlet = async (id) => (await api.delete(`/outlets/${id}`)).data;

// What is recorded at an outlet: { history, setup, canDelete, mustDeactivate }.
// Read before offering Delete, so an outlet with sales is closed instead.
export const getOutletUsage = async (id) => (await api.get(`/outlets/${id}/usage`)).data.data;
