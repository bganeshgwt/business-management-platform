const express = require("express");

const healthRoutes = require("../modules/health/routes/health.routes");
const authRoutes = require("../modules/access/routes/auth.routes");
const restaurantRoutes = require("../modules/restaurant/setup/routes/restaurant.routes");
const outletRoutes = require("../modules/restaurant/setup/routes/outlet.routes");
const userRoutes = require("../modules/access/routes/user.routes");
const roleRoutes = require("../modules/access/routes/role.routes");
const menuRoutes = require("../modules/restaurant/menu/routes/menu.routes");
const tableRoutes = require("../modules/restaurant/tables/routes/table.routes");
const discountRoutes = require("../modules/restaurant/billing/routes/discount.routes");
const businessDayRoutes = require("../modules/restaurant/business-day/routes/businessDay.routes");
const supplierRoutes = require("../modules/restaurant/purchasing/routes/supplier.routes");
const inventoryRoutes = require("../modules/restaurant/inventory/routes/inventory.routes");
const purchaseRoutes = require("../modules/restaurant/purchasing/routes/purchase.routes");
const crmRoutes = require("../modules/restaurant/crm/routes/crm.routes");
const expenseRoutes = require("../modules/restaurant/expenses/routes/expense.routes");
const orderRoutes = require("../modules/restaurant/orders/routes/order.routes");
const billRoutes = require("../modules/restaurant/billing/routes/bill.routes");
const reportRoutes = require("../modules/restaurant/reports/routes/report.routes");
const staffRoutes = require("../modules/restaurant/staff/routes/staff.routes");
const purchaseReturnRoutes = require("../modules/restaurant/purchasing/routes/purchaseReturn.routes");
const kitchenRoutes = require("../modules/restaurant/kitchen/routes/kitchen.routes");
const reservationRoutes = require("../modules/restaurant/reservations/routes/reservation.routes");
const tableRequestRoutes = require("../modules/restaurant/orders/routes/tableRequest.routes");
const publicRoutes = require("../modules/restaurant/orders/routes/public.routes");
const notificationRoutes = require("../modules/restaurant/notifications/routes/notification.routes");
const deliveryRoutes = require("../modules/restaurant/deliveries/routes/delivery.routes");
const timeclockRoutes = require("../modules/restaurant/staff/routes/timeclock.routes");
const inventoryInsightRoutes = require("../modules/restaurant/inventory/routes/inventoryInsight.routes");
const guestInsightRoutes = require("../modules/restaurant/crm/routes/guestInsight.routes");
const availabilityRoutes = require("../modules/restaurant/menu/routes/availability.routes");

const router = express.Router();

router.use("/", healthRoutes);
router.use("/auth", authRoutes);
// Tasks, issues & projects: /tasks (restaurant) and /businesses/:id/tasks (before the /businesses router).
router.use(require("../modules/tasks/routes/tasks.routes"));
// Prescription scans (multipart) for pharmacies, before the JSON-only /businesses router.
router.use(require("../modules/business/health/routes/healthUploads.routes"));
// Live updates: a screen's stream for its restaurant (/live) or a business (/businesses/:id/live), before the /businesses router.
router.use(require("../modules/live/routes/live.routes"));
router.use("/businesses", require("../modules/business/core/routes/business.routes"));
router.use("/restaurants", restaurantRoutes);
router.use("/outlets", outletRoutes);
router.use("/users", userRoutes);
router.use("/roles", roleRoutes);
router.use("/menu", menuRoutes);
router.use("/tables", tableRoutes);
router.use("/discounts", discountRoutes);
router.use("/business-day", businessDayRoutes);
router.use("/suppliers", supplierRoutes);
router.use("/inventory", inventoryRoutes);
router.use("/purchase-orders", purchaseRoutes);
// A guest's saved delivery addresses, before the guest book's own routes.
router.use("/crm/customers/:customerId/addresses", require("../modules/restaurant/online/routes/guestAddress.routes"));
router.use("/crm", crmRoutes);
router.use("/expenses", expenseRoutes);
router.use("/orders", orderRoutes);
router.use("/bills", billRoutes);
router.use("/reports", reportRoutes);
router.use("/staff", staffRoutes);
router.use("/purchase-returns", purchaseReturnRoutes);
router.use("/kitchen", kitchenRoutes);
router.use("/reservations", reservationRoutes);
router.use("/table-requests", tableRequestRoutes);
router.use("/notifications", notificationRoutes);
router.use("/deliveries", deliveryRoutes);
router.use("/timeclock", timeclockRoutes);
router.use("/inventory-insights", inventoryInsightRoutes);
router.use("/guest-insights", guestInsightRoutes);
router.use("/availability", availabilityRoutes);
// Pre-orders: cakes and party orders for a later day (food formats).
router.use("/preorders", require("../modules/restaurant/preorders/routes/preorder.routes"));
// Personal data for the signed-in restaurant's guests (the module serves businesses under /businesses too).
router.use("/privacy", require("../modules/personal-data/routes/personalData.routes").restaurantRouter);

// The one mount with no login in front of it: a guest at a table, holding a
// QR code. Everything behind it is scoped by that code and rate limited.
router.use("/public", publicRoutes);

module.exports = router;
