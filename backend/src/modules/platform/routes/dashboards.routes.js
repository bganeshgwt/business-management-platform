// The platform console's dashboards, mounted inside the platform router
// (platform.routes.js), which lets in only the platform's own super admin:
// the overview, the trial funnel and the leads, and the sales, renewals and
// dues reports.
const express = require("express");
const dashboards = require("../services/dashboards.service");

const router = express.Router();
const send = (res, data, status = 200) => res.status(status).json({ success: true, data });

router.get("/overview", async (req, res) => send(res, await dashboards.overview(req.user)));

// Leads and the free-trial funnel: ?list=<number> gives the businesses (or
// enquiries) behind one number. A lead's follow-up status and its notes are
// the one thing changed here, each in the platform's audit.
router.get("/leads/funnel", async (req, res) => send(res, await dashboards.funnel(req.user, req.query)));
router.get("/leads", async (req, res) => send(res, await dashboards.leads(req.user, req.query)));
router.put("/leads/:id", async (req, res) => send(res, await dashboards.setLeadStatus(req.user, req.params.id, req.body || {})));
router.post("/leads/:id/notes", async (req, res) => send(res, await dashboards.addLeadNote(req.user, req.params.id, req.body || {}), 201));

router.get("/reports/sales", async (req, res) => send(res, await dashboards.salesReport(req.user, req.query)));
router.get("/reports/renewals", async (req, res) => send(res, await dashboards.renewalsReport(req.user, req.query)));
router.get("/reports/dues", async (req, res) => send(res, await dashboards.duesReport(req.user)));

module.exports = router;
