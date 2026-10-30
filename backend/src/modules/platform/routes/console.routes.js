// The platform console's operations, mounted inside the platform router
// (platform.routes.js), which lets in only the platform's own super admin:
// the company's settings and the price list, a business's plan and its time,
// payments to confirm and the invoice register. Each service call checks the
// caller again: a restaurant's user is refused whatever role they hold.
const express = require("express");
const consoleService = require("../services/console.service");

const router = express.Router();

const send = (res, data, status = 200) => res.status(status).json({ success: true, data });
const bodyOf = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});

// The company's details, the trial and grace days, and where owners pay.
router.get("/settings", async (req, res) => send(res, await consoleService.getSettings(req.user)));
router.put("/settings", async (req, res) => send(res, await consoleService.saveSettings(req.user, bodyOf(req))));

// The price list: each type's plans and every module's price.
router.get("/prices", async (req, res) => send(res, await consoleService.getPrices(req.user)));
router.put("/prices", async (req, res) => send(res, await consoleService.savePrices(req.user, bodyOf(req))));

// One business: its page, and what the platform does to its plan.
router.get("/businesses/:id", async (req, res) => send(res, await consoleService.getBusiness(req.user, req.params.id)));
router.put("/businesses/:id/selection", async (req, res) => send(res, await consoleService.setSelection(req.user, req.params.id, bodyOf(req))));
router.post("/businesses/:id/given-time", async (req, res) => send(res, await consoleService.giveTime(req.user, req.params.id, bodyOf(req)), 201));
router.post("/businesses/:id/given-addons", async (req, res) => send(res, await consoleService.giveAddons(req.user, req.params.id, bodyOf(req)), 201));
router.post("/businesses/:id/orders", async (req, res) => send(res, await consoleService.createOrder(req.user, req.params.id, bodyOf(req)), 201));
router.post("/businesses/:id/payments", async (req, res) => send(res, await consoleService.recordPayment(req.user, req.params.id, bodyOf(req)), 201));

// Payments: those being checked first, to confirm or reject.
router.get("/payments", async (req, res) => send(res, await consoleService.listPayments(req.user, req.query)));
router.post("/payments/:id/confirm", async (req, res) => send(res, await consoleService.confirmPayment(req.user, req.params.id)));
router.post("/payments/:id/reject", async (req, res) => send(res, await consoleService.rejectPayment(req.user, req.params.id, bodyOf(req))));

// The invoice register, one invoice to print, and the tax invoice for an
// order invoiced while the GSTIN was the sample one.
router.get("/invoices", async (req, res) => send(res, await consoleService.listInvoices(req.user, req.query)));
router.get("/invoices/:id", async (req, res) => send(res, await consoleService.getInvoice(req.user, req.params.id)));
router.post("/orders/:orderId/tax-invoice", async (req, res) => send(res, await consoleService.issueTaxInvoice(req.user, req.params.orderId), 201));

module.exports = router;
