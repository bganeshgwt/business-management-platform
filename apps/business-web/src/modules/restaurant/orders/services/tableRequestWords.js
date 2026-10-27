// What a guest's call from the QR code on their table asks for, in the words
// a waiter reads it: Table requests, the dashboard and the captain app say it
// the same way. `icon` names the mark beside it (Table requests draws "drop"
// itself; the shared icon set has no drop of water).
//
// Kept free of React and of the API, so the captain app's floor rules
// (workspaces/captain/captainFloor.js) can be tested on their own.
export const CALL_META = {
  call_waiter: { title: "Wants a waiter", icon: "bell" },
  bill: { title: "Wants the bill", icon: "receipt" },
  water: { title: "Asked for water", icon: "drop" },
  other: { title: "Needs something", icon: "message" },
};
