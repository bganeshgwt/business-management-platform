import api from "../../../../services/api";

// Floors
export const listFloors = async () => (await api.get("/tables/floors")).data.data;
export const createFloor = async (payload) => (await api.post("/tables/floors", payload)).data.data;
export const updateFloor = async (id, payload) =>
  (await api.put(`/tables/floors/${id}`, payload)).data.data;
export const deleteFloor = async (id) => (await api.delete(`/tables/floors/${id}`)).data;

// Dining areas
export const listAreas = async () => (await api.get("/tables/areas")).data.data;
export const createArea = async (payload) => (await api.post("/tables/areas", payload)).data.data;
export const updateArea = async (id, payload) =>
  (await api.put(`/tables/areas/${id}`, payload)).data.data;
export const deleteArea = async (id) => (await api.delete(`/tables/areas/${id}`)).data;

// Tables
export const listTables = async (filters = {}) =>
  (await api.get("/tables", { params: filters })).data.data;
export const createTable = async (payload) => (await api.post("/tables", payload)).data.data;
export const updateTable = async (id, payload) => (await api.put(`/tables/${id}`, payload)).data.data;
export const regenerateTableQr = async (id) => (await api.patch(`/tables/${id}/qr`)).data.data;
export const deleteTable = async (id) => (await api.delete(`/tables/${id}`)).data;

// What a printed QR code carries: { guestWebAddress, restaurantName, logoPath }.
export const getQrSettings = async () => (await api.get("/tables/qr-settings")).data.data;

// The table has been cleared and laid again after the last party.
export const markTableReady = async (id) => (await api.patch(`/tables/${id}/ready`)).data.data;

// Floor settings: how long a settled table is held as "Cleaning".
export const getFloorSettings = async () => (await api.get("/tables/settings")).data.data;
export const updateFloorSettings = async (payload) =>
  (await api.put("/tables/settings", payload)).data.data;

// Captain sections (SW-A-20): the plan for a business date (today's by
// default), saving the whole plan, and copying another day's plan.
export const getCaptainPlan = async (date) =>
  (await api.get("/tables/sections", { params: date ? { date } : {} })).data.data;
export const saveCaptainPlan = async (payload) => (await api.put("/tables/sections", payload)).data;
export const copyCaptainPlan = async (payload) => (await api.post("/tables/sections/copy", payload)).data;
