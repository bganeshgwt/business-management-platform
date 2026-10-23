// Guest pages the platform will have that are not built yet (see
// docs/ARCHITECTURE.md › Every address). Their addresses already work
// (App.jsx): each says what is coming and what to do until then, never "Page
// not found". When one is built, its real page takes the route and its entry
// here is deleted.
export const PLANNED_PAGES = {
  shop: {
    title: "Order from a shop",
    icon: "store",
    coming: "Soon you will be able to see a shop's products here and order for pickup or delivery.",
    today: "please call or message the shop to place your order.",
  },
  appointments: {
    title: "Book an appointment",
    icon: "calendar",
    coming: "Soon you will be able to book a salon or clinic appointment here.",
    today: "please call the salon or clinic to book.",
  },
  account: {
    title: "Your account",
    icon: "user",
    coming: "Soon your orders, bookings and loyalty points will be together here.",
    today: "open the link you were sent for an order or a booking; it always shows the latest status.",
  },
};
