// The Business Admin's menu for one business, built from what the business
// has switched on and what this person's role allows. The server checks the
// same two things on every request; the menu only hides what would be refused.

import { AGRI, CLINIC, FUEL, GARAGE, GOODS, HARDWARE, JEWELLERY, LAUNDRY, LODGING, MEMBERSHIPS, OPTICAL, PHARMACY, RENTALS, RETAIL, SALON, WEIGHED } from './businessTypes.js';
import { dailyWorkspaces, WORKSPACES, workspaceLabel, workspaceSections } from './businessWorkspace.js';

export { GOODS };

export const businessPath = (id, section = "") => `/business-admin/${id}${section ? `/${section}` : ""}`;

// Someone who works in the signed-in restaurant (has a restaurant role). A
// kirana cashier is a user too, but only has business memberships.
export const isRestaurantStaff = (user) => Boolean(user?.restaurantId) && Array.isArray(user?.roles) && user.roles.length > 0;

// Where a person lands after signing in: the business they used last; someone
// with no restaurant role falls back to the first business in their list.
// null = stay on the restaurant's home screen.
export function landingBusiness(businesses, restaurantStaff) {
  const list = businesses || [];
  const recent = [...list].filter((b) => b.last_opened_at)
    .sort((a, b) => String(b.last_opened_at).localeCompare(String(a.last_opened_at)))[0];
  const pick = recent || (restaurantStaff ? null : list[0] || null);
  if (!pick || (restaurantStaff && pick.is_signed_in_restaurant)) return null;
  return pick;
}

// Where the home address (/) sends a person, decided before any layout is
// drawn, so a shop never opens under the restaurant's header: "wait" while
// their businesses are not known yet; an address to go to; or null for the
// restaurant's own home screen.
//   - The platform's own account: null (the home screen sends it to its console).
//   - Staff with no restaurant role: always to a business (the last they
//     used, else their first), or to the list when they have none.
//   - Restaurant staff: null once the list is known (or could not be read);
//     arrivalLanding has sent them on by then if they were going.
export function homeLanding({ restaurantStaff, platform = false, directory, failed = false }) {
  if (platform) return null;
  if (!directory && !failed) return "wait";
  if (restaurantStaff) return null;
  const pick = landingBusiness(directory?.businesses, false);
  return pick ? businessPath(pick.id) : "/business-admin?all";
}

// Restaurant staff arriving on the home screen go back to the business they
// used last, when that was not their restaurant: decided once, as their list
// first arrives, before it is shown. Its address, or null to stay.
export function arrivalLanding(businesses, restaurantStaff, pathname) {
  if (!restaurantStaff || pathname !== "/") return null;
  const pick = landingBusiness(businesses, true);
  return pick ? businessPath(pick.id) : null;
}

// Words a business of each type uses for the same screens.
const TYPE_WORDS = {
  salon: { customers: "Clients", products: "Services & products", resources: "Stylists & rooms", sales: "Bills", appointments: "Appointment history" },
  // Patients have their own screen (with consent); the core list is the billing contacts.
  healthcare: { customers: "Billing contacts", products: "Services & charges", resources: "Doctors & rooms", sales: "Bills" },
  pharmacy: { products: "Medicines & products" },
  // Shared receivables: a kirana calls customer credit "udhaar".
  grocery: { outstanding: "Udhaar", collections: "Udhaar collections" },
  books: { products: "Books & stationery" },
  wholesale: { customers: "Customers & retailers", pricing: "Price lists" },
  fashion: { products: "Products & variants", variants: "Size × colour" },
  electronics: { products: "Products & models" },
  // A meat shop's customer rates; a dry-fruit shop sorts and repacks.
  meat: { pricing: "Customer rates" },
  weight_retail: { pricing: "Customer rates", processing: "Sorting & repacking" },
  hardware: { customers: "Customers & contractors", pricing: "Contractor & dealer rates", variants: "Sizes & shades" },
  agri_inputs: { customers: "Farmers & customers", products: "Seeds, fertilisers & pesticides", pricing: "Dealer rates" },
  optical: { products: "Frames, lenses & products", variants: "Frame colours & sizes", appointments: "Eye tests", resources: "Optometrists & rooms" },
  garage: { products: "Parts & services", pricing: "Mechanic & retailer rates", appointments: "Service bookings", resources: "Mechanics & bays" },
  jewellery: { products: "Jewellery & items" },
  fuel_station: { customers: "Customers & fleets", products: "Fuels, lubricants & items" },
  memberships: { customers: "Members", products: "Plans & services", sales: "Bills", appointments: "Sessions & trials", resources: "Trainers & studios" },
  laundry: { products: "Services & items", sales: "Bills" },
  rentals: { customers: "Hirers", products: "Rental items & services", sales: "Bills" },
  lodging: { customers: "Guests & companies", products: "Rooms, services & extras", sales: "Bills" },
};
export const word = (type, key, fallback) => TYPE_WORDS[type]?.[key] || fallback;

// One icon per business type, from the shared Icon set, for the switcher.
export const TYPE_ICONS = {
  restaurant: "utensils", grocery: "store", supermarket: "grid", wholesale: "truck", fashion: "tag",
  electronics: "zap", pharmacy: "heart", books: "book", salon: "sparkles", healthcare: "activity",
  meat: "scale", weight_retail: "scale",
  general_retail: "box", hardware: "layers", agri_inputs: "leaf", optical: "eye", garage: "settings", jewellery: "star",
  fuel_station: "fire", memberships: "users", laundry: "refresh", rentals: "key", lodging: "home",
};

// section: the URL piece under /business-admin/<id>/; need: the permission
// (its module must be on too); module: an extra module the screen needs;
// types: only for these business types; except: not for these types;
// href(id): the address of a workspace of its own outside Business Admin
// (the clinic's, the lab's), which the menu link opens instead.
export function businessSections(type) {
  return [
    { title: "Overview", links: [{ section: "", label: "Overview", icon: "dashboard", end: true }] },
    {
      title: "Sales",
      links: [
        { section: "counter", label: "Quick bill", icon: "pos", need: "sales.create", types: GOODS },
        { section: "rx-sale", label: "Prescription sale", icon: "pos", need: "sales.create", module: "pharmacy", types: PHARMACY },
        { section: "day-close", label: "Daily money", icon: "businessDay", need: "sales.view", except: ['restaurant'] },
        { section: "expenses", label: "Expenses", icon: "expenses", need: "expenses.view", except: ['restaurant'] },
        // The salon's bill and calendar.
        { section: "salon-bill", label: "New bill", icon: "pos", need: "sales.create", types: SALON },
        { section: "salon-calendar", label: "Calendar", icon: "reservations", need: "appointments.view", types: SALON },
        // Phone and WhatsApp orders for pickup at a weight shop.
        { section: "pickup-orders", label: "Orders for pickup", icon: "pickup", need: "sales.view", module: "weight", types: WEIGHED },
        { section: "sales", label: word(type, "sales", "Sales"), icon: "bills", need: "sales.view" },
        // Estimates with a validity date that become bills or sales orders.
        { section: "quotations", label: "Quotations", icon: "logbook", need: "quotations.view", except: ['restaurant'] },
        // A paint shop's tinting board (each tinted line of a bill, queued to handed over) and its shades.
        { section: "tinting", label: "Paint tinting", icon: "board", need: "hardware_tinting.view", types: HARDWARE },
        { section: "customers", label: word(type, "customers", "Customers"), icon: "customers", need: "contacts.view" },
        // A hardware shop's contractors' and builders' sites, each with its ledger.
        { section: "sites", label: "Sites", icon: "locations", need: "hardware_sites.view", types: HARDWARE },
        // A hardware shop's fitters: the register, commission rules, payouts and statements.
        { section: "fitters", label: "Fitters", icon: "employees", need: "fitter_commission.view", types: HARDWARE },
        { section: "udhaar", label: "Udhaar", icon: "dues", need: "receivables.view", types: GOODS },
        // A shop's udhaar collections sit right under Udhaar, one name for every shop.
        { section: "collections", label: "Udhaar collections", icon: "collection", need: "receivables.view", types: GOODS },
        // School booklists and customer orders (bookshops).
        { section: "book-orders", label: "Booklists & orders", icon: "orders", need: "sales.view", module: "books" },
        { section: "offers", label: "Offers & discounts", icon: "discounts", need: "offers.view" },
        { section: "loyalty", label: "Loyalty points", icon: "loyalty", need: "loyalty.view" },
        { section: "appointments", label: word(type, "appointments", "Appointments"), icon: "reservations", need: "appointments.view" },
        // A salon edits its stylists and rooms under Stylists & services.
        { section: "resources", label: word(type, "resources", "Staff & rooms"), icon: "employees", need: "appointments.view", except: SALON },
        { section: "pricing", label: word(type, "pricing", "Wholesale prices"), icon: "priceList", need: "wholesale.view" },
        { section: "price-groups", label: "Price groups & schemes", icon: "discounts", need: "wholesale.view", module: "sales_orders" },
        // Wholesale orders and the shared receivables screens.
        { section: "sales-orders", label: "Sales orders", icon: "orders", need: "sales_orders.view" },
        { section: "dispatch", label: "Dispatch", icon: "deliveries", need: "sales_orders.view" },
        { section: "back-orders", label: "Back-orders", icon: "pickup", need: "sales_orders.view" },
        // Retail shops see the same balances on their Udhaar screen (with reminders).
        { section: "outstanding", label: word(type, "outstanding", "Outstanding"), icon: "dues", need: "receivables.view", except: GOODS },
        { section: "collections", label: word(type, "collections", "Collections"), icon: "collection", need: "receivables.view", except: GOODS },
        { section: "routes", label: "Routes & salespeople", icon: "deliveries", need: "sales_orders.view" },
        // Fashion exchanges, electronics repairs and warranties.
        { section: "exchanges", label: "Exchanges", icon: "returns", need: "exchanges.view" },
        { section: "repairs", label: "Repairs", icon: "repair", need: "repairs.view" },
        { section: "warranties", label: "Warranties", icon: "warranty", need: "warranties.view" },
        // EMI sales owed by financiers, and their payouts.
        { section: "emi-finance", label: "EMI & financiers", icon: "wallet", need: "finance.view" },
        // Salon packages and memberships.
        { section: "packages", label: "Packages", icon: "package", need: "packages.view", types: SALON },
      ],
    },
    {
      title: "Pharmacy",
      links: [
        { section: "drug-master", label: "Drug master", icon: "products", need: "pharmacy.view", types: PHARMACY },
        { section: "pharmacy-registers", label: "Registers & prescriptions", icon: "logbook", need: "pharmacy.view", types: PHARMACY },
        { section: "pharmacy-batches", label: "Expiry, returns & recalls", icon: "returns", need: "pharmacy.view", types: PHARMACY },
      ],
    },
    {
      title: "Clinic",
      links: [
        // The clinic's own workspaces, each a screen of its own: the front desk
        // and the doctors (/clinic), sample collection and the lab (/lab).
        { section: "clinic-workspace", label: "Clinic workspace", icon: "clinic", need: "patients.view", types: CLINIC, href: (id) => `/clinic/${id}` },
        { section: "lab-workspace", label: "Lab workspace", icon: "lab", need: "lab.view", types: CLINIC, href: (id) => `/lab/${id}` },
        { section: "clinic-today", label: "Today's patients", icon: "reservations", need: "patients.view", types: CLINIC },
        { section: "clinic-queue", label: "Token queue", icon: "collection", need: "patients.view", types: CLINIC },
        { section: "patients", label: "Patients", icon: "customers", need: "patients.view", types: CLINIC },
        { section: "visits", label: "Visits & follow-ups", icon: "logbook", need: "patients.view", types: CLINIC },
        { section: "lab-orders", label: "Lab orders", icon: "inventoryInsights", need: "lab.view", types: CLINIC },
        { section: "lab-tests", label: "Tests & panels", icon: "categories", need: "lab.view", types: CLINIC },
        { section: "lab-qc", label: "Quality control", icon: "activity", need: "lab.view", types: CLINIC },
        { section: "doctors", label: "Doctors, fees & OPD", icon: "employees", need: "appointments.view", types: CLINIC },
        // The clinic's own drug list, which the prescription picks from (kept by the doctors).
        { section: "clinic-drugs", label: "Drug list", icon: "products", need: "patients.view_clinical", types: CLINIC },
      ],
    },
    {
      // A seeds, fertilisers & pesticides shop's farmers and village dues, the
      // subsidy PoS reconciliation, the registers and the molecule list.
      title: "Farm inputs",
      links: [
        { section: "farmers", label: "Farmers & village dues", icon: "customers", need: "agri.view", types: AGRI },
        { section: "agri-subsidy", label: "Subsidy PoS reconciliation", icon: "counts", need: "agri.view", types: AGRI },
        { section: "agri-registers", label: "Registers & board", icon: "logbook", need: "agri.view", types: AGRI },
        { section: "molecules", label: "Molecules", icon: "categories", need: "agri.view", types: AGRI },
        // Each farmer's credit for a season (its limit, harvest date and interest), and the crops in their groups.
        { section: "agri-seasons", label: "Season credit", icon: "dues", need: "agri.view", types: AGRI },
        { section: "agri-crops", label: "Crops", icon: "products", need: "agri.view", types: AGRI },
      ],
    },
    {
      // An optical shop's spectacle orders (a daily entry of its own), and its
      // eye prescriptions (with its customers).
      title: "Optical",
      links: [
        { section: "spectacle-orders", label: "Spectacle orders", icon: "orders", need: "optical.view", types: OPTICAL },
        { section: "prescriptions", label: "Prescriptions", icon: "logbook", need: "optical.view", types: OPTICAL },
        // Customers due for an eye test, with a reminder ready to send.
        { section: "recall", label: "Recall list", icon: "reservations", need: "optical.view", types: OPTICAL },
        // Contact lenses running out, with a reminder ready to send, and free trials (with its customers).
        { section: "contact-lenses", label: "Contact lenses", icon: "recurring", need: "optical.view", types: OPTICAL },
        // Contact lenses in stock, power by power (with its stock).
        { section: "lens-stock", label: "Contact lens stock", icon: "stock", need: "inventory.view", module: "optical", types: OPTICAL },
        // The referring doctors and their referrals (with its reports).
        { section: "referrals", label: "Referrals", icon: "reports", need: "optical.view", types: OPTICAL },
      ],
    },
    {
      // A garage's job cards (a daily entry of their own; a mechanic sees the ones
      // assigned to them), and its vehicles and service-due list (with its customers).
      title: "Garage",
      links: [
        { section: "job-cards", label: "Job cards", icon: "repair", module: "garage", types: GARAGE },
        { section: "vehicles", label: "Vehicles", icon: "deliveries", need: "garage.view", types: GARAGE },
        // Vehicles due for a service, and insurance and PUC running out, with a reminder ready to send.
        { section: "service-due", label: "Service due", icon: "reservations", need: "garage.view", types: GARAGE },
      ],
    },
    {
      // A gym's, studio's or coaching centre's front desk (a daily entry of its
      // own), and its members with their plans and the renewal calls (with its
      // members' details).
      title: "Memberships",
      links: [
        { section: "check-in", label: "Check-in", icon: "attendance", need: "member_plans.view", types: MEMBERSHIPS },
        { section: "members", label: "Members", icon: "customers", need: "member_plans.view", types: MEMBERSHIPS },
        // Memberships ending soon or ended lately, and fees falling due, with a reminder ready to send.
        { section: "renewals", label: "Renewals", icon: "recurring", need: "member_plans.view", types: MEMBERSHIPS },
        // The class timetable: the week's classes, their bookings, waitlists and attendance (beside the desk).
        { section: "member-classes", label: "Classes", icon: "calendar", need: "member_plans.view", types: MEMBERSHIPS },
        // Enquiries with their follow-up day, trial passes, and the members they become.
        { section: "member-leads", label: "Enquiries", icon: "guestInsights", need: "member_plans.view", types: MEMBERSHIPS },
      ],
    },
    {
      // A laundry's counter: a new order taken in (a daily entry of its own),
      // and its orders with the racks and those not collected.
      title: "Laundry",
      links: [
        { section: "laundry-new", label: "New order", icon: "pos", need: "laundry.create", types: LAUNDRY },
        { section: "garment-orders", label: "Orders", icon: "orders", need: "laundry.view", types: LAUNDRY },
        // Garments found by tag, phone or order, and what hangs on each rack.
        { section: "ready-racks", label: "Ready & racks", icon: "pickup", need: "laundry.view", types: LAUNDRY },
        // Orders ready and not collected for the shop's days, with the reminders sent.
        { section: "unclaimed", label: "Unclaimed", icon: "hours", need: "laundry.view", types: LAUNDRY },
        // Damage claims, and the claims added up by service, by who took the garment in and by month.
        { section: "laundry-claims", label: "Claims", icon: "complaints", need: "laundry.view", types: LAUNDRY },
        // Prepaid kilo and piece packages: the plans, and the customers' packages with what is left.
        { section: "laundry-packages", label: "Packages", icon: "package", need: "laundry.view", types: LAUNDRY },
      ],
    },
    {
      // A jeweller's day: today's rates (prices: for those who see sales), with
      // the rate board for a showroom screen; its tagged pieces (the first page
      // of its stock).
      title: "Jewellery",
      links: [
        // Its counter: tagged pieces priced by weight at the day's rate (Quick bill beside it for everything else).
        { section: "jewellery-bill", label: "Jewellery bill", icon: "pos", need: "jewellery.create", types: JEWELLERY },
        { section: "gold-rates", label: "Today's rates", icon: "priceList", need: "sales.view", module: "jewellery", types: JEWELLERY },
        { section: "rate-board", label: "Rate board", icon: "dashboard", need: "sales.view", module: "jewellery", types: JEWELLERY },
        { section: "pieces", label: "Pieces & tags", icon: "numbering", need: "jewellery.view", types: JEWELLERY },
        // Old gold bought from customers or taken in exchange (money: for those who see sales).
        { section: "old-gold", label: "Old gold", icon: "collection", need: "sales.view", module: "jewellery", types: JEWELLERY },
        // Gold schemes: monthly instalments turned into jewellery within the year (money: for those who see sales).
        { section: "gold-schemes", label: "Gold schemes", icon: "recurring", need: "sales.view", module: "jewellery", types: JEWELLERY },
        // Pieces made to a customer's order: booked with an advance that may fix the rate, made, hallmarked, billed (with its sales).
        { section: "custom-orders", label: "Custom orders", icon: "orders", need: "jewellery.view", types: JEWELLERY },
        // Pieces out on approval (jangad) to customers and other jewellers (with its sales; money: for those who see sales).
        { section: "approvals", label: "Approvals", icon: "returns", need: "sales.view", module: "jewellery", types: JEWELLERY },
        // Karigars' job work, the hallmarking centre and the fine-weight book (with its pieces).
        { section: "karigar-work", label: "Karigar work", icon: "repair", need: "jewellery.view", types: JEWELLERY },
        { section: "hallmarking", label: "Hallmarking", icon: "logbook", need: "jewellery.view", types: JEWELLERY },
        { section: "fine-weight", label: "Fine weight", icon: "inventoryInsights", need: "jewellery.view", types: JEWELLERY },
        // Metal with bullion suppliers in grams, and its rate fixed (with its purchases; for those who see purchases).
        { section: "metal-account", label: "Metal account", icon: "suppliers", need: "purchasing.view", module: "jewellery", types: JEWELLERY },
      ],
    },
    {
      // A rental business's bookings (a daily entry of their own): the board of
      // what goes out, is out and is due back, the availability week, and the
      // deposits held (money: for those who see sales).
      title: "Rentals",
      links: [
        { section: "rental-bookings", label: "Bookings", icon: "reservations", need: "rentals.view", types: RENTALS },
        // What is free day by day: each unit and pool over the week.
        { section: "rental-availability", label: "Availability", icon: "calendar", need: "rentals.view", types: RENTALS },
        { section: "rental-deposits", label: "Deposits held", icon: "wallet", need: "sales.view", module: "rentals", types: RENTALS },
        // Where the units and pools are kept, the vehicles' papers and services, maintenance booked ahead and moves between locations.
        { section: "rental-yard", label: "Yard & fleet", icon: "deliveries", need: "rentals.view", types: RENTALS },
        // The hirer register of the rent-a-cab and rent-a-motorcycle schemes (Forms 5 and 3; 6 and 4), printed.
        { section: "rental-register", label: "Hirer register", icon: "logbook", need: "rentals.print", types: RENTALS },
        // Each unit's days out against its days available, and what each unit and item earned.
        { section: "rental-reports", label: "Use & earnings", icon: "reports", need: "rentals.view", types: RENTALS },
      ],
    },
    {
      // A fuel station's day (daily entries of their own): the shifts with their
      // readings and takings; the tanks with the morning dips, the tanker loads
      // and the stock register; and its fleet customers' statements (money: for
      // those who see sales).
      title: "Fuel station",
      links: [
        { section: "fuel-shifts", label: "Shift & readings", icon: "shifts", need: "fuel.view", types: FUEL },
        { section: "fuel-dips", label: "Tanks & dips", icon: "stock", need: "fuel.view", types: FUEL },
        { section: "fuel-receipts", label: "Tanker receipts", icon: "deliveries", need: "fuel.view", types: FUEL },
        { section: "fuel-register", label: "Stock register", icon: "logbook", need: "fuel.view", types: FUEL },
        { section: "fuel-fleet", label: "Fleet statements", icon: "bills", need: "sales.view", module: "fuel", types: FUEL },
        // The attendants' shorts and excess (money: for those who see sales), the
        // daily sales register with the inspection log, and every outlet at a glance.
        { section: "fuel-attendants", label: "Attendants' accounts", icon: "payroll", need: "sales.view", module: "fuel", types: FUEL },
        { section: "fuel-records", label: "Registers & inspections", icon: "logbook", need: "fuel.view", types: FUEL },
        { section: "fuel-outlets", label: "Outlets", icon: "outlets", need: "fuel.view", types: FUEL },
      ],
    },
    {
      // A lodging business's day (daily entries of their own): the front desk with
      // the rooms and housekeeping, the reservations calendar and every stay; its
      // foreign guests' Form-III reports and the guest register (guests' ID
      // details: for those who check guests in, or print the register).
      title: "Rooms & stays",
      links: [
        { section: "lodging-desk", label: "Front desk", icon: "reservations", need: "lodging.create", types: LODGING },
        { section: "lodging-rooms", label: "Rooms & housekeeping", icon: "floors", need: "lodging.view", types: LODGING },
        { section: "lodging-reservations", label: "Reservations", icon: "calendar", need: "lodging.view", types: LODGING },
        { section: "lodging-stays", label: "Stays", icon: "hours", need: "lodging.view", types: LODGING },
        { section: "lodging-form-iii", label: "Foreign guests (Form-III)", icon: "profile", need: "lodging.create", types: LODGING },
        { section: "lodging-register", label: "Guest register", icon: "logbook", need: "lodging.print", types: LODGING },
        // Maintenance tickets for the rooms, and the house's figures (occupancy, ADR, RevPAR: money, for those who see reports).
        { section: "lodging-maintenance", label: "Maintenance", icon: "repair", need: "lodging.view", types: LODGING },
        { section: "lodging-reports", label: "Occupancy & revenue", icon: "reports", need: "reports.view", module: "lodging", types: LODGING },
      ],
    },
    {
      title: "Purchases",
      links: [
        { section: "purchases", label: "Purchases", icon: "purchaseOrders", need: "purchasing.view" },
        // Purchase orders to the company / super-stockist (wholesale).
        // Every shop that buys stock raises purchase orders (reorder suggestions per branch).
        { section: "purchase-orders", label: "Purchase orders", icon: "purchaseOrders", need: "purchasing.view", module: "inventory" },
        { section: "suppliers", label: "Suppliers", icon: "suppliers", need: "contacts.view", module: "purchasing" },
        { section: "claims", label: "Claims on suppliers", icon: "returns", need: "purchasing.view", module: "sales_orders" },
        // A farm-input shop's company schemes: what its purchases earn, the claims and what is still due.
        { section: "agri-schemes", label: "Company schemes", icon: "discounts", need: "purchasing.view", module: "agri", types: AGRI },
      ],
    },
    {
      title: "Products",
      links: [
        { section: "products", label: word(type, "products", "Products & services"), icon: "products", need: "catalog.view" },
        { section: "categories", label: "Categories", icon: "categories", need: "catalog.view" },
        { section: "units", label: "Units & pack sizes", icon: "units", need: "catalog.view" },
        { section: "books", label: "Book details", icon: "categories", need: "catalog.view", module: "books" },
        { section: "labels", label: "Barcode labels", icon: "numbering", need: "catalog.print", module: "inventory" },
        { section: "variants", label: word(type, "variants", "Variants"), icon: "modifiers", need: "catalog.view", module: "variants" },
        // A kit / bundle sells as its parts (goods shops).
        { section: "kits", label: "Kits & bundles", icon: "box", need: "catalog.view", module: "inventory", types: GOODS },
        // The yearly GST change, entered ahead: items move to another slab from a date.
        { section: "tax-changes", label: "GST rate changes", icon: "tax", need: "catalog.view", except: ['restaurant'] },
        { section: "salon-setup", label: "Stylists & services", icon: "hours", need: "appointments.view", types: SALON },
        { section: "rates", label: "Today's rates", icon: "priceList", need: "catalog.view", module: "weight", types: WEIGHED },
        // A hardware shop's board of the items whose price moves every day.
        { section: "rates", label: "Today's rates", icon: "priceList", need: "catalog.view", module: "hardware_rates", types: HARDWARE },
        // A laundry's prices by garment and service, and how its orders are billed and handed over.
        { section: "laundry-prices", label: "Price list", icon: "priceList", need: "laundry.view", types: LAUNDRY },
        // A rental business's items with their rates, units and deposits, and the handover settings.
        { section: "rental-items", label: "Rental items", icon: "box", need: "rentals.view", types: RENTALS },
        // A garage's parts: the makes and models each fits, newer numbers and parts that do the same job.
        { section: "garage-parts", label: "Parts fitment", icon: "products", need: "catalog.view", module: "garage", types: GARAGE },
      ],
    },
    {
      title: "Stock",
      links: [
        { section: "stock", label: "Stock on hand", icon: "stock", need: "inventory.view" },
        { section: "movements", label: "Stock movements", icon: "movements", need: "inventory.view" },
        // Batches running out of date, with markdown and write-off.
        { section: "near-expiry", label: "Expiring soon", icon: "hours", need: "inventory.view", module: "batches" },
        { section: "transfers", label: "Transfers", icon: "transfers", need: "stock_transfers.view" },
        { section: "counts", label: "Stock counts", icon: "counts", need: "stock_counts.view" },
        { section: "serials", label: "Serial / IMEI register", icon: "numbering", need: "inventory.view", module: "serials" },
        // Weight-based shops.
        { section: "weight-stock", label: "Stock by weight", icon: "inventoryInsights", need: "inventory.view", module: "weight", types: WEIGHED },
        { section: "processing", label: WEIGHED.includes(type) ? "Cutting & processing" : word(type, "processing", "Cutting & yield"), icon: "kitchen", need: "processing.view" },
        { section: "wastage", label: "Wastage", icon: "returns", need: "wastage.view" },
        // A farm-input shop's seed lots with their tags, and stock kept apart (expired, seized, sampled).
        { section: "agri-seed-lots", label: "Seed lots", icon: "inventoryInsights", need: "inventory.view", module: "agri", types: AGRI },
        { section: "agri-kept-apart", label: "Kept apart", icon: "returns", need: "inventory.view", module: "agri", types: AGRI },
      ],
    },
    {
      // Tasks, issues & projects (modules/tasks): an owner's optional tool for
      // every business type (Settings › Business tools), off until switched on.
      title: "Tasks",
      links: [
        { section: "tasks", label: "My tasks", icon: "tasks", module: "tasks", end: true },
        { section: "tasks/board", label: "Team board", icon: "board", need: "tasks.view", module: "tasks" },
        { section: "tasks/calendar", label: "Task calendar", icon: "calendar", module: "tasks" },
        { section: "tasks/issues", label: "Issues", icon: "issues", module: "issues" },
        { section: "tasks/projects", label: "Projects", icon: "projects", module: "projects" },
        { section: "tasks/templates", label: "Templates", icon: "templates", need: "tasks.create", module: "tasks" },
        { section: "tasks/recurring", label: "Recurring tasks", icon: "recurring", need: "tasks.view", module: "tasks" },
        { section: "tasks/reports", label: "Task reports", icon: "reports", need: "tasks.view", module: "tasks" },
      ],
    },
    {
      title: "Reports",
      links: [
        { section: "reports", label: "Reports", icon: "reports", need: "reports.view" },
        { section: "retail-reports", label: "Retail reports", icon: "inventoryInsights", need: "reports.view", module: "sales", types: RETAIL },
        { section: "wholesale-reports", label: "Wholesale reports", icon: "reports", need: "reports.view", module: "sales_orders" },
        { section: "variant-reports", label: "Variant reports", icon: "inventoryInsights", need: "reports.view", module: "variants" },
        { section: "weight-reports", label: "Yield & wastage report", icon: "inventoryInsights", need: "reports.view", types: WEIGHED },
        { section: "salon-reports", label: "Service profitability", icon: "inventoryInsights", need: "reports.view", types: SALON },
        { section: "commissions", label: "Staff commissions", icon: "payroll", need: "commissions.view" },
        { section: "fitter-reports", label: "Fitters' commission", icon: "payroll", need: "fitter_commission.view", types: HARDWARE },
        // A garage's mechanics' commission on the labour billed, and its payouts.
        { section: "mechanic-commission", label: "Mechanics' commission", icon: "payroll", need: "reports.view", module: "garage", types: GARAGE },
        // A jeweller's cash with each customer, flagged at ₹10 lakh, and the monthly worksheet.
        { section: "cash-report", label: "Cash report", icon: "reports", need: "jewellery.export", module: "jewellery", types: JEWELLERY },
        { section: "activity", label: "Activity log", icon: "activity", need: "audit.view" },
        // A gym's, studio's or coaching centre's trainers' pay and sales commission, by month, paid through the expense book.
        { section: "member-pay", label: "Trainer pay", icon: "payroll", need: "member_plans.manage", types: MEMBERSHIPS },
      ],
    },
    {
      title: "Settings",
      links: [
        { section: "settings", label: "Business settings", icon: "settings", need: "settings.view" },
        { section: "tax-rates", label: "Tax rates", icon: "tax", need: "settings.view" },
        { section: "payment-methods", label: "Payment methods", icon: "collection", need: "settings.view" },
        { section: "number-series", label: "Number series", icon: "numbering", need: "settings.view" },
        { section: "locations", label: "Locations", icon: "locations", need: "settings.view" },
        { section: "health-settings", label: type === "pharmacy" ? "Pharmacy settings" : "Clinic & lab settings", icon: "serviceSettings", need: "settings.view", types: [...PHARMACY, ...CLINIC] },
        // Licences & registrations (every type but a restaurant): each location's licences and their dates.
        { section: "licences", label: "Licences", icon: "logbook", need: "licences.view", except: ['restaurant'] },
        // Personal data (every type but a restaurant, which has its own): requests, breaches, the privacy notice and contact.
        { section: "privacy", label: "Personal data", icon: "privacy", need: "privacy.view", except: ['restaurant'] },
        // What a farm-input shop's bills are checked for, and whether the licence check is on.
        { section: "agri-settings", label: "Farm input checks", icon: "serviceSettings", need: "agri.view", types: AGRI },
        // A garage's months and kilometres to the next service, and the item that bills the owner's share of a claim.
        { section: "garage-settings", label: "Garage settings", icon: "serviceSettings", need: "garage.view", types: GARAGE },
        // A gym's, studio's or coaching centre's plans, and when overdue fees turn a member away at check-in.
        { section: "member-plans", label: "Membership plans", icon: "package", need: "member_plans.view", types: MEMBERSHIPS },
        // A jeweller's tags and the hallmarking charge a new piece starts with.
        { section: "jewellery-settings", label: "Jewellery settings", icon: "serviceSettings", need: "jewellery.view", types: JEWELLERY },
        { section: "scheme-plans", label: "Gold scheme plans", icon: "recurring", need: "sales.view", module: "jewellery", types: JEWELLERY },
        // A fuel station's fuels and prices, tanks, dispensing units and nozzles, stamped measures and tolerances.
        { section: "fuel-pumps", label: "Pumps & nozzles", icon: "serviceSettings", need: "settings.view", module: "fuel", types: FUEL },
        // A lodging business's room types with their rates and rooms, the GST slabs of a room night, the weekend nights.
        { section: "lodging-rates", label: "Room types & rates", icon: "serviceSettings", need: "lodging.view", types: LODGING },
      ],
    },
    {
      title: "Staff & access",
      links: [
        { section: "staff", label: "Staff & access", icon: "users", need: "access.view" },
        { section: "roles", label: "Roles & permissions", icon: "roles", need: "access.view" },
      ],
    },
  ];
}

// The menu this person sees in this business, as the main layout draws it.
export function businessMenu(businessId, type, can, has) {
  const rules = businessSections(type).flatMap((group) => group.links);
  const allowed = (link) => link && typeAllows(link, type) && (!link.need || can(link.need)) && (!link.module || has(link.module));
  return dailyWorkspaces(type).map((group) => ({
    title: group.title,
    links: group.keys.map((key) => {
      const names = WORKSPACES[key] ? workspaceSections(key, type) : [key];
      const available = names.map((name) => rules.find((link) => link.section === name && typeAllows(link, type))).filter(allowed);
      const link = available[0];
      if (!link) return null;
      const to = (item) => (item.href ? item.href(businessId) : businessPath(businessId, item.section));
      // Every page of the area, for quick access and "Jump to…" (the menu shows the area once).
      const pages = available.map((item) => ({ to: to(item), label: workspaceLabel(item.section, type, item.label), icon: item.icon, end: item.end }));
      // Settings keeps its name whoever looks (a stock keeper's first page there is
      // Units & pack sizes), so a hint can say "Settings › Units & pack sizes";
      // so does a farm-input shop's Farm inputs area ("Farm inputs › Molecules").
      return { to: to(link), label: key === 'tasks' ? 'Tasks' : key === 'settings' ? 'Settings' : key === 'farm' ? 'Farm inputs' : workspaceLabel(link.section, type, link.label),
        icon: link.icon, end: link.end, section: link.section, activeSections: available.map((item) => item.section), pages };
    }).filter(Boolean),
  })).filter((group) => group.links.length);
}

// Whether a screen belongs to this business type (the `types` and `except` rules).
export const typeAllows = (link, type) => (!link.types || link.types.includes(type)) && (!link.except || !link.except.includes(type));

// The rule a section follows (permission, module, business types), for the page guard.
// A section listed twice (once for some types, once for the others) answers
// with the entry that belongs to this type.
export function sectionRule(section, type) {
  const links = businessSections(type).flatMap((group) => group.links.filter((l) => l.section === section));
  return links.find((l) => typeAllows(l, type)) || links[0] || null;
}
