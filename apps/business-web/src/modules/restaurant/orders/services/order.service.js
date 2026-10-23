import api from "../../../../services/api";

// Every call that can take off a dish the kitchen already has accepts
// `headers`, so withApproval can send it again with a manager's approval.

// filters: { status, orderType, businessDayId, limit, sort }. sort
// "tables_first" puts every running table before any takeaway. The answer is
// { items, total, limit, summary: { onTables, other, amount } }, the summary
// counted over every matching order, not only the page sent.
export const listOrders = async (filters = {}) =>
  (await api.get("/orders", { params: filters })).data.data;

export const getOrder = async (id) => (await api.get(`/orders/${id}`)).data.data;

export const createOrder = async (payload) => (await api.post("/orders", payload)).data.data;

// Saves a change to a running order: only what changed. payload.items lists
// the lines the waiter changed, by id with the quantity wanted now and the
// quantity the screen showed (seenQuantity), and new dishes by what they
// are; a line left out stays as it is. cancelReason and cancelNote say why a
// dish the kitchen has is coming off. Header fields (guestCount, notes, the
// guest) are sent only when they changed, with `seen` saying what the screen
// showed for each; one another device changed meanwhile is refused (409
// order_changed) rather than overwritten.
export const updateOrderItems = async (id, payload, headers = {}) =>
  (await api.put(`/orders/${id}/items`, { ...payload, changesOnly: true }, { headers })).data.data;

// Whether a business day is open: { current: { id, businessDate } | null }.
// Readable by everyone who takes orders, captains included.
export const getServiceDay = async () => (await api.get("/orders/day")).data.data;

// The open outlets by name, for "which outlet is this sale for?" on the till.
export const listSaleOutlets = async () => (await api.get("/orders/outlets")).data.data;

export const setKitchenStatus = async (id, status) =>
  (await api.patch(`/orders/${id}/kitchen-status`, { status })).data.data;

// The collection screen: { preparing: [{ token }], ready: [{ token, readyAt }],
// clearMinutes, tokensEnabled, ... }. Counter staff also get each token's
// orderId, to mark it collected.
export const getCollectionBoard = async () => (await api.get("/orders/collection")).data.data;
export const markTokenCollected = async (orderId) => (await api.post(`/orders/${orderId}/collected`)).data;

// The service desk's settings (token numbers and the pickup screen, and the
// others kept with them), and saving one part of them.
export const getServiceSettings = async () => (await api.get("/orders/service-settings")).data.data;
export const updateServiceSettings = async (part, payload) =>
  (await api.put(`/orders/service-settings/${part}`, payload)).data;

export const fireOrderCourse = async (id, courseNo) =>
  (await api.post(`/orders/${id}/courses/${courseNo}/fire`)).data.data;

export const cancelOrder = async (id, reason, reasonCode, headers = {}) =>
  (await api.patch(`/orders/${id}/cancel`, { reason, reasonCode }, { headers })).data.data;

// Takes all or part of one dish off: { quantity, reason, note }.
export const cancelOrderItem = async (orderId, itemId, body = {}, headers = {}) =>
  (await api.patch(`/orders/${orderId}/items/${itemId}/cancel`, body, { headers })).data.data;

// The prices running now where the order will be charged, per dish and size:
// happy hours, and the price for the service (a takeaway or delivery price,
// a delivery channel's price and its packaging charge). context: { orderId }
// for the order the till has open, or { tableId } for the table a new order
// is for (with "All outlets" selected a table's order is charged at the
// table's own outlet); orderType and channelId say which service a new
// order is for. Without them the server answers the dine-in price, and the
// till would show one price while the bill charged another.
export const listOffers = async (context = {}) => {
  const params = {};

  if (context.orderId) {
    params.orderId = context.orderId;
  } else if (context.tableId) {
    params.tableId = context.tableId;
  }

  if (context.orderType) {
    params.orderType = context.orderType;
  }

  if (context.channelId) {
    params.channelId = context.channelId;
  }

  return (await api.get("/orders/offers", { params })).data.data;
};

// Dishes taken off after the kitchen had them: { from, to, userId, reason }.
export const listCancellations = async (filters = {}) =>
  (await api.get("/orders/cancellations", { params: filters })).data.data;

// The guest behind a mobile typed at the till: { mobile, valid, problem,
// guest: { id, name, visits, loyaltyPoints, tags, allergies } | null }.
export const lookupGuestByMobile = async (mobile) =>
  (await api.get("/orders/guest", { params: { mobile } })).data.data;

// Guests moving on the floor. Each returns { message, data } so the screen
// can say what happened: data.order is the order the party is on now, and
// data.from the order dishes came from (when there were two).
//   moveTable     { tableId, overrideHold }
//   joinTable     { tableId, overrideHold } (an order running there joins this one)
//   unjoinTable   { tableId }
//   moveDishes    { tableId, items: [{ id, quantity, seenQuantity }], guests, overrideHold }
export const moveOrderTable = async (id, payload) =>
  (await api.post(`/orders/${id}/move-table`, payload)).data;

export const joinOrderTable = async (id, payload) =>
  (await api.post(`/orders/${id}/join-table`, payload)).data;

export const unjoinOrderTable = async (id, tableId) =>
  (await api.post(`/orders/${id}/unjoin-table`, { tableId })).data;

export const moveOrderDishes = async (id, payload) =>
  (await api.post(`/orders/${id}/move-dishes`, payload)).data;

// Where an order has moved, newest first.
export const listOrderMoves = async (id) => (await api.get(`/orders/${id}/moves`)).data.data;

// Every table joined to a party still here (its order open, or billed and
// not yet paid): [{ tableId, tableNo, orderId, orderNumber, orderStatus,
// mainTableNo }].
export const listJoinedTables = async () => (await api.get("/orders/joined-tables")).data.data;

// A delivery's trip charge: waived with a reason (a manager, or
// their PIN), or charged again. Each answers { message, data: order }.
export const waiveDeliveryCharge = async (orderId, reason, headers) =>
  (await api.post(`/orders/${orderId}/delivery-charge/waive`, { reason }, { headers })).data;

export const restoreDeliveryCharge = async (orderId) =>
  (await api.post(`/orders/${orderId}/delivery-charge/restore`)).data;
