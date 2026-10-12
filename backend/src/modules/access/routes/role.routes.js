const express = require("express");
const roleController = require("../controllers/role.controller");
const authenticate = require("../../../middlewares/authenticate");
const authorize = require("../../../middlewares/authorize");

const router = express.Router();

router.use(authenticate);

// "permissions" is listed before "/:id" so it is not mistaken for a role id.
router.get("/permissions", authorize("roles.view"), roleController.listPermissions);

router.get("/", authorize("roles.view"), roleController.list);
router.get("/:id", authorize("roles.view"), roleController.getById);
router.post("/", authorize("roles.manage"), roleController.create);
// Built-in roles cannot be changed; copying one makes this restaurant's own.
router.post("/:id/copy", authorize("roles.manage"), roleController.copy);
router.put("/:id", authorize("roles.manage"), roleController.update);
router.delete("/:id", authorize("roles.manage"), roleController.remove);

module.exports = router;
