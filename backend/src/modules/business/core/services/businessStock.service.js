const crypto = require('node:crypto');
const repo = require('../repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('./businessAccess.service');
const numbering = require('./businessNumbering');
const { decimal, uuid } = require('./business.service');
const { applyAdjustment, lockLot } = require('./businessReturns.service');

// Stock transfers between locations and stock counts. Both lock the business
// row first, the same lock order as every other posting (business, then the
// record, then stock lots), so they can never deadlock with a sale.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const milli = (value) => Math.round(Number(value) * 1000);
const qty = (m) => (m / 1000).toFixed(3);

// --- Transfers -----------------------------------------------------------

async function createTransfer(business, user, body) {
  await access.require(business, 'stock_transfers.create');
  const requestKey = uuid(body.requestKey);
  const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const fromId = id(body.fromLocationId, 'Sending location');
  const toId = id(body.toLocationId, 'Receiving location');
  if (fromId === toId) fail('Choose two different locations');
  const lines = v.requiredArray(body.lines, 'Lines');
  if (!lines.length || lines.length > 200) fail('Add between 1 and 200 lines');
  if (new Set(lines.map((l) => id(l.lotId, 'Stock lot'))).size !== lines.length) fail('Each batch or serial may only appear once');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT * FROM business_stock_transfers WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return old;
    }
    const locations = await repo.all(db, 'SELECT * FROM business_locations WHERE business_id=$1 AND id=ANY($2) AND active', [business.id, [fromId, toId]]);
    if (locations.length !== 2) fail('Location not found', 404);
    const number = await numbering.nextNumber(db, business.id, fromId, 'stock_transfer', user.id);
    const transfer = await repo.one(db, `INSERT INTO business_stock_transfers(business_id,transfer_no,series_id,from_location_id,to_location_id,notes,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [business.id, number.number, number.seriesId, fromId, toId, v.optionalString(body.notes, 'Notes', 500), requestKey, hash, user.id]);
    const moved = [];
    for (const input of lines) {
      const lot = await lockLot(db, business.id, id(input.lotId, 'Stock lot'));
      if (!lot || lot.location_id !== fromId) fail('That batch is not held at the sending location', 404);
      const quantity = decimal(input.quantity, 'Quantity', 3, 0.001, 100000);
      if (lot.unit_decimals === 0 && !Number.isInteger(quantity)) fail(`${lot.label} moves in whole units`);
      if (lot.tracking === 'serial' && quantity !== 1) fail('A serial number moves on its own, one unit at a time');
      if (milli(quantity) > milli(lot.quantity)) fail(`Only ${Number(lot.quantity)} ${lot.unit} of ${lot.label}${lot.lot_code ? ` (${lot.lot_code})` : ''} is at the sending location`, 409);
      const balance = milli(lot.quantity) - milli(quantity);
      await db.query('UPDATE business_stock_lots SET quantity=$3 WHERE business_id=$1 AND id=$2', [business.id, lot.id, qty(balance)]);
      await db.query('INSERT INTO business_stock_movements(business_id,lot_id,transfer_id,quantity,balance_after) VALUES($1,$2,$3,$4,$5)',
        [business.id, lot.id, transfer.id, -quantity, qty(balance)]);
      await db.query(`INSERT INTO business_stock_transfer_lines(business_id,transfer_id,sku_id,source_lot_id,lot_code,expires_on,unit_cost,quantity)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [business.id, transfer.id, lot.sku_id, lot.id, lot.lot_code, lot.expires_on, lot.unit_cost, quantity]);
      moved.push({ skuId: lot.sku_id, lotCode: lot.lot_code || null, quantity });
    }
    await repo.audit(db, business.id, user.id, 'stock_transfer.dispatched', transfer.id, { transferNo: transfer.transfer_no, lines: moved.length });
    await repo.event(db, business.id, user.id, 'stock_transfer.dispatched', 'stock_transfer', transfer.id,
      { transferNo: transfer.transfer_no, fromLocationId: fromId, toLocationId: toId, lines: moved });
    return transfer;
  });
}

async function lockTransfer(db, business, transferId) {
  await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
  const transfer = await repo.one(db, 'SELECT * FROM business_stock_transfers WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(transferId)]);
  if (!transfer) fail('Transfer not found', 404);
  if (transfer.status !== 'in_transit') fail(`This transfer is already ${transfer.status === 'received' ? 'received' : 'cancelled'}`, 409);
  const lines = await repo.all(db, 'SELECT * FROM business_stock_transfer_lines WHERE business_id=$1 AND transfer_id=$2 ORDER BY id', [business.id, transfer.id]);
  return { transfer, lines };
}

// Adds quantity to a lot (creating it at that location if needed), keeping
// the weighted average cost, and writes the ledger line.
async function addToLot(db, businessId, transferId, locationId, line) {
  const existing = await repo.one(db, 'SELECT * FROM business_stock_lots WHERE business_id=$1 AND location_id=$2 AND sku_id=$3 AND lot_code=$4 FOR UPDATE',
    [businessId, locationId, line.sku_id, line.lot_code]);
  if (existing && (existing.expires_on || null) !== (line.expires_on || null)) {
    fail(`Batch ${line.lot_code || '(no batch)'} is already held there with a different expiry date`, 409);
  }
  if (existing && line.lot_code && milli(existing.quantity) > 0) {
    const sku = await repo.one(db, 'SELECT tracking FROM catalog_skus WHERE business_id=$1 AND id=$2', [businessId, line.sku_id]);
    if (sku.tracking === 'serial') fail(`Serial ${line.lot_code} is already in stock there`, 409);
  }
  const lot = await repo.one(db, `INSERT INTO business_stock_lots(business_id,location_id,sku_id,lot_code,expires_on,quantity,unit_cost)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(business_id,location_id,sku_id,lot_code) DO UPDATE SET
    unit_cost=CASE WHEN business_stock_lots.quantity+EXCLUDED.quantity=0 THEN EXCLUDED.unit_cost ELSE
      (business_stock_lots.quantity*business_stock_lots.unit_cost+EXCLUDED.quantity*EXCLUDED.unit_cost)/(business_stock_lots.quantity+EXCLUDED.quantity) END,
    quantity=business_stock_lots.quantity+EXCLUDED.quantity RETURNING *`,
  [businessId, locationId, line.sku_id, line.lot_code, line.expires_on, line.quantity, line.unit_cost]);
  await db.query('INSERT INTO business_stock_movements(business_id,lot_id,transfer_id,quantity,balance_after) VALUES($1,$2,$3,$4,$5)',
    [businessId, lot.id, transferId, line.quantity, lot.quantity]);
  return lot;
}

async function receiveTransfer(business, user, transferId) {
  await access.require(business, 'stock_transfers.approve');
  return repo.transaction(async (db) => {
    const { transfer, lines } = await lockTransfer(db, business, transferId);
    const destination = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, transfer.to_location_id]);
    if (!destination) fail('The receiving location is closed. Reopen it or cancel the transfer.', 409);
    for (const line of lines) {
      const lot = await addToLot(db, business.id, transfer.id, transfer.to_location_id, line);
      await db.query('UPDATE business_stock_transfer_lines SET destination_lot_id=$3 WHERE business_id=$1 AND id=$2', [business.id, line.id, lot.id]);
    }
    const saved = await repo.one(db, `UPDATE business_stock_transfers SET status='received',closed_by=$3,closed_at=now() WHERE business_id=$1 AND id=$2 RETURNING *`,
      [business.id, transfer.id, user.id]);
    await repo.audit(db, business.id, user.id, 'stock_transfer.received', transfer.id, { transferNo: transfer.transfer_no });
    await repo.event(db, business.id, user.id, 'stock_transfer.received', 'stock_transfer', transfer.id,
      { transferNo: transfer.transfer_no, toLocationId: transfer.to_location_id, lines: lines.map((l) => ({ skuId: l.sku_id, lotCode: l.lot_code || null, quantity: l.quantity })) });
    return saved;
  });
}

async function cancelTransfer(business, user, transferId, body) {
  await access.require(business, 'stock_transfers.cancel');
  const reason = v.requiredString(body.reason, 'Reason for cancelling', 300);
  return repo.transaction(async (db) => {
    const { transfer, lines } = await lockTransfer(db, business, transferId);
    // The goods go back into the very lots they left.
    for (const line of lines) {
      const lot = await repo.one(db, 'SELECT * FROM business_stock_lots WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, line.source_lot_id]);
      const balance = milli(lot.quantity) + milli(line.quantity);
      const cost = milli(lot.quantity) === 0 ? Number(line.unit_cost)
        : (Number(lot.quantity) * Number(lot.unit_cost) + Number(line.quantity) * Number(line.unit_cost)) / (balance / 1000);
      await db.query('UPDATE business_stock_lots SET quantity=$3,unit_cost=$4 WHERE business_id=$1 AND id=$2', [business.id, lot.id, qty(balance), cost.toFixed(4)]);
      await db.query('INSERT INTO business_stock_movements(business_id,lot_id,transfer_id,quantity,balance_after) VALUES($1,$2,$3,$4,$5)',
        [business.id, lot.id, transfer.id, line.quantity, qty(balance)]);
    }
    const saved = await repo.one(db, `UPDATE business_stock_transfers SET status='cancelled',closed_by=$3,closed_at=now(),close_reason=$4 WHERE business_id=$1 AND id=$2 RETURNING *`,
      [business.id, transfer.id, user.id, reason]);
    await repo.audit(db, business.id, user.id, 'stock_transfer.cancelled', transfer.id, { transferNo: transfer.transfer_no, reason });
    await repo.event(db, business.id, user.id, 'stock_transfer.cancelled', 'stock_transfer', transfer.id, { transferNo: transfer.transfer_no, reason });
    return saved;
  });
}

async function transferDetail(business, transferId) {
  await access.require(business, 'stock_transfers.view');
  const transfer = await repo.one(repo.pool, `SELECT t.*,f.name AS from_location_name,d.name AS to_location_name,u.name AS created_by_name,c.name AS closed_by_name
    FROM business_stock_transfers t JOIN business_locations f ON f.business_id=t.business_id AND f.id=t.from_location_id
    JOIN business_locations d ON d.business_id=t.business_id AND d.id=t.to_location_id
    JOIN users u ON u.id=t.created_by LEFT JOIN users c ON c.id=t.closed_by WHERE t.business_id=$1 AND t.id=$2`, [business.id, id(transferId)]);
  if (!transfer) fail('Transfer not found', 404);
  transfer.lines = await repo.all(repo.pool, `SELECT x.*,s.label,s.code,s.unit FROM business_stock_transfer_lines x
    JOIN catalog_skus s ON s.business_id=x.business_id AND s.id=x.sku_id WHERE x.business_id=$1 AND x.transfer_id=$2 ORDER BY x.id`, [business.id, transfer.id]);
  return transfer;
}

// --- Counts --------------------------------------------------------------

async function createCount(business, user, body) {
  await access.require(business, 'stock_counts.create');
  const requestKey = uuid(body.requestKey);
  const locationId = id(body.locationId, 'Location');
  const categoryId = body.categoryId ? id(body.categoryId, 'Category') : null;
  const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT * FROM business_stock_counts WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      // Counts saved before the hash existed are matched by key and location.
      if ((old.request_hash && old.request_hash !== hash) || old.location_id !== locationId) fail('This request key was already used for a different count', 409);
      return old;
    }
    const location = await repo.one(db, 'SELECT * FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, locationId]);
    if (!location) fail('Location not found', 404);
    if (categoryId && !(await repo.one(db, 'SELECT id FROM catalog_categories WHERE business_id=$1 AND id=$2', [business.id, categoryId]))) fail('Category not found', 404);
    const open = await repo.one(db, "SELECT count_no FROM business_stock_counts WHERE business_id=$1 AND location_id=$2 AND status='open'", [business.id, locationId]);
    if (open) fail(`Count ${open.count_no} is still open for ${location.name}. Finish or cancel it first.`, 409);
    // Lots on hand, plus empty quantity-tracked lots (something may be found
    // on the shelf). Sold-out batches and sold serials are left off the sheet.
    const lots = await repo.all(db, `SELECT l.id,l.quantity FROM business_stock_lots l
      JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
      JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      WHERE l.business_id=$1 AND l.location_id=$2 AND s.active AND (l.quantity>0 OR s.tracking='quantity')
      AND ($3::bigint IS NULL OR p.category_id=$3) ORDER BY s.label,l.lot_code LIMIT 5001`, [business.id, locationId, categoryId]);
    if (!lots.length) fail('There is no stock at this location to count', 409);
    if (lots.length > 5000) fail('A count sheet can hold up to 5,000 lines. Count one category at a time.');
    const number = await numbering.nextNumber(db, business.id, locationId, 'stock_count', user.id);
    const count = await repo.one(db, `INSERT INTO business_stock_counts(business_id,count_no,series_id,location_id,notes,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [business.id, number.number, number.seriesId, locationId, v.optionalString(body.notes, 'Notes', 500), requestKey, hash, user.id]);
    await db.query(`INSERT INTO business_stock_count_lines(business_id,count_id,lot_id,expected_quantity)
      SELECT $1,$2,x.id,x.quantity FROM jsonb_to_recordset($3::jsonb) AS x(id bigint, quantity numeric)`, [business.id, count.id, JSON.stringify(lots)]);
    await repo.audit(db, business.id, user.id, 'stock_count.started', count.id, { countNo: count.count_no, lines: lots.length });
    return count;
  });
}

async function countDetail(business, countId) {
  await access.require(business, 'stock_counts.view');
  const count = await repo.one(repo.pool, `SELECT c.*,l.name AS location_name,u.name AS created_by_name,a.name AS closed_by_name FROM business_stock_counts c
    JOIN business_locations l ON l.business_id=c.business_id AND l.id=c.location_id JOIN users u ON u.id=c.created_by
    LEFT JOIN users a ON a.id=c.closed_by WHERE c.business_id=$1 AND c.id=$2`, [business.id, id(countId)]);
  if (!count) fail('Count not found', 404);
  count.lines = await repo.all(repo.pool, `SELECT x.*,lot.lot_code,lot.expires_on,lot.quantity AS current_quantity,s.id AS sku_id,s.label,s.code,s.unit,s.tracking,u.decimals AS unit_decimals
    FROM business_stock_count_lines x JOIN business_stock_lots lot ON lot.business_id=x.business_id AND lot.id=x.lot_id
    JOIN catalog_skus s ON s.business_id=lot.business_id AND s.id=lot.sku_id JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
    WHERE x.business_id=$1 AND x.count_id=$2 ORDER BY s.label,lot.lot_code`, [business.id, count.id]);
  return count;
}

async function lockOpenCount(db, business, countId) {
  await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
  const count = await repo.one(db, 'SELECT * FROM business_stock_counts WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(countId)]);
  if (!count) fail('Count not found', 404);
  if (count.status !== 'open') fail(`This count is already ${count.status}`, 409);
  return count;
}

async function enterCounts(business, user, countId, body) {
  await access.require(business, 'stock_counts.create');
  const lines = v.requiredArray(body.lines, 'Counted lines');
  if (!lines.length || lines.length > 5000) fail('Send between 1 and 5,000 counted lines');
  const saved = await repo.transaction(async (db) => {
    const count = await lockOpenCount(db, business, countId);
    for (const input of lines) {
      const line = await repo.one(db, `SELECT x.id,u.decimals,s.label FROM business_stock_count_lines x
        JOIN business_stock_lots l ON l.business_id=x.business_id AND l.id=x.lot_id
        JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
        WHERE x.business_id=$1 AND x.count_id=$2 AND x.id=$3`, [business.id, count.id, id(input.lineId, 'Count line')]);
      if (!line) fail('Count line not found', 404);
      const blank = input.countedQuantity === null || input.countedQuantity === undefined || input.countedQuantity === '';
      const counted = blank ? null : decimal(input.countedQuantity, `Counted quantity of ${line.label}`, 3, 0, 1000000);
      if (counted !== null && line.decimals === 0 && !Number.isInteger(counted)) fail(`${line.label} is counted in whole units`);
      await db.query(`UPDATE business_stock_count_lines SET counted_quantity=$3,reason=$4,counted_by=CASE WHEN $3::numeric IS NULL THEN NULL ELSE $5::bigint END,
        counted_at=CASE WHEN $3::numeric IS NULL THEN NULL ELSE now() END WHERE business_id=$1 AND id=$2`,
      [business.id, line.id, counted, v.optionalString(input.reason, 'Reason', 300), user.id]);
    }
    return count;
  });
  return countDetail(business, saved.id);
}

async function postCount(business, user, countId, body) {
  await access.require(business, 'stock_counts.approve');
  const defaultReason = v.optionalString(body.reason, 'Reason', 200);
  return repo.transaction(async (db) => {
    const count = await lockOpenCount(db, business, countId);
    const lines = await repo.all(db, `SELECT x.* FROM business_stock_count_lines x WHERE x.business_id=$1 AND x.count_id=$2 AND x.counted_quantity IS NOT NULL ORDER BY x.id`,
      [business.id, count.id]);
    if (!lines.length) fail('Enter at least one counted quantity before approving');
    let corrections = 0;
    const changes = [];
    for (const line of lines) {
      const lot = await lockLot(db, business.id, line.lot_id);
      // The difference is taken against the stock at this moment: sales made
      // while the shelf was being counted are not counted twice.
      const variance = (milli(line.counted_quantity) - milli(lot.quantity)) / 1000;
      let adjustmentId = null;
      if (variance !== 0) {
        const reason = line.reason || defaultReason;
        if (!reason) fail(`Give a reason for the difference on ${lot.label}${lot.lot_code ? ` (${lot.lot_code})` : ''}`);
        const adjustment = await applyAdjustment(db, business, user, lot, variance, `Count ${count.count_no}: ${reason}`.slice(0, 300), crypto.randomUUID(), count.id);
        adjustmentId = adjustment.id;
        corrections += 1;
        changes.push({ lotId: lot.id, skuId: lot.sku_id, quantity: variance });
      }
      await db.query('UPDATE business_stock_count_lines SET system_quantity=$3,adjustment_id=$4 WHERE business_id=$1 AND id=$2',
        [business.id, line.id, lot.quantity, adjustmentId]);
    }
    const saved = await repo.one(db, `UPDATE business_stock_counts SET status='posted',closed_by=$3,closed_at=now() WHERE business_id=$1 AND id=$2 RETURNING *`,
      [business.id, count.id, user.id]);
    await repo.audit(db, business.id, user.id, 'stock_count.posted', count.id, { countNo: count.count_no, counted: lines.length, corrections });
    await repo.event(db, business.id, user.id, 'stock_count.posted', 'stock_count', count.id,
      { countNo: count.count_no, locationId: count.location_id, counted: lines.length, corrections: changes });
    return { ...saved, counted: lines.length, corrections };
  });
}

async function cancelCount(business, user, countId, body) {
  await access.require(business, 'stock_counts.cancel');
  const reason = v.requiredString(body.reason, 'Reason for cancelling', 300);
  return repo.transaction(async (db) => {
    const count = await lockOpenCount(db, business, countId);
    const saved = await repo.one(db, `UPDATE business_stock_counts SET status='cancelled',closed_by=$3,closed_at=now(),close_reason=$4 WHERE business_id=$1 AND id=$2 RETURNING *`,
      [business.id, count.id, user.id, reason]);
    await repo.audit(db, business.id, user.id, 'stock_count.cancelled', count.id, { countNo: count.count_no, reason });
    return saved;
  });
}

module.exports = { createTransfer, receiveTransfer, cancelTransfer, transferDetail, createCount, countDetail, enterCounts, postCount, cancelCount };
