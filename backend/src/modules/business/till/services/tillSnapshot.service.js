const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const devices = require('./tillDevices.service');

// What an offline till keeps so it can bill with no network
// (docs/ARCHITECTURE.md › How an offline bill is posted): fetched about every
// five minutes while the till reaches the server, and on demand.
//
//   items       what may be sold at this counter offline: codes, barcodes, a
//               book's ISBN, the weighing-scale code, the unit and its packs,
//               the walk-in price here (this branch's own, else the list
//               price), the member price, the MRP, the GST rate in force today
//               with every change already dated, the HSN, the tracking, and
//               whether GST by price applies (a clothes shop)
//   excluded    items the till may not sell offline, with why: serial-
//               numbered items (each unit is chosen online), kits (priced by
//               their parts), items kept for use in services
//   customers   name, phone, GSTIN, PAN, credit limit and days, balance
//   methods     the payment methods switched on
//   rules       a wholesale price list's prices (when the shop keeps one)
//   settings    tax mode, rounding, walk-in credit, the counter discount limit,
//               the PIN rule, the cash limit, the financial year's start,
//               whether e-invoicing applies, the till's limits and UPI ID
//   seller      the receipt's business and branch details
//
// Items and customers come with a stamp (a hash of what they hold): a till
// that sends back the stamps it has is told "unchanged" instead of being sent
// them again, and gets only the balances that moved since its last snapshot.

const CASH_LIMIT = '200000.00';
const stampOf = (rows) => crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 32);
const iso = (value) => (value ? new Date(value).toISOString() : null);

async function items(db, business, locationId) {
  const rows = await repo.all(db, `SELECT s.id,s.code,s.barcode,s.label,s.product_id,p.name AS product_name,s.unit,s.price AS list_price,lp.price AS branch_price,
      s.member_price,s.mrp,s.tax_rate,s.hsn_code,s.tracking,s.is_kit,s.internal_use,
      (SELECT plu_code FROM retail_scale_items x WHERE x.business_id=s.business_id AND x.sku_id=s.id) AS plu,
      (SELECT isbn FROM books_titles t WHERE t.business_id=s.business_id AND t.sku_id=s.id) AS isbn,
      COALESCE((SELECT json_agg(json_build_object('unit',k.unit_code,'quantity',k.quantity_in_base) ORDER BY k.quantity_in_base)
        FROM catalog_sku_units k WHERE k.business_id=s.business_id AND k.sku_id=s.id AND k.active),'[]') AS packs,
      COALESCE((SELECT json_agg(json_build_object('startsOn',i.starts_on::text,'rate',x.rate) ORDER BY i.starts_on)
        FROM business_tax_change_items i JOIN business_tax_changes x ON x.business_id=i.business_id AND x.id=i.change_id
        WHERE i.business_id=s.business_id AND i.sku_id=s.id AND i.status='scheduled'),'[]') AS changes
    FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    LEFT JOIN business_sku_location_prices lp ON lp.business_id=s.business_id AND lp.sku_id=s.id AND lp.location_id=$2
    WHERE s.business_id=$1 AND s.active AND p.active AND p.kind='goods'
    ORDER BY s.id`, [business.id, locationId]);
  // GST by price (a clothes shop): which items it covers.
  const slab = business.business_type === 'fashion' ? await repo.one(db, 'SELECT * FROM fashion_gst_price_slabs WHERE business_id=$1', [business.id]) : null;
  const covered = slab?.active ? new Set((await repo.all(db, `WITH RECURSIVE up AS (
      SELECT s.id AS sku_id,p.category_id,1 AS depth FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      WHERE s.business_id=$1 AND p.category_id IS NOT NULL
      UNION ALL SELECT up.sku_id,c.parent_id,up.depth+1 FROM up JOIN catalog_categories c ON c.business_id=$1 AND c.id=up.category_id
      WHERE c.parent_id IS NOT NULL AND up.depth<6)
    SELECT sku_id FROM up WHERE category_id=ANY($2::bigint[])
    UNION SELECT sku_id FROM fashion_variants WHERE business_id=$1`, [business.id, slab.category_ids])).map((r) => Number(r.sku_id))) : new Set();
  const sellable = [], excluded = [];
  for (const row of rows) {
    const why = row.tracking === 'serial' ? 'serial' : row.is_kit ? 'kit' : row.internal_use ? 'internal' : null;
    if (why) {
      excluded.push({ id: Number(row.id), code: row.code, barcode: row.barcode, isbn: row.isbn, label: row.label, reason: why });
      continue;
    }
    sellable.push({
      id: Number(row.id), code: row.code, barcode: row.barcode, isbn: row.isbn, plu: row.plu, label: row.label, productId: Number(row.product_id), productName: row.product_name,
      unit: row.unit, listPrice: row.list_price, branchPrice: row.branch_price, memberPrice: row.member_price, mrp: row.mrp, taxRate: row.tax_rate,
      changes: row.changes, hsn: row.hsn_code, tracking: row.tracking, packs: row.packs, slab: covered.has(Number(row.id)),
    });
  }
  return { rows: sellable, excluded };
}

async function customers(db, business) {
  return (await repo.all(db, `SELECT c.id,c.name,c.phone,c.gstin,c.pan,c.address,c.credit_limit,c.credit_days FROM business_contacts c
    WHERE c.business_id=$1 AND c.kind='customer' AND c.active AND c.erased_at IS NULL ORDER BY c.id`, [business.id]))
    .map((row) => ({ id: Number(row.id), name: row.name, phone: row.phone, gstin: row.gstin, pan: row.pan, address: row.address,
      creditLimit: row.credit_limit, creditDays: Number(row.credit_days) }));
}

// Balances of every customer, or of those whose money moved since a moment
// (bills, payments, returns, refunds, receipts and their refunds, bounced
// cheques, a changed opening balance, and offline bills received since,
// whatever their own time).
async function balances(db, business, since) {
  const ids = since ? `AND c.id IN (
      SELECT contact_id FROM business_documents WHERE business_id=$1 AND contact_id IS NOT NULL AND created_at>=$2
      UNION SELECT d.contact_id FROM business_payments p JOIN business_documents d ON d.business_id=p.business_id AND d.id=p.document_id WHERE p.business_id=$1 AND p.created_at>=$2
      UNION SELECT d.contact_id FROM business_returns r JOIN business_documents d ON d.business_id=r.business_id AND d.id=r.document_id WHERE r.business_id=$1 AND r.created_at>=$2
      UNION SELECT d.contact_id FROM business_refunds f JOIN business_documents d ON d.business_id=f.business_id AND d.id=f.document_id WHERE f.business_id=$1 AND f.created_at>=$2
      UNION SELECT contact_id FROM business_collections WHERE business_id=$1 AND created_at>=$2
      UNION SELECT contact_id FROM business_collection_refunds WHERE business_id=$1 AND created_at>=$2
      UNION SELECT contact_id FROM business_collection_cheques WHERE business_id=$1 AND bounced_at>=$2
      UNION SELECT d.contact_id FROM business_till_bills b JOIN business_documents d ON d.business_id=b.business_id AND d.id=b.document_id WHERE b.business_id=$1 AND b.received_at>=$2
      UNION SELECT id FROM business_contacts WHERE business_id=$1 AND updated_at>=$2)` : '';
  const rows = await repo.all(db, `SELECT c.id,${repo.contactBalanceSql('c')} AS balance FROM business_contacts c
    WHERE c.business_id=$1 AND c.kind='customer' AND c.active AND c.erased_at IS NULL ${ids}`, since ? [business.id, since] : [business.id]);
  return rows.map((row) => ({ id: Number(row.id), balance: Number(row.balance).toFixed(2) }));
}

// Whether e-invoicing applies to the business now (its PAN's turnover last
// year, modules/gst-thresholds): a bill to a GSTIN holder then needs the IRP.
async function einvoicing(business) {
  try {
    const thresholds = require('../../../gst-thresholds/services/gstThresholds.service');
    const rules = require('../../../gst-thresholds/services/gstThresholdsRules');
    const standing = await thresholds.standingOf(business.id);
    return Boolean(standing.linked && rules.applying(standing.steps, 'e_invoicing')?.now);
  } catch {
    return false;
  }
}

function readSince(value) {
  if (value === undefined || value === null || value === '') return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

async function snapshot(business, user, query, token) {
  await access.require(business, 'sales.create');
  devices.requireModule(business);
  const since = readSince(query.since);
  const read = await repo.transaction(async (db) => {
    // One reading of the whole snapshot, as of one moment.
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const device = await devices.fromToken(db, business, token);
    const at = await repo.one(db, 'SELECT now() AS now, (now() AT TIME ZONE $1)::date::text AS today', [business.timezone]);
    const settings = await repo.one(db, 'SELECT * FROM business_settings WHERE business_id=$1', [business.id]);
    const location = await repo.one(db, 'SELECT * FROM business_locations WHERE business_id=$1 AND id=$2', [business.id, device.location_id]);
    const tillSettings = await devices.settings(db, business.id);
    const units = await repo.all(db, 'SELECT code,name,kind,decimals,base_unit_code,factor_to_base FROM business_units WHERE business_id=$1 ORDER BY code', [business.id]);
    const methods = await repo.all(db, 'SELECT id,name,kind FROM business_payment_methods WHERE business_id=$1 AND active ORDER BY sort_order,id', [business.id]);
    const goods = await items(db, business, device.location_id);
    const people = await customers(db, business);
    const rules = business.capabilities.includes('wholesale') ? await repo.all(db, `SELECT sku_id,contact_id,unit_code,minimum_quantity,unit_price FROM business_price_rules
      WHERE business_id=$1 AND active ORDER BY id`, [business.id]) : [];
    const slab = business.business_type === 'fashion' ? await repo.one(db, 'SELECT * FROM fashion_gst_price_slabs WHERE business_id=$1 AND active', [business.id]) : null;
    const slabChanges = slab ? await repo.all(db, `SELECT starts_on::text AS starts_on,threshold,rate_low,rate_high FROM business_tax_setting_changes
      WHERE business_id=$1 AND setting='fashion_price' AND status='scheduled' ORDER BY starts_on`, [business.id]) : [];
    const sameItems = query.items && query.items === stampOf(goods);
    const sameCustomers = query.customers && query.customers === stampOf(people);
    const money = await balances(db, business, sameCustomers && since ? since : null);
    return { device, at, settings, location, tillSettings, units, methods, goods, people, rules, slab, slabChanges, sameItems, sameCustomers, money };
  });
  const { device, at, settings, location, tillSettings, units, methods, goods, people, rules, slab, slabChanges, sameItems, sameCustomers, money } = read;
  return {
    serverTime: iso(at.now), today: at.today, since,
    till: { id: Number(device.id), code: device.code, name: device.name, locationId: Number(device.location_id), registeredAt: iso(device.registered_at) },
    business: { id: Number(business.id), name: business.name, type: business.business_type, timezone: business.timezone },
    settings: {
      taxMode: settings?.tax_mode || 'exclusive', rounding: settings?.rounding || 'none', walkInCredit: Boolean(settings?.walk_in_credit),
      maxDiscountPercent: Number(settings?.max_bill_discount_percent ?? 10), pinEveryBill: Boolean(settings?.counter_pin_every_bill),
      fiscalYearStartMonth: Number(settings?.fiscal_year_start_month || 4), cashLimit: CASH_LIMIT, panAbove: CASH_LIMIT,
      memberPrices: business.capabilities.includes('loyalty'), einvoicing: await einvoicing(business),
      weightButtons: settings?.weight_buttons_grams || null, receiptWidth: settings?.receipt_width_mm || 80, ...devices.settingsShape(tillSettings),
    },
    seller: { ...core.branchSeller(settings || {}, location), location_name: location.name },
    location: { id: Number(location.id), name: location.name, code: location.code, stateCode: location.state_code || settings?.state_code || null },
    units: units.map((u) => ({ code: u.code, name: u.name, kind: u.kind, decimals: Number(u.decimals), base: u.base_unit_code, factor: u.factor_to_base })),
    methods: methods.map((m) => ({ id: Number(m.id), name: m.name, kind: m.kind })),
    rules: rules.map((r) => ({ skuId: Number(r.sku_id), contactId: r.contact_id === null ? null : Number(r.contact_id), unit: r.unit_code, minimum: r.minimum_quantity, price: r.unit_price })),
    slab: slab ? { threshold: slab.threshold, rateLow: slab.rate_low, rateHigh: slab.rate_high,
      changes: slabChanges.map((c) => ({ startsOn: c.starts_on, threshold: c.threshold, rateLow: c.rate_low, rateHigh: c.rate_high })) } : null,
    items: sameItems ? { stamp: query.items, unchanged: true } : { stamp: stampOf(goods), rows: goods.rows, excluded: goods.excluded },
    customers: sameCustomers ? { stamp: query.customers, unchanged: true, balances: money } : { stamp: stampOf(people), rows: people, balances: money },
  };
}

module.exports = { snapshot, stampOf, einvoicing };
