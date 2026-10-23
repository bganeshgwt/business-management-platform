const express = require("express");
const expenseController = require("../controllers/expense.controller");
const authenticate = require("../../../../middlewares/authenticate");
const authorize = require("../../../../middlewares/authorize");

const router = express.Router();

router.use(authenticate);
router.use(require('../../../../middlewares/resolveOutlet'));
router.param('id',async(req,res,next,id)=>{
  try {
    if(req.outletId && !req.path.startsWith('/categories/')) {
      require('../../../../utils/validate').requiredId(id,'Expense id');
      const expense=await require('../repositories/expense.repository').findById(req.user.restaurantId,id);
      if(!expense || Number(expense.outlet_id)!==Number(req.outletId))throw new (require('../../../../utils/AppError'))(404,'Expense not found in this outlet');
    }
    next();
  }catch(error){next(error);}
});

// Categories first, so "categories" is not read as an expense id.
router.get("/categories", authorize("expenses.view"), expenseController.listCategories);
router.post("/categories", authorize("expenses.manage"), expenseController.createCategory);
router.put("/categories/:id", authorize("expenses.manage"), expenseController.updateCategory);
router.delete("/categories/:id", authorize("expenses.manage"), expenseController.removeCategory);

router.get("/", authorize("expenses.view"), expenseController.list);
// The date a new expense takes: the business day the till is trading on.
router.get("/defaults", authorize("expenses.view"), expenseController.defaults);
router.post("/", authorize("expenses.manage"), expenseController.create);
// "Approve selected": several waiting expenses at once (all or none).
router.post("/approve", authorize("expenses.manage"), expenseController.approveMany);
router.put("/:id", authorize("expenses.manage"), expenseController.update);
router.patch("/:id/status", authorize("expenses.manage"), expenseController.setStatus);
router.delete("/:id", authorize("expenses.manage"), expenseController.remove);

// The paper bill behind an expense: photos or PDFs, at most five,
// served only through here to people who may see expenses.
const attachments = require("../controllers/attachment.controller").expense;
const { uploadOne } = require("../services/attachment.service");
router.get("/:id/attachments", authorize("expenses.view"), attachments.list);
router.post("/:id/attachments", authorize("expenses.manage"), uploadOne, attachments.add);
router.get("/:id/attachments/:attachmentId", authorize("expenses.view"), attachments.download);
router.delete("/:id/attachments/:attachmentId", authorize("expenses.manage"), attachments.remove);

module.exports = router;
