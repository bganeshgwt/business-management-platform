// What the browser tests' shared data is made of. The global set-up makes
// exactly this, through the API (build-data.mjs), and the specs import these
// names and figures (through fixture.mjs) instead of typing them again, so a
// check never depends on data someone happened to have.

// The restaurant's clock: its business day and its reports' dates.
export const TIMEZONE = "Asia/Kolkata";

// One login per role a spec signs in as. Passwords are made fresh for every
// run and are written only to the run's own file under test-results.
//
// SHOP_MANAGER works in a few of the owner's businesses (`businesses`, keys
// of BUSINESSES below), as their manager, and not in the restaurant. Opening
// a business from the header's switcher changes where a login lands after
// signing in, so the switcher is tried with this login only: every other
// login keeps landing where the specs expect it to.
export const LOGINS = [
  { role: "SUPER_ADMIN", name: "Platform admin", email: "platform@e2e.invalid" },
  { role: "RESTAURANT_ADMIN", name: "Asha Rao", email: "owner@bistro.e2e.invalid" },
  { role: "CASHIER", name: "Ravi Kumar", email: "cashier@bistro.e2e.invalid" },
  { role: "CAPTAIN", name: "Suresh Nair", email: "captain@bistro.e2e.invalid" },
  { role: "KITCHEN", name: "Meena Iyer", email: "kitchen@bistro.e2e.invalid" },
  { role: "SHOP_MANAGER", name: "Kavya Reddy", email: "manager@shops.e2e.invalid", businesses: ["books", "grocery", "pharmacy", "wholesale", "salon"] },
];

// The restaurant the RESTAURANT_ADMIN runs. Tables 1-3 are free; table 4
// has a running order; table 5 (leftOpen) has an order left open from an
// earlier day. Every table belongs to no outlet, so "All outlets" sees them
// all.
export const RESTAURANT = {
  name: "E2E Bistro",
  code: "E2EBISTRO",
  outlets: [
    { name: "Koramangala", code: "KRM" },
    { name: "Indiranagar", code: "IND" },
  ],
  floor: "Ground floor",
  tables: ["1", "2", "3", "4"],
  busyTable: "4",
  categories: ["Starters", "Main course"],
  products: [
    { name: "Paneer tikka", category: "Starters", price: 260, foodType: "veg" },
    { name: "Chicken 65", category: "Starters", price: 280, foodType: "non_veg" },
    { name: "Dal makhani", category: "Main course", price: 240, foodType: "veg" },
    { name: "Butter naan", category: "Main course", price: 60, foodType: "veg" },
  ],
  modifier: { name: "Extra butter", price: 30 },
  expenseCategory: "Kitchen supplies",
  stockUnit: { name: "Kilogram", shortName: "kg" },
  // One item well stocked, one under its reorder level, one run out.
  stockItems: [
    { name: "Basmati rice", reorderLevel: 10, openingStock: 25, cost: 90 },
    { name: "Paneer", reorderLevel: 5, openingStock: 2, cost: 320 },
    { name: "Ghee", reorderLevel: 4, openingStock: 0, cost: 600 },
  ],
  // Today's business: a takeaway billed and paid in cash, and a dine-in
  // order still running on the busy table.
  paidTakeaway: [{ product: "Paneer tikka", quantity: 2 }, { product: "Butter naan", quantity: 2 }],
  runningOrder: [{ product: "Dal makhani", quantity: 1 }, { product: "Butter naan", quantity: 2 }],
  // A dine-in order taken two days ago and never billed or closed, on a
  // table of its own: the dashboard flags it as left open, and a cashier
  // may bill or cancel it.
  leftOpen: { tableNo: "5", daysAgo: 2, items: [{ product: "Chicken 65", quantity: 1 }] },
};

// The platform holds this many restaurants in all (E2E Bistro and the rest
// named "E2E Restaurant 01" and on), so its list has two pages of 25.
export const PLATFORM = { restaurants: 50, otherName: "E2E Restaurant" };

// One business of every type besides a restaurant, all owned by the
// RESTAURANT_ADMIN, each with the specialist tools its trade uses switched on.
export const BUSINESSES = {
  grocery: { name: "Sri Ganesh Kirana Stores", code: "E2E-GROCERY" },
  supermarket: { name: "Annapoorna Super Market", code: "E2E-SUPERMARKET" },
  wholesale: { name: "Mahalakshmi FMCG Distributors", code: "E2E-WHOLESALE" },
  fashion: { name: "Navrang Garments & Textiles", code: "E2E-FASHION" },
  electronics: { name: "City Mobiles & Electronics", code: "E2E-ELECTRONICS" },
  pharmacy: { name: "Sri Balaji Medical Stores", code: "E2E-PHARMACY" },
  books: { name: "Saraswati Book Depot & Stationers", code: "E2E-BOOKS" },
  salon: { name: "Shine Unisex Salon & Spa", code: "E2E-SALON" },
  healthcare: { name: "Lifeline Family Clinic & Diagnostics", code: "E2E-HEALTHCARE" },
  meat: { name: "Fresh Catch Chicken, Mutton & Fish", code: "E2E-MEAT" },
  weight_retail: { name: "Bansal Dry Fruits & Spices", code: "E2E-WEIGHT-RETAIL" },
};

// The grocery: rice sold loose by weight and in 1 kg packs, both received
// into its MAIN location from the supplier, and one sale paid in cash today.
export const GROCERY = {
  supplier: "Sri Lakshmi Traders",
  weighedItem: { name: "Loose rice", unit: "kg", price: 62 },
  pieceItem: { name: "Basmati rice 1 kg", unit: "each", price: 145 },
  sale: [{ item: "Loose rice", quantity: 2 }, { item: "Basmati rice 1 kg", quantity: 1 }],
};

// The meat shop: two cuts sold by weight, received from the supplier.
export const MEAT = {
  supplier: "Fresh Farms Poultry",
  items: [
    { name: "Chicken curry cut", unit: "kg", price: 240 },
    { name: "Chicken breast", unit: "kg", price: 320 },
  ],
};

// The wholesaler: noodles counted in pieces and sold by the case, and a
// retailer who owes for one case bought on credit today.
export const WHOLESALE = {
  supplier: "Deccan Foods Distributors",
  customer: "Om Sai Kirana",
  item: { name: "Instant noodles 70 g", unit: "each", price: 12 },
  packUnit: "case",
  packSize: 96,
  creditSale: { quantity: 96 },
};

// The salon: one stylist and one service.
export const SALON = {
  stylist: { name: "Priya Sharma", role: "Senior stylist" },
  service: { name: "Haircut", price: 300 },
};
