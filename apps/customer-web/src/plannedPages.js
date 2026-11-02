// Guest pages the platform will have that are not built yet (see
// docs/ARCHITECTURE.md › Every address). Their addresses already work
// (App.jsx): each says what is coming and what to do until then, never "Page
// not found". When one is built, its real page takes the route and its entry
// here is deleted.
export const PLANNED_PAGES = {
  account: {
    title: "Your account",
    icon: "user",
    coming: "Soon your orders, bookings and loyalty points will be together here.",
    today: "open the link you were sent for an order or a booking; it always shows the latest status.",
  },
};
