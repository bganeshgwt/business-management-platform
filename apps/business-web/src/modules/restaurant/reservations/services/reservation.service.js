import api from "../../../../services/api";

// The host stand in one read: bookings for a date, the room, the waitlist and
// the day's numbers.
export const getReservationBoard = async (date) =>
  (await api.get("/reservations/day", { params: date ? { date } : {} })).data.data;

// Bookings
export const listReservations = async (filters = {}) =>
  (await api.get("/reservations", { params: filters })).data.data;
export const getReservation = async (id) => (await api.get(`/reservations/${id}`)).data.data;
export const createReservation = async (payload) =>
  (await api.post("/reservations", payload)).data;
export const updateReservation = async (id, payload) =>
  (await api.put(`/reservations/${id}`, payload)).data;
export const confirmReservation = async (id) =>
  (await api.patch(`/reservations/${id}/confirm`)).data;
export const cancelReservation = async (id, reason) =>
  (await api.patch(`/reservations/${id}/cancel`, { reason })).data;
export const markReservationNoShow = async (id) =>
  (await api.patch(`/reservations/${id}/no-show`)).data;
export const completeReservation = async (id) =>
  (await api.patch(`/reservations/${id}/complete`)).data;
export const seatReservation = async (id, payload) =>
  (await api.post(`/reservations/${id}/seat`, payload)).data;

// Which tables suit a time and party size. `now: true` asks about seating
// someone this minute, where a table with guests on it is not free.
export const getTableAvailability = async (params) =>
  (await api.get("/reservations/availability", { params })).data.data;
// `excludeId` leaves the booking being edited out of the guest's record.
export const lookupGuest = async (mobile, excludeId) =>
  (await api.get("/reservations/guest", { params: { mobile, excludeId } })).data.data;

// Walk-in waitlist
export const addToWaitlist = async (payload) =>
  (await api.post("/reservations/waitlist", payload)).data;
export const updateWaitlistEntry = async (id, payload) =>
  (await api.put(`/reservations/waitlist/${id}`, payload)).data;
export const notifyWaitlistEntry = async (id) =>
  (await api.patch(`/reservations/waitlist/${id}/notify`)).data;
export const markWaitlistLeft = async (id) =>
  (await api.patch(`/reservations/waitlist/${id}/left`)).data;
export const removeWaitlistEntry = async (id) =>
  (await api.patch(`/reservations/waitlist/${id}/remove`)).data;
export const seatWaitlistEntry = async (id, payload) =>
  (await api.post(`/reservations/waitlist/${id}/seat`, payload)).data;

// Online booking: the requests guests send from the booking link,
// and the link itself for the counter or outlet being worked in.
export const acceptReservation = async (id, payload = {}) =>
  (await api.patch(`/reservations/${id}/accept`, payload)).data;
export const declineReservation = async (id, reason) =>
  (await api.patch(`/reservations/${id}/decline`, { reason })).data;
export const getOnlineBookingSettings = async () => (await api.get("/reservations/online-settings")).data.data;
export const updateOnlineBookingSettings = async (payload) =>
  (await api.put("/reservations/online-settings", payload)).data;
export const replaceOnlineBookingLink = async () => (await api.post("/reservations/online-settings/new-link")).data;
