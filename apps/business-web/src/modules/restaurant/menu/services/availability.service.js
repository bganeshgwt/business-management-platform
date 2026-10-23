import api from "../../../../services/api";

// The day's sold-out list: what cannot be sold right now.
//   { businessDay, items: [{ productId, productVariantId, label, note,
//     soldOutAt, markedByName }], switchedOff: [...], backOnToday: [...] }
// A dish marked sold out here is back on sale by itself when the next
// business day opens.
export const getAvailability = async () => (await api.get("/availability")).data.data;

// { productId, productVariantId?, soldOut, note? }. Returns { message, data }
// with the list as it now is.
export const setSoldOut = async (payload) => (await api.patch("/availability", payload)).data;

// "12:" is the whole dish, "12:40" one size of it — the keys the till checks.
export const soldOutKey = (productId, variantId) => `${productId}:${variantId || ""}`;

// Every dish there is to mark sold out, with its sizes: [{ id, name, code,
// foodType, isAvailable, categoryName, variants: [{ id, name, status }] }].
// For the kitchen screen, whose cooks may mark a dish (menu.availability)
// without being allowed to open the menu.
export const listMarkableDishes = async () => (await api.get("/availability/dishes")).data.data;
