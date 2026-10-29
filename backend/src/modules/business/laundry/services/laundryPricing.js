const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const { RUNNING } = require('../../retail/services/businessOffers');
const c = require('./laundryCommon');
const money = require('./laundryMoney');

// Pricing garments as they are taken in (module "laundry"), shared by the
// intake, garments added to an open order and a garment changed before its
// work starts:
//   the price   the customer's own price for the garment and service in force
//               on the business's day, else their group's, else the
//               location's, else the price list's (each by the piece, the
//               kilo or the square foot); or a manager's typed price on a change
//   the area    a carpet or curtain by the square foot: its length and width
//               in feet, the area rounded as the shop sets
//   express     the order's surcharge on each garment's price
//   a package   a prepaid package of the customer's in force today, covering
//               the garment's service in its unit (kilos for a bundle by the
//               kilo, pieces for one by the piece): it pays for what it still
//               holds of the garment, the rest is charged
//   an offer    the best offer running now of a percentage off the service's
//               item (Offers & discounts, when switched on), within its most
//               a bill and its least bill; kept as taken in
//   discounts   given by hand on a garment or on the whole order, with a
//               reason, by the discount permission and within the business's
//               most discount on a bill (the owner, any)
//   the day     the promised day from the slowest garment: its service's
//               days (express, the express days), counted on the shop's open
//               days, from the business's own date
// Money is integer paise.

const { fail, id } = c;
const whole = (value, name, min, max) => {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text) || Number(text) < min || Number(text) > max) fail(`${name} must be a whole number from ${min} to ${max}`);
  return Number(text);
};

// A discount as typed: { percent } or { amount } (rupees, off what the customer pays), or none.
function readDiscount(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be a percentage or an amount`);
  const has = (x) => x !== undefined && x !== null && String(x).trim() !== '' && Number(x) !== 0;
  if (!has(value.percent) && !has(value.amount)) return null;
  if (has(value.percent) && has(value.amount)) fail(`${name}: give a percentage or an amount, not both`);
  if (has(value.percent)) return { percent: core.decimal(value.percent, `${name} (percent)`, 2, 0.01, 100) };
  return { amount: c.paise(core.decimal(value.amount, `${name} (amount)`, 2, 0.01, 100000000)) };
}

function readItem(raw, index) {
  const name = `Garment ${index + 1}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${name} must be an object`);
  const defects = raw.defects === undefined || raw.defects === null ? [] : v.requiredArray(raw.defects, `${name}: defects`);
  for (const defect of defects) v.requiredEnum(defect, `${name}: defect`, c.DEFECTS);
  if (new Set(defects).size !== defects.length) fail(`${name}: each defect is noted once`);
  const item = {
    garmentTypeId: id(raw.garmentTypeId, `${name}: garment`), serviceId: id(raw.serviceId, `${name}: service`),
    // How many (or how many kilos), the pieces, and the size of a piece by the square foot: read with the price, which says how it is priced.
    quantity: raw.quantity, pieces: raw.pieces, length: raw.length, width: raw.width,
    tagNo: c.readTag(raw.tagNo, `${name}: tag`),
    colour: c.optionalText(raw.colour, `${name}: colour`, 40), brand: c.optionalText(raw.brand, `${name}: brand`, 60),
    defects: [...defects].sort(), defectNote: c.optionalText(raw.defectNote, `${name}: note on its defects`, 300),
    instructions: c.optionalText(raw.instructions, `${name}: instructions`, 300),
    riskNote: c.optionalText(raw.riskNote, `${name}: what the customer was told about the risk`, 300),
    acknowledged: v.requiredBoolean(raw.acknowledged, `${name}: acknowledged by the customer`, false),
    declaredValue: c.given(raw.declaredValue) ? core.decimal(raw.declaredValue, `${name}: value declared by the customer`, 2, 0.01, 100000000) : null,
    packageId: c.given(raw.packageId) ? id(raw.packageId, `${name}: package`) : null,
    discount: readDiscount(raw.discount, `${name}: discount`),
  };
  if (item.acknowledged && !item.defects.length && !item.defectNote && !item.riskNote) {
    fail(`${name}: the customer acknowledges the defects or the risk noted on a garment: note them, or untick it`);
  }
  return item;
}

// The garments as asked, and the discount on all of them with its reason.
function readGarments(body, max) {
  const items = v.requiredArray(body.items, 'Garments');
  if (!items.length) fail('Add the garments taken in');
  if (items.length > max) fail(`An order takes at most ${max} garments: take in the rest on another order`);
  const list = items.map(readItem);
  const discount = readDiscount(body.discount, 'Discount on the order');
  const reason = c.optionalText(body.discount && typeof body.discount === 'object' ? body.discount.reason : null, 'Reason for the discount', 120);
  if ((discount || list.some((i) => i.discount)) && !reason) fail('Say why the discount is given (for example "regular customer")');
  return { items: list, discount, discountReason: discount || list.some((i) => i.discount) ? reason : null };
}

// What a customer's packages hold now, and whether each is in force on the business's day.
async function packagesOf(db, business, contactId, ids = null) {
  return repo.all(db, `SELECT p.id,p.name,p.unit,p.quantity,p.service_ids,p.starts_on::text AS starts_on,p.ends_on::text AS ends_on,p.status,p.contact_id,
      laundry_package_left(p.business_id,p.id) AS left_now,(t.today BETWEEN p.starts_on AND p.ends_on) AS in_force
    FROM laundry_packages p JOIN businesses b ON b.id=p.business_id CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE b.timezone)::date AS today) t
    WHERE p.business_id=$1 AND p.contact_id=$2 AND ($3::bigint[] IS NULL OR p.id=ANY($3::bigint[])) ORDER BY p.ends_on,p.id${ids ? ' FOR UPDATE OF p' : ''}`,
  [business.id, contactId, ids]);
}

// The prices of its own in force today for these garments and services: the customer's, their group's, the location's (in that order).
async function overridesFor(db, business, { contactId, locationId, garmentIds, serviceIds }) {
  const group = contactId ? await repo.one(db, `SELECT m.group_id FROM laundry_group_members m JOIN laundry_customer_groups g ON g.business_id=m.business_id AND g.id=m.group_id
    WHERE m.business_id=$1 AND m.contact_id=$2 AND g.active`, [business.id, contactId]) : null;
  return repo.all(db, `SELECT DISTINCT ON (o.garment_type_id,o.service_id) o.*,CASE WHEN o.contact_id IS NOT NULL THEN 'customer' WHEN o.group_id IS NOT NULL THEN 'group' ELSE 'location' END AS source
    FROM laundry_price_overrides o JOIN businesses b ON b.id=o.business_id CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE b.timezone)::date AS today) t
    WHERE o.business_id=$1 AND o.garment_type_id=ANY($2::bigint[]) AND o.service_id=ANY($3::bigint[]) AND o.valid_from<=t.today AND (o.valid_to IS NULL OR o.valid_to>=t.today)
      AND (o.contact_id=$4 OR o.group_id=$5 OR o.location_id=$6)
    ORDER BY o.garment_type_id,o.service_id,CASE WHEN o.contact_id IS NOT NULL THEN 1 WHEN o.group_id IS NOT NULL THEN 2 ELSE 3 END`,
  [business.id, garmentIds, serviceIds, contactId || null, group?.group_id || null, locationId || null]);
}

// The best offer of a percentage off each of these items running now (none when offers are off).
async function offersFor(db, business, skuIds) {
  if (!(business.capabilities || business.modules || []).includes('offers')) return [];
  return repo.all(db, `SELECT o.id,o.name,o.sku_id,o.value,o.min_bill_amount,o.max_discount FROM retail_offers o JOIN businesses b ON b.id=o.business_id
    WHERE o.business_id=$1 AND o.kind='item_percent' AND o.coupon_code IS NULL AND o.sku_id=ANY($2::bigint[]) AND ${RUNNING} ORDER BY o.value DESC,o.id`, [business.id, skuIds]);
}

// Each garment priced as at intake. options: { contactId (none for a new
// customer), locationId, expressPercent, rate (a manager's price on a change),
// heldBack: { [packageId]: quantity } (what a changed garment gives back to its
// package first), order discount }. Returns the priced garments and the figures.
async function priceGarments(db, business, items, { contactId = null, locationId, expressPercent = 0, rate = null, heldBack = {}, discount = null }) {
  const settings = await repo.one(db, 'SELECT tax_mode,rounding,max_bill_discount_percent FROM business_settings WHERE business_id=$1', [business.id]);
  const laundry = await c.settingsOf(db, business.id);
  const taxMode = settings?.tax_mode || 'exclusive';
  const garments = await repo.all(db, 'SELECT * FROM laundry_garment_types WHERE business_id=$1 AND id=ANY($2::bigint[])', [business.id, [...new Set(items.map((i) => i.garmentTypeId))]]);
  const services = await repo.all(db, `SELECT ls.*,s.label,s.tax_rate,s.hsn_code,s.internal_use,(s.active AND p.active) AS item_active FROM laundry_services ls
    JOIN catalog_skus s ON s.business_id=ls.business_id AND s.id=ls.sku_id JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    WHERE ls.business_id=$1 AND ls.id=ANY($2::bigint[])`, [business.id, [...new Set(items.map((i) => i.serviceId))]]);
  const prices = await repo.all(db, 'SELECT * FROM laundry_prices WHERE business_id=$1 AND garment_type_id=ANY($2::bigint[]) AND service_id=ANY($3::bigint[])',
    [business.id, garments.map((g) => g.id), services.map((s) => s.id)]);
  const overrides = rate === null ? await overridesFor(db, business, { contactId, locationId, garmentIds: garments.map((g) => g.id), serviceIds: services.map((s) => s.id) }) : [];
  const offers = rate === null ? await offersFor(db, business, services.map((s) => s.sku_id)) : [];
  const packageIds = [...new Set(items.map((i) => i.packageId).filter(Boolean))];
  if (packageIds.length && !contactId) fail('Choose the customer whose package pays');
  const banks = packageIds.length ? await packagesOf(db, business, contactId, packageIds) : [];
  const holds = new Map(banks.map((p) => [Number(p.id), Math.round(Number(p.left_now) * 1000) + Math.round(Number(heldBack[p.id] || 0) * 1000)]));
  const lines = items.map((item, index) => {
    const garment = garments.find((g) => Number(g.id) === item.garmentTypeId);
    const service = services.find((s) => Number(s.id) === item.serviceId);
    if (!garment) fail('Garment not found', 404);
    if (!service) fail('Service not found', 404);
    if (!garment.active) fail(`${garment.name} is switched off on the price list: switch it on to take it in`, 409);
    if (!service.active) fail(`${service.label} is not offered now: switch it on in the price list`, 409);
    if (!service.item_active) fail(`${service.label}, the item it is billed as, is switched off in the catalogue`, 409);
    if (service.internal_use) fail(`${service.label} is kept for use in services only and is not billed`, 409);
    const listed = prices.find((p) => Number(p.garment_type_id) === item.garmentTypeId && Number(p.service_id) === item.serviceId);
    if (!listed) fail(`${garment.name} has no price for ${service.label} on the price list: add one first`, 409);
    const own = overrides.find((o) => Number(o.garment_type_id) === item.garmentTypeId && Number(o.service_id) === item.serviceId && o.per === listed.per);
    const per = listed.per;
    const price = rate !== null ? rate : own ? own.price : listed.price;
    const name = `Garment ${index + 1} (${garment.name})`;
    let quantity, pieces, length = null, width = null;
    if (per === 'kg') {
      if (!c.given(item.quantity)) fail(`${name} is priced by the kilo: give its weight`);
      quantity = core.decimal(item.quantity, `${name}: kilos`, 3, 0.001, 999.999);
      if (!c.given(item.pieces)) fail(`${name}: count the pieces in the bundle as well as weighing it`);
      pieces = whole(item.pieces, `${name}: pieces in the bundle`, 1, 999);
    } else if (per === 'sqft') {
      if (!c.given(item.length) || !c.given(item.width)) fail(`${name} is priced by the square foot: give its length and width in feet`);
      length = core.decimal(item.length, `${name}: length (feet)`, 2, 0.01, 999.99);
      width = core.decimal(item.width, `${name}: width (feet)`, 2, 0.01, 999.99);
      quantity = Number(money.areaOf(length, width, laundry.area_rounding));
      if (quantity <= 0 || quantity >= 1000) fail(`${name}: its area must be above nil and under 1,000 square feet`);
      pieces = c.given(item.pieces) ? whole(item.pieces, `${name}: pieces`, 1, 999) : Number(garment.pieces);
    } else {
      quantity = c.given(item.quantity) ? whole(item.quantity, `${name}: how many`, 1, 999) : 1;
      pieces = c.given(item.pieces) ? whole(item.pieces, `${name}: pieces`, 1, 999) : Math.min(999, quantity * Number(garment.pieces));
    }
    const base = money.baseOf(per, price, quantity);
    const surcharge = money.percentOf(base, expressPercent);
    // A package pays for what it still holds of the garment: kilos of a bundle, pieces of one by the piece.
    let packageId = null, covered = null, packageAmount = 0;
    if (item.packageId) {
      const bank = banks.find((p) => Number(p.id) === item.packageId);
      if (!bank) fail('Package not found', 404);
      if (bank.status !== 'active') fail(`Package ${bank.name} was cancelled`, 409);
      if (!bank.in_force) fail(`Package ${bank.name} runs from ${c.dateWords(bank.starts_on)} to ${c.dateWords(bank.ends_on)}: it is not in force today`, 409);
      if (!bank.service_ids.map(Number).includes(item.serviceId)) fail(`Package ${bank.name} does not cover ${service.label}`, 409);
      if (bank.unit === 'kg' ? per !== 'kg' : per !== 'item') fail(`Package ${bank.name} is of ${bank.unit === 'kg' ? 'kilos: it pays for a bundle by the kilo' : 'pieces: it pays for garments by the piece'}`, 409);
      const left = holds.get(Number(bank.id));
      const wanted = bank.unit === 'kg' ? Math.round(quantity * 1000) : pieces * 1000;
      const take = Math.min(left, wanted);
      if (take <= 0) fail(`Package ${bank.name} has nothing left`, 409);
      holds.set(Number(bank.id), left - take);
      packageId = Number(bank.id);
      covered = take / 1000;
      packageAmount = money.packageShare(base, covered, bank.unit === 'kg' ? quantity : pieces);
    }
    const offer = offers.find((o) => Number(o.sku_id) === Number(service.sku_id)) || null;
    return { ...item, garment, service, per, rate: price, source: rate !== null ? 'manual' : own ? own.source : 'list', overrideId: own ? Number(own.id) : null,
      quantity, pieces, length, width, base, surcharge, packageId, packageQuantity: covered, packageAmount, offer, taxRate: service.tax_rate };
  });
  // Offers: each within its least bill and its most a bill.
  const gross = lines.reduce((s, l) => s + l.base + l.surcharge - l.packageAmount, 0);
  for (const line of lines) {
    if (line.offer && gross < c.paise(line.offer.min_bill_amount)) line.offer = null;
    line.offerAmount = line.offer ? money.percentOf(line.base + line.surcharge - line.packageAmount, line.offer.value) : 0;
  }
  for (const offerId of new Set(lines.filter((l) => l.offer?.max_discount).map((l) => Number(l.offer.id)))) {
    const mine = lines.filter((l) => Number(l.offer?.id) === offerId);
    const cap = c.paise(mine[0].offer.max_discount);
    const total = mine.reduce((s, l) => s + l.offerAmount, 0);
    if (total > cap) money.split(cap, mine.map((l) => l.offerAmount)).forEach((part, i) => { mine[i].offerAmount = part; });
  }
  for (const line of lines) if (line.offer && line.offerAmount <= 0) line.offer = null;
  const priced = money.priceLines(lines.map((l) => ({ ...l, offerAmount: l.offerAmount })), discount, taxMode);
  if (priced.problem) {
    fail(priced.problem.order ? `The discount is more than the garments come to (${money.rupees(priced.problem.left)})`
      : `Garment ${priced.problem.index + 1}: the discount is more than it comes to (${money.rupees(priced.problem.left)})`, 409);
  }
  // Given by hand: by the discount permission, within the business's most discount on a bill (the owner, any).
  if (priced.manual > 0) {
    await access.require(business, 'sales.discount');
    const most = Number(settings?.max_bill_discount_percent ?? 10);
    const cap = Math.floor((priced.before * c.paise(most)) / 10000);
    if (!business.full_access && priced.manual > cap) {
      fail(`At most ${most}% of a bill (${money.rupees(cap)} on these garments) can be taken off. The owner can change this in Business settings.`, 409);
    }
  }
  const out = priced.lines.map((l) => ({ ...l, figures: { base: l.base, surcharge: l.surcharge, amount: l.amount, net: l.net, tax: l.tax } }));
  return { taxMode, items: out, figures: money.billFigures(out.map((l) => l.figures), settings?.rounding), manual: priced.manual, areaRounding: laundry.area_rounding };
}

// The promised day: the slowest garment's service days (or the shop's), on its open days, from the business's day.
async function promisedFor(db, business, items, express) {
  const laundry = await c.settingsOf(db, business.id);
  const day = await c.today(db, business);
  const days = Math.max(0, ...items.map((i) => {
    const own = express ? i.service.express_days : i.service.ready_days;
    return Number(own ?? (express ? laundry.express_days : laundry.ready_days));
  }));
  return { day, days, promisedOn: c.addOpenDays(day, days, laundry.closed_days) };
}

// A priced garment as the screens read it.
const pricedText = (p, index) => ({
  index, garmentTypeId: p.garmentTypeId, serviceId: p.serviceId, garmentName: p.garment.name, serviceName: p.service.label, countedAs: p.garment.counted_as,
  per: p.per, rate: Number(p.rate).toFixed(2), priceSource: p.source, quantity: p.per === 'kg' ? p.quantity.toFixed(3) : String(p.quantity), pieces: p.pieces,
  length: p.length === null ? null : p.length.toFixed(2), width: p.width === null ? null : p.width.toFixed(2), taxRate: p.service.tax_rate,
  base: money.rupees(p.base), surcharge: money.rupees(p.surcharge), packageId: p.packageId, packageQuantity: p.packageQuantity === null ? null : String(p.packageQuantity),
  packageAmount: money.rupees(p.packageAmount), offer: p.offer ? p.offer.name : null, offerAmount: money.rupees(p.offerAmount), discount: money.rupees(p.discountAmount),
  amount: money.rupees(p.amount), net: money.rupees(p.net), tax: money.rupees(p.tax),
});

// The columns a priced garment is kept with (the order, its place, its tag, and how it is billed are the caller's).
function garmentRow(p) {
  return {
    garment_type_id: p.garment.id, service_id: p.service.id, garment_name: p.garment.name, service_name: p.service.label, sku_id: p.service.sku_id, counted_as: p.garment.counted_as,
    per: p.per, quantity: p.per === 'kg' ? p.quantity.toFixed(3) : String(p.quantity), pieces: p.pieces, length_ft: p.length === null ? null : p.length.toFixed(2),
    width_ft: p.width === null ? null : p.width.toFixed(2), rate: Number(p.rate).toFixed(2), base: money.rupees(p.base), surcharge: money.rupees(p.surcharge),
    amount: money.rupees(p.amount), tax_rate: p.service.tax_rate, net: money.rupees(p.net), tax: money.rupees(p.tax), price_source: p.source, price_override_id: p.overrideId,
    package_id: p.packageId, package_quantity: p.packageQuantity === null ? null : p.packageQuantity.toFixed(3), package_amount: money.rupees(p.packageAmount),
    offer_id: p.offer ? p.offer.id : null, offer_name: p.offer ? p.offer.name : null, offer_percent: p.offer ? Number(p.offer.value).toFixed(2) : null,
    offer_amount: money.rupees(p.offerAmount), discount_amount: money.rupees(p.discountAmount),
  };
}

module.exports = { readDiscount, readItem, readGarments, packagesOf, priceGarments, promisedFor, pricedText, garmentRow };
