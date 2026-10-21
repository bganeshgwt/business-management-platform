const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const service = require('../../core/services/business.service');
const { RUNNING } = require('./businessOffers');

// Offers & discounts: setting them up, and what they gave away. How a sale
// picks them is in businessOffers.js. Changing or switching off an offer
// never changes a posted bill: each bill kept its own discount lines.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const KINDS = ['item_percent', 'item_amount', 'category_percent', 'bill_percent', 'bill_amount', 'buy_x_get_y', 'product_percent'];
const PERCENT = new Set(['item_percent', 'category_percent', 'bill_percent', 'buy_x_get_y', 'product_percent']);
const optional = (value) => value === undefined || value === null || value === '';

function readTime(value, name) {
  if (optional(value)) return null;
  const text = String(value);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) fail(`${name} must be a time such as 18:30`);
  return text;
}

async function readOffer(db, business, body, offerId = null) {
  const kind = v.requiredEnum(body.kind, 'Offer type', KINDS);
  const value = service.decimal(body.value, PERCENT.has(kind) ? 'Discount %' : 'Discount amount', 2, 0.01, PERCENT.has(kind) ? 100 : 10000000);
  let skuId = null, categoryId = null, productId = null, buy = null, get = null;
  if (kind === 'product_percent') {
    // A markdown on one style: every size and colour (fashion pro pass).
    const product = await repo.one(db, "SELECT id FROM catalog_products WHERE business_id=$1 AND id=$2 AND kind='goods'", [business.id, id(body.productId, 'Product')]);
    if (!product) fail('Product not found', 404);
    productId = product.id;
  }
  if (['item_percent', 'item_amount', 'buy_x_get_y'].includes(kind)) {
    const sku = await repo.one(db, `SELECT s.id,u.decimals FROM catalog_skus s JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
      WHERE s.business_id=$1 AND s.id=$2`, [business.id, id(body.skuId, 'Item')]);
    if (!sku) fail('Item not found', 404);
    skuId = sku.id;
    if (kind === 'buy_x_get_y') {
      buy = service.decimal(body.buyQuantity, 'Buy quantity', 3, 0.001, 100000);
      get = service.decimal(body.getQuantity, 'Free (or cheaper) quantity', 3, 0.001, 100000);
      if (sku.decimals === 0 && (!Number.isInteger(buy) || !Number.isInteger(get))) fail('This item is sold in whole units: buy and get quantities must be whole numbers');
    }
  }
  if (kind === 'category_percent') {
    const category = await repo.one(db, 'SELECT id FROM catalog_categories WHERE business_id=$1 AND id=$2', [business.id, id(body.categoryId, 'Category')]);
    if (!category) fail('Category not found', 404);
    categoryId = category.id;
  }
  const startsOn = service.dateText(body.startsOn, 'Start date');
  const endsOn = optional(body.endsOn) ? null : service.dateText(body.endsOn, 'End date');
  if (endsOn && endsOn < startsOn) fail('The offer ends before it starts');
  let days = null;
  if (!optional(body.daysOfWeek)) {
    days = [...new Set(v.requiredArray(body.daysOfWeek, 'Days of the week').map(Number))].sort();
    if (!days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) fail('Choose days of the week from Monday to Sunday');
    if (days.length === 7) days = null;
  }
  const startsTime = readTime(body.startsTime, 'Start time'), endsTime = readTime(body.endsTime, 'End time');
  if ((startsTime === null) !== (endsTime === null)) fail('Give both a start and an end time, or neither');
  if (startsTime && startsTime === endsTime) fail('The start and end times are the same');
  // A coupon: the offer applies only when its code is given at the counter,
  // at most usageLimit bills in all and perCustomerLimit per customer.
  const couponText = optional(body.couponCode) ? null : String(body.couponCode).trim().toUpperCase();
  if (couponText && !/^[A-Z0-9-]{3,20}$/.test(couponText)) fail('A coupon code is 3 to 20 letters, digits or dashes');
  const limit = (raw, name) => (optional(raw) ? null : v.requiredId(raw, name));
  const usageLimit = limit(body.usageLimit, 'Uses in all'), perCustomerLimit = limit(body.perCustomerLimit, 'Uses per customer');
  if (!couponText && (usageLimit || perCustomerLimit)) fail('Use limits are for coupons: give a coupon code');
  if (couponText) {
    const taken = await repo.one(db, 'SELECT id FROM retail_offers WHERE business_id=$1 AND coupon_code=$2 AND ($3::bigint IS NULL OR id<>$3)', [business.id, couponText, offerId]);
    if (taken) fail(`Coupon code ${couponText} is used by another offer`, 409);
  }
  return {
    couponCode: couponText, usageLimit, perCustomerLimit,
    name: v.requiredString(body.name, 'Offer name', 120), kind, skuId, categoryId, productId, value, buy, get,
    minBill: optional(body.minBillAmount) ? 0 : service.decimal(body.minBillAmount, 'Minimum bill', 2, 0, 100000000),
    maxDiscount: optional(body.maxDiscount) ? null : service.decimal(body.maxDiscount, 'Most per bill', 2, 0.01, 100000000),
    startsOn, endsOn, days, startsTime, endsTime, active: v.requiredBoolean(body.active, 'Active', true),
  };
}
const values = (business, f) => [business.id, f.name, f.kind, f.skuId, f.categoryId, f.value, f.buy, f.get, f.minBill, f.maxDiscount, f.startsOn, f.endsOn, f.days, f.startsTime, f.endsTime, f.active, f.productId,
  f.couponCode, f.usageLimit, f.perCustomerLimit];

async function createOffer(business, user, body) {
  await access.require(business, 'offers.create');
  return repo.transaction(async (db) => {
    const f = await readOffer(db, business, body);
    const row = await repo.one(db, `INSERT INTO retail_offers(business_id,name,kind,sku_id,category_id,value,buy_quantity,get_quantity,min_bill_amount,max_discount,
      starts_on,ends_on,days_of_week,starts_time,ends_time,active,product_id,coupon_code,usage_limit,per_customer_limit,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21) RETURNING *`, [...values(business, f), user.id]);
    await repo.audit(db, business.id, user.id, 'offer.created', row.id, { name: row.name, kind: row.kind, value: row.value });
    return row;
  });
}
async function updateOffer(business, user, offerId, body) {
  await access.require(business, 'offers.edit');
  return repo.transaction(async (db) => {
    const current = await repo.one(db, 'SELECT * FROM retail_offers WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(offerId, 'Offer')]);
    if (!current) fail('Offer not found', 404);
    // Switching on or off alone keeps everything else as it was.
    const onlySwitch = Object.keys(body).every((k) => k === 'active');
    const f = onlySwitch ? null : await readOffer(db, business, body, current.id);
    const row = onlySwitch
      ? await repo.one(db, 'UPDATE retail_offers SET active=$3,updated_by=$4,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *',
        [business.id, current.id, v.requiredBoolean(body.active, 'Active'), user.id])
      : await repo.one(db, `UPDATE retail_offers SET name=$2,kind=$3,sku_id=$4,category_id=$5,value=$6,buy_quantity=$7,get_quantity=$8,min_bill_amount=$9,
        max_discount=$10,starts_on=$11,ends_on=$12,days_of_week=$13,starts_time=$14,ends_time=$15,active=$16,product_id=$17,
        coupon_code=$18,usage_limit=$19,per_customer_limit=$20,updated_by=$22,updated_at=now()
        WHERE business_id=$1 AND id=$21 RETURNING *`, [...values(business, f), current.id, user.id]);
    await repo.audit(db, business.id, user.id, 'offer.updated', row.id, { name: row.name, active: row.active, ...(onlySwitch ? {} : { kind: row.kind, value: row.value }) });
    return row;
  });
}

// What offers and points gave away in a period, by offer.
async function givenAway(business, query) {
  await access.require(business, 'offers.view');
  await access.require(business, 'sales.view');
  const from = service.dateText(query.from, 'Start date'), to = service.dateText(query.to, 'End date');
  if (to < from) fail('The end date is before the start date');
  const rows = await repo.all(repo.pool, `SELECT COALESCE(x.offer_id::text,'points') AS key,x.offer_id,max(x.label) AS label,x.source,
      count(DISTINCT x.document_id)::int AS bills,sum(x.amount) AS given,
      sum(l.net+l.tax) AS sold_after
    FROM retail_sale_discounts x JOIN business_documents d ON d.business_id=x.business_id AND d.id=x.document_id
    JOIN business_document_lines l ON l.business_id=x.business_id AND l.id=x.line_id
    WHERE x.business_id=$1 AND (d.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
    GROUP BY x.offer_id,x.source ORDER BY sum(x.amount) DESC`, [business.id, from, to, business.timezone]);
  const totals = await repo.one(repo.pool, `SELECT count(*)::int AS bills,COALESCE(sum(total),0) AS sales,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM retail_sale_discounts x WHERE x.business_id=d.business_id AND x.document_id=d.id))::int AS bills_with_offers
    FROM business_documents d WHERE d.business_id=$1 AND d.kind='sale' AND (d.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date`,
  [business.id, from, to, business.timezone]);
  return { from, to, rows, totals };
}

repo.addLists({
  offers: {
    sql: `SELECT o.*,s.label AS sku_label,cat.name AS category_name,(SELECT name FROM catalog_products p WHERE p.business_id=o.business_id AND p.id=o.product_id) AS product_name,
      CASE WHEN NOT o.active THEN 'off'
        WHEN o.starts_on > (now() AT TIME ZONE b.timezone)::date THEN 'scheduled'
        WHEN o.ends_on IS NOT NULL AND o.ends_on < (now() AT TIME ZONE b.timezone)::date THEN 'ended'
        WHEN ${RUNNING} THEN 'running' ELSE 'waiting' END AS status,
      COALESCE((SELECT sum(x.amount) FROM retail_sale_discounts x WHERE x.business_id=o.business_id AND x.offer_id=o.id),0) AS given,
      (SELECT count(DISTINCT x.document_id)::int FROM retail_sale_discounts x WHERE x.business_id=o.business_id AND x.offer_id=o.id) AS bills
      FROM retail_offers o JOIN businesses b ON b.id=o.business_id
      LEFT JOIN catalog_skus s ON s.business_id=o.business_id AND s.id=o.sku_id
      LEFT JOIN catalog_categories cat ON cat.business_id=o.business_id AND cat.id=o.category_id WHERE o.business_id=$1`,
    search: ['name', 'sku_label', 'category_name', 'coupon_code'], filters: { status: 'status', kind: 'kind' },
    order: "CASE status WHEN 'running' THEN 0 WHEN 'waiting' THEN 1 WHEN 'scheduled' THEN 2 WHEN 'off' THEN 3 ELSE 4 END,id DESC",
  },
});

module.exports = { createOffer, updateOffer, givenAway, KINDS };
