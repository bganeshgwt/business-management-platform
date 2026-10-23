import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import useAuth from "./hooks/useAuth";
import ProtectedRoute from "./routes/ProtectedRoute";
import AppLayout from "./layouts/AppLayout";
import { ScreenLoading } from "./components/Feedback";
import useBusiness from "./hooks/useBusiness";
import { businessPath, isRestaurantStaff, landingBusiness } from "./services/businessNav";
const LoginPage = lazy(() => import("./modules/access/pages/LoginPage"));
const BusinessAdminPage = lazy(() => import("./modules/business/core/pages/BusinessAdminPage"));
const BusinessAdminRoutes = lazy(() => import("./modules/business/core/pages/BusinessAdminRoutes"));
const DashboardPage = lazy(() => import("./modules/restaurant/dashboard/pages/DashboardPage"));
const ProfilePage = lazy(() => import("./modules/access/pages/ProfilePage"));
const NotFoundPage = lazy(() => import("./layouts/NotFoundPage"));
const RestaurantProfilePage = lazy(() => import("./modules/restaurant/setup/pages/RestaurantProfilePage"));
const OutletsPage = lazy(() => import("./modules/restaurant/setup/pages/OutletsPage"));
const BusinessHoursPage = lazy(() => import("./modules/restaurant/setup/pages/BusinessHoursPage"));
const RestaurantSettingsPage = lazy(() => import("./modules/restaurant/setup/pages/RestaurantSettingsPage"));
const UsersPage = lazy(() => import("./modules/access/pages/UsersPage"));
const RolesPage = lazy(() => import("./modules/access/pages/RolesPage"));
const CategoriesPage = lazy(() => import("./modules/restaurant/menu/pages/CategoriesPage"));
const ProductsPage = lazy(() => import("./modules/restaurant/menu/pages/ProductsPage"));
const ModifiersPage = lazy(() => import("./modules/restaurant/menu/pages/ModifiersPage"));
const TaxRatesPage = lazy(() => import("./modules/restaurant/menu/pages/TaxRatesPage"));
const PriceWindowsPage = lazy(() => import("./modules/restaurant/menu/pages/PriceWindowsPage"));
const FloorsPage = lazy(() => import("./modules/restaurant/tables/pages/FloorsPage"));
const TablesPage = lazy(() => import("./modules/restaurant/tables/pages/TablesPage"));
const DiscountsPage = lazy(() => import("./modules/restaurant/billing/pages/DiscountsPage"));
const BusinessDayPage = lazy(() => import("./modules/restaurant/business-day/pages/BusinessDayPage"));
const ExpensesPage = lazy(() => import("./modules/restaurant/expenses/pages/ExpensesPage"));
const InventoryItemsPage = lazy(() => import("./modules/restaurant/inventory/pages/InventoryItemsPage"));
const StockLedgerPage = lazy(() => import("./modules/restaurant/inventory/pages/StockLedgerPage"));
const SuppliersPage = lazy(() => import("./modules/restaurant/purchasing/pages/SuppliersPage"));
const PurchaseOrdersPage = lazy(() => import("./modules/restaurant/purchasing/pages/PurchaseOrdersPage"));
const ReturnsPage = lazy(() => import("./modules/restaurant/purchasing/pages/ReturnsPage"));
const CustomersPage = lazy(() => import("./modules/restaurant/crm/pages/CustomersPage"));
const FeedbackPage = lazy(() => import("./modules/restaurant/crm/pages/FeedbackPage"));
const ComplaintsPage = lazy(() => import("./modules/restaurant/crm/pages/ComplaintsPage"));
const PosPage = lazy(() => import("./modules/restaurant/orders/pages/PosPage"));
const OrdersPage = lazy(() => import("./modules/restaurant/orders/pages/OrdersPage"));
const BillsPage = lazy(() => import("./modules/restaurant/orders/pages/BillsPage"));
const DuesPage = lazy(() => import("./modules/restaurant/billing/pages/DuesPage"));
const ReportsPage = lazy(() => import("./modules/restaurant/reports/pages/ReportsPage"));
const AuditLogPage = lazy(() => import("./modules/restaurant/reports/pages/AuditLogPage"));
const EmployeesPage = lazy(() => import("./modules/restaurant/staff/pages/EmployeesPage"));
const ShiftsPage = lazy(() => import("./modules/restaurant/staff/pages/ShiftsPage"));
const AttendancePage = lazy(() => import("./modules/restaurant/staff/pages/AttendancePage"));
const PayrollPage = lazy(() => import("./modules/restaurant/staff/pages/PayrollPage"));
// The guest pages are the guest site's (apps/customer-web); old links to them land here.
const GuestSiteRedirect = lazy(() => import("./layouts/GuestSiteRedirect"));
const KitchenDisplayPage = lazy(() => import("./modules/restaurant/kitchen/pages/KitchenDisplayPage"));
const ReservationsPage = lazy(() => import("./modules/restaurant/reservations/pages/ReservationsPage"));
const TableRequestsPage = lazy(() => import("./modules/restaurant/orders/pages/TableRequestsPage"));
const DeliveriesPage = lazy(() => import("./modules/restaurant/deliveries/pages/DeliveriesPage"));
const TimeClockPage = lazy(() => import("./modules/restaurant/staff/pages/TimeClockPage"));
const InventoryInsightsPage = lazy(() => import("./modules/restaurant/inventory/pages/InventoryInsightsPage"));
const TransfersPage = lazy(() => import("./modules/restaurant/inventory/pages/TransfersPage"));
const StockSettingsPage = lazy(() => import("./modules/restaurant/inventory/pages/StockSettingsPage"));
const GuestInsightsPage = lazy(() => import("./modules/restaurant/crm/pages/GuestInsightsPage"));
const NotificationsPage = lazy(() => import("./modules/restaurant/notifications/pages/NotificationsPage"));
const TipsPage = lazy(() => import("./modules/restaurant/staff/pages/TipsPage"));
const MyWorkPage = lazy(() => import("./modules/restaurant/staff/pages/MyWorkPage"));
const LogbookPage = lazy(() => import("./modules/restaurant/logbook/pages/LogbookPage"));
const PlatformRestaurantsPage = lazy(() => import("./modules/platform/pages/PlatformRestaurantsPage"));
const PlatformBusinessesPage = lazy(() => import("./modules/platform/pages/PlatformBusinessesPage"));
const CollectionDisplayPage = lazy(() => import("./modules/restaurant/orders/pages/CollectionDisplayPage"));
const ServiceSettingsPage = lazy(() => import("./modules/restaurant/setup/pages/ServiceSettingsPage"));
const FeaturesPage = lazy(() => import("./modules/restaurant/setup/pages/FeaturesPage"));
// Food formats: a bakery's and café's pre-orders and the day-end unsold count.
const PreordersPage = lazy(() => import("./modules/restaurant/preorders/pages/PreordersPage"));
const DayEndUnsoldPage = lazy(() => import("./modules/restaurant/inventory/pages/DayEndUnsoldPage"));
const BrandsPage = lazy(() => import("./modules/restaurant/menu/pages/BrandsPage"));
// Tasks, issues & projects (modules/tasks): the same screens serve Business Admin.
const TasksRoutes = lazy(() => import("./modules/tasks/pages/TasksRoutes"));
// Workspaces planned but not built yet (services/plannedWorkspaces.js).
const PlannedPage = lazy(() => import("./layouts/PlannedPage"));

// The platform's own super admin has no restaurant, so no dashboard: home is
// the platform console.
function Home() {
  const { user, hasPermission } = useAuth();

  if (!user.restaurantId && hasPermission("platform.restaurants.manage")) {
    return <Navigate to="/platform/restaurants" replace />;
  }

  // Staff of a shop, wholesaler, salon… (no restaurant role): straight to the
  // business they used last, or their first one; never the restaurant dashboard.
  if (!isRestaurantStaff(user)) {
    return <BusinessLanding />;
  }

  // A TV signed in with the Collection display role has one screen.
  if (hasPermission("orders.collection") && !hasPermission("orders.view") && !hasPermission("kds.view")) {
    return <Navigate to="/collection" replace />;
  }

  return (
    <DashboardPage />
  );
}

function BusinessLanding() {
  const { directory, directoryError, businesses } = useBusiness();

  if (!directory && !directoryError) {
    return <ScreenLoading label="Opening your business…" />;
  }

  const pick = landingBusiness(businesses, false);
  return <Navigate to={pick ? businessPath(pick.id) : "/business-admin?all"} replace />;
}

export default function App() {
  return (
    <Suspense fallback={<ScreenLoading />}>
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      {/* The guests' pages (table QR ordering, online ordering, booking) are
          their own app, apps/customer-web. A QR code or link that still opens
          them here is sent on to it, path and query kept. No login. */}
      <Route path="/order/:token" element={<GuestSiteRedirect />} />
      <Route path="/online/:token/*" element={<GuestSiteRedirect />} />
      <Route path="/book/*" element={<GuestSiteRedirect />} />

      {/* Everything inside needs a logged-in user and shares the layout. */}
      {/* The pickup counter's TV: full screen, no menus. */}
      <Route element={<ProtectedRoute permission="orders.collection" />}>
        <Route path="/collection" element={<CollectionDisplayPage />} />
      </Route>

      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route index element={<Home />} />

          {/* Business Admin for every business other than the signed-in
              restaurant: the switcher in the header opens them here, and the
              business's own menu replaces the restaurant's. */}
          <Route path="business-admin" element={<BusinessAdminPage />} />
          <Route path="business-admin/:businessId/*" element={<BusinessAdminRoutes />} />

          {/* Your own name, mobile and password. This sat inside the menu block,
              which meant a cashier — who has no business editing the menu — could
              not reach the page the topbar offers them to change their password. */}
          <Route path="profile" element={<ProfilePage />} />

          {/* Every alert the bell knows about, for whoever is signed in. */}
          <Route path="notifications" element={<NotificationsPage />} />

          {/* Workspaces that are planned but not built yet: the address works
              already and says what is coming and what to use until then,
              instead of "Page not found". A built one replaces its line. */}
          <Route path="captain" element={<PlannedPage workspace="captain" />} />
          <Route path="clinic" element={<PlannedPage workspace="clinic" />} />
          <Route path="lab" element={<PlannedPage workspace="lab" />} />

          {/* Your own shifts, attendance and payslips (through your staff record). */}
          <Route element={<ProtectedRoute feature="staff_payroll" />}>
            <Route path="my-work" element={<MyWorkPage />} />
          </Route>

          <Route element={<ProtectedRoute permission="logbook.view" />}>
            <Route path="logbook" element={<LogbookPage />} />
          </Route>

          {/* Tasks, issues & projects: My tasks is everyone's; each screen checks its own permission. */}
          <Route element={<ProtectedRoute feature="tasks" />}>
            <Route path="tasks/*" element={<TasksRoutes />} />
          </Route>

          <Route element={<ProtectedRoute permission="staff.salaries" feature={["tips", "staff_payroll"]} />}>
            <Route path="staff/tips" element={<TipsPage />} />
          </Route>

          <Route element={<ProtectedRoute permission="platform.restaurants.manage" />}>
            <Route path="platform/restaurants" element={<PlatformRestaurantsPage />} />
            <Route path="platform/businesses" element={<PlatformBusinessesPage />} />
          </Route>

          {/* Each area also requires its own permission, checked again by the API. */}
          <Route element={<ProtectedRoute permission="restaurant.settings.view" />}>
            <Route path="restaurant/profile" element={<RestaurantProfilePage />} />
            <Route path="restaurant/hours" element={<BusinessHoursPage />} />
            <Route path="restaurant/settings" element={<RestaurantSettingsPage />} />
            {/* Settings -> Features: which parts of the restaurant are switched on. */}
            <Route path="restaurant/features" element={<FeaturesPage />} />
          </Route>

          <Route element={<ProtectedRoute permission="outlets.view" />}>
            <Route path="restaurant/outlets" element={<OutletsPage />} />
          </Route>

          <Route element={<ProtectedRoute permission="users.view" />}>
            <Route path="users" element={<UsersPage />} />
          </Route>

          <Route element={<ProtectedRoute permission="roles.view" />}>
            <Route path="roles" element={<RolesPage />} />
          </Route>

          <Route element={<ProtectedRoute permission="orders.create" />}>
            <Route path="pos" element={<PosPage />} />
          </Route>

          <Route element={<ProtectedRoute permission="orders.view" />}>
            <Route path="orders" element={<OrdersPage />} />
            <Route path="bills" element={<BillsPage />} />
            {/* Each feature page says so when its feature is switched off
                (Settings -> Features); the API refuses it too. */}
            <Route element={<ProtectedRoute featureAny={["qr_ordering", "online_ordering"]} />}>
              <Route path="table-requests" element={<TableRequestsPage />} />
            </Route>
            <Route element={<ProtectedRoute feature="deliveries" />}>
              <Route path="deliveries" element={<DeliveriesPage />} />
            </Route>
            <Route element={<ProtectedRoute feature="brands" />}>
              <Route path="menu/brands" element={<BrandsPage />} />
            </Route>
          </Route>

          <Route element={<ProtectedRoute permission="sales.view" />}>
            <Route path="dues" element={<DuesPage />} />
          </Route>

          <Route element={<ProtectedRoute permission="kds.view" feature="kitchen_display" />}>
            <Route path="kitchen" element={<KitchenDisplayPage />} />
          </Route>

          {/* Pre-orders: the counter's (orders.view), and the kitchen's
              bake list (kds.view), as its menu link and the API allow. */}
          <Route element={<ProtectedRoute permissionAny={["orders.view", "kds.view"]} feature="preorders" />}>
            <Route path="preorders" element={<PreordersPage />} />
          </Route>

          {/* The same rule as its menu link: service settings are for people
              who run the service (orders.manage). */}
          <Route element={<ProtectedRoute permission="orders.manage" />}>
            <Route path="service/settings" element={<ServiceSettingsPage />} />
          </Route>

          <Route element={<ProtectedRoute permission="reservations.view" feature="reservations" />}>
            <Route path="reservations" element={<ReservationsPage />} />
          </Route>

          <Route element={<ProtectedRoute permission="staff.clock" feature="staff_payroll" />}>
            <Route path="staff/timeclock" element={<TimeClockPage />} />
          </Route>

          <Route element={<ProtectedRoute permission="staff.view" feature="staff_payroll" />}>
            <Route path="staff" element={<EmployeesPage />} />
            <Route path="staff/shifts" element={<ShiftsPage />} />
            <Route path="staff/attendance" element={<AttendancePage />} />
          </Route>

          {/* Payroll is salaries: staff.manage and staff.salaries, as its
              menu link and every payroll API ask. */}
          <Route element={<ProtectedRoute permission={["staff.manage", "staff.salaries"]} feature="staff_payroll" />}>
            <Route path="staff/payroll" element={<PayrollPage />} />
          </Route>

          <Route element={<ProtectedRoute permission="reports.view" />}>
            <Route path="reports" element={<ReportsPage />} />
          </Route>

          {/* Reading the log is its own permission (audit.view), as its menu
              link and the activity-log API ask. */}
          <Route element={<ProtectedRoute permission="audit.view" />}>
            <Route path="activity-log" element={<AuditLogPage />} />
          </Route>

          <Route element={<ProtectedRoute permission="menu.view" />}>
            <Route path="menu/categories" element={<CategoriesPage />} />
            <Route path="menu/products" element={<ProductsPage />} />
            <Route path="menu/modifiers" element={<ModifiersPage />} />
            <Route path="menu/tax-rates" element={<TaxRatesPage />} />
            <Route path="menu/happy-hour" element={<PriceWindowsPage />} />
          </Route>

          <Route element={<ProtectedRoute permission="tables.view" />}>
            <Route path="tables/floors" element={<FloorsPage />} />
            <Route path="tables" element={<TablesPage />} />
          </Route>

          <Route element={<ProtectedRoute permission="inventory.view" feature="stock_recipes" />}>
            <Route path="inventory/items" element={<InventoryItemsPage />} />
            <Route path="inventory/stock" element={<StockLedgerPage />} />
            <Route path="inventory/insights" element={<InventoryInsightsPage />} />
            <Route path="inventory/day-end" element={<DayEndUnsoldPage />} />
            <Route path="inventory/transfers" element={<TransfersPage />} />
            <Route path="inventory/settings" element={<StockSettingsPage />} />
          </Route>

          <Route element={<ProtectedRoute permission="suppliers.view" feature="stock_recipes" />}>
            <Route path="purchasing/suppliers" element={<SuppliersPage />} />
          </Route>

          <Route element={<ProtectedRoute permission="purchasing.view" feature="stock_recipes" />}>
            <Route path="purchasing/orders" element={<PurchaseOrdersPage />} />
            <Route path="purchasing/accounts" element={<ReturnsPage />} />
          </Route>

          <Route element={<ProtectedRoute permission="customers.view" feature="guests" />}>
            <Route path="crm/customers" element={<CustomersPage />} />
            <Route path="crm/insights" element={<GuestInsightsPage />} />
          </Route>

          <Route element={<ProtectedRoute permission="feedback.view" feature="guests" />}>
            <Route path="crm/feedback" element={<FeedbackPage />} />
            <Route path="crm/complaints" element={<ComplaintsPage />} />
          </Route>

          <Route element={<ProtectedRoute permission="discounts.view" />}>
            <Route path="discounts" element={<DiscountsPage />} />
          </Route>

          <Route element={<ProtectedRoute permission="business_day.view" />}>
            <Route path="business-day" element={<BusinessDayPage />} />
          </Route>

          <Route element={<ProtectedRoute permission="expenses.view" />}>
            <Route path="expenses" element={<ExpensesPage />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
    </Suspense>
  );
}
