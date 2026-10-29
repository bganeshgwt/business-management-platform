const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./fuelCommon');

// The forecourt's set-up (module "fuel", fuel stations), typed in by the
// dealer: nothing here reads a dispenser or a tank gauge.
//
//   fuels      each fuel sold: a goods item of the catalogue kept in stock by
//              quantity, counted in litres (CNG in kilos), on the GST nil
//              slab: petrol, diesel and CNG are outside GST, their price
//              including the state's VAT (an existing item, or one made with
//              it). Petrol and diesel come in from tanker receipts, CNG on a
//              purchase; every fuel is sold only by a shift's close.
//   tanks      each tank at an outlet: its number, fuel and capacity, and the
//              stock in it when it is added (brought into stock as a correction).
//   units      each dispensing unit with its Weights & Measures stamping and
//              when it falls due; in use, suspended (not used until it is
//              re-stamped) or retired; and its nozzles, each drawing its
//              tank's fuel (CNG from none) with its totaliser as it reads.
//   meters     a totaliser replaced or reset: a manager records the reading
//              before and after and why, while no shift is open on it.
//   measures   the outlet's stamped measures (the 5-litre measure of the daily
//              nozzle test) and when each falls due.
//   prices     each fuel's price at each outlet from the moment it takes
//              effect (now, or a time typed: the morning's revision); never
//              changed, a new one set. A shift sells at the price in force
//              when it opened.
//   settings   the tolerances the registers check against (MDG 2024) and the
//              test measure's quantity; the bell's warning days.
// The PESO licence (Form XIV) of each outlet is kept with the licences
// (Settings › Licences); the set-up shows where it stands.

const { fail, id } = c;

const PRODUCTS_SQL = `SELECT f.id,f.sku_id,f.family,f.sort_order,f.active,s.label AS name,s.code AS item_code,s.unit,s.tax_rate,s.hsn_code,(s.active AND p.active) AS item_active
  FROM fuel_products f JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
  WHERE f.business_id=$1`;

async function productsOf(db, business) {
  return repo.all(db, `${PRODUCTS_SQL} ORDER BY f.active DESC,f.sort_order,lower(s.label),f.id`, [business.id]);
}

// The prices in force now at each outlet, and the next one set to take effect.
async function pricesOf(db, business, locationId = null) {
  return repo.all(db, `SELECT l.id AS location_id,l.name AS location_name,f.id AS product_id,s.label AS name,f.family,s.unit,
      cur.price,cur.effective_from,nxt.price AS next_price,nxt.effective_from AS next_from
    FROM business_locations l CROSS JOIN fuel_products f JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id
    LEFT JOIN LATERAL (SELECT price,effective_from FROM fuel_prices x WHERE x.business_id=l.business_id AND x.location_id=l.id AND x.product_id=f.id AND x.effective_from<=now()
      ORDER BY effective_from DESC LIMIT 1) cur ON TRUE
    LEFT JOIN LATERAL (SELECT price,effective_from FROM fuel_prices x WHERE x.business_id=l.business_id AND x.location_id=l.id AND x.product_id=f.id AND x.effective_from>now()
      ORDER BY effective_from LIMIT 1) nxt ON TRUE
    WHERE l.business_id=$1 AND f.business_id=$1 AND l.active AND f.active AND ($2::bigint IS NULL OR l.id=$2)
    ORDER BY l.id,f.sort_order,lower(s.label)`, [business.id, locationId]);
}

async function load(db, business) {
  const scope = business.location_scope || null;
  const [products, tanks, dispensers, nozzles, measures, settings, prices] = [
    await productsOf(db, business),
    await repo.all(db, `SELECT t.*,l.name AS location_name,s.label AS product_name,f.family,
        (SELECT row_to_json(d) FROM (SELECT x.dip_on::text AS dip_on,x.stock,x.taken_at FROM fuel_dips x WHERE x.business_id=t.business_id AND x.tank_id=t.id ORDER BY x.dip_on DESC LIMIT 1) d) AS last_dip
      FROM fuel_tanks t JOIN business_locations l ON l.business_id=t.business_id AND l.id=t.location_id
      JOIN fuel_products f ON f.business_id=t.business_id AND f.id=t.product_id JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id
      WHERE t.business_id=$1 AND ($2::bigint IS NULL OR t.location_id=$2) ORDER BY t.location_id,t.active DESC,t.sort_order,lower(t.tank_no)`, [business.id, scope]),
    await repo.all(db, `SELECT d.*,d.stamped_on::text AS stamped_on,d.stamping_due::text AS stamping_due,l.name AS location_name,
        (d.stamping_due - (now() AT TIME ZONE b.timezone)::date) AS days_to_due
      FROM fuel_dispensers d JOIN businesses b ON b.id=d.business_id JOIN business_locations l ON l.business_id=d.business_id AND l.id=d.location_id
      WHERE d.business_id=$1 AND ($2::bigint IS NULL OR d.location_id=$2) ORDER BY d.location_id,d.status='retired',d.sort_order,lower(d.unit_no)`, [business.id, scope]),
    await repo.all(db, `SELECT n.*,s.label AS product_name,f.family,s.unit,t.tank_no,o.shift_id AS open_shift_id,o.shift_no AS open_shift_no,o.attendant_name AS open_attendant
      FROM fuel_nozzles n JOIN fuel_products f ON f.business_id=n.business_id AND f.id=n.product_id JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id
      LEFT JOIN fuel_tanks t ON t.business_id=n.business_id AND t.id=n.tank_id
      LEFT JOIN LATERAL fuel_nozzle_open_shift(n.business_id,n.id) o ON TRUE
      WHERE n.business_id=$1 AND ($2::bigint IS NULL OR n.location_id=$2) ORDER BY n.location_id,n.sort_order,n.nozzle_no`, [business.id, scope]),
    await repo.all(db, `SELECT m.*,m.stamped_on::text AS stamped_on,m.stamping_due::text AS stamping_due,l.name AS location_name,
        (m.stamping_due - (now() AT TIME ZONE b.timezone)::date) AS days_to_due
      FROM fuel_measures m JOIN businesses b ON b.id=m.business_id JOIN business_locations l ON l.business_id=m.business_id AND l.id=m.location_id
      WHERE m.business_id=$1 AND ($2::bigint IS NULL OR m.location_id=$2) ORDER BY m.location_id,m.active DESC,lower(m.name)`, [business.id, scope]),
    await c.settingsOf(db, business.id),
    await pricesOf(db, business, scope),
  ];
  for (const d of dispensers) d.nozzles = nozzles.filter((n) => String(n.dispenser_id) === String(d.id));
  // The PESO licence (Form XIV) each outlet holds, from the licences.
  const day = await c.today(db, business);
  const locations = (await repo.all(db, 'SELECT id,name FROM business_locations WHERE business_id=$1 AND active AND ($2::bigint IS NULL OR id=$2) ORDER BY id', [business.id, scope]));
  const licences = require('../../licences/services/businessLicences.service');
  const peso = business.modules.includes('licences')
    ? await Promise.all(locations.map(async (l) => ({ locationId: l.id, locationName: l.name, licence: await licences.standing(db, business, { locationId: l.id, kind: 'peso', on: day }) })))
    : null;
  return { products, tanks, dispensers, measures, settings: settingsShape(settings), prices, peso, today: day };
}

async function setup(business) {
  c.requireFuel(business);
  await access.require(business, 'fuel.view');
  return load(repo.pool, business);
}

// --- Fuels -------------------------------------------------------------------------------------

// The business's GST nil slab, which a fuel's item is on.
async function nilSlab(db, business) {
  const slab = await repo.one(db, 'SELECT id FROM business_tax_rates WHERE business_id=$1 AND rate=0 AND active ORDER BY is_default DESC,id LIMIT 1', [business.id]);
  if (!slab) fail('This business has no GST nil slab switched on: add one under Settings › Tax rates (a fuel is outside GST)', 409);
  return slab;
}
// A free item code for a new fuel's item: FUEL-01, FUEL-02 ….
async function freeCode(db, businessId) {
  const count = await repo.one(db, 'SELECT count(*)::int AS n FROM fuel_products WHERE business_id=$1', [businessId]);
  for (let n = count.n + 1; ; n += 1) {
    const code = `FUEL-${String(n).padStart(2, '0')}`;
    if (!await repo.one(db, 'SELECT 1 FROM catalog_skus WHERE business_id=$1 AND code=$2', [businessId, code])) return code;
  }
}

// body: { skuId } an existing goods item (counted in litres, or kilos for CNG,
// kept by quantity, on the GST nil slab), or { item: { name, code?, hsnCode? } }
// for a new one; family: petrol | diesel | cng; sortOrder?
async function createProduct(business, user, body) {
  c.requireFuel(business);
  await access.require(business, 'catalog.edit');
  const family = v.requiredEnum(body.family, 'Fuel', c.FAMILIES);
  const sortOrder = c.given(body.sortOrder) ? c.whole(body.sortOrder, 'Order on the list', 0, 999) : 0;
  const insert = async (db, sku) => {
    await c.lockBusiness(db, business);
    if (await repo.one(db, 'SELECT 1 FROM fuel_products WHERE business_id=$1 AND sku_id=$2', [business.id, sku.id])) fail(`${sku.label} is already a fuel`, 409);
    const row = await repo.one(db, 'INSERT INTO fuel_products(business_id,sku_id,family,sort_order,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$5) RETURNING *',
      [business.id, sku.id, family, sortOrder, user.id]);
    await repo.audit(db, business.id, user.id, 'fuel_product.created', row.id, { name: sku.label, family });
    return row;
  };
  if (c.given(body.skuId)) {
    return repo.transaction(async (db) => {
      const sku = await repo.one(db, `SELECT s.id,s.label,s.unit,s.tracking,s.tax_rate,s.is_kit,p.kind FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
        WHERE s.business_id=$1 AND s.id=$2 AND s.active AND p.active`, [business.id, id(body.skuId, 'Item')]);
      if (!sku) fail('Item not found', 404);
      await insert(db, sku);
      return load(db, business);
    });
  }
  const typed = body.item && typeof body.item === 'object' && !Array.isArray(body.item) ? body.item : null;
  if (!typed) fail('Give the fuel\'s item: a new one with its name, or an existing goods item');
  const name = v.requiredString(typeof typed.name === 'string' ? typed.name : '', 'Name', 150);
  const slab = await nilSlab(repo.pool, business);
  const code = c.given(typed.code) ? String(typed.code).trim().toUpperCase() : await freeCode(repo.pool, business.id);
  // Priced by the fuel prices of each outlet, so the item's own price is nil.
  await core.createCatalog(business, user, { kind: 'goods', tracking: 'quantity', unit: family === 'cng' ? 'kg' : 'litre', name, label: name, code, price: '0',
    taxRateId: slab.id, hsnCode: typed.hsnCode }, async (db, sku) => { await insert(db, sku); });
  return load(repo.pool, business);
}

// body: { active?, sortOrder? } — what is left out stays.
async function updateProduct(business, user, productId, body) {
  c.requireFuel(business);
  await access.require(business, 'catalog.edit');
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const current = await repo.one(db, `SELECT f.*,s.label FROM fuel_products f JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id
      WHERE f.business_id=$1 AND f.id=$2 FOR UPDATE OF f`, [business.id, id(productId, 'Fuel')]);
    if (!current) fail('Fuel not found', 404);
    const active = v.requiredBoolean(body.active, 'In use', current.active);
    const sortOrder = c.given(body.sortOrder) ? c.whole(body.sortOrder, 'Order on the list', 0, 999) : current.sort_order;
    if (!active && current.active) {
      const busy = await repo.one(db, `SELECT n.nozzle_no FROM fuel_nozzles n WHERE n.business_id=$1 AND n.product_id=$2 AND n.active LIMIT 1`, [business.id, current.id]);
      if (busy) fail(`Nozzle ${busy.nozzle_no} still sells ${current.label}: switch its nozzles off first`, 409);
    }
    await db.query('UPDATE fuel_products SET active=$3,sort_order=$4,updated_by=$5,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, current.id, active, sortOrder, user.id]);
    if (active !== current.active || sortOrder !== current.sort_order) {
      await repo.audit(db, business.id, user.id, 'fuel_product.updated', current.id, { name: current.label, ...(active !== current.active ? { active } : {}),
        ...(sortOrder !== current.sort_order ? { sortOrder } : {}) });
    }
    return load(db, business);
  });
}

// --- Tanks ------------------------------------------------------------------------------------

// body: { locationId, productId, tankNo, capacity, sortOrder?, stockNow?: { litres, unitCost? } }
// The stock in the tank when it is added comes into stock as a correction
// ("Opening stock in tank T1"), for someone who may correct stock.
async function createTank(business, user, body) {
  c.requireFuel(business);
  await access.require(business, 'settings.edit');
  const tankNo = v.requiredString(typeof body.tankNo === 'string' ? body.tankNo : '', 'Tank number', 20);
  const capacity = c.readLitres(body.capacity, 'Capacity (litres)', { min: 0, minExclusive: true });
  const sortOrder = c.given(body.sortOrder) ? c.whole(body.sortOrder, 'Order on the list', 0, 999) : 0;
  const stockNow = body.stockNow && typeof body.stockNow === 'object' && c.given(body.stockNow.litres) && Number(body.stockNow.litres) > 0
    ? { litres: c.readLitres(body.stockNow.litres, 'Stock in it now (litres)', { max: Number(capacity) }),
      unitCost: c.given(body.stockNow.unitCost) ? core.decimal(body.stockNow.unitCost, 'Cost of a litre', 4) : 0 } : null;
  if (stockNow) await access.require(business, 'inventory.edit');
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const location = await c.locationOf(db, business, body.locationId);
    const product = await repo.one(db, `SELECT f.*,s.label,s.unit FROM fuel_products f JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id
      WHERE f.business_id=$1 AND f.id=$2 AND f.active`, [business.id, id(body.productId, 'Fuel')]);
    if (!product) fail('Fuel not found', 404);
    if (await repo.one(db, 'SELECT 1 FROM fuel_tanks WHERE business_id=$1 AND location_id=$2 AND lower(tank_no)=lower($3)', [business.id, location.id, tankNo])) {
      fail(`${location.name} already has a tank ${tankNo}`, 409);
    }
    const tank = await repo.one(db, 'INSERT INTO fuel_tanks(business_id,location_id,product_id,tank_no,capacity,sort_order,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *',
      [business.id, location.id, product.id, tankNo, capacity, sortOrder, user.id]);
    await repo.audit(db, business.id, user.id, 'fuel_tank.created', tank.id, { tankNo, fuel: product.label, capacity, location: location.name });
    if (stockNow) {
      let lot = await repo.one(db, `SELECT * FROM business_stock_lots WHERE business_id=$1 AND location_id=$2 AND sku_id=$3 AND lot_code='' FOR UPDATE`, [business.id, location.id, product.sku_id]);
      if (!lot) {
        lot = await repo.one(db, `INSERT INTO business_stock_lots(business_id,location_id,sku_id,lot_code,quantity,unit_cost) VALUES($1,$2,$3,'',0,$4) RETURNING *`,
          [business.id, location.id, product.sku_id, stockNow.unitCost.toFixed(4)]);
      }
      const { applyAdjustment } = require('../../core/services/businessReturns.service');
      const reason = `Opening stock in tank ${tankNo}`;
      const adjustment = await applyAdjustment(db, business, user, { ...lot, tracking: 'quantity', unit_decimals: 3, label: product.label }, Number(stockNow.litres), reason,
        c.derivedKey(require('node:crypto').randomUUID(), 'opening'));
      await repo.audit(db, business.id, user.id, 'stock.adjusted', adjustment.id, { reason, quantity: stockNow.litres, label: product.label });
      await repo.event(db, business.id, user.id, 'stock.adjusted', 'stock_adjustment', adjustment.id,
        { lotId: lot.id, skuId: product.sku_id, locationId: location.id, quantity: stockNow.litres, reason });
    }
    return load(db, business);
  });
}

// body: { tankNo?, capacity?, active?, sortOrder? } — what is left out stays. A tank keeps its outlet and its fuel.
async function updateTank(business, user, tankId, body) {
  c.requireFuel(business);
  await access.require(business, 'settings.edit');
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const current = await repo.one(db, 'SELECT * FROM fuel_tanks WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(tankId, 'Tank')]);
    if (!current) fail('Tank not found', 404);
    access.requireLocation(business, current.location_id);
    if (body.productId !== undefined && String(body.productId) !== String(current.product_id)) fail('A tank keeps the fuel it holds: add another tank for another fuel');
    const tankNo = body.tankNo === undefined ? current.tank_no : v.requiredString(typeof body.tankNo === 'string' ? body.tankNo : '', 'Tank number', 20);
    const capacity = body.capacity === undefined ? current.capacity : c.readLitres(body.capacity, 'Capacity (litres)', { min: 0, minExclusive: true });
    const active = v.requiredBoolean(body.active, 'In use', current.active);
    const sortOrder = c.given(body.sortOrder) ? c.whole(body.sortOrder, 'Order on the list', 0, 999) : current.sort_order;
    if (tankNo.toLowerCase() !== current.tank_no.toLowerCase()
        && await repo.one(db, 'SELECT 1 FROM fuel_tanks WHERE business_id=$1 AND location_id=$2 AND lower(tank_no)=lower($3) AND id<>$4', [business.id, current.location_id, tankNo, current.id])) {
      fail(`The outlet already has a tank ${tankNo}`, 409);
    }
    if (!active && current.active) {
      const drawn = await repo.one(db, 'SELECT nozzle_no FROM fuel_nozzles WHERE business_id=$1 AND tank_id=$2 AND active LIMIT 1', [business.id, current.id]);
      if (drawn) fail(`Nozzle ${drawn.nozzle_no} still draws from tank ${current.tank_no}: switch it off first`, 409);
    }
    await db.query('UPDATE fuel_tanks SET tank_no=$3,capacity=$4,active=$5,sort_order=$6,updated_by=$7,updated_at=now() WHERE business_id=$1 AND id=$2',
      [business.id, current.id, tankNo, capacity, active, sortOrder, user.id]);
    const was = { tankNo: current.tank_no, capacity: current.capacity, active: current.active, sortOrder: current.sort_order };
    const now = { tankNo, capacity: String(capacity), active, sortOrder };
    const changed = Object.keys(now).filter((k) => String(was[k]) !== String(now[k]));
    if (changed.length) await repo.audit(db, business.id, user.id, 'fuel_tank.updated', current.id, { from: Object.fromEntries(changed.map((k) => [k, was[k]])), to: Object.fromEntries(changed.map((k) => [k, now[k]])) });
    return load(db, business);
  });
}

// --- Dispensing units and nozzles --------------------------------------------------------------

function readUnit(body, current = null) {
  const keep = (name) => body[name] === undefined && current;
  const stampedOn = keep('stampedOn') ? current.stamped_on : c.given(body.stampedOn) ? c.readDate(body.stampedOn, 'Stamped on') : null;
  const stampingDue = keep('stampingDue') ? current.stamping_due : c.readDate(body.stampingDue, 'Stamping falls due on');
  if (stampedOn && String(stampingDue) <= String(stampedOn)) fail('The stamping falls due after it was stamped');
  return {
    unitNo: keep('unitNo') ? current.unit_no : v.requiredString(typeof body.unitNo === 'string' ? body.unitNo : '', 'Unit number', 20),
    make: keep('make') ? current.make : c.optionalText(body.make, 'Make', 80),
    serialNo: keep('serialNo') ? current.serial_no : c.optionalText(body.serialNo, 'Serial number', 40),
    stampedOn, stampingDue,
    sortOrder: c.given(body.sortOrder) ? c.whole(body.sortOrder, 'Order on the list', 0, 999) : current ? current.sort_order : 0,
  };
}
function readNozzle(raw, name = 'Nozzle') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${name} must be an object`);
  return {
    nozzleNo: c.readNozzleNo(raw.nozzleNo),
    tankId: c.given(raw.tankId) ? id(raw.tankId, `${name}: tank`) : null,
    productId: c.given(raw.productId) ? id(raw.productId, `${name}: fuel`) : null,
    reading: c.readReading(raw.reading ?? '0', `${name}: totaliser reading`),
  };
}
// A nozzle written for a unit: drawing its tank's fuel, or CNG from no tank.
async function insertNozzle(db, business, user, unit, nozzle) {
  let productId = nozzle.productId, tankId = nozzle.tankId;
  if (tankId) {
    const tank = await repo.one(db, 'SELECT * FROM fuel_tanks WHERE business_id=$1 AND id=$2 AND location_id=$3 AND active', [business.id, tankId, unit.location_id]);
    if (!tank) fail('Tank not found at this outlet', 404);
    if (productId && String(productId) !== String(tank.product_id)) fail(`Nozzle ${nozzle.nozzleNo} draws the fuel of tank ${tank.tank_no}`);
    productId = tank.product_id;
  } else {
    if (!productId) fail(`Nozzle ${nozzle.nozzleNo}: choose the tank it draws from (a CNG nozzle: its fuel)`);
    const product = await repo.one(db, 'SELECT family FROM fuel_products WHERE business_id=$1 AND id=$2 AND active', [business.id, productId]);
    if (!product) fail('Fuel not found', 404);
    if (product.family !== 'cng') fail(`Nozzle ${nozzle.nozzleNo} sells petrol or diesel: choose the tank it draws from`);
    tankId = null;
  }
  if (await repo.one(db, 'SELECT 1 FROM fuel_nozzles WHERE business_id=$1 AND location_id=$2 AND nozzle_no=$3', [business.id, unit.location_id, nozzle.nozzleNo])) {
    fail(`The outlet already has a nozzle ${nozzle.nozzleNo}`, 409);
  }
  const row = await repo.one(db, `INSERT INTO fuel_nozzles(business_id,location_id,dispenser_id,nozzle_no,product_id,tank_id,reading,created_by,updated_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`, [business.id, unit.location_id, unit.id, nozzle.nozzleNo, productId, tankId, nozzle.reading, user.id]);
  await repo.audit(db, business.id, user.id, 'fuel_nozzle.created', row.id, { unit: unit.unit_no, nozzleNo: row.nozzle_no, reading: row.reading });
  return row;
}

// body: { locationId, unitNo, make?, serialNo?, stampedOn?, stampingDue, sortOrder?, nozzles?: [{ nozzleNo, tankId | productId (CNG), reading }] }
async function createDispenser(business, user, body) {
  c.requireFuel(business);
  await access.require(business, 'settings.edit');
  const unit = readUnit(body);
  const nozzles = body.nozzles === undefined || body.nozzles === null ? [] : v.requiredArray(body.nozzles, 'Nozzles').map((n, i) => readNozzle(n, `Nozzle ${i + 1}`));
  if (nozzles.length > 24) fail('A unit has at most 24 nozzles');
  if (new Set(nozzles.map((n) => n.nozzleNo)).size !== nozzles.length) fail('Each nozzle number is given once');
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const location = await c.locationOf(db, business, body.locationId);
    if (await repo.one(db, 'SELECT 1 FROM fuel_dispensers WHERE business_id=$1 AND location_id=$2 AND lower(unit_no)=lower($3)', [business.id, location.id, unit.unitNo])) {
      fail(`${location.name} already has a unit ${unit.unitNo}`, 409);
    }
    const row = await repo.one(db, `INSERT INTO fuel_dispensers(business_id,location_id,unit_no,make,serial_no,stamped_on,stamping_due,sort_order,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`, [business.id, location.id, unit.unitNo, unit.make, unit.serialNo, unit.stampedOn, unit.stampingDue, unit.sortOrder, user.id]);
    await repo.audit(db, business.id, user.id, 'fuel_dispenser.created', row.id, { unitNo: row.unit_no, location: location.name, stampingDue: unit.stampingDue });
    for (const nozzle of nozzles) await insertNozzle(db, business, user, row, nozzle);
    return load(db, business);
  });
}

// body: { unitNo?, make?, serialNo?, stampedOn?, stampingDue?, sortOrder?, status?: in_use | suspended | retired, statusNote? } — what is left out stays.
async function updateDispenser(business, user, unitId, body) {
  c.requireFuel(business);
  await access.require(business, 'settings.edit');
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const current = await repo.one(db, 'SELECT *,stamped_on::text AS stamped_on,stamping_due::text AS stamping_due FROM fuel_dispensers WHERE business_id=$1 AND id=$2 FOR UPDATE',
      [business.id, id(unitId, 'Dispensing unit')]);
    if (!current) fail('Dispensing unit not found', 404);
    access.requireLocation(business, current.location_id);
    const unit = readUnit(body, current);
    const status = body.status === undefined ? current.status : v.requiredEnum(body.status, 'The unit is', c.UNIT_STATES);
    const note = status === 'in_use' ? null : body.statusNote === undefined && status === current.status ? current.status_note : c.optionalText(body.statusNote, 'Why', 300);
    if (status !== 'in_use' && !note) fail(status === 'suspended' ? 'Say why the unit is suspended (seals, a delivery variation …)' : 'Say why the unit is retired');
    if (unit.unitNo.toLowerCase() !== current.unit_no.toLowerCase()
        && await repo.one(db, 'SELECT 1 FROM fuel_dispensers WHERE business_id=$1 AND location_id=$2 AND lower(unit_no)=lower($3) AND id<>$4', [business.id, current.location_id, unit.unitNo, current.id])) {
      fail(`The outlet already has a unit ${unit.unitNo}`, 409);
    }
    await db.query(`UPDATE fuel_dispensers SET unit_no=$3,make=$4,serial_no=$5,stamped_on=$6,stamping_due=$7,sort_order=$8,status=$9,status_note=$10,updated_by=$11,updated_at=now()
      WHERE business_id=$1 AND id=$2`, [business.id, current.id, unit.unitNo, unit.make, unit.serialNo, unit.stampedOn, unit.stampingDue, unit.sortOrder, status, note, user.id]);
    const was = { unitNo: current.unit_no, make: current.make, serialNo: current.serial_no, stampedOn: current.stamped_on, stampingDue: current.stamping_due, status: current.status, statusNote: current.status_note };
    const now = { unitNo: unit.unitNo, make: unit.make, serialNo: unit.serialNo, stampedOn: unit.stampedOn, stampingDue: unit.stampingDue, status, statusNote: note };
    const changed = Object.keys(now).filter((k) => String(was[k] ?? '') !== String(now[k] ?? ''));
    if (changed.length) {
      const action = status !== current.status ? `fuel_dispenser.${status === 'in_use' ? 'back_in_use' : status}` : unit.stampingDue !== current.stamping_due ? 'fuel_dispenser.stamped' : 'fuel_dispenser.updated';
      await repo.audit(db, business.id, user.id, action, current.id, { unitNo: unit.unitNo, from: Object.fromEntries(changed.map((k) => [k, was[k]])), to: Object.fromEntries(changed.map((k) => [k, now[k]])) });
    }
    return load(db, business);
  });
}

// body: { nozzleNo, tankId | productId (CNG), reading } — a nozzle added to a unit.
async function addNozzle(business, user, unitId, body) {
  c.requireFuel(business);
  await access.require(business, 'settings.edit');
  const nozzle = readNozzle(body);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const unit = await repo.one(db, 'SELECT * FROM fuel_dispensers WHERE business_id=$1 AND id=$2', [business.id, id(unitId, 'Dispensing unit')]);
    if (!unit) fail('Dispensing unit not found', 404);
    access.requireLocation(business, unit.location_id);
    if (unit.status === 'retired') fail(`${unit.unit_no} is retired`, 409);
    await insertNozzle(db, business, user, unit, nozzle);
    return load(db, business);
  });
}

// body: { nozzleNo?, active?, sortOrder? } — a nozzle renumbered or switched off (while no shift is open on it).
async function updateNozzle(business, user, nozzleId, body) {
  c.requireFuel(business);
  await access.require(business, 'settings.edit');
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const current = await repo.one(db, 'SELECT * FROM fuel_nozzles WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(nozzleId, 'Nozzle')]);
    if (!current) fail('Nozzle not found', 404);
    access.requireLocation(business, current.location_id);
    if (body.reading !== undefined) fail('A totaliser reading moves only with a shift\'s close, or a meter change a manager records');
    const nozzleNo = body.nozzleNo === undefined ? current.nozzle_no : c.readNozzleNo(body.nozzleNo);
    const active = v.requiredBoolean(body.active, 'In use', current.active);
    const sortOrder = c.given(body.sortOrder) ? c.whole(body.sortOrder, 'Order on the list', 0, 999) : current.sort_order;
    if (nozzleNo !== current.nozzle_no && await repo.one(db, 'SELECT 1 FROM fuel_nozzles WHERE business_id=$1 AND location_id=$2 AND nozzle_no=$3', [business.id, current.location_id, nozzleNo])) {
      fail(`The outlet already has a nozzle ${nozzleNo}`, 409);
    }
    await db.query('UPDATE fuel_nozzles SET nozzle_no=$3,active=$4,sort_order=$5,updated_by=$6,updated_at=now() WHERE business_id=$1 AND id=$2',
      [business.id, current.id, nozzleNo, active, sortOrder, user.id]);
    if (nozzleNo !== current.nozzle_no || active !== current.active) {
      await repo.audit(db, business.id, user.id, 'fuel_nozzle.updated', current.id, { nozzleNo, ...(nozzleNo !== current.nozzle_no ? { renumberedFrom: current.nozzle_no } : {}),
        ...(active !== current.active ? { active } : {}) });
    }
    return load(db, business);
  });
}

// body: { reading, reason } — a manager's meter change: the totaliser replaced
// or reset, from the reading now to the one given, while no shift is open on it.
async function changeMeter(business, user, nozzleId, body) {
  c.requireFuel(business);
  await access.require(business, 'fuel.approve');
  const reading = c.readReading(body.reading, 'New totaliser reading');
  const reason = v.requiredString(typeof body.reason === 'string' ? body.reason : '', 'Why the meter changed', 300);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const nozzle = await repo.one(db, 'SELECT * FROM fuel_nozzles WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(nozzleId, 'Nozzle')]);
    if (!nozzle) fail('Nozzle not found', 404);
    access.requireLocation(business, nozzle.location_id);
    if (reading === nozzle.reading) fail(`Nozzle ${nozzle.nozzle_no} reads ${nozzle.reading} already`);
    const change = await repo.one(db, 'INSERT INTO fuel_meter_changes(business_id,nozzle_id,from_reading,to_reading,reason,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [business.id, nozzle.id, nozzle.reading, reading, reason, user.id]);
    await db.query('UPDATE fuel_nozzles SET reading=$3,updated_by=$4,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, nozzle.id, reading, user.id]);
    await repo.audit(db, business.id, user.id, 'fuel_meter.changed', change.id, { nozzleNo: nozzle.nozzle_no, from: nozzle.reading, to: reading, reason });
    return load(db, business);
  });
}

// --- Measures --------------------------------------------------------------------------------

function readMeasure(body, current = null) {
  const keep = (name) => body[name] === undefined && current;
  const stampedOn = keep('stampedOn') ? current.stamped_on : c.given(body.stampedOn) ? c.readDate(body.stampedOn, 'Stamped on') : null;
  const stampingDue = keep('stampingDue') ? current.stamping_due : c.readDate(body.stampingDue, 'Stamping falls due on');
  if (stampedOn && String(stampingDue) <= String(stampedOn)) fail('The stamping falls due after it was stamped');
  return {
    name: keep('name') ? current.name : v.requiredString(typeof body.name === 'string' ? body.name : '', 'Name', 80),
    litres: keep('litres') ? current.litres : c.readDecimal(body.litres, 'What it holds (litres)', 3, { min: 0, max: 100, minExclusive: true }),
    serialNo: keep('serialNo') ? current.serial_no : c.optionalText(body.serialNo, 'Serial number', 40),
    stampedOn, stampingDue,
    active: v.requiredBoolean(body.active, 'In use', current ? current.active : true),
  };
}

// body: { locationId, name, litres, serialNo?, stampedOn?, stampingDue }
async function createMeasure(business, user, body) {
  c.requireFuel(business);
  await access.require(business, 'settings.edit');
  const m = readMeasure(body);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const location = await c.locationOf(db, business, body.locationId);
    const row = await repo.one(db, `INSERT INTO fuel_measures(business_id,location_id,name,litres,serial_no,stamped_on,stamping_due,active,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`, [business.id, location.id, m.name, m.litres, m.serialNo, m.stampedOn, m.stampingDue, m.active, user.id]);
    await repo.audit(db, business.id, user.id, 'fuel_measure.created', row.id, { name: m.name, litres: m.litres, location: location.name, stampingDue: m.stampingDue });
    return load(db, business);
  });
}

// body: { name?, litres?, serialNo?, stampedOn?, stampingDue?, active? } — what is left out stays.
async function updateMeasure(business, user, measureId, body) {
  c.requireFuel(business);
  await access.require(business, 'settings.edit');
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const current = await repo.one(db, 'SELECT *,stamped_on::text AS stamped_on,stamping_due::text AS stamping_due FROM fuel_measures WHERE business_id=$1 AND id=$2 FOR UPDATE',
      [business.id, id(measureId, 'Measure')]);
    if (!current) fail('Measure not found', 404);
    access.requireLocation(business, current.location_id);
    const m = readMeasure(body, current);
    await db.query('UPDATE fuel_measures SET name=$3,litres=$4,serial_no=$5,stamped_on=$6,stamping_due=$7,active=$8,updated_by=$9,updated_at=now() WHERE business_id=$1 AND id=$2',
      [business.id, current.id, m.name, m.litres, m.serialNo, m.stampedOn, m.stampingDue, m.active, user.id]);
    await repo.audit(db, business.id, user.id, m.stampingDue !== current.stamping_due ? 'fuel_measure.stamped' : 'fuel_measure.updated', current.id,
      { name: m.name, stampingDue: { from: current.stamping_due, to: m.stampingDue }, active: m.active });
    return load(db, business);
  });
}

// --- Prices ----------------------------------------------------------------------------------

// The prices in force at an outlet, the next ones set, and the last ones set.
async function prices(business, query = {}) {
  c.requireFuel(business);
  await access.require(business, 'fuel.view');
  const location = await c.boardOutlet(repo.pool, business, query.locationId || query.location);
  const current = await pricesOf(repo.pool, business, location.id);
  const history = await repo.all(repo.pool, `SELECT x.id,x.product_id,s.label AS name,x.price,x.effective_from,x.note,x.created_at,u.name AS created_by_name
    FROM fuel_prices x JOIN fuel_products f ON f.business_id=x.business_id AND f.id=x.product_id JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id
    JOIN users u ON u.id=x.created_by WHERE x.business_id=$1 AND x.location_id=$2 ORDER BY x.effective_from DESC,x.id DESC LIMIT 60`, [business.id, location.id]);
  return { location, current, history };
}

// body: { requestKey, locationId, effectiveFrom? (now when left out), note?, prices: [{ productId, price }] }
// — the day's prices of the outlet's fuels, set together. A price never takes
// effect back into a closed shift that sold the fuel (the database says which).
async function setPrices(business, user, body) {
  c.requireFuel(business);
  await access.require(business, 'catalog.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const list = v.requiredArray(body.prices, 'Prices');
  if (!list.length || list.length > 20) fail('Give the price of one fuel or more');
  const typed = list.map((p, i) => ({ productId: id(p?.productId, `Price ${i + 1}: fuel`), price: c.readMoney(p?.price, `Price ${i + 1}: price a litre`, { min: 0, max: 99999.99, minExclusive: true }) }));
  if (new Set(typed.map((p) => p.productId)).size !== typed.length) fail('Each fuel is priced once');
  const note = c.optionalText(body.note, 'Note', 200);
  // The prices are read back once the transaction has committed them.
  const locationId = await repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const old = await repo.all(db, 'SELECT * FROM fuel_prices WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old.length) {
      if (old[0].request_hash !== hash) fail('This request key was already used for different data', 409);
      return old[0].location_id;
    }
    const location = await c.locationOf(db, business, body.locationId);
    const at = await c.readWhen(db, business, body.effectiveFrom, 'Takes effect from');
    for (const p of typed) {
      const product = await repo.one(db, `SELECT f.id,s.label FROM fuel_products f JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id
        WHERE f.business_id=$1 AND f.id=$2`, [business.id, p.productId]);
      if (!product) fail('Fuel not found', 404);
      const row = await repo.one(db, `INSERT INTO fuel_prices(business_id,location_id,product_id,price,effective_from,note,request_key,request_hash,created_by)
        VALUES($1,$2,$3,$4,COALESCE($5,now()),$6,$7,$8,$9) RETURNING *`, [business.id, location.id, product.id, p.price, at, note, requestKey, hash, user.id]);
      await repo.audit(db, business.id, user.id, 'fuel_price.set', row.id, { fuel: product.label, price: row.price, effectiveFrom: row.effective_from, location: location.name });
    }
    return location.id;
  });
  return prices(business, { locationId });
}

// --- Settings --------------------------------------------------------------------------------

const settingsShape = (s) => ({ densityTolerance: s.density_tolerance, variationPercent: s.variation_percent, petrolLossPercent: s.petrol_loss_percent,
  petrolLossAbovePercent: s.petrol_loss_above_percent, dieselLossPercent: s.diesel_loss_percent, dieselLossAbovePercent: s.diesel_loss_above_percent,
  above600Kl: s.above_600_kl, testLitres: s.test_litres, stampingWarnDays: Number(s.stamping_warn_days), denominations: (s.denominations || []).map(Number),
  interestSkuId: s.interest_sku_id ? Number(s.interest_sku_id) : null, updatedAt: s.updated_at });

// The notes and coins the cash is counted in (₹): whole rupees, largest first, each once.
function readDenominations(value) {
  const list = v.requiredArray(value, 'Notes and coins');
  if (!list.length || list.length > 20) fail('Give 1 to 20 notes and coins');
  const read = list.map((x, i) => c.whole(x, `Note or coin ${i + 1} (₹)`, 1, 2000));
  if (new Set(read).size !== read.length) fail('Each note or coin is given once');
  return read.sort((a, b) => b - a);
}

async function settings(business) {
  c.requireFuel(business);
  await access.require(business, 'fuel.view');
  return settingsShape(await c.settingsOf(repo.pool, business.id));
}

// body: { densityTolerance?, variationPercent?, petrolLossPercent?, petrolLossAbovePercent?, dieselLossPercent?, dieselLossAbovePercent?, above600Kl?,
//   testLitres?, stampingWarnDays?, denominations? (₹ notes and coins the cash is counted in), interestSkuId? (a service item; null: none) }
// — what is left out stays.
async function saveSettings(business, user, body) {
  c.requireFuel(business);
  await access.require(business, 'settings.edit');
  const denominations = body.denominations === undefined ? null : readDenominations(body.denominations);
  return repo.transaction(async (db) => {
    const before = await c.settingsOf(db, business.id);
    let interestSkuId = before.interest_sku_id ? Number(before.interest_sku_id) : null;
    if (body.interestSkuId !== undefined) {
      interestSkuId = c.given(body.interestSkuId) ? id(body.interestSkuId, 'Interest item') : null;
      if (interestSkuId) {
        const sku = await repo.one(db, `SELECT s.label,p.kind FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
          WHERE s.business_id=$1 AND s.id=$2 AND s.active`, [business.id, interestSkuId]);
        if (!sku) fail('Item not found', 404);
        if (sku.kind !== 'service') fail(`${sku.label} is goods: interest is billed as a service item (its own GST slab)`);
      }
    }
    const percent = (name, label, max) => (body[name] === undefined ? before[{ variationPercent: 'variation_percent', petrolLossPercent: 'petrol_loss_percent',
      petrolLossAbovePercent: 'petrol_loss_above_percent', dieselLossPercent: 'diesel_loss_percent', dieselLossAbovePercent: 'diesel_loss_above_percent' }[name]]
      : c.readDecimal(body[name], label, 2, { min: 0, max }));
    const next = {
      density_tolerance: body.densityTolerance === undefined ? before.density_tolerance : c.readDecimal(body.densityTolerance, 'Density tolerance (kg/m³)', 1, { min: 0, max: 20, minExclusive: true }),
      variation_percent: percent('variationPercent', 'Operational variation (%)', 20),
      petrol_loss_percent: percent('petrolLossPercent', 'Petrol allowance up to 600 KL (%)', 5),
      petrol_loss_above_percent: percent('petrolLossAbovePercent', 'Petrol allowance beyond 600 KL (%)', 5),
      diesel_loss_percent: percent('dieselLossPercent', 'Diesel allowance up to 600 KL (%)', 5),
      diesel_loss_above_percent: percent('dieselLossAbovePercent', 'Diesel allowance beyond 600 KL (%)', 5),
      above_600_kl: v.requiredBoolean(body.above600Kl, 'Annual average beyond 600 KL', before.above_600_kl),
      test_litres: body.testLitres === undefined ? before.test_litres : c.readDecimal(body.testLitres, 'Test measure (litres)', 3, { min: 0, max: 100, minExclusive: true }),
      stamping_warn_days: body.stampingWarnDays === undefined ? Number(before.stamping_warn_days) : c.whole(body.stampingWarnDays, 'Warn this many days before a stamping falls due', 1, 180),
      denominations: denominations || before.denominations.map(Number),
      interest_sku_id: interestSkuId,
    };
    await db.query(`INSERT INTO fuel_settings(business_id,density_tolerance,variation_percent,petrol_loss_percent,petrol_loss_above_percent,diesel_loss_percent,diesel_loss_above_percent,
        above_600_kl,test_litres,stamping_warn_days,denominations,interest_sku_id,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (business_id) DO UPDATE SET density_tolerance=EXCLUDED.density_tolerance,variation_percent=EXCLUDED.variation_percent,petrol_loss_percent=EXCLUDED.petrol_loss_percent,
        petrol_loss_above_percent=EXCLUDED.petrol_loss_above_percent,diesel_loss_percent=EXCLUDED.diesel_loss_percent,diesel_loss_above_percent=EXCLUDED.diesel_loss_above_percent,
        above_600_kl=EXCLUDED.above_600_kl,test_litres=EXCLUDED.test_litres,stamping_warn_days=EXCLUDED.stamping_warn_days,denominations=EXCLUDED.denominations,
        interest_sku_id=EXCLUDED.interest_sku_id,updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [business.id, next.density_tolerance, next.variation_percent, next.petrol_loss_percent, next.petrol_loss_above_percent, next.diesel_loss_percent, next.diesel_loss_above_percent,
      next.above_600_kl, next.test_litres, next.stamping_warn_days, next.denominations, next.interest_sku_id, user.id]);
    const changed = Object.keys(next).filter((k) => String(before[k]) !== String(next[k]));
    if (changed.length) await repo.audit(db, business.id, user.id, 'fuel_settings.updated', null, Object.fromEntries(changed.map((k) => [k, { from: before[k], to: next[k] }])));
    return settingsShape(await c.settingsOf(db, business.id));
  });
}

// --- What only the fuel tools bill and buy --------------------------------------------------

// A fuel is sold only by a shift's close: its meters gave it out.
async function checkLooseSale(db, business, lines) {
  const skuIds = [...new Set(lines.map((line) => Number(line.sku.id)))];
  const item = await repo.one(db, `SELECT s.label FROM fuel_products f JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id
    WHERE f.business_id=$1 AND f.sku_id=ANY($2::bigint[]) ORDER BY s.label LIMIT 1`, [business.id, skuIds]);
  if (item) fail(`${item.label} is sold by the meters: a shift's close bills it (Shift & readings)`, 409);
}
// Petrol and diesel come in from tanker receipts, with their dips and density; CNG on a purchase.
async function checkLoosePurchase(db, business, lines) {
  const skuIds = [...new Set(lines.map((line) => Number(line.sku.id)))];
  const item = await repo.one(db, `SELECT s.label FROM fuel_products f JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id
    WHERE f.business_id=$1 AND f.sku_id=ANY($2::bigint[]) AND f.family<>'cng' ORDER BY s.label LIMIT 1`, [business.id, skuIds]);
  if (item) fail(`${item.label} comes in from a tanker receipt, with its dips and density (Tanker receipts)`, 409);
}

module.exports = { PRODUCTS_SQL, productsOf, pricesOf, load, setup, createProduct, updateProduct, createTank, updateTank, createDispenser, updateDispenser, addNozzle, updateNozzle,
  changeMeter, createMeasure, updateMeasure, prices, setPrices, settings, saveSettings, settingsShape, checkLooseSale, checkLoosePurchase };
