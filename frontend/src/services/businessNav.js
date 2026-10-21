// The Business Admin's menu for one business, built from what the business
// has switched on and what this person's role allows. The server checks the
// same two things on every request; the menu only hides what would be refused.

import { dailyWorkspaces, WORKSPACES, workspaceLabel, workspaceSections } from './businessWorkspace.js';

export const businessPath = (id, section = "") => `/business-admin/${id}${section ? `/${section}` : ""}`;

// Someone who works in the signed-in restaurant (has a restaurant role). A
// kirana cashier is a user too, but only has business memberships.
export const isRestaurantStaff = (user) => Boolean(user?.restaurantId) && Array.isArray(user?.roles) && user.roles.length > 0;

// Where a person lands after signing in: the business they used last; someone
// with no restaurant role falls back to the first business in their list
// (round 2, R2-CORE). null = stay on the restaurant's home screen.
export function landingBusiness(businesses, restaurantStaff) {
  const list = businesses || [];
  const recent = [...list].filter((b) => b.last_opened_at)
    .sort((a, b) => String(b.last_opened_at).localeCompare(String(a.last_opened_at)))[0];
  const pick = recent || (restaurantStaff ? null : list[0] || null);
  if (!pick || (restaurantStaff && pick.is_signed_in_restaurant)) return null;
  return pick;
}

// Words a business of each type uses for the same screens.
const TYPE_WORDS = {
  salon: { customers: "Clients", products: "Services & products", resources: "Stylists & rooms", sales: "Bills", appointments: "Appointment history" },
  // Round 2: patients have their own screen (with consent); the core list is the billing contacts.
  healthcare: { customers: "Billing contacts", products: "Services & charges", resources: "Doctors & rooms", sales: "Bills" },
  pharmacy: { products: "Medicines & products" },
  // Shared receivables (Phase 2): a kirana calls customer credit "udhaar".
  grocery: { outstanding: "Udhaar", collections: "Udhaar collections" },
  books: { products: "Books & stationery" },
  wholesale: { customers: "Customers & retailers", pricing: "Price lists" },
  fashion: { products: "Products & variants", variants: "Size × colour" },
  electronics: { products: "Products & models" },
  // Pro pass F-15/F-23: a meat shop's customer rates; a dry-fruit shop sorts and repacks.
  meat: { pricing: "Customer rates" },
  weight_retail: { pricing: "Customer rates", processing: "Sorting & repacking" },
};
export const word = (type, key, fallback) => TYPE_WORDS[type]?.[key] || fallback;

// One icon per business type, from the shared Icon set, for the switcher.
export const TYPE_ICONS = {
  restaurant: "utensils", grocery: "store", supermarket: "grid", wholesale: "truck", fashion: "tag",
  electronics: "zap", pharmacy: "heart", books: "book", salon: "sparkles", healthcare: "activity",
  meat: "scale", weight_retail: "scale",
};

// Retail screens (Quick bill, Udhaar, Retail reports) belong to these types.
const RETAIL = ["grocery", "supermarket", "books"];
// Weight-based shops (Phase 2, T4) bill loose weighed goods at the same counter.
const WEIGHED = ["meat", "weight_retail"];
const SALON = ["salon"];
// Round 2 (health module): pharmacy rules, and patients and the lab of a clinic.
const PHARMACY = ["pharmacy"];
const CLINIC = ["healthcare"];
// Pro pass: every goods shop bills at the counter (Quick bill), keeps udhaar
// for named customers and closes its day there.
export const GOODS = [...RETAIL, "pharmacy", "fashion", "electronics", ...WEIGHED];

// section: the URL piece under /business-admin/<id>/; need: the permission
// (its module must be on too); module: an extra module the screen needs;
// types: only for these business types; except: not for these types.
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
        // Phase 2, T4: the salon's bill and calendar.
        { section: "salon-bill", label: "New bill", icon: "pos", need: "sales.create", types: SALON },
        { section: "salon-calendar", label: "Calendar", icon: "reservations", need: "appointments.view", types: SALON },
        // Pro pass F-16: phone and WhatsApp orders for pickup at a weight shop.
        { section: "pickup-orders", label: "Orders for pickup", icon: "pickup", need: "sales.view", module: "weight", types: WEIGHED },
        { section: "sales", label: word(type, "sales", "Sales"), icon: "bills", need: "sales.view" },
        { section: "customers", label: word(type, "customers", "Customers"), icon: "customers", need: "contacts.view" },
        { section: "udhaar", label: "Udhaar", icon: "dues", need: "receivables.view", types: GOODS },
        // Pro pass C-19: a shop's udhaar collections sit right under Udhaar, one name for every shop.
        { section: "collections", label: "Udhaar collections", icon: "collection", need: "receivables.view", types: GOODS },
        // Pro pass C-24: school booklists and customer orders (bookshops).
        { section: "book-orders", label: "Booklists & orders", icon: "orders", need: "sales.view", module: "books" },
        { section: "offers", label: "Offers & discounts", icon: "discounts", need: "offers.view" },
        { section: "loyalty", label: "Loyalty points", icon: "loyalty", need: "loyalty.view" },
        { section: "appointments", label: word(type, "appointments", "Appointments"), icon: "reservations", need: "appointments.view" },
        // A salon edits its stylists and rooms under Stylists & services (pro pass F-12).
        { section: "resources", label: word(type, "resources", "Staff & rooms"), icon: "employees", need: "appointments.view", except: SALON },
        { section: "pricing", label: word(type, "pricing", "Wholesale prices"), icon: "priceList", need: "wholesale.view" },
        { section: "price-groups", label: "Price groups & schemes", icon: "discounts", need: "wholesale.view", module: "sales_orders" },
        // Phase 2, T2: wholesale orders and the shared receivables screens.
        { section: "sales-orders", label: "Sales orders", icon: "orders", need: "sales_orders.view" },
        { section: "dispatch", label: "Dispatch", icon: "deliveries", need: "sales_orders.view" },
        { section: "back-orders", label: "Back-orders", icon: "pickup", need: "sales_orders.view" },
        // Retail shops see the same balances on their Udhaar screen (with reminders).
        { section: "outstanding", label: word(type, "outstanding", "Outstanding"), icon: "dues", need: "receivables.view", except: GOODS },
        { section: "collections", label: word(type, "collections", "Collections"), icon: "collection", need: "receivables.view", except: GOODS },
        { section: "routes", label: "Routes & salespeople", icon: "deliveries", need: "sales_orders.view" },
        // Phase 2, T3: fashion exchanges, electronics repairs and warranties.
        { section: "exchanges", label: "Exchanges", icon: "returns", need: "exchanges.view" },
        { section: "repairs", label: "Repairs", icon: "repair", need: "repairs.view" },
        { section: "warranties", label: "Warranties", icon: "warranty", need: "warranties.view" },
        // Round 2: EMI sales owed by financiers, and their payouts.
        { section: "emi-finance", label: "EMI & financiers", icon: "wallet", need: "finance.view" },
        // Phase 2, T4: salon packages and memberships.
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
        { section: "clinic-today", label: "Today's patients", icon: "reservations", need: "patients.view", types: CLINIC },
        { section: "clinic-queue", label: "Token queue", icon: "collection", need: "patients.view", types: CLINIC },
        { section: "patients", label: "Patients", icon: "customers", need: "patients.view", types: CLINIC },
        { section: "visits", label: "Visits & follow-ups", icon: "logbook", need: "patients.view", types: CLINIC },
        { section: "lab-orders", label: "Lab orders", icon: "inventoryInsights", need: "lab.view", types: CLINIC },
        { section: "lab-tests", label: "Tests & panels", icon: "categories", need: "lab.view", types: CLINIC },
        { section: "lab-qc", label: "Quality control", icon: "activity", need: "lab.view", types: CLINIC },
        { section: "doctors", label: "Doctors, fees & OPD", icon: "employees", need: "appointments.view", types: CLINIC },
      ],
    },
    {
      title: "Purchases",
      links: [
        { section: "purchases", label: "Purchases", icon: "purchaseOrders", need: "purchasing.view" },
        // Round 2: purchase orders to the company / super-stockist (wholesale).
        // Every shop that buys stock raises purchase orders (reorder suggestions per branch).
        { section: "purchase-orders", label: "Purchase orders", icon: "purchaseOrders", need: "purchasing.view", module: "inventory" },
        { section: "suppliers", label: "Suppliers", icon: "suppliers", need: "contacts.view", module: "purchasing" },
        { section: "claims", label: "Claims on suppliers", icon: "returns", need: "purchasing.view", module: "sales_orders" },
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
        // Round 2: a kit / bundle sells as its parts (goods shops).
        { section: "kits", label: "Kits & bundles", icon: "box", need: "catalog.view", module: "inventory", types: GOODS },
        { section: "salon-setup", label: "Stylists & services", icon: "hours", need: "appointments.view", types: SALON },
        { section: "rates", label: "Today's rates", icon: "priceList", need: "catalog.view", module: "weight", types: WEIGHED },
      ],
    },
    {
      title: "Stock",
      links: [
        { section: "stock", label: "Stock on hand", icon: "stock", need: "inventory.view" },
        { section: "movements", label: "Stock movements", icon: "movements", need: "inventory.view" },
        // Pro pass C-14: batches running out of date, with markdown and write-off.
        { section: "near-expiry", label: "Expiring soon", icon: "hours", need: "inventory.view", module: "batches" },
        { section: "transfers", label: "Transfers", icon: "transfers", need: "stock_transfers.view" },
        { section: "counts", label: "Stock counts", icon: "counts", need: "stock_counts.view" },
        { section: "serials", label: "Serial / IMEI register", icon: "numbering", need: "inventory.view", module: "serials" },
        // Phase 2, T4: weight-based shops.
        { section: "weight-stock", label: "Stock by weight", icon: "inventoryInsights", need: "inventory.view", module: "weight", types: WEIGHED },
        { section: "processing", label: WEIGHED.includes(type) ? "Cutting & processing" : word(type, "processing", "Cutting & yield"), icon: "kitchen", need: "processing.view" },
        { section: "wastage", label: "Wastage", icon: "returns", need: "wastage.view" },
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
        { section: "activity", label: "Activity log", icon: "activity", need: "audit.view" },
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
      // Every page of the area, for quick access and "Jump to…" (the menu shows the area once).
      const pages = available.map((item) => ({ to: businessPath(businessId, item.section), label: workspaceLabel(item.section, type, item.label), icon: item.icon, end: item.end }));
      return { to: businessPath(businessId, link.section), label: key === 'tasks' ? 'Tasks' : workspaceLabel(link.section, type, link.label),
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
