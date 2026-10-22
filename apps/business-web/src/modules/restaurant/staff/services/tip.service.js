import api from "../../../../services/api";

// Staff -> Tips: collected, shared out, paid with salary.
export const getTips = async (range) => (await api.get("/staff/tips", { params: range })).data.data;
export const getTipSettings = async () => (await api.get("/staff/tips/settings")).data.data;
export const saveTipSettings = async (payload) => (await api.put("/staff/tips/settings", payload)).data.data;
export const previewShareout = async (payload) => (await api.post("/staff/tips/preview", payload)).data.data;
export const confirmShareout = async (payload) => (await api.post("/staff/tips/shareouts", payload)).data;
export const undoShareout = async (id) => (await api.delete(`/staff/tips/shareouts/${id}`)).data;
