// Quick sold-out switch ("86 a dish") for the floor and the kitchen.
//
// Separate from menu editing on purpose: a captain or a cook must be able to
// say "paneer is finished" in two taps without being allowed to change prices.
// A dish marked here is sold out for the current business day only and is
// back on sale by itself when the next day opens.
//
//   GET   /api/availability   what cannot be sold right now
//   PATCH /api/availability   { productId, productVariantId?, soldOut, note? }
const express = require("express");
const availabilityController = require("../controllers/availability.controller");
const authenticate = require("../../../../middlewares/authenticate");
const authorize = require("../../../../middlewares/authorize");
const AppError = require("../../../../utils/AppError");

const router = express.Router();

// Any one of these will do: the till reads it to grey dishes out, the
// kitchen screen to show what is off, and whoever may switch a dish reads it
// to switch it back.
const READERS = ["orders.view", "kds.view", "menu.view", "menu.availability"];

const authorizeAnyReader = (req, res, next) => {
  const granted = req.user?.permissions || [];

  if (!READERS.some((permission) => granted.includes(permission))) {
    throw new AppError(403, "You do not have permission to perform this action");
  }

  next();
};

authorize.noteEnforced(...READERS);

router.use(authenticate);
router.use(require('../../../../middlewares/resolveOutlet'));

router.get("/", authorizeAnyReader, availabilityController.list);
// The dishes there are to mark, for whoever may mark them: the kitchen's
// sold-out switch searches this, as a cook does not hold menu.view.
router.get("/dishes", authorize("menu.availability"), availabilityController.dishes);
router.patch("/", authorize("menu.availability"), availabilityController.setSoldOut);

module.exports = router;
