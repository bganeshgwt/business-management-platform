import api from "../../../../services/api";

// The board: every delivery of the open day, the riders and the day's figures.
// `date` (YYYY-MM-DD): an earlier business date's deliveries instead.
export const getDeliveryBoard = async (date) =>
  (await api.get("/deliveries/board", { params: date ? { date } : undefined })).data.data;

export const getDelivery = async (orderId) =>
  (await api.get(`/deliveries/${orderId}`)).data.data;

// Actions return { message, data } so the screen can say what happened.
export const updateDelivery = async (orderId, payload) =>
  (await api.patch(`/deliveries/${orderId}`, payload)).data;

export const setDeliveryStatus = async (orderId, payload) =>
  (await api.patch(`/deliveries/${orderId}/status`, payload)).data;

// One rider, one or more orders.
export const dispatchDeliveries = async (payload) =>
  (await api.post("/deliveries/dispatch", payload)).data;

// Channels
export const listChannels = async () => (await api.get("/deliveries/channels")).data.data;
export const createChannel = async (payload) =>
  (await api.post("/deliveries/channels", payload)).data;
export const updateChannel = async (id, payload) =>
  (await api.put(`/deliveries/channels/${id}`, payload)).data;
export const deleteChannel = async (id) => (await api.delete(`/deliveries/channels/${id}`)).data;

// Money by channel for a date range, and how the deliveries went.
export const getChannelReport = async (params = {}) =>
  (await api.get("/deliveries/report", { params })).data.data;

// Rider cash settlement: a rider's delivered, unpaid bills; paying
// them in one step (a shortfall kept as owed, or written off with a
// manager's PIN); the day's settlements and the dues riders still owe.
export const getRiderSettlement = async (riderId) =>
  (await api.get(`/deliveries/riders/${riderId}/settlement`)).data.data;
export const settleRider = async (riderId, payload) =>
  (await api.post(`/deliveries/riders/${riderId}/settle`, payload)).data;
export const settleRiderWriteOff = async (riderId, payload, headers) =>
  (await api.post(`/deliveries/riders/${riderId}/settle-write-off`, payload, { headers })).data;
export const getRiderSettlements = async (params = {}) =>
  (await api.get("/deliveries/rider-settlements", { params })).data.data;
export const markRiderRepaid = async (id) =>
  (await api.post(`/deliveries/rider-settlements/${id}/repaid`)).data;
