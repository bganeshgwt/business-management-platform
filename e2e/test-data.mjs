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
// of BUSINESSES below), as their manager, and not in the restaurant. A login
// with a `businessRole` has that role of its trade there instead. Opening
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
  // The fuel station's pump attendant, who opens and closes their own shift.
  { role: "PUMP_ATTENDANT", name: "Mahesh Yadav", email: "attendant@fuel.e2e.invalid", businesses: ["fuel_station"], businessRole: "pump_attendant" },
  // The lodge's housekeeping, who makes the rooms up after the guests leave.
  { role: "HOUSEKEEPER", name: "Lakshmi Bai", email: "housekeeping@lodge.e2e.invalid", businesses: ["lodging"], businessRole: "housekeeping" },
  // The clinic's people (clinic-lab.spec.js): the front desk, a doctor with
  // their own queue, the lab technician and the pathologist who signs with a
  // PIN of their own.
  { role: "RECEPTION", name: "Divya Menon", email: "desk@clinic.e2e.invalid", businesses: ["healthcare"], businessRole: "cashier" },
  { role: "DOCTOR", name: "Ravi Shankar", email: "doctor@clinic.e2e.invalid", businesses: ["healthcare"], businessRole: "doctor" },
  { role: "LAB_TECH", name: "Imran Sheikh", email: "lab@clinic.e2e.invalid", businesses: ["healthcare"], businessRole: "lab_technician" },
  { role: "PATHOLOGIST", name: "Anitha Rao", email: "pathologist@clinic.e2e.invalid", businesses: ["healthcare"], businessRole: "pathologist" },
  // An owner of businesses of their own, apart from the restaurant's
  // (gst-thresholds.spec.js), made with them by the platform; and the manager
  // of one of them, made in its Staff & access. Both are made with
  // GST_THRESHOLDS below.
  { role: "GST_OWNER", name: "Prakash Rao", email: "owner@thresholds.e2e.invalid", gstOwner: true },
  { role: "GST_MANAGER", name: "Kiran Kumar", email: "manager@thresholds.e2e.invalid", gstOwner: true },
  // The hardware shop's manager, who lets a tinted tin come back with a PIN of their own.
  { role: "HARDWARE_MANAGER", name: "Prakash Shetty", email: "manager@hardware.e2e.invalid", businesses: ["hardware"] },
  // The general store's cashier, with a PIN of their own, whom its shared till
  // is switched to (small-items.spec.js).
  { role: "TILL_CASHIER", name: "Deepak Rao", email: "cashier@general.e2e.invalid", businesses: ["general_retail"], businessRole: "cashier" },
  // The garage's mechanic, on a job card of their own (business-garage-more.spec.js).
  { role: "MECHANIC", name: "Raju Goud", email: "mechanic@garage.e2e.invalid", businesses: ["garage"], businessRole: "mechanic" },
];

// The staff login a spec makes in the grocery's Staff & access, as the owner
// makes one: a cashier, who chooses their own password at the first sign-in.
// The spec makes its e-mail address and both passwords fresh on each run.
export const NEW_STAFF = { name: "Nisha Verma", emailName: "nisha", role: "Cashier / sales" };

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
  // A banquet over ₹2,00,000 for a caterer from the guest book: its bill asks
  // for the buyer's PAN, refuses cash of ₹2,00,000 or more, and takes the
  // rest by UPI. The dish is on the menu and the caterer in the guest book;
  // the spec places the order itself.
  banquet: {
    dish: { name: "Banquet thali", category: "Main course", price: 1500, foodType: "veg" },
    thalis: 150,
    guest: { name: "Lakshmi Caterers", mobile: "9845098450" },
    pan: "AAACL1234K",
    cash: 150000,
    // A regular whose guest book keeps their PAN: their banquet bill takes it
    // with its first payment, and nobody types it (restaurant-cash-pan.spec.js).
    regular: { name: "Kavya Events", mobile: "9845098451", pan: "AAKCK5678M" },
  },
  // The captain app (captain.spec.js): a garden floor whose tables are the
  // CAPTAIN's section today (Tables & QR → Captain sections), none tied to an
  // outlet; and a dish in two sizes with an add-on, for an order taken there.
  captain: {
    floor: "Garden",
    tables: ["G1", "G2", "G3"],
    dish: {
      name: "Veg biryani", category: "Main course", price: 240, foodType: "veg",
      sizes: [{ name: "Half", price: 160 }, { name: "Full", price: 240, isDefault: true }],
      addOn: { name: "Raita", price: 40 },
    },
  },
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

// Personal data: every shop's privacy notice is published from its starter
// text, with one privacy contact for them all. In the grocery
// (personal-data.spec.js): a customer the counter takes with what they agree
// to be sent, a customer who asks to see their data and then to erase it,
// and one whose details were on the laptop of a breach.
export const PRIVACY = {
  contact: { name: "Shalini Nair", phone: "98450 11111" },
  counterCustomer: { name: "Kamala Devi", phone: "9845500021" },
  requester: { name: "Arif Khan", phone: "9845500022", asked: "Send me what the shop keeps about me, and then erase it" },
  affected: { name: "Farida Begum", phone: "9845500023" },
  breach: {
    whatHappened: "The counter laptop with the customer list was stolen from the shop",
    impact: "Customers' names and phone numbers may be seen by others",
    stepsTaken: "Changed every password and told the police",
    boardReference: "DPB/2026/0042",
  },
};

// GST rates by date: two biscuits the grocery sells at 18%, which the spec
// moves to 5% from the next 1 April and then cancels again; and the
// restaurant's butter naan, moved to its 18% rate the same way.
export const GST_CHANGE = {
  items: [
    { name: "Marie gold biscuit 250 g", code: "MARIE-250", price: 59, hsn: "19053100" },
    { name: "Cream biscuit 120 g", code: "CREAM-120", price: 35, hsn: "19053200" },
  ],
  search: "biscuit",
  dish: "Butter naan",
  reason: "GST Council notification of 8 October 2026",
};

// An owner's GST thresholds (gst-thresholds.spec.js): the GST_OWNER's own
// businesses. The hardware shop and the building supplies store in another
// state trade under one PAN (their GSTINs carry it) and sold ₹5.1 crore of
// contract supplies today on the GST nil slab: past ₹5 crore this year, so
// e-invoicing and 6-digit HSN / SAC codes apply from the next 1 April; the
// hardware shop's contract supply has a 4-digit SAC code to fix. The firm,
// under its own PAN, sold ₹6 crore last financial year (moved there by SQL)
// and nothing this year: they apply to its invoices now, and its supply's
// 4-digit SAC code is to fix. The kirana has no GSTIN: it counts under no PAN
// until the spec records its PAN. The GST_MANAGER manages the hardware shop.
export const GST_THRESHOLDS = {
  pan: "ABCPR1234K",
  hardware: { type: "hardware", name: "Rao Hardware & Paints", code: "E2E-GST-HARDWARE", gstin: "36ABCPR1234K1ZO",
    item: { name: "Site supply contract", code: "SITE-SUPPLY", price: "10000000", sac: "9954" }, quantity: 3 },
  supplies: { type: "general_retail", name: "Rao Building Supplies", code: "E2E-GST-SUPPLIES", gstin: "29ABCPR1234K1ZJ",
    item: { name: "Bulk cement supply", code: "BULK-CEMENT", price: "21000000", sac: "995411" }, quantity: 1 },
  firm: { type: "general_retail", name: "Rao & Sons Traders", code: "E2E-GST-FIRM", gstin: "36AAFFR1234L1Z6", pan: "AAFFR1234L",
    item: { name: "Institutional supply", code: "INST-SUPPLY", price: "60000000", sac: "9963" }, quantity: 1, lastYear: true },
  kirana: { type: "grocery", name: "Rao Kirana Stores", code: "E2E-GST-KIRANA" },
  buyer: { name: "Ravi Constructions", pan: "AABCR1234Q" },
  // The full code the spec gives the hardware shop's contract supply.
  fixedSac: "995411",
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
  // The insecticide licence endorses the chlorpyrifos and holds its maker's
  // principal certificate; the fertiliser authorisation holds the supplier's
  // certificate of source (Form O). A thiamethoxam pesticide, kept by batch
  // and received, is on neither.
  principal: { manufacturer: "Dhanuka Agritech", registrationNo: "CIR-26,842/2006-Chlorpyrifos (EC)", manufacturingLicenceNo: "HR/ML/2011/042", formulations: ["EC"] },
  source: { certificateNo: "FO/IFFCO/2025/311" },
  unendorsed: { name: "Thiamethoxam 25% WG 100 g", code: "THM-100", unit: "packet", price: 210, mrp: 230, hsn: "3808", molecule: "Thiamethoxam", formulation: "25% WG",
    lot: "TM-07", manufacturer: "Syngenta India" },
  // The farmer's kharif credit (falling due in 60 days, 2% a month after it)
  // with 10 kg of the paddy seed billed on it; a pest-control firm, a customer
  // tagged on the screen; aluminium phosphide tablets (restricted use), kept by
  // batch and received.
  season: { season: "kharif", creditLimit: "20000", interestRate: "2", seedKg: "10" },
  pestControl: { name: "Deccan Pest Control Services", phone: "9849011122", licenceNo: "PCO/TS/2024/0311" },
  fumigant: { name: "Aluminium phosphide 56% tablets 10 g", code: "ALP-10", unit: "packet", price: 180, mrp: 195, hsn: "3808", molecule: "Aluminium phosphide",
    formulation: "56% TB", lot: "AP-03", manufacturer: "UPL Limited" },
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
  // Paint tinting: a Pastel base in 4 L tins, received; the tinting charge for
  // each tin, a service at 18%; and a shade on the Pastel base.
  base: { name: "Apex Ultima base Pastel 4 L", code: "APX-P4", unit: "each", price: 1725, mrp: 1890, hsn: "3209", paintBase: "Pastel", litres: 4 },
  tintCharge: { name: "Tinting charge", code: "TINT", price: 30, sac: "9988" },
  shade: { maker: "Asian Paints", code: "7974", name: "Sunset Glow", card: "Colour Spectra", base: "Pastel", formula: "XR 1.25; YE 0.4" },
  // Red bricks by the piece, received, for the brickwork calculator.
  bricks: { name: "Red clay bricks 9 x 4 in", code: "BRICK-RED", unit: "each", price: 9, hsn: "6901" },
  // A kit of a bag of cement and a kilo of binding wire at its own price (quoted as one line, billed as its parts),
  // and the terms and conditions the quotation spec prints on its quotations (set on Business settings by the spec).
  kit: { name: "Cement and wire pack", code: "HW-PACK", price: 480 },
  terms: "Prices include delivery within 10 km. 50% advance with the order.",
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
  // The scooter's job card, assigned to the mechanic, its estimate approved and the work started.
  mechanicJob: { complaint: "Brakes squeak when cold" },
  // An older number of the oil filter, none in stock, replaced by the filter; both fit the car.
  oldFilter: { name: "Oil filter, old number (Swift)", code: "FLT-SW-OLD", price: 360, hsn: "84212300" },
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
  // A trainer with a fixed monthly pay from this month; a studio room; an enquiry walked in.
  trainer: { name: "Coach Arjun", fixedMonthly: 12000 },
  room: { name: "Studio A", capacity: 12 },
  enquiry: { name: "Neha Kapoor", phone: "9876500104", interest: "Morning yoga" },
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
  // Carpets shampooed by the square foot; a kilo package of wash and fold the
  // customer bought (30 kg for 30 days, ₹2,499 + 18% GST); and a second order of
  // a shirt for dry cleaning, for the quality check and a change before its work.
  carpetShampoo: { name: "Carpet shampoo" },
  carpet: { name: "Carpet", shampooSqft: 25.5 },
  plan: { name: "Wash & fold 30 kg", kilos: 30, days: 30, price: 2499 },
};

// The jeweller: the morning's rates from the local association, set on the
// business's own date; a gold ring and a gold chain as jewellery items (22K,
// HSN 7113, making by the gram and wastage), and the hallmarking charge a new
// hallmarked piece starts with; its location's district under mandatory
// hallmarking, and its BIS registration. In stock as opening stock: three 22K
// rings, each hallmarked with its HUID (one for each bill the specs make: at
// the counter, against old gold, and for a gold scheme), and a 22K chain of
// 8.2 g with no hallmark, which the bill refuses. A customer brought in an old
// 22K chain, valued at the day's buy rate less the shop's 2% buy-back
// deduction and not paid out; another is enrolled in an 11-month gold scheme
// with three instalments paid by UPI.
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
  // Its work: a karigar not registered for GST (2% wastage allowed, ₹450 a
  // gram for a ring); 50 g of 22K on a bullion dealer's metal balance; a
  // custom order for a ring with a ₹20,000 advance by UPI that fixed the rate
  // (bhav cut), the karigar's 5.000 g ring made from 6 g issued (0.800 g of
  // scrap back), hallmarked at the centre with its HUID and ready to bill; and
  // a hallmarked ring out on an approval challan with a customer.
  karigar: { name: "Ramesh Soni", phone: "9876500401", wastage: 2, labourPerGram: 450 },
  bullion: { name: "Mehta Bullion", gstin: "36AABCB1234F1Z9", grams: "50" },
  centre: { name: "Sri Sai Hallmarking Centre" },
  order: { customer: { name: "Kavitha Reddy", phone: "9876500402" }, description: "Ring with a lotus design", advance: 20000, issued: "6", gross: "5.000", scrap: "0.800",
    huid: "JR5D04" },
  approvalRing: { description: "Twisted band", gross: "3.200", huid: "JR4E05", customer: { name: "Anitha Kumar", phone: "9876500403" } },
  // Its money: a seller with two old gold vouchers of 22K (4 g and 6 g, less
  // the shop's 2%: ₹45,080 and ₹67,620), not paid out; a 5 g gold coin of its
  // own at 3%, two in stock; a hallmarked ring for a bill with a discount at
  // the counter; and a member's gold scheme on its day 364 (joined 364 days
  // ago, ₹2,000 paid in), to be closed into their safekeeping.
  money: {
    seller: { name: "Ravi Teja", phone: "9876500501", idRef: "TSV7654321", article: "Old bangle", grams: ["4.000", "6.000"] },
    coin: { name: "Gold coin 5 g 24K", code: "JWL-COIN5", price: 64000, cost: 62000, stock: "2" },
    discountRing: { description: "Floral ring", gross: "3.000", huid: "JR6F06" },
    closing: { name: "Lalitha Devi", phone: "9876500502", instalment: 2000 },
  },
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
  // A class of cars with its checklist; two self-drive cars with a kilometre allowance and a fuel charge, their class,
  // engine, length and fuel kept (the first's PUC certificate runs out in 5 days); the location's rent-a-cab licence.
  carClass: { name: "Cars", checklist: ["Body and paint", "Tyres"] },
  car: { name: "Swift self-drive", code: "RNT-SWIFT", rates: { day: "1500" }, deposit: 0, km: { allowance: "100", per: "day", rate: "12" }, fuel: { per: "eighth", rate: "300" },
    unit: { label: "Swift 1", serialNo: "TS09EA1111", meter: "25000.0", vehicleClass: "LMV", engineCc: "1197", lengthMm: "3995", fuelType: "petrol" }, pucInDays: 5, insuranceInDays: 200,
    spare: { label: "Swift 2", serialNo: "TS09EA2222", meter: "25000.0" } },
  licence: { kind: "rent_a_cab", name: "Rent a cab licence", licenceNo: "STA/RAC/2026/12", authority: "State Transport Authority, Telangana" },
  // What the hirer register keeps of a driving licence (Form 5).
  register: { address: "8-2-293, Road No. 3, Banjara Hills, Hyderabad 500034", licenceAuthority: "RTA Khairatabad", licenceClasses: ["LMV"], licenceIssuedOn: "2018-04-10",
    licenceNo: "TS0920180004321" },
  // The second car hired and back 120 km later (in the register); the first reserved from now for a day.
  driven: { hirer: { name: "Ravi Shankar", phone: "9876500404" }, back: "25120.0" },
  driving: { hirer: { name: "Meena Kumari", phone: "9876500405" }, hours: 24 },
  // A shamiana set of 8 poles and 2 cloths from their pools, billed as the kit.
  poles: { name: "Tent pole", code: "RNT-POLE", rates: { day: "50" }, deposit: 0, pool: 40 },
  cloth: { name: "Tent cloth", code: "RNT-CLOTH", rates: { day: "400" }, deposit: 0, pool: 10 },
  kit: { name: "Shamiana 20x40", code: "RNT-SHAM", rates: { day: "2000" }, deposit: 0, poles: 8, cloth: 2 },
  // The shop's cancellation slabs (its own terms), and 20 chairs booked to go out in 30 hours.
  cancelSlabs: [{ hours: 72, percent: 10 }, { hours: 24, percent: 25 }, { hours: 6, percent: 50 }, { hours: 0, percent: 75 }], noShow: 100,
  cancelling: { hirer: { name: "Suresh Babu", phone: "9876500406" }, inHours: 30, chairs: 20 },
};

// The fuel station: petrol and diesel (outside GST: on the GST nil slab, the
// price including state VAT), a tank of each with its stock, dispensing unit
// DU 1 with nozzle 1 for petrol and nozzle 2 for diesel, the 5-litre measure,
// and the prices from yesterday morning. Yesterday's morning dips at 06:00; a
// diesel shift opened on nozzle 2 two hours ago and closed an hour ago: 500
// litres moved, the 5-litre test pumped back, 495 litres sold at ₹95.20 for
// ₹47,124.00 in cash, a day of the stock register that today's dip ends. A
// transport company fills its truck on credit; the oil company's fleet card
// is a payment method; the terminal supplies the tanker loads.
export const FUEL = {
  petrol: { name: "Petrol", price: "102.12", tank: { tankNo: "T1", capacity: "15000", stock: "9000" }, nozzle: { nozzleNo: "1", reading: "100000" } },
  diesel: { name: "Diesel", price: "95.20", tank: { tankNo: "T2", capacity: "20000", stock: "12000" }, nozzle: { nozzleNo: "2", reading: "250000.5" } },
  unit: { unitNo: "DU 1", make: "Tokheim", stampingInDays: 200 },
  measure: { name: "5-litre measure", litres: "5", stampingInDays: 150 },
  // The diesel shift the set-up closes: its closing reading, the test pumped back and the cash, exact.
  closedShift: { closing: "250500.5", test: "5", cash: "47124" },
  supplier: "Cherlapally Terminal",
  fleet: { name: "Sri Balaji Transports", phone: "9848011223", creditDays: "30", creditLimit: "100000",
    vehicle: { registration: "TS09UB4455", description: "Tata 1613", fillLimit: "300" } },
  fleetCard: "Fleet card",
  // An engine oil the attendants sell on the forecourt (GST 18%, price with GST inside), in stock.
  lube: { name: "Engine oil 1 L", code: "E2E-LUBE-1", price: "450", stock: "24", supplier: "Lube Distributors" },
  // A contractor billed by the month, with a book of slips 1001 to 1050 and a tipper filled on credit.
  monthly: { name: "Ramesh Contractors", creditDays: "15", vehicle: { registration: "AP29TB0042" }, book: { bookNo: "B-21", first: "1001", last: "1050" } },
};

// The lodge: Deluxe rooms 101 and 102 and a Suite, room 201 (rates a night
// before GST, Friday and Saturday nights at the weekend rate), the two GST
// slabs of a room night (5% at or below ₹7,500, 18% above it) and its terms. In
// the house since yesterday: a family of three adults in the Suite (the third
// an extra adult, so the night is above ₹7,500: 18%) who paid ₹5,000 in
// advance, leaving today. Reserved by phone for tonight: room 102. A guest who
// walks in books a Deluxe room for two nights and checks in with a foreign
// national, who is reported on Form-III.
export const LODGING = {
  sac: "996311",
  deluxe: { name: "Deluxe", baseOccupancy: 2, maxOccupancy: 3, extraBeds: 1, rates: { rack: "4500", weekend: "5200", extraAdult: "1000", child: "500", extraBed: "800" },
    rooms: ["101", "102"] },
  suite: { name: "Suite", baseOccupancy: 2, maxOccupancy: 4, rates: { rack: "7000", weekend: "8500", extraAdult: "1500" }, rooms: ["201"] },
  weekendNights: [5, 6],
  terms: "Check-out by 11 am. Every guest shows a photo ID at check-in.",
  // In the house since yesterday, leaving today.
  inHouse: { guest: { name: "Vikram Shah", phone: "9820012345" }, adults: 3, advance: "5000",
    occupants: [{ fullName: "Vikram Shah", idKind: "pan_card", idRef: "ABCPS1234K" }, { fullName: "Neha Shah", idKind: "voter_id", idRef: "MHV1234567" },
      { fullName: "Rohan Shah", idKind: "driving_licence", idRef: "MH0120190012345" }] },
  // Reserved by phone for tonight, in room 102.
  booked: { guest: { name: "Kiran Desai", phone: "9820054321" }, adults: 2 },
  // The walk-in the spec books and checks in: two nights in a Deluxe room, an advance, and a foreign national.
  walkIn: { guest: { name: "Rahul Mehta", phone: "9811122233" }, advance: "2000", aadhaarLast4: "4321",
    foreigner: { fullName: "Emma Clarke", nationality: "British", passport: "GB7766554", visaType: "e-Tourist visa", visaNo: "ETV445566", nextDestination: "Jaipur, India",
      inIndiaDaysAgo: 3 },
    acknowledgement: "FRRO/HYD/2026/004512" },
  // A food service item a rate plan's meals are billed as, and a company billed on a folio of its own (build-data.mjs).
  meals: { name: "Breakfast and dinner", code: "LDG-MEALS", price: "0" },
  company: { name: "Infotech Solutions Pvt Ltd", gstin: "27AAPFU0939F1ZV" },
  // What the spec makes: a half-board plan of the Suite, a group booking a week ahead, an occupant joining the walk-in's stay, the walk-in's preferences.
  plan: { name: "Half board", mealAdult: "900", mealChild: "400" },
  group: { name: "Sharma wedding party", organiser: "Anil Sharma", phone: "9811100011", inDays: 7, roomGuest: "Sunita Sharma" },
  joining: { fullName: "Aarav Mehta" },
  preferences: "A quiet room away from the lift; extra pillows",
  // The house (the spec's last tests): room 201 booked out of order ahead, and a ticket for room 102.
  house: { outOfOrder: { inDays: 10, lastInDays: 11, reason: "Bathroom tiles relaid" }, ticket: { room: "102", issue: "Curtain rod loose", outcome: "Rod refixed" } },
};

// The clinic's front desk (live-updates.spec.js): a patient registered with
// consent, given a token on one screen while the token queue is open on
// another. The clinic and lab workspaces (clinic-lab.spec.js): the DOCTOR's
// calendar (their queue) and registration, the PATHOLOGIST's registration, a
// haemoglobin test billed as a service, with its range for a woman and the
// critical low; and the patient the front desk registers there, whom the
// doctor sees and sends for the test.
export const CLINIC = {
  patient: { name: "Lakshmi Narayanan", phone: "9000012345", sex: "female", ageYears: 52 },
  doctor: { resource: "Dr. Ravi Shankar", signedName: "Dr. Ravi Shankar", qualification: "MBBS, MD (General Medicine)", registrationNo: "TSMC 31248" },
  pathologist: { signedName: "Dr. Anitha Rao", qualification: "MD (Pathology)", registrationNo: "TSMC 40266" },
  test: { code: "HB", name: "Haemoglobin", service: "Haemoglobin test", price: 150, unit: "g/dL", low: 12, high: 15.5, criticalLow: 7 },
  walkIn: {
    name: "Meera Krishnan", phone: "9000054321", ageYears: 38,
    consultation: { bpSystolic: "150", bpDiastolic: "96", complaints: "Tiredness and breathlessness for two weeks", diagnosis: "Anaemia, to be confirmed" },
    medicine: { drugName: "Ferrous sulphate", strength: "200 mg", frequency: "1-0-1", duration: "30 days" },
    referral: { referredTo: "Dr. S. Rao, haematologist, City Hospital", reason: "Anaemia not explained by diet; please evaluate" },
    // Low, not critical: 12 to 15.5 g/dL for a woman.
    haemoglobin: "9.2",
  },
};

// The salon: one stylist and one service.
export const SALON = {
  stylist: { name: "Priya Sharma", role: "Senior stylist" },
  service: { name: "Haircut", price: 300 },
};

// Small rules (small-items.spec.js): the general store asks the biller's PIN
// for every bill and sells a tiffin box from stock, and the spec renames it
// for a moment (then back); the meat shop takes orders for pickup for a hotel;
// the salon has a client whose usual stylist is the salon's stylist; and a
// guest web address of the restaurant's own, which the spec answers for the
// restaurant in the browser only.
export const SMALL_ITEMS = {
  storeItem: { name: "Steel tiffin box", code: "TIFFIN-3", price: 450 },
  renamed: "Lakshmi Stores, Main Road",
  hotel: { name: "Hotel Annapurna", phone: "9845033333" },
  salonClient: { name: "Meera Iyer", phone: "9845044444" },
  guestAddress: "https://order.bistro.e2e.invalid",
};

// A shop's CSV import (business-csv-import.spec.js), in the general store: a
// products file of three rows, one counted in a unit the shop does not keep,
// and a customers file of two, one with no phone. The spec makes each file from
// these rows, checks it, imports it and finds the records on their lists.
export const CSV_IMPORT = {
  business: "general_retail",
  products: {
    headings: ["Name", "Code", "Barcode", "Category", "Unit", "GST rate", "MRP", "Sale price", "Purchase price", "Opening stock"],
    rows: [
      ["Gift wrap roll", "WRAP-01", "8904000000017", "Gift wrap", "each", "18%", "60", "55", "35", "40"],
      ["Greeting card", "CARD-01", "", "Cards", "pcs", "18%", "", "25", "", ""],
      ["Scented candle", "CANDLE-01", "", "Candles", "carton", "18%", "", "150", "", ""],
    ],
    // The row the check refuses (the file's row 4, under its heading row).
    refused: { line: 4, name: "Scented candle", reason: "\"carton\" is not one of your units" },
  },
  customers: {
    headings: ["Name", "Phone", "GSTIN", "Opening balance"],
    rows: [
      ["Revathi Stores", "98480 22334", "", "1500"],
      ["Ramu (walk-in regular)", "", "", ""],
    ],
    owes: "₹1,500.00",
  },
};

// The clinic's lab by department, its ordered tests billed later and its drug
// list (clinic-lab-more.spec.js), with CLINIC's haemoglobin test, doctor and
// lab technician: the haemoglobin in Haematology and a fasting sugar test in
// Biochemistry, the LAB_TECH working in Haematology, an order of both for a
// patient with its samples in the lab (on the worklist by department), a
// patient whose test the front desk orders without billing and bills from
// the order, the clinic's drug list, and a patient allergic to penicillin
// with a visit open with the doctor, who prescribes amoxicillin with a reason.
export const CLINIC_LAB = {
  sugar: { code: "FBS", name: "Fasting blood sugar", service: "Fasting sugar test", price: 80, unit: "mg/dL", low: 70, high: 100 },
  worklistPatient: { name: "Gopal Rao", phone: "9000012001", sex: "male", ageYears: 61 },
  billedLater: { name: "Sunita Rao", phone: "9000012003", sex: "female", ageYears: 33 },
  drugs: [
    { genericName: "Amoxicillin", brandNames: "Mox, Novamox", strength: "500 mg", form: "Capsule", route: "Oral", usualDose: "1 cap", usualFrequency: "TDS",
      maxDailyAmount: 3000, maxDailyUnit: "mg", allergyGroup: "Penicillins" },
    { genericName: "Paracetamol", brandNames: "Dolo, Calpol", strength: "650 mg", form: "Tablet", route: "Oral", usualDose: "1 tab", usualFrequency: "1-1-1",
      maxDailyAmount: 4000, maxDailyUnit: "mg" },
  ],
  allergic: { name: "Farida Begum", phone: "9000012002", sex: "female", ageYears: 44, allergies: "Penicillin (rash)" },
  reason: "Took amoxicillin last year with no reaction; watched for 30 minutes",
  byHand: "Cough syrup",
};
