// A guest's saved delivery addresses, under
// /api/crm/customers/:customerId/addresses. Reading is for the guest book;
// changing one needs the full text, so it is for people who may see
// contact details (customers.contact) and edit guests (customers.manage).
const express = require("express");
const authenticate = require("../../../../middlewares/authenticate");
const authorize = require("../../../../middlewares/authorize");
const requireFeature = require("../../../../middlewares/requireFeature");
const guestAddressController = require("../controllers/guestAddress.controller");

const router = express.Router({ mergeParams: true });

router.use(authenticate);
router.use(requireFeature("guests"));

router.get("/", authorize("customers.view"), guestAddressController.list);
router.put("/:id", authorize("customers.manage"), authorize("customers.contact"), guestAddressController.update);
router.delete("/:id", authorize("customers.manage"), guestAddressController.remove);

module.exports = router;
