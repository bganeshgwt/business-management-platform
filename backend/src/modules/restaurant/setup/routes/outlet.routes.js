const express = require("express");
const outletController = require("../controllers/outlet.controller");
const authenticate = require("../../../../middlewares/authenticate");
const authorize = require("../../../../middlewares/authorize");

const router = express.Router();

router.use(authenticate);

router.get("/", authorize("outlets.view"), outletController.list);
router.get("/:id", authorize("outlets.view"), outletController.getById);
router.get("/:id/usage", authorize("outlets.manage"), outletController.usage);
router.post("/", authorize("outlets.manage"), outletController.create);
router.put("/:id", authorize("outlets.manage"), outletController.update);
router.delete("/:id", authorize("outlets.manage"), outletController.remove);

module.exports = router;
