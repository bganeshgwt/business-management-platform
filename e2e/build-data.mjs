// Makes the browser tests' shared data (test-data.mjs) through the API, the
// way people make it: the platform admin sets up the restaurants and the
// businesses, their owner sets up everything inside them. Returns what the
// specs need to find it again: ids, the table QR codes, document numbers.
// `sql(text, values)` runs one statement on the run's own database, for the
// one thing no request can make: an order taken on an earlier day.
import crypto from "node:crypto";

import { BUSINESSES, GROCERY, MEAT, PLATFORM, RESTAURANT, SALON, TIMEZONE, WHOLESALE } from "./test-data.mjs";

// Every call names the status it expects, so a set-up that goes wrong stops
// at the first wrong answer, with the API's own message, rather than leaving
// specs to fail later on data that is not there.
function caller(base, token) {
  return async (method, route, body, expected = 200) => {
    const response = await fetch(base + route, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();

    if (response.status !== expected) {
      throw new Error(`Test data: ${method} ${route} answered ${response.status}, expected ${expected}: ${text.slice(0, 500)}`);
    }

    const answer = text ? JSON.parse(text) : {};
    return answer.data ?? answer;
  };
}

const requestKey = () => crypto.randomUUID();

// Runs `work` for every item, `size` at a time.
async function inBatches(items, size, work) {
  for (let start = 0; start < items.length; start += size) {
    await Promise.all(items.slice(start, start + size).map(work));
  }
}

// The specialist tools a new business starts without (migration
// 1791950400000), switched on as an owner of that trade would: every one its
// type offers, each once the tools it needs are on. Tasks, issues and
// projects go on only where the trade is recommended them (a supermarket, a
// pharmacy, a clinic).
const TOOLS = ["offers", "loyalty", "stock_transfers", "repairs", "finance", "packages", "commissions", "lab", "processing"];
const TEAM_TOOLS = ["tasks", "issues", "projects"];

async function switchOnTools(owner, businessId) {
  const modules = await owner("GET", `/businesses/${businessId}/modules`);
  const offered = new Map(modules.filter((module) => module.kind !== "core").map((module) => [module.code, module]));
  const on = new Set(modules.filter((module) => module.enabled || module.kind === "core").map((module) => module.code));
  const wanted = [...TOOLS, ...(offered.get("tasks")?.recommended ? TEAM_TOOLS : [])];
  let waiting = wanted.filter((code) => offered.has(code) && !on.has(code));

  while (waiting.length) {
    const ready = waiting.filter((code) => offered.get(code).requires.every((need) => on.has(need)));

    if (!ready.length) {
      break;
    }

    for (const code of ready) {
      await owner("PUT", `/businesses/${businessId}/modules/${code}`, { enabled: true });
      on.add(code);
    }

    waiting = waiting.filter((code) => !on.has(code));
  }
}

export async function buildTestData({ api, logins, sql }) {
  const login = (role) => logins.find((item) => item.role === role);
  const signIn = async (role) => {
    const { email, password } = login(role);
    return (await caller(api)("POST", "/auth/login", { identifier: email, password })).token;
  };

  // --- The restaurant, its admin and staff ----------------------------------
  const platform = caller(api, await signIn("SUPER_ADMIN"));
  const admin = login("RESTAURANT_ADMIN");
  const restaurant = await platform("POST", "/users/platform/restaurants", {
    name: RESTAURANT.name,
    code: RESTAURANT.code,
    timezone: TIMEZONE,
    admin: { name: admin.name, email: admin.email, password: admin.password },
  }, 201);
  const owner = caller(api, await signIn("RESTAURANT_ADMIN"));

  const roles = await owner("GET", "/roles");
  for (const person of logins.filter((item) => !["SUPER_ADMIN", "RESTAURANT_ADMIN"].includes(item.role))) {
    const role = roles.find((item) => item.code === person.role && item.isSystem);
    await owner("POST", "/users", { name: person.name, email: person.email, password: person.password, roleIds: [role.id] }, 201);
  }

  const outlets = [];
  for (const outlet of RESTAURANT.outlets) {
    const made = await owner("POST", "/outlets", outlet, 201);
    outlets.push({ id: made.id, name: made.name, code: made.code });
  }

  // Tables with no outlet: every outlet's floor, and "All outlets", sees them.
  const floor = await owner("POST", "/tables/floors", { name: RESTAURANT.floor }, 201);
  for (const tableNo of RESTAURANT.tables) {
    await owner("POST", "/tables", { floorId: floor.id, tableNo, capacity: 4 }, 201);
  }
  // A table goes to "cleaning" after its bill, so the floor's "Mark ready" can be tried.
  await owner("PUT", "/tables/settings", { cleaningMinutes: 5 });

  const categories = [];
  for (const name of RESTAURANT.categories) {
    categories.push(await owner("POST", "/menu/categories", { name }, 201));
  }
  // No tax given: each dish takes the restaurant's default GST rate.
  const products = [];
  for (const dish of RESTAURANT.products) {
    const categoryId = categories.find((category) => category.name === dish.category).id;
    products.push(await owner("POST", "/menu/products", { categoryId, name: dish.name, price: dish.price, foodType: dish.foodType, isAvailable: true }, 201));
  }
  const modifier = await owner("POST", "/menu/modifiers", RESTAURANT.modifier, 201);
  const expenseCategory = await owner("POST", "/expenses/categories", { name: RESTAURANT.expenseCategory }, 201);

  const unit = await owner("POST", "/inventory/units", RESTAURANT.stockUnit, 201);
  const stockItems = [];
  for (const item of RESTAURANT.stockItems) {
    const made = await owner("POST", "/inventory/items", {
      name: item.name, unitId: unit.id, reorderLevel: item.reorderLevel, openingStock: item.openingStock, openingCost: item.cost,
    }, 201);
    stockItems.push({ id: made.id, name: item.name, reorderLevel: item.reorderLevel, openingStock: item.openingStock });
  }

  // Today's trading, at the main counter (no outlet): the day the till would
  // open on the restaurant's own clock, a paid takeaway and a running table.
  const day = await owner("POST", "/business-day/open", { openingCash: 2000 }, 201);
  const lines = (wanted) => wanted.map(({ product, quantity }) => ({ productId: products.find((dish) => dish.name === product).id, quantity }));
  const takeaway = await owner("POST", "/orders", { orderType: "takeaway", items: lines(RESTAURANT.paidTakeaway) }, 201);
  const bill = await owner("POST", "/bills", { orderId: takeaway.id }, 201);
  await owner("POST", `/bills/${bill.id}/payments`, { paymentMethod: "cash", amount: bill.dueAmount }, 201);

  let tables = await owner("GET", "/tables");
  const busyTable = tables.find((table) => table.tableNo === RESTAURANT.busyTable);
  const running = await owner("POST", "/orders", { orderType: "dine_in", tableId: busyTable.id, guestCount: 2, items: lines(RESTAURANT.runningOrder) }, 201);
  tables = await owner("GET", "/tables");

  // A table whose order was taken days ago and never billed or closed. An
  // order is always placed now, so this one is placed through the API and
  // then moved back in the database, the way the API's own tests make one.
  const leftOpenTable = await owner("POST", "/tables", { floorId: floor.id, tableNo: RESTAURANT.leftOpen.tableNo, capacity: 4 }, 201);
  const leftOpen = await owner("POST", "/orders", {
    orderType: "dine_in", tableId: leftOpenTable.id, guestCount: 2, items: lines(RESTAURANT.leftOpen.items),
  }, 201);
  const [movedBack] = await sql(
    "UPDATE orders SET placed_at = placed_at - make_interval(days => $3::int) WHERE id = $1 AND restaurant_id = $2 RETURNING id",
    [leftOpen.id, restaurant.id, RESTAURANT.leftOpen.daysAgo]
  );
  if (!movedBack) {
    throw new Error(`Test data: order ${leftOpen.orderNumber} could not be moved back ${RESTAURANT.leftOpen.daysAgo} days.`);
  }

  // --- The rest of the platform's restaurants --------------------------------
  // Each comes with its own admin, as every restaurant does; nobody signs in
  // as them, so their password is not kept.
  const othersPassword = crypto.randomBytes(12).toString("base64url");
  const others = Array.from({ length: PLATFORM.restaurants - 1 }, (_, index) => String(index + 1).padStart(2, "0"));
  await inBatches(others, 4, (number) =>
    platform("POST", "/users/platform/restaurants", {
      name: `${PLATFORM.otherName} ${number}`,
      code: `E2EREST${number}`,
      timezone: TIMEZONE,
      admin: { name: `Admin ${number}`, email: `admin${number}@restaurants.e2e.invalid`, password: othersPassword },
    }, 201)
  );

  // --- The businesses ---------------------------------------------------------
  // The platform creates each for the restaurant's admin, whose existing
  // login becomes its owner.
  const created = {};
  for (const [type, business] of Object.entries(BUSINESSES)) {
    created[type] = (await platform("POST", "/users/platform/businesses", {
      businessType: type, name: business.name, code: business.code, timezone: TIMEZONE, owner: { email: admin.email },
    }, 201)).business;
  }
  for (const business of Object.values(created)) {
    await switchOnTools(owner, business.id);
  }

  const directory = (await owner("GET", "/businesses")).businesses;
  const businesses = {};
  for (const [type, business] of Object.entries(created)) {
    const row = directory.find((item) => String(item.id) === String(business.id));
    const location = (await owner("GET", `/businesses/${business.id}/locations`)).items[0];
    businesses[type] = { id: business.id, type, name: business.name, code: business.code, locationId: location.id, capabilities: row.capabilities };
  }
  const at = (type) => (route) => `/businesses/${businesses[type].id}/${route}`;

  // The grocery's rice, its stock, and one paid sale today.
  {
    const B = at("grocery");
    const locationId = businesses.grocery.locationId;
    const supplier = await owner("POST", B("contacts"), { kind: "supplier", name: GROCERY.supplier }, 201);
    const weighed = await owner("POST", B("catalog"), {
      name: GROCERY.weighedItem.name, code: "RICE-LOOSE", kind: "goods", unit: GROCERY.weighedItem.unit, tracking: "quantity", price: String(GROCERY.weighedItem.price), taxRate: "0",
    }, 201);
    const piece = await owner("POST", B("catalog"), {
      name: GROCERY.pieceItem.name, code: "RICE-BAS1", kind: "goods", unit: GROCERY.pieceItem.unit, tracking: "quantity", price: String(GROCERY.pieceItem.price), taxRate: "5",
    }, 201);
    const items = { [weighed.label]: weighed, [piece.label]: piece };
    await owner("POST", B("documents"), {
      kind: "purchase", requestKey: requestKey(), locationId, contactId: supplier.id,
      lines: [{ skuId: weighed.id, quantity: "200", unitPrice: "48" }, { skuId: piece.id, quantity: "60", unitPrice: "118" }],
    }, 201);
    const sale = await owner("POST", B("documents"), {
      kind: "sale", requestKey: requestKey(), locationId,
      lines: GROCERY.sale.map((line) => ({ skuId: items[line.item].id, quantity: String(line.quantity) })),
      payment: { amount: "full", method: "cash" },
    }, 201);
    Object.assign(businesses.grocery, {
      supplier: { id: supplier.id, name: supplier.name },
      weighedItem: { id: weighed.id, name: weighed.label },
      pieceItem: { id: piece.id, name: piece.label },
      sale: { id: sale.id, number: sale.document_no, total: Number(sale.total) },
    });
  }

  // The meat shop's cuts and their stock.
  {
    const B = at("meat");
    const supplier = await owner("POST", B("contacts"), { kind: "supplier", name: MEAT.supplier }, 201);
    const items = [];
    for (const [index, cut] of MEAT.items.entries()) {
      items.push(await owner("POST", B("catalog"), {
        name: cut.name, code: `CHICKEN-${index + 1}`, kind: "goods", unit: cut.unit, tracking: "quantity", price: String(cut.price), taxRate: "0",
      }, 201));
    }
    await owner("POST", B("documents"), {
      kind: "purchase", requestKey: requestKey(), locationId: businesses.meat.locationId, contactId: supplier.id,
      lines: items.map((item) => ({ skuId: item.id, quantity: "30", unitPrice: "180" })),
    }, 201);
    Object.assign(businesses.meat, {
      supplier: { id: supplier.id, name: supplier.name },
      items: items.map((item) => ({ id: item.id, name: item.label })),
    });
  }

  // The wholesaler's noodles by the case, its stock, and a retailer's unpaid credit sale.
  {
    const B = at("wholesale");
    const locationId = businesses.wholesale.locationId;
    const supplier = await owner("POST", B("contacts"), { kind: "supplier", name: WHOLESALE.supplier, creditDays: 30 }, 201);
    const customer = await owner("POST", B("contacts"), { kind: "customer", name: WHOLESALE.customer, creditDays: 30 }, 201);
    const item = await owner("POST", B("catalog"), {
      name: WHOLESALE.item.name, code: "NOODLES-70", kind: "goods", unit: WHOLESALE.item.unit, tracking: "quantity", price: String(WHOLESALE.item.price), taxRate: "5",
    }, 201);
    await owner("POST", B("pack-sizes"), { skuId: item.id, unitCode: WHOLESALE.packUnit, quantityInBase: String(WHOLESALE.packSize) }, 201);
    await owner("POST", B("documents"), {
      kind: "purchase", requestKey: requestKey(), locationId, contactId: supplier.id,
      lines: [{ skuId: item.id, quantity: String(WHOLESALE.packSize * 10), unitPrice: "9.50" }],
    }, 201);
    const sale = await owner("POST", B("documents"), {
      kind: "sale", requestKey: requestKey(), locationId, contactId: customer.id,
      lines: [{ skuId: item.id, quantity: String(WHOLESALE.creditSale.quantity) }],
    }, 201);
    Object.assign(businesses.wholesale, {
      supplier: { id: supplier.id, name: supplier.name },
      customer: { id: customer.id, name: customer.name },
      item: { id: item.id, name: item.label },
      creditSale: { id: sale.id, number: sale.document_no, total: Number(sale.total) },
    });
  }

  // The salon's stylist and service.
  {
    const B = at("salon");
    const stylist = await owner("POST", B("resources"), { name: SALON.stylist.name, roleLabel: SALON.stylist.role, locationId: businesses.salon.locationId }, 201);
    const service = await owner("POST", B("catalog"), {
      name: SALON.service.name, code: "SVC-HAIRCUT", kind: "service", unit: "service", tracking: "none", price: String(SALON.service.price), taxRate: "18",
    }, 201);
    Object.assign(businesses.salon, {
      stylist: { id: stylist.id, name: stylist.name },
      service: { id: service.id, name: service.label },
    });
  }

  return {
    accounts: logins.map(({ role, name, email, password }) => ({ role, name, email, password })),
    restaurant: {
      id: restaurant.id,
      name: restaurant.name,
      code: restaurant.code,
      timezone: TIMEZONE,
      businessDate: day.businessDate,
      outlets,
      floor: { id: floor.id, name: floor.name },
      tables: RESTAURANT.tables.map((tableNo) => {
        const table = tables.find((item) => item.tableNo === tableNo);
        return { id: table.id, tableNo, qrToken: table.qrToken, free: tableNo !== RESTAURANT.busyTable };
      }),
      categories: categories.map((category) => ({ id: category.id, name: category.name })),
      products: products.map((dish) => ({ id: dish.id, name: dish.name, price: Number(dish.price), categoryId: dish.categoryId })),
      modifier: { id: modifier.id, name: modifier.name, price: Number(modifier.price) },
      expenseCategory: { id: expenseCategory.id, name: expenseCategory.name },
      stockUnit: { id: unit.id, name: unit.name, shortName: unit.shortName },
      stockItems,
      paidBill: { id: bill.id, number: bill.billNumber, orderId: takeaway.id, total: bill.totalAmount },
      runningOrder: { id: running.id, number: running.orderNumber, tableId: busyTable.id, tableNo: busyTable.tableNo },
      leftOpenOrder: { id: leftOpen.id, number: leftOpen.orderNumber, tableId: leftOpenTable.id, tableNo: leftOpenTable.tableNo },
    },
    platform: { restaurants: PLATFORM.restaurants },
    businesses,
  };
}
