import PosPage from "../../modules/restaurant/orders/pages/PosPage";

// Where the captain app's screens are, for the POS in its captain mode.
const CAPTAIN = { home: "/captain", calls: "/captain/calls" };

// Taking an order at the table: the POS's own screen, never a copy, in its
// phone layout. The same order and KOT calls and the same rules (what is on
// sale and sold out, the price of the hour, the table held for a booking,
// cancelling after the KOT, moving and joining tables, the bill); a dine-in
// order's dishes may be held for a later course, and a dish just added may
// take a note.
export default function CaptainOrderPage() {
  return (
    <>
      <h1 className="sr-only">Take an order</h1>
      <PosPage captain={CAPTAIN} />
    </>
  );
}
