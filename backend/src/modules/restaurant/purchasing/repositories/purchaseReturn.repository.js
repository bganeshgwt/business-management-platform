const pool = require("../../../../config/database");
const inventoryRepository = require("../../inventory/repositories/inventory.repository");
const { nextNumber } = require("../../../../utils/docNumber");

// --- Purchase returns ---

const RETURN_COLUMNS = `pr.id, pr.return_number, pr.return_date, pr.total_amount, pr.taxable_amount,
       pr.tax_amount, pr.reason, pr.notes, pr.supplier_id, pr.purchase_order_id,
       pr.goods_receipt_id, pr.return_status, pr.void_reason, pr.voided_at, pr.created_at,
       s.name AS supplier_name, po.po_number, gr.receipt_number, gr.bill_number,
       cu.name AS created_by_name, vu.name AS voided_by_name,
       s.gst_number AS supplier_gstin, s.address AS supplier_address, s.mobile AS supplier_mobile,
       gr.bill_date, gr.received_date AS bill_received_date`;

const RETURN_JOINS = `
     JOIN suppliers s ON s.id = pr.supplier_id
     LEFT JOIN purchase_orders po ON po.id = pr.purchase_order_id
     LEFT JOIN goods_receipts gr ON gr.id = pr.goods_receipt_id
     LEFT JOIN users cu ON cu.id = pr.created_by
     LEFT JOIN users vu ON vu.id = pr.voided_by`;

// filters: { supplierId, status, from, to (the return's date), limit
// (200 when not asked), offset }. Each row carries total_count: how many
// match, whichever page this is.
const findAll = async (restaurantId, filters = {}) => {
  const result = await pool.query(
    `SELECT ${RETURN_COLUMNS},
            (SELECT COUNT(*)::int FROM purchase_return_items pri WHERE pri.purchase_return_id = pr.id) AS item_count,
            COUNT(*) OVER ()::int AS total_count
     FROM purchase_returns pr
     ${RETURN_JOINS}
     WHERE pr.restaurant_id = $1
       AND ($2::bigint IS NULL OR pr.supplier_id = $2)
       AND ($3::text IS NULL OR pr.return_status = $3)
       AND ($4::date IS NULL OR pr.return_date >= $4::date)
       AND ($5::date IS NULL OR pr.return_date <= $5::date)
     ORDER BY pr.return_date DESC, pr.id DESC
     LIMIT $6 OFFSET $7`,
    [
      restaurantId,
      filters.supplierId || null,
      filters.status || null,
      filters.from || null,
      filters.to || null,
      filters.limit || 200,
      filters.offset || 0,
    ]
  );

  return result.rows;
};

const findById = async (restaurantId, id, client = pool) => {
  const header = await client.query(
    `SELECT ${RETURN_COLUMNS}
     FROM purchase_returns pr
     ${RETURN_JOINS}
     WHERE pr.restaurant_id = $1 AND pr.id = $2`,
    [restaurantId, id]
  );

  if (header.rows.length === 0) {
    return null;
  }

  const items = await client.query(
    `SELECT pri.id, pri.inventory_item_id, pri.goods_receipt_item_id, pri.quantity, pri.unit_price,
            pri.tax_rate, pri.tax_amount, pri.amount,
            i.name AS item_name, u.short_name AS unit_short_name
     FROM purchase_return_items pri
     JOIN inventory_items i ON i.id = pri.inventory_item_id
     JOIN units u ON u.id = i.unit_id
     WHERE pri.purchase_return_id = $1
     ORDER BY pri.id`,
    [id]
  );

  return { ...header.rows[0], items: items.rows };
};

// Everything of one item that has gone back against an order: returns naming
// the order, and returns naming any of its bills. An order and its bills are
// one set of goods, so a kilo sent back "against PO-0012" and the same kilo
// sent back "against its bill" used to be counted separately, and the same
// goods could be credited twice.
const ORDER_RETURNED = (orderColumn, itemColumn) => `COALESCE((
  SELECT SUM(pri.quantity) FROM purchase_return_items pri
  JOIN purchase_returns pr ON pr.id = pri.purchase_return_id
  WHERE pr.return_status = 'posted' AND pri.inventory_item_id = ${itemColumn}
    AND (pr.purchase_order_id = ${orderColumn}
         OR pr.goods_receipt_id IN (SELECT og.id FROM goods_receipts og WHERE og.purchase_order_id = ${orderColumn}))
), 0)`;

// What an order or a bill brought in, per item, less what has already gone
// back against it: the most that can be returned against it now
// (`available`). A bill that came against an order is also held to what is
// left on the order as a whole.
//
// For an order, what its bills actually charged: the highest price before GST
// (`paid_max`) and the GST rates they carried, latest first (`tax_rates`). A
// credit is checked against those, not against the price the order was
// raised at.
const findReturnable = async (restaurantId, { purchaseOrderId, goodsReceiptId }, client = pool) => {
  if (goodsReceiptId) {
    const result = await client.query(
      `SELECT t.*,
              LEAST(t.received - t.returned, COALESCE(t.order_available, t.received - t.returned)) AS available
       FROM (
         SELECT gi.id AS goods_receipt_item_id, gi.inventory_item_id, gi.quantity AS received,
                gi.taxable_amount, gi.tax_rate, i.name AS item_name, u.short_name AS unit_short_name,
                gr.purchase_order_id,
                COALESCE((
                  SELECT SUM(pri.quantity) FROM purchase_return_items pri
                  JOIN purchase_returns pr ON pr.id = pri.purchase_return_id
                  WHERE pri.goods_receipt_item_id = gi.id AND pr.return_status = 'posted'
                ), 0) AS returned,
                CASE WHEN gr.purchase_order_id IS NULL THEN NULL ELSE
                  (SELECT COALESCE(SUM(poi.received_quantity), 0) FROM purchase_order_items poi
                   WHERE poi.purchase_order_id = gr.purchase_order_id
                     AND poi.inventory_item_id = gi.inventory_item_id)
                  - ${ORDER_RETURNED("gr.purchase_order_id", "gi.inventory_item_id")}
                END AS order_available
         FROM goods_receipt_items gi
         JOIN goods_receipts gr ON gr.id = gi.goods_receipt_id
         JOIN inventory_items i ON i.id = gi.inventory_item_id
         JOIN units u ON u.id = i.unit_id
         WHERE gr.restaurant_id = $1 AND gr.id = $2
       ) t`,
      [restaurantId, goodsReceiptId]
    );

    return result.rows;
  }

  const result = await client.query(
    `SELECT t.*, t.received - t.returned AS available
     FROM (
       SELECT NULL::bigint AS goods_receipt_item_id, poi.inventory_item_id,
              poi.received_quantity AS received, poi.unit_price,
              i.name AS item_name, u.short_name AS unit_short_name,
              ${ORDER_RETURNED("po.id", "poi.inventory_item_id")} AS returned,
              (SELECT MAX(gi.taxable_amount / gi.quantity)
               FROM goods_receipt_items gi
               JOIN goods_receipts gr ON gr.id = gi.goods_receipt_id
               WHERE gr.purchase_order_id = po.id AND gr.receipt_status = 'posted'
                 AND gi.inventory_item_id = poi.inventory_item_id AND gi.quantity > 0) AS paid_max,
              COALESCE((
                SELECT array_agg(rates.tax_rate ORDER BY rates.latest DESC)
                FROM (
                  SELECT gi.tax_rate, MAX(gr.id) AS latest
                  FROM goods_receipt_items gi
                  JOIN goods_receipts gr ON gr.id = gi.goods_receipt_id
                  WHERE gr.purchase_order_id = po.id AND gr.receipt_status = 'posted'
                    AND gi.inventory_item_id = poi.inventory_item_id AND gi.quantity > 0
                  GROUP BY gi.tax_rate
                ) rates
              ), '{}') AS tax_rates
       FROM purchase_order_items poi
       JOIN purchase_orders po ON po.id = poi.purchase_order_id
       JOIN inventory_items i ON i.id = poi.inventory_item_id
       JOIN units u ON u.id = i.unit_id
       WHERE po.restaurant_id = $1 AND po.id = $2
     ) t`,
    [restaurantId, purchaseOrderId]
  );

  return result.rows;
};

// The most a return not tied to a bill may credit per unit of an item: the
// highest price this supplier ever billed for it before GST (per unit of
// stock), and what the item costs today, for the service to choose from.
// Also the GST rates this supplier billed the item at, latest first: a debit
// note carries the rate the goods were bought at.
const findCreditCeiling = async (restaurantId, supplierId, itemId) => {
  const result = await pool.query(
    `SELECT
       (SELECT MAX(gi.taxable_amount / gi.quantity)
        FROM goods_receipt_items gi
        JOIN goods_receipts gr ON gr.id = gi.goods_receipt_id
        WHERE gr.restaurant_id = $1 AND gr.supplier_id = $2 AND gr.receipt_status = 'posted'
          AND gi.inventory_item_id = $3 AND gi.quantity > 0) AS supplier_max,
       COALESCE((
         SELECT array_agg(rates.tax_rate ORDER BY rates.latest DESC)
         FROM (
           SELECT gi.tax_rate, MAX(gr.id) AS latest
           FROM goods_receipt_items gi
           JOIN goods_receipts gr ON gr.id = gi.goods_receipt_id
           WHERE gr.restaurant_id = $1 AND gr.supplier_id = $2 AND gr.receipt_status = 'posted'
             AND gi.inventory_item_id = $3 AND gi.quantity > 0
           GROUP BY gi.tax_rate
         ) rates
       ), '{}') AS supplier_rates,
       (SELECT last_cost FROM inventory_items WHERE restaurant_id = $1 AND id = $3) AS last_cost`,
    [restaurantId, supplierId, itemId]
  );

  const row = result.rows[0];

  return {
    supplierMax: row.supplier_max === null ? null : Number(row.supplier_max),
    supplierRates: (row.supplier_rates || []).map(Number),
    lastCost: row.last_cost === null ? null : Number(row.last_cost),
  };
};

// What a supplier has supplied of each item, and what has gone back to them.
// Supplied is every delivery against their orders (the order line's received
// quantity, which a voided bill takes back off) plus every bill of theirs
// with no order behind it. Returned is every standing return to them,
// whatever it names: a bill, an order or nothing. A return can never take
// the second figure past the first — you can only send a supplier back what
// they sent you. Before, a return with no bill was held only to what was on
// the shelf, and credited a supplier for 10 kg of paneer they never supplied.
const findSupplierReturnable = async (restaurantId, supplierId, itemIds, client = pool) => {
  const result = await client.query(
    `SELECT i.id AS inventory_item_id, i.name AS item_name, u.short_name AS unit_short_name,
            COALESCE((
              SELECT SUM(poi.received_quantity) FROM purchase_order_items poi
              JOIN purchase_orders po ON po.id = poi.purchase_order_id
              WHERE po.restaurant_id = $1 AND po.supplier_id = $2 AND poi.inventory_item_id = i.id
            ), 0)
            + COALESCE((
              SELECT SUM(gi.quantity) FROM goods_receipt_items gi
              JOIN goods_receipts gr ON gr.id = gi.goods_receipt_id
              WHERE gr.restaurant_id = $1 AND gr.supplier_id = $2 AND gr.receipt_status = 'posted'
                AND gr.purchase_order_id IS NULL AND gi.inventory_item_id = i.id
            ), 0) AS supplied,
            COALESCE((
              SELECT SUM(pri.quantity) FROM purchase_return_items pri
              JOIN purchase_returns pr ON pr.id = pri.purchase_return_id
              WHERE pr.restaurant_id = $1 AND pr.supplier_id = $2 AND pr.return_status = 'posted'
                AND pri.inventory_item_id = i.id
            ), 0) AS returned
     FROM inventory_items i
     JOIN units u ON u.id = i.unit_id
     WHERE i.restaurant_id = $1 AND i.id = ANY($3::bigint[])`,
    [restaurantId, supplierId, itemIds]
  );

  return result.rows.map((row) => ({
    inventoryItemId: Number(row.inventory_item_id),
    itemName: row.item_name,
    unit: row.unit_short_name,
    supplied: Number(row.supplied),
    returned: Number(row.returned),
  }));
};

// The day an order's goods first arrived: its earliest standing delivery, or
// for an order received before deliveries were kept as bills, its earliest
// stock movement. Nothing can go back against the order before that day.
const findFirstArrival = async (restaurantId, purchaseOrderId) => {
  const result = await pool.query(
    `SELECT COALESCE(
       (SELECT MIN(gr.received_date) FROM goods_receipts gr
        WHERE gr.restaurant_id = $1 AND gr.purchase_order_id = $2 AND gr.receipt_status = 'posted'),
       (SELECT MIN((st.effective_at AT TIME ZONE
                    COALESCE((SELECT timezone FROM restaurant_settings WHERE restaurant_id = $1), 'Asia/Kolkata'))::date)
        FROM stock_transactions st
        WHERE st.restaurant_id = $1 AND st.reference_type = 'purchase_order' AND st.reference_id = $2
          AND st.quantity > 0)
     )::text AS arrived`,
    [restaurantId, purchaseOrderId]
  );

  return result.rows[0].arrived;
};

// Cash handed to suppliers out of the drawer on a trading day: what the
// drawer holds less of at day-end. Voided payments are left out.
//
// byOutlet lists the same by the till that paid (outletId null: the main
// counter), so a restaurant with branch tills sees whose drawer is short.
const findTillPayments = async (restaurantId, businessDate) => {
  const result = await pool.query(
    `SELECT sp.outlet_id, o.name AS outlet_name, COUNT(*)::int AS count, COALESCE(SUM(sp.amount), 0) AS amount
     FROM supplier_payments sp
     LEFT JOIN outlets o ON o.id = sp.outlet_id
     WHERE sp.restaurant_id = $1 AND sp.paid_from_till AND sp.payment_status = 'posted'
       AND sp.business_date = $2::date
     GROUP BY sp.outlet_id, o.name
     ORDER BY sp.outlet_id NULLS FIRST`,
    [restaurantId, businessDate]
  );

  const count = result.rows.reduce((sum, row) => sum + row.count, 0);
  const amount = Math.round(result.rows.reduce((sum, row) => sum + Number(row.amount) * 100, 0)) / 100;

  return {
    count,
    amount,
    byOutlet: result.rows.map((row) => ({
      outletId: row.outlet_id === null ? null : Number(row.outlet_id),
      outletName: row.outlet_name || "Main counter",
      count: row.count,
      amount: Number(row.amount),
    })),
  };
};

// Sending goods back reduces stock, so the return and the stock movements are
// written together. The goods leave the shelf at what they are worth on the
// books — the item's average cost — exactly as wastage or a stock-out does,
// so the average cost of what stays behind does not move. What the supplier
// credits is money, kept on the return's own lines: a damaged crate sent back
// for a replacement at ₹0, or credited at a discount, says nothing about what
// the oil left on the shelf cost. (Recording the return at the credit price
// and re-averaging made half a tin sent back for replacement raise the cost
// of every dish that uses oil.)
//
// What can still go back is checked again here, with the bill and the order
// locked (bill first, then order, the order a bill void takes them in). The
// service checked it before, but two people returning the last crate at once,
// or a return racing the bill's void, both passed that check.
const create = async (restaurantId, data, userId) => {
  const client = await pool.connect();
  // The item whose stock is being taken out, to name it if the shelf is short.
  let moving = null;

  try {
    await client.query("BEGIN");

    if (data.goodsReceiptId) {
      const bill = await client.query(
        "SELECT receipt_number, receipt_status FROM goods_receipts WHERE restaurant_id = $1 AND id = $2 FOR UPDATE",
        [restaurantId, data.goodsReceiptId]
      );

      if (bill.rows.length === 0 || bill.rows[0].receipt_status !== "posted") {
        await client.query("ROLLBACK");
        return { error: "BILL_VOID", receiptNumber: bill.rows[0] ? bill.rows[0].receipt_number : null };
      }
    }

    if (data.purchaseOrderId) {
      await client.query("SELECT id FROM purchase_orders WHERE restaurant_id = $1 AND id = $2 FOR UPDATE", [
        restaurantId,
        data.purchaseOrderId,
      ]);
    }

    // Returns to one supplier go one at a time, so two returns of the last
    // kilo at once cannot both find it still unreturned. NO KEY UPDATE, so a
    // bill or payment being written for the same supplier is not held up.
    // Taken after the bill and the order, the order every writer takes them.
    await client.query("SELECT id FROM suppliers WHERE restaurant_id = $1 AND id = $2 FOR NO KEY UPDATE", [
      restaurantId,
      data.supplierId,
    ]);

    if (data.goodsReceiptId || data.purchaseOrderId) {
      const returnable = await findReturnable(
        restaurantId,
        data.goodsReceiptId ? { goodsReceiptId: data.goodsReceiptId } : { purchaseOrderId: data.purchaseOrderId },
        client
      );

      for (const item of data.items) {
        const row = returnable.find((line) => Number(line.inventory_item_id) === Number(item.inventoryItemId));
        const available = row ? Math.round(Number(row.available) * 1000) / 1000 : 0;

        if (item.quantity > available + 0.0005) {
          await client.query("ROLLBACK");
          return {
            error: "TOO_MUCH",
            itemName: row ? row.item_name : null,
            unit: row ? row.unit_short_name : null,
            available: Math.max(available, 0),
          };
        }
      }
    }

    const returnNumber = await nextNumber(client, restaurantId, "PR");

    const inserted = await client.query(
      `INSERT INTO purchase_returns (restaurant_id, supplier_id, purchase_order_id, goods_receipt_id,
                                     return_number, return_date, taxable_amount, tax_amount,
                                     total_amount, reason, notes, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
       RETURNING id`,
      [
        restaurantId,
        data.supplierId,
        data.purchaseOrderId || null,
        data.goodsReceiptId || null,
        returnNumber,
        data.returnDate,
        data.taxableAmount,
        data.taxAmount,
        data.totalAmount,
        data.reason,
        data.notes,
        userId,
      ]
    );

    const returnId = inserted.rows[0].id;

    for (const item of data.items) {
      moving = item.inventoryItemId;
      await client.query(
        `INSERT INTO purchase_return_items (purchase_return_id, inventory_item_id, goods_receipt_item_id,
                                            quantity, unit_price, tax_rate, tax_amount, amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          returnId,
          item.inventoryItemId,
          item.goodsReceiptItemId || null,
          item.quantity,
          item.unitPrice,
          item.taxRate,
          item.taxAmount,
          item.amount,
        ]
      );

      const balance = await inventoryRepository.recordMovement(
        client,
        restaurantId,
        {
          inventoryItemId: item.inventoryItemId,
          outletId: data.storeId,
          transactionType: "return",
          quantity: -item.quantity,
          // No unitCost: stock going out is valued at the item's average
          // cost, and without `revalue` that average stays where it was.
          keepLastCost: true,
          reason: `Returned to supplier: ${data.reason}`,
          referenceType: "purchase_return",
          referenceId: returnId,
          notes: returnNumber,
        },
        userId
      );

      if (balance === null) {
        await client.query("ROLLBACK");
        return { error: "ITEM_NOT_FOUND" };
      }
    }

    // With this return written, nothing may have gone back to the supplier
    // that they did not supply (checked after the shelf, so goods that are
    // not there are refused as that first).
    const standing = await findSupplierReturnable(
      restaurantId,
      data.supplierId,
      data.items.map((item) => item.inventoryItemId),
      client
    );

    for (const row of standing) {
      if (row.returned > row.supplied + 0.0005) {
        const now = data.items.find((item) => Number(item.inventoryItemId) === row.inventoryItemId);
        const before = Math.round((row.returned - Number(now.quantity)) * 1000) / 1000;

        await client.query("ROLLBACK");
        return {
          error: "SUPPLIER_CAP",
          itemName: row.itemName,
          unit: row.unit,
          supplied: Math.round(row.supplied * 1000) / 1000,
          returnedBefore: before,
          available: Math.max(Math.round((row.supplied - before) * 1000) / 1000, 0),
        };
      }
    }

    await client.query("COMMIT");
    return { purchaseReturn: await findById(restaurantId, returnId, client) };
  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === "NEGATIVE_STOCK") {
      return { error: "NEGATIVE_STOCK", currentStock: error.currentStock, inventoryItemId: moving };
    }

    throw error;
  } finally {
    client.release();
  }
};

// Corrects what the supplier credited — the date, the reason, the price per
// line — without touching quantities: stock already left, and changing what
// left is a void and a new return. The credit is money owed back by the
// supplier, not a stock figure, so the stock ledger is left as it was: the
// goods left at their book value whatever the supplier ends up crediting.
const update = async (restaurantId, id, data, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const locked = await client.query(
      "SELECT return_status FROM purchase_returns WHERE restaurant_id = $1 AND id = $2 FOR UPDATE",
      [restaurantId, id]
    );

    if (locked.rows.length === 0) {
      await client.query("ROLLBACK");
      return { error: "NOT_FOUND" };
    }

    if (locked.rows[0].return_status !== "posted") {
      await client.query("ROLLBACK");
      return { error: "VOID" };
    }

    for (const line of data.lines) {
      const updated = await client.query(
        `UPDATE purchase_return_items
         SET unit_price = $3, tax_amount = $4, amount = $5
         WHERE purchase_return_id = $1 AND id = $2
         RETURNING inventory_item_id`,
        [id, line.id, line.unitPrice, line.taxAmount, line.amount]
      );

      if (updated.rows.length === 0) {
        await client.query("ROLLBACK");
        return { error: "LINE_NOT_FOUND" };
      }
    }

    await client.query(
      `UPDATE purchase_returns
       SET return_date = $3, reason = $4, notes = $5, taxable_amount = $6, tax_amount = $7,
           total_amount = $8, updated_by = $9
       WHERE restaurant_id = $1 AND id = $2`,
      [
        restaurantId,
        id,
        data.returnDate,
        data.reason,
        data.notes,
        data.taxableAmount,
        data.taxAmount,
        data.totalAmount,
        userId,
      ]
    );

    await client.query("COMMIT");
    return { purchaseReturn: await findById(restaurantId, id, client) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// The store a return's goods left from (null: the main store), or undefined
// when there is no such return in this restaurant.
const findReturnStore = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT (SELECT st.outlet_id FROM stock_transactions st
             WHERE st.restaurant_id = pr.restaurant_id AND st.reference_type = 'purchase_return'
               AND st.reference_id = pr.id
             ORDER BY st.id LIMIT 1) AS outlet_id
     FROM purchase_returns pr WHERE pr.restaurant_id = $1 AND pr.id = $2`,
    [restaurantId, id]
  );

  if (result.rows.length === 0) {
    return undefined;
  }

  return result.rows[0].outlet_id === null ? null : Number(result.rows[0].outlet_id);
};

// A return entered by mistake: the goods come back onto the shelf they left,
// and the credit no longer counts against what the supplier is owed.
const voidReturn = async (restaurantId, id, reason, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const locked = await client.query(
      `SELECT pr.id, pr.return_number, pr.return_status
       FROM purchase_returns pr WHERE pr.restaurant_id = $1 AND pr.id = $2 FOR UPDATE`,
      [restaurantId, id]
    );

    const found = locked.rows[0];

    if (!found) {
      await client.query("ROLLBACK");
      return { error: "NOT_FOUND" };
    }

    if (found.return_status !== "posted") {
      await client.query("ROLLBACK");
      return { error: "ALREADY_VOID" };
    }

    // Back to the store each line left from, at exactly the value it took
    // off the books, so the void undoes the return and nothing else: the
    // average it left at, or — for a return written before that rule, which
    // left at the supplier's credit and re-averaged — that same value again.
    // Each movement is read with the average just before it (the previous
    // ledger row's); inventoryRepository.returnedAt has the arithmetic. Never
    // the credit price as such: the credit is money owed back, not stock.
    const movements = await client.query(
      `SELECT st.inventory_item_id, st.outlet_id, st.quantity, st.unit_cost, st.average_cost_after,
              st.balance_after,
              (SELECT p.average_cost_after FROM stock_transactions p
               WHERE p.inventory_item_id = st.inventory_item_id AND p.id < st.id
                 AND p.average_cost_after IS NOT NULL
               ORDER BY p.id DESC LIMIT 1) AS average_before
       FROM stock_transactions st
       WHERE st.restaurant_id = $1 AND st.reference_type = 'purchase_return' AND st.reference_id = $2
       ORDER BY st.id`,
      [restaurantId, id]
    );

    for (const movement of movements.rows) {
      const cost = inventoryRepository.returnedAt(movement);

      await inventoryRepository.recordMovement(
        client,
        restaurantId,
        {
          inventoryItemId: movement.inventory_item_id,
          outletId: movement.outlet_id,
          transactionType: "return",
          quantity: -Number(movement.quantity),
          unitCost: cost,
          keepLastCost: true,
          revalue: true,
          reason: `Return voided: ${reason}`,
          referenceType: "purchase_return_void",
          referenceId: id,
          notes: found.return_number,
        },
        userId
      );
    }

    await client.query(
      `UPDATE purchase_returns
       SET return_status = 'void', void_reason = $3, voided_at = NOW(), voided_by = $4, updated_by = $4
       WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, id, reason, userId]
    );

    await client.query("COMMIT");
    return { purchaseReturn: await findById(restaurantId, id, client) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// --- Supplier payments ---

const PAYMENT_COLUMNS = `sp.id, sp.supplier_id, sp.purchase_order_id, sp.goods_receipt_id, sp.payment_date,
       sp.amount, sp.payment_method, sp.reference_no, sp.notes, sp.payment_status, sp.void_reason,
       sp.voided_at, sp.paid_from_till, sp.business_date, sp.created_at, sp.updated_at,
       sp.outlet_id, tl.name AS till_outlet_name,
       s.name AS supplier_name, po.po_number, gr.receipt_number, gr.bill_number,
       u.name AS created_by_name, vu.name AS voided_by_name`;

const PAYMENT_JOINS = `
     JOIN suppliers s ON s.id = sp.supplier_id
     LEFT JOIN purchase_orders po ON po.id = sp.purchase_order_id
     LEFT JOIN goods_receipts gr ON gr.id = sp.goods_receipt_id
     LEFT JOIN users u ON u.id = sp.created_by
     LEFT JOIN users vu ON vu.id = sp.voided_by
     LEFT JOIN outlets tl ON tl.id = sp.outlet_id`;

// filters as findAll: { supplierId, status, from, to (the payment's date),
// limit, offset }.
const findPayments = async (restaurantId, filters = {}) => {
  const result = await pool.query(
    `SELECT ${PAYMENT_COLUMNS}, COUNT(*) OVER ()::int AS total_count
     FROM supplier_payments sp
     ${PAYMENT_JOINS}
     WHERE sp.restaurant_id = $1
       AND ($2::bigint IS NULL OR sp.supplier_id = $2)
       AND ($3::text IS NULL OR sp.payment_status = $3)
       AND ($4::date IS NULL OR sp.payment_date >= $4::date)
       AND ($5::date IS NULL OR sp.payment_date <= $5::date)
     ORDER BY sp.payment_date DESC, sp.id DESC
     LIMIT $6 OFFSET $7`,
    [
      restaurantId,
      filters.supplierId || null,
      filters.status || null,
      filters.from || null,
      filters.to || null,
      filters.limit || 200,
      filters.offset || 0,
    ]
  );

  return result.rows;
};

const findPaymentById = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT ${PAYMENT_COLUMNS}
     FROM supplier_payments sp
     ${PAYMENT_JOINS}
     WHERE sp.restaurant_id = $1 AND sp.id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// A payment against a named bill holds the bill while it is written. The
// bill's void takes the same lock, so the two go one after the other: a
// payment recorded in the same second as the void either lands first (and the
// void deals with it) or finds the bill voided and is refused. Before, 11 of
// 12 such races left a payment posted against a bill that no longer counted.
//
// Returns { id } or { error: "BILL_VOID", receiptNumber }.
const createPayment = async (restaurantId, data, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (data.goodsReceiptId) {
      const bill = await client.query(
        "SELECT receipt_number, receipt_status FROM goods_receipts WHERE restaurant_id = $1 AND id = $2 FOR SHARE",
        [restaurantId, data.goodsReceiptId]
      );

      if (bill.rows.length === 0 || bill.rows[0].receipt_status !== "posted") {
        await client.query("ROLLBACK");
        return { error: "BILL_VOID", receiptNumber: bill.rows[0] ? bill.rows[0].receipt_number : null };
      }
    }

    const result = await client.query(
      `INSERT INTO supplier_payments (restaurant_id, supplier_id, purchase_order_id, goods_receipt_id,
                                      payment_date, amount, payment_method, reference_no, notes,
                                      paid_from_till, business_date, created_by, updated_by, outlet_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, $13)
       RETURNING id`,
      [
        restaurantId,
        data.supplierId,
        data.purchaseOrderId || null,
        data.goodsReceiptId || null,
        data.paymentDate,
        data.amount,
        data.paymentMethod,
        data.referenceNo,
        data.notes,
        data.paidFromTill,
        data.businessDate || null,
        userId,
        // The till's outlet: whose drawer the cash came out of.
        data.paidFromTill ? data.tillOutletId || null : null,
      ]
    );

    await client.query("COMMIT");
    return { id: result.rows[0].id };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const updatePayment = async (restaurantId, id, data, userId) => {
  const result = await pool.query(
    `UPDATE supplier_payments
     SET payment_date = $3, amount = $4, payment_method = $5, reference_no = $6, notes = $7,
         paid_from_till = $8, business_date = $9, updated_by = $10,
         outlet_id = CASE WHEN $8 THEN $11::bigint END
     WHERE restaurant_id = $1 AND id = $2 AND payment_status = 'posted'
     RETURNING id`,
    [
      restaurantId,
      id,
      data.paymentDate,
      data.amount,
      data.paymentMethod,
      data.referenceNo,
      data.notes,
      data.paidFromTill,
      data.businessDate || null,
      userId,
      data.tillOutletId || null,
    ]
  );

  return result.rows[0] || null;
};

const voidPayment = async (restaurantId, id, reason, userId) => {
  const result = await pool.query(
    `UPDATE supplier_payments
     SET payment_status = 'void', void_reason = $3, voided_at = NOW(), voided_by = $4, updated_by = $4
     WHERE restaurant_id = $1 AND id = $2 AND payment_status = 'posted'
     RETURNING id`,
    [restaurantId, id, reason, userId]
  );

  return result.rows[0] || null;
};

// --- What each supplier is owed ---

// Bills received, less goods returned, less payments made — voided entries
// left out. Each figure is the supplier's own bills, so it matches their
// statement rather than the purchase order's hopes.
const outstanding = async (restaurantId) => {
  const result = await pool.query(
    `SELECT s.id, s.name, s.mobile, s.payment_terms, s.credit_days, s.status,
            COALESCE(billed.value, 0) AS purchased,
            COALESCE(returned.value, 0) AS returned,
            COALESCE(paid.value, 0) AS paid,
            COALESCE(billed.value, 0) - COALESCE(returned.value, 0) - COALESCE(paid.value, 0)
              AS outstanding
     FROM suppliers s
     LEFT JOIN LATERAL (
       SELECT SUM(gr.total_amount) AS value
       FROM goods_receipts gr
       WHERE gr.supplier_id = s.id AND gr.receipt_status = 'posted'
     ) AS billed ON TRUE
     LEFT JOIN LATERAL (
       SELECT SUM(pr.total_amount) AS value
       FROM purchase_returns pr WHERE pr.supplier_id = s.id AND pr.return_status = 'posted'
     ) AS returned ON TRUE
     LEFT JOIN LATERAL (
       SELECT SUM(sp.amount) AS value
       FROM supplier_payments sp WHERE sp.supplier_id = s.id AND sp.payment_status = 'posted'
     ) AS paid ON TRUE
     WHERE s.restaurant_id = $1
     ORDER BY outstanding DESC, s.name`,
    [restaurantId]
  );

  return result.rows;
};

// Every posted bill, return and payment — the raw material for ageing and
// statements. Kept as three plain lists; the arithmetic is in the service.
const findLedger = async (restaurantId, supplierId = null) => {
  const bills = await pool.query(
    `SELECT gr.id, gr.supplier_id, gr.receipt_number, gr.bill_number, gr.bill_date, gr.due_date,
            gr.total_amount, gr.receipt_status, gr.void_reason, gr.payment_mode, gr.created_at,
            gr.outlet_id, po.po_number
     FROM goods_receipts gr
     LEFT JOIN purchase_orders po ON po.id = gr.purchase_order_id
     WHERE gr.restaurant_id = $1 AND ($2::bigint IS NULL OR gr.supplier_id = $2)
     ORDER BY gr.bill_date, gr.id`,
    [restaurantId, supplierId]
  );

  const returns = await pool.query(
    `SELECT pr.id, pr.supplier_id, pr.return_number, pr.return_date, pr.total_amount, pr.reason,
            pr.goods_receipt_id, pr.return_status, pr.void_reason, pr.created_at
     FROM purchase_returns pr
     WHERE pr.restaurant_id = $1 AND ($2::bigint IS NULL OR pr.supplier_id = $2)
     ORDER BY pr.return_date, pr.id`,
    [restaurantId, supplierId]
  );

  const payments = await pool.query(
    `SELECT sp.id, sp.supplier_id, sp.payment_date, sp.amount, sp.payment_method, sp.reference_no,
            sp.goods_receipt_id, sp.payment_status, sp.void_reason, sp.paid_from_till, sp.created_at
     FROM supplier_payments sp
     WHERE sp.restaurant_id = $1 AND ($2::bigint IS NULL OR sp.supplier_id = $2)
     ORDER BY sp.payment_date, sp.id`,
    [restaurantId, supplierId]
  );

  return { bills: bills.rows, returns: returns.rows, payments: payments.rows };
};

module.exports = {
  findAll,
  findById,
  findReturnable,
  findSupplierReturnable,
  findFirstArrival,
  findCreditCeiling,
  findTillPayments,
  create,
  update,
  voidReturn,
  findReturnStore,
  findPayments,
  findPaymentById,
  createPayment,
  updatePayment,
  voidPayment,
  outstanding,
  findLedger,
};
