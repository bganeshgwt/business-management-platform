const repo = require('../../core/repositories/business.repository');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');

// Offers and loyalty points on a sale, worked out by the server inside the
// posting transaction (business.service.js › document). Retail modules
// `offers` and `loyalty`; nothing here runs for a business without them.
//
// The rule, in the order it is applied (docs/BUSINESS_PLATFORM_DATA_MODEL.md
// › Retail):
//  1. Only offers running now count: switched on, within their dates, on
//     today's weekday and inside their daily time window (business time zone),
//     and the bill before any discount reaches their minimum.
//  2. Each item gets at most ONE item offer — the one worth most to the
//     customer among: % off the item, ₹ off each unit, % off its category (or
//     a parent category), buy X get Y. Lines of the same item are taken
//     together (buy 2 get 1 works across two scans).
//  3. Then at most ONE bill offer (% or ₹ off the bill), the one worth most,
//     on what is left after item offers.
//  4. Then loyalty points the customer chose to redeem, up to the business's
//     limit, worth their value off what the customer pays.
//  5. An offer's "most per bill" cap holds across all items it applies to.
// Discounts are spread over lines in proportion to their value, with the
// rounding carried forward so the shares add up to the paisa. They reduce the
// taxable value (a discount given at the time of sale), so GST follows them.
// Amounts on offers are in the same terms as the selling prices (including
// GST when the business's prices include GST, before GST otherwise); points
// are worth their value off the bill total either way.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const paise = (number) => Math.round(Number(number) * 100);
const milli = (number) => Math.round(Number(number) * 1000);
const money = (value) => (value / 100).toFixed(2);
const divide = (numerator, denominator) => Number((numerator + denominator / 2n) / denominator);
const sum = (values) => values.reduce((total, value) => total + value, 0);

// total split over weights in proportion, cumulative rounding: exact sum.
function split(total, weights) {
  const whole = sum(weights);
  if (!whole || !total) return weights.map(() => 0);
  let given = 0, running = 0;
  return weights.map((weight) => {
    running += weight;
    const upto = divide(BigInt(total) * BigInt(running), BigInt(whole));
    const part = upto - given;
    given = upto;
    return part;
  });
}

// Offers running at this moment, in the business's own time zone.
const RUNNING = `o.active
  AND o.starts_on <= (now() AT TIME ZONE b.timezone)::date
  AND (o.ends_on IS NULL OR o.ends_on >= (now() AT TIME ZONE b.timezone)::date)
  AND (o.days_of_week IS NULL OR extract(isodow FROM now() AT TIME ZONE b.timezone)::smallint = ANY(o.days_of_week))
  AND (o.starts_time IS NULL OR CASE WHEN o.starts_time < o.ends_time
    THEN (now() AT TIME ZONE b.timezone)::time >= o.starts_time AND (now() AT TIME ZONE b.timezone)::time < o.ends_time
    ELSE (now() AT TIME ZONE b.timezone)::time >= o.starts_time OR (now() AT TIME ZONE b.timezone)::time < o.ends_time END)`;

const runningOffers = (db, businessId) => repo.all(db, `SELECT o.* FROM retail_offers o JOIN businesses b ON b.id=o.business_id
  WHERE o.business_id=$1 AND ${RUNNING} ORDER BY o.id`, [businessId]);

// Each SKU's category and every category above it.
async function categoryPaths(db, businessId, skuIds) {
  const rows = await repo.all(db, `WITH RECURSIVE up AS (
      SELECT s.id AS sku_id,p.category_id,1 AS depth FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      WHERE s.business_id=$1 AND s.id=ANY($2::bigint[]) AND p.category_id IS NOT NULL
      UNION ALL SELECT up.sku_id,c.parent_id,up.depth+1 FROM up JOIN catalog_categories c ON c.business_id=$1 AND c.id=up.category_id
      WHERE c.parent_id IS NOT NULL AND up.depth<6)
    SELECT sku_id,array_agg(category_id) AS categories FROM up GROUP BY sku_id`, [businessId, skuIds]);
  return new Map(rows.map((r) => [Number(r.sku_id), r.categories.map(Number)]));
}

const percentOf = (amount, percent) => divide(BigInt(amount) * BigInt(paise(percent)), 10000n);

// What one item offer is worth on one item (all its lines on this bill).
function itemDiscount(offer, group, categories) {
  const skuMatches = Number(offer.sku_id) === group.skuId;
  switch (offer.kind) {
    case 'item_percent': return skuMatches ? percentOf(group.amount, offer.value) : 0;
    case 'item_amount': return skuMatches ? Math.min(group.amount, divide(BigInt(paise(offer.value)) * BigInt(group.quantity), 1000n)) : 0;
    case 'category_percent': return (categories.get(group.skuId) || []).includes(Number(offer.category_id)) ? percentOf(group.amount, offer.value) : 0;
    // A markdown on a whole style (fashion): every size and colour of the product.
    case 'product_percent': return Number(offer.product_id) === group.productId ? percentOf(group.amount, offer.value) : 0;
    case 'buy_x_get_y': {
      if (!skuMatches) return 0;
      const set = milli(offer.buy_quantity) + milli(offer.get_quantity);
      const free = Math.floor(group.quantity / set) * milli(offer.get_quantity);
      if (!free) return 0;
      return Math.min(group.amount, divide(BigInt(group.amount) * BigInt(free) * BigInt(paise(offer.value)), BigInt(group.quantity) * 10000n));
    }
    default: return 0;
  }
}

async function loyaltySettings(db, businessId) {
  return repo.one(db, 'SELECT * FROM retail_loyalty_settings WHERE business_id=$1', [businessId]);
}
// Points a customer holds now: the plain sum of their entries. Returns take
// points back as entries of their own (reverseForReturn), so the sum is the
// truth and a database trigger keeps it from ever going below zero.
const BALANCE_SQL = 'COALESCE(sum(e.points),0)::int';
async function pointsBalance(db, businessId, contactId) {
  const row = await repo.one(db, `SELECT ${BALANCE_SQL} AS balance FROM retail_loyalty_entries e
    WHERE e.business_id=$1 AND e.contact_id=$2`, [businessId, contactId]);
  return Number(row.balance);
}

// Goods back from a sale take back the points that sale earned, in
// proportion to the value returned so far (cumulative, so a sale returned in
// parts gives back exactly what it earned). Inside the return's own
// transaction, after the business and the sale are locked; the customer is
// locked here, as a sale does, so a redemption or correction cannot run in
// between. Points come off what the customer holds, never below zero; what
// was already spent is the shortfall, valued at the point value and held
// back from any refund on that sale (heldBack).
async function reverseForReturn(db, business, user, doc, saved) {
  if (doc.kind !== 'sale' || !doc.contact_id) return null;
  const earn = await repo.one(db, "SELECT * FROM retail_loyalty_entries WHERE business_id=$1 AND document_id=$2 AND kind='earn'", [business.id, doc.id]);
  if (!earn) return null;
  await db.query('SELECT id FROM business_contacts WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, doc.contact_id]);
  const sums = await repo.one(db, `SELECT
    COALESCE((SELECT sum(total) FROM business_returns WHERE business_id=$1 AND document_id=$2),0) AS returned,
    COALESCE((SELECT sum(-points+shortfall_points) FROM retail_loyalty_entries WHERE business_id=$1 AND document_id=$2 AND kind='reverse'),0)::int AS reversed`,
  [business.id, doc.id]);
  const total = paise(doc.total), returned = Math.min(total, paise(sums.returned));
  const keep = total > 0 ? Number((BigInt(earn.points) * BigInt(total - returned)) / BigInt(total)) : 0;
  const due = earn.points - keep - Number(sums.reversed);
  if (due <= 0) return null;
  const held = await pointsBalance(db, business.id, doc.contact_id);
  const take = Math.min(due, Math.max(0, held));
  const shortfall = due - take;
  const settings = await loyaltySettings(db, business.id);
  const value = shortfall * paise(settings?.point_value || 0);
  const entry = await repo.one(db, `INSERT INTO retail_loyalty_entries(business_id,contact_id,kind,points,document_id,return_id,shortfall_points,shortfall_value,reason,created_by)
    VALUES($1,$2,'reverse',$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [business.id, doc.contact_id, -take, doc.id, saved.id, shortfall, money(value),
    shortfall ? `Goods returned on ${saved.return_no || doc.document_no}: ${shortfall} points were already spent` : `Goods returned on ${saved.return_no || doc.document_no}`, user.id]);
  await repo.event(db, business.id, user.id, 'loyalty.reversed', 'loyalty_entry', entry.id,
    { contactId: doc.contact_id, documentId: doc.id, returnId: saved.id, points: take, shortfallPoints: shortfall, shortfallValue: money(value) });
  return entry;
}
// Points the customer spent on a sale come back when goods on that sale are
// returned (Loyalty rules › "Give back spent points on
// returns", on by default): the redeemed points times the share of the bill's
// value returned so far, cumulative, so a bill returned in parts gives back
// exactly what was spent once everything is back. The goods' refund is what
// the customer paid after the points, so nothing is paid twice.
async function restoreForReturn(db, business, user, doc, saved) {
  if (doc.kind !== 'sale' || !doc.contact_id) return null;
  const redeem = await repo.one(db, "SELECT * FROM retail_loyalty_entries WHERE business_id=$1 AND document_id=$2 AND kind='redeem'", [business.id, doc.id]);
  if (!redeem) return null;
  const settings = await loyaltySettings(db, business.id);
  if (settings && settings.return_spent_points === false) return null;
  await db.query('SELECT id FROM business_contacts WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, doc.contact_id]);
  const sums = await repo.one(db, `SELECT
    COALESCE((SELECT sum(total) FROM business_returns WHERE business_id=$1 AND document_id=$2),0) AS returned,
    COALESCE((SELECT sum(points) FROM retail_loyalty_entries WHERE business_id=$1 AND document_id=$2 AND kind='restore'),0)::int AS restored`,
  [business.id, doc.id]);
  const spent = -Number(redeem.points);
  const total = paise(doc.total), returned = Math.min(total, paise(sums.returned));
  const upto = total > 0 ? Number((BigInt(spent) * BigInt(returned)) / BigInt(total)) : spent;
  const due = (returned >= total ? spent : upto) - Number(sums.restored);
  if (due <= 0) return null;
  const value = Number((BigInt(paise(redeem.value)) * BigInt(due)) / BigInt(spent));
  const entry = await repo.one(db, `INSERT INTO retail_loyalty_entries(business_id,contact_id,kind,points,document_id,return_id,value,reason,created_by)
    VALUES($1,$2,'restore',$3,$4,$5,$6,$7,$8) RETURNING *`, [business.id, doc.contact_id, due, doc.id, saved.id, money(Math.max(1, value)),
    `Points spent on ${doc.document_no} given back: goods returned on ${saved.return_no || doc.document_no}`, user.id]);
  await repo.event(db, business.id, user.id, 'loyalty.restored', 'loyalty_entry', entry.id,
    { contactId: doc.contact_id, documentId: doc.id, returnId: saved.id, points: due, value: entry.value });
  return entry;
}
// What a refund on this sale must keep back for points already spent (paise).
async function heldBack(db, businessId, documentId) {
  const row = await repo.one(db, "SELECT COALESCE(sum(shortfall_value),0) AS held FROM retail_loyalty_entries WHERE business_id=$1 AND document_id=$2 AND kind='reverse'", [businessId, documentId]);
  return paise(row.held);
}
const earnedPoints = (settings, totalPaise) => (settings && settings.active
  ? Math.floor(totalPaise / paise(settings.earn_per_amount)) * Number(settings.earn_points) : 0);

// A small discount the counter gives on this bill ("₹5 kam kar do"): an
// amount or a percent of what the customer pays, with a reason.
function readManualDiscount(body) {
  if (body.discount === undefined || body.discount === null) return null;
  if (typeof body.discount !== 'object' || Array.isArray(body.discount)) fail('Discount must be an object');
  const { amount, percent } = body.discount;
  const has = (value) => value !== undefined && value !== null && String(value).trim() !== '' && Number(value) !== 0;
  if (!has(amount) && !has(percent)) return null;
  if (has(amount) && has(percent)) fail('Give the discount as an amount or a percent, not both');
  const text = String(has(amount) ? amount : percent).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) fail('The discount must be a positive number with at most 2 decimal places');
  if (has(percent) && Number(text) > 100) fail('A discount cannot be more than 100%');
  const reason = String(body.discount.reason ?? '').trim();
  if (!reason) fail('Say why the discount is given (for example "regular customer")');
  if (reason.length > 120) fail('Keep the discount reason under 120 characters');
  return has(amount) ? { amount: paise(text), reason } : { percent: Number(text), reason };
}

// A coupon code typed at the counter ("DIWALI100"), or null.
function readCoupon(body) {
  if (body.coupon === undefined || body.coupon === null || String(body.coupon).trim() === '') return null;
  const code = String(body.coupon).trim().toUpperCase();
  if (!/^[A-Z0-9-]{3,20}$/.test(code)) fail('A coupon code is 3 to 20 letters, digits or dashes');
  return code;
}

// The coupon's offer if it may be used on this bill now; refuses with the
// reason otherwise. Locks the offer so two bills cannot both take its last use.
async function couponOffer(db, business, code, contact, grossBill, running) {
  const offer = await repo.one(db, 'SELECT * FROM retail_offers WHERE business_id=$1 AND coupon_code=$2 FOR UPDATE', [business.id, code]);
  if (!offer) fail(`There is no coupon ${code}`, 404);
  const live = running.find((o) => Number(o.id) === Number(offer.id));
  if (!live) fail(`Coupon ${code} cannot be used now (switched off, outside its dates or hours)`, 409);
  if (grossBill < paise(offer.min_bill_amount)) fail(`Coupon ${code} needs a bill of at least ${money(paise(offer.min_bill_amount))}`, 409);
  if (offer.per_customer_limit && !contact) fail(`Coupon ${code} is limited per customer: choose the customer first`, 409);
  if (offer.usage_limit || offer.per_customer_limit) {
    const used = await repo.one(db, `SELECT count(DISTINCT x.document_id)::int AS total,
        count(DISTINCT x.document_id) FILTER (WHERE d.contact_id=$3)::int AS mine
      FROM retail_sale_discounts x JOIN business_documents d ON d.business_id=x.business_id AND d.id=x.document_id
      WHERE x.business_id=$1 AND x.offer_id=$2`, [business.id, offer.id, contact?.id || null]);
    if (offer.usage_limit && used.total >= offer.usage_limit) fail(`Coupon ${code} has been used up (${offer.usage_limit} bills)`, 409);
    if (offer.per_customer_limit && used.mine >= offer.per_customer_limit) fail(`${contact.name} has already used coupon ${code} ${used.mine === 1 ? 'once' : `${used.mine} times`}`, 409);
  }
  return live;
}

function readRedeem(body) {
  if (body.loyalty === undefined || body.loyalty === null) return 0;
  if (typeof body.loyalty !== 'object' || Array.isArray(body.loyalty)) fail('Loyalty must be an object');
  const raw = body.loyalty.redeemPoints;
  if (raw === undefined || raw === null || raw === '' || Number(raw) === 0) return 0;
  if (!/^\d+$/.test(String(raw)) || Number(raw) > 10000000) fail('Points to redeem must be a whole number');
  return Number(raw);
}

// lines: the sale's prepared lines, each with `sku` and `amount` (paise, in
// the document's price terms) and `quantity`. Returns how much comes off each
// line and why; the caller works out tax on what is left.
async function priceSale(db, business, { contact, lines, body, taxMode }) {
  const perLine = lines.map(() => 0);
  const rows = [];
  // Lines with fixed prices (a dispatched order) take no offers or points.
  const open = (line) => !line.preset;
  const grossBill = sum(lines.filter(open).map((l) => l.amount));
  const caps = business.capabilities;

  const couponCode = readCoupon(body);
  if (couponCode && !caps.includes('offers')) fail('Offers and coupons are not switched on for this business');
  let coupon = null;
  if (caps.includes('offers')) {
    const running = await runningOffers(db, business.id);
    if (couponCode) coupon = { code: couponCode, offer: await couponOffer(db, business, couponCode, contact, grossBill, running), applied: false };
    // A coupon's offer counts only on the bill it was given for.
    const offers = running.filter((o) => (!o.coupon_code || Number(o.id) === Number(coupon?.offer.id)) && grossBill >= paise(o.min_bill_amount));
    if (offers.length) {
      const groups = new Map();
      lines.forEach((line, index) => {
        // A kit's parts take no item offer of their own (the kit has its price);
        // bill offers, the counter discount and points still apply.
        if (!open(line) || line.kit) return;
        const skuId = Number(line.sku.id);
        const group = groups.get(skuId) || { skuId, productId: Number(line.sku.product_id), indexes: [], amount: 0, quantity: 0 };
        group.indexes.push(index);
        group.amount += line.amount;
        group.quantity += milli(line.quantity);
        groups.set(skuId, group);
      });
      const itemOffers = offers.filter((o) => !o.kind.startsWith('bill_'));
      const categories = itemOffers.some((o) => o.kind === 'category_percent') ? await categoryPaths(db, business.id, [...groups.keys()]) : new Map();
      const chosen = [];
      for (const group of groups.values()) {
        let best = null;
        for (const offer of itemOffers) {
          const amount = itemDiscount(offer, group, categories);
          if (amount > 0 && (!best || amount > best.amount)) best = { group, offer, amount };
        }
        if (best) chosen.push(best);
      }
      // An offer's cap holds across every item it was chosen for.
      for (const offer of itemOffers.filter((o) => o.max_discount !== null)) {
        const mine = chosen.filter((c) => c.offer.id === offer.id);
        const total = sum(mine.map((c) => c.amount));
        if (total > paise(offer.max_discount)) split(paise(offer.max_discount), mine.map((c) => c.amount)).forEach((part, i) => { mine[i].amount = part; });
      }
      for (const { group, offer, amount } of chosen) {
        split(amount, group.indexes.map((i) => lines[i].amount)).forEach((part, n) => {
          const index = group.indexes[n];
          if (part <= 0) return;
          perLine[index] += part;
          rows.push({ index, source: 'offer', offerId: offer.id, label: offer.name, amount: part });
        });
      }
      const left = lines.map((line, i) => (open(line) ? line.amount - perLine[i] : 0));
      const leftTotal = sum(left);
      let bill = null;
      for (const offer of offers.filter((o) => o.kind.startsWith('bill_'))) {
        let amount = offer.kind === 'bill_percent' ? percentOf(leftTotal, offer.value) : paise(offer.value);
        if (offer.max_discount !== null) amount = Math.min(amount, paise(offer.max_discount));
        amount = Math.min(amount, leftTotal);
        if (amount > 0 && (!bill || amount > bill.amount)) bill = { offer, amount };
      }
      if (bill) {
        split(bill.amount, left).forEach((part, index) => {
          if (part <= 0) return;
          perLine[index] += part;
          rows.push({ index, source: 'offer', offerId: bill.offer.id, label: bill.offer.name, amount: part });
        });
      }
    }
  }

  // A small discount given at the counter, after offers and before points.
  const manual = readManualDiscount(body);
  if (manual) {
    await access.require(business, 'sales.discount');
    const payable = lines.map((line, i) => {
      if (!open(line)) return 0;
      const left = line.amount - perLine[i];
      return taxMode === 'inclusive' ? left : left + divide(BigInt(left) * BigInt(paise(line.sku.tax_rate)), 10000n);
    });
    const bill = sum(payable);
    const value = manual.amount ?? divide(BigInt(bill) * BigInt(Math.round(manual.percent * 100)), 10000n);
    if (value > bill) fail(`The discount is more than the bill (${money(bill)})`, 409);
    const limit = await repo.one(db, 'SELECT max_bill_discount_percent FROM business_settings WHERE business_id=$1', [business.id]);
    const cap = Math.floor((bill * paise(limit?.max_bill_discount_percent ?? 10)) / 10000);
    if (!business.full_access && value > cap) {
      fail(`At most ${Number(limit?.max_bill_discount_percent ?? 10)}% of a bill (${money(cap)} on this one) can be taken off at the counter. The owner can change this in Business settings.`, 409);
    }
    split(value, payable).forEach((part, index) => {
      if (part <= 0) return;
      const line = lines[index];
      const share = Math.min(line.amount - perLine[index], taxMode === 'inclusive' ? part : divide(BigInt(part) * 10000n, 10000n + BigInt(paise(line.sku.tax_rate))));
      if (share <= 0) return;
      perLine[index] += share;
      rows.push({ index, source: 'manual', offerId: null, label: `Discount: ${manual.reason}`, amount: share });
    });
  }

  const redeemPoints = readRedeem(body);
  let loyalty = null;
  if (caps.includes('loyalty') && contact) {
    const settings = await loyaltySettings(db, business.id);
    if (settings?.active) loyalty = { settings, balance: await pointsBalance(db, business.id, contact.id), redeem: null };
  }
  if (redeemPoints) {
    if (!caps.includes('loyalty')) fail('Loyalty points are not switched on for this business');
    await access.require(business, 'loyalty.create');
    if (!contact) fail('Choose the customer whose points are being redeemed');
    if (!loyalty) fail('Loyalty points are switched off in the loyalty rules', 409);
    const { settings, balance } = loyalty;
    if (redeemPoints < Number(settings.min_redeem_points)) fail(`At least ${settings.min_redeem_points} points must be redeemed at a time`);
    if (redeemPoints > balance) fail(`${contact.name} has ${balance} points; ${redeemPoints} cannot be redeemed`, 409);
    // What the customer would pay for each line, including GST.
    const payable = lines.map((line, i) => {
      if (!open(line)) return 0;
      const left = line.amount - perLine[i];
      return taxMode === 'inclusive' ? left : left + divide(BigInt(left) * BigInt(paise(line.sku.tax_rate)), 10000n);
    });
    const value = Number(BigInt(redeemPoints) * BigInt(paise(settings.point_value)));
    const cap = Math.floor((sum(payable) * paise(settings.max_redeem_percent)) / 10000);
    if (value > cap) {
      const most = Math.floor(cap / paise(settings.point_value));
      fail(`Points can pay at most ${Number(settings.max_redeem_percent)}% of this bill (${money(cap)}): redeem up to ${most} points`, 409);
    }
    split(value, payable).forEach((part, index) => {
      if (part <= 0) return;
      const line = lines[index];
      // Back to the line's price terms: before GST when prices exclude it.
      const share = Math.min(line.amount - perLine[index], taxMode === 'inclusive' ? part : divide(BigInt(part) * 10000n, 10000n + BigInt(paise(line.sku.tax_rate))));
      if (share <= 0) return;
      perLine[index] += share;
      rows.push({ index, source: 'points', offerId: null, label: `Loyalty points redeemed (${redeemPoints})`, amount: share });
    });
    loyalty.redeem = { points: redeemPoints, value };
  }
  if (coupon) coupon.applied = rows.some((r) => Number(r.offerId) === Number(coupon.offer.id));
  return { perLine, rows, loyalty, coupon: coupon && { code: coupon.code, name: coupon.offer.name, applied: coupon.applied } };
}

// What a quote shows about points: balance, what this bill earns, the most
// that can be redeemed on it.
function loyaltyPreview(pricing, totalPaise) {
  const loyalty = pricing?.loyalty;
  if (!loyalty) return null;
  const { settings, balance, redeem } = loyalty;
  const payableBefore = totalPaise + (redeem ? redeem.value : 0);
  const cap = Math.floor((payableBefore * paise(settings.max_redeem_percent)) / 10000);
  return {
    balance, earns: earnedPoints(settings, totalPaise), redeemed: redeem?.points || 0, redeemedValue: money(redeem?.value || 0),
    pointValue: Number(settings.point_value), minRedeem: Number(settings.min_redeem_points),
    maxRedeem: Math.min(balance, Math.floor(cap / paise(settings.point_value))),
  };
}

// The bill a quote shows: every figure exactly as posting would save it.
function quoteOf({ prepared, offers, subtotal, tax, roundOff, rounded, taxMode, contact }) {
  return {
    taxMode, contactId: contact?.id || null,
    lines: prepared.map((line, index) => ({
      skuId: line.sku.id, label: line.sku.label, unit: line.sku.unit, quantity: line.quantity, unitPrice: Number(line.price).toFixed(2),
      // Which price the line sold at: the list, this branch's own, the member price or a customer rule.
      priceKind: line.priceKind || null,
      enteredUnit: line.entered?.unit || null, enteredQuantity: line.entered?.quantity ?? null,
      amount: money(line.amount), discount: money(offers?.perLine[index] || 0), net: money(line.net), tax: money(line.tax), taxRate: line.sku.tax_rate,
      lotCode: line.lotCode || null,
      // The request line this came from, and its kit (if any).
      inputIndex: line.inputIndex ?? index, kitSkuId: line.kit?.skuId || null, kitLabel: line.kit?.label || null, kitGroup: line.kit?.group || null,
      offers: (offers?.rows || []).filter((r) => r.index === index).map((r) => ({ label: r.label, source: r.source, offerId: r.offerId, amount: money(r.amount) })),
    })),
    subtotal: money(subtotal), tax: money(tax), roundOff: money(roundOff), total: money(rounded),
    savings: money(sum(offers?.perLine || [])),
    loyalty: loyaltyPreview(offers, rounded),
    // The coupon given, and whether it took anything off (another offer may be better).
    coupon: offers?.coupon || null,
  };
}

// After the sale and its lines are saved (same transaction): the discount
// snapshot per line, points redeemed and earned, and their events.
async function recordSale(db, business, user, saved, lines, pricing) {
  for (const row of pricing.rows) {
    await db.query(`INSERT INTO retail_sale_discounts(business_id,document_id,line_id,source,offer_id,label,amount) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [business.id, saved.id, lines[row.index].id, row.source, row.offerId, row.label.slice(0, 150), money(row.amount)]);
  }
  const loyalty = pricing.loyalty;
  if (!loyalty || !saved.contact_id) return;
  if (loyalty.redeem) {
    const entry = await repo.one(db, `INSERT INTO retail_loyalty_entries(business_id,contact_id,kind,points,document_id,value,created_by)
      VALUES($1,$2,'redeem',$3,$4,$5,$6) RETURNING id`, [business.id, saved.contact_id, -loyalty.redeem.points, saved.id, money(loyalty.redeem.value), user.id]);
    await repo.event(db, business.id, user.id, 'loyalty.redeemed', 'loyalty_entry', entry.id,
      { contactId: saved.contact_id, documentId: saved.id, documentNo: saved.document_no, points: loyalty.redeem.points, value: money(loyalty.redeem.value) });
  }
  const earned = earnedPoints(loyalty.settings, paise(saved.total));
  if (earned > 0) {
    const entry = await repo.one(db, `INSERT INTO retail_loyalty_entries(business_id,contact_id,kind,points,document_id,created_by)
      VALUES($1,$2,'earn',$3,$4,$5) RETURNING id`, [business.id, saved.contact_id, earned, saved.id, user.id]);
    await repo.event(db, business.id, user.id, 'loyalty.earned', 'loyalty_entry', entry.id,
      { contactId: saved.contact_id, documentId: saved.id, documentNo: saved.document_no, points: earned });
  }
}

// Shown with a posted sale: what each line was given, and points.
async function saleExtras(db, businessId, documentId) {
  const [discounts, loyalty] = await Promise.all([
    repo.all(db, 'SELECT line_id,source,offer_id,label,amount FROM retail_sale_discounts WHERE business_id=$1 AND document_id=$2 ORDER BY id', [businessId, documentId]),
    repo.all(db, 'SELECT kind,points,value,shortfall_points,shortfall_value FROM retail_loyalty_entries WHERE business_id=$1 AND document_id=$2 ORDER BY id', [businessId, documentId]),
  ]);
  const held = sum(loyalty.filter((e) => e.kind === 'reverse').map((e) => paise(e.shortfall_value)));
  return { discounts, savings: money(sum(discounts.map((d) => paise(d.amount)))), loyalty, heldBack: money(held) };
}

module.exports = { priceSale, quoteOf, recordSale, reverseForReturn, restoreForReturn, heldBack, saleExtras, pointsBalance, loyaltySettings, split, BALANCE_SQL, RUNNING };
