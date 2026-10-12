const outletRepository = require("../modules/restaurant/setup/repositories/outlet.repository");
const AppError = require("../utils/AppError");

// Which outlet a report (or the dashboard) reads.
//
// The same rules as resolveOutlet — a user pinned to one outlet reads that
// outlet and no other, and another restaurant's outlet is refused — with two
// differences that only make sense for reading history:
//
//   * A closed (inactive) outlet can be read. Its bills, stock and GST return
//     stay in the books after it stops trading; a branch with its own GSTIN
//     still has to file its last return. resolveOutlet refuses a closed
//     outlet because nothing may be RECORDED there — reading is not that.
//
//   * The outlet may be named in the query (?outletId=12). The top-bar
//     switcher offers only outlets that trade, so a closed branch is read
//     from the Reports screen's own picker and the Outlets page's links,
//     without storing a closed outlet as the outlet everyone works in. When
//     both are sent, the query wins: it is the more specific request.
//
// Sets:
//   req.outletId      the outlet to read, or null for the whole restaurant
//   req.outletPinned  true when the user is tied to that outlet
//
// An id is plain digits the database can hold. Number() alone let
// 99999999999999999999 (and "1e3") through, and PostgreSQL then refused it
// as out of range for a bigint — "Internal server error" for a URL anyone can
// edit.
const readId = (value) => {
  const text = String(value).trim();
  const id = Number(text);

  if (!/^\d{1,16}$/.test(text) || !Number.isSafeInteger(id) || id < 1) {
    throw new AppError(400, "That outlet id is not valid");
  }

  return id;
};

const reportOutlet = async (req, res, next) => {
  try {
    const fromQuery = req.query && req.query.outletId !== undefined && req.query.outletId !== "";
    const asked = fromQuery ? req.query.outletId : req.get("X-Outlet-Id");

    if (req.user.outletId) {
      const pinnedId = Number(req.user.outletId);

      if (asked && readId(asked) !== pinnedId) {
        throw new AppError(
          403,
          "You are set up to work at one outlet only. Ask your manager if you need to see another."
        );
      }

      const outlet = await outletRepository.findById(req.user.restaurantId, pinnedId);

      if (!outlet) {
        throw new AppError(403, "Your outlet no longer exists. Ask your manager to move you to an open outlet.");
      }

      req.outletId = pinnedId;
      req.outletPinned = true;
      next();
      return;
    }

    req.outletPinned = false;

    if (!asked) {
      req.outletId = null;
      next();
      return;
    }

    const outlet = await outletRepository.findById(req.user.restaurantId, readId(asked));

    if (!outlet) {
      throw new AppError(403, "That outlet does not belong to your restaurant");
    }

    req.outletId = outlet.id;
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = reportOutlet;
