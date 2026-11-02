const repo = require("../../core/repositories/business.repository");
const AppError = require("../../../../utils/AppError");

// Whether a business takes anything from its guest pages now (ARCHITECTURE.md
// › Build a guest page for a business): the business's version of
// planGuard.assertTakingOrders, for every write a guest page makes (a booking,
// an order, a change to one).
//
//   assertBusinessTakingOrders(db, businessId, { locationId, message })
//
//   - no such business, or a location that is not this business's: 404
//     not_available, the way an unknown link answers;
//   - a business whose paid plan has ended, a business the platform switched
//     off (business_plan_state ended or off), or a location that is closed:
//     409 not_taking_orders, with the page's own sentence when it gives one.
//     The page then says so and gives the business's phone, from its card
//     (guestBusinessCard: takingOrders false).
// Reads only; with the caller's transaction client when it has one.

const NOT_AVAILABLE = "This page is not available any more. Please contact the business.";
const NOT_TAKING = "This business isn't taking online orders or bookings right now. Please call them.";

async function assertBusinessTakingOrders(db, businessId, { locationId = null, message = NOT_TAKING } = {}) {
  const row = await repo.one(db, "SELECT s.state FROM businesses b CROSS JOIN LATERAL business_plan_state(b.id) s WHERE b.id=$1", [businessId]);

  if (!row) {
    throw new AppError(404, NOT_AVAILABLE, { reason: "not_available" });
  }

  let closed = ["ended", "off"].includes(row.state);

  if (locationId !== null && locationId !== undefined) {
    const id = Number(locationId);
    const location = Number.isSafeInteger(id) && id > 0
      ? await repo.one(db, "SELECT active FROM business_locations WHERE business_id=$1 AND id=$2", [businessId, id])
      : null;

    if (!location) {
      throw new AppError(404, NOT_AVAILABLE, { reason: "not_available" });
    }

    closed = closed || !location.active;
  }

  if (closed) {
    throw new AppError(409, message, { reason: "not_taking_orders" });
  }
}

module.exports = { assertBusinessTakingOrders, NOT_AVAILABLE, NOT_TAKING };
