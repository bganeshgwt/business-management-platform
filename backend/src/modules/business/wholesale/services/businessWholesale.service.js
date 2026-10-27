const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const numbering = require('../../core/services/businessNumbering');
const pricing = require('../../core/services/businessPricing');
const core = require('../../core/services/business.service');
const receivables = require('./businessReceivables.service');
const prices = require('./businessWholesalePricing.service');
const credit = require('./businessWholesaleCredit.service');

// Wholesale / FMCG distribution.
//
//   Customer → sales order (prices fixed now: customer price, slab, pack)
//            → dispatch, in one go or in parts (each dispatch is a tax
//              invoice: stock leaves, oldest expiry first, the customer is
//              billed at the order's prices)
//            → what is not sent yet is a back-order, until it is sent or the
//              order is closed short
//            → collections against the invoices (shared receivables)
//
// Stock moves only at dispatch, through the core sale posting, so the
// invoice, its number, the ledger, the credit-limit check, events and audit
// are the same as any sale. Credit limits are checked when the order is taken
// (balance + other orders still to dispatch + this order) and again when it
// is invoiced. Money is integer paise; quantities integer thousandths.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const optionalId = (value, name) => (value === undefined || value === null || value === '' ? null : id(value, name));
const paise = (value) => Math.round(Number(value) * 100);
const milli = (value) => Math.round(Number(value) * 1000);
const rupees = (p) => (p / 100).toFixed(2);
const qty = (m) => (m / 1000).toFixed(3);
const roundedDivide = (numerator, denominator) => Number((numerator + denominator / 2n) / denominator);
const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');

// --- Lists ---------------------------------------------------------------------

// What is still to go on an order line, and its value at the order's prices.
const remainingSql = (l) => `(${l}.quantity-${l}.dispatched_quantity-${l}.closed_quantity)`;
const remainingValueSql = (l) => `round((${l}.net+${l}.tax)*${remainingSql(l)}/${l}.quantity,2)`;

repo.addLists({
  // The login a salesperson uses, their monthly target, what
  // their orders were invoiced this month and what they collected.
  salespeople: { sql: `SELECT s.*,u.name AS user_name,u.email AS user_email,
      (SELECT count(*)::int FROM wholesale_beats b WHERE b.business_id=s.business_id AND b.salesperson_id=s.id AND b.active) AS beat_count,
      (SELECT count(*)::int FROM wholesale_customer_beats cb JOIN wholesale_beats b ON b.business_id=cb.business_id AND b.id=cb.beat_id
        WHERE cb.business_id=s.business_id AND b.salesperson_id=s.id AND b.active) AS customer_count,
      (SELECT count(*)::int FROM wholesale_orders o WHERE o.business_id=s.business_id AND o.salesperson_id=s.id
        AND date_trunc('month',o.created_at AT TIME ZONE bz.timezone)=date_trunc('month',now() AT TIME ZONE bz.timezone)) AS orders_this_month,
      (SELECT COALESCE(sum(d.total),0) FROM wholesale_dispatches w JOIN wholesale_orders o ON o.business_id=w.business_id AND o.id=w.order_id
        JOIN business_documents d ON d.business_id=w.business_id AND d.id=w.document_id
        WHERE w.business_id=s.business_id AND o.salesperson_id=s.id
        AND date_trunc('month',d.created_at AT TIME ZONE bz.timezone)=date_trunc('month',now() AT TIME ZONE bz.timezone)) AS invoiced_this_month,
      (SELECT COALESCE(sum(k.amount),0) FROM wholesale_collection_details wd JOIN business_collections k ON k.business_id=wd.business_id AND k.id=wd.collection_id
        WHERE wd.business_id=s.business_id AND wd.salesperson_id=s.id AND ${receivables.liveSql('k')}
        AND date_trunc('month',k.created_at AT TIME ZONE bz.timezone)=date_trunc('month',now() AT TIME ZONE bz.timezone)) AS collected_this_month
      FROM wholesale_salespeople s JOIN businesses bz ON bz.id=s.business_id LEFT JOIN users u ON u.id=s.user_id WHERE s.business_id=$1`,
  search: ['name', 'phone', 'user_name'], filters: { active: 'active', user: 'user_id' }, order: 'active DESC,name' },
  routes: { sql: `SELECT r.*,l.name AS location_name,
      (SELECT count(*)::int FROM wholesale_beats b WHERE b.business_id=r.business_id AND b.route_id=r.id AND b.active) AS beat_count,
      (SELECT count(*)::int FROM wholesale_customer_beats cb JOIN wholesale_beats b ON b.business_id=cb.business_id AND b.id=cb.beat_id
        WHERE cb.business_id=r.business_id AND b.route_id=r.id) AS customer_count
      FROM wholesale_routes r LEFT JOIN business_locations l ON l.business_id=r.business_id AND l.id=r.location_id WHERE r.business_id=$1`,
  // A route with no depot runs from every one.
  search: ['name', 'location_name'], filters: { active: 'active', location: { any: ['location_id'], orNull: true } }, order: 'active DESC,name' },
  beats: { sql: `SELECT b.*,r.name AS route_name,s.name AS salesperson_name,
      (SELECT count(*)::int FROM wholesale_customer_beats cb WHERE cb.business_id=b.business_id AND cb.beat_id=b.id) AS customer_count
      FROM wholesale_beats b JOIN wholesale_routes r ON r.business_id=b.business_id AND r.id=b.route_id
      LEFT JOIN wholesale_salespeople s ON s.business_id=b.business_id AND s.id=b.salesperson_id WHERE b.business_id=$1`,
  search: ['name', 'route_name', 'salesperson_name'], filters: { route: 'route_id', salesperson: 'salesperson_id', active: 'active' }, order: 'active DESC,route_name,visit_day NULLS LAST,name' },
  // Customers with their beat and trade details: walk-ins sort last
  // and are left out of order taking; what they owe comes along.
  'customer-beats': { sql: `SELECT c.id,c.name,c.phone,c.gstin,c.address,c.credit_limit,c.credit_days,cb.beat_id,b.name AS beat_name,b.route_id,r.name AS route_name,
      b.salesperson_id,s.name AS salesperson_name,b.visit_day,COALESCE(p.trade_type,'trade') AS trade_type,p.price_group_id,g.name AS price_group_name,
      p.state_code,p.contact_person,COALESCE(p.hold_exempt,false) AS hold_exempt,
      (b.visit_day IS NOT NULL AND b.visit_day=EXTRACT(ISODOW FROM now() AT TIME ZONE bz.timezone)) AS beat_today,
      ${repo.contactBalanceSql('c')} AS balance
      FROM business_contacts c JOIN businesses bz ON bz.id=c.business_id
      LEFT JOIN wholesale_customer_beats cb ON cb.business_id=c.business_id AND cb.contact_id=c.id
      LEFT JOIN wholesale_beats b ON b.business_id=cb.business_id AND b.id=cb.beat_id
      LEFT JOIN wholesale_routes r ON r.business_id=b.business_id AND r.id=b.route_id
      LEFT JOIN wholesale_salespeople s ON s.business_id=b.business_id AND s.id=b.salesperson_id
      LEFT JOIN wholesale_customer_profiles p ON p.business_id=c.business_id AND p.contact_id=c.id
      LEFT JOIN wholesale_price_groups g ON g.business_id=p.business_id AND g.id=p.price_group_id
      WHERE c.business_id=$1 AND c.kind='customer' AND c.active`,
  search: ['name', 'phone', 'beat_name', 'route_name', 'salesperson_name', 'gstin'],
  filters: { beat: 'beat_id', route: 'route_id', salesperson: 'salesperson_id', trade: 'trade_type', group: 'price_group_id', today: 'beat_today' },
  order: "trade_type='walk_in',beat_today DESC,route_name NULLS FIRST,beat_name,name" },
  'sales-orders': { sql: `SELECT o.*,l.name AS location_name,s.name AS salesperson_name,r.name AS route_name,b.name AS beat_name,
      (SELECT count(*)::int FROM wholesale_order_lines x WHERE x.business_id=o.business_id AND x.order_id=o.id) AS line_count,
      (SELECT COALESCE(sum(${remainingValueSql('x')}),0) FROM wholesale_order_lines x WHERE x.business_id=o.business_id AND x.order_id=o.id) AS pending_value,
      (SELECT count(*)::int FROM wholesale_dispatches d WHERE d.business_id=o.business_id AND d.order_id=o.id) AS dispatch_count,
      (SELECT COALESCE(sum(doc.total),0) FROM wholesale_dispatches d JOIN business_documents doc ON doc.business_id=d.business_id AND doc.id=d.document_id
        WHERE d.business_id=o.business_id AND d.order_id=o.id) AS invoiced,
      EXISTS (SELECT 1 FROM wholesale_hold_releases h WHERE h.business_id=o.business_id AND h.order_id=o.id) AS hold_released,
      EXISTS (SELECT 1 FROM wholesale_order_edits e WHERE e.business_id=o.business_id AND e.order_id=o.id) AS edited,
      (SELECT count(*)::int FROM wholesale_dispatches d WHERE d.business_id=o.business_id AND d.order_id=o.id AND d.delivery_status='out_for_delivery') AS out_for_delivery
      FROM wholesale_orders o JOIN business_locations l ON l.business_id=o.business_id AND l.id=o.location_id
      LEFT JOIN wholesale_salespeople s ON s.business_id=o.business_id AND s.id=o.salesperson_id
      LEFT JOIN wholesale_routes r ON r.business_id=o.business_id AND r.id=o.route_id
      LEFT JOIN wholesale_beats b ON b.business_id=o.business_id AND b.id=o.beat_id WHERE o.business_id=$1`,
  search: ['order_no', 'contact_name', 'salesperson_name', 'route_name', 'notes'], date: 'created_at',
  filters: { status: 'status', contact: 'contact_id', salesperson: 'salesperson_id', route: 'route_id', location: 'location_id', beat: 'beat_id' }, order: 'id DESC' },
  // Everything still to send, with the stock at the dispatching godown;
  // can_go_now: that stock covers the line.
  'back-orders': { sql: `SELECT y.*,(y.available>=y.remaining) AS can_go_now FROM (
      SELECT x.id,x.order_id,o.order_no,o.created_at,o.expected_on,o.contact_id,o.contact_name,o.location_id,o.status,o.route_id,o.salesperson_id,o.beat_id,
      r.name AS route_name,s.name AS salesperson_name,x.sku_id,x.label,x.unit,x.quantity,x.dispatched_quantity,${remainingSql('x')} AS remaining,
      x.entered_unit,x.unit_factor,${remainingValueSql('x')} AS remaining_value,x.free_of_line_id,sku.code AS sku_code,
      (SELECT u.unit_code FROM catalog_sku_units u WHERE u.business_id=x.business_id AND u.sku_id=x.sku_id AND u.active ORDER BY u.quantity_in_base DESC LIMIT 1) AS pack_unit,
      (SELECT u.quantity_in_base FROM catalog_sku_units u WHERE u.business_id=x.business_id AND u.sku_id=x.sku_id AND u.active ORDER BY u.quantity_in_base DESC LIMIT 1) AS pack_factor,
      COALESCE((SELECT sum(lot.quantity) FROM business_stock_lots lot JOIN businesses bz ON bz.id=lot.business_id
        WHERE lot.business_id=x.business_id AND lot.sku_id=x.sku_id AND lot.location_id=o.location_id
        AND (lot.expires_on IS NULL OR lot.expires_on>=(now() AT TIME ZONE bz.timezone)::date)),0) AS available
      FROM wholesale_order_lines x JOIN wholesale_orders o ON o.business_id=x.business_id AND o.id=x.order_id
      JOIN catalog_skus sku ON sku.business_id=x.business_id AND sku.id=x.sku_id
      LEFT JOIN wholesale_routes r ON r.business_id=o.business_id AND r.id=o.route_id
      LEFT JOIN wholesale_salespeople s ON s.business_id=o.business_id AND s.id=o.salesperson_id
      WHERE x.business_id=$1 AND o.status IN ('open','part_dispatched') AND ${remainingSql('x')}>0) y`,
  search: ['order_no', 'contact_name', 'label', 'route_name', 'salesperson_name', 'sku_code'],
  filters: { route: 'route_id', salesperson: 'salesperson_id', contact: 'contact_id', sku: 'sku_id', order: 'order_id', ready: 'can_go_now', location: 'location_id' }, order: 'created_at,order_id,id' },
});

// --- Salespeople, routes, beats ------------------------------------------------------

async function audited(business, user, action, work) {
  return repo.transaction(async (db) => {
    const row = await work(db);
    await repo.audit(db, business.id, user.id, action, row.id ?? row.contact_id ?? null, {});
    return row;
  });
}
// A salesperson may be linked to the login they use in this business, and
// given a monthly sales target.
async function saveSalesperson(business, user, salespersonId, body) {
  await access.require(business, 'sales_orders.edit');
  const name = v.requiredString(body.name, 'Name', 150), phone = v.optionalString(body.phone, 'Phone', 30);
  const target = body.monthlyTarget === undefined || body.monthlyTarget === null || body.monthlyTarget === '' ? null : core.decimal(body.monthlyTarget, 'Monthly target', 2, 0, 1000000000);
  const userId = optionalId(body.userId, 'Login');
  return audited(business, user, salespersonId ? 'salesperson.updated' : 'salesperson.created', async (db) => {
    if (userId && !(await repo.one(db, 'SELECT user_id FROM business_memberships WHERE business_id=$1 AND user_id=$2 AND active', [business.id, userId]))) {
      fail('That login is not a member of this business. Add them under Staff & access first.', 404);
    }
    if (!salespersonId) {
      return repo.one(db, 'INSERT INTO wholesale_salespeople(business_id,name,phone,created_by,user_id,monthly_target) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
        [business.id, name, phone, user.id, userId, target]);
    }
    const current = await repo.one(db, 'SELECT * FROM wholesale_salespeople WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(salespersonId)]);
    if (!current) fail('Salesperson not found', 404);
    // Older clients send only name/phone/active: keep the login and target then.
    return repo.one(db, 'UPDATE wholesale_salespeople SET name=$3,phone=$4,active=$5,user_id=$6,monthly_target=$7 WHERE business_id=$1 AND id=$2 RETURNING *',
      [business.id, current.id, name, phone, v.requiredBoolean(body.active, 'Active', true),
        body.userId === undefined ? current.user_id : userId, body.monthlyTarget === undefined ? current.monthly_target : target]);
  });
}
// Logins of this business a salesperson can be linked to.
async function salespersonLogins(business) {
  await access.require(business, 'sales_orders.edit');
  return repo.all(repo.pool, `SELECT u.id,u.name,u.email,r.name AS role_name,
    (SELECT s.name FROM wholesale_salespeople s WHERE s.business_id=m.business_id AND s.user_id=u.id) AS linked_to
    FROM business_memberships m JOIN users u ON u.id=m.user_id JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id
    WHERE m.business_id=$1 AND m.active ORDER BY u.name`, [business.id]);
}
async function readLocation(db, business, value, required) {
  const locationId = required ? id(value, 'Location') : optionalId(value, 'Location');
  if (!locationId) return null;
  const location = await repo.one(db, 'SELECT * FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, locationId]);
  if (!location) fail('Location not found', 404);
  return location;
}
async function saveRoute(business, user, routeId, body) {
  await access.require(business, 'sales_orders.edit');
  const name = v.requiredString(body.name, 'Route name', 100);
  return audited(business, user, routeId ? 'route.updated' : 'route.created', async (db) => {
    const location = await readLocation(db, business, body.locationId, false);
    if (!routeId) {
      return repo.one(db, 'INSERT INTO wholesale_routes(business_id,name,location_id,created_by) VALUES($1,$2,$3,$4) RETURNING *', [business.id, name, location?.id || null, user.id]);
    }
    const row = await repo.one(db, 'UPDATE wholesale_routes SET name=$3,location_id=$4,active=$5 WHERE business_id=$1 AND id=$2 RETURNING *',
      [business.id, id(routeId), name, location?.id || null, v.requiredBoolean(body.active, 'Active', true)]);
    if (!row) fail('Route not found', 404);
    return row;
  });
}
async function saveBeat(business, user, beatId, body) {
  await access.require(business, 'sales_orders.edit');
  const name = v.requiredString(body.name, 'Beat name', 100);
  const visitDay = body.visitDay === undefined || body.visitDay === null || body.visitDay === '' ? null : core.decimal(body.visitDay, 'Visit day', 0, 1, 7);
  return audited(business, user, beatId ? 'beat.updated' : 'beat.created', async (db) => {
    const route = await repo.one(db, 'SELECT id FROM wholesale_routes WHERE business_id=$1 AND id=$2 AND active', [business.id, id(body.routeId, 'Route')]);
    if (!route) fail('Route not found', 404);
    const salespersonId = optionalId(body.salespersonId, 'Salesperson');
    if (salespersonId && !(await repo.one(db, 'SELECT id FROM wholesale_salespeople WHERE business_id=$1 AND id=$2 AND active', [business.id, salespersonId]))) fail('Salesperson not found', 404);
    if (!beatId) {
      return repo.one(db, 'INSERT INTO wholesale_beats(business_id,route_id,name,visit_day,salesperson_id,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
        [business.id, route.id, name, visitDay, salespersonId, user.id]);
    }
    const row = await repo.one(db, 'UPDATE wholesale_beats SET route_id=$3,name=$4,visit_day=$5,salesperson_id=$6,active=$7 WHERE business_id=$1 AND id=$2 RETURNING *',
      [business.id, id(beatId), route.id, name, visitDay, salespersonId, v.requiredBoolean(body.active, 'Active', true)]);
    if (!row) fail('Beat not found', 404);
    return row;
  });
}
// Puts a customer on a beat (beatId null takes them off).
async function setCustomerBeat(business, user, contactId, body) {
  await access.require(business, 'sales_orders.edit');
  const beatId = optionalId(body.beatId, 'Beat');
  return repo.transaction(async (db) => {
    const contact = await repo.one(db, "SELECT id FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, id(contactId, 'Customer')]);
    if (!contact) fail('Customer not found', 404);
    let row;
    if (beatId) {
      if (!(await repo.one(db, 'SELECT id FROM wholesale_beats WHERE business_id=$1 AND id=$2 AND active', [business.id, beatId]))) fail('Beat not found', 404);
      row = await repo.one(db, `INSERT INTO wholesale_customer_beats(business_id,contact_id,beat_id,updated_by) VALUES($1,$2,$3,$4)
        ON CONFLICT(business_id,contact_id) DO UPDATE SET beat_id=EXCLUDED.beat_id,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,
      [business.id, contact.id, beatId, user.id]);
    } else {
      await db.query('DELETE FROM wholesale_customer_beats WHERE business_id=$1 AND contact_id=$2', [business.id, contact.id]);
      row = { contact_id: contact.id, beat_id: null };
    }
    await repo.audit(db, business.id, user.id, 'customer.beat_set', contact.id, { beatId });
    return row;
  });
}

// --- Sales orders ---------------------------------------------------------------------

// What a customer has ordered but not yet been sent, at the order prices (paise).
async function pendingOrderValue(db, businessId, contactId, exceptOrderId = null) {
  const row = await repo.one(db, `SELECT COALESCE(sum(${remainingValueSql('x')}),0) AS value FROM wholesale_order_lines x
    JOIN wholesale_orders o ON o.business_id=x.business_id AND o.id=x.order_id
    WHERE x.business_id=$1 AND o.contact_id=$2 AND o.status IN ('open','part_dispatched') AND ($3::bigint IS NULL OR o.id<>$3)`, [businessId, contactId, exceptOrderId]);
  return paise(row.value);
}

// Credit limit at order: what they owe now + what is ordered and not yet
// sent (other orders) + this order's unsent value may not pass their limit.
async function checkCreditLimit(db, business, contact, thisOrderPending, exceptOrderId = null) {
  if (contact.credit_limit === null) return;
  const owed = await repo.one(db, `SELECT ${repo.contactBalanceSql('c')} AS balance FROM business_contacts c WHERE c.business_id=$1 AND c.id=$2`, [business.id, contact.id]);
  const pending = await pendingOrderValue(db, business.id, contact.id, exceptOrderId);
  const exposure = paise(owed.balance) + pending + thisOrderPending;
  if (exposure > paise(contact.credit_limit)) {
    fail(`This order would take ${contact.name} to ${rupees(exposure)} (owed ${rupees(paise(owed.balance))}, ordered and not yet sent ${rupees(pending)}, this order ${rupees(thisOrderPending)}), over their credit limit of ${Number(contact.credit_limit).toFixed(2)}. Collect payment first or raise the limit.`, 409);
  }
}

// The order context of a customer: tax mode, today, their price group, and
// whether this person may give a discount or free goods by hand.
async function orderContext(db, business, contact) {
  const settings = await repo.one(db, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [business.id]);
  const profile = await repo.one(db, 'SELECT * FROM wholesale_customer_profiles WHERE business_id=$1 AND contact_id=$2', [business.id, contact.id]);
  return {
    contact, taxMode: settings?.tax_mode || 'exclusive', day: await prices.today(db, business), groupId: profile?.price_group_id || null,
    canDiscount: access.can(business, 'sales.discount') || access.can(business, 'wholesale.edit'),
  };
}

// Prices one order line on the server:
//   input: { skuId, quantity, unit?, discountPercent?, freeQuantity? }
// The customer's own price, else their price group's, else a slab, else the
// list price; then a scheme's discount and the line's own discount (needs
// sales.discount or wholesale.edit); then GST. Free goods (a scheme's, plus
// any given by hand) become their own line at no charge.
async function priceLine(db, business, ctx, input) {
  const sku = await repo.one(db, `SELECT s.*,p.kind,u.decimals AS unit_decimals,u.name AS unit_name FROM catalog_skus s
    JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
    WHERE s.business_id=$1 AND s.id=$2 AND s.active AND p.active`, [business.id, id(input?.skuId, 'Item')]);
  if (!sku) fail('Item not found', 404);
  if (sku.kind !== 'goods') fail(`${sku.label} is a service; orders are for goods`);
  let quantity, entered = null, factorMicro = 1000000;
  if (input.unit && input.unit !== sku.unit) {
    const unit = await core.readUnit(db, business.id, input.unit);
    const enteredQuantity = core.decimal(input.quantity, 'Quantity', 3, 0.001, 100000);
    core.requiredDecimals(input.quantity, unit, 'Quantity');
    factorMicro = await core.conversion(db, business.id, sku, unit);
    const base = BigInt(milli(enteredQuantity)) * BigInt(factorMicro);
    if (base % 1000000n !== 0n) fail(`${input.quantity} ${unit.name.toLowerCase()} does not make an exact quantity in ${sku.unit_name.toLowerCase()}`);
    quantity = Number(base / 1000000n) / 1000;
    entered = { unit: unit.code, quantity: enteredQuantity };
  } else {
    quantity = core.decimal(input.quantity, 'Quantity', 3, 0.001, 100000);
  }
  if (quantity <= 0 || quantity > 100000) fail('Quantity must be between 0.001 and 100000 in the stock unit');
  core.requiredDecimals(quantity, { decimals: sku.unit_decimals, name: sku.unit_name }, 'Quantity');
  // The scheme first: one marked "don't combine with slab price" prices the
  // line without quantity slabs; otherwise it stacks on them.
  const scheme = await prices.schemeFor(db, business.id, ctx.groupId, sku, milli(quantity), entered, ctx.day);
  const noSlab = Boolean(scheme?.noSlab);
  let priced = await pricing.salePrice(db, business, sku, ctx.contact.id, quantity, entered && { ...entered, factorMicro });
  if (noSlab && priced.rule && !priced.rule.contact_id) {
    // A slab for every customer gives way: the list price (no price rules).
    priced = await pricing.salePrice(db, { ...business, capabilities: [] }, sku, ctx.contact.id, quantity, entered && { ...entered, factorMicro });
  }
  let stockPrice = priced.stockPrice, enteredPrice = priced.enteredPrice, gross = priced.net, ruleId = priced.rule?.id || null;
  let source = priced.rule ? (priced.rule.contact_id ? 'customer' : 'slab') : 'list';
  if (!priced.rule?.contact_id) {
    const group = await prices.groupPrice(db, business.id, ctx.groupId, sku, quantity, entered, ctx.day, noSlab);
    if (group) {
      ruleId = null; source = 'group';
      if (group.unit_code && entered) {
        enteredPrice = paise(group.unit_price);
        gross = roundedDivide(BigInt(enteredPrice) * BigInt(milli(entered.quantity)), 1000n);
        stockPrice = Number(((enteredPrice / 100) / (factorMicro / 1e6)).toFixed(4));
      } else {
        stockPrice = Number(group.unit_price);
        gross = roundedDivide(BigInt(paise(stockPrice)) * BigInt(milli(quantity)), 1000n);
        enteredPrice = entered ? roundedDivide(BigInt(paise(stockPrice)) * BigInt(factorMicro), 1000000n) : null;
      }
    }
  }
  // Discounts: the scheme's, plus one given by hand.
  const manual = input.discountPercent === undefined || input.discountPercent === null || input.discountPercent === '' ? 0 : core.decimal(input.discountPercent, 'Discount %', 2, 0, 99.99);
  const manualFree = input.freeQuantity === undefined || input.freeQuantity === null || input.freeQuantity === '' ? 0 : core.decimal(input.freeQuantity, 'Free quantity', 3, 0, 100000);
  if ((manual > 0 || manualFree > 0) && !ctx.canDiscount) await access.require(business, 'sales.discount');
  const discountBp = Math.min(9999, Math.round(manual * 100) + Math.round((scheme?.discount || 0) * 100));
  const listPrice = stockPrice;
  let net = gross;
  if (discountBp) {
    net = roundedDivide(BigInt(gross) * BigInt(10000 - discountBp), 10000n);
    stockPrice = Number(((stockPrice * (10000 - discountBp)) / 10000).toFixed(4));
    if (enteredPrice !== null) enteredPrice = roundedDivide(BigInt(enteredPrice) * BigInt(10000 - discountBp), 10000n);
  }
  let lineTax;
  if (ctx.taxMode === 'inclusive') {
    const amount = net;
    net = core.inclusiveNet(amount, Number(sku.tax_rate));
    lineTax = amount - net;
  } else lineTax = core.lineTax(net, Number(sku.tax_rate));
  // Free goods: by hand in the line's own unit, plus the scheme's (when the
  // scheme gives the same item; another item becomes a line of its own).
  const otherFree = scheme?.freeSkuId && scheme.freeMilli > 0 ? await freeItem(db, business, scheme) : null;
  let freeMilli = otherFree ? 0 : scheme?.freeMilli || 0;
  if (manualFree > 0) {
    const handMilli = entered ? Number((BigInt(milli(manualFree)) * BigInt(factorMicro)) / 1000000n) : milli(manualFree);
    freeMilli += handMilli;
  }
  let free = null;
  if (freeMilli > 0) {
    core.requiredDecimals(freeMilli / 1000, { decimals: sku.unit_decimals, name: sku.unit_name }, 'Free quantity');
    // Shown in packs when it is whole packs of the line's pack.
    const packFactor = entered ? factorMicro : scheme?.freeEntered?.factorMicro;
    const packUnit = entered ? entered.unit : scheme?.freeEntered?.unit;
    const wholePacks = packFactor && (BigInt(freeMilli) * 1000000n) % (BigInt(packFactor) * 1000n) === 0n;
    free = { quantityMilli: freeMilli, entered: wholePacks ? { unit: packUnit, quantity: Number((BigInt(freeMilli) * 1000000n) / BigInt(packFactor)) / 1000, factorMicro: packFactor } : null };
  }
  return { sku, quantity, entered, factorMicro, listPrice, stockPrice, enteredPrice, net, tax: lineTax, ruleId, source, discount: discountBp / 100,
    schemeId: scheme ? scheme.scheme.id : null, schemeName: scheme?.scheme.name || null, free, otherFree };
}

// "Buy 5 cases of A, get 1 of B": B's free line, in B's pack when whole packs.
async function freeItem(db, business, scheme) {
  const sku = await repo.one(db, `SELECT s.*,u.decimals AS unit_decimals,u.name AS unit_name FROM catalog_skus s
    JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
    WHERE s.business_id=$1 AND s.id=$2 AND s.active AND p.active`, [business.id, scheme.freeSkuId]);
  if (!sku) fail(`The free item of scheme ${scheme.scheme.name} is no longer sold; end the scheme or change it`, 409);
  core.requiredDecimals(scheme.freeMilli / 1000, { decimals: sku.unit_decimals, name: sku.unit_name }, 'Free quantity');
  return { sku, quantityMilli: scheme.freeMilli, entered: scheme.freeEntered };
}

async function insertLines(db, business, orderId, line) {
  const saved = await repo.one(db, `INSERT INTO wholesale_order_lines(business_id,order_id,sku_id,label,unit,quantity,unit_price,tax_rate,net,tax,price_rule_id,
    entered_unit,entered_quantity,entered_unit_price,unit_factor,discount_percent,list_unit_price,scheme_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
  [business.id, orderId, line.sku.id, line.sku.label, line.sku.unit, line.quantity, Number(line.stockPrice).toFixed(4), line.sku.tax_rate,
    rupees(line.net), rupees(line.tax), line.ruleId, line.entered?.unit || null, line.entered?.quantity ?? null,
    line.entered ? rupees(line.enteredPrice) : null, line.entered ? (line.factorMicro / 1e6).toFixed(6) : null,
    line.discount.toFixed(2), Number(line.listPrice).toFixed(4), line.schemeId]);
  const ids = [saved.id];
  if (line.free) {
    const f = line.free;
    const freeLine = await repo.one(db, `INSERT INTO wholesale_order_lines(business_id,order_id,sku_id,label,unit,quantity,unit_price,tax_rate,net,tax,
      entered_unit,entered_quantity,entered_unit_price,unit_factor,discount_percent,list_unit_price,free_of_line_id,scheme_id)
      VALUES($1,$2,$3,$4,$5,$6,0,$7,0,0,$8,$9,$10,$11,100,$12,$13,$14) RETURNING id`,
    [business.id, orderId, line.sku.id, `${line.sku.label} (free)`.slice(0, 150), line.sku.unit, qty(f.quantityMilli), line.sku.tax_rate,
      f.entered?.unit || null, f.entered?.quantity ?? null, f.entered ? '0.00' : null, f.entered ? (f.entered.factorMicro / 1e6).toFixed(6) : null,
      Number(line.listPrice).toFixed(4), saved.id, line.schemeId]);
    ids.push(freeLine.id);
  }
  if (line.otherFree) {
    const f = line.otherFree;
    const freeLine = await repo.one(db, `INSERT INTO wholesale_order_lines(business_id,order_id,sku_id,label,unit,quantity,unit_price,tax_rate,net,tax,
      entered_unit,entered_quantity,entered_unit_price,unit_factor,discount_percent,list_unit_price,free_of_line_id,scheme_id)
      VALUES($1,$2,$3,$4,$5,$6,0,$7,0,0,$8,$9,$10,$11,100,$12,$13,$14) RETURNING id`,
    [business.id, orderId, f.sku.id, `${f.sku.label} (free)`.slice(0, 150), f.sku.unit, qty(f.quantityMilli), f.sku.tax_rate,
      f.entered?.unit || null, f.entered?.quantity ?? null, f.entered ? '0.00' : null, f.entered ? (f.entered.factorMicro / 1e6).toFixed(6) : null,
      Number(f.sku.price).toFixed(4), saved.id, line.schemeId]);
    ids.push(freeLine.id);
  }
  return ids;
}

// The hash of an order request leaves out a manager's release (and PIN):
// asking again with a release after a credit-hold refusal is the same order.
const orderHash = (body) => hashOf({ ...body, release: undefined });

async function createOrder(business, user, body) {
  await access.require(business, 'sales_orders.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = orderHash(body);
  const lines = v.requiredArray(body.lines, 'Lines');
  if (!lines.length || lines.length > 100) fail('Add between 1 and 100 lines');
  const expectedOn = body.expectedOn ? core.dateText(body.expectedOn, 'Expected delivery date') : null;
  const existing = await repo.one(repo.pool, 'SELECT * FROM wholesale_orders WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
  if (existing) {
    if (existing.request_hash !== hash) fail('This request key was already used for different data', 409);
    return existing;
  }
  const release = await credit.readRelease(business, user, body.release);
  return repo.transaction((db) => placeOrder(db, business, user, body, { requestKey, hash, release, expectedOn }));
}

// Places an order inside the caller's transaction, with the same checks
// (credit limit, credit hold), number, audit and event as any order.
// `priced`: lines already priced elsewhere, as priceLine returns them (a
// quotation's, at its prices); otherwise each line of the body is priced here.
async function placeOrder(db, business, user, body, { requestKey, hash, release, expectedOn, priced = null }) {
  await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
  const old = await repo.one(db, 'SELECT * FROM wholesale_orders WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
  if (old) {
    if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
    return old;
  }
  const location = await readLocation(db, business, body.locationId, true);
  const contact = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer' AND active FOR UPDATE", [business.id, id(body.contactId, 'Customer')]);
  if (!contact) fail('Customer not found', 404);
  // Route, beat and salesperson: as given, else from the customer's beat.
  const home = await repo.one(db, `SELECT b.id AS beat_id,b.route_id,b.salesperson_id FROM wholesale_customer_beats cb
    JOIN wholesale_beats b ON b.business_id=cb.business_id AND b.id=cb.beat_id WHERE cb.business_id=$1 AND cb.contact_id=$2`, [business.id, contact.id]);
  let beatId = body.beatId === undefined ? home?.beat_id || null : optionalId(body.beatId, 'Beat');
  let routeId = body.routeId === undefined ? null : optionalId(body.routeId, 'Route');
  let salespersonId = body.salespersonId === undefined ? null : optionalId(body.salespersonId, 'Salesperson');
  if (beatId) {
    const beat = await repo.one(db, 'SELECT * FROM wholesale_beats WHERE business_id=$1 AND id=$2', [business.id, beatId]);
    if (!beat) fail('Beat not found', 404);
    routeId = routeId || beat.route_id;
    if (routeId !== beat.route_id) fail('That beat is on another route');
    if (body.salespersonId === undefined) salespersonId = beat.salesperson_id;
  }
  if (routeId && !(await repo.one(db, 'SELECT id FROM wholesale_routes WHERE business_id=$1 AND id=$2', [business.id, routeId]))) fail('Route not found', 404);
  if (salespersonId && !(await repo.one(db, 'SELECT id FROM wholesale_salespeople WHERE business_id=$1 AND id=$2 AND active', [business.id, salespersonId]))) fail('Salesperson not found', 404);
  const ctx = await orderContext(db, business, contact);
  const prepared = [];
  let subtotal = 0, tax = 0;
  for (const input of priced || body.lines) {
    const line = priced ? input : await priceLine(db, business, ctx, input);
    subtotal += line.net; tax += line.tax;
    if (subtotal + tax > 100000000000) fail('Order total exceeds the supported limit');
    prepared.push(line);
  }
  const total = subtotal + tax;
  await checkCreditLimit(db, business, contact, total);
  // Credit hold: overdue past the business's limit needs a release.
  const hold = await credit.checkHold(db, business, contact, release);
  const number = await numbering.nextNumber(db, business.id, location.id, 'sales_order', user.id);
  const order = await repo.one(db, `INSERT INTO wholesale_orders(business_id,order_no,series_id,location_id,contact_id,contact_name,salesperson_id,route_id,beat_id,
    expected_on,notes,tax_mode,subtotal,tax,total,request_key,request_hash,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
  [business.id, number.number, number.seriesId, location.id, contact.id, contact.name, salespersonId, routeId, beatId, expectedOn,
    v.optionalString(body.notes, 'Notes', 500), ctx.taxMode, rupees(subtotal), rupees(tax), rupees(total), requestKey, hash, user.id]);
  for (const line of prepared) await insertLines(db, business, order.id, line);
  if (hold) await credit.recordRelease(db, business, user, order, contact, hold, release);
  await repo.audit(db, business.id, user.id, 'sales_order.placed', order.id, { orderNo: order.order_no, total: order.total });
  await repo.event(db, business.id, user.id, 'sales_order.placed', 'sales_order', order.id, {
    orderNo: order.order_no, contactId: contact.id, total: order.total, salespersonId, routeId,
    lines: prepared.map((l) => ({ skuId: l.sku.id, quantity: l.quantity, unit: l.entered?.unit || l.sku.unit, discountPercent: l.discount, schemeId: l.schemeId,
      free: l.free ? qty(l.free.quantityMilli) : null, freeItem: l.otherFree ? { skuId: l.otherFree.sku.id, quantity: qty(l.otherFree.quantityMilli) } : null })),
  });
  return { ...order, hold_released: Boolean(hold) };
}

// Re-values an order from its lines: what was ordered less what was taken
// off by an edit or closed (each line's share, rounded per line).
async function revalue(db, business, orderId) {
  const row = await repo.one(db, `SELECT COALESCE(sum(round(x.net*(x.quantity-x.closed_quantity)/x.quantity,2)),0) AS subtotal,
    COALESCE(sum(round(x.tax*(x.quantity-x.closed_quantity)/x.quantity,2)),0) AS tax FROM wholesale_order_lines x WHERE x.business_id=$1 AND x.order_id=$2`, [business.id, orderId]);
  const subtotal = paise(row.subtotal), tax = paise(row.tax);
  return repo.one(db, 'UPDATE wholesale_orders SET subtotal=$3,tax=$4,total=$5 WHERE business_id=$1 AND id=$2 RETURNING *', [business.id, orderId, rupees(subtotal), rupees(tax), rupees(subtotal + tax)]);
}

// Edit an order before it goes. body: { requestKey, reason,
//   lines: [{ orderLineId?, skuId?, quantity, unit?, discountPercent?, freeQuantity? }], expectedOn?, notes?, release? }
// `lines` is what should still be sent: an existing line keeps its price when
// its quantity and discount are unchanged; a changed one has its unsent part
// taken off and a new line added at today's price (scheme and credit checks
// again); lines left out are taken off; new lines are added. What was
// already sent never changes.
async function editOrder(business, user, orderId, body) {
  await access.require(business, 'sales_orders.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = orderHash(body);
  const reason = v.requiredString(body.reason, 'Reason for the change', 300);
  const inputs = v.requiredArray(body.lines, 'Lines');
  if (inputs.length > 100) fail('At most 100 lines');
  const done = await repo.one(repo.pool, 'SELECT * FROM wholesale_order_edits WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
  if (done) {
    if (done.request_hash !== hash) fail('This request key was already used for different data', 409);
    return repo.one(repo.pool, 'SELECT * FROM wholesale_orders WHERE business_id=$1 AND id=$2', [business.id, done.order_id]);
  }
  const release = await credit.readRelease(business, user, body.release);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const order = await repo.one(db, 'SELECT * FROM wholesale_orders WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(orderId)]);
    if (!order) fail('Order not found', 404);
    if (!['open', 'part_dispatched'].includes(order.status)) fail(`This order is already ${order.status.replace('_', ' ')}; it can no longer be changed`, 409);
    const contact = await repo.one(db, 'SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, order.contact_id]);
    const current = await repo.all(db, `SELECT x.*,${remainingSql('x')} AS remaining FROM wholesale_order_lines x WHERE x.business_id=$1 AND x.order_id=$2 ORDER BY x.id FOR UPDATE`, [business.id, order.id]);
    const paid = current.filter((l) => !l.free_of_line_id && milli(l.remaining) > 0);
    const seen = new Set();
    const remove = [], add = [];
    const ctx = await orderContext(db, business, contact);
    for (const input of inputs) {
      if (input?.orderLineId !== undefined && input?.orderLineId !== null && input?.orderLineId !== '') {
        const line = paid.find((l) => l.id === id(input.orderLineId, 'Order line'));
        if (!line) fail('That line is not one still to send on this order', 404);
        if (seen.has(line.id)) fail('Each order line may appear once');
        seen.add(line.id);
        // Unchanged: same quantity still to send, same discount, no extra free goods.
        const unit = input.unit && input.unit !== line.unit ? input.unit : null;
        let wantMilli;
        if (unit) {
          if (unit !== line.entered_unit) fail(`${line.label} was ordered in ${line.entered_unit || line.unit}; change it in that or in ${line.unit}`);
          wantMilli = Number((BigInt(milli(core.decimal(input.quantity, 'Quantity', 3, 0, 100000))) * BigInt(Math.round(Number(line.unit_factor) * 1e6))) / 1000000n);
        } else wantMilli = milli(core.decimal(input.quantity, 'Quantity', 3, 0, 100000));
        const sameDiscount = input.discountPercent === undefined || input.discountPercent === null || input.discountPercent === '' || Number(input.discountPercent) === Number(line.discount_percent);
        const noFree = input.freeQuantity === undefined || input.freeQuantity === null || input.freeQuantity === '' || Number(input.freeQuantity) === 0;
        if (wantMilli === milli(line.remaining) && sameDiscount && noFree) continue;
        remove.push(line);
        if (wantMilli > 0) {
          add.push({ skuId: line.sku_id, quantity: unit ? String(input.quantity) : qty(wantMilli), ...(unit ? { unit } : {}),
            discountPercent: sameDiscount ? line.discount_percent : input.discountPercent, freeQuantity: input.freeQuantity });
        }
      } else {
        add.push(input);
      }
    }
    for (const line of paid) if (!seen.has(line.id)) remove.push(line);
    if (!remove.length && !add.length) fail('Nothing was changed', 409);
    const pendingBefore = paise((await repo.one(db, `SELECT COALESCE(sum(${remainingValueSql('x')}),0) AS v FROM wholesale_order_lines x WHERE x.business_id=$1 AND x.order_id=$2`, [business.id, order.id])).v);
    // Take off what is unsent on removed lines and on their free goods.
    const removeIds = remove.map((l) => l.id);
    const freeIds = current.filter((l) => l.free_of_line_id && removeIds.includes(l.free_of_line_id) && milli(l.remaining) > 0).map((l) => l.id);
    if (removeIds.length) {
      await db.query(`UPDATE wholesale_order_lines x SET closed_quantity=x.closed_quantity+${remainingSql('x')} WHERE x.business_id=$1 AND x.id=ANY($2::bigint[])`, [business.id, [...removeIds, ...freeIds]]);
    }
    const added = [];
    for (const input of add) {
      const line = await priceLine(db, business, ctx, input);
      added.push(...(await insertLines(db, business, order.id, line)));
    }
    const left = await repo.one(db, `SELECT COALESCE(sum(${remainingSql('x')}),0) AS remaining,COALESCE(sum(${remainingValueSql('x')}),0) AS value
      FROM wholesale_order_lines x WHERE x.business_id=$1 AND x.order_id=$2`, [business.id, order.id]);
    if (milli(left.remaining) === 0) fail(order.status === 'open' ? 'Nothing would be left on this order. Cancel the order instead.' : 'Nothing would be left to send. Close the back-order instead.', 409);
    const pendingAfter = paise(left.value);
    if (pendingAfter > pendingBefore) await checkCreditLimit(db, business, contact, pendingAfter, order.id);
    let hold = null;
    if (added.length && pendingAfter > pendingBefore) hold = await credit.checkHold(db, business, contact, release);
    const expectedOn = body.expectedOn === undefined ? order.expected_on : body.expectedOn ? core.dateText(body.expectedOn, 'Expected delivery date') : null;
    const notes = body.notes === undefined ? order.notes : v.optionalString(body.notes, 'Notes', 500);
    await db.query('UPDATE wholesale_orders SET expected_on=$3,notes=$4 WHERE business_id=$1 AND id=$2', [business.id, order.id, expectedOn, notes]);
    const saved = await revalue(db, business, order.id);
    await db.query(`INSERT INTO wholesale_order_edits(business_id,order_id,reason,removed_line_ids,added_line_ids,total_before,total_after,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [business.id, order.id, reason, [...removeIds, ...freeIds], added, order.total, saved.total, requestKey, hash, user.id]);
    if (hold) await credit.recordRelease(db, business, user, order, contact, hold, release);
    await repo.audit(db, business.id, user.id, 'sales_order.edited', order.id, { orderNo: order.order_no, reason, totalBefore: order.total, totalAfter: saved.total,
      removed: remove.map((l) => ({ id: l.id, label: l.label, unsent: l.remaining })), added: added.length });
    await repo.event(db, business.id, user.id, 'sales_order.edited', 'sales_order', order.id, { orderNo: order.order_no, totalBefore: order.total, totalAfter: saved.total,
      removedLineIds: [...removeIds, ...freeIds], addedLineIds: added });
    return saved;
  });
}

// Drops what is left of one line (and its free goods) — the odd remainder
// that will not be sent.
async function closeLine(business, user, orderId, lineId, body) {
  await access.require(business, 'sales_orders.cancel');
  const reason = v.requiredString(body.reason, 'Reason', 300);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const order = await repo.one(db, 'SELECT * FROM wholesale_orders WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(orderId)]);
    if (!order) fail('Order not found', 404);
    if (!['open', 'part_dispatched'].includes(order.status)) fail(`This order is already ${order.status.replace('_', ' ')}`, 409);
    const line = await repo.one(db, `SELECT x.*,${remainingSql('x')} AS remaining FROM wholesale_order_lines x WHERE x.business_id=$1 AND x.order_id=$2 AND x.id=$3 FOR UPDATE`,
      [business.id, order.id, id(lineId, 'Order line')]);
    if (!line) fail('Order line not found', 404);
    if (milli(line.remaining) <= 0) fail('Nothing is left to send on that line', 409);
    await db.query(`UPDATE wholesale_order_lines x SET closed_quantity=x.closed_quantity+${remainingSql('x')}
      WHERE x.business_id=$1 AND x.order_id=$2 AND (x.id=$3 OR x.free_of_line_id=$3) AND ${remainingSql('x')}>0`, [business.id, order.id, line.id]);
    const left = await repo.one(db, `SELECT COALESCE(sum(${remainingSql('x')}),0) AS remaining FROM wholesale_order_lines x WHERE x.business_id=$1 AND x.order_id=$2`, [business.id, order.id]);
    let saved = order;
    if (milli(left.remaining) === 0) {
      const anySent = await repo.one(db, 'SELECT EXISTS (SELECT 1 FROM wholesale_dispatches WHERE business_id=$1 AND order_id=$2) AS sent', [business.id, order.id]);
      const status = anySent.sent ? 'closed' : 'cancelled';
      saved = await repo.one(db, 'UPDATE wholesale_orders SET status=$3,closed_by=$4,closed_at=now(),close_reason=$5 WHERE business_id=$1 AND id=$2 RETURNING *',
        [business.id, order.id, status, user.id, reason]);
    }
    await repo.audit(db, business.id, user.id, 'sales_order.line_closed', order.id, { orderNo: order.order_no, line: line.label, dropped: line.remaining, reason });
    await repo.event(db, business.id, user.id, 'sales_order.line_closed', 'sales_order', order.id, { orderNo: order.order_no, orderLineId: line.id, dropped: line.remaining, reason });
    return { ...saved, closed_line: line.id };
  });
}

async function orderDetail(business, orderId) {
  await access.require(business, 'sales_orders.view');
  const order = await repo.one(repo.pool, `SELECT o.*,l.name AS location_name,s.name AS salesperson_name,r.name AS route_name,b.name AS beat_name,
    c.phone AS contact_phone,c.gstin AS contact_gstin,c.credit_limit,c.address AS contact_address,u.name AS created_by_name
    FROM wholesale_orders o JOIN business_locations l ON l.business_id=o.business_id AND l.id=o.location_id
    JOIN business_contacts c ON c.business_id=o.business_id AND c.id=o.contact_id JOIN users u ON u.id=o.created_by
    LEFT JOIN wholesale_salespeople s ON s.business_id=o.business_id AND s.id=o.salesperson_id
    LEFT JOIN wholesale_routes r ON r.business_id=o.business_id AND r.id=o.route_id
    LEFT JOIN wholesale_beats b ON b.business_id=o.business_id AND b.id=o.beat_id
    WHERE o.business_id=$1 AND o.id=$2`, [business.id, id(orderId)]);
  if (!order) fail('Order not found', 404);
  const [lines, dispatches, edits, releases] = await Promise.all([
    repo.all(repo.pool, `SELECT x.*,${remainingSql('x')} AS remaining,${remainingValueSql('x')} AS remaining_value,s.code AS sku_code,s.tracking,sc.name AS scheme_name,
      COALESCE((SELECT sum(lot.quantity) FROM business_stock_lots lot WHERE lot.business_id=x.business_id AND lot.sku_id=x.sku_id AND lot.location_id=$3
        AND (lot.expires_on IS NULL OR lot.expires_on>=(now() AT TIME ZONE $4)::date)),0) AS available,
      EXISTS (SELECT 1 FROM wholesale_order_edits e WHERE e.business_id=x.business_id AND e.order_id=x.order_id AND x.id=ANY(e.removed_line_ids)) AS removed_by_edit
      FROM wholesale_order_lines x JOIN catalog_skus s ON s.business_id=x.business_id AND s.id=x.sku_id
      LEFT JOIN wholesale_schemes sc ON sc.business_id=x.business_id AND sc.id=x.scheme_id
      WHERE x.business_id=$1 AND x.order_id=$2 ORDER BY COALESCE(x.free_of_line_id,x.id),x.id`, [business.id, order.id, order.location_id, business.timezone]),
    repo.all(repo.pool, `SELECT d.*,doc.document_no,doc.total,doc.created_at AS invoiced_at,u.name AS created_by_name,
      COALESCE((SELECT json_agg(json_build_object('order_line_id',dl.order_line_id,'quantity',dl.quantity,'lot_code',bl.lot_code,
        'entered_unit',bl.entered_unit,'entered_quantity',bl.entered_quantity,'expires_on',lot.expires_on,'document_line_id',bl.id,'label',bl.label,'unit',bl.unit) ORDER BY dl.id)
        FROM wholesale_dispatch_lines dl JOIN business_document_lines bl ON bl.business_id=dl.business_id AND bl.id=dl.document_line_id
        LEFT JOIN business_stock_lots lot ON lot.business_id=bl.business_id AND lot.sku_id=bl.sku_id AND lot.location_id=doc.location_id AND lot.lot_code=bl.lot_code
        WHERE dl.business_id=d.business_id AND dl.dispatch_id=d.id),'[]') AS lines,
      rt.return_no
      FROM wholesale_dispatches d JOIN business_documents doc ON doc.business_id=d.business_id AND doc.id=d.document_id
      JOIN users u ON u.id=d.created_by LEFT JOIN business_returns rt ON rt.business_id=d.business_id AND rt.id=d.return_id
      WHERE d.business_id=$1 AND d.order_id=$2 ORDER BY d.id`, [business.id, order.id]),
    repo.all(repo.pool, `SELECT e.id,e.reason,e.total_before,e.total_after,e.created_at,u.name AS created_by_name FROM wholesale_order_edits e
      JOIN users u ON u.id=e.created_by WHERE e.business_id=$1 AND e.order_id=$2 ORDER BY e.id`, [business.id, order.id]),
    repo.all(repo.pool, `SELECT h.id,h.overdue,h.overdue_days,h.reason,h.created_at,a.name AS released_by_name,q.name AS requested_by_name FROM wholesale_hold_releases h
      JOIN users a ON a.id=h.released_by JOIN users q ON q.id=h.requested_by WHERE h.business_id=$1 AND h.order_id=$2 ORDER BY h.id`, [business.id, order.id]),
  ]);
  return { ...order, lines, dispatches, edits, hold_releases: releases };
}

// Batches to send for one order line: the ones named, or oldest expiry
// first (FEFO). Never an expired batch, never more than a batch holds.
async function pickLots(db, business, order, line, quantityMilli, chosen) {
  const today = await repo.one(db, 'SELECT (now() AT TIME ZONE $1)::date::text AS day', [business.timezone]);
  const usable = await repo.all(db, `SELECT * FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND location_id=$3 AND quantity>0
    AND (expires_on IS NULL OR expires_on>=$4::date) ORDER BY expires_on NULLS LAST, id FOR UPDATE`, [business.id, line.sku_id, order.location_id, today.day]);
  const picks = [];
  if (chosen) {
    let total = 0;
    for (const entry of chosen) {
      const lot = usable.find((l) => l.id === id(entry?.lotId, 'Batch'));
      if (!lot) fail(`That batch of ${line.label} is not usable stock at ${order.location_name}`, 409);
      const take = milli(core.decimal(entry.quantity, 'Batch quantity', 3, 0.001, 100000));
      if (take > milli(lot.quantity)) fail(`Batch ${lot.lot_code || 'stock'} of ${line.label} holds only ${Number(lot.quantity)}`, 409);
      picks.push({ lot, quantity: take }); total += take;
    }
    if (total !== quantityMilli) fail(`The batches chosen for ${line.label} add up to ${qty(total)}, not ${qty(quantityMilli)}`);
    return picks;
  }
  let left = quantityMilli;
  for (const lot of usable) {
    if (left <= 0) break;
    const take = Math.min(left, milli(lot.quantity));
    picks.push({ lot, quantity: take }); left -= take;
  }
  if (left > 0) {
    const available = quantityMilli - left;
    fail(`Only ${qty(available).replace(/\.?0+$/, '')} ${line.unit} of ${line.label} is in usable stock at ${order.location_name}; dispatch that much and leave the rest as a back-order.`, 409);
  }
  return picks;
}

// Transport and e-way bill details of a dispatch.
function readTransport(body) {
  const ewayBillNo = v.optionalString(body.ewayBillNo, 'E-way bill number', 14)?.replace(/\s+/g, '') || null;
  if (ewayBillNo && !/^[0-9]{12}$/.test(ewayBillNo)) fail('An e-way bill number has 12 digits');
  const ewayBillDate = body.ewayBillDate ? core.dateText(body.ewayBillDate, 'E-way bill date') : null;
  if (ewayBillNo && !ewayBillDate) fail('Enter the e-way bill date with its number');
  const transporterId = v.optionalString(body.transporterId, 'Transporter ID', 15)?.toUpperCase() || null;
  if (transporterId && !/^[0-9A-Z]{15}$/.test(transporterId)) fail('The transporter ID (GSTIN or TRANSIN) has 15 letters and digits');
  const distance = body.distanceKm === undefined || body.distanceKm === null || body.distanceKm === '' ? null : Number(body.distanceKm);
  if (distance !== null && (!Number.isInteger(distance) || distance < 0 || distance > 4000)) fail('Distance must be whole kilometres up to 4000');
  return {
    vehicleNo: v.optionalString(body.vehicleNo, 'Vehicle number', 20)?.toUpperCase() || null,
    driverName: v.optionalString(body.driverName, 'Driver', 100), helperName: v.optionalString(body.helperName, 'Helper', 100),
    transporterName: v.optionalString(body.transporterName, 'Transporter', 150), transporterId,
    lrNo: v.optionalString(body.lrNo, 'LR / docket number', 50), ewayBillNo, ewayBillDate, distanceKm: distance,
  };
}

// One dispatch inside the caller's transaction (also used by a delivery run).
// body: { lines: [{ orderLineId, quantity, unit?, lots? }], notes?, transport fields }
async function dispatchInTransaction(db, business, user, orderId, body, { requestKey, hash, runId = null }) {
  const inputs = v.requiredArray(body.lines, 'Lines to dispatch');
  if (!inputs.length || inputs.length > 100) fail('Dispatch between 1 and 100 lines');
  if (new Set(inputs.map((l) => id(l?.orderLineId, 'Order line'))).size !== inputs.length) fail('Each order line may appear once');
  const transport = readTransport(body);
  const notesText = v.optionalString(body.notes, 'Notes', 300);
  const old = await repo.one(db, 'SELECT * FROM wholesale_dispatches WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
  if (old) {
    if (old.request_hash !== hash || old.order_id !== id(orderId)) fail('This request key was already used for different data', 409);
    return { dispatch: old, document: await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2', [business.id, old.document_id]) };
  }
  const order = await repo.one(db, `SELECT o.*,l.name AS location_name FROM wholesale_orders o JOIN business_locations l ON l.business_id=o.business_id AND l.id=o.location_id
    WHERE o.business_id=$1 AND o.id=$2 FOR UPDATE OF o`, [business.id, id(orderId)]);
  if (!order) fail('Order not found', 404);
  if (!['open', 'part_dispatched'].includes(order.status)) fail(`Order ${order.order_no} is already ${order.status.replace('_', ' ')}`, 409);
  const pieces = [];
  for (const input of inputs) {
    const line = await repo.one(db, `SELECT x.*,u.decimals AS unit_decimals,u.name AS unit_name,s.tax_rate AS tax_rate_now FROM wholesale_order_lines x
      JOIN business_units u ON u.business_id=x.business_id AND u.code=x.unit
      JOIN catalog_skus s ON s.business_id=x.business_id AND s.id=x.sku_id
      WHERE x.business_id=$1 AND x.order_id=$2 AND x.id=$3 FOR UPDATE OF x`, [business.id, order.id, id(input.orderLineId, 'Order line')]);
    if (!line) fail('Order line not found', 404);
    // The quantity may be typed in the line's pack or in the stock unit.
    let quantityMilli;
    if (input.unit && input.unit !== line.unit) {
      if (input.unit !== line.entered_unit) fail(`${line.label} was ordered in ${line.entered_unit || line.unit}; dispatch it in that or in ${line.unit}`);
      const packs = core.decimal(input.quantity, 'Quantity', 3, 0.001, 100000);
      const base = BigInt(milli(packs)) * BigInt(Math.round(Number(line.unit_factor) * 1e6));
      if (base % 1000000n !== 0n) fail(`That is not an exact quantity of ${line.label}`);
      quantityMilli = Number(base / 1000000n);
    } else {
      quantityMilli = milli(core.decimal(input.quantity, 'Quantity', 3, 0.001, 100000));
    }
    core.requiredDecimals(quantityMilli / 1000, { decimals: line.unit_decimals, name: line.unit_name }, 'Quantity');
    const remaining = milli(line.quantity) - milli(line.dispatched_quantity) - milli(line.closed_quantity);
    if (quantityMilli > remaining) fail(`Only ${qty(remaining).replace(/\.?0+$/, '')} ${line.unit} of ${line.label} is left to send on ${order.order_no}`, 409);
    const chosen = input.lots === undefined || input.lots === null ? null : v.requiredArray(input.lots, 'Batches');
    const picks = await pickLots(db, business, order, line, quantityMilli, chosen);
    // Order prices, allocated by quantity: each piece takes its cumulative
    // share of the order line, so sending everything bills the order's
    // amount. Each invoice line is then complete in itself: GST is worked
    // out on that line's own value to the paisa (prices including GST: the
    // GST inside the line's gross), and the rate is the line's value per
    // unit to four places. With prices before GST the line amounts add up
    // to the order exactly; the GST, rounded per invoice line as the law
    // requires, can differ from the order's estimate by at most 1 paisa
    // for each extra invoice line the order was split into. GST is at the
    // item's rate on the day of the invoice: after a GST rate change, a price
    // including GST keeps its total and one before GST its taxable value.
    const rate = Number(line.tax_rate_now);
    const invoiced = await repo.one(db, `SELECT COALESCE(sum(bl.net),0) AS net,COALESCE(sum(bl.tax),0) AS tax FROM wholesale_dispatch_lines dl
      JOIN business_document_lines bl ON bl.business_id=dl.business_id AND bl.id=dl.document_line_id
      WHERE dl.business_id=$1 AND dl.order_line_id=$2`, [business.id, line.id]);
    let doneMilli = milli(line.dispatched_quantity), doneNet = paise(invoiced.net), doneTax = paise(invoiced.tax);
    const ordered = BigInt(milli(line.quantity));
    const share = (amount, upTo) => roundedDivide(BigInt(paise(amount)) * BigInt(upTo), ordered);
    const factorMicro = line.unit_factor ? Math.round(Number(line.unit_factor) * 1e6) : null;
    const pack = line.entered_unit ? await repo.one(db, 'SELECT quantity_in_base FROM catalog_sku_units WHERE business_id=$1 AND sku_id=$2 AND unit_code=$3 AND active',
      [business.id, line.sku_id, line.entered_unit]) : null;
    for (const pick of picks) {
      const upTo = doneMilli + pick.quantity;
      let net, tax;
      if (order.tax_mode === 'inclusive') {
        // The gross (what the customer pays) is shared; GST is inside it.
        const gross = roundedDivide((BigInt(paise(line.net)) + BigInt(paise(line.tax))) * BigInt(upTo), ordered) - (doneNet + doneTax);
        net = core.inclusiveNet(gross, rate); tax = gross - net;
      } else {
        net = share(line.net, upTo) - doneNet; tax = core.lineTax(net, rate);
      }
      doneMilli = upTo; doneNet += net; doneTax += tax;
      // Whole packs keep the pack on the invoice (when the pack size is unchanged).
      const wholePacks = factorMicro && pack && Math.round(Number(pack.quantity_in_base) * 1e6) === factorMicro
        && (BigInt(pick.quantity) * 1000000n) % (BigInt(factorMicro) * 1000n) === 0n;
      pieces.push({ line, rate, lot: pick.lot, quantityMilli: pick.quantity, net, tax,
        entered: wholePacks ? { unit: line.entered_unit, quantity: Number((BigInt(pick.quantity) * 1000000n) / BigInt(factorMicro)) / 1000 } : null });
    }
  }
  // The invoice: an ordinary sale, posted by the core with the order's prices.
  const documentBody = {
    kind: 'sale', locationId: order.location_id, contactId: order.contact_id,
    notes: [`Order ${order.order_no}`, transport.vehicleNo && `vehicle ${transport.vehicleNo}`, notesText].filter(Boolean).join(' · ').slice(0, 500),
    lines: pieces.map((p) => ({ skuId: p.line.sku_id, lotCode: p.lot.lot_code, ...(p.entered ? { unit: p.entered.unit, quantity: String(p.entered.quantity) } : { quantity: qty(p.quantityMilli) }) })),
  };
  // The rate shown on each invoice line is its own value per stock unit (4 places).
  const fixed = pieces.map((p) => ({ price: Number(((p.net / 100) / (p.quantityMilli / 1000)).toFixed(4)), net: p.net, tax: p.tax, taxRate: p.rate.toFixed(2),
    enteredPrice: p.entered ? paise(p.line.entered_unit_price) : null, priceRuleId: p.line.price_rule_id }));
  const document = await core.postDocument(db, business, user, documentBody, { kind: 'sale', requestKey, hash, lines: documentBody.lines, paidNow: null, fixed });
  // A hardware shop's order may name a fitter: each invoice earns them their commission.
  if (business.business_type === 'hardware') await require('../../hardware/services/hardwareFitters.service').orderInvoice(db, business, user, order.id, document);
  // Place of supply for a buyer without a GSTIN: their state from the trade details.
  const state = await repo.one(db, 'SELECT state_code FROM wholesale_customer_profiles WHERE business_id=$1 AND contact_id=$2', [business.id, order.contact_id]);
  if (state?.state_code && !document.buyer_gstin && document.place_of_supply !== state.state_code) {
    await db.query('UPDATE business_documents SET place_of_supply=$3 WHERE business_id=$1 AND id=$2', [business.id, document.id, state.state_code]);
    document.place_of_supply = state.state_code;
  }
  const documentLines = await repo.all(db, 'SELECT id FROM business_document_lines WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, document.id]);
  if (documentLines.length !== pieces.length) throw new Error('Dispatch lines and invoice lines differ');
  const saved = await repo.one(db, `INSERT INTO wholesale_dispatches(business_id,order_id,document_id,vehicle_no,notes,request_key,request_hash,created_by,
    run_id,driver_name,helper_name,transporter_name,transporter_id,lr_no,eway_bill_no,eway_bill_date,distance_km)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`, [business.id, order.id, document.id, transport.vehicleNo,
    v.optionalString(body.notes, 'Notes', 500), requestKey, hash, user.id, runId, transport.driverName, transport.helperName, transport.transporterName,
    transport.transporterId, transport.lrNo, transport.ewayBillNo, transport.ewayBillDate, transport.distanceKm]);
  // The delivery challan that travels with the goods: its own series per location and year.
  const challan = await numbering.nextNumber(db, business.id, order.location_id, 'delivery_challan', user.id);
  await db.query('UPDATE wholesale_dispatches SET challan_no=$3,challan_series_id=$4 WHERE business_id=$1 AND id=$2', [business.id, saved.id, challan.number, challan.seriesId]);
  saved.challan_no = challan.number; saved.challan_series_id = challan.seriesId;
  const sent = new Map();
  for (const [index, piece] of pieces.entries()) {
    await db.query('INSERT INTO wholesale_dispatch_lines(business_id,dispatch_id,order_line_id,document_line_id,quantity) VALUES($1,$2,$3,$4,$5)',
      [business.id, saved.id, piece.line.id, documentLines[index].id, qty(piece.quantityMilli)]);
    sent.set(piece.line.id, (sent.get(piece.line.id) || 0) + piece.quantityMilli);
  }
  for (const [lineId, quantityMilli] of sent) {
    await db.query('UPDATE wholesale_order_lines SET dispatched_quantity=dispatched_quantity+$3 WHERE business_id=$1 AND id=$2', [business.id, lineId, qty(quantityMilli)]);
  }
  const left = await repo.one(db, `SELECT COALESCE(sum(${remainingSql('x')}),0) AS remaining FROM wholesale_order_lines x WHERE x.business_id=$1 AND x.order_id=$2`, [business.id, order.id]);
  const status = milli(left.remaining) === 0 ? 'dispatched' : 'part_dispatched';
  await db.query('UPDATE wholesale_orders SET status=$3 WHERE business_id=$1 AND id=$2', [business.id, order.id, status]);
  await repo.audit(db, business.id, user.id, 'sales_order.dispatched', order.id, { orderNo: order.order_no, documentNo: document.document_no, status, runId });
  await repo.event(db, business.id, user.id, 'sales_order.dispatched', 'sales_order', order.id, {
    orderNo: order.order_no, dispatchId: saved.id, documentId: document.id, documentNo: document.document_no, status, runId,
    lines: pieces.map((p) => ({ orderLineId: p.line.id, skuId: p.line.sku_id, lotCode: p.lot.lot_code || null, quantity: qty(p.quantityMilli) })),
  });
  return { dispatch: saved, document, status, order };
}

// body: { requestKey, lines: [{ orderLineId, quantity, unit?, lots?: [{ lotId, quantity }] }], notes?,
//   vehicleNo?, driverName?, helperName?, transporterName?, transporterId?, lrNo?, ewayBillNo?, ewayBillDate?, distanceKm? }
async function dispatch(business, user, orderId, body) {
  await access.require(business, 'sales_orders.approve');
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf(body);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const result = await dispatchInTransaction(db, business, user, orderId, body, { requestKey, hash });
    return { dispatch: result.dispatch, document: result.document, status: result.status };
  });
}

// Cancels an order nothing was sent on, or closes what is left of one that
// was partly sent (the back-order is dropped). A reason is required.
async function closeOrder(business, user, orderId, body) {
  await access.require(business, 'sales_orders.cancel');
  const reason = v.requiredString(body.reason, 'Reason', 300);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const order = await repo.one(db, 'SELECT * FROM wholesale_orders WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(orderId)]);
    if (!order) fail('Order not found', 404);
    if (!['open', 'part_dispatched'].includes(order.status)) fail(`This order is already ${order.status.replace('_', ' ')}`, 409);
    const status = order.status === 'open' ? 'cancelled' : 'closed';
    const lines = await repo.all(db, `UPDATE wholesale_order_lines x SET closed_quantity=x.closed_quantity+${remainingSql('x')}
      WHERE x.business_id=$1 AND x.order_id=$2 AND ${remainingSql('x')}>0 RETURNING x.id,x.closed_quantity`, [business.id, order.id]);
    const saved = await repo.one(db, `UPDATE wholesale_orders SET status=$3,closed_by=$4,closed_at=now(),close_reason=$5 WHERE business_id=$1 AND id=$2 RETURNING *`,
      [business.id, order.id, status, user.id, reason]);
    await repo.audit(db, business.id, user.id, `sales_order.${status}`, order.id, { orderNo: order.order_no, reason, lines: lines.length });
    await repo.event(db, business.id, user.id, `sales_order.${status}`, 'sales_order', order.id, { orderNo: order.order_no, reason });
    return saved;
  });
}

// --- Collections with salesperson and route -------------------------------------------

// The shared collection, plus who collected it and on which route.
async function collect(business, user, body) {
  const salespersonId = optionalId(body.salespersonId, 'Salesperson');
  const routeId = optionalId(body.routeId, 'Route');
  const { salespersonId: _s, routeId: _r, ...shared } = body;
  const extend = (salespersonId || routeId) ? async (db, collection) => {
    if (!business.modules.includes('sales_orders')) fail('Salespeople and routes need Sales orders & dispatch switched on', 403);
    if (salespersonId && !(await repo.one(db, 'SELECT id FROM wholesale_salespeople WHERE business_id=$1 AND id=$2', [business.id, salespersonId]))) fail('Salesperson not found', 404);
    if (routeId && !(await repo.one(db, 'SELECT id FROM wholesale_routes WHERE business_id=$1 AND id=$2', [business.id, routeId]))) fail('Route not found', 404);
    await db.query('INSERT INTO wholesale_collection_details(business_id,collection_id,salesperson_id,route_id) VALUES($1,$2,$3,$4)', [business.id, collection.id, salespersonId, routeId]);
  } : undefined;
  // The request hash covers the whole body, so a repeat with another salesperson is a conflict.
  return receivables.createCollection(business, user, { ...shared, ...(extend ? { salespersonId, routeId } : {}) }, { extend });
}

// --- Reports -----------------------------------------------------------------------------

// Sales, orders and collections in a period by customer, salesperson or
// route; outstanding now by route or salesperson. Sales are invoices dated
// in the period less returns dated in the period; an invoice belongs to the
// salesperson and route of the order it was dispatched from ("Counter sales"
// when it came from no order).
async function reports(business, query) {
  await access.require(business, 'reports.view');
  const group = v.requiredEnum(query.group, 'Report', ['customer', 'salesperson', 'route', 'collections', 'outstanding']);
  if (group === 'outstanding' || group === 'collections') await access.require(business, 'receivables.view');
  else await access.require(business, 'sales.view');
  // Salesperson and route figures come from the wholesale module's own records.
  if (['salesperson', 'route', 'outstanding'].includes(group)) await access.require(business, 'sales_orders.view');
  if (group === 'outstanding') return outstandingBy(business, query);
  const from = core.dateText(query.from, 'From date'), to = core.dateText(query.to, 'To date');
  if (to < from || Date.parse(to) - Date.parse(from) > 366 * 86400000) fail('Choose a date range of up to 367 days');
  const params = [business.id, from, to, business.timezone];
  const inPeriod = (column) => `(${column} AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date`;
  if (group === 'collections') {
    const rows = await repo.all(repo.pool, `SELECT (k.created_at AT TIME ZONE $4)::date::text AS day,k.method,COALESCE(s.name,'—') AS salesperson,
      COALESCE(r.name,'—') AS route,count(*)::int AS receipts,sum(k.amount) AS amount,
      sum(COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=k.business_id AND p.collection_id=k.id),0)) AS applied
      FROM business_collections k LEFT JOIN wholesale_collection_details wd ON wd.business_id=k.business_id AND wd.collection_id=k.id
      LEFT JOIN wholesale_salespeople s ON s.business_id=wd.business_id AND s.id=wd.salesperson_id
      LEFT JOIN wholesale_routes r ON r.business_id=wd.business_id AND r.id=wd.route_id
      WHERE k.business_id=$1 AND ${inPeriod('k.created_at')} GROUP BY 1,2,3,4 ORDER BY 1 DESC,2,3`, params);
    const direct = await repo.one(repo.pool, `SELECT count(*)::int AS payments,COALESCE(sum(p.amount),0) AS amount FROM business_payments p
      JOIN business_documents d ON d.business_id=p.business_id AND d.id=p.document_id
      WHERE p.business_id=$1 AND d.kind='sale' AND p.collection_id IS NULL AND ${inPeriod('p.created_at')}`, params);
    return { group, from, to, rows, paidOnBills: direct };
  }
  const col = { customer: 'contact_id', salesperson: 'salesperson_id', route: 'route_id' }[group];
  const label = {
    customer: "COALESCE((SELECT name FROM business_contacts x WHERE x.business_id=$1 AND x.id=keys.k),'Walk-in / counter')",
    salesperson: "COALESCE((SELECT name FROM wholesale_salespeople x WHERE x.business_id=$1 AND x.id=keys.k),'Counter sales (no order)')",
    route: "COALESCE((SELECT name FROM wholesale_routes x WHERE x.business_id=$1 AND x.id=keys.k),'Counter sales (no order)')",
  }[group];
  const rows = await repo.all(repo.pool, `WITH inv AS (
      SELECT d.id,d.total,d.created_at,d.contact_id,o.salesperson_id,o.route_id FROM business_documents d
      LEFT JOIN wholesale_dispatches w ON w.business_id=d.business_id AND w.document_id=d.id
      LEFT JOIN wholesale_orders o ON o.business_id=w.business_id AND o.id=w.order_id
      WHERE d.business_id=$1 AND d.kind='sale'),
    sales AS (
      SELECT COALESCE(inv.${col},0) AS k,count(*)::int AS invoices,sum(inv.total) AS invoiced,0::numeric AS returned
      FROM inv WHERE ${inPeriod('inv.created_at')} GROUP BY 1
      UNION ALL
      SELECT COALESCE(inv.${col},0),0,0,sum(rt.total) FROM business_returns rt JOIN inv ON inv.id=rt.document_id
      WHERE rt.business_id=$1 AND ${inPeriod('rt.created_at')} GROUP BY 1),
    orders AS (
      SELECT COALESCE(o.${col},0) AS k,count(*)::int AS orders,sum(o.total) AS ordered
      FROM wholesale_orders o WHERE o.business_id=$1 AND ${inPeriod('o.created_at')} GROUP BY 1),
    keys AS (SELECT k FROM sales UNION SELECT k FROM orders)
    SELECT keys.k AS id,${label} AS name,
      COALESCE((SELECT sum(invoices) FROM sales WHERE sales.k=keys.k),0)::int AS invoices,
      COALESCE((SELECT sum(invoiced) FROM sales WHERE sales.k=keys.k),0) AS invoiced,
      COALESCE((SELECT sum(returned) FROM sales WHERE sales.k=keys.k),0) AS returned,
      COALESCE((SELECT sum(invoiced)-sum(returned) FROM sales WHERE sales.k=keys.k),0) AS net_sales,
      COALESCE((SELECT orders FROM orders WHERE orders.k=keys.k),0) AS orders,
      COALESCE((SELECT ordered FROM orders WHERE orders.k=keys.k),0) AS ordered
    FROM keys ORDER BY net_sales DESC, name`, params);
  return { group, from, to, rows };
}

// Outstanding now, summed by the route or salesperson of each customer's beat.
async function outstandingBy(business, query) {
  const by = v.optionalEnum(query.by, 'By', ['route', 'salesperson'], 'route');
  const column = by === 'route' ? 'b.route_id' : 'b.salesperson_id';
  const label = by === 'route' ? "COALESCE((SELECT name FROM wholesale_routes x WHERE x.business_id=$1 AND x.id=g.k),'No route')"
    : "COALESCE((SELECT name FROM wholesale_salespeople x WHERE x.business_id=$1 AND x.id=g.k),'No salesperson')";
  const rows = await repo.all(repo.pool, `WITH a AS (${receivables.ageingSql}),
    g AS (SELECT COALESCE(${column},0) AS k,count(*) FILTER (WHERE a.balance>0)::int AS customers,sum(a.balance) FILTER (WHERE a.balance>0) AS balance,
      sum(a.days_0_30) AS days_0_30,sum(a.days_31_60) AS days_31_60,sum(a.days_61_90) AS days_61_90,sum(a.days_over_90) AS days_over_90,sum(a.overdue) AS overdue
      FROM a LEFT JOIN wholesale_customer_beats cb ON cb.business_id=$1 AND cb.contact_id=a.contact_id
      LEFT JOIN wholesale_beats b ON b.business_id=cb.business_id AND b.id=cb.beat_id GROUP BY 1)
    SELECT g.k AS id,${label} AS name,g.customers,COALESCE(g.balance,0) AS balance,g.days_0_30,g.days_31_60,g.days_61_90,g.days_over_90,g.overdue
    FROM g WHERE g.customers>0 ORDER BY balance DESC`, [business.id, null]);
  return { group: 'outstanding', by, rows };
}

// Customers on a route (for the outstanding list's route filter).
async function routeCustomers(business, routeId) {
  const rows = await repo.all(repo.pool, `SELECT cb.contact_id FROM wholesale_customer_beats cb JOIN wholesale_beats b ON b.business_id=cb.business_id AND b.id=cb.beat_id
    WHERE cb.business_id=$1 AND b.route_id=$2`, [business.id, id(routeId, 'Route')]);
  return rows.map((r) => r.contact_id);
}

module.exports = { saveSalesperson, salespersonLogins, saveRoute, saveBeat, setCustomerBeat, createOrder, placeOrder, editOrder, closeLine, orderDetail, dispatch, dispatchInTransaction,
  readTransport, closeOrder, collect, reports, routeCustomers, remainingSql, remainingValueSql };
