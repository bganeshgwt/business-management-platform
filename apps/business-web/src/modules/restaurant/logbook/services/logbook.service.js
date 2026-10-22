import api from "../../../../services/api";

// The shift log book.
export const listLogbook = async (params) => (await api.get("/staff/logbook", { params })).data.data;
export const getHandover = async () => (await api.get("/staff/logbook/handover")).data.data;
export const addLogbookEntry = async (payload) => (await api.post("/staff/logbook", payload)).data;
export const closeLogbookEntry = async (id, note) => (await api.post(`/staff/logbook/${id}/close`, { note })).data;
export const markLogbookRead = async (ids) => (await api.post("/staff/logbook/read", { ids })).data.data;
