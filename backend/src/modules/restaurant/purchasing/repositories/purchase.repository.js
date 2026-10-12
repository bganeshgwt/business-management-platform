const pool = require("../../../../config/database");
const inventoryRepository = require("../../inventory/repositories/inventory.repository");
const purchaseReturnRepository = require("./purchaseReturn.repository");
const { nextNumber } = require("../../../../utils/docNumber");
const { MAX_AMOUNT } = require("../../../../utils/amountLimit");

const TIMEZONE = `COALESCE((SELECT timezone FROM restaurant_settings WHERE restaurant_id = $1), 'Asia/Kolkata')`;

// --- Purchase orders ---

const findAll = async (restaurantId, filters = {}) => {
  const result = await pool.query(
    `SELECT po.id, po.po_number, po.order_date, po.expected_date, po.total_amount,
            po.po_status, po.notes, po.supplier_id, po.outlet_id, po.closed_reason,
            po.approval_requested_at, po.approved_at, po.approved_amount, po.rejected_at, po.rejection_note,
            rq.name AS approval_requested_by_name, ap.name AS approved_by_name, rj.name AS rejected_by_name,
            s.name AS supplier_name, o.name AS outlet_name, o.status AS outlet_status,
            (SELECT COUNT(*)::int FROM purchase_order_items poi WHERE poi.purchase_order_id = po.id) AS item_count,
            (SELECT COALESCE(SUM(gr.total_amount), 0) FROM goods_receipts gr
              WHERE gr.purchase_order_id = po.id AND gr.receipt_status = 'posted') AS billed_amount,
            (SELECT COUNT(*)::int FROM goods_receipts gr
              WHERE gr.purchase_order_id = po.id AND gr.receipt_status = 'posted') AS receipt_count
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     LEFT JOIN outlets o ON o.id = po.outlet_id
     LEFT JOIN users rq ON rq.id = po.approval_requested_by
     LEFT JOIN users ap ON ap.id = po.approved_by
     LEFT JOIN users rj ON rj.id = po.rejected_by
     WHERE po.restaurant_id = $1
       AND ($2::text[] IS NULL OR po.po_status = ANY($2))
       AND ($3::bigint IS NULL OR po.supplier_id = $3)
       AND ($4::text IS NULL OR po.po_number ILIKE '%' || $4 || '%' OR s.name ILIKE '%' || $4 || '%')
       AND ($5::date IS NULL OR po.order_date >= $5::date)
       AND ($6::date IS NULL OR po.order_date <= $6::date)
       -- One store only (someone tied to an outlet): an outlet's own store,
       -- or the main store (orders raised with no outlet, or at an outlet
       -- that sells from the main store).
       AND ($7::bigint IS NULL OR po.outlet_id = $7)
       AND ($8::boolean IS NOT TRUE OR po.outlet_id IS NULL OR COALESCE(o.own_store, FALSE) = FALSE)
     ORDER BY po.order_date DESC, po.id DESC`,
    [
      restaurantId,
      filters.status || null,
      filters.supplierId || null,
      filters.search || null,
      filters.from || null,
      filters.to || null,
      filters.store && filters.store.outletId ? filters.store.outletId : null,
      Boolean(filters.store && filters.store.main),
    ]
  );

  return result.rows;
};

const findById = async (restaurantId, id, client = pool) => {
  const orderResult = await client.query(
    `SELECT po.id, po.po_number, po.order_date, po.expected_date, po.total_amount,
            po.po_status, po.notes, po.supplier_id, po.outlet_id, po.closed_reason, po.created_at,
            po.approval_requested_at, po.approved_at, po.approved_amount, po.approval_note,
            po.rejected_at, po.rejection_note,
            rq.name AS approval_requested_by_name, ap.name AS approved_by_name, rj.name AS rejected_by_name,
            s.name AS supplier_name, s.mobile AS supplier_mobile, s.email AS supplier_email,
            s.gst_number AS supplier_gstin, s.address AS supplier_address,
            s.contact_person AS supplier_contact, s.credit_days AS supplier_credit_days,
            o.name AS outlet_name, o.status AS outlet_status, u.name AS created_by_name
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     LEFT JOIN outlets o ON o.id = po.outlet_id
     LEFT JOIN users u ON u.id = po.created_by
     LEFT JOIN users rq ON rq.id = po.approval_requested_by
     LEFT JOIN users ap ON ap.id = po.approved_by
     LEFT JOIN users rj ON rj.id = po.rejected_by
     WHERE po.restaurant_id = $1 AND po.id = $2`,
    [restaurantId, id]
  );

  const order = orderResult.rows[0];

  if (!order) {
    return null;
  }

  const itemsResult = await client.query(
    `SELECT poi.id, poi.inventory_item_id, poi.quantity, poi.received_quantity,
            poi.unit_price, poi.amount, poi.pack_id, poi.pack_name, poi.pack_size,
            poi.pack_quantity, poi.pack_price,
            i.name AS item_name, u.short_name AS unit_short_name
     FROM purchase_order_items poi
     JOIN inventory_items i ON i.id = poi.inventory_item_id
     JOIN units u ON u.id = i.unit_id
     WHERE poi.purchase_order_id = $1
     ORDER BY poi.id`,
    [id]
  );

  const receiptsResult = await client.query(
    `SELECT gr.id, gr.receipt_number, gr.bill_number, gr.bill_date, gr.received_date,
            gr.total_amount, gr.receipt_status, gr.payment_mode
     FROM goods_receipts gr
     WHERE gr.restaurant_id = $1 AND gr.purchase_order_id = $2
     ORDER BY gr.id`,
    [restaurantId, id]
  );

  return { ...order, items: itemsResult.rows, receipts: receiptsResult.rows };
};

const insertOrderLines = async (client, orderId, items) => {
  for (const item of items) {
    await client.query(
      `INSERT INTO purchase_order_items
         (purchase_order_id, inventory_item_id, quantity, unit_price, amount,
          pack_id, pack_name, pack_size, pack_quantity, pack_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        orderId,
        item.inventoryItemId,
        item.quantity,
        item.unitPrice,
        item.amount,
        item.packId || null,
        item.packName || null,
        item.packSize || null,
        item.packQuantity || null,
        item.packPrice ?? null,
      ]
    );
  }
};

const create = async (restaurantId, data, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const poNumber = await nextNumber(client, restaurantId, "PO");
    const total = data.items.reduce((sum, item) => sum + Number(item.amount), 0);

    const inserted = await client.query(
      `INSERT INTO purchase_orders (restaurant_id, supplier_id, po_number, order_date,
                                    expected_date, total_amount, po_status, notes,
                                    created_by, updated_by, outlet_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10)
       RETURNING id`,
      [
        restaurantId,
        data.supplierId,
        poNumber,
        data.orderDate,
        data.expectedDate,
        total.toFixed(2),
        data.poStatus,
        data.notes,
        userId,
        data.outletId || null,
      ]
    );

    const orderId = inserted.rows[0].id;

    await insertOrderLines(client, orderId, data.items);

    await client.query("COMMIT");
    return await findById(restaurantId, orderId, client);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// A draft has gone nowhere yet, so its lines are simply replaced.
const updateDraft = async (restaurantId, id, data, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const locked = await client.query(
      "SELECT po_status FROM purchase_orders WHERE restaurant_id = $1 AND id = $2 FOR UPDATE",
      [restaurantId, id]
    );

    if (locked.rows.length === 0) {
      await client.query("ROLLBACK");
      return { error: "NOT_FOUND" };
    }

    if (locked.rows[0].po_status !== "draft") {
      await client.query("ROLLBACK");
      return { error: "NOT_DRAFT", status: locked.rows[0].po_status };
    }

    const total = data.items.reduce((sum, item) => sum + Number(item.amount), 0);

    await client.query(
      `UPDATE purchase_orders
       SET supplier_id = $3, order_date = $4, expected_date = $5, notes = $6,
           total_amount = $7, updated_by = $8
       WHERE restaurant_id = $1 AND id = $2`,
      [
        restaurantId,
        id,
        data.supplierId,
        data.orderDate,
        data.expectedDate,
        data.notes,
        total.toFixed(2),
        userId,
      ]
    );

    await client.query("DELETE FROM purchase_order_items WHERE purchase_order_id = $1", [id]);
    await insertOrderLines(client, id, data.items);

    await client.query("COMMIT");
    return { order: await findById(restaurantId, id, client) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// --- Approval of orders over the limit (Settings → Stock & purchasing) ---
//
// Each step moves the order only from the status it is expected to be in, so
// two approvers pressing at the same moment move it once; the second is told
// where it now stands (null comes back).

// Draft → waiting for approval. A send-back from before is cleared: this is
// a new request.
const requestApproval = async (restaurantId, id, userId) => {
  const result = await pool.query(
    `UPDATE purchase_orders
     SET po_status = 'pending_approval', approval_requested_at = NOW(), approval_requested_by = $3,
         rejected_at = NULL, rejected_by = NULL, rejection_note = NULL, updated_by = $3
     WHERE restaurant_id = $1 AND id = $2 AND po_status = 'draft'
     RETURNING id`,
    [restaurantId, id, userId]
  );

  return result.rows[0] || null;
};

// Draft (ordered by someone allowed to approve it) or waiting → ordered, with
// who approved it and the total they saw. `approval` null: under the limit,
// nobody needed to approve.
const markOrdered = async (restaurantId, id, userId, approval = null) => {
  const result = await pool.query(
    `UPDATE purchase_orders
     SET po_status = 'ordered', updated_by = $3,
         approved_at = CASE WHEN $4::boolean THEN NOW() ELSE approved_at END,
         approved_by = CASE WHEN $4::boolean THEN $5::bigint ELSE approved_by END,
         approved_amount = CASE WHEN $4::boolean THEN total_amount ELSE approved_amount END,
         approval_note = CASE WHEN $4::boolean THEN $6::varchar ELSE approval_note END
     WHERE restaurant_id = $1 AND id = $2 AND po_status = ANY($7::text[])
     RETURNING id`,
    [
      restaurantId,
      id,
      userId,
      Boolean(approval),
      approval ? approval.approvedBy : null,
      approval ? approval.note : null,
      approval && approval.fromWaiting ? ["pending_approval"] : ["draft"],
    ]
  );

  return result.rows[0] || null;
};

// Waiting → back to draft. With a note it is a send-back by the approver
// (kept on the order for the buyer to read); without, the buyer has taken it
// back to change it.
const returnToDraft = async (restaurantId, id, userId, rejection = null) => {
  const result = await pool.query(
    `UPDATE purchase_orders
     SET po_status = 'draft', updated_by = $3,
         approval_requested_at = NULL, approval_requested_by = NULL,
         rejected_at = CASE WHEN $4::boolean THEN NOW() ELSE rejected_at END,
         rejected_by = CASE WHEN $4::boolean THEN $5::bigint ELSE rejected_by END,
         rejection_note = CASE WHEN $4::boolean THEN $6::varchar ELSE rejection_note END
     WHERE restaurant_id = $1 AND id = $2 AND po_status = 'pending_approval'
     RETURNING id`,
    [restaurantId, id, userId, Boolean(rejection), rejection ? rejection.rejectedBy : null, rejection ? rejection.note : null]
  );

  return result.rows[0] || null;
};

const updateStatus = async (restaurantId, id, status, userId, reason = null) => {
  const result = await pool.query(
    `UPDATE purchase_orders
     SET po_status = $3::varchar, updated_by = $4,
         closed_reason = CASE WHEN $3::varchar = 'closed' THEN $5::varchar ELSE closed_reason END
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id`,
    [restaurantId, id, status, userId, reason]
  );

  return result.rows[0] || null;
};

// Where an order stands after goods arrive or a delivery is voided: nothing
// outstanding is received; some arrived is part received; nothing arrived is
// back to ordered. A closed-short order stays closed unless a void takes it
// back below what had arrived when it was closed — then it is open again.
const recomputeStatus = async (client, orderId, userId) => {
  const result = await client.query(
    `SELECT COUNT(*) FILTER (WHERE received_quantity < quantity)::int AS open_lines,
            COALESCE(SUM(received_quantity), 0) AS received
     FROM purchase_order_items WHERE purchase_order_id = $1`,
    [orderId]
  );

  const { open_lines: openLines, received } = result.rows[0];
  const status = openLines === 0 ? "received" : Number(received) > 0 ? "partial" : "ordered";

  await client.query(
    `UPDATE purchase_orders
     SET po_status = $2::varchar, updated_by = $3,
         closed_reason = CASE WHEN $2::varchar = 'received' THEN closed_reason ELSE NULL END
     WHERE id = $1 AND po_status NOT IN ('cancelled')`,
    [orderId, status, userId]
  );

  return status;
};

// --- Goods receipts ---

// Writes one delivery: the receipt, its lines, the stock coming in at the
// price actually paid, and — for a bill paid on the spot — the payment. Used
// both for a delivery against a purchase order and for a bill with no order.
const writeReceipt = async (client, restaurantId, receipt, userId) => {
  const receiptNumber = await nextNumber(client, restaurantId, "GRN");

  const inserted = await client.query(
    `INSERT INTO goods_receipts (restaurant_id, receipt_number, supplier_id, purchase_order_id,
                                 outlet_id, bill_number, bill_date, received_date, due_date,
                                 payment_mode, prices_include_tax, taxable_amount, tax_amount,
                                 round_off, total_amount, notes, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17)
     RETURNING id`,
    [
      restaurantId,
      receiptNumber,
      receipt.supplierId,
      receipt.purchaseOrderId || null,
      receipt.storeId,
      receipt.billNumber || null,
      receipt.billDate,
      receipt.receivedDate,
      receipt.dueDate,
      receipt.paymentMode,
      receipt.pricesIncludeTax,
      receipt.taxableAmount,
      receipt.taxAmount,
      receipt.roundOff,
      receipt.totalAmount,
      receipt.notes || null,
      userId,
    ]
  );

  const receiptId = inserted.rows[0].id;
  const label = receipt.billNumber ? `${receiptNumber} · Bill ${receipt.billNumber}` : receiptNumber;

  // Goods received on an earlier day than the bill is typed in were on the
  // shelf from that day. Deliveries come in the morning, so a late entry is
  // placed at midday of the day received (restaurant time): the closing
  // stock of that day and a count taken that evening both expect it.
  // Received today, it is simply now.
  const when = await client.query(
    `SELECT CASE
              WHEN $2::date < (NOW() AT TIME ZONE ${TIMEZONE})::date
              THEN ($2::date + TIME '12:00') AT TIME ZONE ${TIMEZONE}
            END AS effective_at`,
    [restaurantId, receipt.receivedDate]
  );
  const effectiveAt = when.rows[0].effective_at;

  for (const line of receipt.lines) {
    await client.query(
      `INSERT INTO goods_receipt_items (goods_receipt_id, purchase_order_item_id, inventory_item_id,
                                        pack_id, pack_name, pack_size, bill_quantity,
                                        rejected_quantity, rejection_reason, quantity, unit_price,
                                        tax_rate, taxable_amount, tax_amount, amount, unit_cost)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        receiptId,
        line.purchaseOrderItemId || null,
        line.inventoryItemId,
        line.packId || null,
        line.packName || null,
        line.packSize || null,
        line.billQuantity,
        line.rejectedQuantity,
        line.rejectionReason || null,
        line.quantity,
        line.unitPrice,
        line.taxRate,
        line.taxableAmount,
        line.taxAmount,
        line.amount,
        line.unitCost,
      ]
    );

    if (line.quantity > 0) {
      // A bill typed in late — last month's, caught up today — is not what the
      // item costs now: a delivery priced since then keeps its price.
      const superseded = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM stock_transactions
           WHERE inventory_item_id = $1 AND sets_cost
             AND effective_at > COALESCE($2::timestamptz, NOW())
         ) AS newer`,
        [line.inventoryItemId, effectiveAt]
      );

      await inventoryRepository.recordMovement(
        client,
        restaurantId,
        {
          inventoryItemId: line.inventoryItemId,
          outletId: receipt.storeId,
          transactionType: "purchase",
          quantity: line.quantity,
          batchNumber: line.batchNumber,
          expiryDate: line.expiryDate,
          unitCost: line.unitCost,
          keepLastCost: superseded.rows[0].newer,
          revalue: true,
          effectiveAt,
          reason: receipt.purchaseOrderId ? "Goods received" : "Purchase bill",
          referenceType: "goods_receipt",
          referenceId: receiptId,
          notes: label,
        },
        userId
      );
    }
  }

  if (receipt.paymentMode === "paid" && receipt.totalAmount > 0) {
    await client.query(
      `INSERT INTO supplier_payments (restaurant_id, supplier_id, purchase_order_id, goods_receipt_id,
                                      payment_date, amount, payment_method, reference_no, notes,
                                      paid_from_till, business_date, created_by, updated_by, outlet_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, $13)`,
      [
        restaurantId,
        receipt.supplierId,
        receipt.purchaseOrderId || null,
        receiptId,
        receipt.billDate,
        receipt.totalAmount,
        receipt.paymentMethod,
        receipt.paymentReference || null,
        `Paid on delivery · ${label}`,
        receipt.paidFromTill,
        receipt.paidFromTill ? receipt.businessDate : null,
        userId,
        // The till's outlet: whose drawer the cash came out of.
        receipt.paidFromTill ? receipt.tillOutletId || null : null,
      ]
    );
  }

  return receiptId;
};

// A bill with no purchase order: the daily vegetables, meat and milk.
const createDirectReceipt = async (restaurantId, receipt, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const id = await writeReceipt(client, restaurantId, receipt, userId);
    await client.query("COMMIT");
    return { id };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// Receiving is the point where purchasing meets inventory: each accepted line
// adds stock, and everything happens in one transaction so stock can never
// increase without the order being updated, or the other way round.
//
// `receipt.lines` carry the purchase order line id, the quantity accepted and
// turned away (in the line's own buying unit) and the price actually billed.
// `price(line, orderLine)` works out the money for one line once the order
// line is known and locked.
const receive = async (restaurantId, id, receipt, userId, price) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const orderResult = await client.query(
      `SELECT id, po_status, supplier_id, outlet_id FROM purchase_orders
       WHERE restaurant_id = $1 AND id = $2 FOR UPDATE`,
      [restaurantId, id]
    );

    const order = orderResult.rows[0];

    if (!order) {
      await client.query("ROLLBACK");
      return { error: "NOT_FOUND" };
    }

    // Only an order that went to the supplier can bring goods in: not a
    // draft, and not one still waiting for an approver.
    if (!["ordered", "partial"].includes(order.po_status)) {
      await client.query("ROLLBACK");
      return { error: "BAD_STATUS", status: order.po_status };
    }

    const lines = [];
    const seen = new Set();

    for (const line of receipt.lines) {
      if (seen.has(line.itemId)) {
        await client.query("ROLLBACK");
        return { error: "DUPLICATE_LINE" };
      }

      seen.add(line.itemId);

      const itemResult = await client.query(
        `SELECT poi.id, poi.inventory_item_id, poi.quantity, poi.received_quantity, poi.unit_price,
                poi.pack_id, poi.pack_name, poi.pack_size, poi.pack_price, i.name AS item_name,
                i.current_stock, u.short_name AS unit_short_name
         FROM purchase_order_items poi
         JOIN inventory_items i ON i.id = poi.inventory_item_id
         JOIN units u ON u.id = i.unit_id
         WHERE poi.purchase_order_id = $1 AND poi.id = $2
         FOR UPDATE OF poi`,
        [id, line.itemId]
      );

      const orderLine = itemResult.rows[0];

      if (!orderLine) {
        await client.query("ROLLBACK");
        return { error: "LINE_NOT_FOUND" };
      }

      const priced = price(line, orderLine);
      const outstanding = Number(orderLine.quantity) - Number(orderLine.received_quantity);

      // A thousandth of a unit of slack for pack arithmetic (a third of a tray).
      if (priced.quantity > outstanding + 0.0005) {
        await client.query("ROLLBACK");
        return {
          error: "TOO_MUCH",
          outstanding: Math.round(outstanding * 1000) / 1000,
          unit: orderLine.unit_short_name,
          itemName: orderLine.item_name,
        };
      }

      // What was turned away is typed in the line's buying unit (tins, or
      // kg); it can be no more than was still due, in that same unit.
      const packSize = orderLine.pack_size !== null ? Number(orderLine.pack_size) : 1;

      if (Number(priced.rejectedQuantity || 0) * packSize > outstanding + 0.0005) {
        await client.query("ROLLBACK");
        return {
          error: "TOO_MANY_REJECTED",
          rejected: Math.round(Number(priced.rejectedQuantity) * 1000) / 1000,
          outstanding: Math.round((outstanding / packSize) * 1000) / 1000,
          unit: orderLine.pack_size !== null ? orderLine.pack_name : orderLine.unit_short_name,
          itemName: orderLine.item_name,
        };
      }

      lines.push({ ...priced, purchaseOrderItemId: orderLine.id });
    }

    const totals = receipt.totals(lines);

    if (totals.error) {
      await client.query("ROLLBACK");
      return totals;
    }

    // Where the goods go: the store of the outlet the order was raised for
    // (else the receiver's own outlet). An outlet closed since the order was
    // raised sells nothing and takes no stock in — a transfer, a Stock in or
    // a bill into it is refused — but the van is at the door and the goods
    // physically arrive somewhere, so they go into the main store, and the
    // bill and the screen say so. Read inside this transaction, with the
    // outlet row held, so an outlet being closed right now is seen.
    const wantedOutletId = order.outlet_id || receipt.outletId || null;
    const outletRow = wantedOutletId
      ? (
          await client.query("SELECT id, name, status FROM outlets WHERE restaurant_id = $1 AND id = $2 FOR SHARE", [
            restaurantId,
            wantedOutletId,
          ])
        ).rows[0] || null
      : null;
    const closedOutlet = outletRow && outletRow.status !== "active" ? outletRow.name : null;
    const storeNote = closedOutlet ? `${closedOutlet} is closed, so these goods went into the main store.` : null;

    const receiptId = await writeReceipt(
      client,
      restaurantId,
      {
        ...receipt,
        ...totals,
        lines,
        supplierId: order.supplier_id,
        purchaseOrderId: id,
        storeId: closedOutlet ? null : await inventoryRepository.storeFor(client, restaurantId, wantedOutletId),
        notes: storeNote ? [receipt.notes, storeNote].filter(Boolean).join(" · ") : receipt.notes,
      },
      userId
    );

    for (const line of lines) {
      if (line.quantity > 0) {
        await client.query(
          `UPDATE purchase_order_items SET received_quantity = received_quantity + $2 WHERE id = $1`,
          [line.purchaseOrderItemId, line.quantity]
        );
      }
    }

    await recomputeStatus(client, id, userId);

    await client.query("COMMIT");
    return { order: await findById(restaurantId, id, client), receiptId, closedOutlet, storeNote };
  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === "23505" && /uq_goods_receipts_bill/.test(error.constraint || error.message)) {
      return { error: "DUPLICATE_BILL" };
    }

    throw error;
  } finally {
    client.release();
  }
};

const RECEIPT_COLUMNS = `gr.id, gr.receipt_number, gr.supplier_id, gr.purchase_order_id, gr.outlet_id,
       gr.bill_number, gr.bill_date, gr.received_date, gr.due_date, gr.payment_mode,
       gr.prices_include_tax, gr.taxable_amount, gr.tax_amount, gr.round_off, gr.total_amount,
       gr.receipt_status, gr.void_reason, gr.voided_at, gr.notes, gr.created_at,
       s.name AS supplier_name, s.gst_number AS supplier_gstin, po.po_number,
       o.name AS outlet_name, cu.name AS created_by_name, vu.name AS voided_by_name,
       (SELECT COUNT(*)::int FROM document_attachments da
        WHERE da.restaurant_id = gr.restaurant_id AND da.entity_type = 'purchase_bill'
          AND da.entity_id = gr.id AND da.removed_at IS NULL) AS attachment_count`;

const RECEIPT_JOINS = `
     JOIN suppliers s ON s.id = gr.supplier_id
     LEFT JOIN purchase_orders po ON po.id = gr.purchase_order_id
     LEFT JOIN outlets o ON o.id = gr.outlet_id
     LEFT JOIN users cu ON cu.id = gr.created_by
     LEFT JOIN users vu ON vu.id = gr.voided_by`;

const findReceipts = async (restaurantId, filters = {}) => {
  const result = await pool.query(
    `SELECT ${RECEIPT_COLUMNS},
            (SELECT COUNT(*)::int FROM goods_receipt_items gi WHERE gi.goods_receipt_id = gr.id) AS line_count,
            (SELECT COALESCE(SUM(gi.rejected_quantity), 0) > 0 FROM goods_receipt_items gi
              WHERE gi.goods_receipt_id = gr.id) AS has_rejections,
            COUNT(*) OVER ()::int AS total_count
     FROM goods_receipts gr
     ${RECEIPT_JOINS}
     WHERE gr.restaurant_id = $1
       AND ($2::date IS NULL OR gr.bill_date >= $2)
       AND ($3::date IS NULL OR gr.bill_date <= $3)
       AND ($4::bigint IS NULL OR gr.supplier_id = $4)
       AND ($5::text IS NULL
            OR ($5 = 'direct' AND gr.purchase_order_id IS NULL)
            OR ($5 = 'po' AND gr.purchase_order_id IS NOT NULL))
       AND ($6::text IS NULL OR gr.receipt_status = $6)
       AND ($7::text IS NULL OR gr.receipt_number ILIKE '%' || $7 || '%'
            OR gr.bill_number ILIKE '%' || $7 || '%' OR s.name ILIKE '%' || $7 || '%')
     ORDER BY gr.bill_date DESC, gr.id DESC
     LIMIT $8`,
    [
      restaurantId,
      filters.from || null,
      filters.to || null,
      filters.supplierId || null,
      filters.kind || null,
      filters.status || null,
      filters.search || null,
      filters.limit || 200,
    ]
  );

  return { rows: result.rows, total: result.rows.length ? result.rows[0].total_count : 0 };
};

const findReceiptById = async (restaurantId, id, client = pool) => {
  const header = await client.query(
    `SELECT ${RECEIPT_COLUMNS}
     FROM goods_receipts gr
     ${RECEIPT_JOINS}
     WHERE gr.restaurant_id = $1 AND gr.id = $2`,
    [restaurantId, id]
  );

  if (header.rows.length === 0) {
    return null;
  }

  const lines = await client.query(
    `SELECT gi.id, gi.purchase_order_item_id, gi.inventory_item_id, gi.pack_id, gi.pack_name,
            gi.pack_size, gi.bill_quantity, gi.rejected_quantity, gi.rejection_reason, gi.quantity,
            gi.unit_price, gi.tax_rate, gi.taxable_amount, gi.tax_amount, gi.amount, gi.unit_cost,
            i.name AS item_name, u.short_name AS unit_short_name,
            COALESCE((
              SELECT SUM(pri.quantity) FROM purchase_return_items pri
              JOIN purchase_returns pr ON pr.id = pri.purchase_return_id
              WHERE pri.goods_receipt_item_id = gi.id AND pr.return_status = 'posted'
            ), 0) AS returned_quantity
     FROM goods_receipt_items gi
     JOIN inventory_items i ON i.id = gi.inventory_item_id
     JOIN units u ON u.id = i.unit_id
     WHERE gi.goods_receipt_id = $1
     ORDER BY gi.id`,
    [id]
  );

  const payments = await client.query(
    `SELECT id, amount, payment_method, payment_date, payment_status, paid_from_till, void_reason
     FROM supplier_payments WHERE restaurant_id = $1 AND goods_receipt_id = $2
     ORDER BY id`,
    [restaurantId, id]
  );

  const returns = await client.query(
    `SELECT id, return_number, return_date, total_amount, return_status
     FROM purchase_returns WHERE restaurant_id = $1 AND goods_receipt_id = $2
     ORDER BY id`,
    [restaurantId, id]
  );

  return { ...header.rows[0], lines: lines.rows, payments: payments.rows, returns: returns.rows };
};

// Whether money has been handed over on a bill (paid on delivery, or a
// payment recorded against it that still stands). Voiding such a bill voids
// that payment too, which is paying-suppliers work, not receiving work.
const hasPostedPayment = async (restaurantId, receiptId) => {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM supplier_payments
       WHERE restaurant_id = $1 AND goods_receipt_id = $2 AND payment_status = 'posted'
     ) AS paid`,
    [restaurantId, receiptId]
  );

  return result.rows[0].paid;
};

// Voiding a bill entered by mistake: its stock goes back out, the order it was
// received against counts it as not arrived, a payment made with it is voided
// too, and every item it priced goes back to the cost it had before.
//
// options.mayVoidPayments: false when the person voiding cannot pay suppliers
// (and no manager approved it). The route already checked; this repeats the
// check with the bill locked, so a payment recorded in between is not voided
// on their word.
const voidReceipt = async (restaurantId, id, reason, userId, options = {}) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const locked = await client.query(
      `SELECT id, receipt_number, receipt_status, purchase_order_id, outlet_id, supplier_id
       FROM goods_receipts WHERE restaurant_id = $1 AND id = $2 FOR UPDATE`,
      [restaurantId, id]
    );

    const receipt = locked.rows[0];

    if (!receipt) {
      await client.query("ROLLBACK");
      return { error: "NOT_FOUND" };
    }

    if (receipt.receipt_status !== "posted") {
      await client.query("ROLLBACK");
      return { error: "ALREADY_VOID" };
    }

    // The order next, before any of its lines: receiving takes the order and
    // then its lines, so taking them the same way round means a void and a
    // delivery on the same order wait for each other instead of deadlocking.
    if (receipt.purchase_order_id) {
      await client.query("SELECT id FROM purchase_orders WHERE restaurant_id = $1 AND id = $2 FOR UPDATE", [
        restaurantId,
        receipt.purchase_order_id,
      ]);
    }

    // Then the supplier, as a return to them takes it (bill, order,
    // supplier), so a return and this void cannot both count the same goods.
    await client.query("SELECT id FROM suppliers WHERE restaurant_id = $1 AND id = $2 FOR NO KEY UPDATE", [
      restaurantId,
      receipt.supplier_id,
    ]);

    if (options.mayVoidPayments === false) {
      const paid = await client.query(
        `SELECT 1 FROM supplier_payments
         WHERE restaurant_id = $1 AND goods_receipt_id = $2 AND payment_status = 'posted'
         LIMIT 1 FOR UPDATE`,
        [restaurantId, id]
      );

      if (paid.rows.length > 0) {
        await client.query("ROLLBACK");
        return { error: "PAID" };
      }
    }

    const liveReturns = await client.query(
      `SELECT return_number FROM purchase_returns
       WHERE restaurant_id = $1 AND goods_receipt_id = $2 AND return_status = 'posted'`,
      [restaurantId, id]
    );

    if (liveReturns.rows.length > 0) {
      await client.query("ROLLBACK");
      return { error: "HAS_RETURNS", returns: liveReturns.rows.map((row) => row.return_number) };
    }

    // The receipt's own stock rows stop counting as a price, before the stock
    // goes back out, so the cost below is worked out without them.
    await client.query(
      `UPDATE stock_transactions SET sets_cost = FALSE
       WHERE restaurant_id = $1 AND reference_type = 'goods_receipt' AND reference_id = $2`,
      [restaurantId, id]
    );

    // The moment is read as text, not as a JavaScript date: a date keeps
    // milliseconds only, so 10:16:17.758127 came back as 10:16:17.758 and the
    // void sorted BEFORE the delivery it cancels. Closing stock takes "the
    // latest average" by that moment, and so kept valuing the item at the
    // average that included the voided bill. Stamped at exactly the same
    // moment, the void wins the tie (it is the later row).
    // `averaged`: the bill came in after the ledger began keeping each
    // item's average, so the item can be re-run as if it never happened
    // (inventoryRepository.recostAfterVoid). Older bills go back out the
    // old way, reversing their price at the moment of the void.
    const lines = await client.query(
      `SELECT gi.id, gi.purchase_order_item_id, gi.inventory_item_id, gi.quantity, gi.unit_cost,
              (SELECT MIN(st.effective_at) FROM stock_transactions st
                WHERE st.restaurant_id = $2 AND st.reference_type = 'goods_receipt'
                  AND st.reference_id = gi.goods_receipt_id
                  AND st.inventory_item_id = gi.inventory_item_id)::text AS effective_at,
              COALESCE((SELECT bool_and(st.average_cost_after IS NOT NULL) FROM stock_transactions st
                WHERE st.restaurant_id = $2 AND st.reference_type = 'goods_receipt'
                  AND st.reference_id = gi.goods_receipt_id
                  AND st.inventory_item_id = gi.inventory_item_id), FALSE) AS averaged
       FROM goods_receipt_items gi WHERE gi.goods_receipt_id = $1 AND gi.quantity > 0`,
      [id, restaurantId]
    );

    for (const line of lines.rows) {
      // Out as a negative purchase at the same cost, so purchase totals net
      // to nothing for a bill that never really happened — and at the same
      // moment it came in, so the closing stock of the days in between no
      // longer counts goods that were never there. For an averaged item the
      // average is left to the re-run below, which also re-costs what was
      // used since; that is why a void of a mistyped price (₹55,000 for
      // ₹550) no longer stops on "a negative stock value after later usage".
      await inventoryRepository.recordMovement(
        client,
        restaurantId,
        {
          inventoryItemId: line.inventory_item_id,
          outletId: receipt.outlet_id,
          transactionType: "purchase",
          quantity: -Number(line.quantity),
          unitCost: Number(line.unit_cost),
          keepLastCost: true,
          revalue: !line.averaged,
          allowNegative: true,
          effectiveAt: line.effective_at,
          reason: `Purchase bill voided: ${reason}`,
          referenceType: "goods_receipt_void",
          referenceId: id,
          notes: receipt.receipt_number,
        },
        userId
      );

      // Back to the price of the last delivery still standing — or no price
      // at all, if this bill was the only one, rather than keep a price that
      // was never really paid.
      const repriced = await client.query(
        `UPDATE inventory_items i
         SET last_cost = (
           SELECT st.unit_cost FROM stock_transactions st
           WHERE st.inventory_item_id = i.id AND st.sets_cost
           ORDER BY st.effective_at DESC, st.id DESC
           LIMIT 1
         )
         WHERE i.restaurant_id = $1 AND i.id = $2
         RETURNING i.name, i.current_stock, i.last_cost,
                   (SELECT u.short_name FROM units u WHERE u.id = i.unit_id) AS unit_short_name`,
        [restaurantId, line.inventory_item_id]
      );

      // The same ceiling every way stock comes in at a price has: one item's
      // stock may be worth at most MAX_AMOUNT. Going back to an older price
      // can break it — 1 kg of saffron stocked in at ₹90,00,000, taken out,
      // then 1,000 kg bought at ₹1 and this bill voided would leave 1,000 kg
      // at ₹90,00,000, ₹900 crore of closing stock. Refused as a whole
      // (nothing above is kept), naming the price and where it came from.
      const item = repriced.rows[0];
      const value = item && item.last_cost !== null ? Math.max(Number(item.current_stock), 0) * Number(item.last_cost) : 0;

      if (!Number.isFinite(value) || value > MAX_AMOUNT) {
        const source = await client.query(
          `SELECT st.reference_type, st.notes,
                  (st.effective_at AT TIME ZONE ${TIMEZONE})::date::text AS day
           FROM stock_transactions st
           WHERE st.inventory_item_id = $2 AND st.sets_cost
           ORDER BY st.effective_at DESC, st.id DESC
           LIMIT 1`,
          [restaurantId, line.inventory_item_id]
        );

        await client.query("ROLLBACK");
        return {
          error: "STOCK_VALUE",
          receiptNumber: receipt.receipt_number,
          itemName: item.name,
          unit: item.unit_short_name,
          stock: Number(item.current_stock),
          cost: Number(item.last_cost),
          value,
          source: source.rows[0] || null,
        };
      }

      if (line.purchase_order_item_id) {
        await client.query(
          `UPDATE purchase_order_items
           SET received_quantity = GREATEST(received_quantity - $2, 0)
           WHERE id = $1`,
          [line.purchase_order_item_id, line.quantity]
        );
      }
    }

    if (receipt.purchase_order_id) {
      // Goods sent back against the order itself (not against a bill) were
      // part of what arrived. If this bill brought them, voiding it would
      // leave a credit for goods the order no longer shows as received.
      const orphaned = await client.query(
        `SELECT DISTINCT pr.return_number
         FROM purchase_order_items poi
         JOIN purchase_return_items pri ON pri.inventory_item_id = poi.inventory_item_id
         JOIN purchase_returns pr ON pr.id = pri.purchase_return_id
           AND pr.purchase_order_id = poi.purchase_order_id AND pr.goods_receipt_id IS NULL
           AND pr.return_status = 'posted'
         WHERE poi.purchase_order_id = $1
           AND poi.received_quantity < COALESCE((
             SELECT SUM(r2.quantity) FROM purchase_return_items r2
             JOIN purchase_returns p2 ON p2.id = r2.purchase_return_id
             WHERE p2.return_status = 'posted' AND r2.inventory_item_id = poi.inventory_item_id
               AND (p2.purchase_order_id = poi.purchase_order_id
                    OR p2.goods_receipt_id IN (SELECT g2.id FROM goods_receipts g2
                                               WHERE g2.purchase_order_id = poi.purchase_order_id
                                                 AND g2.receipt_status = 'posted' AND g2.id <> $2))
           ), 0) - 0.0005`,
        [receipt.purchase_order_id, id]
      );

      if (orphaned.rows.length > 0) {
        await client.query("ROLLBACK");
        return { error: "HAS_RETURNS", returns: orphaned.rows.map((row) => row.return_number) };
      }

      await recomputeStatus(client, receipt.purchase_order_id, userId);
    }

    await client.query(
      `UPDATE supplier_payments
       SET payment_status = 'void', void_reason = $3, voided_at = NOW(), voided_by = $4, updated_by = $4
       WHERE restaurant_id = $1 AND goods_receipt_id = $2 AND payment_status = 'posted'`,
      [restaurantId, id, `Bill ${receipt.receipt_number} voided: ${reason}`, userId]
    );

    await client.query(
      `UPDATE goods_receipts
       SET receipt_status = 'void', void_reason = $3, voided_at = NOW(), voided_by = $4, updated_by = $4
       WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, id, reason, userId]
    );

    // With this bill no longer counting, the supplier must still have
    // supplied at least what has gone back to them. A return with no bill may
    // have sent back goods that came on this one; voiding the bill under it
    // would leave the supplier credited for goods they never supplied.
    const onBill = await client.query(
      "SELECT DISTINCT inventory_item_id FROM goods_receipt_items WHERE goods_receipt_id = $1",
      [id]
    );
    const standing = await purchaseReturnRepository.findSupplierReturnable(
      restaurantId,
      receipt.supplier_id,
      onBill.rows.map((row) => row.inventory_item_id),
      client
    );
    const overReturned = standing.filter((row) => row.returned > row.supplied + 0.0005).map((row) => row.inventoryItemId);

    if (overReturned.length > 0) {
      const blocking = await client.query(
        `SELECT DISTINCT pr.return_number, pr.id
         FROM purchase_returns pr
         JOIN purchase_return_items pri ON pri.purchase_return_id = pr.id
         WHERE pr.restaurant_id = $1 AND pr.supplier_id = $2 AND pr.return_status = 'posted'
           AND pr.goods_receipt_id IS NULL AND pri.inventory_item_id = ANY($3::bigint[])
         ORDER BY pr.id DESC`,
        [restaurantId, receipt.supplier_id, overReturned]
      );

      await client.query("ROLLBACK");
      return { error: "HAS_RETURNS", returns: blocking.rows.map((row) => row.return_number) };
    }

    // Each averaged item, re-run from this bill onwards as if it had never
    // been entered (the bill is marked void above, and every item is still
    // locked by its void movement).
    const averagedItems = [
      ...new Set(lines.rows.filter((line) => line.averaged).map((line) => Number(line.inventory_item_id))),
    ];

    for (const itemId of averagedItems) {
      const recosted = await inventoryRepository.recostAfterVoid(client, restaurantId, itemId, id);

      // The same ceiling as above, on the cost the item is now valued at:
      // re-run without this bill, an item can only come back to prices it
      // really had, but stock that joined at one of them must still be a
      // believable figure. Refused as a whole, nothing kept.
      if (recosted && recosted.average !== null) {
        const item = (
          await client.query(
            `SELECT i.name, i.current_stock, u.short_name AS unit_short_name
             FROM inventory_items i JOIN units u ON u.id = i.unit_id
             WHERE i.restaurant_id = $1 AND i.id = $2`,
            [restaurantId, itemId]
          )
        ).rows[0];
        const value = Math.max(Number(item.current_stock), 0) * recosted.average;

        if (!Number.isFinite(value) || value > MAX_AMOUNT) {
          await client.query("ROLLBACK");
          return {
            error: "STOCK_VALUE",
            receiptNumber: receipt.receipt_number,
            itemName: item.name,
            unit: item.unit_short_name,
            stock: Number(item.current_stock),
            cost: recosted.average,
            value,
            source: null,
          };
        }
      }
    }

    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// --- Purchase register ---

// Every posted supplier bill in a period, as the accountant books it: bill
// date and number, the supplier's GSTIN, taxable value and GST by line rate.
const findRegister = async (restaurantId, { from, to, supplierId }) => {
  const bills = await pool.query(
    `SELECT gr.id, gr.receipt_number, gr.bill_number, gr.bill_date, gr.received_date,
            gr.payment_mode, gr.taxable_amount, gr.tax_amount, gr.round_off, gr.total_amount,
            s.id AS supplier_id, s.name AS supplier_name, s.gst_number AS supplier_gstin,
            po.po_number,
            COALESCE((
              SELECT json_agg(json_build_object('rate', rate, 'taxable', taxable, 'tax', tax) ORDER BY rate)
              FROM (
                SELECT gi.tax_rate AS rate, SUM(gi.taxable_amount) AS taxable, SUM(gi.tax_amount) AS tax
                FROM goods_receipt_items gi WHERE gi.goods_receipt_id = gr.id
                GROUP BY gi.tax_rate
              ) rates
            ), '[]'::json) AS rates
     FROM goods_receipts gr
     JOIN suppliers s ON s.id = gr.supplier_id
     LEFT JOIN purchase_orders po ON po.id = gr.purchase_order_id
     WHERE gr.restaurant_id = $1 AND gr.receipt_status = 'posted'
       AND gr.bill_date BETWEEN $2 AND $3
       AND ($4::bigint IS NULL OR gr.supplier_id = $4)
     ORDER BY gr.bill_date, gr.id`,
    [restaurantId, from, to, supplierId || null]
  );

  // Goods sent back are debit notes against those bills, in the same period.
  const returns = await pool.query(
    `SELECT pr.id, pr.return_number, pr.return_date, pr.taxable_amount, pr.tax_amount,
            pr.total_amount, pr.reason,
            s.id AS supplier_id, s.name AS supplier_name, s.gst_number AS supplier_gstin,
            gr.receipt_number, gr.bill_number
     FROM purchase_returns pr
     JOIN suppliers s ON s.id = pr.supplier_id
     LEFT JOIN goods_receipts gr ON gr.id = pr.goods_receipt_id
     WHERE pr.restaurant_id = $1 AND pr.return_status = 'posted'
       AND pr.return_date BETWEEN $2 AND $3
       AND ($4::bigint IS NULL OR pr.supplier_id = $4)
     ORDER BY pr.return_date, pr.id`,
    [restaurantId, from, to, supplierId || null]
  );

  const settings = await pool.query(
    "SELECT gst_number FROM restaurant_settings WHERE restaurant_id = $1",
    [restaurantId]
  );

  return {
    bills: bills.rows,
    returns: returns.rows,
    restaurantGstin: settings.rows[0] ? settings.rows[0].gst_number : null,
  };
};

const remove = async (restaurantId, id) => {
  const result = await pool.query(
    "DELETE FROM purchase_orders WHERE restaurant_id = $1 AND id = $2 RETURNING id",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// The restaurant's own calendar date today, for due dates and ageing.
const findToday = async (restaurantId) => {
  const result = await pool.query(
    `SELECT (NOW() AT TIME ZONE ${TIMEZONE})::date::text AS today`,
    [restaurantId]
  );

  return result.rows[0].today;
};

module.exports = {
  requestApproval,
  markOrdered,
  returnToDraft,
  findAll,
  findById,
  create,
  updateDraft,
  updateStatus,
  receive,
  createDirectReceipt,
  findReceipts,
  findReceiptById,
  hasPostedPayment,
  voidReceipt,
  findRegister,
  remove,
  findToday,
};
