// The delivery details the POS takes with an order, and what is sent to
// PATCH /deliveries/:orderId (the deliveries module keeps them on the order).
//
// savedAddressId: one of the guest's saved addresses, picked with a tap
// (SW-A-18); the server copies its full text onto the delivery, so it works
// also where the till shows it masked. addressLabel: what a new address is
// kept under on the guest (Home, Office, Other).
export const EMPTY_DELIVERY = {
  channelId: "",
  address: "",
  landmark: "",
  externalRef: "",
  etaMinutes: "",
  savedAddressId: null,
  addressLabel: "",
};

export const deliveryOf = (order) =>
  order
    ? {
        channelId: order.channelId ? String(order.channelId) : "",
        address: order.deliveryAddress || "",
        landmark: order.deliveryLandmark || "",
        externalRef: order.externalOrderRef || "",
        etaMinutes: order.deliveryEtaMinutes ? String(order.deliveryEtaMinutes) : "",
        savedAddressId: null,
        addressLabel: "",
      }
    : EMPTY_DELIVERY;

export const sameDelivery = (a, b) =>
  ["channelId", "address", "landmark", "externalRef", "etaMinutes"].every(
    (field) => String(a[field] || "").trim() === String(b[field] || "").trim()
  );

// What PATCH /deliveries/:orderId is sent: every field, blank ones as null,
// so clearing a landmark clears it.
export const deliveryPayload = (value) => ({
  channelId: value.channelId ? Number(value.channelId) : null,
  ...(value.savedAddressId
    ? { savedAddressId: value.savedAddressId }
    : {
        address: value.address.trim() || null,
        landmark: value.landmark.trim() || null,
        ...(value.addressLabel ? { addressLabel: value.addressLabel } : {}),
      }),
  externalRef: value.externalRef.trim() || null,
  etaMinutes: value.etaMinutes ? Number(value.etaMinutes) : null,
});

