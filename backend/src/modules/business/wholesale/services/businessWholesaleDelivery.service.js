const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const returns = require('../../core/services/businessReturns.service');
const numbering = require('../../core/services/businessNumbering');
const wholesale = require('./businessWholesale.service');

// Getting orders out of the godown and to the shops (pro pass D-04, D-05, D-10).
//
//   Pick list     every item wanted by the orders chosen, in cases and
//                 pieces, against the stock in the godown and the batches
//                 to take first (earliest expiry first).
//   Delivery run  one van, one driver: the orders chosen are dispatched
//                 together (each its own tax invoice; what is not in stock
//                 stays a back-order), and the load sheet lists every item
//                 and every invoice with what to collect and a signature
//                 column.
//   Delivery      each dispatch is out for delivery until it is marked
//                 delivered, part returned or refused. Goods that come back
//                 in the van are a sales return (stock goes back in, the
//                 invoice is credited); the order does not reopen — take a
//                 new order if the shop still wants them.
//   Transport     vehicle, driver, transporter and e-way bill on a dispatch
//                 (filled in later too, once the e-way bill is generated).

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const optionalId = (value, name) => (value === undefined || value === null || value === '' ? null : id(value, name));
const milli = (value) => Math.round(Number(value) * 1000);
const qty = (m) => (m / 1000).toFixed(3);
const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
const derivedKey = (base, n) => {
  const hex = crypto.createHash('sha256').update(`${base}:run:${n}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const { remainingSql } = wholesale;

repo.addLists({
  'delivery-runs': { sql: `SELECT r.*,l.name AS location_name,rt.name AS route_name,u.name AS created_by_name,
      (SELECT count(*)::int FROM wholesale_dispatches d WHERE d.business_id=r.business_id AND d.run_id=r.id) AS invoices,
      (SELECT COALESCE(sum(doc.total),0) FROM wholesale_dispatches d JOIN business_documents doc ON doc.business_id=d.business_id AND doc.id=d.document_id
        WHERE d.business_id=r.business_id AND d.run_id=r.id) AS value,
      (SELECT count(*)::int FROM wholesale_dispatches d WHERE d.business_id=r.business_id AND d.run_id=r.id AND d.delivery_status='out_for_delivery') AS out_for_delivery
      FROM wholesale_delivery_runs r JOIN business_locations l ON l.business_id=r.business_id AND l.id=r.location_id
      LEFT JOIN wholesale_routes rt ON rt.business_id=r.business_id AND rt.id=r.route_id JOIN users u ON u.id=r.created_by WHERE r.business_id=$1`,
  search: ['vehicle_no', 'driver_name', 'route_name'], date: 'created_at', filters: { route: 'route_id', location: 'location_id' }, order: 'id DESC' },
  // Every dispatch (invoice) with its delivery state, for the delivery screen.
  dispatches: { sql: `SELECT d.id,d.order_id,d.document_id,d.run_id,d.vehicle_no,d.driver_name,d.helper_name,d.transporter_name,d.lr_no,d.eway_bill_no,d.eway_bill_date,
      d.distance_km,d.delivery_status,d.delivered_at,d.received_by,d.delivery_note,d.created_at,d.challan_no,o.order_no,o.contact_id,o.contact_name,o.route_id,r.name AS route_name,
      o.salesperson_id,doc.document_no,doc.total,doc.location_id,
      doc.total-COALESCE((SELECT sum(total) FROM business_returns x WHERE x.business_id=doc.business_id AND x.document_id=doc.id),0)
        -COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.business_id=doc.business_id AND p.document_id=doc.id),0)
        +COALESCE((SELECT sum(amount) FROM business_refunds f WHERE f.business_id=doc.business_id AND f.document_id=doc.id),0) AS to_collect
      FROM wholesale_dispatches d JOIN wholesale_orders o ON o.business_id=d.business_id AND o.id=d.order_id
      JOIN business_documents doc ON doc.business_id=d.business_id AND doc.id=d.document_id
      LEFT JOIN wholesale_routes r ON r.business_id=o.business_id AND r.id=o.route_id WHERE d.business_id=$1`,
  search: ['order_no', 'contact_name', 'document_no', 'vehicle_no', 'driver_name', 'eway_bill_no', 'challan_no', 'lr_no'], date: 'created_at',
  filters: { delivery: 'delivery_status', run: 'run_id', route: 'route_id', contact: 'contact_id' }, order: 'id DESC' },
});

// --- Pick list ---------------------------------------------------------------------

const readIds = (value, name) => {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',').filter(Boolean);
  if (!list.length || list.length > 60) fail(`Choose between 1 and 60 ${name}`);
  const ids = [...new Set(list.map((x) => id(x, name)))];
  return ids;
};

// Orders still to dispatch, each with what can go now and what is short.
async function dispatchBoard(business, query) {
  await access.require(business, 'sales_orders.view');
  const routeId = optionalId(query.route, 'Route');
  const beatDay = query.day === undefined || query.day === '' ? null : Number(query.day);
  if (beatDay !== null && !(Number.isInteger(beatDay) && beatDay >= 1 && beatDay <= 7)) fail('Day must be 1 (Monday) to 7 (Sunday)');
  const wantedBy = query.wantedBy ? core.dateText(query.wantedBy, 'Wanted by') : null;
  const locationId = optionalId(query.location, 'Location');
  const rows = await repo.all(repo.pool, `SELECT o.id,o.order_no,o.created_at,o.expected_on,o.contact_id,o.contact_name,o.status,o.location_id,l.name AS location_name,
      o.route_id,r.name AS route_name,o.beat_id,b.name AS beat_name,b.visit_day,o.salesperson_id,s.name AS salesperson_name,c.phone AS contact_phone,
      count(x.id)::int AS lines,
      COALESCE(sum(round((x.net+x.tax)*${remainingSql('x')}/x.quantity,2)),0) AS pending_value,
      count(x.id) FILTER (WHERE COALESCE(st.available,0)>=${remainingSql('x')})::int AS lines_ready,
      count(x.id) FILTER (WHERE COALESCE(st.available,0)<=0)::int AS lines_none
    FROM wholesale_orders o JOIN business_locations l ON l.business_id=o.business_id AND l.id=o.location_id
    JOIN business_contacts c ON c.business_id=o.business_id AND c.id=o.contact_id
    JOIN wholesale_order_lines x ON x.business_id=o.business_id AND x.order_id=o.id AND ${remainingSql('x')}>0
    LEFT JOIN LATERAL (SELECT sum(lot.quantity) AS available FROM business_stock_lots lot WHERE lot.business_id=x.business_id AND lot.sku_id=x.sku_id
      AND lot.location_id=o.location_id AND (lot.expires_on IS NULL OR lot.expires_on>=(now() AT TIME ZONE $2)::date)) st ON TRUE
    LEFT JOIN wholesale_routes r ON r.business_id=o.business_id AND r.id=o.route_id
    LEFT JOIN wholesale_beats b ON b.business_id=o.business_id AND b.id=o.beat_id
    LEFT JOIN wholesale_salespeople s ON s.business_id=o.business_id AND s.id=o.salesperson_id
    WHERE o.business_id=$1 AND o.status IN ('open','part_dispatched')
      AND ($3::bigint IS NULL OR o.route_id=$3) AND ($4::int IS NULL OR b.visit_day=$4) AND ($5::date IS NULL OR o.expected_on IS NULL OR o.expected_on<=$5)
      AND ($6::bigint IS NULL OR o.location_id=$6)
    GROUP BY o.id,l.name,r.name,b.name,b.visit_day,s.name,c.phone ORDER BY r.name NULLS LAST,b.name NULLS LAST,o.expected_on NULLS LAST,o.id LIMIT 200`,
  [business.id, business.timezone, routeId, beatDay, wantedBy, locationId]);
  return rows;
}

// The combined pick list of some orders: per item, what is wanted, what is
// in stock, the batches to take (earliest expiry first) and the orders.
async function pickList(business, query) {
  await access.require(business, 'sales_orders.view');
  const orderIds = readIds(query.orders, 'orders');
  const orders = await repo.all(repo.pool, `SELECT o.id,o.order_no,o.contact_name,o.location_id,l.name AS location_name,r.name AS route_name FROM wholesale_orders o
    JOIN business_locations l ON l.business_id=o.business_id AND l.id=o.location_id LEFT JOIN wholesale_routes r ON r.business_id=o.business_id AND r.id=o.route_id
    WHERE o.business_id=$1 AND o.id=ANY($2::bigint[]) AND o.status IN ('open','part_dispatched') ORDER BY o.id`, [business.id, orderIds]);
  if (orders.length !== orderIds.length) fail('Some of those orders are not waiting to be dispatched', 409);
  const locations = new Set(orders.map((o) => o.location_id));
  if (locations.size > 1) fail('Those orders go out from different godowns; pick one godown at a time');
  const locationId = orders[0].location_id;
  const items = await repo.all(repo.pool, `SELECT x.sku_id,s.code,s.label,s.unit,
      sum(${remainingSql('x')}) AS wanted,
      count(DISTINCT x.order_id)::int AS orders,
      (SELECT u.unit_code FROM catalog_sku_units u WHERE u.business_id=s.business_id AND u.sku_id=s.id AND u.active ORDER BY u.quantity_in_base DESC LIMIT 1) AS pack_unit,
      (SELECT u.quantity_in_base FROM catalog_sku_units u WHERE u.business_id=s.business_id AND u.sku_id=s.id AND u.active ORDER BY u.quantity_in_base DESC LIMIT 1) AS pack_factor,
      COALESCE((SELECT sum(lot.quantity) FROM business_stock_lots lot WHERE lot.business_id=s.business_id AND lot.sku_id=s.id AND lot.location_id=$3
        AND (lot.expires_on IS NULL OR lot.expires_on>=(now() AT TIME ZONE $4)::date)),0) AS available,
      COALESCE((SELECT json_agg(json_build_object('lot_code',lot.lot_code,'expires_on',lot.expires_on,'quantity',lot.quantity) ORDER BY lot.expires_on NULLS LAST,lot.id)
        FROM business_stock_lots lot WHERE lot.business_id=s.business_id AND lot.sku_id=s.id AND lot.location_id=$3 AND lot.quantity>0
        AND (lot.expires_on IS NULL OR lot.expires_on>=(now() AT TIME ZONE $4)::date)),'[]') AS lots,
      string_agg(DISTINCT o.order_no, ', ') AS order_nos
    FROM wholesale_order_lines x JOIN wholesale_orders o ON o.business_id=x.business_id AND o.id=x.order_id
    JOIN catalog_skus s ON s.business_id=x.business_id AND s.id=x.sku_id
    WHERE x.business_id=$1 AND x.order_id=ANY($2::bigint[]) AND ${remainingSql('x')}>0
    GROUP BY x.sku_id,s.business_id,s.id,s.code,s.label,s.unit ORDER BY s.label`, [business.id, orderIds, locationId, business.timezone]);
  // The batches to take for what can go now, earliest expiry first.
  for (const item of items) {
    let left = Math.min(milli(item.wanted), milli(item.available));
    item.take = [];
    for (const lot of item.lots) {
      if (left <= 0) break;
      const take = Math.min(left, milli(lot.quantity));
      item.take.push({ lot_code: lot.lot_code, expires_on: lot.expires_on, quantity: qty(take) });
      left -= take;
    }
    item.short = qty(Math.max(0, milli(item.wanted) - milli(item.available)));
    delete item.lots;
  }
  return { location: { id: locationId, name: orders[0].location_name }, orders, items };
}

// --- Delivery runs --------------------------------------------------------------------

// body: { requestKey, orderIds: [], vehicleNo?, driverName?, driverPhone?, helperName?, routeId?, notes?,
//   transporterName?, transporterId?, lrNo? }
// Each order sends what is in stock now (whole packs for lines ordered in
// packs); an order with nothing in stock, or one the core refuses (credit
// limit), is left out and said why. All the rest go in one transaction.
async function createRun(business, user, body) {
  await access.require(business, 'sales_orders.approve');
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf(body);
  const orderIds = readIds(body.orderIds, 'orders');
  const transport = wholesale.readTransport({ ...body, ewayBillNo: undefined, ewayBillDate: undefined, distanceKm: undefined });
  const routeId = optionalId(body.routeId, 'Route');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT * FROM wholesale_delivery_runs WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return runDetail(business, old.id, db);
    }
    const orders = await repo.all(db, `SELECT id,order_no,location_id,status FROM wholesale_orders WHERE business_id=$1 AND id=ANY($2::bigint[]) ORDER BY id FOR UPDATE`, [business.id, orderIds]);
    if (orders.length !== orderIds.length) fail('Some of those orders were not found', 404);
    if (new Set(orders.map((o) => o.location_id)).size > 1) fail('Those orders go out from different godowns; send one godown at a time');
    if (routeId && !(await repo.one(db, 'SELECT id FROM wholesale_routes WHERE business_id=$1 AND id=$2', [business.id, routeId]))) fail('Route not found', 404);
    const run = await repo.one(db, `INSERT INTO wholesale_delivery_runs(business_id,location_id,route_id,vehicle_no,driver_name,driver_phone,helper_name,notes,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [business.id, orders[0].location_id, routeId, transport.vehicleNo, transport.driverName,
      v.optionalString(body.driverPhone, 'Driver phone', 30), transport.helperName, v.optionalString(body.notes, 'Notes', 300), requestKey, hash, user.id]);
    const sent = [], skipped = [];
    for (const [n, order] of orders.entries()) {
      if (!['open', 'part_dispatched'].includes(order.status)) { skipped.push({ orderId: order.id, orderNo: order.order_no, reason: `already ${order.status.replace('_', ' ')}` }); continue; }
      // What can go now, line by line (stock already taken by earlier orders in this run counts).
      const lines = await repo.all(db, `SELECT x.id,x.unit,x.entered_unit,x.unit_factor,${remainingSql('x')} AS remaining,
        COALESCE((SELECT sum(lot.quantity) FROM business_stock_lots lot WHERE lot.business_id=x.business_id AND lot.sku_id=x.sku_id AND lot.location_id=$3
          AND (lot.expires_on IS NULL OR lot.expires_on>=(now() AT TIME ZONE $4)::date)),0) AS available
        FROM wholesale_order_lines x WHERE x.business_id=$1 AND x.order_id=$2 AND ${remainingSql('x')}>0 ORDER BY x.id`, [business.id, order.id, order.location_id, business.timezone]);
      const toSend = [];
      const used = new Map();
      for (const line of lines) {
        const can = Math.min(milli(line.remaining), milli(line.available) - (used.get(line.id) || 0));
        if (can <= 0) continue;
        if (line.entered_unit && line.unit_factor) {
          const factor = milli(line.unit_factor);
          const packs = Math.floor(can / factor);
          if (can === milli(line.remaining)) toSend.push({ orderLineId: line.id, quantity: qty(can) });
          else if (packs > 0) toSend.push({ orderLineId: line.id, quantity: String(packs), unit: line.entered_unit });
          else continue;
        } else toSend.push({ orderLineId: line.id, quantity: qty(can) });
      }
      if (!toSend.length) { skipped.push({ orderId: order.id, orderNo: order.order_no, reason: 'nothing in stock for it' }); continue; }
      const subBody = { lines: toSend, vehicleNo: transport.vehicleNo, driverName: transport.driverName, helperName: transport.helperName,
        transporterName: transport.transporterName, transporterId: transport.transporterId, lrNo: transport.lrNo, notes: `Delivery run ${run.id}` };
      await db.query('SAVEPOINT run_order');
      try {
        const result = await wholesale.dispatchInTransaction(db, business, user, order.id, subBody, { requestKey: derivedKey(requestKey, n), hash: hashOf(subBody), runId: run.id });
        await db.query('RELEASE SAVEPOINT run_order');
        sent.push({ orderId: order.id, orderNo: order.order_no, documentId: result.document.id, documentNo: result.document.document_no, status: result.status });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        await db.query('ROLLBACK TO SAVEPOINT run_order');
        skipped.push({ orderId: order.id, orderNo: order.order_no, reason: error.message });
      }
    }
    if (!sent.length) fail(`Nothing could go: ${skipped.map((s) => `${s.orderNo} — ${s.reason}`).join('; ')}`, 409);
    await repo.audit(db, business.id, user.id, 'delivery_run.created', run.id, { vehicleNo: run.vehicle_no, driver: run.driver_name, sent: sent.map((s) => s.documentNo), skipped });
    const detail = await runDetail(business, run.id, db);
    return { ...detail, sent, skipped };
  });
}

// The load sheet of a run: every item loaded (in cases and pieces, with
// batches) and every invoice with the shop, address, phone and what to collect.
async function runDetail(business, runId, db = repo.pool) {
  await access.require(business, 'sales_orders.view');
  const run = await repo.one(db, `SELECT r.*,l.name AS location_name,rt.name AS route_name,u.name AS created_by_name FROM wholesale_delivery_runs r
    JOIN business_locations l ON l.business_id=r.business_id AND l.id=r.location_id LEFT JOIN wholesale_routes rt ON rt.business_id=r.business_id AND rt.id=r.route_id
    JOIN users u ON u.id=r.created_by WHERE r.business_id=$1 AND r.id=$2`, [business.id, id(runId, 'Delivery run')]);
  if (!run) fail('Delivery run not found', 404);
  const [invoices, items] = await Promise.all([
    repo.all(db, `SELECT d.id AS dispatch_id,d.delivery_status,d.received_by,d.delivered_at,o.order_no,o.contact_name,c.phone AS contact_phone,c.address AS contact_address,
      doc.id AS document_id,doc.document_no,doc.total,
      doc.total-COALESCE((SELECT sum(total) FROM business_returns x WHERE x.business_id=doc.business_id AND x.document_id=doc.id),0)
        -COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.business_id=doc.business_id AND p.document_id=doc.id),0)
        +COALESCE((SELECT sum(amount) FROM business_refunds f WHERE f.business_id=doc.business_id AND f.document_id=doc.id),0) AS to_collect,
      (SELECT count(*)::int FROM business_document_lines bl WHERE bl.business_id=doc.business_id AND bl.document_id=doc.id) AS lines
      FROM wholesale_dispatches d JOIN wholesale_orders o ON o.business_id=d.business_id AND o.id=d.order_id
      JOIN business_documents doc ON doc.business_id=d.business_id AND doc.id=d.document_id
      JOIN business_contacts c ON c.business_id=o.business_id AND c.id=o.contact_id
      WHERE d.business_id=$1 AND d.run_id=$2 ORDER BY d.id`, [business.id, run.id]),
    repo.all(db, `SELECT bl.sku_id,s.code,bl.label,bl.unit,sum(bl.quantity) AS quantity,string_agg(DISTINCT NULLIF(bl.lot_code,''),', ') AS lots,
      (SELECT u.unit_code FROM catalog_sku_units u WHERE u.business_id=s.business_id AND u.sku_id=s.id AND u.active ORDER BY u.quantity_in_base DESC LIMIT 1) AS pack_unit,
      (SELECT u.quantity_in_base FROM catalog_sku_units u WHERE u.business_id=s.business_id AND u.sku_id=s.id AND u.active ORDER BY u.quantity_in_base DESC LIMIT 1) AS pack_factor
      FROM wholesale_dispatches d JOIN business_document_lines bl ON bl.business_id=d.business_id AND bl.document_id=d.document_id
      JOIN catalog_skus s ON s.business_id=bl.business_id AND s.id=bl.sku_id
      WHERE d.business_id=$1 AND d.run_id=$2 GROUP BY bl.sku_id,s.business_id,s.id,s.code,bl.label,bl.unit ORDER BY bl.label`, [business.id, run.id]),
  ]);
  return { ...run, invoices, items };
}

// --- Transport, delivery, van returns ---------------------------------------------------------

async function lockDispatch(db, business, dispatchId) {
  const row = await repo.one(db, `SELECT d.*,o.order_no,o.contact_name FROM wholesale_dispatches d JOIN wholesale_orders o ON o.business_id=d.business_id AND o.id=d.order_id
    WHERE d.business_id=$1 AND d.id=$2 FOR UPDATE OF d`, [business.id, id(dispatchId, 'Dispatch')]);
  if (!row) fail('Dispatch not found', 404);
  return row;
}

// The e-way bill and transport details, filled in after the dispatch too.
async function setTransport(business, user, dispatchId, body) {
  await access.require(business, 'sales_orders.approve');
  const t = wholesale.readTransport(body);
  return repo.transaction(async (db) => {
    const row = await lockDispatch(db, business, dispatchId);
    const saved = await repo.one(db, `UPDATE wholesale_dispatches SET vehicle_no=$3,driver_name=$4,helper_name=$5,transporter_name=$6,transporter_id=$7,lr_no=$8,
      eway_bill_no=$9,eway_bill_date=$10,distance_km=$11 WHERE business_id=$1 AND id=$2 RETURNING *`,
    [business.id, row.id, t.vehicleNo, t.driverName, t.helperName, t.transporterName, t.transporterId, t.lrNo, t.ewayBillNo, t.ewayBillDate, t.distanceKm]);
    await repo.audit(db, business.id, user.id, 'dispatch.transport_updated', row.id, { orderNo: row.order_no, ...t });
    return saved;
  });
}

// body: { status: 'delivered' | 'part_returned' | 'refused', receivedBy?, note?, requestKey?,
//   returns?: [{ documentLineId, quantity }] }   (refused: everything comes back)
async function recordDelivery(business, user, dispatchId, body) {
  await access.require(business, 'sales_orders.approve');
  const status = v.requiredEnum(body.status, 'Delivery', ['delivered', 'part_returned', 'refused']);
  const receivedBy = v.optionalString(body.receivedBy, 'Received by', 100);
  const note = v.optionalString(body.note, 'Note', 300);
  if (status !== 'delivered') {
    await access.require(business, 'sales.refund');
    if (!note) fail('Say why the goods came back');
  }
  const requestKey = status === 'delivered' ? null : core.uuid(body.requestKey);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const row = await lockDispatch(db, business, dispatchId);
    if (row.delivery_status !== 'out_for_delivery') fail(`This dispatch was already marked ${row.delivery_status.replace('_', ' ')}`, 409);
    let saved;
    let returnRow = null;
    if (status !== 'delivered') {
      const doc = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, row.document_id]);
      const docLines = await repo.all(db, `SELECT bl.id,bl.label,bl.quantity,COALESCE((SELECT sum(rl.quantity) FROM business_return_lines rl WHERE rl.business_id=bl.business_id AND rl.line_id=bl.id),0) AS returned
        FROM business_document_lines bl WHERE bl.business_id=$1 AND bl.document_id=$2 ORDER BY bl.id`, [business.id, doc.id]);
      let lines;
      if (status === 'refused') {
        lines = docLines.filter((l) => milli(l.quantity) > milli(l.returned)).map((l) => ({ lineId: l.id, quantity: qty(milli(l.quantity) - milli(l.returned)), restock: true }));
      } else {
        const inputs = v.requiredArray(body.returns, 'Goods that came back');
        if (!inputs.length) fail('Say which goods came back');
        lines = inputs.map((input) => {
          const line = docLines.find((l) => l.id === id(input?.documentLineId, 'Invoice line'));
          if (!line) fail('That line is not on this invoice', 404);
          return { lineId: line.id, quantity: String(core.decimal(input.quantity, 'Quantity back', 3, 0.001, 100000)), restock: true };
        });
      }
      if (!lines.length) fail('Everything on this invoice was already returned', 409);
      const input = { reason: `${status === 'refused' ? 'Refused at the shop' : 'Came back in the van'}: ${note}`.slice(0, 300), requestKey, hash: hashOf({ dispatch: row.id, lines, note }), lines };
      returnRow = await returns.postReturn(db, business, user, doc, input);
    }
    saved = await repo.one(db, `UPDATE wholesale_dispatches SET delivery_status=$3,delivered_at=now(),delivery_recorded_by=$4,received_by=$5,delivery_note=$6,return_id=$7
      WHERE business_id=$1 AND id=$2 RETURNING *`, [business.id, row.id, status, user.id, receivedBy, note, returnRow?.id || null]);
    await repo.audit(db, business.id, user.id, `dispatch.${status}`, row.id, { orderNo: row.order_no, receivedBy, note, returnNo: returnRow?.return_no || null });
    await repo.event(db, business.id, user.id, `dispatch.${status}`, 'dispatch', row.id, { orderNo: row.order_no, documentId: row.document_id, returnId: returnRow?.id || null });
    return { ...saved, return: returnRow };
  });
}

// --- Invoice extras (the shared tax invoice of a dispatched order) -------------------------------

// Order, salesperson, route, transport and e-way bill, and each line's
// discount and free goods — what the tax invoice prints for a wholesale sale.
async function invoiceExtras(db, businessId, documentId) {
  const dispatchRow = await repo.one(db, `SELECT d.id,d.vehicle_no,d.driver_name,d.transporter_name,d.transporter_id,d.lr_no,d.eway_bill_no,d.eway_bill_date,d.distance_km,d.challan_no,
    d.delivery_status,d.run_id,o.order_no,o.created_at AS ordered_at,s.name AS salesperson_name,r.name AS route_name
    FROM wholesale_dispatches d JOIN wholesale_orders o ON o.business_id=d.business_id AND o.id=d.order_id
    LEFT JOIN wholesale_salespeople s ON s.business_id=o.business_id AND s.id=o.salesperson_id
    LEFT JOIN wholesale_routes r ON r.business_id=o.business_id AND r.id=o.route_id WHERE d.business_id=$1 AND d.document_id=$2`, [businessId, documentId]);
  if (!dispatchRow) return null;
  const lines = await repo.all(db, `SELECT dl.document_line_id,x.discount_percent,x.list_unit_price,(x.free_of_line_id IS NOT NULL) AS free,sc.name AS scheme_name
    FROM wholesale_dispatch_lines dl JOIN wholesale_order_lines x ON x.business_id=dl.business_id AND x.id=dl.order_line_id
    LEFT JOIN wholesale_schemes sc ON sc.business_id=x.business_id AND sc.id=x.scheme_id
    WHERE dl.business_id=$1 AND dl.dispatch_id=$2`, [businessId, dispatchRow.id]);
  return { ...dispatchRow, lines };
}

// --- Delivery challan (round 2, R2-WS) -------------------------------------------------------------

// Everything the A4 delivery challan prints: its number (from the location's
// 'delivery_challan' series; a dispatch made before challans existed gets its
// number now, once), the invoice it goes with, consignor and consignee, the
// transport (transporter, vehicle, LR, e-way bill typed in by hand) and every
// line with its batch, pack and value, free goods at no value.
async function challan(business, user, dispatchId) {
  await access.require(business, 'sales_orders.view');
  return repo.transaction(async (db) => {
    const row = await lockDispatch(db, business, dispatchId);
    if (!row.challan_no) {
      const doc = await repo.one(db, 'SELECT location_id FROM business_documents WHERE business_id=$1 AND id=$2', [business.id, row.document_id]);
      const number = await numbering.nextNumber(db, business.id, doc.location_id, 'delivery_challan', user.id);
      await db.query('UPDATE wholesale_dispatches SET challan_no=$3,challan_series_id=$4 WHERE business_id=$1 AND id=$2', [business.id, row.id, number.number, number.seriesId]);
      await repo.audit(db, business.id, user.id, 'dispatch.challan_issued', row.id, { orderNo: row.order_no, challanNo: number.number });
    }
    const head = await repo.one(db, `SELECT d.*,o.order_no,o.created_at AS ordered_at,o.contact_id,doc.document_no,doc.created_at AS invoiced_at,doc.total,doc.subtotal,doc.tax,
      doc.place_of_supply,doc.buyer_gstin,l.name AS location_name,c.name AS contact_name,c.phone AS contact_phone,c.address AS contact_address,c.gstin AS contact_gstin,
      p.state_code AS contact_state,p.pin_code AS contact_pin,p.contact_person,s.name AS salesperson_name,r.name AS route_name,u.name AS created_by_name
      FROM wholesale_dispatches d JOIN wholesale_orders o ON o.business_id=d.business_id AND o.id=d.order_id
      JOIN business_documents doc ON doc.business_id=d.business_id AND doc.id=d.document_id
      JOIN business_locations l ON l.business_id=doc.business_id AND l.id=doc.location_id
      JOIN business_contacts c ON c.business_id=o.business_id AND c.id=o.contact_id JOIN users u ON u.id=d.created_by
      LEFT JOIN wholesale_customer_profiles p ON p.business_id=c.business_id AND p.contact_id=c.id
      LEFT JOIN wholesale_salespeople s ON s.business_id=o.business_id AND s.id=o.salesperson_id
      LEFT JOIN wholesale_routes r ON r.business_id=o.business_id AND r.id=o.route_id WHERE d.business_id=$1 AND d.id=$2`, [business.id, row.id]);
    const lines = await repo.all(db, `SELECT bl.id,bl.label,bl.unit,bl.quantity,bl.entered_unit,bl.entered_quantity,bl.unit_factor,bl.lot_code,bl.hsn_code,bl.net,bl.tax,bl.tax_rate,
      lot.expires_on,(x.free_of_line_id IS NOT NULL) AS free,sc.name AS scheme_name
      FROM wholesale_dispatch_lines dl JOIN business_document_lines bl ON bl.business_id=dl.business_id AND bl.id=dl.document_line_id
      JOIN wholesale_order_lines x ON x.business_id=dl.business_id AND x.id=dl.order_line_id
      LEFT JOIN wholesale_schemes sc ON sc.business_id=x.business_id AND sc.id=x.scheme_id
      LEFT JOIN business_documents doc ON doc.business_id=bl.business_id AND doc.id=bl.document_id
      LEFT JOIN business_stock_lots lot ON lot.business_id=bl.business_id AND lot.sku_id=bl.sku_id AND lot.location_id=doc.location_id AND lot.lot_code=bl.lot_code
      WHERE dl.business_id=$1 AND dl.dispatch_id=$2 ORDER BY bl.id`, [business.id, row.id]);
    // The consignor is the dispatching location (its own address and GSTIN when it has them).
    const [settings, location] = await Promise.all([
      repo.one(db, 'SELECT * FROM business_settings WHERE business_id=$1', [business.id]),
      repo.one(db, 'SELECT l.* FROM business_locations l JOIN business_documents d ON d.business_id=l.business_id AND d.location_id=l.id WHERE d.business_id=$1 AND d.id=$2', [business.id, head.document_id]),
    ]);
    return { ...head, lines, seller: core.branchSeller(settings, location) };
  });
}

module.exports = { dispatchBoard, pickList, createRun, runDetail, setTransport, recordDelivery, invoiceExtras, challan };
