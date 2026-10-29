const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const returns = require('../../core/services/businessReturns.service');
const c = require('./fuelCommon');
const money = require('./fuelMoney');

// Tanks and their stock (module "fuel", fuel stations), from what is typed
// in: the dip rod, the dip chart, the hydrometer and the oil company's invoice.
// Nothing here reads a tank gauge.
//
//   dips       each tank's morning dip: the litres it holds by its dip chart
//              (and the dip read, the water dip, the morning density at 15 °C
//              and temperature of a nozzle sample), one a day, typed within a
//              week; a manager corrects one, saying why.
//   receipts   each tanker load: the invoice, the lorry, the seals; for each
//              tank it went into, the invoice's litres, value and density at
//              15 °C, the lorry's sample at 15 °C (within the tolerance of the
//              invoice's either way, 3.0 kg/m³ until changed; outside it the
//              load is refused, or a manager accepts it saying why), and the
//              dips before and after decanting (what came in, and a short
//              receipt). An accepted load is a purchase through the core, at
//              the invoice's litres and value (no GST: fuel is outside it); a
//              manager cancels one entered wrongly (its purchase credited).
//   register   each tank's daily stock register between two morning dips
//              (MDG 2024, Annexure 9): opening dip, the loads received, the
//              meters' sales (closed shifts), the test pumped back, the book
//              stock, the next morning's dip, the variation and its
//              percentage, against the tolerance: the operational variation
//              of the dip stock (4%) either way, a loss also within the
//              evaporation and handling allowance on what was sold.
//   density    each tank's density register by month (MDG 2024, Annexure 1):
//              the morning density, and each load's density by invoice, at
//              receipt and after decanting.
//   allowances a load's shrinkage and temperature variation allowance (TVA),
//              in rupees a kilolitre on its invoice, kept on its tank line and
//              turned into a percentage of its value (so of its litres); the
//              register takes them off the receipts (Annexure 9: A + B - C =
//              D, D - E = F, against the dip G). A manager posts a day's gap
//              (the dip against the stock by the meters and the invoices) to
//              the stock as a correction, saying why, once.
//   loads      each compartment of a tanker load: its dip, density and
//              temperature, the water-finding paste, the 20-litre check from
//              its manifold and the short made up through the pump; the
//              retention samples of each load, kept until two later loads of
//              the fuel have come in, then due for disposal.
//   charts     each tank's calibration (dip) chart, cm to litres, typed or
//              pasted; a dip read in cm takes its litres from the chart by a
//              straight line between the two rows around it.

const { fail, id } = c;
const MAX_LINES = 12;
const REGISTER_DAYS = 92;

// What someone who does not buy sees of a load: no money.
const seesPurchases = (business) => access.can(business, 'purchasing.view');

// --- Tanks and their dips ---------------------------------------------------------------------

const TANKS_SQL = `SELECT t.id,t.location_id,t.tank_no,t.capacity,t.active,t.product_id,f.sku_id,s.label AS product_name,f.family,s.unit
  FROM fuel_tanks t JOIN fuel_products f ON f.business_id=t.business_id AND f.id=t.product_id JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id
  WHERE t.business_id=$1`;

// A tank's stock by the book now: its last dip, the loads received since and the meters' sales since (closed shifts).
async function bookNow(db, business, tank) {
  const dip = await repo.one(db, 'SELECT * FROM fuel_dips WHERE business_id=$1 AND tank_id=$2 ORDER BY dip_on DESC LIMIT 1', [business.id, tank.id]);
  if (!dip) return null;
  const since = await repo.one(db, `SELECT
      COALESCE((SELECT sum(l.invoice_litres) FROM fuel_receipt_lines l JOIN fuel_receipts r ON r.business_id=l.business_id AND r.id=l.receipt_id
        WHERE l.business_id=$1 AND l.tank_id=$2 AND r.status='accepted' AND r.received_at>=$3),0) AS receipts,
      COALESCE((SELECT sum(x.litres) FROM fuel_close_readings x JOIN fuel_shift_closes k ON k.business_id=x.business_id AND k.id=x.close_id
        WHERE x.business_id=$1 AND x.tank_id=$2 AND k.reopened_at IS NULL AND k.closed_at>=$3),0) AS sales,
      (SELECT count(DISTINCT s.id)::int FROM fuel_shift_nozzles n JOIN fuel_shifts s ON s.business_id=n.business_id AND s.id=n.shift_id
        WHERE n.business_id=$1 AND n.tank_id=$2 AND s.status='open') AS open_shifts`, [business.id, tank.id, dip.taken_at]);
  const book = money.milli(dip.stock) + money.milli(since.receipts) - money.milli(since.sales);
  return { from: dip.dip_on, takenAt: dip.taken_at, dip: dip.stock, receipts: since.receipts, sales: since.sales, book: money.litres(book), openShifts: since.open_shifts };
}

// query: { date?, locationId? } — each tank of the outlet with that day's dip, the one before, and its stock by the book now.
async function dips(business, query = {}) {
  c.requireFuel(business);
  await access.require(business, 'fuel.view');
  const db = repo.pool;
  const location = await c.boardOutlet(db, business, query.locationId || query.location);
  const today = await c.today(db, business);
  const date = query.date ? c.readDate(query.date, 'Date') : today;
  const tanks = await repo.all(db, `${TANKS_SQL} AND t.location_id=$2 ORDER BY t.active DESC,t.sort_order,lower(t.tank_no)`, [business.id, location.id]);
  const out = [];
  for (const tank of tanks) {
    const [dip, previous] = [
      await repo.one(db, `SELECT d.*,d.dip_on::text AS dip_on,u.name AS created_by_name,cu.name AS corrected_by_name FROM fuel_dips d JOIN users u ON u.id=d.created_by
        LEFT JOIN users cu ON cu.id=d.corrected_by WHERE d.business_id=$1 AND d.tank_id=$2 AND d.dip_on=$3`, [business.id, tank.id, date]),
      await repo.one(db, 'SELECT d.*,d.dip_on::text AS dip_on FROM fuel_dips d WHERE d.business_id=$1 AND d.tank_id=$2 AND d.dip_on<$3 ORDER BY d.dip_on DESC LIMIT 1',
        [business.id, tank.id, date]),
    ];
    out.push({ ...tank, dip: dip || null, previous: previous || null, book: date === today ? await bookNow(db, business, tank) : null, chart: await chartOf(db, business, tank.id) });
  }
  return { date, today, location, tanks: out };
}

// --- Dip charts ------------------------------------------------------------------------------

// A tank's chart, in rising order: [{ cm, litres }] as text.
const chartOf = (db, business, tankId) => repo.all(db, 'SELECT dip_cm AS cm,litres FROM fuel_dip_charts WHERE business_id=$1 AND tank_id=$2 ORDER BY dip_cm', [business.id, tankId]);

// The litres a dip in cm reads on the tank's chart, or null when it has none.
async function litresOnChart(db, business, tank, dipCm) {
  const rows = await chartOf(db, business, tank.id);
  if (!rows.length) return null;
  const read = money.chartLitres(rows.map((r) => ({ cm: money.tenths(r.cm), litres: money.milli(r.litres) })), money.tenths(dipCm));
  if (read === null) fail(`A dip of ${dipCm} cm is outside tank ${tank.tank_no}'s chart (${rows[0].cm} to ${rows.at(-1).cm} cm)`);
  return money.litres(read);
}

async function chart(business, tankId) {
  c.requireFuel(business);
  await access.require(business, 'fuel.view');
  const tank = await repo.one(repo.pool, `${TANKS_SQL} AND t.id=$2`, [business.id, id(tankId, 'Tank')]);
  if (!tank) fail('Tank not found', 404);
  access.requireLocation(business, tank.location_id);
  return { tank, rows: await chartOf(repo.pool, business, tank.id) };
}

// body: { rows: [{ cm, litres }] } or { text: "cm,litres" a line, as pasted from the chart }
// — a tank's whole calibration chart, put in place of the one it had.
async function saveChart(business, user, tankId, body) {
  c.requireFuel(business);
  await access.require(business, 'settings.edit');
  let raw = body.rows;
  if (raw === undefined && typeof body.text === 'string') {
    raw = body.text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^[a-z]/i.test(line)).map((line) => {
      const [cm, litres] = line.split(/[\s,;\t]+/);
      return { cm, litres };
    });
  }
  const rows = v.requiredArray(raw, 'Chart rows').map((r, i) => ({ cm: c.readDecimal(r?.cm, `Row ${i + 1}: dip (cm)`, 1, { max: 99999 }),
    litres: c.readLitres(r?.litres, `Row ${i + 1}: litres`) }));
  if (rows.length < 2 || rows.length > 3000) fail('A dip chart has 2 to 3,000 rows');
  rows.sort((a, b) => money.tenths(a.cm) - money.tenths(b.cm));
  for (let i = 1; i < rows.length; i += 1) {
    if (money.tenths(rows[i].cm) === money.tenths(rows[i - 1].cm)) fail(`The chart gives ${rows[i].cm} cm twice`);
    if (money.milli(rows[i].litres) <= money.milli(rows[i - 1].litres)) fail(`The chart's litres rise with the dip: ${rows[i].cm} cm reads no more than ${rows[i - 1].cm} cm`);
  }
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const tank = await repo.one(db, `${TANKS_SQL} AND t.id=$2`, [business.id, id(tankId, 'Tank')]);
    if (!tank) fail('Tank not found', 404);
    access.requireLocation(business, tank.location_id);
    const before = await repo.one(db, 'SELECT count(*)::int AS n FROM fuel_dip_charts WHERE business_id=$1 AND tank_id=$2', [business.id, tank.id]);
    await db.query('DELETE FROM fuel_dip_charts WHERE business_id=$1 AND tank_id=$2', [business.id, tank.id]);
    await db.query(`INSERT INTO fuel_dip_charts(business_id,tank_id,dip_cm,litres) SELECT $1,$2,x.cm,x.litres FROM unnest($3::numeric[],$4::numeric[]) AS x(cm,litres)`,
      [business.id, tank.id, rows.map((r) => r.cm), rows.map((r) => r.litres)]);
    await repo.audit(db, business.id, user.id, 'fuel_tank.chart_set', tank.id, { tankNo: tank.tank_no, rows: rows.length, rowsBefore: before.n, from: rows[0], to: rows.at(-1) });
    return { tank, rows: await chartOf(db, business, tank.id) };
  });
}

function readDip(body) {
  return {
    stock: c.given(body.stock) ? c.readLitres(body.stock, 'Litres in the tank (by the dip chart)') : null,
    dipCm: c.given(body.dipCm) ? c.readDecimal(body.dipCm, 'Dip (cm)', 1, { max: 99999 }) : null,
    waterCm: c.given(body.waterCm) ? c.readDecimal(body.waterCm, 'Water dip (cm)', 1, { max: 9999 }) : null,
    density: c.optionalDensity(body.density, 'Morning density at 15 °C (kg/m³)'),
    temperature: c.given(body.temperature) ? c.readDecimal(body.temperature, 'Temperature (°C)', 1, { max: 70 }) : null,
    note: c.optionalText(body.note, 'Note', 300),
  };
}

// body: { requestKey, tankId, dipOn? (today), takenAt? (now; given for a day before today), stock, dipCm?, waterCm?, density?, temperature?, note? }
async function takeDip(business, user, body) {
  c.requireFuel(business);
  await access.require(business, 'fuel.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const read = readDip(body);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const old = await repo.one(db, 'SELECT id,tank_id,request_hash FROM fuel_dips WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return repo.one(db, 'SELECT *,dip_on::text AS dip_on FROM fuel_dips WHERE business_id=$1 AND id=$2', [business.id, old.id]);
    }
    const tank = await repo.one(db, `${TANKS_SQL} AND t.id=$2`, [business.id, id(body.tankId, 'Tank')]);
    if (!tank) fail('Tank not found', 404);
    access.requireLocation(business, tank.location_id);
    if (!tank.active) fail(`Tank ${tank.tank_no} is switched off`, 409);
    const today = await c.today(db, business);
    const dipOn = c.given(body.dipOn) ? c.readDate(body.dipOn, 'Dip of') : today;
    if (dipOn > today) fail('A dip is not taken on a day to come');
    const typed = await c.readWhen(db, business, body.takenAt, 'Taken at');
    if (!typed && dipOn !== today) fail(`Give the time the dip of ${c.dateWords(dipOn)} was taken`);
    // With a chart, the dip in cm gives the litres; without one, the litres are read off the paper chart.
    const charted = read.dipCm !== null ? await litresOnChart(db, business, tank, read.dipCm) : null;
    const stock = charted ?? read.stock;
    if (stock === null) fail(`Give the litres in tank ${tank.tank_no} by its dip chart, or its dip in cm once its chart is kept`);
    if (Number(stock) > Number(tank.capacity)) fail(`Tank ${tank.tank_no} holds at most ${tank.capacity} litres`);
    const same = await repo.one(db, 'SELECT id FROM fuel_dips WHERE business_id=$1 AND tank_id=$2 AND dip_on=$3', [business.id, tank.id, dipOn]);
    if (same) fail(`Tank ${tank.tank_no}'s dip of ${c.dateWords(dipOn)} is taken already: a manager corrects it`, 409);
    const row = await repo.one(db, `INSERT INTO fuel_dips(business_id,location_id,tank_id,dip_on,taken_at,dip_cm,stock,water_cm,density,temperature,note,request_key,request_hash,created_by,from_chart)
      VALUES($1,$2,$3,$4,COALESCE($5,now()),$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *,dip_on::text AS dip_on`, [business.id, tank.location_id, tank.id, dipOn, typed, read.dipCm, stock,
      read.waterCm, read.density, read.temperature, read.note, requestKey, hash, user.id, charted !== null]);
    await repo.audit(db, business.id, user.id, 'fuel_dip.taken', row.id, { tankNo: tank.tank_no, dipOn, stock: row.stock, density: row.density, waterCm: row.water_cm });
    await repo.event(db, business.id, user.id, 'fuel_dip.taken', 'fuel_dip', row.id, { tankId: tank.id, locationId: tank.location_id, dipOn, takenAt: row.taken_at, stock: row.stock,
      density: row.density });
    return row;
  });
}

// body: { stock?, dipCm?, waterCm?, density?, temperature?, takenAt?, note?, reason } — a manager's correction of a dip, saying why.
async function correctDip(business, user, dipId, body) {
  c.requireFuel(business);
  await access.require(business, 'fuel.approve');
  const reason = v.requiredString(typeof body.reason === 'string' ? body.reason : '', 'Why the dip is corrected', 300);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const current = await repo.one(db, 'SELECT *,dip_on::text AS dip_on FROM fuel_dips WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(dipId, 'Dip')]);
    if (!current) fail('Dip not found', 404);
    access.requireLocation(business, current.location_id);
    const merged = readDip({ stock: body.stock ?? current.stock, dipCm: body.dipCm === undefined ? current.dip_cm : body.dipCm,
      waterCm: body.waterCm === undefined ? current.water_cm : body.waterCm, density: body.density === undefined ? current.density : body.density,
      temperature: body.temperature === undefined ? current.temperature : body.temperature, note: body.note === undefined ? current.note : body.note });
    const typed = body.takenAt === undefined ? null : await c.readInstant(db, business, body.takenAt, 'Taken at');
    // A dip in cm corrected on a tank with a chart takes its litres from the chart.
    const tank = await repo.one(db, `${TANKS_SQL} AND t.id=$2`, [business.id, current.tank_id]);
    const charted = body.dipCm !== undefined && merged.dipCm !== null ? await litresOnChart(db, business, tank, merged.dipCm) : null;
    const stock = charted ?? merged.stock;
    const row = await repo.one(db, `UPDATE fuel_dips SET stock=$3,dip_cm=$4,water_cm=$5,density=$6,temperature=$7,note=$8,taken_at=COALESCE($9,taken_at),
        corrected_by=$10,corrected_at=now(),correction_reason=$11,from_chart=$12 WHERE business_id=$1 AND id=$2 RETURNING *,dip_on::text AS dip_on`,
    [business.id, current.id, stock, merged.dipCm, merged.waterCm, merged.density, merged.temperature, merged.note, typed, user.id, reason,
      charted !== null || (body.stock === undefined && body.dipCm === undefined && current.from_chart)]);
    const fields = ['stock', 'dip_cm', 'water_cm', 'density', 'temperature', 'note', 'taken_at'];
    const changed = fields.filter((k) => String(current[k] ?? '') !== String(row[k] ?? ''));
    await repo.audit(db, business.id, user.id, 'fuel_dip.corrected', current.id, { dipOn: current.dip_on, reason, from: Object.fromEntries(changed.map((k) => [k, current[k]])),
      to: Object.fromEntries(changed.map((k) => [k, row[k]])) });
    return row;
  });
}

// --- Tanker receipts ----------------------------------------------------------------------------

const RECEIPTS_SQL = `SELECT r.id,r.location_id,l.name AS location_name,r.contact_id,r.supplier_name,r.invoice_no,r.invoice_date::text AS invoice_date,r.lorry_no,r.received_at,
    r.seals_ok,r.status,r.refuse_reason,r.density_note,r.document_id,d.document_no,d.total AS amount,r.notes,r.created_at,r.cancelled_at,r.cancel_reason,
    (SELECT string_agg(t.tank_no || ' ' || sk.label || ' ' || trim(to_char(x.invoice_litres,'FM999999999990.000')),' · ' ORDER BY x.seq) FROM fuel_receipt_lines x
      JOIN fuel_tanks t ON t.business_id=x.business_id AND t.id=x.tank_id JOIN fuel_products f ON f.business_id=x.business_id AND f.id=x.product_id
      JOIN catalog_skus sk ON sk.business_id=f.business_id AND sk.id=f.sku_id WHERE x.business_id=r.business_id AND x.receipt_id=r.id) AS loads,
    (SELECT sum(x.invoice_litres) FROM fuel_receipt_lines x WHERE x.business_id=r.business_id AND x.receipt_id=r.id) AS invoice_litres,
    (SELECT sum(x.invoice_litres-(x.dip_after-x.dip_before)) FROM fuel_receipt_lines x WHERE x.business_id=r.business_id AND x.receipt_id=r.id AND x.dip_after IS NOT NULL) AS short_litres,
    EXISTS (SELECT 1 FROM fuel_receipt_lines x WHERE x.business_id=r.business_id AND x.receipt_id=r.id AND abs(x.receipt_density-x.invoice_density)>x.tolerance) AS density_outside
  FROM fuel_receipts r JOIN business_locations l ON l.business_id=r.business_id AND l.id=r.location_id
  LEFT JOIN business_documents d ON d.business_id=r.business_id AND d.id=r.document_id
  WHERE r.business_id=$1`;

repo.addLists({
  // Every tanker load, newest first, with its tanks and litres, a short receipt and the density check.
  'fuel-receipts': { sql: RECEIPTS_SQL, search: ['invoice_no', 'lorry_no', 'supplier_name', 'loads', 'document_no'], date: 'received_at',
    filters: { status: 'status', location: 'location_id', density_outside: 'density_outside', contact: 'contact_id' }, order: 'received_at DESC,id DESC' },
});
const listShape = (business, page) => (seesPurchases(business) ? page : { ...page, items: page.items.map((r) => ({ ...r, amount: null })) });

async function receiptDetail(db, business, receiptId) {
  const receipt = await repo.one(db, `SELECT * FROM (${RECEIPTS_SQL}) x WHERE x.id=$2`, [business.id, receiptId]);
  if (!receipt) fail('Tanker receipt not found', 404);
  access.requireLocation(business, receipt.location_id);
  const lines = await repo.all(db, `SELECT x.*,t.tank_no,t.capacity,sk.label AS product_name,f.family,u.name AS decant_by_name FROM fuel_receipt_lines x
    JOIN fuel_tanks t ON t.business_id=x.business_id AND t.id=x.tank_id JOIN fuel_products f ON f.business_id=x.business_id AND f.id=x.product_id
    JOIN catalog_skus sk ON sk.business_id=f.business_id AND sk.id=f.sku_id LEFT JOIN users u ON u.id=x.decant_by WHERE x.business_id=$1 AND x.receipt_id=$2 ORDER BY x.seq`,
  [business.id, receiptId]);
  const people = await repo.one(db, `SELECT cu.name AS created_by_name,au.name AS density_approved_by_name,xu.name AS cancelled_by_name FROM fuel_receipts r JOIN users cu ON cu.id=r.created_by
    LEFT JOIN users au ON au.id=r.density_approved_by LEFT JOIN users xu ON xu.id=r.cancelled_by WHERE r.business_id=$1 AND r.id=$2`, [business.id, receiptId]);
  const shaped = lines.map((l) => {
    const density = money.densityCheck({ invoice: l.invoice_density, receipt: l.receipt_density, tolerance: l.tolerance });
    const dips = money.receiptFigures({ invoiceLitres: l.invoice_litres, dipBefore: l.dip_before, dipAfter: l.dip_after });
    const allowance = allowancesOf(l);
    return { ...l, density_difference: money.fixed(density.difference, 1), density_within: density.within,
      received_litres: dips.received === null ? null : money.litres(dips.received), short_litres: dips.short === null ? null : money.litres(dips.short),
      shrinkage_litres: money.litres(allowance.shrinkage.litres), shrinkage_percent: money.fixed(allowance.shrinkage.percent, 4),
      tva_litres: money.litres(allowance.tva.litres), tva_percent: money.fixed(allowance.tva.percent, 4), allowance_litres: money.litres(allowance.litres),
      invoice_amount: seesPurchases(business) ? l.invoice_amount : null, shrinkage_per_kl: seesPurchases(business) ? l.shrinkage_per_kl : null, tva_per_kl: seesPurchases(business) ? l.tva_per_kl : null };
  });
  const compartments = await repo.all(db, `SELECT x.*,t.tank_no FROM fuel_receipt_compartments x JOIN fuel_receipt_lines l ON l.business_id=x.business_id AND l.receipt_id=x.receipt_id AND l.seq=x.seq
    JOIN fuel_tanks t ON t.business_id=l.business_id AND t.id=l.tank_id WHERE x.business_id=$1 AND x.receipt_id=$2 ORDER BY x.compartment_no`, [business.id, receiptId]);
  const samples = await repo.all(db, `SELECT ${SAMPLE_COLUMNS} FROM ${SAMPLE_FROM} WHERE m.business_id=$1 AND m.receipt_id=$2 ORDER BY m.id`, [business.id, receiptId]);
  return { ...receipt, ...people, amount: seesPurchases(business) ? receipt.amount : null, lines: shaped, compartments, samples };
}

// A load's shrinkage and temperature variation allowances (thousandths of a litre, ten-thousandths of a percent).
function allowancesOf(line) {
  const base = { litres: money.milli(line.invoice_litres), amount: money.paise(line.invoice_amount) };
  const shrinkage = money.allowanceOf({ ...base, perKl: line.shrinkage_per_kl === null ? 0 : money.paise(line.shrinkage_per_kl) });
  const tva = money.allowanceOf({ ...base, perKl: line.tva_per_kl === null ? 0 : money.paise(line.tva_per_kl) });
  return { shrinkage, tva, litres: shrinkage.litres + tva.litres };
}

async function receipt(business, receiptId) {
  c.requireFuel(business);
  await access.require(business, 'fuel.view');
  return receiptDetail(repo.pool, business, id(receiptId, 'Tanker receipt'));
}

function readReceiptLine(raw, index) {
  const name = `Tank ${index + 1}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${name} must be an object`);
  const dipBefore = c.given(raw.dipBefore) ? c.readLitres(raw.dipBefore, `${name}: dip before decanting (litres)`) : null;
  const dipAfter = c.given(raw.dipAfter) ? c.readLitres(raw.dipAfter, `${name}: dip after decanting (litres)`) : null;
  if ((dipBefore === null) !== (dipAfter === null)) fail(`${name}: give the dip before and after decanting`);
  if (dipAfter !== null && Number(dipAfter) <= Number(dipBefore)) fail(`${name}: the dip after decanting is more than the dip before it`);
  return {
    tankId: id(raw.tankId, `${name}: tank`),
    invoiceLitres: c.readLitres(raw.invoiceLitres, `${name}: litres on the invoice`, { min: 0, minExclusive: true }),
    invoiceAmount: c.readMoney(raw.invoiceAmount, `${name}: value on the invoice`),
    invoiceDensity: c.readDensity(raw.invoiceDensity, `${name}: density at 15 °C on the invoice`),
    receiptDensity: c.readDensity(raw.receiptDensity, `${name}: the lorry's density at 15 °C`),
    dipBefore, dipAfter,
    decantDensity: c.optionalDensity(raw.decantDensity, `${name}: density after decanting`),
    shrinkagePerKl: c.given(raw.shrinkagePerKl) ? c.readMoney(raw.shrinkagePerKl, `${name}: shrinkage allowance (₹ a KL)`, { max: 10000 }) : null,
    tvaPerKl: c.given(raw.tvaPerKl) ? signedMoney(raw.tvaPerKl, `${name}: temperature variation allowance (₹ a KL)`) : null,
  };
}
// Rupees that may be below zero ("-45.50"), to the paisa: a temperature variation allowance either way.
function signedMoney(value, name) {
  const text = String(value ?? '').trim();
  const negative = text.startsWith('-');
  const read = c.readMoney(negative ? text.slice(1) : text, name, { max: 10000 });
  return negative && Number(read) !== 0 ? `-${read}` : read;
}

// A compartment of the lorry as checked before decanting.
function readCompartment(raw, index) {
  const name = `Compartment ${index + 1}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${name} must be an object`);
  const temp = (value, label) => (c.given(value) ? signedTemperature(value, `${name}: ${label}`) : null);
  const out = {
    compartmentNo: c.whole(raw.compartmentNo ?? index + 1, `${name}: number`, 1, 12),
    tankId: id(raw.tankId, `${name}: tank it went into`),
    dipCm: c.given(raw.dipCm) ? c.readDecimal(raw.dipCm, `${name}: dip (cm)`, 1, { max: 99999 }) : null,
    density: c.optionalDensity(raw.density, `${name}: density (kg/m³)`),
    temperature: temp(raw.temperature, 'temperature (°C)'),
    waterFound: v.requiredBoolean(raw.waterFound, `${name}: water found by the paste`, false),
    waterCm: c.given(raw.waterCm) ? c.readDecimal(raw.waterCm, `${name}: water (cm)`, 1, { max: 999 }) : null,
    checkLitres: c.given(raw.checkLitres) ? c.readLitres(raw.checkLitres, `${name}: litres drawn from the manifold`, { min: 0, minExclusive: true, max: 100 }) : null,
    checkDensity: c.optionalDensity(raw.checkDensity, `${name}: density of the litres drawn`),
    checkTemperature: temp(raw.checkTemperature, 'temperature of the litres drawn (°C)'),
    shortLitres: c.given(raw.shortLitres) ? c.readLitres(raw.shortLitres, `${name}: short by the dip (litres)`, { max: 100000 }) : '0.000',
    madeUpLitres: c.given(raw.madeUpLitres) ? c.readLitres(raw.madeUpLitres, `${name}: made up through the pump (litres)`, { max: 100000 }) : '0.000',
  };
  if (!out.waterFound && out.waterCm !== null && Number(out.waterCm) > 0) fail(`${name}: water is measured only when the paste found it`);
  if ((out.checkDensity !== null || out.checkTemperature !== null) && out.checkLitres === null) fail(`${name}: give the litres drawn from the manifold with their density`);
  if (Number(out.madeUpLitres) > Number(out.shortLitres)) fail(`${name}: no more is made up than it was short`);
  return out;
}
function signedTemperature(value, name) {
  const text = String(value ?? '').trim();
  const negative = text.startsWith('-');
  const read = c.readDecimal(negative ? text.slice(1) : text, name, 1, { max: 70 });
  return negative ? `-${read}` : read;
}

// body: { requestKey, locationId, contactId (the supplier), invoiceNo, invoiceDate, lorryNo, receivedAt? (now), sealsOk?, status: accepted | refused,
//   refuseReason? (refused), densityNote? (a manager accepting a density outside the tolerance), notes?,
//   lines: [{ tankId, invoiceLitres, invoiceAmount, invoiceDensity, receiptDensity, dipBefore?, dipAfter?, decantDensity? }] }
async function record(business, user, body) {
  c.requireFuel(business);
  await access.require(business, 'fuel.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const status = v.requiredEnum(body.status, 'The load is', ['accepted', 'refused']);
  if (status === 'accepted') await access.require(business, 'purchasing.create');
  const lines = v.requiredArray(body.lines, 'Tanks').map(readReceiptLine);
  if (!lines.length || lines.length > MAX_LINES) fail(`A load goes into 1 to ${MAX_LINES} tanks`);
  if (new Set(lines.map((l) => l.tankId)).size !== lines.length) fail('Each tank is on the load once');
  const invoiceNo = v.requiredString(typeof body.invoiceNo === 'string' ? body.invoiceNo : '', 'Invoice number', 60);
  const invoiceDate = c.readDate(body.invoiceDate, 'Invoice date');
  const lorryNo = c.readPlate(body.lorryNo, 'Tank lorry number');
  const refuseReason = status === 'refused' ? v.requiredString(typeof body.refuseReason === 'string' ? body.refuseReason : '', 'Why the load is refused', 300) : null;
  const densityNote = status === 'accepted' ? c.optionalText(body.densityNote, 'Why the load is accepted', 300) : null;
  const sealsOk = body.sealsOk === undefined || body.sealsOk === null ? null : v.requiredBoolean(body.sealsOk, 'Seals matched the invoice');
  const notes = c.optionalText(body.notes, 'Notes', 500);
  const compartments = body.compartments === undefined || body.compartments === null ? [] : v.requiredArray(body.compartments, 'Compartments').map(readCompartment);
  if (compartments.length > 12) fail('A tank lorry has at most 12 compartments');
  if (new Set(compartments.map((x) => x.compartmentNo)).size !== compartments.length) fail('Each compartment is checked once');
  const samples = body.samples === undefined || body.samples === null ? [] : v.requiredArray(body.samples, 'Retention samples').map(readSample);
  if (samples.length && status !== 'accepted') fail('Retention samples are kept of a load received');
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const old = await repo.one(db, 'SELECT id,request_hash FROM fuel_receipts WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return receiptDetail(db, business, old.id);
    }
    const location = await c.locationOf(db, business, body.locationId);
    const supplier = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='supplier'", [business.id, id(body.contactId, 'Supplier')]);
    if (!supplier) fail('Supplier not found', 404);
    if (!supplier.active) fail(`${supplier.name} is switched off`, 409);
    const typed = await c.readWhen(db, business, body.receivedAt, 'Decanted at');
    if (typed) {
      const when = await repo.one(db, "SELECT $1::timestamptz > now() AS later, $1::timestamptz < now() - interval '7 days' AS old", [typed]);
      if (when.later) fail('A load is decanted now or earlier');
      if (when.old) fail('A tanker load is written within a week of its decanting');
    }
    const settings = await c.settingsOf(db, business.id);
    const tolerance = settings.density_tolerance;
    const shaped = [];
    for (const [index, l] of lines.entries()) {
      const tank = await repo.one(db, `${TANKS_SQL} AND t.id=$2`, [business.id, l.tankId]);
      if (!tank || String(tank.location_id) !== String(location.id)) fail(`Tank ${index + 1}: not a tank of ${location.name}`, 404);
      if (!tank.active) fail(`Tank ${tank.tank_no} is switched off`, 409);
      const density = money.densityCheck({ invoice: l.invoiceDensity, receipt: l.receiptDensity, tolerance });
      if (status === 'accepted') {
        if (l.dipBefore === null) fail(`Tank ${tank.tank_no}: give the dip before and after decanting`);
        if (Number(l.dipAfter) > Number(tank.capacity)) fail(`Tank ${tank.tank_no} holds at most ${tank.capacity} litres`);
      }
      if (l.decantDensity && status !== 'accepted') fail('A refused load is not decanted');
      shaped.push({ ...l, tank, density });
    }
    // Outside the tolerance a load is refused, unless a manager accepts it saying why.
    const outside = shaped.filter((l) => !l.density.within);
    let approvedBy = null;
    if (status === 'accepted' && outside.length) {
      if (!densityNote || !access.can(business, 'fuel.approve')) {
        const words = outside.map((l) => `tank ${l.tank.tank_no}'s load is ${money.fixed(Math.abs(l.density.difference), 1)} kg/m³ ${l.density.difference > 0 ? 'above' : 'below'} its invoice's density`);
        fail(`${c.listWords(words)}, outside the ${tolerance} kg/m³ allowed: refuse the load, or a manager accepts it saying why`, 409,
          { reason: 'density_outside', tolerance, lines: outside.map((l) => ({ tankId: l.tankId, tankNo: l.tank.tank_no, difference: money.fixed(l.density.difference, 1) })) });
      }
      approvedBy = user.id;
    }
    if (status === 'accepted' && !outside.length && densityNote) fail('Every density is within the tolerance: no manager\'s note is needed');
    const lineOf = (tankId, what) => {
      const index = shaped.findIndex((l) => String(l.tankId) === String(tankId));
      if (index < 0) fail(`${what}: that tank is not on this load`, 404);
      return index + 1;
    };
    const compartmentRows = compartments.map((x) => ({ ...x, seq: lineOf(x.tankId, `Compartment ${x.compartmentNo}`) }));
    const sampleRows = samples.map((x, i) => ({ ...x, seq: lineOf(x.tankId, `Sample ${i + 1}`) }));
    // An accepted load is a purchase through the core: the invoice's litres at its value, no GST.
    let document = null, documentLines = [];
    if (status === 'accepted') {
      const fixed = shaped.map((l) => {
        const net = money.paise(l.invoiceAmount);
        return { price: Number(((net / 100) / Number(l.invoiceLitres)).toFixed(4)), net, tax: 0, priceRuleId: null, enteredPrice: null,
          label: `${l.tank.product_name} · tank ${l.tank.tank_no} · lorry ${lorryNo}`.slice(0, 150) };
      });
      const documentBody = { kind: 'purchase', locationId: location.id, contactId: supplier.id, supplierBillNo: invoiceNo, supplierBillDate: invoiceDate,
        lines: shaped.map((l) => ({ skuId: l.tank.sku_id, quantity: l.invoiceLitres })), notes: `Tanker ${lorryNo}, invoice ${invoiceNo}` };
      document = await core.postDocument(db, business, user, documentBody, { kind: 'purchase', requestKey: c.derivedKey(requestKey, 'purchase'), hash: c.hashOf(documentBody),
        lines: documentBody.lines, paidNow: [], fixed, fuel: true });
      documentLines = await repo.all(db, 'SELECT id FROM business_document_lines WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, document.id]);
      if (documentLines.length !== shaped.length) fail('The purchase does not have a line for each tank. Try again.', 409);
    }
    const row = await repo.one(db, `INSERT INTO fuel_receipts(business_id,location_id,contact_id,supplier_name,invoice_no,invoice_date,lorry_no,received_at,seals_ok,status,refuse_reason,
        density_approved_by,density_note,document_id,notes,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8,now()),$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [business.id, location.id, supplier.id, supplier.name, invoiceNo, invoiceDate, lorryNo, typed, sealsOk, status, refuseReason, approvedBy, approvedBy ? densityNote : null,
      document?.id || null, notes, requestKey, hash, user.id]);
    for (const [index, l] of shaped.entries()) {
      await db.query(`INSERT INTO fuel_receipt_lines(business_id,receipt_id,seq,tank_id,product_id,invoice_litres,invoice_amount,invoice_density,receipt_density,tolerance,
          dip_before,dip_after,decant_density,decant_by,decant_at,line_id,shrinkage_per_kl,tva_per_kl)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,CASE WHEN $13::numeric IS NULL THEN NULL ELSE now() END,$15,$16,$17)`,
      [business.id, row.id, index + 1, l.tank.id, l.tank.product_id, l.invoiceLitres, l.invoiceAmount, l.invoiceDensity, l.receiptDensity, tolerance, l.dipBefore, l.dipAfter,
        l.decantDensity, l.decantDensity ? user.id : null, documentLines[index]?.id || null, l.shrinkagePerKl, l.tvaPerKl]);
    }
    for (const x of compartmentRows) {
      await db.query(`INSERT INTO fuel_receipt_compartments(business_id,receipt_id,compartment_no,seq,dip_cm,density,temperature,water_found,water_cm,check_litres,check_density,
          check_temperature,short_litres,made_up_litres) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [business.id, row.id, x.compartmentNo, x.seq, x.dipCm, x.density,
        x.temperature, x.waterFound, x.waterCm, x.checkLitres, x.checkDensity, x.checkTemperature, x.shortLitres, x.madeUpLitres]);
    }
    for (const x of sampleRows) {
      await db.query('INSERT INTO fuel_samples(business_id,receipt_id,seq,product_id,sample_no,seal_no,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [business.id, row.id, x.seq, shaped[x.seq - 1].tank.product_id, x.sampleNo, x.sealNo, x.note, user.id]);
    }
    const words = { invoiceNo, lorryNo, supplier: supplier.name, status, tanks: shaped.map((l) => ({ tankNo: l.tank.tank_no, litres: l.invoiceLitres,
      densityDifference: money.fixed(l.density.difference, 1) })), ...(document ? { purchase: document.document_no } : {}), ...(refuseReason ? { refuseReason } : {}),
    ...(approvedBy ? { densityNote } : {}) };
    await repo.audit(db, business.id, user.id, `fuel_receipt.${status}`, row.id, words);
    await repo.event(db, business.id, user.id, `fuel_receipt.${status}`, 'fuel_receipt', row.id, { ...words, locationId: location.id, documentId: document?.id || null,
      receivedAt: row.received_at });
    return receiptDetail(db, business, row.id);
  });
}

// body: { lines: [{ tankId, density }] } — the density at 15 °C after decanting and 50 litres dispensed, written once for each tank.
async function decant(business, user, receiptId, body) {
  c.requireFuel(business);
  await access.require(business, 'fuel.create');
  const given = v.requiredArray(body.lines, 'Densities').map((l, i) => ({ tankId: id(l?.tankId, `Density ${i + 1}: tank`), density: c.readDensity(l?.density, `Density ${i + 1}`) }));
  if (!given.length) fail('Give the density after decanting');
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const r = await repo.one(db, 'SELECT * FROM fuel_receipts WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(receiptId, 'Tanker receipt')]);
    if (!r) fail('Tanker receipt not found', 404);
    access.requireLocation(business, r.location_id);
    if (r.status !== 'accepted') fail(`Tanker receipt ${r.invoice_no} is ${r.status}`, 409);
    for (const g of given) {
      const line = await repo.one(db, 'SELECT * FROM fuel_receipt_lines WHERE business_id=$1 AND receipt_id=$2 AND tank_id=$3', [business.id, r.id, g.tankId]);
      if (!line) fail('That tank is not on this load', 404);
      if (line.decant_density !== null) fail('The density after decanting is written once', 409);
      await db.query('UPDATE fuel_receipt_lines SET decant_density=$4,decant_by=$5,decant_at=now() WHERE business_id=$1 AND receipt_id=$2 AND tank_id=$3', [business.id, r.id, g.tankId, g.density, user.id]);
    }
    await repo.audit(db, business.id, user.id, 'fuel_receipt.decanted', r.id, { invoiceNo: r.invoice_no, densities: given });
    return receiptDetail(db, business, r.id);
  });
}

// body: { requestKey, reason } — a manager cancels an accepted load entered wrongly: its purchase credited (the litres go back out of stock).
async function cancel(business, user, receiptId, body) {
  c.requireFuel(business);
  await access.require(business, 'fuel.approve');
  const requestKey = core.uuid(body.requestKey);
  const reason = v.requiredString(typeof body.reason === 'string' ? body.reason : '', 'Why the receipt is cancelled', 300);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const r = await repo.one(db, 'SELECT * FROM fuel_receipts WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(receiptId, 'Tanker receipt')]);
    if (!r) fail('Tanker receipt not found', 404);
    access.requireLocation(business, r.location_id);
    if (r.status === 'cancelled') {
      if (String(r.cancel_key) !== requestKey) fail(`Tanker receipt ${r.invoice_no} is cancelled already`, 409);
      return receiptDetail(db, business, r.id);
    }
    if (r.status !== 'accepted') fail(`Tanker receipt ${r.invoice_no} was refused: nothing came in`, 409);
    const lines = await repo.all(db, `SELECT x.*,t.tank_no,sk.label,f.sku_id FROM fuel_receipt_lines x JOIN fuel_tanks t ON t.business_id=x.business_id AND t.id=x.tank_id
      JOIN fuel_products f ON f.business_id=x.business_id AND f.id=x.product_id JOIN catalog_skus sk ON sk.business_id=f.business_id AND sk.id=f.sku_id
      WHERE x.business_id=$1 AND x.receipt_id=$2 ORDER BY x.seq`, [business.id, r.id]);
    for (const l of lines) {
      const lot = await repo.one(db, "SELECT COALESCE(sum(quantity),0) AS quantity FROM business_stock_lots WHERE business_id=$1 AND location_id=$2 AND sku_id=$3 AND lot_code=''",
        [business.id, r.location_id, l.sku_id]);
      if (money.milli(lot.quantity) < money.milli(l.invoice_litres)) {
        fail(`${l.label}: the stock at the outlet is ${lot.quantity} litres, less than the ${l.invoice_litres} of this load: it can no longer be cancelled`, 409);
      }
    }
    await db.query("UPDATE fuel_receipts SET status='cancelled',cancelled_at=now(),cancelled_by=$3,cancel_reason=$4,cancel_key=$5 WHERE business_id=$1 AND id=$2",
      [business.id, r.id, user.id, reason, requestKey]);
    const doc = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, r.document_id]);
    const returned = await returns.postReturn(db, business, user, doc, { reason: `Tanker receipt ${r.invoice_no} cancelled: ${reason}`.slice(0, 300),
      requestKey: c.derivedKey(requestKey, 'return'), hash: c.hashOf({ cancel: requestKey, receipt: r.id }), lines: lines.map((l) => ({ lineId: l.line_id, quantity: l.invoice_litres })) });
    await repo.audit(db, business.id, user.id, 'fuel_receipt.cancelled', r.id, { invoiceNo: r.invoice_no, reason, debitNote: returned.return_no });
    await repo.event(db, business.id, user.id, 'fuel_receipt.cancelled', 'fuel_receipt', r.id, { invoiceNo: r.invoice_no, locationId: r.location_id, documentId: doc.id, returnId: returned.id });
    return receiptDetail(db, business, r.id);
  });
}

// --- The stock register ---------------------------------------------------------------------------

// query: { locationId?, tankId?, from?, to? } (the month so far until given) — each tank's register, day by day.
async function register(business, query = {}) {
  c.requireFuel(business);
  await access.require(business, 'fuel.view');
  const db = repo.pool;
  const location = await c.boardOutlet(db, business, query.locationId || query.location);
  const today = await c.today(db, business);
  const from = query.from ? c.readDate(query.from, 'From date') : `${today.slice(0, 8)}01`;
  const to = query.to ? c.readDate(query.to, 'To date') : today;
  if (to < from) fail('The end date is before the start date');
  if (Date.parse(to) - Date.parse(from) > REGISTER_DAYS * 86400000) fail(`Choose up to ${REGISTER_DAYS} days`);
  const settings = await c.settingsOf(db, business.id);
  const tanks = await repo.all(db, `${TANKS_SQL} AND t.location_id=$2 AND ($3::bigint IS NULL OR t.id=$3) ORDER BY t.sort_order,lower(t.tank_no)`,
    [business.id, location.id, c.given(query.tankId) ? id(query.tankId, 'Tank') : null]);
  const out = [];
  for (const tank of tanks) {
    out.push({ ...tank, rows: await tankRows(db, business, tank, from, to, settings), allowance: money.percentText(money.lossAllowance(tank.family, settings)) });
  }
  return { location, from, to, today, settings: { variationPercent: settings.variation_percent, above600Kl: settings.above_600_kl }, tanks: out };
}

// A tank's register, day by day from its morning dips (Annexure 9): the
// opening dip (A), the loads received (B) less their shrinkage and TVA (C),
// the meters' sales (E), the book (F), the next morning's dip (G), the
// variation against the tolerance, and a correction posted for the day.
async function tankRows(db, business, tank, from, to, settings) {
  const dipRows = await repo.all(db, `SELECT d.*,d.dip_on::text AS dip_on FROM fuel_dips d WHERE d.business_id=$1 AND d.tank_id=$2 AND d.dip_on>=$3
    AND d.dip_on<=(SELECT COALESCE(min(x.dip_on),$4::date) FROM fuel_dips x WHERE x.business_id=$1 AND x.tank_id=$2 AND x.dip_on>$4) ORDER BY d.dip_on`, [business.id, tank.id, from, to]);
  const start = dipRows[0]?.taken_at || null;
  const receipts = start ? await repo.all(db, `SELECT x.invoice_litres,x.invoice_amount,x.shrinkage_per_kl,x.tva_per_kl,r.received_at,r.invoice_no FROM fuel_receipt_lines x
    JOIN fuel_receipts r ON r.business_id=x.business_id AND r.id=x.receipt_id WHERE x.business_id=$1 AND x.tank_id=$2 AND r.status='accepted' AND r.received_at>=$3`,
  [business.id, tank.id, start]) : [];
  const sold = start ? await repo.all(db, `SELECT x.closing-x.opening AS gross,x.test,x.litres,k.closed_at FROM fuel_close_readings x
    JOIN fuel_shift_closes k ON k.business_id=x.business_id AND k.id=x.close_id WHERE x.business_id=$1 AND x.tank_id=$2 AND k.reopened_at IS NULL AND k.closed_at>=$3`,
  [business.id, tank.id, start]) : [];
  const open = await repo.one(db, `SELECT count(DISTINCT s.id)::int AS n,min(s.opened_at) AS since FROM fuel_shift_nozzles n JOIN fuel_shifts s ON s.business_id=n.business_id AND s.id=n.shift_id
    WHERE n.business_id=$1 AND n.tank_id=$2 AND s.status='open'`, [business.id, tank.id]);
  const corrections = await repo.all(db, `SELECT k.id,k.day::text AS day,k.litres,k.reason,k.created_at,u.name AS created_by_name FROM fuel_stock_corrections k JOIN users u ON u.id=k.created_by
    WHERE k.business_id=$1 AND k.tank_id=$2 AND k.day BETWEEN $3 AND $4`, [business.id, tank.id, from, to]);
  const rows = [];
  dipRows.forEach((dip, index) => {
    if (dip.dip_on > to) return;
    const next = dipRows[index + 1] || null;
    const within = (at) => new Date(at) >= new Date(dip.taken_at) && (!next || new Date(at) < new Date(next.taken_at));
    const inLoads = receipts.filter((r) => within(r.received_at));
    const inSales = sold.filter((s) => within(s.closed_at));
    const sum = (list, key) => list.reduce((total, x) => total + money.milli(x[key]), 0);
    const allowances = inLoads.map(allowancesOf);
    const shrinkage = allowances.reduce((total, a) => total + a.shrinkage.litres, 0);
    const tva = allowances.reduce((total, a) => total + a.tva.litres, 0);
    const figures = money.registerFigures({ opening: money.milli(dip.stock), receipts: sum(inLoads, 'invoice_litres'), sales: sum(inSales, 'litres'),
      closing: next ? money.milli(next.stock) : null, family: tank.family, settings, allowance: shrinkage + tva });
    rows.push({
      day: dip.dip_on, takenAt: dip.taken_at, opening: dip.stock, waterCm: dip.water_cm, density: dip.density, temperature: dip.temperature,
      receipts: money.litres(sum(inLoads, 'invoice_litres')), loads: inLoads.map((r) => r.invoice_no), shrinkage: money.litres(shrinkage), tva: money.litres(tva),
      afterAllowances: money.litres(money.milli(dip.stock) + sum(inLoads, 'invoice_litres') - shrinkage - tva),
      meter: money.litres(sum(inSales, 'gross')), test: money.litres(sum(inSales, 'test')),
      sales: money.litres(sum(inSales, 'litres')), book: money.litres(figures.book), closingDay: next?.dip_on || null, closing: next ? next.stock : null,
      variation: figures.variation === null ? null : money.litres(figures.variation), percent: figures.percent === null ? null : money.percentText(figures.percent),
      allowedGain: figures.allowedGain === null ? null : money.litres(figures.allowedGain), allowedLoss: figures.allowedLoss === null ? null : money.litres(figures.allowedLoss),
      flag: figures.flag, openShifts: !next && open.n ? open.n : 0,
      // What the stock moves by when the day is posted: the dip against the stock by the meters and the invoices.
      gap: figures.variation === null ? null : money.litres(figures.variation - shrinkage - tva),
      correction: corrections.find((x) => x.day === dip.dip_on) || null,
    });
  });
  return rows;
}

// body: { requestKey, tankId, day, reason } — a day of a tank's register posted
// to the stock as a correction through the core, by a manager, once: the
// stock moves by the gap between the next morning's dip and the stock by the
// meters and the invoices (the variation, and the allowances taken in the book).
async function correctStock(business, user, body) {
  c.requireFuel(business);
  await access.require(business, 'fuel.approve');
  await access.require(business, 'inventory.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const day = c.readDate(body.day, 'Day of the register');
  const reason = v.requiredString(typeof body.reason === 'string' ? body.reason : '', 'Why the stock is corrected', 300);
  const correctionId = await repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const old = await repo.one(db, 'SELECT id,request_hash FROM fuel_stock_corrections WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return old.id;
    }
    const tank = await repo.one(db, `${TANKS_SQL} AND t.id=$2`, [business.id, id(body.tankId, 'Tank')]);
    if (!tank) fail('Tank not found', 404);
    access.requireLocation(business, tank.location_id);
    const done = await repo.one(db, 'SELECT id FROM fuel_stock_corrections WHERE business_id=$1 AND tank_id=$2 AND day=$3', [business.id, tank.id, day]);
    if (done) fail(`Tank ${tank.tank_no}'s register of ${c.dateWords(day)} is posted to the stock already`, 409);
    const settings = await c.settingsOf(db, business.id);
    const row = (await tankRows(db, business, tank, day, day, settings)).find((r) => r.day === day);
    if (!row) fail(`Tank ${tank.tank_no} has no morning dip on ${c.dateWords(day)}`, 404);
    if (row.variation === null) fail(`Tank ${tank.tank_no}'s day of ${c.dateWords(day)} is still open: the next morning's dip closes it`, 409);
    if (row.openShifts) fail(`A shift is still open on tank ${tank.tank_no}: close it before posting the day`, 409);
    const gap = money.milli(row.gap);
    if (gap === 0) fail(`Tank ${tank.tank_no}'s dip matches the stock by the meters and the invoices on ${c.dateWords(day)}: there is nothing to post`, 409);
    const words = `Stock register of tank ${tank.tank_no}, ${c.dateWords(day)}: ${reason}`.slice(0, 300);
    const lot = await repo.one(db, `SELECT l.*,s.tracking,s.unit,s.label,u.decimals AS unit_decimals FROM business_stock_lots l JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
      JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit WHERE l.business_id=$1 AND l.location_id=$2 AND l.sku_id=$3 AND l.lot_code='' FOR UPDATE OF l`,
    [business.id, tank.location_id, tank.sku_id]);
    if (!lot) fail(`${tank.product_name} has no stock at this outlet to correct`, 409);
    const adjustment = await returns.applyAdjustment(db, business, user, lot, gap / 1000, words, c.derivedKey(requestKey, 'adjustment'));
    const variation = money.milli(row.variation);
    const saved = await repo.one(db, `INSERT INTO fuel_stock_corrections(business_id,location_id,tank_id,day,litres,variation,allowance,reason,adjustment_id,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [business.id, tank.location_id, tank.id, day, money.litres(gap), money.litres(variation),
      money.litres(variation - gap), reason, adjustment.id, requestKey, hash, user.id]);
    await repo.audit(db, business.id, user.id, 'fuel_register.posted', saved.id, { tankNo: tank.tank_no, day, litres: money.litres(gap), variation: row.variation, reason });
    await repo.audit(db, business.id, user.id, 'stock.adjusted', adjustment.id, { reason: words, quantity: money.litres(gap), label: tank.product_name });
    await repo.event(db, business.id, user.id, 'stock.adjusted', 'stock_adjustment', adjustment.id, { skuId: tank.sku_id, locationId: tank.location_id, quantity: money.litres(gap), reason: words });
    return saved.id;
  });
  return repo.one(repo.pool, `SELECT k.*,k.day::text AS day FROM fuel_stock_corrections k WHERE k.business_id=$1 AND k.id=$2`, [business.id, correctionId]);
}

// --- Retention samples ------------------------------------------------------------------------

const SAMPLE_COLUMNS = `m.id,m.receipt_id,m.seq,m.product_id,sk.label AS product_name,t.tank_no,r.invoice_no,r.lorry_no,r.received_at,r.location_id,m.sample_no,m.seal_no,m.note,m.created_at,
  m.disposed_at,m.disposal_note,du.name AS disposed_by_name,fuel_later_loads(m.business_id,m.receipt_id,m.product_id) AS later_loads`;
const SAMPLE_FROM = `fuel_samples m JOIN fuel_receipts r ON r.business_id=m.business_id AND r.id=m.receipt_id
  JOIN fuel_receipt_lines l ON l.business_id=m.business_id AND l.receipt_id=m.receipt_id AND l.seq=m.seq JOIN fuel_tanks t ON t.business_id=l.business_id AND t.id=l.tank_id
  JOIN fuel_products f ON f.business_id=m.business_id AND f.id=m.product_id JOIN catalog_skus sk ON sk.business_id=f.business_id AND sk.id=f.sku_id LEFT JOIN users du ON du.id=m.disposed_by`;

function readSample(raw, index) {
  const name = `Sample ${index + 1}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${name} must be an object`);
  return { tankId: id(raw.tankId, `${name}: tank`), sampleNo: v.requiredString(typeof raw.sampleNo === 'string' ? raw.sampleNo : String(raw.sampleNo ?? ''), `${name}: sample number`, 40),
    sealNo: v.requiredString(typeof raw.sealNo === 'string' ? raw.sealNo : String(raw.sealNo ?? ''), `${name}: seal number`, 40), note: c.optionalText(raw.note, `${name}: note`, 300) };
}

// query: { locationId?, all? } — the retention samples kept at an outlet, fuel
// by fuel: those of the last two loads kept, the older ones due for disposal
// (and, with all, those disposed of).
async function samples(business, query = {}) {
  c.requireFuel(business);
  await access.require(business, 'fuel.view');
  const db = repo.pool;
  const location = await c.boardOutlet(db, business, query.locationId || query.location);
  const all = query.all === true || query.all === 'true';
  const rows = await repo.all(db, `SELECT ${SAMPLE_COLUMNS} FROM ${SAMPLE_FROM} WHERE m.business_id=$1 AND r.location_id=$2 AND ($3 OR m.disposed_at IS NULL)
    ORDER BY sk.label,r.received_at DESC,m.id`, [business.id, location.id, all]);
  return { location, items: rows.map((s) => ({ ...s, due: !s.disposed_at && s.later_loads >= 2 })) };
}

// body: { tankId, samples: [{ sampleNo, sealNo, note? }] } — samples of an accepted load kept after it was written.
async function addSamples(business, user, receiptId, body) {
  c.requireFuel(business);
  await access.require(business, 'fuel.create');
  const list = v.requiredArray(body.samples, 'Retention samples').map((x, i) => readSample({ ...x, tankId: x?.tankId ?? body.tankId }, i));
  if (!list.length || list.length > 10) fail('Give 1 to 10 samples');
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const r = await repo.one(db, 'SELECT * FROM fuel_receipts WHERE business_id=$1 AND id=$2', [business.id, id(receiptId, 'Tanker receipt')]);
    if (!r) fail('Tanker receipt not found', 404);
    access.requireLocation(business, r.location_id);
    if (r.status !== 'accepted') fail(`Tanker receipt ${r.invoice_no} is ${r.status}: samples are kept of a load received`, 409);
    for (const x of list) {
      const line = await repo.one(db, 'SELECT seq,product_id FROM fuel_receipt_lines WHERE business_id=$1 AND receipt_id=$2 AND tank_id=$3', [business.id, r.id, x.tankId]);
      if (!line) fail('That tank is not on this load', 404);
      const same = await repo.one(db, 'SELECT 1 FROM fuel_samples WHERE business_id=$1 AND receipt_id=$2 AND seq=$3 AND sample_no=$4', [business.id, r.id, line.seq, x.sampleNo]);
      if (same) fail(`Sample ${x.sampleNo} of this load is kept already`, 409);
      await db.query('INSERT INTO fuel_samples(business_id,receipt_id,seq,product_id,sample_no,seal_no,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [business.id, r.id, line.seq, line.product_id, x.sampleNo, x.sealNo, x.note, user.id]);
    }
    await repo.audit(db, business.id, user.id, 'fuel_sample.kept', r.id, { invoiceNo: r.invoice_no, samples: list.map((x) => ({ sampleNo: x.sampleNo, sealNo: x.sealNo })) });
    return receiptDetail(db, business, r.id);
  });
}

// body: { note? } — a sample disposed of, once two later loads of its fuel have come in.
async function disposeSample(business, user, sampleId, body) {
  c.requireFuel(business);
  await access.require(business, 'fuel.create');
  const note = c.optionalText(body.note, 'Note', 300);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const s = await repo.one(db, `SELECT ${SAMPLE_COLUMNS} FROM ${SAMPLE_FROM} WHERE m.business_id=$1 AND m.id=$2`, [business.id, id(sampleId, 'Sample')]);
    if (!s) fail('Sample not found', 404);
    access.requireLocation(business, s.location_id);
    if (s.disposed_at) fail(`Sample ${s.sample_no} is disposed of already`, 409);
    if (s.later_loads < 2) fail(`Sample ${s.sample_no} is of one of the last two loads of ${s.product_name}: it is kept until two more have come in`, 409);
    await db.query('UPDATE fuel_samples SET disposed_at=now(),disposed_by=$3,disposal_note=$4 WHERE business_id=$1 AND id=$2', [business.id, s.id, user.id, note]);
    await repo.audit(db, business.id, user.id, 'fuel_sample.disposed', s.id, { sampleNo: s.sample_no, sealNo: s.seal_no, invoiceNo: s.invoice_no, note });
    return { ...s, disposed: true };
  });
}

// query: { locationId?, month? (this month) } — the density register: each tank's morning densities and each load's densities, day by day.
async function density(business, query = {}) {
  c.requireFuel(business);
  await access.require(business, 'fuel.view');
  const db = repo.pool;
  const location = await c.boardOutlet(db, business, query.locationId || query.location);
  const today = await c.today(db, business);
  const { month, from, to } = c.readMonth(query.month || today.slice(0, 7));
  const tanks = await repo.all(db, `${TANKS_SQL} AND t.location_id=$2 ORDER BY t.sort_order,lower(t.tank_no)`, [business.id, location.id]);
  const out = [];
  for (const tank of tanks) {
    const dipRows = await repo.all(db, `SELECT dip_on::text AS dip_on,taken_at,density,temperature FROM fuel_dips WHERE business_id=$1 AND tank_id=$2 AND dip_on BETWEEN $3 AND $4 ORDER BY dip_on`,
      [business.id, tank.id, from, to]);
    const loads = await repo.all(db, `SELECT (r.received_at AT TIME ZONE $5)::date::text AS day,r.received_at,r.invoice_no,r.lorry_no,r.status,x.invoice_density,x.receipt_density,x.tolerance,
        x.decant_density FROM fuel_receipt_lines x JOIN fuel_receipts r ON r.business_id=x.business_id AND r.id=x.receipt_id
      WHERE x.business_id=$1 AND x.tank_id=$2 AND (r.received_at AT TIME ZONE $5)::date BETWEEN $3 AND $4 ORDER BY r.received_at`, [business.id, tank.id, from, to, business.timezone]);
    const days = [...new Set([...dipRows.map((d) => d.dip_on), ...loads.map((l) => l.day)])].sort();
    out.push({ ...tank, rows: days.map((day) => ({ day, dip: dipRows.find((d) => d.dip_on === day) || null,
      loads: loads.filter((l) => l.day === day).map((l) => {
        const check = money.densityCheck({ invoice: l.invoice_density, receipt: l.receipt_density, tolerance: l.tolerance });
        return { ...l, difference: money.fixed(check.difference, 1), within: check.within };
      }) })) });
  }
  return { location, month, from, to, tanks: out };
}

module.exports = { TANKS_SQL, bookNow, dips, takeDip, correctDip, chart, saveChart, RECEIPTS_SQL, listShape, receipt, receiptDetail, record, decant, cancel, register, tankRows,
  correctStock, density, samples, addSamples, disposeSample, allowancesOf };
