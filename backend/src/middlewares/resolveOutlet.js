const outletRepository = require("../modules/restaurant/setup/repositories/outlet.repository");
const AppError = require("../utils/AppError");

// Which outlet this request is working in.
//
// It is settled here rather than taken from the request body, for the same
// reason the restaurant is: an id the browser sends is a request, not a fact.
// A user pinned to one outlet cannot work in another however they ask, and an
// outlet belonging to a different restaurant is never accepted.
//
// Runs after authenticate. Sets:
//   req.outletId      the outlet this request works in; may be null — a
//                     restaurant with a single location need not use outlets
//   req.outletPinned  true when the user is tied to that outlet. Lists and
//                     actions on existing records (bills, orders) must then
//                     treat another outlet's record as not found.
const resolveOutlet = async (req, res, next) => {
  try {
    // A user tied to one outlet works there and nowhere else. The switcher is
    // for owners and managers, who are not pinned.
    if (req.user.outletId) {
      const pinnedId = Number(req.user.outletId);
      const asked = req.get("X-Outlet-Id");

      // Asking for a different outlet is refused rather than quietly ignored,
      // so a stale switcher value or a hand-made request is visible.
      if (asked && Number(asked) !== pinnedId) {
        throw new AppError(
          403,
          "You are set up to work at one outlet only. Ask your manager if you need to work at another."
        );
      }

      const outlet = await outletRepository.findById(req.user.restaurantId, pinnedId);

      // An outlet that has been closed (made inactive) or removed takes no
      // orders, bills or stock — including from the staff tied to it.
      if (!outlet || outlet.status !== "active") {
        throw new AppError(
          403,
          outlet
            ? `Your outlet "${outlet.name}" is not active, so nothing can be recorded there. Ask your manager to move you to an open outlet.`
            : "Your outlet no longer exists. Ask your manager to move you to an open outlet.",
          { reason: "outlet_inactive" }
        );
      }

      req.outletId = pinnedId;
      req.outletPinned = true;
      next();
      return;
    }

    req.outletPinned = false;
    const asked = req.get("X-Outlet-Id");

    if (!asked) {
      req.outletId = null;
      next();
      return;
    }

    const id = Number(asked);

    if (!Number.isInteger(id) || id < 1) {
      throw new AppError(400, "That outlet id is not valid");
    }

    const outlet = await outletRepository.findById(req.user.restaurantId, id);

    if (!outlet) {
      throw new AppError(403, "That outlet does not belong to your restaurant");
    }

    if (outlet.status !== "active") {
      throw new AppError(400, `The outlet "${outlet.name}" is not active`);
    }

    req.outletId = outlet.id;
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = resolveOutlet;
