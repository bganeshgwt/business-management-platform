import { lazy, Suspense } from "react";
import { Link, Navigate, Route, Routes, useParams, useSearchParams } from "react-router-dom";
import useBusiness from "../../../../hooks/useBusiness";
import PageHeader from "../../../../components/PageHeader";
import SectionCard from "../../../../components/SectionCard";
import { ScreenLoading } from "../../../../components/Feedback";
import SidePanel from "../../../../components/SidePanel";
import { sectionRule, typeAllows } from "../../../../services/businessNav";
import WorkspaceNav from './WorkspaceNav';
import { workspaceLabel } from "../../../../services/businessWorkspace";

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
const ExpensesPage = lazy(() => import('./ExpensesPage'));
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
// Batches near expiry; booklists and customer orders for bookshops.
const NearExpiryPage = lazy(() => import("../../retail/pages/NearExpiryPage"));
const BookOrdersPage = lazy(() => import("../../retail/pages/BookOrdersPage"));
// Wholesale and the shared receivables.
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
// Fashion and electronics.
const VariantsPage = lazy(() => import("../../fashion/pages/VariantsPage"));
const VariantMatrixPage = lazy(() => import("../../fashion/pages/VariantMatrixPage"));
const VariantReportsPage = lazy(() => import("../../fashion/pages/VariantReportsPage"));
const ExchangesPage = lazy(() => import("../../fashion/pages/ExchangesPage"));
const SerialsPage = lazy(() => import("../../electronics/pages/SerialsPage"));
const WarrantiesPage = lazy(() => import("../../electronics/pages/WarrantiesPage"));
const RepairsPage = lazy(() => import("../../electronics/pages/RepairsPage"));
const RepairJobPage = lazy(() => import("../../electronics/pages/RepairJobPage"));
// Kits / bundles and EMI & financiers.
const KitsPage = lazy(() => import("./KitsPage"));
const FinancePage = lazy(() => import("../../electronics/pages/FinancePage"));
// Salon & spa and weight-based shops.
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
// Salon history with deposits and bills; weight shops' rates and pickup orders.
const SalonAppointmentsPage = lazy(() => import("../../salon/pages/SalonAppointmentsPage"));
const RatesPage = lazy(() => import("../../weight/pages/RatesPage"));
const PickupOrdersPage = lazy(() => import("../../weight/pages/PickupOrdersPage"));
// Pharmacy (drug master, prescription sale, registers, expiry and recalls), clinic and lab.
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
// Doctors' fees and OPD, the token queue and lab quality control.
const DoctorsPage = lazy(() => import("../../health/pages/DoctorsPage"));
const TokenQueuePage = lazy(() => import("../../health/pages/TokenQueuePage"));
const LabQcPage = lazy(() => import("../../health/pages/LabQcPage"));
// Tasks, issues & projects (modules/tasks), the same screens as the restaurant's.
const TasksRoutes = lazy(() => import("../../../tasks/pages/TasksRoutes"));
// Quotations (every type but a restaurant).
const QuotationsPage = lazy(() => import("../../quotations/pages/QuotationsPage"));
// GST rate changes by date (every type but a restaurant, whose menu has its own).
const BusinessTaxChangesPage = lazy(() => import("../../../tax-changes/pages/BusinessTaxChangesPage"));
// Hardware, paints & building materials.
const SitesPage = lazy(() => import("../../hardware/pages/SitesPage"));
const FittersPage = lazy(() => import("../../hardware/pages/FittersPage"));
const FitterReportPage = lazy(() => import("../../hardware/pages/FitterReportPage"));
const HardwareRatesPage = lazy(() => import("../../hardware/pages/HardwareRatesPage"));
const TintingPage = lazy(() => import("../../hardware/pages/TintingPage"));
// Licences & registrations (every type but a restaurant).
const LicencesPage = lazy(() => import("../../licences/pages/LicencesPage"));
// Personal data: requests, breaches, the privacy notice (every type but a restaurant, which has its own).
const BusinessPrivacyPage = lazy(() => import("../../../personal-data/pages/BusinessPrivacyPage"));
// Seeds, fertilisers & pesticides.
const FarmersPage = lazy(() => import("../../agri/pages/FarmersPage"));
const SubsidyPage = lazy(() => import("../../agri/pages/SubsidyPage"));
const AgriRegistersPage = lazy(() => import("../../agri/pages/AgriRegistersPage"));
const MoleculesPage = lazy(() => import("../../agri/pages/MoleculesPage"));
const AgriSettingsPage = lazy(() => import("../../agri/pages/AgriSettingsPage"));
const SeasonCreditPage = lazy(() => import("../../agri/pages/SeasonCreditPage"));
const CropsPage = lazy(() => import("../../agri/pages/CropsPage"));
const SeedLotsPage = lazy(() => import("../../agri/pages/SeedLotsPage"));
const KeptApartPage = lazy(() => import("../../agri/pages/KeptApartPage"));
const CompanySchemesPage = lazy(() => import("../../agri/pages/CompanySchemesPage"));
// Optical shops.
const PrescriptionsPage = lazy(() => import("../../optical/pages/PrescriptionsPage"));
const PrescriptionHistoryPage = lazy(() => import("../../optical/pages/PrescriptionHistoryPage"));
const SpectacleOrdersPage = lazy(() => import("../../optical/pages/SpectacleOrdersPage"));
const SpectacleOrderPage = lazy(() => import("../../optical/pages/SpectacleOrderPage"));
const RecallPage = lazy(() => import("../../optical/pages/RecallPage"));
const ContactLensesPage = lazy(() => import("../../optical/pages/ContactLensesPage"));
const LensStockPage = lazy(() => import("../../optical/pages/LensStockPage"));
const ReferralsPage = lazy(() => import("../../optical/pages/ReferralsPage"));
// Garages.
const JobCardsPage = lazy(() => import("../../garage/pages/JobCardsPage"));
const JobCardPage = lazy(() => import("../../garage/pages/JobCardPage"));
const VehiclesPage = lazy(() => import("../../garage/pages/VehiclesPage"));
const VehiclePage = lazy(() => import("../../garage/pages/VehiclePage"));
const StatementPage = lazy(() => import("../../garage/pages/StatementPage"));
const ServiceDuePage = lazy(() => import("../../garage/pages/ServiceDuePage"));
const GarageSettingsPage = lazy(() => import("../../garage/pages/GarageSettingsPage"));
const GaragePartsPage = lazy(() => import("../../garage/pages/GaragePartsPage"));
const MechanicCommissionPage = lazy(() => import("../../garage/pages/MechanicCommissionPage"));
// Gyms, studios and coaching centres.
const CheckInPage = lazy(() => import("../../memberships/pages/CheckInPage"));
const MembersPage = lazy(() => import("../../memberships/pages/MembersPage"));
const MemberPage = lazy(() => import("../../memberships/pages/MemberPage"));
const RenewalsPage = lazy(() => import("../../memberships/pages/RenewalsPage"));
const PlansPage = lazy(() => import("../../memberships/pages/PlansPage"));
const ClassesPage = lazy(() => import("../../memberships/pages/ClassesPage"));
const LeadsPage = lazy(() => import("../../memberships/pages/LeadsPage"));
const TrainerPayPage = lazy(() => import("../../memberships/pages/TrainerPayPage"));
// Laundries and dry cleaners.
const IntakePage = lazy(() => import("../../laundry/pages/IntakePage"));
const GarmentOrdersPage = lazy(() => import("../../laundry/pages/GarmentOrdersPage"));
const GarmentOrderPage = lazy(() => import("../../laundry/pages/GarmentOrderPage"));
const ReadyRacksPage = lazy(() => import("../../laundry/pages/ReadyRacksPage"));
const UnclaimedPage = lazy(() => import("../../laundry/pages/UnclaimedPage"));
const PriceListPage = lazy(() => import("../../laundry/pages/PriceListPage"));
// Jewellery shops.
const GoldRatesPage = lazy(() => import("../../jewellery/pages/RatesPage"));
const RateBoardPage = lazy(() => import("../../jewellery/pages/RateBoardPage"));
const PiecesPage = lazy(() => import("../../jewellery/pages/PiecesPage"));
const JewelleryBillPage = lazy(() => import("../../jewellery/pages/JewelleryBillPage"));
const JewellerySettingsPage = lazy(() => import("../../jewellery/pages/JewellerySettingsPage"));
const OldGoldPage = lazy(() => import("../../jewellery/pages/OldGoldPage"));
const SchemesPage = lazy(() => import("../../jewellery/pages/SchemesPage"));
const SchemePlansPage = lazy(() => import("../../jewellery/pages/SchemePlansPage"));
const CashReportPage = lazy(() => import("../../jewellery/pages/CashReportPage"));
const CustomOrdersPage = lazy(() => import("../../jewellery/pages/CustomOrdersPage"));
const ApprovalsPage = lazy(() => import("../../jewellery/pages/ApprovalsPage"));
const KarigarWorkPage = lazy(() => import("../../jewellery/pages/KarigarWorkPage"));
const HallmarkingPage = lazy(() => import("../../jewellery/pages/HallmarkingPage"));
const FineWeightPage = lazy(() => import("../../jewellery/pages/FineWeightPage"));
const MetalAccountPage = lazy(() => import("../../jewellery/pages/MetalAccountPage"));
// Rental and hire businesses.
const RentalBookingsPage = lazy(() => import("../../rentals/pages/BookingsPage"));
const RentalBookingPage = lazy(() => import("../../rentals/pages/BookingPage"));
const RentalBookingFormPage = lazy(() => import("../../rentals/pages/BookingFormPage"));
const RentalAvailabilityPage = lazy(() => import("../../rentals/pages/AvailabilityPage"));
const RentalDepositsPage = lazy(() => import("../../rentals/pages/DepositsPage"));
const RentalItemsPage = lazy(() => import("../../rentals/pages/RentalItemsPage"));
const RentalYardPage = lazy(() => import("../../rentals/pages/YardPage"));
const RentalRegisterPage = lazy(() => import("../../rentals/pages/RegisterPage"));
const RentalReportsPage = lazy(() => import("../../rentals/pages/RentalReportsPage"));
// Fuel stations.
const FuelShiftsPage = lazy(() => import("../../fuel/pages/ShiftsPage"));
const FuelShiftPage = lazy(() => import("../../fuel/pages/ShiftPage"));
const FuelDipsPage = lazy(() => import("../../fuel/pages/DipsPage"));
const FuelReceiptsPage = lazy(() => import("../../fuel/pages/ReceiptsPage"));
const FuelRegisterPage = lazy(() => import("../../fuel/pages/RegisterPage"));
const FuelFleetPage = lazy(() => import("../../fuel/pages/FleetPage"));
const FuelStatementPage = lazy(() => import("../../fuel/pages/FleetStatementPage"));
const FuelPumpsPage = lazy(() => import("../../fuel/pages/PumpsPage"));
const FuelAttendantsPage = lazy(() => import("../../fuel/pages/AttendantsPage"));
const FuelRecordsPage = lazy(() => import("../../fuel/pages/RecordsPage"));
const FuelOutletsPage = lazy(() => import("../../fuel/pages/OutletsPage"));
// Hotels, lodges and guest houses.
const LodgingDeskPage = lazy(() => import("../../lodging/pages/FrontDeskPage"));
const LodgingRoomsPage = lazy(() => import("../../lodging/pages/RoomsPage"));
const LodgingReservationsPage = lazy(() => import("../../lodging/pages/ReservationsPage"));
const LodgingStaysPage = lazy(() => import("../../lodging/pages/StaysPage"));
const LodgingStayPage = lazy(() => import("../../lodging/pages/StayPage"));
const LodgingStayFormPage = lazy(() => import("../../lodging/pages/StayFormPage"));
const LodgingFormIIIPage = lazy(() => import("../../lodging/pages/ForeignGuestsPage"));
const LodgingRegisterPage = lazy(() => import("../../lodging/pages/GuestRegisterPage"));
const LodgingRatesPage = lazy(() => import("../../lodging/pages/RoomTypesPage"));
const LodgingGroupFormPage = lazy(() => import("../../lodging/pages/GroupFormPage"));
const LodgingGroupPage = lazy(() => import("../../lodging/pages/GroupPage"));

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
function Guard({ section, children, nav = true }) {
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
        <p>{moduleCode && !has(moduleCode) ? "This business does not use this tool. An owner can switch it on under Settings › Business tools." : "Your role in this business does not include this screen. Ask the owner if you need it."}</p>
      </Notice>
    );
  }
  return <>{nav && <WorkspaceNav section={section} />}{children}</>;
}

const page = (section, element) => <Guard section={section}>{element}</Guard>;

// The clinic's and the lab's workspaces are screens of their own outside
// Business Admin (workspaces/clinic, workspaces/lab): their menu links open
// them, and so do their sections' addresses here.
function OpenWorkspace({ address }) {
  const { businessId } = useBusiness();
  return <Navigate to={`/${address}/${businessId}`} replace />;
}

// Every screen of a business at /business-admin/<id>/<section>, by section.
// The same screens open in a wide panel over the Overview (?open=<section>),
// so the routes and the panel can never drift apart.
function screens(type) {
  return {
    appointments: type === "salon" ? <SalonAppointmentsPage /> : <AppointmentsPage />,
    "sales": <DocumentsPage kind="sale" />,
    "day-close": <DayClosePage />,
    "purchases": <DocumentsPage kind="purchase" />,
    "customers": <ContactsPage kind="customer" />,
    "suppliers": <ContactsPage kind="supplier" />,
    "pricing": <PricingPage />,
    "sales-orders": <SalesOrdersPage />,
    "back-orders": <BackOrdersPage />,
    "routes": <RoutesPage />,
    "wholesale-reports": <WholesaleReportsPage />,
    "dispatch": <DispatchPage />,
    "price-groups": <PriceGroupsPage />,
    "claims": <ClaimsPage />,
    "purchase-orders": <PurchaseOrdersPage />,
    "outstanding": <OutstandingPage />,
    "collections": <CollectionsPage />,
    "products": <CatalogPage />,
    "categories": <CategoriesPage />,
    "units": <UnitsPage />,
    "kits": <KitsPage />,
    "tax-changes": <BusinessTaxChangesPage />,
    "emi-finance": <FinancePage />,
    "stock": <StockPage />,
    "movements": <MovementsPage />,
    "transfers": <TransfersPage />,
    "counts": <CountsPage />,
    "reports": <ReportsPage />,
    "expenses": <ExpensesPage />,
    "activity": <ActivityPage />,
    "settings": <SettingsPage />,
    "tax-rates": <TaxRatesPage />,
    "payment-methods": <PaymentMethodsPage />,
    "number-series": <NumberSeriesPage />,
    "locations": <LocationsPage />,
    "staff": <StaffAccessPage />,
    "roles": <RolesPage />,
    "counter": <CounterPage />,
    "udhaar": <UdhaarPage />,
    "offers": <OffersPage />,
    "loyalty": <LoyaltyPage />,
    "books": <BooksPage />,
    "labels": <LabelsPage />,
    "retail-reports": <RetailReportsPage />,
    "near-expiry": <NearExpiryPage />,
    "book-orders": <BookOrdersPage />,
    "variants": <VariantsPage />,
    "variant-reports": <VariantReportsPage />,
    "exchanges": <ExchangesPage />,
    "serials": <SerialsPage />,
    "warranties": <WarrantiesPage />,
    "repairs": <RepairsPage />,
    "salon-calendar": <SalonCalendarPage />,
    "salon-bill": <SalonBillPage />,
    "packages": <PackagesPage />,
    "salon-setup": <SalonSetupPage />,
    "commissions": <CommissionsPage />,
    "processing": <ProcessingPage />,
    "wastage": <WastagePage />,
    "weight-stock": <WeightStockPage />,
    "weight-reports": <WeightReportsPage />,
    "salon-reports": <SalonReportsPage />,
    "rates": type === "hardware" ? <HardwareRatesPage /> : <RatesPage />,
    "pickup-orders": <PickupOrdersPage />,
    "rx-sale": <PharmacyCounterPage />,
    "drug-master": <DrugMasterPage />,
    "pharmacy-registers": <PharmacyRegistersPage />,
    "pharmacy-batches": <PharmacyBatchesPage />,
    "health-settings": <HealthSettingsPage />,
    "clinic-workspace": <OpenWorkspace address="clinic" />,
    "lab-workspace": <OpenWorkspace address="lab" />,
    "clinic-today": <ClinicTodayPage />,
    "clinic-queue": <TokenQueuePage />,
    doctors: <DoctorsPage />,
    "lab-qc": <LabQcPage />,
    "patients": <PatientsPage />,
    "visits": <VisitsPage />,
    "lab-orders": <LabOrdersPage />,
    "lab-tests": <LabTestsPage />,
    "quotations": <QuotationsPage />,
    "sites": <SitesPage />,
    "fitters": <FittersPage />,
    "fitter-reports": <FitterReportPage />,
    "tinting": <TintingPage />,
    "licences": <LicencesPage />,
    "privacy": <BusinessPrivacyPage />,
    "farmers": <FarmersPage />,
    "agri-subsidy": <SubsidyPage />,
    "agri-registers": <AgriRegistersPage />,
    "molecules": <MoleculesPage />,
    "agri-settings": <AgriSettingsPage />,
    "agri-seasons": <SeasonCreditPage />,
    "agri-crops": <CropsPage />,
    "agri-seed-lots": <SeedLotsPage />,
    "agri-kept-apart": <KeptApartPage />,
    "agri-schemes": <CompanySchemesPage />,
    "prescriptions": <PrescriptionsPage />,
    "spectacle-orders": <SpectacleOrdersPage />,
    "recall": <RecallPage />,
    "contact-lenses": <ContactLensesPage />,
    "lens-stock": <LensStockPage />,
    "referrals": <ReferralsPage />,
    "job-cards": <JobCardsPage />,
    "vehicles": <VehiclesPage />,
    "service-due": <ServiceDuePage />,
    "garage-settings": <GarageSettingsPage />,
    "garage-parts": <GaragePartsPage />,
    "mechanic-commission": <MechanicCommissionPage />,
    "check-in": <CheckInPage />,
    "members": <MembersPage />,
    "renewals": <RenewalsPage />,
    "member-plans": <PlansPage />,
    "member-classes": <ClassesPage />,
    "member-leads": <LeadsPage />,
    "member-pay": <TrainerPayPage />,
    "laundry-new": <IntakePage />,
    "garment-orders": <GarmentOrdersPage />,
    "ready-racks": <ReadyRacksPage />,
    "unclaimed": <UnclaimedPage />,
    "laundry-prices": <PriceListPage />,
    "gold-rates": <GoldRatesPage />,
    "rate-board": <RateBoardPage />,
    "pieces": <PiecesPage />,
    "jewellery-bill": <JewelleryBillPage />,
    "jewellery-settings": <JewellerySettingsPage />,
    "old-gold": <OldGoldPage />,
    "gold-schemes": <SchemesPage />,
    "scheme-plans": <SchemePlansPage />,
    "cash-report": <CashReportPage />,
    "custom-orders": <CustomOrdersPage />,
    "approvals": <ApprovalsPage />,
    "karigar-work": <KarigarWorkPage />,
    "hallmarking": <HallmarkingPage />,
    "fine-weight": <FineWeightPage />,
    "metal-account": <MetalAccountPage />,
    "rental-bookings": <RentalBookingsPage />,
    "rental-availability": <RentalAvailabilityPage />,
    "rental-deposits": <RentalDepositsPage />,
    "rental-items": <RentalItemsPage />,
    "rental-yard": <RentalYardPage />,
    "rental-register": <RentalRegisterPage />,
    "rental-reports": <RentalReportsPage />,
    "fuel-shifts": <FuelShiftsPage />,
    "fuel-dips": <FuelDipsPage />,
    "fuel-receipts": <FuelReceiptsPage />,
    "fuel-register": <FuelRegisterPage />,
    "fuel-fleet": <FuelFleetPage />,
    "fuel-pumps": <FuelPumpsPage />,
    "fuel-attendants": <FuelAttendantsPage />,
    "fuel-records": <FuelRecordsPage />,
    "fuel-outlets": <FuelOutletsPage />,
    "lodging-desk": <LodgingDeskPage />,
    "lodging-rooms": <LodgingRoomsPage />,
    "lodging-reservations": <LodgingReservationsPage />,
    "lodging-stays": <LodgingStaysPage />,
    "lodging-form-iii": <LodgingFormIIIPage />,
    "lodging-register": <LodgingRegisterPage />,
    "lodging-rates": <LodgingRatesPage />,
  };
}

// A screen opened over the Overview (?open=<section>): the real screen in a
// wide panel, with "Open full page" for the screen on its own. Closing it
// returns to the Overview. Any other settings in the address (?new=1,
// ?cut=1) reach the screen as they would on its own page.
function OverviewSheet() {
  const { context } = useBusiness();
  const [params, setParams] = useSearchParams();
  const section = params.get("open");
  const type = context.business.business_type;
  const element = section ? screens(type)[section] : null;
  if (!element) return null;
  const rule = sectionRule(section, type);
  const title = workspaceLabel(section, type, rule?.label || "Details");
  const rest = new URLSearchParams(params);
  rest.delete("open");
  return (
    <SidePanel open wide title={title} icon="grid" onClose={() => setParams(new URLSearchParams(), { replace: false })}
      footer={<Link className="button button-secondary" to={`/business-admin/${context.business.id}/${section}${rest.toString() ? `?${rest}` : ""}`}>Open full page</Link>}>
      <Suspense fallback={<ScreenLoading />}>
        <Guard section={section} nav={false}>{element}</Guard>
      </Suspense>
    </SidePanel>
  );
}

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
        <Route index element={<><OverviewPage /><OverviewSheet /></>} />
        {Object.entries(screens(context.business.business_type)).map(([section, element]) => <Route key={section} path={section} element={page(section, element)} />)}
        {/* A salon keeps its stylists and rooms on one screen (Stylists & services). */}
        <Route path="resources" element={context.business.business_type === "salon"
          ? <Navigate to={`/business-admin/${context.business.id}/salon-setup?tab=staff`} replace /> : page("resources", <ResourcesPage />)} />
        <Route path="counts/:countId" element={page("counts", <CountSheetPage />)} />
        <Route path="variants/:productId" element={page("variants", <VariantMatrixPage />)} />
        <Route path="repairs/:jobId" element={page("repairs", <RepairJobPage />)} />
        <Route path="patients/:contactId" element={page("patients", <PatientPage />)} />
        <Route path="visits/:visitId" element={page("visits", <VisitPage />)} />
        <Route path="lab-orders/:orderId" element={page("lab-orders", <LabOrderPage />)} />
        <Route path="prescriptions/:contactId" element={page("prescriptions", <PrescriptionHistoryPage />)} />
        <Route path="spectacle-orders/:orderId" element={page("spectacle-orders", <SpectacleOrderPage />)} />
        <Route path="job-cards/:jobId" element={page("job-cards", <JobCardPage />)} />
        <Route path="vehicles/:vehicleId" element={page("vehicles", <VehiclePage />)} />
        <Route path="vehicles/owner/:contactId" element={page("vehicles", <StatementPage />)} />
        <Route path="members/:contactId" element={page("members", <MemberPage />)} />
        <Route path="garment-orders/:orderId" element={page("garment-orders", <GarmentOrderPage />)} />
        <Route path="rental-bookings/new" element={page("rental-bookings", <RentalBookingFormPage />)} />
        <Route path="rental-bookings/:bookingId" element={page("rental-bookings", <RentalBookingPage />)} />
        <Route path="fuel-shifts/:shiftId" element={page("fuel-shifts", <FuelShiftPage />)} />
        <Route path="fuel-fleet/:contactId" element={page("fuel-fleet", <FuelStatementPage />)} />
        <Route path="lodging-stays/new" element={page("lodging-stays", <LodgingStayFormPage />)} />
        <Route path="lodging-stays/:stayId" element={page("lodging-stays", <LodgingStayPage />)} />
        <Route path="lodging-groups/new" element={page("lodging-stays", <LodgingGroupFormPage />)} />
        <Route path="lodging-groups/:groupId" element={page("lodging-stays", <LodgingGroupPage />)} />
        <Route path="tasks/*" element={page("tasks", <TasksRoutes />)} />
        <Route path="*" element={<Notice title="Page not found"><p>Use the menu on the left to find the screen you need.</p></Notice>} />
      </Routes>
    </Suspense>
  );
}
