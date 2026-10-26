// Makes the browser tests' shared data (test-data.mjs) through the API, the
// way people make it: the platform admin sets up the restaurants and the
// businesses, their owner sets up everything inside them. Returns what the
// specs need to find it again: ids, the table QR codes, document numbers.
// `sql(text, values)` runs one statement on the run's own database, for what
// no request can make: an order taken, or a hire handed over, on an earlier day.
import crypto from "node:crypto";

import { AGRI, BUSINESSES, FUEL, GARAGE, GROCERY, HARDWARE, JEWELLERY, LAUNDRY, LODGING, MEAT, MEMBERSHIPS, OPTICAL, PLATFORM, RENTALS, RESTAURANT, SALON, TIMEZONE, WHOLESALE } from "./test-data.mjs";

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

// A PIN as a person picks one, made fresh for every run like the passwords:
// six digits, never a run (123456) or a repeat (111111), which the API refuses.
function freshPin() {
  for (;;) {
    const pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    if (!/^(\d)\1+$/.test(pin) && !"01234567890".includes(pin) && !"09876543210".includes(pin)) return pin;
  }
}

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
// The trades added later (migration 1791960000000) also switch on the tools
// that migration recommends for them.
const TYPE_TOOLS = {
  general_retail: ["variants"], hardware: ["wholesale", "sales_orders"], agri_inputs: ["wholesale"],
  optical: ["batches", "variants", "appointments"], garage: ["appointments", "wholesale"], memberships: ["appointments"],
};

async function switchOnTools(owner, businessId, type) {
  const modules = await owner("GET", `/businesses/${businessId}/modules`);
  const offered = new Map(modules.filter((module) => module.kind !== "core").map((module) => [module.code, module]));
  const on = new Set(modules.filter((module) => module.enabled || module.kind === "core").map((module) => module.code));
  const wanted = [...TOOLS, ...(TYPE_TOOLS[type] || []), ...(offered.get("tasks")?.recommended ? TEAM_TOOLS : [])];
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

  // The restaurant's own staff. A login with businesses of its own works in
  // those shops only, and is made with them further down.
  const roles = await owner("GET", "/roles");
  for (const person of logins.filter((item) => !["SUPER_ADMIN", "RESTAURANT_ADMIN"].includes(item.role) && !item.businesses)) {
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
  for (const [type, business] of Object.entries(created)) {
    await switchOnTools(owner, business.id, type);
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

  // The hardware shop's cement, binding wire and floor tiles (with what a box
  // covers), their stock, a contractor with a site, and a painter who earns
  // commission on cement (fitters' commission starts off).
  {
    const B = at("hardware");
    const supplier = await owner("POST", B("contacts"), { kind: "supplier", name: HARDWARE.supplier }, 201);
    const contractor = await owner("POST", B("contacts"), { kind: "customer", name: HARDWARE.contractor.name, phone: HARDWARE.contractor.phone }, 201);
    const cement = await owner("POST", B("catalog"), {
      name: HARDWARE.cement.name, code: "CEM-OPC53", kind: "goods", unit: HARDWARE.cement.unit, tracking: "quantity", price: String(HARDWARE.cement.price),
      mrp: String(HARDWARE.cement.mrp), hsnCode: HARDWARE.cement.hsn, taxRate: "18",
    }, 201);
    const wire = await owner("POST", B("catalog"), {
      name: HARDWARE.wire.name, code: "WIRE-20G", kind: "goods", unit: HARDWARE.wire.unit, tracking: "quantity", price: String(HARDWARE.wire.price), hsnCode: HARDWARE.wire.hsn, taxRate: "18",
    }, 201);
    await owner("POST", B("pack-sizes"), { skuId: wire.id, unitCode: HARDWARE.packUnit, quantityInBase: String(HARDWARE.packSize) }, 201);
    const tiles = await owner("POST", B("catalog"), {
      name: HARDWARE.tiles.name, code: "VIT-2X2", kind: "goods", unit: HARDWARE.tiles.unit, tracking: "quantity", price: String(HARDWARE.tiles.price), hsnCode: HARDWARE.tiles.hsn,
      taxRate: "18", attributes: { coverageSqftPerUnit: String(HARDWARE.tiles.coverage) },
    }, 201);
    await owner("POST", B("documents"), {
      kind: "purchase", requestKey: requestKey(), locationId: businesses.hardware.locationId, contactId: supplier.id, supplierBillNo: "ACD-1001",
      lines: [{ skuId: cement.id, quantity: "200", unitPrice: "340" }, { skuId: wire.id, quantity: "250", unitPrice: "80" }, { skuId: tiles.id, quantity: "100", unitPrice: "900" }],
    }, 201);
    const site = await owner("POST", B("hardware/sites"), { contactId: contractor.id, name: HARDWARE.site.name, address: HARDWARE.site.address }, 201);
    await owner("PUT", B("modules/fitter_commission"), { enabled: true });
    const fitter = await owner("POST", B("hardware/fitters"), {
      name: HARDWARE.fitter.name, trade: HARDWARE.fitter.trade, phone: HARDWARE.fitter.phone, upiId: HARDWARE.fitter.upiId,
    }, 201);
    await owner("POST", B("hardware/fitter-rules"), { skuId: cement.id, perUnit: String(HARDWARE.fitter.perBag) }, 201);
    Object.assign(businesses.hardware, {
      fitter: { id: fitter.id, name: fitter.name },
      supplier: { id: supplier.id, name: supplier.name },
      contractor: { id: contractor.id, name: contractor.name },
      site: { id: site.id, name: site.name },
      cement: { id: cement.id, name: cement.label },
      wire: { id: wire.id, name: wire.label },
      tiles: { id: tiles.id, name: tiles.label },
    });
  }

  // The seeds, fertilisers & pesticides shop: its fertiliser, seed and
  // insecticide licences; subsidised urea, a chlorpyrifos pesticide and paddy
  // seed (by batch, each lot with its expiry), received from the supplier; and
  // a farmer from Kothur.
  {
    const B = at("agri_inputs");
    const locationId = businesses.agri_inputs.locationId;
    const day = (days) => new Date(Date.now() + days * 86400000).toLocaleDateString("en-CA", { timeZone: TIMEZONE });
    for (const licence of AGRI.licences) {
      await owner("POST", B("licences"), { ...licence, locationId, authority: "Agriculture Officer, Rangareddy", validFrom: day(-300), validUntil: day(700) }, 201);
    }
    const supplier = await owner("POST", B("contacts"), { kind: "supplier", name: AGRI.supplier }, 201);
    const urea = await owner("POST", B("catalog"), {
      name: AGRI.urea.name, code: "UREA-45", kind: "goods", unit: AGRI.urea.unit, tracking: "quantity", price: String(AGRI.urea.price), mrp: String(AGRI.urea.mrp),
      hsnCode: AGRI.urea.hsn, taxRate: "5", attributes: { inputKind: "fertiliser", subsidised: true, netKg: "45" },
    }, 201);
    const pesticide = await owner("POST", B("catalog"), {
      name: AGRI.pesticide.name, code: "CPF-500", kind: "goods", unit: AGRI.pesticide.unit, tracking: "batch", price: String(AGRI.pesticide.price), mrp: String(AGRI.pesticide.mrp),
      hsnCode: AGRI.pesticide.hsn, taxRate: "18",
      attributes: { inputKind: "pesticide", molecules: [AGRI.pesticide.molecule], formulation: AGRI.pesticide.formulation, manufacturer: AGRI.pesticide.manufacturer },
    }, 201);
    const seed = await owner("POST", B("catalog"), {
      name: AGRI.seed.name, code: "SEED-BPT", kind: "goods", unit: AGRI.seed.unit, tracking: "batch", price: String(AGRI.seed.price), taxRate: "0",
      attributes: { inputKind: "seed", seedClass: "certified", seedCrop: AGRI.seed.crop, seedVariety: AGRI.seed.variety },
    }, 201);
    await owner("POST", B("documents"), {
      kind: "purchase", requestKey: requestKey(), locationId, contactId: supplier.id, supplierBillNo: "IF-2201",
      lines: [{ skuId: urea.id, quantity: "100", unitPrice: "242" }, { skuId: pesticide.id, quantity: "24", unitPrice: "330", lotCode: AGRI.pesticide.lot, expiresOn: day(300) },
        { skuId: seed.id, quantity: "200", unitPrice: "45", lotCode: AGRI.seed.lot, expiresOn: day(120) }],
    }, 201);
    const farmer = await owner("POST", B("agri/farmers"), AGRI.farmer, 201);
    Object.assign(businesses.agri_inputs, {
      supplier: { id: supplier.id, name: supplier.name },
      urea: { id: urea.id, name: urea.label },
      pesticide: { id: pesticide.id, name: pesticide.label },
      seed: { id: seed.id, name: seed.label },
      farmer: { id: farmer.contact_id, name: farmer.name },
    });
  }

  // The optical shop: its frame and lens in stock, the fitting charge, a
  // customer with today's prescription and one due for an eye test.
  {
    const B = at("optical");
    const locationId = businesses.optical.locationId;
    const day = (days) => new Date(Date.now() + days * 86400000).toLocaleDateString("en-CA", { timeZone: TIMEZONE });
    const supplier = await owner("POST", B("contacts"), { kind: "supplier", name: OPTICAL.supplier }, 201);
    const goods = (item, extra = {}) => owner("POST", B("catalog"), {
      name: item.name, code: item.code, kind: "goods", unit: "each", tracking: "quantity", price: String(item.price), hsnCode: item.hsn, taxRate: "5", ...extra,
    }, 201);
    const frame = await goods(OPTICAL.frame, { mrp: String(OPTICAL.frame.mrp) });
    const lens = await goods(OPTICAL.lens);
    const fitting = await owner("POST", B("catalog"), { name: OPTICAL.fitting.name, code: OPTICAL.fitting.code, kind: "service", unit: "service", price: String(OPTICAL.fitting.price), taxRate: "18" }, 201);
    await owner("POST", B("documents"), {
      kind: "purchase", requestKey: requestKey(), locationId, contactId: supplier.id,
      lines: [{ skuId: frame.id, quantity: "3", unitPrice: "1200" }, { skuId: lens.id, quantity: "10", unitPrice: "400" }],
    }, 201);
    const customer = await owner("POST", B("contacts"), { kind: "customer", ...OPTICAL.customer }, 201);
    const due = await owner("POST", B("contacts"), { kind: "customer", name: OPTICAL.due.name, phone: OPTICAL.due.phone }, 201);
    const prescription = await owner("POST", B("optical/prescriptions"), { requestKey: requestKey(), contactId: customer.id, pdBinocular: "63", rows: [
      { eye: "right", zone: "distance", sph: "-2.25", cyl: "-0.75", axis: "180" }, { eye: "left", zone: "distance", sph: "-2.00", cyl: "-0.50", axis: "90" }] }, 201);
    await owner("POST", B("optical/prescriptions"), { requestKey: requestKey(), contactId: due.id, examinedOn: day(-OPTICAL.due.daysAgo), rows: [
      { eye: "right", zone: "distance", sph: "+1.25" }, { eye: "left", zone: "distance", sph: "+1.50" }] }, 201);
    Object.assign(businesses.optical, {
      supplier: { id: supplier.id, name: supplier.name },
      frame: { id: frame.id, name: frame.label }, lens: { id: lens.id, name: lens.label }, fitting: { id: fitting.id, name: fitting.label },
      customer: { id: customer.id, name: customer.name }, due: { id: due.id, name: due.name }, prescription: { id: prescription.id },
    });
  }

  // The garage: engine oil and an oil filter in stock, service labour, a
  // customer's car with its last reading, and a scooter due for its service.
  {
    const B = at("garage");
    const day = (days) => new Date(Date.now() + days * 86400000).toLocaleDateString("en-CA", { timeZone: TIMEZONE });
    const supplier = await owner("POST", B("contacts"), { kind: "supplier", name: GARAGE.supplier }, 201);
    const goods = (item) => owner("POST", B("catalog"), {
      name: item.name, code: item.code, kind: "goods", unit: item.unit, tracking: "quantity", price: String(item.price), mrp: String(item.mrp), hsnCode: item.hsn, taxRate: "18",
    }, 201);
    const oil = await goods(GARAGE.oil);
    const filter = await goods(GARAGE.filter);
    const labour = await owner("POST", B("catalog"), {
      name: GARAGE.labour.name, code: GARAGE.labour.code, kind: "service", unit: "service", price: String(GARAGE.labour.price), hsnCode: GARAGE.labour.sac, taxRate: "18",
    }, 201);
    await owner("POST", B("documents"), {
      kind: "purchase", requestKey: requestKey(), locationId: businesses.garage.locationId, contactId: supplier.id,
      lines: [{ skuId: oil.id, quantity: "20", unitPrice: "300" }, { skuId: filter.id, quantity: "5", unitPrice: "220" }],
    }, 201);
    const { odometerKm, insuranceInDays, ...car } = GARAGE.car;
    const swift = await owner("POST", B("garage/vehicles"), { ...car, owner: GARAGE.owner, odometerKm: String(odometerKm), insuranceExpiresOn: day(insuranceInDays) }, 201);
    const { serviceInDays, ...scooter } = GARAGE.scooter;
    const activa = await owner("POST", B("garage/vehicles"), { ...scooter, owner: GARAGE.scooterOwner, nextServiceOn: day(serviceInDays) }, 201);
    Object.assign(businesses.garage, {
      supplier: { id: supplier.id, name: supplier.name },
      oil: { id: oil.id, name: oil.label }, filter: { id: filter.id, name: filter.label }, labour: { id: labour.id, name: labour.label },
      car: { id: swift.id, registrationNo: swift.registration_no, owner: swift.owner_name },
      scooter: { id: activa.id, registrationNo: activa.registration_no, owner: activa.owner_name },
    });
  }

  // The gym: its joining fee, its plans (each sold as its own service item at
  // 5% GST), a member with a paid monthly membership and one on the trial.
  {
    const B = at("memberships");
    const gst5 = (await owner("GET", B("tax-rates?limit=100"), undefined, 200)).items.find((r) => Number(r.rate) === 5);
    const joining = await owner("POST", B("catalog"), {
      name: MEMBERSHIPS.joining.name, code: MEMBERSHIPS.joining.code, kind: "service", unit: "service", price: String(MEMBERSHIPS.joining.price), hsnCode: MEMBERSHIPS.joining.sac, taxRateId: gst5.id,
    }, 201);
    const plan = (body) => owner("POST", B("member-plans/plans"), { policy: MEMBERSHIPS.policy, ...body }, 201);
    const item = (price) => ({ price: String(price), taxRateId: gst5.id, hsnCode: "999723" });
    const monthly = await plan({ name: MEMBERSHIPS.monthly.name, kind: "duration", durationUnit: "months", duration: "1", item: item(MEMBERSHIPS.monthly.price), joiningSkuId: joining.id,
      maxFreezes: String(MEMBERSHIPS.monthly.freezes), maxFreezeDays: String(MEMBERSHIPS.monthly.freezeDays), graceDays: String(MEMBERSHIPS.monthly.grace), transferable: true });
    const yoga = await plan({ name: MEMBERSHIPS.yoga.name, kind: "sessions", sessions: String(MEMBERSHIPS.yoga.sessions), item: item(MEMBERSHIPS.yoga.price) });
    const trial = await plan({ name: MEMBERSHIPS.trial.name, kind: "duration", durationUnit: "days", duration: String(MEMBERSHIPS.trial.days), item: item(MEMBERSHIPS.trial.price) });
    const sell = (planId, member) => owner("POST", B("member-plans/memberships"), { requestKey: requestKey(), locationId: businesses.memberships.locationId, planId, member,
      payments: [{ amount: "full", method: "cash" }] }, 201);
    const sold = await sell(monthly.id, MEMBERSHIPS.member);
    const tried = await sell(trial.id, MEMBERSHIPS.trialMember);
    Object.assign(businesses.memberships, {
      monthly: { id: monthly.id, name: monthly.name }, yoga: { id: yoga.id, name: yoga.name }, trial: { id: trial.id, name: trial.name },
      member: { id: sold.contact_id, name: sold.member_name, code: sold.member_code, membershipId: sold.id, membershipNo: sold.membership_no },
      trialMember: { id: tried.contact_id, name: tried.member_name, code: tried.member_code, membershipId: tried.id, membershipNo: tried.membership_no },
    });
  }

  // The laundry: its services (each made as its own service item at the
  // default 18% slab), its garments and their prices, express and the terms on
  // the receipt; a customer's order taken in, billed when handed over.
  {
    const B = at("laundry");
    const service = (body) => owner("POST", B("laundry/services"), body, 201);
    await service({ item: { name: LAUNDRY.dryCleaning.name, hsnCode: LAUNDRY.dryCleaning.sac } });
    await service({ item: { name: LAUNDRY.washIron.name } });
    let list = await service({ item: { name: LAUNDRY.washFold.name } });
    for (const garment of [LAUNDRY.shirt, LAUNDRY.saree, LAUNDRY.mixed]) list = await owner("POST", B("laundry/garments"), { name: garment.name }, 201);
    const serviceId = (name) => list.services.find((s) => s.name === name).id;
    const garmentId = (name) => list.garments.find((g) => g.name === name).id;
    const price = (garment, service, value, per = "item") => ({ garmentTypeId: garmentId(garment), serviceId: serviceId(service), per, price: String(value) });
    await owner("PUT", B("laundry/prices"), { prices: [price(LAUNDRY.shirt.name, LAUNDRY.washIron.name, LAUNDRY.shirt.washIron),
      price(LAUNDRY.shirt.name, LAUNDRY.dryCleaning.name, LAUNDRY.shirt.dryCleaning), price(LAUNDRY.saree.name, LAUNDRY.dryCleaning.name, LAUNDRY.saree.dryCleaning),
      price(LAUNDRY.mixed.name, LAUNDRY.washFold.name, LAUNDRY.mixed.washFoldKg, "kg")] }, 200);
    await owner("PUT", B("laundry/settings"), { expressPercent: String(LAUNDRY.express), receiptTerms: LAUNDRY.terms }, 200);
    const customer = await owner("POST", B("contacts"), { kind: "customer", name: LAUNDRY.customer.name, phone: LAUNDRY.customer.phone }, 201);
    const day = (days) => new Date(Date.now() + days * 86400000).toLocaleDateString("en-CA", { timeZone: TIMEZONE });
    const order = await owner("POST", B("laundry/orders"), { requestKey: requestKey(), locationId: businesses.laundry.locationId, contactId: customer.id, promisedOn: day(2),
      items: [{ garmentTypeId: garmentId(LAUNDRY.shirt.name), serviceId: serviceId(LAUNDRY.washIron.name), quantity: "2" },
        { garmentTypeId: garmentId(LAUNDRY.saree.name), serviceId: serviceId(LAUNDRY.dryCleaning.name), defects: ["stain"], riskNote: "Silk: colour may run", acknowledged: true }] }, 201);
    Object.assign(businesses.laundry, {
      customer: { id: customer.id, name: customer.name },
      order: { id: order.id, orderNo: order.order_no, total: order.total, tags: order.items.map((item) => item.tag_no) },
    });
  }

  // The jeweller: today's rates on its own date; the hallmarking charge and
  // its location's district under mandatory hallmarking; its BIS registration,
  // kept with the licences tool (switched on for it); its rings and chains as
  // jewellery items, and pieces tagged into stock as opening stock; a
  // customer's old gold taken in; and a gold scheme plan with a customer
  // enrolled in it, three instalments paid.
  {
    const B = at("jewellery");
    const locationId = businesses.jewellery.locationId;
    const day = (days) => new Date(Date.now() + days * 86400000).toLocaleDateString("en-CA", { timeZone: TIMEZONE });
    await owner("POST", B("jewellery/rates"), { requestKey: requestKey(), session: "morning", source: "association",
      rates: JEWELLERY.rates.map((r) => ({ metal: r.metal, purity: r.purity, sellRate: String(r.sell), buyRate: String(r.buy) })) }, 201);
    await owner("PUT", B("jewellery/settings"), { hallmarkCharge: String(JEWELLERY.hallmarkCharge),
      locations: [{ locationId, mandatory: true, district: JEWELLERY.district }] }, 200);
    await owner("PUT", B("modules/licences"), { enabled: true });
    await owner("POST", B("licences"), { locationId, kind: "bis", name: JEWELLERY.bis.name, licenceNo: JEWELLERY.bis.licenceNo, authority: JEWELLERY.bis.authority,
      validFrom: day(-400) }, 201);
    const item = async (made) => (await owner("POST", B("jewellery/items"), { item: { name: made.name, hsnCode: "7113", code: made.code }, metal: "gold", purity: "22K",
      wastagePercent: String(made.wastage), makingMode: "per_gram", makingValue: String(made.makingPerGram) }, 201)).items.find((i) => i.label === made.name);
    const ring = await item(JEWELLERY.ring);
    const chain = await item(JEWELLERY.chain);
    // Each piece takes its item's purity, making and wastage; a hallmarked one the settings' hallmarking charge.
    const tag = async (sku, made, extra = {}) => {
      const piece = await owner("POST", B("jewellery/pieces"), { requestKey: requestKey(), skuId: sku.sku_id, comesIn: "new", locationId, reason: "opening",
        description: made.description, grossWeight: made.gross, stoneWeight: made.stones || "0", ...(made.huid ? { hallmarked: true, huids: [made.huid] } : {}), ...extra }, 201);
      return { id: piece.id, tag: piece.tag_no, description: made.description, huid: made.huid || null };
    };
    const counterRing = await tag(ring, JEWELLERY.counterRing, {
      stones: [{ kind: "ruby", pieces: "1", carat: JEWELLERY.counterRing.ruby.carat, value: String(JEWELLERY.counterRing.ruby.value) }] });
    const exchangeRing = await tag(ring, JEWELLERY.exchangeRing);
    const schemeRing = await tag(ring, JEWELLERY.schemeRing);
    const unmarkedChain = await tag(chain, JEWELLERY.unmarkedChain);
    const customer = (person) => owner("POST", B("contacts"), { kind: "customer", name: person.name, phone: person.phone }, 201);
    const seller = await customer(JEWELLERY.oldGold.seller);
    const { line } = JEWELLERY.oldGold;
    const voucher = await owner("POST", B("jewellery/old-gold"), { requestKey: requestKey(), locationId, contactId: seller.id, idKind: JEWELLERY.oldGold.idKind,
      idRef: JEWELLERY.oldGold.idRef, ownerDeclared: true, lines: [{ description: line.description, metal: "gold", purity: "22K", testMethod: "xrf",
        testedFineness: line.tested, grossWeight: line.gross, lessWeight: line.less, deductionPercent: line.deduction }] }, 201);
    const { plan: terms } = JEWELLERY;
    const plan = (await owner("POST", B("jewellery/scheme-plans"), { requestKey: requestKey(), name: terms.name, instalments: terms.instalments,
      minInstalment: String(terms.minInstalment), discountPercent: String(terms.discountPercent), terms: terms.terms }, 201)).items.find((p) => p.name === terms.name);
    const member = await customer(JEWELLERY.member);
    let scheme = await owner("POST", B("jewellery/schemes"), { requestKey: requestKey(), locationId, planId: plan.id, contactId: member.id,
      instalment: String(JEWELLERY.member.instalment), nomineeName: JEWELLERY.member.nominee, nomineeRelation: JEWELLERY.member.relation, termsAccepted: true,
      payment: { method: "upi" } }, 201);
    for (let paid = 1; paid < JEWELLERY.member.instalmentsPaid; paid++) {
      scheme = await owner("POST", B(`jewellery/schemes/${scheme.id}/instalments`), { requestKey: requestKey(), method: "upi" }, 201);
    }
    Object.assign(businesses.jewellery, {
      items: { ring: { skuId: ring.sku_id, name: ring.label }, chain: { skuId: chain.sku_id, name: chain.label } },
      counterRing, exchangeRing, schemeRing, unmarkedChain,
      oldGold: { id: voucher.id, voucherNo: voucher.voucher_no, value: voucher.value, seller: { id: seller.id, name: seller.name } },
      plan: { id: plan.id, name: plan.name },
      scheme: { id: scheme.id, schemeNo: scheme.scheme_no, paid: scheme.paid, member: { id: member.id, name: member.name } },
    });
  }

  // The tent house: a hirer's photo ID at every handover and its terms; a
  // generator hired one by one (two units, each with its hour meter), plastic
  // chairs from a pool and a sound system by the day, each its own service
  // item at 18%; the first generator booked for tomorrow; a sound system
  // handed over with its deposit, then moved back in the database (the way
  // the API's own tests move one) so that it is past its due back time now;
  // and the other generator with chairs, going out now.
  {
    const B = at("rentals");
    const locationId = businesses.rentals.locationId;
    const gst18 = (await owner("GET", B("tax-rates?limit=100"))).items.find((r) => Number(r.rate) === 18);
    await owner("PUT", B("rentals/settings"), { idRequired: true, terms: RENTALS.terms });
    const item = async (made, body) => (await owner("POST", B("rentals/items"), { item: { name: made.name, code: made.code, taxRateId: gst18.id, hsnCode: RENTALS.sac },
      rates: made.rates, deposit: String(made.deposit), ...body }, 201)).items.find((i) => i.name === made.name);
    const units = (made) => made.units.map((u) => ({ label: u.label, serialNo: u.serialNo, ...(u.meter ? { meterReading: u.meter } : {}) }));
    const generator = await item(RENTALS.generator, { kind: "unit", meter: "hours", minHours: RENTALS.generator.minHours, bufferMinutes: RENTALS.generator.turnaround,
      graceMinutes: RENTALS.generator.grace, latePer: "hour", units: units(RENTALS.generator) });
    const chairs = await item(RENTALS.chairs, { kind: "pool", poolQuantity: RENTALS.chairs.pool, latePer: "day" });
    const sound = await item(RENTALS.sound, { kind: "unit", latePer: "day", lateRate: String(RENTALS.sound.lateRate), graceMinutes: RENTALS.sound.grace,
      units: units(RENTALS.sound) });
    const unitOf = (made, label) => made.units.find((u) => u.label === label);
    const hirer = (person) => owner("POST", B("contacts"), { kind: "customer", name: person.name, phone: person.phone }, 201);
    const book = (contact, times, lines) => owner("POST", B("rentals/bookings"), { requestKey: requestKey(), locationId, status: "reserved", contactId: contact.id, ...times, lines }, 201);
    const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString("en-CA", { timeZone: TIMEZONE });
    const bookedTimes = { outAt: `${tomorrow}T${RENTALS.booked.from}`, dueAt: `${tomorrow}T${RENTALS.booked.until}` };
    const bookedHirer = await hirer(RENTALS.booked.hirer);
    const booked = await book(bookedHirer, bookedTimes, [{ itemId: generator.id, unitId: unitOf(generator, "Gen A").id }]);
    const start = Date.now();
    const after = (minutes) => new Date(start + minutes * 60000).toISOString();
    const lateHirer = await hirer(RENTALS.late.hirer);
    const late = await book(lateHirer, { outAt: after(0), dueAt: after(24 * 60) }, [{ itemId: sound.id, unitId: unitOf(sound, "Sound 1").id }]);
    await owner("POST", B(`rentals/bookings/${late.id}/checkout`), { requestKey: requestKey(), idKind: RENTALS.late.idKind, idRef: RENTALS.late.idRef,
      deposit: { amount: late.deposit_due, method: "cash" } });
    // A booking handed over keeps its times (a database guard), so the guard
    // is lifted for this one statement; the availability check still runs.
    const minutes = 24 * 60 + RENTALS.late.minutesPastDue;
    await sql("ALTER TABLE rental_bookings DISABLE TRIGGER rental_bookings_guard");
    try {
      await sql(`UPDATE rental_bookings SET out_at=out_at-make_interval(mins => $3::int),due_at=due_at-make_interval(mins => $3::int),
        checked_out_at=checked_out_at-make_interval(mins => $3::int) WHERE business_id=$1 AND id=$2`, [businesses.rentals.id, late.id, minutes]);
    } finally {
      await sql("ALTER TABLE rental_bookings ENABLE TRIGGER rental_bookings_guard");
    }
    if (!(await owner("GET", B(`rentals/bookings/${late.id}`))).overdue) {
      throw new Error(`Test data: booking ${late.booking_no} could not be moved back ${minutes} minutes.`);
    }
    const goingHirer = await hirer(RENTALS.going.hirer);
    const going = await book(goingHirer, { outAt: after(0), dueAt: after(RENTALS.going.hours * 60) },
      [{ itemId: generator.id, unitId: unitOf(generator, "Gen B").id }, { itemId: chairs.id, quantity: String(RENTALS.going.chairs) }]);
    Object.assign(businesses.rentals, {
      items: { generator: { id: generator.id, name: generator.name }, chairs: { id: chairs.id, name: chairs.name }, sound: { id: sound.id, name: sound.name } },
      units: Object.fromEntries([...generator.units, ...sound.units].map((u) => [u.label, u.id])),
      booked: { id: booked.id, bookingNo: booked.booking_no, hirer: bookedHirer.name, ...bookedTimes },
      late: { id: late.id, bookingNo: late.booking_no, hirer: lateHirer.name, deposit: late.deposit_due },
      going: { id: going.id, bookingNo: going.booking_no, hirer: goingHirer.name, dueAt: going.due_at, deposit: going.deposit_due },
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

  // The fuel station: its fuels on the GST nil slab, a tank of each with its
  // stock, a dispensing unit with a nozzle for each, the 5-litre measure, the
  // prices from yesterday morning and yesterday's morning dips; a diesel shift
  // opened two hours ago and closed an hour ago, exact in cash; the terminal
  // as a supplier; a transport company with a truck filled on credit; and the
  // oil company's fleet card as a payment method.
  {
    const B = at("fuel_station");
    const locationId = businesses.fuel_station.locationId;
    const day = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString("en-CA", { timeZone: TIMEZONE });
    // Typed times are read to the minute.
    const minute = Math.floor(Date.now() / 60000) * 60000;
    const ago = (minutes) => new Date(minute - minutes * 60000).toISOString();
    const fuel = async (made, family) => (await owner("POST", B("fuel/products"), { item: { name: made.name }, family }, 201)).products.find((p) => p.name === made.name);
    const petrol = await fuel(FUEL.petrol, "petrol");
    const diesel = await fuel(FUEL.diesel, "diesel");
    const tank = async (made, product) => (await owner("POST", B("fuel/tanks"), { locationId, productId: product.id, tankNo: made.tank.tankNo, capacity: made.tank.capacity,
      stockNow: { litres: made.tank.stock } }, 201)).tanks.find((t) => t.tank_no === made.tank.tankNo);
    const petrolTank = await tank(FUEL.petrol, petrol);
    const dieselTank = await tank(FUEL.diesel, diesel);
    const unit = (await owner("POST", B("fuel/dispensers"), { locationId, unitNo: FUEL.unit.unitNo, make: FUEL.unit.make, stampingDue: day(FUEL.unit.stampingInDays),
      nozzles: [{ nozzleNo: FUEL.petrol.nozzle.nozzleNo, tankId: petrolTank.id, reading: FUEL.petrol.nozzle.reading },
        { nozzleNo: FUEL.diesel.nozzle.nozzleNo, tankId: dieselTank.id, reading: FUEL.diesel.nozzle.reading }] }, 201)).dispensers.find((d) => d.unit_no === FUEL.unit.unitNo);
    const nozzleOf = (made) => unit.nozzles.find((n) => n.nozzle_no === made.nozzle.nozzleNo);
    await owner("POST", B("fuel/measures"), { locationId, name: FUEL.measure.name, litres: FUEL.measure.litres, stampingDue: day(FUEL.measure.stampingInDays) }, 201);
    await owner("POST", B("fuel/prices"), { requestKey: requestKey(), locationId, effectiveFrom: ago(26 * 60),
      prices: [{ productId: petrol.id, price: FUEL.petrol.price }, { productId: diesel.id, price: FUEL.diesel.price }] }, 201);
    for (const [made, tankMade] of [[FUEL.petrol, petrolTank], [FUEL.diesel, dieselTank]]) {
      await owner("POST", B("fuel/dips"), { requestKey: requestKey(), tankId: tankMade.id, dipOn: day(-1), takenAt: `${day(-1)}T06:00`, stock: made.tank.stock }, 201);
    }
    const shift = await owner("POST", B("fuel/shifts"), { requestKey: requestKey(), locationId, openedAt: ago(120), nozzles: [nozzleOf(FUEL.diesel).id] }, 201);
    const closed = await owner("POST", B(`fuel/shifts/${shift.id}/close`), { requestKey: requestKey(), closedAt: ago(60),
      readings: [{ nozzleId: nozzleOf(FUEL.diesel).id, closing: FUEL.closedShift.closing, test: FUEL.closedShift.test }], cash: FUEL.closedShift.cash });
    if (Number(closed.close.difference) !== 0) throw new Error(`Test data: shift ${closed.shift_no} closed ${closed.close.difference} out.`);
    const terminal = await owner("POST", B("contacts"), { kind: "supplier", name: FUEL.supplier }, 201);
    const fleet = await owner("POST", B("contacts"), { kind: "customer", name: FUEL.fleet.name, phone: FUEL.fleet.phone, creditDays: FUEL.fleet.creditDays,
      creditLimit: FUEL.fleet.creditLimit }, 201);
    const truck = await owner("POST", B("fuel/vehicles"), { contactId: fleet.id, registration: FUEL.fleet.vehicle.registration, description: FUEL.fleet.vehicle.description,
      productId: diesel.id, fillLimit: FUEL.fleet.vehicle.fillLimit }, 201);
    await owner("POST", B("payment-methods"), { name: FUEL.fleetCard, kind: "card" }, 201);
    Object.assign(businesses.fuel_station, {
      fuels: { petrol: { id: petrol.id, name: petrol.name }, diesel: { id: diesel.id, name: diesel.name } },
      tanks: { petrol: { id: petrolTank.id, tankNo: petrolTank.tank_no }, diesel: { id: dieselTank.id, tankNo: dieselTank.tank_no } },
      nozzles: { petrol: { id: nozzleOf(FUEL.petrol).id, nozzleNo: FUEL.petrol.nozzle.nozzleNo }, diesel: { id: nozzleOf(FUEL.diesel).id, nozzleNo: FUEL.diesel.nozzle.nozzleNo } },
      closedShift: { id: closed.id, shiftNo: closed.shift_no },
      supplier: { id: terminal.id, name: terminal.name },
      fleet: { id: fleet.id, name: fleet.name },
      truck: { id: truck.id, registration: truck.registration },
    });
  }

  // The lodge: the two GST slabs of a room night (5% and 18%), the weekend
  // nights and its terms; Deluxe rooms 101 and 102 and a Suite, 201, with their
  // rates; a family in the Suite with an advance, checked in and then moved
  // back a day in the database (the way the API's own tests move one), so that
  // they came yesterday and leave today; and a phone reservation for tonight
  // in room 102.
  {
    const B = at("lodging");
    const locationId = businesses.lodging.locationId;
    const slabs = (await owner("GET", B("tax-rates?limit=100"))).items;
    const gst5 = slabs.find((r) => Number(r.rate) === 5), gst18 = slabs.find((r) => Number(r.rate) === 18);
    await owner("PUT", B("lodging/settings"), { lowTaxRateId: gst5.id, highTaxRateId: gst18.id, weekendNights: LODGING.weekendNights, terms: LODGING.terms });
    const roomType = async (made) => (await owner("POST", B("lodging/room-types"), { item: { name: made.name, hsnCode: LODGING.sac }, baseOccupancy: made.baseOccupancy,
      maxOccupancy: made.maxOccupancy, maxExtraBeds: made.extraBeds || 0, rates: made.rates }, 201)).roomTypes.find((t) => t.name === made.name);
    const deluxe = await roomType(LODGING.deluxe);
    const suite = await roomType(LODGING.suite);
    await owner("POST", B("lodging/rooms"), { locationId, roomTypeId: deluxe.id, rooms: LODGING.deluxe.rooms.map((roomNo) => ({ roomNo, floor: "1" })) }, 201);
    const rooms = (await owner("POST", B("lodging/rooms"), { locationId, roomTypeId: suite.id, rooms: LODGING.suite.rooms.map((roomNo) => ({ roomNo, floor: "2" })) }, 201)).rooms;
    const roomOf = (no) => rooms.find((r) => r.room_no === no);
    // Dates on the lodge's own clock.
    const today = new Date().toLocaleDateString("en-CA", { timeZone: TIMEZONE });
    const day = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
    const family = await owner("POST", B("lodging/stays"), { requestKey: requestKey(), locationId, guest: LODGING.inHouse.guest, source: "phone", arrival: today, departure: day(1),
      roomTypeId: suite.id, roomId: roomOf("201").id, adults: LODGING.inHouse.adults, advance: { amount: LODGING.inHouse.advance, method: "cash" } }, 201);
    await owner("POST", B(`lodging/stays/${family.id}/check-in`), { requestKey: requestKey(), guests: LODGING.inHouse.occupants });
    // A stay in the house keeps its arrival (a database guard), so the guards
    // are lifted for these statements; the room and room type checks still run.
    await sql("ALTER TABLE lodging_stays DISABLE TRIGGER lodging_stays_guard");
    await sql("ALTER TABLE lodging_stay_guests DISABLE TRIGGER lodging_stay_guests_guard");
    try {
      await sql("UPDATE lodging_stays SET arrival=arrival-1,departure=departure-1,checked_in_at=checked_in_at-interval '1 day' WHERE business_id=$1 AND id=$2",
        [businesses.lodging.id, family.id]);
      await sql("UPDATE lodging_stay_guests SET arrived_at=arrived_at-interval '1 day',created_at=created_at-interval '1 day' WHERE business_id=$1 AND stay_id=$2",
        [businesses.lodging.id, family.id]);
    } finally {
      await sql("ALTER TABLE lodging_stay_guests ENABLE TRIGGER lodging_stay_guests_guard");
      await sql("ALTER TABLE lodging_stays ENABLE TRIGGER lodging_stays_guard");
    }
    if ((await owner("GET", B(`lodging/stays/${family.id}`))).arrival !== day(-1)) {
      throw new Error(`Test data: stay ${family.stay_no} could not be moved back a day.`);
    }
    const booked = await owner("POST", B("lodging/stays"), { requestKey: requestKey(), locationId, guest: LODGING.booked.guest, source: "phone", arrival: today, departure: day(1),
      roomTypeId: deluxe.id, roomId: roomOf("102").id, adults: LODGING.booked.adults }, 201);
    Object.assign(businesses.lodging, {
      roomTypes: { deluxe: { id: deluxe.id, name: deluxe.name }, suite: { id: suite.id, name: suite.name } },
      rooms: Object.fromEntries(rooms.map((r) => [r.room_no, r.id])),
      inHouse: { id: family.id, stayNo: family.stay_no, guest: family.guest_name, arrival: day(-1) },
      booked: { id: booked.id, stayNo: booked.stay_no, guest: booked.guest_name },
    });
  }

  // Each login that works in some of the owner's shops: made in the first
  // of them, as Staff & access › New staff login makes one, then given access
  // to the others; a manager in every one, or the role of its trade it names.
  for (const person of logins.filter((item) => item.businesses)) {
    const [first, ...others] = person.businesses.map((type) => businesses[type]);
    const roleIn = async (business) => (await owner("GET", `/businesses/${business.id}/roles`)).items.find((role) => role.template_code === (person.businessRole || "manager"));
    const made = await owner("POST", `/businesses/${first.id}/staff-accounts`, {
      name: person.name, email: person.email, password: person.password, roleId: (await roleIn(first)).id,
    }, 201);
    for (const business of others) {
      await owner("POST", `/businesses/${business.id}/members`, person.businessRole ? { userId: made.user_id, roleId: (await roleIn(business)).id } : { userId: made.user_id, role: "manager" }, 201);
    }
  }

  // The tent house's manager approves money handed back from a deposit with a
  // PIN of their own, set the way My profile › Personal PIN sets one.
  {
    const manager = login("RENTALS_MANAGER");
    const pin = freshPin();
    await caller(api, await signIn("RENTALS_MANAGER"))("PUT", "/auth/me/pin", { password: manager.password, pin, confirmPin: pin });
    businesses.rentals.manager = { name: manager.name, pin };
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
