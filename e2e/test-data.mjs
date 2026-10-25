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
  // The tent house's manager, who approves money handed back from a deposit with a PIN of their own.
  { role: "RENTALS_MANAGER", name: "Arjun Menon", email: "manager@rentals.e2e.invalid", businesses: ["rentals"] },
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
  general_retail: { name: "Lakshmi General Stores & Gifts", code: "E2E-GENERAL-RETAIL" },
  hardware: { name: "Shree Ram Hardware & Paints", code: "E2E-HARDWARE" },
  agri_inputs: { name: "Kisan Agro Seeds & Fertilisers", code: "E2E-AGRI-INPUTS" },
  optical: { name: "Clear Vision Opticals", code: "E2E-OPTICAL" },
  garage: { name: "Speed Auto Garage & Spares", code: "E2E-GARAGE" },
  jewellery: { name: "Swarna Lakshmi Jewellers", code: "E2E-JEWELLERY" },
  fuel_station: { name: "Highway Fuel Station", code: "E2E-FUEL-STATION" },
  memberships: { name: "Fit Zone Gym & Yoga Studio", code: "E2E-MEMBERSHIPS" },
  laundry: { name: "Sparkle Laundry & Dry Cleaners", code: "E2E-LAUNDRY" },
  rentals: { name: "Sai Tent House & Rentals", code: "E2E-RENTALS" },
  lodging: { name: "Green Park Lodge & Guest House", code: "E2E-LODGING" },
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

// The seeds, fertilisers & pesticides shop: subsidised urea by the bag, a
// chlorpyrifos pesticide by the bottle and paddy seed by the kilo (both kept by
// batch), received from the supplier; its three licences; and a farmer.
export const AGRI = {
  supplier: "IFFCO depot, Shamshabad",
  urea: { name: "Neem coated urea 45 kg", unit: "bag", price: 266.5, mrp: 266.5, hsn: "3102" },
  pesticide: { name: "Chlorpyrifos 20% EC 500 ml", unit: "bottle", price: 420, mrp: 450, hsn: "3808", molecule: "Chlorpyrifos", formulation: "20% EC", lot: "CP-11",
    manufacturer: "Dhanuka Agritech" },
  seed: { name: "Paddy seed BPT 5204", unit: "kg", price: 60, crop: "Paddy", variety: "BPT 5204", lot: "P-2601" },
  licences: [
    { kind: "fertiliser", name: "Fertiliser authorisation letter (Form A2)", licenceNo: "FAL/RR/2025/1187", covers: ["fertiliser"] },
    { kind: "seed", name: "Seed dealer licence (Form B)", licenceNo: "SDL/1123/2025", covers: ["seed"] },
    { kind: "insecticide", name: "Insecticide sale licence (Form VIII)", licenceNo: "INS/RR/0457", covers: ["insecticide"] },
  ],
  farmer: { name: "Ramaiah Goud", phone: "9848012345", village: "Kothur", relativeName: "Venkaiah Goud", landAcres: "3.5", crops: "Paddy, cotton" },
};

// The hardware shop: cement by the bag and binding wire by the kilo in 25 kg
// coils, received from the supplier, and a contractor with a site who asks for
// quotations.
export const HARDWARE = {
  supplier: "Ambuja Cement Depot",
  contractor: { name: "Sharma Constructions", phone: "9845012345" },
  site: { name: "Whitefield villa", address: "Plot 14, Whitefield, Bengaluru" },
  cement: { name: "UltraTech OPC 53 grade cement 50 kg", unit: "bag", price: 395, mrp: 450, hsn: "2523" },
  wire: { name: "Binding wire 20 gauge", unit: "kg", price: 95.5, hsn: "7217" },
  // Floor tiles by the box, each box covering 16 sq ft (for the tile calculator).
  tiles: { name: "Vitrified floor tiles 2 x 2 ft, box of 4", unit: "box", price: 1200, hsn: "6907", coverage: 16 },
  packUnit: "coil",
  packSize: 25,
  // A painter who brings customers, earning 2 rupees on every bag of cement.
  fitter: { name: "Ramesh Kumar", trade: "painter", phone: "9845098450", upiId: "ramesh@okicici", perBag: 2 },
};

// The optical shop: a frame and a single-vision lens kept in stock and the
// fitting charge as a service, received from the distributor; a customer with
// today's prescription, and one whose last eye test is over a year old (on the
// recall list).
export const OPTICAL = {
  supplier: "Vision Distributors, Abids",
  frame: { name: "Titan Eye+ TE-1001 black", code: "FR-TE1001", price: 2499, mrp: 2499, hsn: "90031100" },
  lens: { name: "Single vision 1.56 anti-reflective lens", code: "LN-SV156", price: 1250, hsn: "90015000" },
  fitting: { name: "Fitting charges", code: "SV-FIT", price: 99.5 },
  customer: { name: "Anitha Reddy", phone: "9876543210" },
  due: { name: "Lakshmi Devi", phone: "9000012345", daysAgo: 400 },
  lab: "Crystal Lens Lab",
};

// The garage: engine oil and an oil filter kept in stock, received from the
// spares dealer, and service labour; a customer's car with its last reading
// (its insurance running out within the month), and a scooter due for its
// service in a few days.
export const GARAGE = {
  supplier: "Sri Sai Auto Spares, Kukatpally",
  oil: { name: "Engine oil 5W-30", code: "OIL-5W30", unit: "litre", price: 449.9, mrp: 480, hsn: "27101980" },
  filter: { name: "Oil filter (Swift)", code: "FLT-SW", unit: "each", price: 380, mrp: 400, hsn: "84212300" },
  labour: { name: "General service labour", code: "LAB-GEN", price: 1000, sac: "998714" },
  car: { registrationNo: "TS09EA4521", make: "Maruti Suzuki", model: "Swift", variant: "VXi", fuel: "petrol", odometerKm: 41250, insuranceInDays: 20 },
  owner: { name: "Lakshmi Prasad", phone: "9876501234" },
  scooter: { registrationNo: "TS10EV0042", make: "Honda", model: "Activa 6G", fuel: "petrol", serviceInDays: 3 },
  scooterOwner: { name: "Kiran Reddy", phone: "9123456780" },
};

// The gym: a monthly plan at 5% GST with a joining fee, two freezes and grace
// days; a pack of yoga classes; and a three-day trial. A member holds the
// monthly plan (paid; their card's code is checked in at the desk) and
// another the trial, which ends in two days.
export const MEMBERSHIPS = {
  joining: { name: "Joining fee", code: "GYM-JOIN", price: 500, sac: "999723" },
  monthly: { name: "Gym monthly", price: 1500, freezes: 2, freezeDays: 15, grace: 3 },
  yoga: { name: "Yoga 10 classes", price: 2000, sessions: 10 },
  trial: { name: "Three-day trial", price: 300, days: 3 },
  policy: "If you cancel, the fee for the days (or sessions) you have not used is refunded pro rata. The joining fee is not refunded.",
  member: { name: "Deepa Menon", phone: "9876500101" },
  trialMember: { name: "Rahul Verma", phone: "9876500102" },
};

// The laundry: dry cleaning (SAC 999712), wash and iron, and wash and fold by
// the kilo, each its own service item at 18% GST; shirts, sarees and mixed
// clothes on the price list; express at 50% on each garment, and the terms
// printed on every receipt. A customer has an order taken in, billed when it
// is handed over: two shirts for wash and iron under one tag, and a saree for
// dry cleaning with a stain noted and acknowledged.
export const LAUNDRY = {
  dryCleaning: { name: "Dry cleaning", sac: "999712" },
  washIron: { name: "Wash & iron" },
  washFold: { name: "Wash & fold" },
  shirt: { name: "Shirt", washIron: 40, dryCleaning: 120 },
  saree: { name: "Saree", dryCleaning: 350 },
  mixed: { name: "Mixed clothes", washFoldKg: 89.9 },
  express: 50,
  terms: "Please check your garments when you collect them, and tell us of any problem the same day.",
  customer: { name: "Sunita Kapoor", phone: "9876500201" },
};

// The jeweller: the morning's rates from the local association, set on the
// business's own date; a gold ring and a gold chain as jewellery items (22K,
// HSN 7113, making by the gram and wastage), and the hallmarking charge a new
// hallmarked piece starts with; its location's district under mandatory
// hallmarking, and its BIS registration. In stock as opening stock: three 22K
// rings, each hallmarked with its HUID (one for each bill the specs make: at
// the counter, against old gold, and for a gold scheme), and a 22K chain of
// 8.2 g with no hallmark, which the bill refuses. A customer brought in an old
// 22K chain, valued at the day's buy rate and not paid out; another is
// enrolled in an 11-month gold scheme with three instalments paid by UPI.
export const JEWELLERY = {
  rates: [
    { metal: "gold", purity: "24K", sell: 12850, buy: 12600 },
    { metal: "gold", purity: "22K", sell: 11780, buy: 11500 },
    { metal: "gold", purity: "18K", sell: 9640, buy: 9350 },
    { metal: "silver", purity: "999", sell: 165, buy: 158 },
  ],
  hallmarkCharge: 45,
  district: "Hyderabad",
  bis: { name: "BIS registration (hallmarking)", licenceNo: "HM/C-7190047651", authority: "Bureau of Indian Standards" },
  ring: { name: "Gold ring", code: "JWL-RING", wastage: 8, makingPerGram: 450 },
  chain: { name: "Gold chain", code: "JWL-CHAIN", wastage: 6, makingPerGram: 350 },
  counterRing: { description: "Ruby ring", gross: "4.400", stones: "0.150", huid: "JR4A01", ruby: { carat: "0.750", value: 1200 } },
  exchangeRing: { description: "Plain band", gross: "3.800", huid: "JR4B02" },
  schemeRing: { description: "Ladies ring", gross: "2.500", huid: "JR4C03" },
  unmarkedChain: { description: "Rope chain", gross: "8.200" },
  oldGold: {
    seller: { name: "Meenakshi Sundaram", phone: "9876500301" },
    idKind: "voter_id", idRef: "TSV1234567",
    line: { description: "Old chain", gross: "3.050", less: "0.050", tested: "916.0", deduction: "2" },
  },
  plan: {
    name: "Swarna 11", instalments: 11, minInstalment: 1000, discountPercent: 100,
    terms: "Pay the same amount each month for 11 months. With all 11 paid, one month's amount comes off your jewellery bill as a discount, from a month after the last instalment. The scheme is turned into jewellery within the year and is never paid back in money.",
  },
  member: { name: "Padmavathi Rao", phone: "9876500302", instalment: 5000, instalmentsPaid: 3, nominee: "Suresh Rao", relation: "Son" },
};

// The tent house: a 15 kVA generator hired one by one (two units, each with
// its hour meter), plastic chairs from a pool of 200, and a sound system hired
// by the day with a late fee by the day; each billed as its own service item
// at 18% GST, before GST. Three bookings: the first generator booked for
// tomorrow; a sound system handed over with its deposit a day ago and now three
// hours past its due back time; and the other generator with 100 chairs, going
// out now and not handed over yet.
export const RENTALS = {
  sac: "997329",
  generator: { name: "Generator 15 kVA", code: "RNT-GEN15", rates: { hour: "400", day: "2500" }, deposit: 5000, minHours: 4, turnaround: 60, grace: 30,
    units: [{ label: "Gen A", serialNo: "GX-101", meter: "1200.0" }, { label: "Gen B", serialNo: "GX-102", meter: "850.0" }] },
  chairs: { name: "Plastic chair", code: "RNT-CHAIR", rates: { day: "10" }, deposit: 5, pool: 200 },
  sound: { name: "Sound system", code: "RNT-SOUND", rates: { day: "2000" }, deposit: 5000, lateRate: 1000, grace: 30,
    units: [{ label: "Sound 1", serialNo: "SND-01" }, { label: "Sound 2", serialNo: "SND-02" }] },
  terms: "The hirer looks after everything hired and returns it by the due back time, in the condition noted at the handover.",
  // The first generator, tomorrow on the business's clock.
  booked: { hirer: { name: "Venkat Rao", phone: "9876500401" }, from: "09:00", until: "21:00" },
  // The sound system: out for a day from a day and three hours ago.
  late: { hirer: { name: "Lalitha Devi", phone: "9876500402" }, idKind: "voter_id", idRef: "TSV7654321", minutesPastDue: 180 },
  // The other generator and the chairs, out now for 26 hours.
  going: { hirer: { name: "Srinivas Naidu", phone: "9876500403" }, chairs: 100, hours: 26 },
};

// The salon: one stylist and one service.
export const SALON = {
  stylist: { name: "Priya Sharma", role: "Senior stylist" },
  service: { name: "Haircut", price: 300 },
};
