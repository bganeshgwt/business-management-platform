// Fills an empty restaurant with a realistic month of trading, so every screen
// and report has something true to show.
//
// It works through the real services, not raw INSERTs: prices, tax, stock
// consumption and loyalty all follow the same rules the POS follows. That is
// what makes the numbers add up — the reports are reporting real work.
//
// Usage:  npm run seed:demo          (refuses if the menu already has products)
//         npm run seed:demo -- --force
//
// To undo it, drop and recreate the database and run the migrations again.
const pool = require("../src/config/database");

const menuService = require("../src/modules/restaurant/menu/services/menu.service");
const menuExtrasService = require("../src/modules/restaurant/menu/services/menuExtras.service");
const taxRateService = require("../src/modules/restaurant/setup/services/taxRate.service");
const inventoryService = require("../src/modules/restaurant/inventory/services/inventory.service");
const recipeService = require("../src/modules/restaurant/menu/services/recipe.service");
const supplierService = require("../src/modules/restaurant/purchasing/services/supplier.service");
const purchaseService = require("../src/modules/restaurant/purchasing/services/purchase.service");
const tableService = require("../src/modules/restaurant/tables/services/table.service");
const crmService = require("../src/modules/restaurant/crm/services/crm.service");
const staffService = require("../src/modules/restaurant/staff/services/staff.service");
const expenseService = require("../src/modules/restaurant/expenses/services/expense.service");
const discountService = require("../src/modules/restaurant/billing/services/discount.service");
const businessDayService = require("../src/modules/restaurant/business-day/services/businessDay.service");
const orderService = require("../src/modules/restaurant/orders/services/order.service");
const billService = require("../src/modules/restaurant/billing/services/bill.service");
const restaurantRepository = require("../src/modules/restaurant/setup/repositories/restaurant.repository");

const DAYS_OF_TRADING = 30;

// One fixed seed, so a re-run on a fresh database produces the same restaurant.
// Math.random() would make every run different and every bug unreproducible.
let randomState = 20260921;

const random = () => {
  randomState = (randomState * 1103515245 + 12345) % 2147483648;
  return randomState / 2147483648;
};

const pick = (list) => list[Math.floor(random() * list.length)];
const between = (low, high) => low + Math.floor(random() * (high - low + 1));

const isoDate = (date) => date.toLocaleDateString("en-CA");

const say = (message) => console.log(message);

// ---------------------------------------------------------------- reference data

// The same five the tax-rates migration gave every restaurant that existed
// then (1789830000000_create-tax-rates.sql), for one set up after it.
const STANDARD_TAX_RATES = [
  { name: "Exempt", percentage: 0, hsnCode: null, isDefault: false },
  { name: "GST 5% (restaurant)", percentage: 5, hsnCode: "996331", isDefault: true },
  { name: "GST 12%", percentage: 12, hsnCode: "2106", isDefault: false },
  { name: "GST 18%", percentage: 18, hsnCode: "2201", isDefault: false },
  { name: "GST 28%", percentage: 28, hsnCode: "2202", isDefault: false },
];

const UNITS = [
  { name: "Kilogram", shortName: "kg" },
  { name: "Gram", shortName: "g" },
  { name: "Litre", shortName: "L" },
  { name: "Millilitre", shortName: "ml" },
  { name: "Piece", shortName: "pc" },
  { name: "Packet", shortName: "pkt" },
];

const INGREDIENTS = [
  { name: "Basmati Rice", unit: "kg", category: "Grains", stock: 120, cost: 118, reorder: 25 },
  { name: "Wheat Flour", unit: "kg", category: "Grains", stock: 80, cost: 46, reorder: 20 },
  { name: "Paneer", unit: "kg", category: "Dairy", stock: 18, cost: 340, reorder: 8 },
  { name: "Butter", unit: "kg", category: "Dairy", stock: 14, cost: 520, reorder: 5 },
  { name: "Fresh Cream", unit: "L", category: "Dairy", stock: 12, cost: 210, reorder: 5 },
  { name: "Curd", unit: "kg", category: "Dairy", stock: 20, cost: 80, reorder: 8 },
  { name: "Chicken", unit: "kg", category: "Meat", stock: 35, cost: 240, reorder: 12 },
  { name: "Mutton", unit: "kg", category: "Meat", stock: 12, cost: 720, reorder: 5 },
  { name: "Prawns", unit: "kg", category: "Seafood", stock: 8, cost: 560, reorder: 4 },
  { name: "Onion", unit: "kg", category: "Vegetables", stock: 60, cost: 32, reorder: 15 },
  { name: "Tomato", unit: "kg", category: "Vegetables", stock: 45, cost: 38, reorder: 12 },
  { name: "Potato", unit: "kg", category: "Vegetables", stock: 50, cost: 28, reorder: 15 },
  { name: "Capsicum", unit: "kg", category: "Vegetables", stock: 15, cost: 60, reorder: 5 },
  { name: "Green Chilli", unit: "kg", category: "Vegetables", stock: 6, cost: 80, reorder: 2 },
  { name: "Ginger Garlic Paste", unit: "kg", category: "Spices", stock: 9, cost: 180, reorder: 3 },
  { name: "Garam Masala", unit: "kg", category: "Spices", stock: 4, cost: 620, reorder: 1 },
  { name: "Red Chilli Powder", unit: "kg", category: "Spices", stock: 7, cost: 380, reorder: 2 },
  { name: "Turmeric Powder", unit: "kg", category: "Spices", stock: 5, cost: 260, reorder: 2 },
  { name: "Sunflower Oil", unit: "L", category: "Oils", stock: 70, cost: 140, reorder: 20 },
  { name: "Ghee", unit: "L", category: "Oils", stock: 16, cost: 620, reorder: 6 },
  { name: "Sugar", unit: "kg", category: "Grocery", stock: 40, cost: 45, reorder: 10 },
  { name: "Salt", unit: "kg", category: "Grocery", stock: 25, cost: 22, reorder: 8 },
  { name: "Cashew Nuts", unit: "kg", category: "Grocery", stock: 6, cost: 880, reorder: 2 },
  { name: "Tea Powder", unit: "kg", category: "Beverages", stock: 8, cost: 420, reorder: 3 },
  { name: "Coffee Powder", unit: "kg", category: "Beverages", stock: 5, cost: 640, reorder: 2 },
  { name: "Milk", unit: "L", category: "Dairy", stock: 55, cost: 62, reorder: 20 },
  { name: "Soft Drink Bottle", unit: "pc", category: "Beverages", stock: 180, cost: 32, reorder: 48 },
  { name: "Mineral Water Bottle", unit: "pc", category: "Beverages", stock: 240, cost: 12, reorder: 60 },
];

const SUPPLIERS = [
  {
    name: "Sri Venkateswara Traders",
    contactPerson: "K. Ramesh",
    mobile: "9848011223",
    email: "orders@svtraders.example",
    address: "Shop 14, Rythu Bazaar Road, Rajahmundry",
    gstNumber: "37AABCS1429B1Z5",
    paymentTerms: "15 days credit",
  },
  {
    name: "Godavari Fresh Vegetables",
    contactPerson: "M. Lakshmi",
    mobile: "9885044556",
    address: "Stall 7, Kotipalli Bus Stand Market, Rajahmundry",
    paymentTerms: "Cash on delivery",
  },
  {
    name: "Krishna Dairy & Foods",
    contactPerson: "B. Srinivas",
    mobile: "9963077889",
    email: "supply@krishnadairy.example",
    address: "Danavaipeta, Rajahmundry",
    gstNumber: "37AADCK9021M1ZP",
    paymentTerms: "7 days credit",
  },
  {
    name: "Coastal Meat Suppliers",
    contactPerson: "A. Farooq",
    mobile: "9701033445",
    address: "Alcot Gardens, Rajahmundry",
    paymentTerms: "Weekly settlement",
  },
];

// price is the full/regular price; halfPrice creates a "Half" size where a
// restaurant would really offer one.
const MENU = [
  {
    category: "Starters",
    items: [
      { name: "Paneer Tikka", price: 260, type: "veg", half: 150, recipe: [["Paneer", 0.18], ["Curd", 0.05], ["Capsicum", 0.04], ["Sunflower Oil", 0.02]] },
      { name: "Gobi Manchurian", price: 190, type: "veg", half: 120, recipe: [["Wheat Flour", 0.06], ["Onion", 0.05], ["Sunflower Oil", 0.04]] },
      { name: "Chicken 65", price: 280, type: "non_veg", half: 165, recipe: [["Chicken", 0.22], ["Curd", 0.04], ["Red Chilli Powder", 0.01], ["Sunflower Oil", 0.05]] },
      { name: "Chilli Chicken", price: 290, type: "non_veg", half: 170, recipe: [["Chicken", 0.22], ["Capsicum", 0.05], ["Onion", 0.05], ["Sunflower Oil", 0.04]] },
      { name: "Apollo Fish", price: 340, type: "non_veg", recipe: [["Prawns", 0.15], ["Curd", 0.03], ["Sunflower Oil", 0.04]] },
      { name: "Veg Spring Roll", price: 180, type: "veg", recipe: [["Wheat Flour", 0.08], ["Capsicum", 0.03], ["Onion", 0.03]] },
      { name: "Egg Pakoda", price: 150, type: "egg", recipe: [["Wheat Flour", 0.05], ["Onion", 0.04], ["Sunflower Oil", 0.03]] },
    ],
  },
  {
    category: "Main Course",
    items: [
      { name: "Paneer Butter Masala", price: 290, type: "veg", half: 175, recipe: [["Paneer", 0.16], ["Butter", 0.03], ["Fresh Cream", 0.04], ["Tomato", 0.12], ["Cashew Nuts", 0.02]] },
      { name: "Kadai Paneer", price: 280, type: "veg", half: 170, recipe: [["Paneer", 0.16], ["Capsicum", 0.06], ["Tomato", 0.1], ["Onion", 0.08]] },
      { name: "Dal Tadka", price: 180, type: "veg", half: 110, recipe: [["Ghee", 0.02], ["Onion", 0.05], ["Tomato", 0.05], ["Turmeric Powder", 0.005]] },
      { name: "Butter Chicken", price: 340, type: "non_veg", half: 200, recipe: [["Chicken", 0.24], ["Butter", 0.04], ["Fresh Cream", 0.05], ["Tomato", 0.14], ["Cashew Nuts", 0.02]] },
      { name: "Chicken Curry", price: 300, type: "non_veg", half: 180, recipe: [["Chicken", 0.24], ["Onion", 0.1], ["Tomato", 0.08], ["Ginger Garlic Paste", 0.02]] },
      { name: "Mutton Rogan Josh", price: 420, type: "non_veg", recipe: [["Mutton", 0.25], ["Curd", 0.06], ["Onion", 0.1], ["Garam Masala", 0.008]] },
      { name: "Egg Curry", price: 220, type: "egg", recipe: [["Onion", 0.08], ["Tomato", 0.07], ["Sunflower Oil", 0.03]] },
    ],
  },
  {
    category: "Rice & Biryani",
    items: [
      { name: "Chicken Dum Biryani", price: 320, type: "non_veg", half: 190, recipe: [["Basmati Rice", 0.25], ["Chicken", 0.22], ["Curd", 0.06], ["Ghee", 0.03], ["Onion", 0.08]] },
      { name: "Mutton Biryani", price: 440, type: "non_veg", recipe: [["Basmati Rice", 0.25], ["Mutton", 0.24], ["Curd", 0.06], ["Ghee", 0.04]] },
      { name: "Veg Biryani", price: 240, type: "veg", half: 145, recipe: [["Basmati Rice", 0.25], ["Potato", 0.08], ["Capsicum", 0.05], ["Ghee", 0.02]] },
      { name: "Jeera Rice", price: 160, type: "veg", recipe: [["Basmati Rice", 0.18], ["Ghee", 0.02]] },
      { name: "Curd Rice", price: 140, type: "veg", recipe: [["Basmati Rice", 0.16], ["Curd", 0.12]] },
    ],
  },
  {
    category: "Breads",
    items: [
      { name: "Butter Naan", price: 60, type: "veg", recipe: [["Wheat Flour", 0.1], ["Butter", 0.01]] },
      { name: "Garlic Naan", price: 70, type: "veg", recipe: [["Wheat Flour", 0.1], ["Butter", 0.01], ["Ginger Garlic Paste", 0.01]] },
      { name: "Tandoori Roti", price: 35, type: "veg", recipe: [["Wheat Flour", 0.08]] },
      { name: "Laccha Paratha", price: 65, type: "veg", recipe: [["Wheat Flour", 0.1], ["Ghee", 0.015]] },
    ],
  },
  {
    category: "Desserts",
    items: [
      { name: "Gulab Jamun (2 pc)", price: 90, type: "veg", recipe: [["Milk", 0.1], ["Sugar", 0.06], ["Ghee", 0.02]] },
      { name: "Double Ka Meetha", price: 110, type: "veg", recipe: [["Milk", 0.15], ["Sugar", 0.05], ["Ghee", 0.02], ["Cashew Nuts", 0.01]] },
      { name: "Vanilla Ice Cream", price: 80, type: "veg", recipe: [["Milk", 0.12], ["Sugar", 0.03]] },
    ],
  },
  {
    category: "Beverages",
    items: [
      { name: "Masala Chai", price: 30, type: "veg", tax: "GST 5% (restaurant)", recipe: [["Tea Powder", 0.006], ["Milk", 0.1], ["Sugar", 0.012]] },
      { name: "Filter Coffee", price: 40, type: "veg", recipe: [["Coffee Powder", 0.008], ["Milk", 0.12], ["Sugar", 0.012]] },
      { name: "Sweet Lassi", price: 90, type: "veg", recipe: [["Curd", 0.2], ["Sugar", 0.03]] },
      { name: "Fresh Lime Soda", price: 70, type: "veg", recipe: [["Sugar", 0.02]] },
      { name: "Soft Drink (300 ml)", price: 50, type: "veg", tax: "GST 28%", recipe: [["Soft Drink Bottle", 1]] },
      { name: "Mineral Water (1 L)", price: 20, type: "veg", tax: "GST 18%", recipe: [["Mineral Water Bottle", 1]] },
    ],
  },
];

const MODIFIERS = [
  { name: "Extra Butter", price: 20 },
  { name: "Extra Cheese", price: 40 },
  { name: "Less Spicy", price: 0 },
  { name: "Extra Spicy", price: 0 },
  { name: "No Onion No Garlic", price: 0 },
  { name: "Extra Gravy", price: 30 },
];

const CUSTOMERS = [
  ["Ravi Teja Konidela", "9848112233", "ravi.teja@example.com", "1988-04-12"],
  ["Sita Mahalakshmi", "9885223344", "sita.m@example.com", "1992-11-03"],
  ["Abdul Rahman", "9963334455", null, "1985-07-19"],
  ["Priya Darshini", "9701445566", "priya.d@example.com", "1995-02-27"],
  ["Venkata Subbarao", "9848556677", null, "1975-09-08"],
  ["Anusha Reddy", "9885667788", "anusha.reddy@example.com", "1993-06-15"],
  ["Mohammed Ilyas", "9963778899", null, "1990-01-22"],
  ["Lakshmi Prasanna", "9701889900", "lakshmi.p@example.com", "1998-12-05"],
  ["Suresh Babu Gadde", "9848990011", null, "1982-03-30"],
  ["Divya Bharathi", "9885101112", "divya.b@example.com", "1996-08-11"],
  ["Naveen Kumar Ch", "9963121314", null, "1991-05-17"],
  ["Padmavathi Devi", "9701131415", null, "1968-10-02"],
];

const EMPLOYEES = [
  ["Ramesh Naidu", "EMP001", "9848201010", "Head Chef", "kitchen", 42000],
  ["Kiran Kumar", "EMP002", "9885202020", "Sous Chef", "kitchen", 28000],
  ["Sailaja Rani", "EMP003", "9963203030", "Cashier", "service", 22000],
  ["Prasad Rao", "EMP004", "9701204040", "Head Waiter", "service", 20000],
  ["Mahesh Yadav", "EMP005", "9848205050", "Waiter", "service", 16000],
  ["Fatima Begum", "EMP006", "9885206060", "Waiter", "service", 16000],
  ["Ganesh Dora", "EMP007", "9963207070", "Kitchen Helper", "kitchen", 14000],
  ["Srinivas Rao", "EMP008", "9701208080", "Manager", "management", 55000],
  ["Lalitha Kumari", "EMP009", "9848209090", "Housekeeping", "housekeeping", 12000],
];

// ---------------------------------------------------------------- helpers

// When an order is taken. A restaurant does not serve evenly from noon to
// midnight: there is a lunch service and a longer, busier dinner service, with
// a lull in between. Stamping every order with the same clock time made the
// hourly chart one meaningless spike and every visit in a guest's history read
// "12:35 pm".
//
// Roughly a third of covers at lunch, the rest in the evening.
const serviceTime = () => {
  const lunch = random() < 0.35;

  // Minutes from midnight: lunch 12:00–15:00, dinner 19:00–23:00.
  const minutes = lunch ? 12 * 60 + between(0, 179) : 19 * 60 + between(0, 239);

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}:${String(
    between(0, 59)
  ).padStart(2, "0")}`;
};

// How busy a given day is. Friday and Saturday are the peak, Monday the lull —
// which is what makes the sales chart look like a real restaurant's.
const coversForDay = (date) => {
  const weekday = date.getDay();
  const base = { 0: 34, 1: 16, 2: 18, 3: 20, 4: 24, 5: 38, 6: 42 }[weekday];

  return Math.max(6, base + between(-5, 6));
};

const main = async () => {
  const force = process.argv.includes("--force");

  const restaurant = (await pool.query("SELECT id, name FROM restaurants ORDER BY id LIMIT 1")).rows[0];

  if (!restaurant) {
    throw new Error("No restaurant found. Run the migrations first.");
  }

  const admin = (
    await pool.query(
      "SELECT id, name FROM users WHERE restaurant_id = $1 ORDER BY id LIMIT 1",
      [restaurant.id]
    )
  ).rows[0];

  if (!admin) {
    throw new Error("No user found for the restaurant. Create one with npm run user:create.");
  }

  const restaurantId = restaurant.id;
  const userId = admin.id;

  const existingProducts = await pool.query(
    "SELECT COUNT(*)::int AS count FROM products WHERE restaurant_id = $1",
    [restaurantId]
  );

  if (existingProducts.rows[0].count > 0 && !force) {
    console.error(
      `\n"${restaurant.name}" already has ${existingProducts.rows[0].count} products.\n` +
        "Seeding on top of real data would mix demo records into it.\n" +
        "Re-run with --force if that is really what you want.\n"
    );
    process.exit(1);
  }

  say(`\nSeeding demo data into "${restaurant.name}"…\n`);

  // ---- Settings: the scheme has to be on for loyalty to accrue below.
  const settings = await restaurantRepository.findSettings(restaurantId);
  await restaurantRepository.updateSettings(
    restaurantId,
    {
      currencyCode: "INR",
      currencySymbol: "₹",
      timezone: settings.timezone || "Asia/Kolkata",
      taxMode: "exclusive",
      defaultTaxPercentage: 5,
      serviceChargePercentage: 0,
      orderPrefix: "ORD",
      invoicePrefix: "INV",
      gstNumber: "37AAFCF1234K1ZV",
      fssaiNumber: "10123456789012",
      gstSplit: true,
      billHeader: "Andhra & North Indian · Pure Veg and Non-Veg",
      billFooter: "Thank you for dining with us. Please visit again!",
      autoConsumeStock: true,
      loyaltyEnabled: true,
      loyaltyEarnAmount: 100,
      loyaltyPointValue: 1,
      loyaltyMinRedeem: 50,
      printPaperWidth: "80mm",
      printCopies: 1,
      autoPrintBill: false,
      printShowQr: false,
    },
    userId
  );
  // Loyalty on or off is the Loyalty points feature (Settings -> Features),
  // no longer a setting: the demo restaurant has it on, as it always had.
  await pool.query("SELECT restaurant_feature_set($1, 'guest_loyalty', TRUE, $2)", [restaurant.id, userId]);
  say("  settings · currency, GST, loyalty and printing");

  // ---- Units and ingredients
  const unitIds = new Map();

  for (const unit of UNITS) {
    const saved = await inventoryService.createUnit(restaurantId, { ...unit, status: "active" }, userId);
    unitIds.set(unit.shortName, saved.id);
  }

  const ingredientIds = new Map();
  const ingredientById = new Map();

  for (const item of INGREDIENTS) {
    const saved = await inventoryService.createItem(
      restaurantId,
      {
        name: item.name,
        code: null,
        unitId: unitIds.get(item.unit),
        category: item.category,
        reorderLevel: item.reorder,
        status: "active",
        openingStock: item.stock,
        openingCost: item.cost,
      },
      userId
    );
    ingredientIds.set(item.name, saved.id);
    ingredientById.set(saved.id, item);
  }

  say(`  inventory · ${UNITS.length} units, ${INGREDIENTS.length} ingredients with opening stock`);

  // ---- Suppliers
  const suppliers = [];

  for (const supplier of SUPPLIERS) {
    suppliers.push(
      await supplierService.create(restaurantId, { ...supplier, code: null, status: "active" }, userId)
    );
  }

  say(`  suppliers · ${SUPPLIERS.length}`);

  // ---- Tax rates. Restaurants that existed when tax rates came in got the
  // standard five from that migration; one set up since may have none yet
  // (the seed then stopped on the first dish). It gets the same five, which
  // is what an Indian restaurant charges: 5% on food, and the goods rates for
  // packaged drinks and water.
  if ((await taxRateService.list(restaurantId, {})).length === 0) {
    for (const rate of STANDARD_TAX_RATES) {
      await taxRateService.create(restaurantId, { ...rate, cessPercentage: 0, status: "active" }, userId);
    }

    say(`  tax rates · ${STANDARD_TAX_RATES.length} standard GST rates added`);
  }

  const taxRates = await taxRateService.list(restaurantId, {});
  const rateByName = new Map(taxRates.map((rate) => [rate.name, rate]));
  const defaultRate = taxRates.find((rate) => rate.isDefault) || taxRates[0];

  // ---- Menu
  const products = [];
  let sortOrder = 0;

  for (const [index, group] of MENU.entries()) {
    const category = await menuService.createCategory(
      restaurantId,
      { name: group.category, description: null, sortOrder: index, status: "active" },
      userId
    );

    for (const item of group.items) {
      const rate = (item.tax && rateByName.get(item.tax)) || defaultRate;

      const product = await menuService.createProduct(
        restaurantId,
        {
          categoryId: category.id,
          name: item.name,
          code: null,
          description: null,
          price: item.price,
          taxRateId: rate.id,
          taxPercentage: rate.percentage,
          foodType: item.type,
          isAvailable: true,
          sortOrder: (sortOrder += 1),
          status: "active",
        },
        userId
      );

      // A half plate is priced as a negative delta from the full plate.
      if (item.half) {
        await menuExtrasService.createVariant(
          restaurantId,
          product.id,
          {
            name: "Half",
            priceDelta: item.half - item.price,
            isDefault: false,
            sortOrder: 0,
            status: "active",
          },
          userId
        );
        await menuExtrasService.createVariant(
          restaurantId,
          product.id,
          // The full plate is what "no size chosen" means.
          { name: "Full", priceDelta: 0, isDefault: true, sortOrder: 1, status: "active" },
          userId
        );
      }

      for (const [ingredient, quantity] of item.recipe) {
        await recipeService.addLine(
          restaurantId,
          product.id,
          { inventoryItemId: ingredientIds.get(ingredient), productVariantId: null, quantity },
          userId
        );
      }

      products.push({ ...product, weight: item.price > 280 ? 1 : item.price < 90 ? 4 : 3 });
    }
  }

  say(`  menu · ${MENU.length} categories, ${products.length} dishes with recipes`);

  // ---- Modifiers
  for (const modifier of MODIFIERS) {
    await menuExtrasService.createModifier(
      restaurantId,
      { name: modifier.name, price: modifier.price, status: "active" },
      userId
    );
  }

  say(`  modifiers · ${MODIFIERS.length}`);

  // ---- Floors, areas and tables
  const groundFloor = await tableService.createFloor(
    restaurantId,
    { name: "Ground Floor", sortOrder: 0, status: "active" },
    userId
  );
  const firstFloor = await tableService.createFloor(
    restaurantId,
    { name: "First Floor", sortOrder: 1, status: "active" },
    userId
  );

  const mainHall = await tableService.createArea(
    restaurantId,
    { floorId: groundFloor.id, name: "Main Hall", sortOrder: 0, status: "active" },
    userId
  );
  const familySection = await tableService.createArea(
    restaurantId,
    { floorId: firstFloor.id, name: "Family Section", sortOrder: 0, status: "active" },
    userId
  );
  const acCabin = await tableService.createArea(
    restaurantId,
    { floorId: firstFloor.id, name: "AC Cabins", sortOrder: 1, status: "active" },
    userId
  );

  const tables = [];

  for (let n = 1; n <= 8; n += 1) {
    tables.push(
      await tableService.createTable(
        restaurantId,
        {
          floorId: groundFloor.id,
          areaId: mainHall.id,
          outletId: null,
          tableNo: `T${n}`,
          capacity: n <= 4 ? 4 : 6,
          status: "active",
        },
        userId
      )
    );
  }

  for (let n = 1; n <= 5; n += 1) {
    tables.push(
      await tableService.createTable(
        restaurantId,
        {
          floorId: firstFloor.id,
          areaId: familySection.id,
          outletId: null,
          tableNo: `F${n}`,
          capacity: 6,
          status: "active",
        },
        userId
      )
    );
  }

  for (let n = 1; n <= 3; n += 1) {
    tables.push(
      await tableService.createTable(
        restaurantId,
        {
          floorId: firstFloor.id,
          areaId: acCabin.id,
          outletId: null,
          tableNo: `C${n}`,
          capacity: 8,
          status: "active",
        },
        userId
      )
    );
  }

  say(`  tables · 2 floors, 3 areas, ${tables.length} tables`);

  // ---- Customers
  const customers = [];

  for (const [name, mobile, email, dob] of CUSTOMERS) {
    customers.push(
      await crmService.createCustomer(
        restaurantId,
        {
          name,
          mobile,
          email,
          address: null,
          dateOfBirth: dob,
          notes: null,
          status: "active",
        },
        userId
      )
    );
  }

  say(`  customers · ${customers.length}`);

  // ---- Staff, shifts and a roster
  const employees = [];

  for (const [name, code, mobile, designation, department, salary] of EMPLOYEES) {
    employees.push(
      await staffService.createEmployee(
        restaurantId,
        {
          name,
          employeeCode: code,
          mobile,
          email: null,
          designation,
          department,
          employmentType: "full_time",
          salaryType: "monthly",
          salaryAmount: salary,
          dateOfJoining: "2025-06-01",
          dateOfLeaving: null,
          outletId: null,
          userId: null,
          address: null,
          emergencyContact: null,
          notes: null,
          status: "active",
        },
        userId
      )
    );
  }

  const morning = await staffService.createShift(
    restaurantId,
    { name: "Morning", startTime: "10:00", endTime: "18:00", breakMinutes: 45, graceMinutes: 10, status: "active" },
    userId
  );
  const evening = await staffService.createShift(
    restaurantId,
    { name: "Evening", startTime: "16:00", endTime: "00:00", breakMinutes: 45, graceMinutes: 10, status: "active" },
    userId
  );

  say(`  staff · ${employees.length} employees, 2 shift patterns`);

  // ---- Discounts
  await discountService.create(
    restaurantId,
    {
      name: "Weekday Lunch 10%",
      code: "LUNCH10",
      discountType: "percentage",
      value: 10,
      minOrderAmount: 500,
      maxDiscountAmount: 150,
      appliesTo: "all",
      usageLimit: null,
      validFrom: null,
      validTo: null,
      status: "active",
    },
    userId
  );
  await discountService.create(
    restaurantId,
    {
      name: "Flat ₹100 off above ₹1500",
      code: "SAVE100",
      discountType: "amount",
      value: 100,
      minOrderAmount: 1500,
      maxDiscountAmount: null,
      appliesTo: "all",
      usageLimit: null,
      validFrom: null,
      validTo: null,
      status: "active",
    },
    userId
  );

  say("  discounts · 2 coupons");

  // ---- A month of trading
  const today = new Date();
  const timezone = settings.timezone || "Asia/Kolkata";
  const paymentMethods = ["cash", "cash", "card", "upi", "upi", "upi"];
  const orderTypes = ["dine_in", "dine_in", "dine_in", "takeaway", "takeaway", "delivery"];

  let totalOrders = 0;
  let totalBills = 0;
  let totalSales = 0;
  let purchaseOrders = 0;

  for (let back = DAYS_OF_TRADING; back >= 0; back -= 1) {
    const date = new Date(today);
    date.setDate(date.getDate() - back);
    const businessDate = isoDate(date);

    const openingCash = 2000;
    const day = await businessDayService.openDay(
      restaurantId,
      { businessDate, openingCash, notes: null },
      userId
    );

    const covers = coversForDay(date);
    let cashTaken = 0;

    // The clock time each order was taken at, so the paperwork can be stamped
    // with it once the day is done.
    const stamps = [];

    for (let n = 0; n < covers; n += 1) {
      const orderType = pick(orderTypes);
      const table = orderType === "dine_in" ? pick(tables) : null;

      // Roughly one order in three is from someone we know by name.
      const customer = random() < 0.34 ? pick(customers) : null;

      const lineCount = between(1, 4);
      const chosen = [];

      for (let l = 0; l < lineCount; l += 1) {
        const product = pick(products);

        if (chosen.some((line) => line.productId === product.id)) {
          continue;
        }

        chosen.push({
          productId: product.id,
          productVariantId: null,
          modifierIds: [],
          quantity: between(1, product.weight),
          notes: null,
        });
      }

      if (chosen.length === 0) {
        continue;
      }

      let order;

      try {
        order = await orderService.create(
          restaurantId,
          {
            orderType,
            source: "pos",
            tableId: table ? table.id : null,
            outletId: null,
            customerId: customer ? customer.id : null,
            customerName: customer ? customer.name : null,
            customerMobile: customer ? customer.mobile : null,
            guestCount: orderType === "dine_in" ? between(1, 6) : null,
            notes: null,
            items: chosen,
          },
          userId
        );
      } catch {
        // A dish may be short of stock by now; skip that order rather than stop.
        continue;
      }

      totalOrders += 1;

      const at = serviceTime();
      stamps.push({ orderId: order.id, billId: null, at });

      // A few orders are still open at the end of the day, as they would be.
      if (n >= covers - 2 && back === 0) {
        continue;
      }

      // SAVE100 needs a subtotal of 1500, and the coupon is checked against the
      // subtotal rather than the tax-inclusive total, so this compares the same
      // number the rule does.
      const useCoupon = order.subtotal >= 1600 && random() < 0.25;

      const bill = await billService.createForOrder(
        restaurantId,
        {
          orderId: order.id,
          discountCode: useCoupon ? "SAVE100" : null,
          outletId: null,
          loyaltyPoints: null,
          items: [],
        },
        userId
      );

      const method = pick(paymentMethods);

      await billService.addPayment(
        restaurantId,
        bill.id,
        {
          paymentMethod: method,
          amount: bill.dueAmount,
          tenderedAmount: method === "cash" ? Math.ceil(bill.dueAmount / 100) * 100 : null,
          transactionRef: method === "upi" ? `UPI${between(100000, 999999)}` : null,
        },
        userId
      );

      stamps[stamps.length - 1].billId = bill.id;

      totalBills += 1;
      totalSales += bill.totalAmount;

      if (method === "cash") {
        cashTaken += bill.totalAmount;
      }
    }

    // Every fifth day the kitchen orders what has run low and the goods arrive
    // the same day. Without this a month of selling would drive the shelves
    // negative. The gap after the last delivery is deliberate: a few things are
    // always running low in a working kitchen, so the low-stock alert has
    // something true to show.
    if (back % 5 === 0 && back > 0) {
      const low = (
        await pool.query(
          `SELECT id, name, current_stock, reorder_level
           FROM inventory_items
           WHERE restaurant_id = $1 AND status = 'active'
             AND current_stock <= reorder_level * 1.5
           ORDER BY current_stock ASC
           LIMIT 12`,
          [restaurantId]
        )
      ).rows;

      if (low.length > 0) {
        const lines = low.map((row) => {
          const reference = ingredientById.get(row.id);
          // Ordered up to a couple of weeks' cover, not a warehouse full.
          const target = Number(row.reorder_level) * 2.5 + 8;
          const shortfall = Math.max(target - Number(row.current_stock), 5);

          return {
            inventoryItemId: row.id,
            quantity: Math.ceil(shortfall),
            // Suppliers nudge their prices around from week to week.
            unitPrice: Math.round(reference.cost * (0.94 + random() * 0.14) * 100) / 100,
          };
        });

        const po = await purchaseService.create(
          restaurantId,
          {
            supplierId: pick(suppliers).id,
            orderDate: businessDate,
            expectedDate: businessDate,
            poStatus: "ordered",
            notes: null,
            items: lines,
          },
          userId
        );

        // Received in full, which is the common case; a short delivery would be
        // a partial receive against the same order.
        const full = await purchaseService.getById(restaurantId, po.id);

        // Goods arrive with the supplier's bill, on credit — the supplier is
        // paid later from Returns & payments, as a real kitchen does it.
        await purchaseService.receive(
          restaurantId,
          po.id,
          {
            billNumber: `${po.poNumber || "PO"}-B`,
            billDate: businessDate,
            receivedDate: businessDate,
            pricesIncludeTax: false,
            billTotal: null,
            notes: null,
            paymentMode: "credit",
            paymentMethod: "cash",
            paidFromTill: false,
            paymentReference: null,
            outletId: null,
            lines: full.items.map((line) => ({
              itemId: line.id,
              quantity: line.quantity,
              rejectedQuantity: 0,
              rejectionReason: null,
              unitPrice: null,
              taxRate: null,
            })),
          },
          userId
        );

        purchaseOrders += 1;
      }
    }

    // Stamp each order and its bill with the time it was actually served,
    // rather than the moment this script happened to write the row. The bill
    // follows the order by the time it takes to eat.
    for (const stamp of stamps) {
      await pool.query(
        `UPDATE orders
         SET placed_at = ($2::date + $3::time) AT TIME ZONE $5,
             completed_at = CASE WHEN completed_at IS NULL THEN NULL
                                 ELSE ($2::date + $3::time + INTERVAL '50 minutes')
                                      AT TIME ZONE $5 END
         WHERE restaurant_id = $1 AND id = $4`,
        [restaurantId, businessDate, stamp.at, stamp.orderId, timezone]
      );

      if (stamp.billId) {
        await pool.query(
          `UPDATE bills
           SET billed_at = ($2::date + $3::time + INTERVAL '45 minutes') AT TIME ZONE $5,
               settled_at = CASE WHEN settled_at IS NULL THEN NULL
                                 ELSE ($2::date + $3::time + INTERVAL '50 minutes')
                                      AT TIME ZONE $5 END
           WHERE restaurant_id = $1 AND id = $4`,
          [restaurantId, businessDate, stamp.at, stamp.billId, timezone]
        );

        await pool.query(
          `UPDATE payments
           SET paid_at = ($2::date + $3::time + INTERVAL '50 minutes') AT TIME ZONE $4
           WHERE restaurant_id = $1 AND bill_id = $5`,
          [restaurantId, businessDate, stamp.at, timezone, stamp.billId]
        );
      }
    }

    // The last day stays open, so the POS has a live day to work in.
    if (back > 0) {
      // A little cash goes missing now and then, as it does.
      const drift = random() < 0.2 ? -between(20, 120) : 0;

      await businessDayService.closeDay(
        restaurantId,
        {
          closingCash: Math.round(openingCash + cashTaken + drift),
          notes: drift ? "Counted short at close" : null,
        },
        userId
      );
    }

    // Stamped last, because closeDay sets closed_at to NOW(): the day opened in
    // the morning and closed at night, not in the two seconds this script took.
    await pool.query(
      `UPDATE business_days
       SET opened_at = business_date + TIME '10:00',
           closed_at = CASE WHEN closed_at IS NULL THEN NULL
                            ELSE business_date + TIME '23:30' END
       WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, day.id]
    );
  }

  say(`  trading · ${DAYS_OF_TRADING + 1} business days, ${totalOrders} orders, ${totalBills} bills`);
  say(`  purchasing · ${purchaseOrders} purchase orders raised and received`);

  // ---- Expenses, spread over the same period
  const EXPENSE_CATEGORIES = [
    ["Rent", "Premises rent and deposits"],
    ["Utilities", "Electricity, water and gas"],
    ["Salaries", "Wages, advances and bonuses"],
    ["Maintenance", "Repairs and servicing"],
    ["Marketing", "Advertising and promotions"],
    ["Miscellaneous", "Anything that fits nowhere else"],
  ];

  for (const [name, description] of EXPENSE_CATEGORIES) {
    await expenseService.createCategory(
      restaurantId,
      { name, description, status: "active" },
      userId
    );
  }

  const expenseCategories = await expenseService.listCategories(restaurantId);
  const byName = new Map(expenseCategories.map((row) => [row.name.toLowerCase(), row]));
  const anyCategory = expenseCategories[0];

  const EXPENSES = [
    ["rent", "Monthly rent — September", 85000, 28],
    ["utilities", "Electricity bill", 18400, 24],
    ["utilities", "Water tanker", 2400, 18],
    ["salaries", "Staff advance — Mahesh", 5000, 20],
    ["maintenance", "Chimney servicing", 3800, 15],
    ["marketing", "Local newspaper insert", 6500, 12],
    ["utilities", "Gas cylinder refill (x4)", 7200, 9],
    ["maintenance", "Plumbing repair", 1600, 6],
    ["marketing", "Festival banner printing", 2800, 3],
  ];

  let expenseCount = 0;

  for (const [categoryHint, description, amount, daysAgo] of EXPENSES) {
    const category = byName.get(categoryHint) || anyCategory;

    if (!category) {
      break;
    }

    const when = new Date(today);
    when.setDate(when.getDate() - daysAgo);

    await expenseService.create(
      restaurantId,
      {
        expenseCategoryId: category.id,
        supplierId: null,
        expenseDate: isoDate(when),
        amount,
        paymentMode: amount > 20000 ? "bank" : "cash",
        referenceNo: null,
        notes: description,
      },
      userId
    );

    expenseCount += 1;
  }

  // Purchase orders carry their own order_date, but the row timestamps would
  // otherwise all say "now".
  await pool.query(
    `UPDATE purchase_orders SET created_at = order_date + TIME '10:30',
                                updated_at = order_date + TIME '17:00'
     WHERE restaurant_id = $1`,
    [restaurantId]
  );

  say(`  expenses · ${expenseCount}`);

  // ---- Feedback, from guests who actually visited
  const FEEDBACK = [
    [0, 5, "Biryani was excellent, service quick even though it was busy."],
    [1, 4, "Good food. AC cabin was a bit warm."],
    [3, 5, "Paneer butter masala is the best in town."],
    [5, 3, "Food fine but we waited 25 minutes for the bill."],
    [7, 5, "Very clean and the staff were polite."],
    [9, 4, "Portions are generous. Will come back."],
  ];

  for (const [customerIndex, rating, comments] of FEEDBACK) {
    await crmService.createFeedback(
      restaurantId,
      {
        customerId: customers[customerIndex].id,
        customerName: null,
        customerMobile: null,
        rating,
        comments,
        source: "in_store",
        feedbackStatus: "new",
      },
      userId
    );
  }

  await crmService.createComplaint(
    restaurantId,
    {
      customerId: customers[5].id,
      customerName: null,
      customerMobile: null,
      subject: "Long wait for the bill",
      description: "Guest waited around 25 minutes for the bill on a Saturday evening.",
      category: "service",
      priority: "medium",
      assignedTo: null,
      complaintStatus: "open",
    },
    userId
  );

  say(`  feedback · ${FEEDBACK.length} reviews, 1 complaint`);

  // ---- Summary
  const totals = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM products WHERE restaurant_id = $1) AS products,
       (SELECT COUNT(*)::int FROM orders WHERE restaurant_id = $1) AS orders,
       (SELECT COUNT(*)::int FROM bills WHERE restaurant_id = $1) AS bills,
       (SELECT COALESCE(SUM(total_amount), 0) FROM bills
         WHERE restaurant_id = $1 AND bill_status <> 'void') AS sales,
       (SELECT COALESCE(SUM(loyalty_points), 0) FROM customers WHERE restaurant_id = $1) AS points,
       (SELECT COUNT(*)::int FROM stock_transactions WHERE restaurant_id = $1) AS movements`,
    [restaurantId]
  );

  const row = totals.rows[0];

  say("\nDone.");
  say(`  ${row.products} dishes · ${row.orders} orders · ${row.bills} bills`);
  say(`  ₹${Number(row.sales).toLocaleString("en-IN")} of sales over ${DAYS_OF_TRADING + 1} days`);
  say(`  ${row.movements} stock movements · ${row.points} loyalty points held by guests`);
  say("\nToday's business day is still open, so the POS is ready to take an order.\n");
};

main()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error("\nSeeding failed:", error.message);
    console.error(error);
    await pool.end();
    process.exit(1);
  });
