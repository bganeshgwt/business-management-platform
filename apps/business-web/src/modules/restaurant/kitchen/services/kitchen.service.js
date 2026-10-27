import api from "../../../../services/api";

// The board: open tickets, stations, the day's figures. Reading it also cuts
// any tickets the tills have sent since the last read.
export const getBoard = async (params = {}) =>
  (await api.get("/kitchen/board", { params })).data.data;

// The food at the pass, for the waiters who carry it out (the captain app):
// { serverTime, passMinutes, tickets }, the tickets marked ready and not yet
// served, oldest first. Reading it cuts nothing.
export const getPass = async () => (await api.get("/kitchen/pass")).data.data;

// One order's tickets, cut first if the kitchen has not seen it yet.
export const getOrderTickets = async (orderId) =>
  (await api.get(`/kitchen/orders/${orderId}/kots`)).data.data;

// Ticket actions return { message, data } so the screen can say what happened.
export const setTicketStatus = async (id, status) =>
  (await api.patch(`/kitchen/kots/${id}/status`, { status })).data;
export const setTicketItemDone = async (kotId, itemId, done) =>
  (await api.patch(`/kitchen/kots/${kotId}/items/${itemId}`, { done })).data;
export const recallTicket = async (id) => (await api.post(`/kitchen/kots/${id}/recall`)).data;
export const recallLastTicket = async (stationId) =>
  (await api.post("/kitchen/recall", stationId ? { stationId } : {})).data;
export const recordTicketPrint = async (id) =>
  (await api.post(`/kitchen/kots/${id}/print`)).data.data;
// Change slips (CANCEL / TABLE CHANGED). Claiming hands this till the slips of
// these orders nobody has printed yet, counted as printed, so two tills never
// print the same one.
export const claimChangeSlips = async (orderIds) =>
  (await api.post("/kitchen/slips/claim", { orderIds })).data.data;
export const recordSlipPrint = async (id) => (await api.post(`/kitchen/slips/${id}/print`)).data.data;
// A manager's tidy-up: open tickets older than this leave the board.
export const clearOldTickets = async ({ olderThanMinutes, stationId }) =>
  (
    await api.post("/kitchen/clear-old", {
      olderThanMinutes,
      ...(stationId ? { stationId } : {}),
    })
  ).data;

// Stations and routing
export const getStationSetup = async () => (await api.get("/kitchen/stations")).data.data;
export const createStation = async (payload) =>
  (await api.post("/kitchen/stations", payload)).data;
export const updateStation = async (id, payload) =>
  (await api.put(`/kitchen/stations/${id}`, payload)).data;
export const makeDefaultStation = async (id) =>
  (await api.post(`/kitchen/stations/${id}/default`)).data;
export const setCategoryStation = async (categoryId, stationId) =>
  (await api.put(`/kitchen/category-stations/${categoryId}`, { stationId: stationId || null })).data;
export const setDishStation = async (productId, stationId) =>
  (await api.put(`/kitchen/product-stations/${productId}`, { stationId: stationId || null })).data;
export const searchDishes = async (search) =>
  (await api.get("/kitchen/products", { params: { search } })).data.data;
export const updateKitchenSettings = async (payload) =>
  (await api.put("/kitchen/settings", payload)).data;
