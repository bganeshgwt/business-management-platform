import api from "../../../../services/api";

// The tablet at the staff entrance
export const getBoard = async () => (await api.get("/timeclock/board")).data.data;
export const verifyPin = async (payload) => (await api.post("/timeclock/verify", payload)).data.data;
export const punch = async (payload) => (await api.post("/timeclock/punch", payload)).data.data;

// A day's punches and timeline
export const getDay = async (date) =>
  (await api.get("/timeclock/day", { params: date ? { date } : {} })).data.data;
export const listPunches = async (filters = {}) =>
  (await api.get("/timeclock/punches", { params: filters })).data.data;
export const addPunch = async (payload) => (await api.post("/timeclock/punches", payload)).data;
export const removePunch = async (punchId, reason) =>
  (await api.delete(`/timeclock/punches/${punchId}`, { data: { reason } })).data;

// PINs
export const listPins = async () => (await api.get("/timeclock/pins")).data.data;
export const setPin = async (employeeId, payload) =>
  (await api.put(`/timeclock/pins/${employeeId}`, payload)).data;
export const removePin = async (employeeId) => (await api.delete(`/timeclock/pins/${employeeId}`)).data;
export const unlockPin = async (employeeId) =>
  (await api.post(`/timeclock/pins/${employeeId}/unlock`)).data;

// Punch photos: the setting, and one punch's picture (as a blob, because the
// request needs the session; the page makes it an object URL).
export const getTimeclockSettings = async () => (await api.get("/timeclock/settings")).data.data;
export const saveTimeclockSettings = async (payload) => (await api.put("/timeclock/settings", payload)).data;
export const getPunchPhoto = async (punchId) =>
  (await api.get(`/timeclock/punches/${punchId}/photo`, { responseType: "blob" })).data;
