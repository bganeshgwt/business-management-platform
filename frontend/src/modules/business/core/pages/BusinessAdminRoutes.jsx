import { lazy, Suspense } from "react";
import { Link, Navigate, Route, Routes, useParams } from "react-router-dom";
import useBusiness from "../../../../hooks/useBusiness";
import PageHeader from "../../../../components/PageHeader";
import SectionCard from "../../../../components/SectionCard";
import { ScreenLoading } from "../../../../components/Feedback";
import { sectionRule, typeAllows } from "../../../../services/businessNav";

const OverviewPage = lazy(() => import("./OverviewPage"));
const DocumentsPage = lazy(() => import("./DocumentsPage"));
const ContactsPage = lazy(() => import("./ContactsPage"));
const CatalogPage = lazy(() => import("./CatalogPage"));
const CategoriesPage = lazy(() => import("./CategoriesPage"));
const UnitsPage = lazy(() => import("./UnitsPage"));
const PricingPage = lazy(() => import("./PricingPage"));
const StockPage = lazy(() => import("./StockPage"));
const MovementsPage = lazy(() => import("./MovementsPage"));
const TransfersPage = lazy(() => import("./TransfersPage"));
const CountsPage = lazy(() => import("./CountsPage"));
const CountSheetPage = lazy(() => import("./CountSheetPage"));
const AppointmentsPage = lazy(() => import("./AppointmentsPage"));
const ResourcesPage = lazy(() => import("./ResourcesPage"));
const ReportsPage = lazy(() => import("./ReportsPage"));
const DayClosePage = lazy(() => import("./DayClosePage"));
const ActivityPage = lazy(() => import("./ActivityPage"));
const SettingsPage = lazy(() => import("./SettingsPage"));
const TaxRatesPage = lazy(() => import("./TaxRatesPage"));
const PaymentMethodsPage = lazy(() => import("./PaymentMethodsPage"));
const NumberSeriesPage = lazy(() => import("./NumberSeriesPage"));
const LocationsPage = lazy(() => import("./LocationsPage"));
const StaffAccessPage = lazy(() => import("./StaffAccessPage"));
const RolesPage = lazy(() => import("./RolesPage"));
const CounterPage = lazy(() => import("../../retail/pages/CounterPage"));
const UdhaarPage = lazy(() => import("../../retail/pages/UdhaarPage"));
const OffersPage = lazy(() => import("../../retail/pages/OffersPage"));
const LoyaltyPage = lazy(() => import("../../retail/pages/LoyaltyPage"));
const BooksPage = lazy(() => import("../../retail/pages/BooksPage"));
const LabelsPage = lazy(() => import("../../retail/pages/LabelsPage"));
const RetailReportsPage = lazy(() => import("../../retail/pages/RetailReportsPage"));
// Pro pass C: batches near expiry; booklists and customer orders for bookshops.
const NearExpiryPage = lazy(() => import("../../retail/pages/NearExpiryPage"));
const BookOrdersPage = lazy(() => import("../../retail/pages/BookOrdersPage"));
// Phase 2, T2: wholesale and the shared receivables.
const SalesOrdersPage = lazy(() => import("../../wholesale/pages/SalesOrdersPage"));
const BackOrdersPage = lazy(() => import("../../wholesale/pages/BackOrdersPage"));
const RoutesPage = lazy(() => import("../../wholesale/pages/RoutesPage"));
const WholesaleReportsPage = lazy(() => import("../../wholesale/pages/WholesaleReportsPage"));
const DispatchPage = lazy(() => import("../../wholesale/pages/DispatchPage"));
const PriceGroupsPage = lazy(() => import("../../wholesale/pages/PriceGroupsPage"));
const ClaimsPage = lazy(() => import("../../wholesale/pages/ClaimsPage"));
const PurchaseOrdersPage = lazy(() => import("../../wholesale/pages/PurchaseOrdersPage"));
const OutstandingPage = lazy(() => import("../../receivables/pages/OutstandingPage"));
const CollectionsPage = lazy(() => import("../../receivables/pages/CollectionsPage"));
// Phase 2, T3: fashion and electronics.
const VariantsPage = lazy(() => import("../../fashion/pages/VariantsPage"));
const VariantMatrixPage = lazy(() => import("../../fashion/pages/VariantMatrixPage"));
const VariantReportsPage = lazy(() => import("../../fashion/pages/VariantReportsPage"));
const ExchangesPage = lazy(() => import("../../fashion/pages/ExchangesPage"));
const SerialsPage = lazy(() => import("../../electronics/pages/SerialsPage"));
const WarrantiesPage = lazy(() => import("../../electronics/pages/WarrantiesPage"));
const RepairsPage = lazy(() => import("../../electronics/pages/RepairsPage"));
const RepairJobPage = lazy(() => import("../../electronics/pages/RepairJobPage"));
// Round 2 (R2-CORE): kits / bundles and EMI & financiers.
const KitsPage = lazy(() => import("./KitsPage"));
const FinancePage = lazy(() => import("../../electronics/pages/FinancePage"));
// Phase 2, T4: salon & spa and weight-based shops.
const SalonCalendarPage = lazy(() => import("../../salon/pages/SalonCalendarPage"));
const SalonBillPage = lazy(() => import("../../salon/pages/SalonBillPage"));
const PackagesPage = lazy(() => import("../../salon/pages/PackagesPage"));
const SalonSetupPage = lazy(() => import("../../salon/pages/SalonSetupPage"));
const CommissionsPage = lazy(() => import("../../salon/pages/CommissionsPage"));
const ProcessingPage = lazy(() => import("../../weight/pages/ProcessingPage"));
const WastagePage = lazy(() => import("../../weight/pages/WastagePage"));
const WeightStockPage = lazy(() => import("../../weight/pages/WeightStockPage"));
const WeightReportsPage = lazy(() => import("../../weight/pages/WeightReportsPage"));
const SalonReportsPage = lazy(() => import("../../salon/pages/SalonReportsPage"));
// Pro pass F: salon history with deposits and bills; weight shops' rates and pickup orders.
const SalonAppointmentsPage = lazy(() => import("../../salon/pages/SalonAppointmentsPage"));
const RatesPage = lazy(() => import("../../weight/pages/RatesPage"));
const PickupOrdersPage = lazy(() => import("../../weight/pages/PickupOrdersPage"));
// Round 2: pharmacy (drug master, prescription sale, registers, expiry and recalls), clinic and lab.
const PharmacyCounterPage = lazy(() => import("../../health/pages/PharmacyCounterPage"));
const DrugMasterPage = lazy(() => import("../../health/pages/DrugMasterPage"));
const PharmacyRegistersPage = lazy(() => import("../../health/pages/PharmacyRegistersPage"));
const PharmacyBatchesPage = lazy(() => import("../../health/pages/PharmacyBatchesPage"));
const HealthSettingsPage = lazy(() => import("../../health/pages/HealthSettingsPage"));
const ClinicTodayPage = lazy(() => import("../../health/pages/ClinicTodayPage"));
const PatientsPage = lazy(() => import("../../health/pages/PatientsPage"));
const PatientPage = lazy(() => import("../../health/pages/PatientPage"));
const VisitsPage = lazy(() => import("../../health/pages/VisitsPage"));
const VisitPage = lazy(() => import("../../health/pages/VisitPage"));
const LabOrdersPage = lazy(() => import("../../health/pages/LabOrdersPage"));
const LabOrderPage = lazy(() => import("../../health/pages/LabOrderPage"));
const LabTestsPage = lazy(() => import("../../health/pages/LabTestsPage"));
// Tasks, issues & projects (modules/tasks), the same screens as the restaurant's.
const TasksRoutes = lazy(() => import("../../../tasks/pages/TasksRoutes"));

function Notice({ title, children }) {
  return (
    <div className="stack">
      <PageHeader icon="lock" eyebrow="Business Admin" title={title} />
      <SectionCard>{children}</SectionCard>
    </div>
  );
}

// A screen this person's role or this business's modules do not include.
// The server refuses the data anyway; this says why in words.
function Guard({ section, children }) {
  const { can, has, context } = useBusiness();
  const type = context?.business.business_type;
  const rule = sectionRule(section, type);
  // Screens of another business type (a salon's /counter, a kirana's /salon-bill).
  if (rule && !typeAllows(rule, type)) {
    return (
      <Notice title="Not available for this business type">
        <p>This screen belongs to a different kind of business. Use the menu on the left to find the screens this business has.</p>
      </Notice>
    );
  }
  if (rule && ((rule.need && !can(rule.need)) || (rule.module && !has(rule.module)))) {
    const moduleCode = rule.need?.split(".")[0];
    return (
      <Notice title="Not available here">
        <p>{moduleCode && !has(moduleCode) ? "This business does not use this module. An owner can switch it on under Business settings › Modules." : "Your role in this business does not include this screen. Ask the owner if you need it."}</p>
      </Notice>
    );
  }
  return children;
}

const page = (section, element) => <Guard section={section}>{element}</Guard>;

// /business-admin/<id>/… : one business's admin, inside the main layout.
export default function BusinessAdminRoutes() {
  const { businessId } = useParams();
  const { context, error, restaurantBusiness } = useBusiness();

  if (error) {
    return (
      <Notice title={error.status === 404 ? "Business not found" : "This business could not be opened"}>
        <p>{error.status === 404 ? "There is no business here that you are a member of. Pick one from the switcher at the top." : error.message}</p>
        <Link className="button button-secondary" to="/business-admin?all=1">See your businesses</Link>
      </Notice>
    );
  }
  if (!context || String(context.business.id) !== String(businessId)) {
    return <ScreenLoading label="Opening the business…" />;
  }
  // A restaurant's own admin is the restaurant screens.
  if (context.business.business_type === "restaurant") {
    if (restaurantBusiness && restaurantBusiness.id === context.business.id) {
      return <Navigate to="/" replace />;
    }
    return (
      <Notice title={context.business.name}>
        <p>This restaurant's admin opens when you sign in to the restaurant itself. Sign out and sign in with that restaurant's code to manage it.</p>
      </Notice>
    );
  }

  return (
    <Suspense fallback={<ScreenLoading />}>
      <Routes key={context.business.id}>
        <Route index element={<OverviewPage />} />
        <Route path="sales" element={page("sales", <DocumentsPage kind="sale" />)} />
        <Route path="day-close" element={page("day-close", <DayClosePage />)} />
        <Route path="purchases" element={page("purchases", <DocumentsPage kind="purchase" />)} />
        <Route path="customers" element={page("customers", <ContactsPage kind="customer" />)} />
        <Route path="suppliers" element={page("suppliers", <ContactsPage kind="supplier" />)} />
        <Route path="appointments" element={page("appointments", context.business.business_type === "salon" ? <SalonAppointmentsPage /> : <AppointmentsPage />)} />
        {/* A salon keeps its stylists and rooms on one screen (Stylists & services). */}
        <Route path="resources" element={context.business.business_type === "salon"
          ? <Navigate to={`/business-admin/${context.business.id}/salon-setup?tab=staff`} replace /> : page("resources", <ResourcesPage />)} />
        <Route path="pricing" element={page("pricing", <PricingPage />)} />
        <Route path="sales-orders" element={page("sales-orders", <SalesOrdersPage />)} />
        <Route path="back-orders" element={page("back-orders", <BackOrdersPage />)} />
        <Route path="routes" element={page("routes", <RoutesPage />)} />
        <Route path="wholesale-reports" element={page("wholesale-reports", <WholesaleReportsPage />)} />
        <Route path="dispatch" element={page("dispatch", <DispatchPage />)} />
        <Route path="price-groups" element={page("price-groups", <PriceGroupsPage />)} />
        <Route path="claims" element={page("claims", <ClaimsPage />)} />
        <Route path="purchase-orders" element={page("purchase-orders", <PurchaseOrdersPage />)} />
        <Route path="outstanding" element={page("outstanding", <OutstandingPage />)} />
        <Route path="collections" element={page("collections", <CollectionsPage />)} />
        <Route path="products" element={page("products", <CatalogPage />)} />
        <Route path="categories" element={page("categories", <CategoriesPage />)} />
        <Route path="units" element={page("units", <UnitsPage />)} />
        <Route path="kits" element={page("kits", <KitsPage />)} />
        <Route path="emi-finance" element={page("emi-finance", <FinancePage />)} />
        <Route path="stock" element={page("stock", <StockPage />)} />
        <Route path="movements" element={page("movements", <MovementsPage />)} />
        <Route path="transfers" element={page("transfers", <TransfersPage />)} />
        <Route path="counts" element={page("counts", <CountsPage />)} />
        <Route path="counts/:countId" element={page("counts", <CountSheetPage />)} />
        <Route path="reports" element={page("reports", <ReportsPage />)} />
        <Route path="activity" element={page("activity", <ActivityPage />)} />
        <Route path="settings" element={page("settings", <SettingsPage />)} />
        <Route path="tax-rates" element={page("tax-rates", <TaxRatesPage />)} />
        <Route path="payment-methods" element={page("payment-methods", <PaymentMethodsPage />)} />
        <Route path="number-series" element={page("number-series", <NumberSeriesPage />)} />
        <Route path="locations" element={page("locations", <LocationsPage />)} />
        <Route path="staff" element={page("staff", <StaffAccessPage />)} />
        <Route path="roles" element={page("roles", <RolesPage />)} />
        <Route path="counter" element={page("counter", <CounterPage />)} />
        <Route path="udhaar" element={page("udhaar", <UdhaarPage />)} />
        <Route path="offers" element={page("offers", <OffersPage />)} />
        <Route path="loyalty" element={page("loyalty", <LoyaltyPage />)} />
        <Route path="books" element={page("books", <BooksPage />)} />
        <Route path="labels" element={page("labels", <LabelsPage />)} />
        <Route path="retail-reports" element={page("retail-reports", <RetailReportsPage />)} />
        <Route path="near-expiry" element={page("near-expiry", <NearExpiryPage />)} />
        <Route path="book-orders" element={page("book-orders", <BookOrdersPage />)} />
        <Route path="variants" element={page("variants", <VariantsPage />)} />
        <Route path="variants/:productId" element={page("variants", <VariantMatrixPage />)} />
        <Route path="variant-reports" element={page("variant-reports", <VariantReportsPage />)} />
        <Route path="exchanges" element={page("exchanges", <ExchangesPage />)} />
        <Route path="serials" element={page("serials", <SerialsPage />)} />
        <Route path="warranties" element={page("warranties", <WarrantiesPage />)} />
        <Route path="repairs" element={page("repairs", <RepairsPage />)} />
        <Route path="repairs/:jobId" element={page("repairs", <RepairJobPage />)} />
        <Route path="salon-calendar" element={page("salon-calendar", <SalonCalendarPage />)} />
        <Route path="salon-bill" element={page("salon-bill", <SalonBillPage />)} />
        <Route path="packages" element={page("packages", <PackagesPage />)} />
        <Route path="salon-setup" element={page("salon-setup", <SalonSetupPage />)} />
        <Route path="commissions" element={page("commissions", <CommissionsPage />)} />
        <Route path="processing" element={page("processing", <ProcessingPage />)} />
        <Route path="wastage" element={page("wastage", <WastagePage />)} />
        <Route path="weight-stock" element={page("weight-stock", <WeightStockPage />)} />
        <Route path="weight-reports" element={page("weight-reports", <WeightReportsPage />)} />
        <Route path="salon-reports" element={page("salon-reports", <SalonReportsPage />)} />
        <Route path="rates" element={page("rates", <RatesPage />)} />
        <Route path="pickup-orders" element={page("pickup-orders", <PickupOrdersPage />)} />
        <Route path="rx-sale" element={page("rx-sale", <PharmacyCounterPage />)} />
        <Route path="drug-master" element={page("drug-master", <DrugMasterPage />)} />
        <Route path="pharmacy-registers" element={page("pharmacy-registers", <PharmacyRegistersPage />)} />
        <Route path="pharmacy-batches" element={page("pharmacy-batches", <PharmacyBatchesPage />)} />
        <Route path="health-settings" element={page("health-settings", <HealthSettingsPage />)} />
        <Route path="clinic-today" element={page("clinic-today", <ClinicTodayPage />)} />
        <Route path="patients" element={page("patients", <PatientsPage />)} />
        <Route path="patients/:contactId" element={page("patients", <PatientPage />)} />
        <Route path="visits" element={page("visits", <VisitsPage />)} />
        <Route path="visits/:visitId" element={page("visits", <VisitPage />)} />
        <Route path="lab-orders" element={page("lab-orders", <LabOrdersPage />)} />
        <Route path="lab-orders/:orderId" element={page("lab-orders", <LabOrderPage />)} />
        <Route path="lab-tests" element={page("lab-tests", <LabTestsPage />)} />
        <Route path="tasks/*" element={page("tasks", <TasksRoutes />)} />
        <Route path="*" element={<Notice title="Page not found"><p>Use the menu on the left to find the screen you need.</p></Notice>} />
      </Routes>
    </Suspense>
  );
}
