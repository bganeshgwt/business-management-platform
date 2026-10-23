const pool = require("../../../../config/database");
const recipeRepository = require("../../menu/repositories/recipe.repository");
const inventoryRepository = require("../../inventory/repositories/inventory.repository");
const loyaltyRepository = require("../../crm/repositories/loyalty.repository");
const comboRepository = require("../../menu/repositories/combo.repository");
const crmRepository = require("../../crm/repositories/crm.repository");
const { outletInvoicePrefix, numberSeries, FY_SERIES_MAX } = require("../../setup/repositories/restaurant.repository");

const BILL_COLUMNS = `b.id, b.bill_number, b.order_id, b.outlet_id, b.business_day_id, b.discount_id, b.discount_code,
                      b.subtotal, b.discount_amount, b.tax_amount, b.service_charge,
                      b.round_off, b.total_amount, b.paid_amount, b.refunded_amount, b.credited_amount,
                      b.bill_status, b.void_reason, b.billed_at, b.settled_at,
                      b.print_count, b.first_printed_at, b.last_printed_at, b.is_split,
                      b.loyalty_points_used, b.loyalty_discount,
                      b.coupon_discount, b.manual_discount_type, b.manual_discount_value,
                      b.manual_discount_amount, b.item_discount_amount, b.discount_reason, b.discount_note,
                      b.service_charge_percentage, b.service_charge_tax, b.service_charge_waived,
                      b.service_charge_waive_reason, b.cess_amount, b.taxable_amount, b.tax_mode,
                      b.is_complimentary, b.complimentary_reason, b.complimentary_note,
                      b.seller_gstin, b.receipt_settings, b.last_adjusted_at, b.consume_stock, b.created_by,
                      b.discount_given_by, b.discount_approved_by, b.complimentary_by, b.complimentary_approved_by,
                      b.account_customer_id, b.delivery_charge, b.delivery_charge_tax, b.delivery_charge_waived,
                      b.delivery_charge_waive_reason, b.delivery_charge_waived_by, b.delivery_charge_approved_by,
                      b.seller_fssai`;

// Staff pinned to one outlet see and act on that outlet's bills only — not
// another branch's, and not a bill raised with no outlet at all (the owner
// billing with "All outlets" chosen), which is the owner's to sort out. Only
// a restaurant with outlets can pin anyone, so a single-location restaurant
// is never affected. A null outlet here means the whole restaurant.
const outletScope = (param, alias = "b") =>
  `(${param}::bigint IS NULL OR ${alias}.outlet_id = ${param}::bigint)`;

// ILIKE treats % and _ as wildcards; a bill number typed with an underscore
// must match only itself.
const likeText = (text) => `%${String(text).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// The rows, and how many there would have been without the limit.
//
// COUNT(*) OVER () is evaluated after WHERE and before LIMIT, so it costs one
// query rather than two and cannot disagree with the rows it came back with.
//
// search: a bill or order number, a guest's name, or four or more digits of
// their mobile. from/to: the business date (the day the bill was raised in,
// which for a kitchen serving past midnight is the evening before).
const findAll = async (restaurantId, filters = {}) => {
  const search = filters.search ? String(filters.search).trim() : null;
  const digits = search ? search.replace(/\D/g, "") : "";

  const result = await pool.query(
    `SELECT ${BILL_COLUMNS}, o.order_number, o.order_type, o.customer_name, o.customer_mobile,
            (SELECT rb.name FROM restaurant_brands rb WHERE rb.id = o.brand_id) AS brand_name,
            c.name AS linked_customer_name, c.mobile AS linked_customer_mobile,
            t.table_no, u.name AS created_by_name, ot.name AS outlet_name,
            ac.name AS account_name, NULLIF(BTRIM(ac.company_name), '') AS account_company,
            COALESCE(bd.business_date, (b.billed_at AT TIME ZONE $10)::date) AS business_date,
            COUNT(*) OVER ()::int AS total_count
     FROM bills b
     JOIN orders o ON o.id = b.order_id
     LEFT JOIN customers ac ON ac.id = b.account_customer_id
     LEFT JOIN dining_tables t ON t.id = o.table_id
     LEFT JOIN users u ON u.id = b.created_by
     LEFT JOIN outlets ot ON ot.id = b.outlet_id
     LEFT JOIN business_days bd ON bd.id = b.business_day_id
     LEFT JOIN customers c ON c.id = o.customer_id
     WHERE b.restaurant_id = $1
       AND ($2::text[] IS NULL OR b.bill_status = ANY($2))
       AND ($3::bigint IS NULL OR b.business_day_id = $3)
       AND ($4::bigint IS NULL OR b.order_id = $4)
       AND ${outletScope("$5")}
       AND ($6::date IS NULL OR COALESCE(bd.business_date, (b.billed_at AT TIME ZONE $10)::date) >= $6::date)
       AND ($7::date IS NULL OR COALESCE(bd.business_date, (b.billed_at AT TIME ZONE $10)::date) <= $7::date)
       AND ($8::text IS NULL
            OR b.bill_number ILIKE $8 OR o.order_number ILIKE $8
            OR o.customer_name ILIKE $8 OR c.name ILIKE $8 OR c.company_name ILIKE $8
            OR ac.name ILIKE $8 OR ac.company_name ILIKE $8
            OR ($9::text IS NOT NULL
                AND (REGEXP_REPLACE(COALESCE(o.customer_mobile, ''), '\\D', '', 'g') LIKE '%' || $9 || '%'
                     OR REGEXP_REPLACE(COALESCE(c.mobile, ''), '\\D', '', 'g') LIKE '%' || $9 || '%')))
       AND ($11::boolean IS NOT TRUE OR b.is_complimentary)
       -- Today's bills only (someone without sales.view or payments.manage):
       -- bills of a business day that is open now.
       AND ($14::boolean IS NOT TRUE OR bd.day_status = 'open')
       -- Several business days at once (the dashboard's "today" with All
       -- outlets is every open day, each on its own date).
       AND ($15::bigint[] IS NULL OR b.business_day_id = ANY($15::bigint[]))
       -- Bills on a guest's or company's account, or only those that are not
       -- (the dashboard counts the two apart).
       AND ($16::text IS NULL
            OR ($16 = 'only' AND b.account_customer_id IS NOT NULL)
            OR ($16 = 'none' AND b.account_customer_id IS NULL))
     ORDER BY b.billed_at DESC, b.id DESC
     LIMIT $12 OFFSET $13`,
    [
      restaurantId,
      filters.status || null,
      filters.businessDayId || null,
      filters.orderId || null,
      filters.outletId || null,
      filters.from || null,
      filters.to || null,
      search ? likeText(search) : null,
      digits.length >= 4 ? digits : null,
      filters.timezone || "Asia/Kolkata",
      filters.complimentaryOnly || false,
      filters.limit || 100,
      filters.offset || 0,
      filters.openDayOnly || false,
      filters.businessDayIds && filters.businessDayIds.length > 0 ? filters.businessDayIds : null,
      filters.account || null,
    ]
  );

  return {
    rows: result.rows,
    total: result.rows.length > 0 ? result.rows[0].total_count : 0,
  };
};

// The bill header only, for checks before anything is done to it.
const findHeader = async (restaurantId, id, outletId = null, db = pool) => {
  const result = await db.query(
    `SELECT ${BILL_COLUMNS}, o.order_type, o.order_status, o.customer_id, o.table_id, o.outlet_id AS order_outlet_id,
            o.delivery_charge AS order_delivery_charge
     FROM bills b
     JOIN orders o ON o.id = b.order_id
     WHERE b.restaurant_id = $1 AND b.id = $2 AND ${outletScope("$3")}`,
    [restaurantId, id, outletId]
  );

  return result.rows[0] || null;
};

// Everything the bill screen and the printed invoice need.
const findById = async (restaurantId, id, outletId = null) => {
  const billResult = await pool.query(
    `SELECT ${BILL_COLUMNS}, o.order_number, o.order_type, o.customer_name, o.customer_mobile,
            (SELECT rb.name FROM restaurant_brands rb WHERE rb.id = o.brand_id) AS brand_name,
            o.guest_count, o.customer_id, t.table_no, u.name AS created_by_name,
            c.name AS linked_customer_name, c.mobile AS linked_customer_mobile,
            gb.name AS discount_given_by_name, ga.name AS discount_approved_by_name,
            cb.name AS complimentary_by_name, ca.name AS complimentary_approved_by_name,
            bd.business_date,
            r.name AS restaurant_name, r.address AS restaurant_address, r.contact AS restaurant_phone,
            ot.name AS outlet_name, ot.address AS outlet_address, ot.contact AS outlet_phone,
            s.gst_number AS settings_gstin, ot.gst_number AS outlet_gstin,
            -- The licence printed when the bill was raised; a bill from before
            -- that was kept prints the outlet's (else the restaurant's) now.
            COALESCE(b.seller_fssai, ot.fssai_number, s.fssai_number) AS fssai_number,
            -- Where the guest can pay by UPI: the outlet's own ID, else the
            -- restaurant's. Read live, so a changed ID prints on a reprint.
            COALESCE(NULLIF(BTRIM(ot.upi_vpa), ''), NULLIF(BTRIM(s.upi_vpa), '')) AS upi_vpa,
            CASE WHEN NULLIF(BTRIM(ot.upi_vpa), '') IS NOT NULL
                 THEN COALESCE(NULLIF(BTRIM(ot.upi_payee_name), ''), NULLIF(BTRIM(s.upi_payee_name), ''), r.name)
                 ELSE COALESCE(NULLIF(BTRIM(s.upi_payee_name), ''), r.name) END AS upi_payee_name,
            -- The table's ordering QR, for "Print the table's QR on the bill".
            t.qr_token AS table_qr_token, ss.guest_web_address,
            dw.name AS delivery_charge_waived_by_name, dap.name AS delivery_charge_approved_by_name,
            -- The buyer is the one written on the bill (by billing, the
            -- moment it is raised for a guest with a GSTIN, or by hand), never
            -- the guest's record as it is today: a GSTIN added to a regular
            -- later must not print on the reprint of a bill they paid as an
            -- ordinary guest.
            gr.gstin AS buyer_gstin,
            gr.legal_name AS buyer_name,
            CASE WHEN gr.id IS NOT NULL THEN 'bill' END AS buyer_source,
            -- The address written on the bill; for a buyer written before
            -- addresses were (or by a screen that left it out), the address on
            -- the guest's record when it is the same GSTIN.
            CASE WHEN gr.id IS NOT NULL THEN COALESCE(gr.address, CASE WHEN c.gstin = gr.gstin THEN NULLIF(BTRIM(c.address), '') END)
                 END AS buyer_address,
            b.account_customer_id, b.account_at, b.account_note,
            ac.name AS account_name, NULLIF(BTRIM(ac.company_name), '') AS account_company,
            abu.name AS account_by_name, aap.name AS account_approved_by_name
     FROM bills b
     JOIN orders o ON o.id = b.order_id
     JOIN restaurants r ON r.id = b.restaurant_id
     LEFT JOIN restaurant_settings s ON s.restaurant_id = b.restaurant_id
     LEFT JOIN outlets ot ON ot.id = b.outlet_id
     LEFT JOIN dining_tables t ON t.id = o.table_id
     LEFT JOIN users u ON u.id = b.created_by
     LEFT JOIN users gb ON gb.id = b.discount_given_by
     LEFT JOIN users ga ON ga.id = b.discount_approved_by
     LEFT JOIN users cb ON cb.id = b.complimentary_by
     LEFT JOIN users ca ON ca.id = b.complimentary_approved_by
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN business_days bd ON bd.id = b.business_day_id
     LEFT JOIN bill_gst_recipients gr ON gr.bill_id = b.id
     LEFT JOIN customers ac ON ac.id = b.account_customer_id
     LEFT JOIN users abu ON abu.id = b.account_by
     LEFT JOIN users aap ON aap.id = b.account_approved_by
     LEFT JOIN users dw ON dw.id = b.delivery_charge_waived_by
     LEFT JOIN users dap ON dap.id = b.delivery_charge_approved_by
     LEFT JOIN service_settings ss ON ss.restaurant_id = b.restaurant_id
     WHERE b.restaurant_id = $1 AND b.id = $2 AND ${outletScope("$3")}`,
    [restaurantId, id, outletId]
  );

  const bill = billResult.rows[0];

  if (!bill) {
    return null;
  }

  const [items, payments, refunds, taxes, notes, noteTaxes, noteItems, corrections] = await Promise.all([
    pool.query(
      `SELECT bi.id AS bill_item_id, bi.order_item_id, oi.item_name, oi.variant_name, bi.quantity,
              oi.unit_price, oi.modifier_total, oi.mrp, oi.price_includes_tax, oi.tax_percentage AS order_tax_percentage,
              (SELECT COALESCE(SUM(m.price),0) FROM order_item_modifiers m WHERE m.order_item_id=oi.id AND m.modifier_id IS NULL AND m.modifier_name='Packaging') AS packaging_charge,
              bi.line_subtotal, bi.line_tax, bi.line_total,
              bi.item_discount_type, bi.item_discount_value, bi.item_discount_amount,
              bi.discount_amount, bi.service_charge_share, bi.delivery_charge_share, bi.taxable_value,
              bi.tax_percentage, bi.cess_percentage, bi.tax_amount, bi.cess_amount,
              COALESCE(bi.hsn_code, oi.hsn_code) AS hsn_code, bi.returned_quantity
       FROM bill_items bi
       JOIN order_items oi ON oi.id = bi.order_item_id
       WHERE bi.bill_id = $1
       ORDER BY bi.id`,
      [id]
    ),
    pool.query(
      `SELECT p.id, p.payment_method, p.amount, p.tendered_amount, p.change_amount,
              p.transaction_ref, p.payment_status, p.paid_at, p.business_day_id,
              p.tip_amount, p.payment_type_id, pt.name AS payment_type_name,
              p.advance_id, ca.receipt_number AS advance_receipt_number,
              pd.day_status AS day_status,
              u.name AS created_by_name
       FROM payments p
       LEFT JOIN users u ON u.id = p.created_by
       LEFT JOIN payment_types pt ON pt.id = p.payment_type_id
       LEFT JOIN customer_advances ca ON ca.id = p.advance_id
       LEFT JOIN business_days pd ON pd.id = p.business_day_id
       WHERE p.bill_id = $1
       ORDER BY p.id`,
      [id]
    ),
    pool.query(
      `SELECT r.id, r.amount, r.refund_method, r.reason, r.refunded_at, r.refund_kind, r.business_day_id,
              cn.credit_note_number, u.name AS created_by_name, pt.name AS payment_type_name,
              ca.receipt_number AS advance_receipt_number
       FROM refunds r
       LEFT JOIN users u ON u.id = r.created_by
       LEFT JOIN credit_notes cn ON cn.refund_id = r.id
       LEFT JOIN payment_types pt ON pt.id = r.payment_type_id
       LEFT JOIN customer_advances ca ON ca.id = r.advance_id
       WHERE r.bill_id = $1
       ORDER BY r.id`,
      [id]
    ),
    pool.query(
      `SELECT tax_percentage, cess_percentage, items_taxable, service_charge_taxable, delivery_charge_taxable,
              taxable_value, cgst_amount, sgst_amount, service_charge_tax, cess_amount
       FROM bill_taxes
       WHERE bill_id = $1
       ORDER BY tax_percentage, cess_percentage`,
      [id]
    ),
    pool.query(
      `SELECT cn.id, cn.credit_note_number, cn.kind, cn.reason, cn.taxable_value, cn.service_charge_value,
              cn.tax_amount, cn.cess_amount, cn.round_off, cn.total_amount, cn.points_reversed, cn.issued_at,
              r.refund_method, u.name AS created_by_name
       FROM credit_notes cn
       LEFT JOIN refunds r ON r.id = cn.refund_id
       LEFT JOIN users u ON u.id = cn.created_by
       WHERE cn.bill_id = $1
       ORDER BY cn.id`,
      [id]
    ),
    pool.query(
      `SELECT ct.credit_note_id, ct.tax_percentage, ct.cess_percentage, ct.taxable_value,
              ct.service_charge_taxable, ct.cgst_amount, ct.sgst_amount, ct.cess_amount
       FROM credit_note_taxes ct
       JOIN credit_notes cn ON cn.id = ct.credit_note_id
       WHERE cn.bill_id = $1
       ORDER BY ct.tax_percentage`,
      [id]
    ),
    pool.query(
      `SELECT ci.credit_note_id, ci.bill_item_id, oi.item_name, oi.variant_name, ci.quantity,
              ci.taxable_value, ci.tax_amount, ci.amount
       FROM credit_note_items ci
       JOIN credit_notes cn ON cn.id = ci.credit_note_id
       JOIN bill_items bi ON bi.id = ci.bill_item_id
       JOIN order_items oi ON oi.id = bi.order_item_id
       WHERE cn.bill_id = $1
       ORDER BY ci.id`,
      [id]
    ),
    pool.query(
      `SELECT pc.id, pc.payment_id, pc.amount, pc.old_method, pc.new_method, pc.old_reference, pc.new_reference,
              opt.name AS old_type_name, npt.name AS new_type_name, pc.reason, pc.corrected_at,
              cu.name AS corrected_by_name, au.name AS approved_by_name
       FROM payment_corrections pc
       LEFT JOIN payment_types opt ON opt.id = pc.old_payment_type_id
       LEFT JOIN payment_types npt ON npt.id = pc.new_payment_type_id
       LEFT JOIN users cu ON cu.id = pc.corrected_by
       LEFT JOIN users au ON au.id = pc.approved_by
       WHERE pc.bill_id = $1
       ORDER BY pc.id`,
      [id]
    ),
  ]);

  return {
    ...bill,
    items: items.rows,
    payments: payments.rows,
    refunds: refunds.rows,
    corrections: corrections.rows,
    taxes: taxes.rows,
    credit_notes: notes.rows.map((note) => ({
      ...note,
      taxes: noteTaxes.rows.filter((row) => Number(row.credit_note_id) === Number(note.id)),
      items: noteItems.rows.filter((row) => Number(row.credit_note_id) === Number(note.id)),
    })),
  };
};

// How much of each order line is still unbilled. Split bills are built from
// this, and an order counts as fully billed when nothing is left.
const findBillableItems = async (client, restaurantId, orderId) => {
  const result = await (client || pool).query(
    `SELECT oi.id, oi.item_name, oi.variant_name, oi.quantity, oi.unit_price,
            oi.modifier_total, oi.tax_percentage, oi.price_includes_tax, oi.mrp, oi.cess_percentage, oi.hsn_code,
            oi.line_subtotal, oi.line_tax, oi.line_total, oi.product_id, p.category_id,
            COALESCE(SUM(bi.quantity) FILTER (WHERE b.bill_status <> 'void'), 0) AS billed_quantity
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     LEFT JOIN products p ON p.id = oi.product_id
     LEFT JOIN bill_items bi ON bi.order_item_id = oi.id
     LEFT JOIN bills b ON b.id = bi.bill_id
     WHERE o.restaurant_id = $1 AND oi.order_id = $2 AND oi.item_status <> 'cancelled'
     GROUP BY oi.id, p.category_id
     ORDER BY oi.id`,
    [restaurantId, orderId]
  );

  return result.rows.map((row) => ({
    ...row,
    remaining_quantity: Number(row.quantity) - Number(row.billed_quantity),
  }));
};

// The lines ON a bill, as the pricing needs them (the quantity this bill
// covers, and the order line's own money for it).
const findLinesForPricing = async (billId, db = pool) => {
  const result = await db.query(
    `SELECT bi.id AS bill_item_id, bi.order_item_id, bi.quantity,
            oi.quantity AS order_quantity, oi.unit_price, oi.modifier_total,
            oi.tax_percentage, oi.price_includes_tax, oi.mrp, oi.cess_percentage, oi.hsn_code,
            oi.line_subtotal AS order_line_subtotal, oi.line_tax AS order_line_tax,
            oi.line_total AS order_line_total, oi.item_name, oi.variant_name,
            bi.item_discount_type, bi.item_discount_value, oi.product_id, p.category_id
     FROM bill_items bi
     JOIN order_items oi ON oi.id = bi.order_item_id
     LEFT JOIN products p ON p.id = oi.product_id
     WHERE bi.bill_id = $1
     ORDER BY bi.id`,
    [billId]
  );

  return result.rows;
};

// Whether another bill of the order (not voided) already carries its delivery
// charge: an order split over several bills charges the trip once, on the
// first.
const deliveryChargedElsewhere = async (restaurantId, orderId, exceptBillId = null, db = pool) => {
  const result = await db.query(
    `SELECT 1 FROM bills
     WHERE restaurant_id = $1 AND order_id = $2 AND bill_status <> 'void'
       AND ($3::bigint IS NULL OR id <> $3)
       AND (delivery_charge > 0 OR delivery_charge_waived)
     LIMIT 1`,
    [restaurantId, orderId, exceptBillId]
  );

  return result.rows.length > 0;
};

// The next number of a series (bills, credit notes), from a counter per
// restaurant and SERIES — the prefix the number is printed with. The counter
// row is locked by this update until the transaction commits, so two tills
// billing in the same instant are handed different numbers — the second waits
// a few milliseconds — instead of the second failing on the unique number.
//
// The counter is keyed by the prefix itself ("BILL:INV", "BILL:INV-RJY001"),
// never by who is billing: two outlets that print the same prefix share one
// locked counter, so no two counters can ever hand out the same number. (A
// counter per outlet did exactly that when an outlet printed the
// restaurant's prefix, and every second bill failed.)
//
// A new series carries on from the highest number already printed with that
// prefix. A number that somehow exists already (typed in by an import) is
// stepped over.
//
// With numbers restarting each financial year the year is part of the prefix
// ("INV/26-27", joined to the count by "/"), so each year is a series — and
// a counter — of its own, starting at 0001 on 1 April.
const nextNumber = async (client, restaurantId, kind, prefix, table, column, separator = "-") => {
  const seriesKey = `${kind}:${prefix}`.slice(0, 40);
  const lead = `${prefix}${separator}`;
  for (;;) {
    let result = await client.query(
      `UPDATE document_counters SET last_number = last_number + 1, updated_at = NOW()
       WHERE restaurant_id = $1 AND series = $2
       RETURNING last_number`,
      [restaurantId, seriesKey]
    );

    if (result.rows.length === 0) {
      // The first of the series for this restaurant. Two first bills at once
      // meet on the primary key; the second becomes an update and waits.
      result = await client.query(
        `INSERT INTO document_counters (restaurant_id, series, last_number)
         VALUES ($1, $2, (SELECT COALESCE(MAX(SUBSTRING(${column} FROM LENGTH($3) + 1)::bigint), 0)::int + 1
                          FROM ${table}
                          WHERE restaurant_id = $1 AND LEFT(${column}, LENGTH($3)) = $3
                            AND SUBSTRING(${column} FROM LENGTH($3) + 1) ~ '^[0-9]{1,9}$'))
         ON CONFLICT (restaurant_id, series)
         DO UPDATE SET last_number = document_counters.last_number + 1, updated_at = NOW()
         RETURNING last_number`,
        [restaurantId, seriesKey, lead]
      );
    }

    const number = `${lead}${String(result.rows[0].last_number).padStart(4, "0")}`;
    const taken = await client.query(`SELECT 1 FROM ${table} WHERE restaurant_id = $1 AND ${column} = $2`, [
      restaurantId,
      number,
    ]);

    if (taken.rows.length === 0) {
      return number;
    }
  }
};

// The credit-note series of a bill's outlet. A credit note is numbered in the
// series of the counter that issued the invoice, as the invoices are: the
// main counter's notes run CN-0001, CN-0002…; an outlet with an invoice
// series of its own (its own prefix, or the one worked out for it) numbers
// its own notes from 0001 — CN-BR-0001 for the INV-BR series, CN-JH784407…
// for JH784407. One restaurant-wide CN series put a branch registered for GST
// on its own under another registration's numbers, with gaps in each.
//
// The series keeps a credit note within GST's 16 characters (rule 53, like an
// invoice): at most 10, so a number stays valid up to 99,999 of the series.
// Two outlets whose series come out the same share one locked counter
// (nextNumber), so a number is still never issued twice.
const CN_SERIES_MAX = 10;
const gstChars = (text) => String(text || "").toUpperCase().replace(/[^A-Z0-9/-]/g, "");

const creditNoteSeries = async (client, restaurantId, outletId, max = CN_SERIES_MAX) => {
  if (!outletId) {
    return "CN";
  }

  const found = await client.query(
    `SELECT s.invoice_prefix AS main_prefix, ol.invoice_prefix, ol.code
     FROM outlets ol
     LEFT JOIN restaurant_settings s ON s.restaurant_id = ol.restaurant_id
     WHERE ol.restaurant_id = $1 AND ol.id = $2`,
    [restaurantId, outletId]
  );
  const row = found.rows[0];

  if (!row) {
    return "CN";
  }

  const main = gstChars(row.main_prefix) || "INV";
  const series = gstChars(row.invoice_prefix || outletInvoicePrefix(row.main_prefix, row.code, max));

  // An outlet printing the main counter's own series shares its notes too.
  if (!series || series === main) {
    return "CN";
  }

  // The outlet's own part of its series: "INV-BR" -> "BR", "JH784407" stays.
  const own = series.startsWith(`${main}-`) ? series.slice(main.length + 1) : series;
  const tag = own.replace(/^[-/]+|[-/]+$/g, "") || series;

  for (const candidate of [`CN-${tag}`, `CN${tag}`]) {
    if (candidate.length <= max) {
      return candidate;
    }
  }

  // Too long either way: the end of the tag, which is where outlet codes
  // differ (BRANCH01, BRANCH02).
  return max - 3 >= 1 ? `CN-${tag.slice(-(max - 3))}` : `CN${tag.slice(-(max - 2))}`;
};

// A coupon's use is counted in the same step as its limit is checked, on the
// coupon row itself, so two tills racing for the last use cannot both get it.
const takeCouponUse = async (client, restaurantId, discountId) => {
  const result = await client.query(
    `UPDATE discounts SET used_count = used_count + 1
     WHERE restaurant_id = $1 AND id = $2 AND (usage_limit IS NULL OR used_count < usage_limit)
     RETURNING id`,
    [restaurantId, discountId]
  );

  return result.rows.length > 0;
};

const giveCouponUseBack = (client, restaurantId, discountId) =>
  client.query(
    "UPDATE discounts SET used_count = GREATEST(used_count - 1, 0) WHERE restaurant_id = $1 AND id = $2",
    [restaurantId, discountId]
  );

// Writes what the pricing worked out onto the bill: the header's figures, each
// line's share, and the tax rate by rate.
const writePricing = async (client, restaurantId, billId, priced, billItemIds, userId) => {
  await client.query(
    `UPDATE bills
     SET subtotal = $3, discount_amount = $4, tax_amount = $5, service_charge = $6, round_off = $7,
         total_amount = $8, coupon_discount = $9, manual_discount_amount = $10, item_discount_amount = $11,
         loyalty_discount = $12, loyalty_points_used = $13, service_charge_percentage = $14,
         service_charge_tax = $15, cess_amount = $16, taxable_amount = $17, updated_by = $18,
         delivery_charge = $19, delivery_charge_tax = $20
     WHERE restaurant_id = $1 AND id = $2`,
    [
      restaurantId,
      billId,
      priced.subtotal,
      priced.discountAmount,
      priced.taxAmount,
      priced.serviceCharge,
      priced.roundOff,
      priced.totalAmount,
      priced.couponDiscount,
      priced.manualDiscountAmount,
      priced.itemDiscountAmount,
      priced.loyaltyDiscount,
      priced.loyaltyPointsUsed,
      priced.serviceChargePercentage,
      priced.serviceChargeTax,
      priced.cessAmount,
      priced.taxableAmount,
      userId,
      priced.deliveryCharge || 0,
      priced.deliveryChargeTax || 0,
    ]
  );

  for (let index = 0; index < priced.lines.length; index += 1) {
    const line = priced.lines[index];

    await client.query(
      `UPDATE bill_items
       SET line_subtotal = $2, line_tax = $3, line_total = $4,
           item_discount_type = $5, item_discount_value = $6, item_discount_amount = $7,
           discount_amount = $8, service_charge_share = $9, taxable_value = $10,
           tax_percentage = $11, cess_percentage = $12, tax_amount = $13, cess_amount = $14, hsn_code = $15,
           delivery_charge_share = $16
       WHERE id = $1`,
      [
        billItemIds[index],
        line.lineSubtotal,
        line.lineTax,
        line.lineTotal,
        line.itemDiscountType,
        line.itemDiscountValue,
        line.itemDiscountAmount,
        line.discountAmount,
        line.serviceChargeShare,
        line.taxableValue,
        line.taxPercentage,
        line.cessPercentage,
        line.taxAmount,
        line.cessAmount,
        line.hsnCode,
        line.deliveryChargeShare || 0,
      ]
    );
  }

  await client.query("DELETE FROM bill_taxes WHERE bill_id = $1", [billId]);

  for (const row of priced.taxes) {
    await client.query(
      `INSERT INTO bill_taxes (restaurant_id, bill_id, tax_percentage, cess_percentage, items_taxable,
                               service_charge_taxable, taxable_value, cgst_amount, sgst_amount,
                               service_charge_tax, cess_amount, delivery_charge_taxable)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        restaurantId,
        billId,
        row.taxPercentage,
        row.cessPercentage,
        row.itemsTaxable,
        row.serviceChargeTaxable,
        row.taxableValue,
        row.cgstAmount,
        row.sgstAmount,
        row.serviceChargeTax,
        row.cessAmount,
        row.deliveryChargeTaxable || 0,
      ]
    );
  }
};

// A bill with nothing to collect (a no-charge bill, or points that cover it
// all) is settled the moment it is priced: the order closes and the table is
// freed, exactly as when the last rupee is paid.
const settle = async (client, restaurantId, billId, orderId, tableId, userId) => {
  await client.query(
    `UPDATE bills SET bill_status = 'paid', settled_at = NOW(), updated_by = $3
     WHERE restaurant_id = $1 AND id = $2`,
    [restaurantId, billId, userId]
  );

  await closeOrderIfDone(client, restaurantId, orderId, tableId, userId);
};

// The order is over once every line is billed and no bill of it is still
// waiting for money at the table. A bill put on a guest's account counts as
// done: its money is owed on the account, not at the table, so the table is
// free for the next guests.
const closeOrderIfDone = async (client, restaurantId, orderId, tableId, userId) => {
  const left = await findBillableItems(client, restaurantId, orderId);
  const open = await client.query(
    `SELECT COUNT(*)::int AS n FROM bills
     WHERE order_id = $1 AND bill_status IN ('unpaid', 'partial') AND account_customer_id IS NULL`,
    [orderId]
  );

  if (left.every((row) => row.remaining_quantity <= 0.0001) && open.rows[0].n === 0) {
    await client.query(
      `UPDATE orders SET order_status = 'completed', completed_at = NOW(), updated_by = $2
       WHERE id = $1`,
      [orderId, userId]
    );

    if (tableId) {
      await client.query("UPDATE dining_tables SET table_status = 'available' WHERE id = $1", [tableId]);
    }
  }
};

// Moves a guest's redeemed points by the difference between what the bill
// used and what it now uses. Throws NOT_ENOUGH_POINTS (from recordPoints) if
// they no longer have them.
const moveRedeemedPoints = async (client, restaurantId, customerId, billId, billNumber, before, after, userId) => {
  const change = Number(after) - Number(before);

  if (change === 0 || !customerId) {
    return;
  }

  await loyaltyRepository.recordPoints(
    client,
    restaurantId,
    {
      customerId,
      billId,
      points: -change,
      entryType: change > 0 ? "redeem" : "adjust",
      notes: change > 0 ? `Redeemed on ${billNumber}` : `Returned from ${billNumber} (points changed on the bill)`,
    },
    userId
  );
};

// Creating a bill closes the order for editing and, when a coupon is used,
// counts that use. All of it happens with the order row locked.
//
// data: { orderId, outletId, businessDayId, invoicePrefix, sellerGstin,
//         discountId, discountCode, priced, lines (billing quantities),
//         serviceChargeWaived, waiveReason, consumeStock, customerId, isSplit,
//         taxMode, tableId }
const create = async (restaurantId, data, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const locked = await client.query(
      "SELECT order_status FROM orders WHERE restaurant_id = $1 AND id = $2 FOR UPDATE",
      [restaurantId, data.orderId]
    );

    if (locked.rows.length === 0) {
      await client.query("ROLLBACK");
      return { error: "NOT_FOUND" };
    }

    if (locked.rows[0].order_status !== "open") {
      await client.query("ROLLBACK");
      return { error: "NOT_OPEN", status: locked.rows[0].order_status };
    }

    // What is left to bill, read again under the lock: another till may have
    // billed part of it since the request was priced.
    const left = await findBillableItems(client, restaurantId, data.orderId);

    for (const line of data.lines) {
      const row = left.find((one) => Number(one.id) === Number(line.orderItemId));

      if (!row || line.quantity > row.remaining_quantity + 0.0001) {
        await client.query("ROLLBACK");
        return { error: "NOTHING_LEFT" };
      }
    }

    if (data.discountId && !(await takeCouponUse(client, restaurantId, data.discountId))) {
      await client.query("ROLLBACK");
      return { error: "COUPON_LIMIT" };
    }

    const billNumber = await nextNumber(
      client,
      restaurantId,
      "BILL",
      data.invoicePrefix,
      "bills",
      "bill_number",
      data.invoiceSeparator || "-"
    );
    const { priced } = data;

    const inserted = await client.query(
      `INSERT INTO bills (restaurant_id, outlet_id, business_day_id, order_id, bill_number,
                          discount_id, discount_code, subtotal, discount_amount, tax_amount,
                          service_charge, round_off, total_amount, is_split,
                          loyalty_points_used, loyalty_discount, consume_stock, tax_mode, seller_gstin,
                          service_charge_waived, service_charge_waive_reason, created_by, updated_by,
                          seller_fssai)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
               $20, $21, $22, $22, $23)
       RETURNING id`,
      [
        restaurantId,
        data.outletId,
        data.businessDayId,
        data.orderId,
        billNumber,
        data.discountId,
        data.discountCode,
        priced.subtotal,
        priced.discountAmount,
        priced.taxAmount,
        priced.serviceCharge,
        priced.roundOff,
        priced.totalAmount,
        data.isSplit || false,
        priced.loyaltyPointsUsed,
        priced.loyaltyDiscount,
        data.consumeStock || false,
        data.taxMode || null,
        data.sellerGstin || null,
        Boolean(data.serviceChargeWaived),
        data.serviceChargeWaived ? data.waiveReason : null,
        userId,
        data.sellerFssai || null,
      ]
    );

    const billId = inserted.rows[0].id;
    await client.query('UPDATE bills SET receipt_settings=$2::jsonb WHERE id=$1', [billId, JSON.stringify(data.receiptSettings)]);
    const billItemIds = [];

    // Exactly which lines, and how much of each, this bill covers.
    for (const line of data.lines) {
      const added = await client.query(
        `INSERT INTO bill_items (bill_id, order_item_id, quantity, line_subtotal, line_tax, line_total)
         VALUES ($1, $2, $3, 0, 0, 0)
         RETURNING id`,
        [billId, line.orderItemId, line.quantity]
      );
      billItemIds.push(added.rows[0].id);
    }

    await writePricing(client, restaurantId, billId, priced, billItemIds, userId);

    // The order is only "billed" once every line has been billed in full.
    const after = await findBillableItems(client, restaurantId, data.orderId);

    if (after.every((row) => row.remaining_quantity <= 0.0001)) {
      await client.query(
        "UPDATE orders SET order_status = 'billed', updated_by = $3 WHERE restaurant_id = $1 AND id = $2",
        [restaurantId, data.orderId, userId]
      );
    }

    // Points spent on this bill leave the guest's balance now, because the
    // discount has already been taken off the total.
    if (priced.loyaltyPointsUsed > 0 && data.customerId) {
      await moveRedeemedPoints(client, restaurantId, data.customerId, billId, billNumber, 0, priced.loyaltyPointsUsed, userId);
    }

    // A guest whose record carries a GSTIN gets a B2B invoice: the buyer is
    // written on the bill now, so the invoice never changes if the guest's
    // record does — the address too, which a tax invoice must print for a
    // registered buyer (it was left behind, so the company's own invoices
    // printed no address unless someone typed it on every bill).
    await crmRepository.recordInvoiceBuyer(client, restaurantId, billId, userId);
    await client.query(
      `UPDATE bill_gst_recipients r
       SET address = NULLIF(LEFT(BTRIM(g.address), 300), '')
       FROM bills b
       JOIN orders o ON o.id = b.order_id
       JOIN customers g ON g.id = o.customer_id
       WHERE r.bill_id = $1 AND b.id = r.bill_id AND r.address IS NULL AND g.gstin = r.gstin`,
      [billId]
    );

    // Billing is the moment a dish is really sold, so this is where its
    // ingredients leave stock — from the bill's own outlet's store.
    if (data.consumeStock) {
      await consumeIngredients(client, restaurantId, data.lines, { billId, billNumber, outletId: data.outletId }, userId);
    }

    if (priced.totalAmount === 0) {
      await settle(client, restaurantId, billId, data.orderId, data.tableId, userId);
    }

    await client.query("COMMIT");
    return { billId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// --- A bill on a guest's or company's account --------------------------------
//
// The account's credit limit holds whatever happens to a bill after it went
// on the account: a discount taken off, service charge put back, a payment
// handed back — anything that makes the bill owe more — is checked against
// the limit, with the account locked, exactly as putting a bill on it is.
// (Only putting it on was checked, so a ₹299 bill on a ₹400 account could
// become ₹599 by taking its discount off.)
//
// Lock order, everywhere: the account first, then its bills (as collecting
// money on an account does), so two tills can never each hold one and wait
// for the other.

// The account the bill is on now, locked; null when it is on none. Read
// before the bill is locked, so the caller checks after locking the bill that
// it is still on this account (accountChanged) and starts again if not.
const lockAccountOfBill = async (client, restaurantId, billId) => {
  const bill = await client.query("SELECT account_customer_id FROM bills WHERE restaurant_id = $1 AND id = $2", [
    restaurantId,
    billId,
  ]);
  const customerId = bill.rows[0] ? bill.rows[0].account_customer_id : null;

  if (!customerId) {
    return null;
  }

  const account = await client.query(
    `SELECT customer_id, credit_limit, status FROM customer_accounts
     WHERE restaurant_id = $1 AND customer_id = $2
     FOR UPDATE`,
    [restaurantId, customerId]
  );

  return account.rows[0] || { customer_id: customerId, credit_limit: null, status: null };
};

const accountChanged = (account, bill) =>
  Number((account && account.customer_id) || 0) !== Number(bill.account_customer_id || 0);

// Whether the account has room for this bill to owe `due`, its other bills
// counted. `db`: a client holding the account's lock, or the pool for the
// check made before anyone is asked for a PIN.
const accountRoom = async (db, restaurantId, customerId, billId, due) => {
  const result = await db.query(
    `SELECT a.credit_limit, a.status,
            COALESCE(NULLIF(BTRIM(c.company_name), ''), c.name) AS account_name,
            (SELECT COALESCE(SUM(GREATEST(o.total_amount - o.credited_amount - (o.paid_amount - o.refunded_amount), 0)), 0)
             FROM bills o
             WHERE o.restaurant_id = $1 AND o.account_customer_id = $2 AND o.id <> $3
               AND o.bill_status IN ('unpaid', 'partial')) AS owed_elsewhere
     FROM customers c
     LEFT JOIN customer_accounts a ON a.customer_id = c.id AND a.restaurant_id = c.restaurant_id
     WHERE c.restaurant_id = $1 AND c.id = $2`,
    [restaurantId, customerId, billId]
  );
  const row = result.rows[0] || {};
  const limit = row.credit_limit === null || row.credit_limit === undefined ? null : Number(row.credit_limit);
  const owed = Math.round(Number(row.owed_elsewhere || 0) * 100) / 100;
  const onHold = row.status !== "active";

  return {
    name: row.account_name || "The guest",
    limit,
    owed,
    due: Math.round(Number(due) * 100) / 100,
    onHold,
    fits: !onHold && limit !== null && owed + Number(due) <= limit + 0.009,
  };
};

// The same, unlocked: for the check made before anyone is asked for a PIN.
const accountRoomNow = (restaurantId, customerId, billId, due) => accountRoom(pool, restaurantId, customerId, billId, due);

// What a bill would owe at a new total: the total, less what was credited
// back against the sale, less the money held on it.
const dueAt = (bill, total) =>
  Math.round(
    (Number(total) - Number(bill.credited_amount || 0) - (Number(bill.paid_amount) - Number(bill.refunded_amount))) * 100
  ) / 100;

// Re-prices a bill that has not been settled, in place: the same number, the
// same bill. A coupon, points, a till discount, a no-charge bill or a guest
// declining service charge used to void the bill and raise a new one, which
// used up coupon limits and filled the voids report with routine entries.
//
// `work(client, bill, lines)` runs with the bill locked and returns what to
// write: { priced, changes, discountId?, discountCode?, ... } or { error }.
//
// A bill on an account that would owe more afterwards must still fit the
// account's credit limit: { error: "OVER_LIMIT", ...accountRoom } if not.
const reprice = async (restaurantId, billId, outletId, work, userId) => {
  for (let attempt = 1; ; attempt += 1) {
    const result = await repriceOnce(restaurantId, billId, outletId, work, userId);

    // The bill moved onto (or off) an account between the two reads: start
    // again, now locking the right account first.
    if (result.error !== "ACCOUNT_MOVED" || attempt >= 3) {
      return result.error === "ACCOUNT_MOVED" ? { error: "BUSY" } : result;
    }
  }
};

const repriceOnce = async (restaurantId, billId, outletId, work, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const bill = await findHeader(restaurantId, billId, outletId, client);

    if (!bill) {
      await client.query("ROLLBACK");
      return { error: "NOT_FOUND" };
    }

    const account = await lockAccountOfBill(client, restaurantId, billId);
    await client.query("SELECT id FROM bills WHERE id = $1 FOR UPDATE", [billId]);
    const fresh = await findHeader(restaurantId, billId, outletId, client);

    if (accountChanged(account, fresh)) {
      await client.query("ROLLBACK");
      return { error: "ACCOUNT_MOVED" };
    }

    const lines = await findLinesForPricing(billId, client);
    const plan = await work(client, fresh, lines);

    if (plan.error) {
      await client.query("ROLLBACK");
      return plan;
    }

    const { priced, changes } = plan;

    if (fresh.account_customer_id) {
      const before = dueAt(fresh, fresh.total_amount);
      const after = dueAt(fresh, priced.totalAmount);

      if (after > before + 0.009) {
        const room = await accountRoom(client, restaurantId, fresh.account_customer_id, billId, after);

        if (!room.fits) {
          await client.query("ROLLBACK");
          return { error: "OVER_LIMIT", ...room };
        }
      }
    }

    // Coupon uses follow the coupon on the bill.
    if (Number(fresh.discount_id || 0) !== Number(plan.discountId || 0)) {
      if (plan.discountId && !(await takeCouponUse(client, restaurantId, plan.discountId))) {
        await client.query("ROLLBACK");
        return { error: "COUPON_LIMIT" };
      }

      if (fresh.discount_id) {
        await giveCouponUseBack(client, restaurantId, fresh.discount_id);
      }
    }

    await moveRedeemedPoints(
      client,
      restaurantId,
      fresh.customer_id,
      billId,
      fresh.bill_number,
      fresh.loyalty_points_used,
      priced.loyaltyPointsUsed,
      userId
    );

    await client.query(
      `UPDATE bills
       SET discount_id = $3, discount_code = $4,
           manual_discount_type = $5, manual_discount_value = $6,
           discount_reason = $7, discount_note = $8, discount_given_by = $9, discount_approved_by = $10,
           service_charge_waived = $11, service_charge_waive_reason = $12,
           is_complimentary = $13, complimentary_reason = $14, complimentary_note = $15,
           complimentary_by = $16, complimentary_approved_by = $17,
           delivery_charge_waived = $18, delivery_charge_waive_reason = $19,
           delivery_charge_waived_by = $20, delivery_charge_approved_by = $21,
           last_adjusted_at = NOW()
       WHERE restaurant_id = $1 AND id = $2`,
      [
        restaurantId,
        billId,
        plan.discountId || null,
        plan.discountCode || null,
        changes.manualDiscountType,
        changes.manualDiscountValue,
        changes.discountReason,
        changes.discountNote,
        changes.discountGivenBy,
        changes.discountApprovedBy,
        changes.serviceChargeWaived,
        changes.serviceChargeWaived ? changes.waiveReason : null,
        changes.complimentary,
        changes.complimentary ? changes.complimentaryReason : null,
        changes.complimentary ? changes.complimentaryNote : null,
        changes.complimentary ? changes.complimentaryBy : null,
        changes.complimentary ? changes.complimentaryApprovedBy : null,
        Boolean(changes.deliveryChargeWaived),
        changes.deliveryChargeWaived ? changes.deliveryWaiveReason : null,
        changes.deliveryChargeWaived ? changes.deliveryWaivedBy || null : null,
        changes.deliveryChargeWaived ? changes.deliveryApprovedBy || null : null,
      ]
    );

    await writePricing(
      client,
      restaurantId,
      billId,
      priced,
      lines.map((line) => line.bill_item_id),
      userId
    );

    if (priced.totalAmount === 0) {
      await settle(client, restaurantId, billId, fresh.order_id, fresh.table_id, userId);
    }

    await client.query("COMMIT");
    return { before: fresh };
  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === "NOT_ENOUGH_POINTS") {
      return { error: "NOT_ENOUGH_POINTS", balance: error.balance };
    }

    throw error;
  } finally {
    client.release();
  }
};

// Reads the lines on THIS bill, finds each recipe and takes the ingredients out
// of stock at the bill's outlet (its own store where it has one, else the main
// store). Working from the billed lines rather than the whole order means a
// split bill consumes each portion exactly once. Products without a recipe
// consume nothing.
const consumeIngredients = async (client, restaurantId, lines, bill, userId) => {
  const ids = lines.map((line) => line.orderItemId);

  if (ids.length === 0) {
    return;
  }

  const items = await client.query(
    `SELECT oi.id, oi.product_id, oi.product_variant_id, oi.item_name, oi.combo_parts, p.is_combo
     FROM order_items oi
     LEFT JOIN products p ON p.id = oi.product_id
     WHERE oi.id = ANY($1::bigint[]) AND oi.item_status <> 'cancelled'`,
    [ids]
  );

  for (const row of items.rows) {
    const billedQuantity = Number(
      lines.find((line) => Number(line.orderItemId) === Number(row.id)).quantity
    );
    const item = { ...row, quantity: billedQuantity };

    for (const part of await expandToParts(client, restaurantId, item)) {
      const recipe = await recipeRepository.findForSale(
        client,
        restaurantId,
        part.productId,
        part.productVariantId
      );

      for (const line of recipe) {
        await inventoryRepository.recordMovement(
          client,
          restaurantId,
          {
            inventoryItemId: line.inventory_item_id,
            transactionType: "consumption",
            quantity: -(Number(line.quantity) * part.quantity),
            reason: `Sold: ${item.item_name}`,
            referenceType: "bill",
            referenceId: bill.billId,
            notes: bill.billNumber,
            outletId: bill.outletId || null,
            allowNegative: true,
          },
          userId
        );
      }
    }

    const addOnRecipe = await client.query(
      `SELECT mr.inventory_item_id, mr.quantity, m.modifier_name
       FROM order_item_modifiers m
       JOIN modifier_recipes mr ON mr.modifier_id = m.modifier_id AND mr.restaurant_id = $2
       WHERE m.order_item_id = $1`,
      [row.id, restaurantId]
    );
    for (const line of addOnRecipe.rows) {
      await inventoryRepository.recordMovement(client, restaurantId, {
        inventoryItemId: line.inventory_item_id,
        transactionType: "consumption",
        quantity: -(Number(line.quantity) * billedQuantity),
        reason: `Add-on sold: ${line.modifier_name}`,
        referenceType: "bill",
        referenceId: bill.billId,
        notes: bill.billNumber,
        outletId: bill.outletId || null,
        allowNegative: true,
      }, userId);
    }
  }
};

// A combo has no recipe of its own: it is made of dishes that do. One line of
// "Thali x2" containing "Dal x1" consumes two portions of dal.
const expandToParts = async (client, restaurantId, item) => {
  if (item.combo_parts !== null && item.combo_parts !== undefined) {
    return item.combo_parts.map(part => ({productId:part.productId,
      productVariantId:part.productVariantId,quantity:Number(part.quantity)*Number(item.quantity)}));
  }
  if (!item.is_combo) {
    return [
      {
        productId: item.product_id,
        productVariantId: item.product_variant_id,
        quantity: Number(item.quantity),
      },
    ];
  }

  const parts = await comboRepository.findItemsForSale(client, restaurantId, item.product_id);

  return parts.map((part) => ({
    productId: part.product_id,
    productVariantId: part.product_variant_id,
    quantity: Number(part.quantity) * Number(item.quantity),
  }));
};

// What the guest still owes: the bill, less what was credited back against
// the sale, less the money held (paid less handed back).
const dueOf = (bill) =>
  Number(bill.total_amount) - Number(bill.credited_amount || 0) - (Number(bill.paid_amount) - Number(bill.refunded_amount));

// Taking a payment can complete the whole sale: the bill is settled, the order
// is closed and the table is freed, so it all happens in one transaction.
//
// The payment belongs to the business day open NOW, not to the day the bill
// was raised: a due from last week collected today is in today's drawer, and
// a day already closed and counted is never changed.
const addPayment = async (restaurantId, billId, outletId, payment, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const locked = await client.query(
      `SELECT b.id, b.bill_number, b.order_id, b.outlet_id, b.business_day_id, b.total_amount, b.paid_amount,
              b.refunded_amount, b.credited_amount, b.bill_status, o.table_id, o.customer_id
       FROM bills b
       JOIN orders o ON o.id = b.order_id
       WHERE b.restaurant_id = $1 AND b.id = $2 AND ${outletScope("$3")}
       FOR UPDATE OF b`,
      [restaurantId, billId, outletId]
    );

    const bill = locked.rows[0];

    if (!bill) {
      await client.query("ROLLBACK");
      return { error: "NOT_FOUND" };
    }

    if (bill.bill_status === "void") {
      await client.query("ROLLBACK");
      return { error: "VOID" };
    }

    if (bill.bill_status === "paid") {
      await client.query("ROLLBACK");
      return { error: "ALREADY_PAID" };
    }

    const applied = await applyPayment(client, restaurantId, bill, payment, userId);

    if (applied.error) {
      await client.query("ROLLBACK");
      return applied;
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

// The business day money for a bill goes into, locked against being closed
// while it is written:
//
//   1. the day open now at the bill's own outlet (the main counter's for a
//      bill with none) — a due from last week collected today is in today's
//      drawer;
//   2. else the day the bill was raised in, while it is still open: an outlet
//      with no day of its own trades on the main counter's (a bill raised
//      with that outlet chosen sits in the main counter's day), so its money
//      goes there too. It used to be refused — "no day is open" — for a bill
//      the screen had just raised.
//
// Returns the day's id, or null when neither is open.
const openDayForBill = async (client, restaurantId, bill) => {
  const own = await client.query(
    "SELECT id FROM business_days WHERE restaurant_id = $1 AND day_status = 'open' AND outlet_id IS NOT DISTINCT FROM $2::bigint FOR SHARE",
    [restaurantId, bill.outlet_id || null]
  );

  if (own.rows.length > 0) {
    return own.rows[0].id;
  }

  if (!bill.business_day_id) {
    return null;
  }

  const raisedIn = await client.query(
    "SELECT id FROM business_days WHERE restaurant_id = $1 AND id = $2 AND day_status = 'open' FOR SHARE",
    [restaurantId, bill.business_day_id]
  );

  return raisedIn.rows.length > 0 ? raisedIn.rows[0].id : null;
};

// The day open now at one till: an outlet's own, or (null) the main
// counter's. Money collected on an account goes into the drawer of the till
// that takes it, whichever outlet the bills were raised at.
const openDayOfTill = async (client, restaurantId, outletId) => {
  const day = await client.query(
    "SELECT id FROM business_days WHERE restaurant_id = $1 AND day_status = 'open' AND outlet_id IS NOT DISTINCT FROM $2::bigint FOR SHARE",
    [restaurantId, outletId || null]
  );

  return day.rows.length > 0 ? day.rows[0].id : null;
};

// Records one payment on a bill locked by the caller (FOR UPDATE), inside
// the caller's transaction, settling the bill when the last of it is in:
// into `dayId` when the caller names the day (a collection on an account:
// the collecting till's day), else into the bill's day (openDayForBill).
// Returns { error } without writing anything when no day is open or the
// amount is more than is due.
//
// bill: id, bill_number, order_id, outlet_id, business_day_id, total_amount,
//       paid_amount, refunded_amount, credited_amount, table_id
// payment: paymentMethod, amount, tenderedAmount, changeAmount,
//          transactionRef, earnPoints, customerId, and optionally tipAmount,
//          paymentTypeId, advanceId (paymentMethod "advance": the guest's
//          advance it is paid from)
const applyPayment = async (client, restaurantId, bill, payment, userId, { dayId = null } = {}) => {
  const intoDay = dayId || (await openDayForBill(client, restaurantId, bill));

  if (!intoDay) {
    return { error: "NO_DAY", outletId: bill.outlet_id || null };
  }

  const due = Math.round(dueOf(bill) * 100) / 100;

  if (payment.amount > due + 0.009) {
    return { error: "TOO_MUCH", due };
  }

  // Paid from an advance the guest gave earlier: the advance is locked and
  // must still hold this much; what it pays is marked used on it.
  if (payment.paymentMethod === "advance") {
    const advance = await client.query(
      `SELECT id, amount, used_amount, refunded_amount FROM customer_advances
       WHERE restaurant_id = $1 AND id = $2
       FOR UPDATE`,
      [restaurantId, payment.advanceId]
    );
    const row = advance.rows[0];

    if (!row) {
      return { error: "ADVANCE_NOT_FOUND" };
    }

    const left = Math.round((Number(row.amount) - Number(row.used_amount) - Number(row.refunded_amount)) * 100) / 100;

    if (payment.amount > left + 0.009) {
      return { error: "ADVANCE_SHORT", left };
    }

    await client.query(
      "UPDATE customer_advances SET used_amount = used_amount + $2 WHERE id = $1",
      [row.id, payment.amount]
    );
  }

  const inserted = await client.query(
    `INSERT INTO payments (restaurant_id, bill_id, order_id, business_day_id, payment_method,
                           amount, tendered_amount, change_amount, transaction_ref, created_by,
                           tip_amount, payment_type_id, advance_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      restaurantId,
      bill.id,
      bill.order_id,
      intoDay,
      payment.paymentMethod,
      payment.amount,
      payment.tenderedAmount ?? null,
      payment.changeAmount || 0,
      payment.transactionRef ?? null,
      userId,
      payment.tipAmount || 0,
      payment.paymentTypeId || null,
      payment.paymentMethod === "advance" ? payment.advanceId : null,
    ]
  );

  const paid = Math.round((Number(bill.paid_amount) + Number(payment.amount)) * 100) / 100;
  const fullyPaid = payment.amount >= due - 0.009;

  await client.query(
    `UPDATE bills
     SET paid_amount = $3,
         bill_status = $4::varchar,
         settled_at = CASE WHEN $4::varchar = 'paid' THEN NOW() ELSE NULL END,
         updated_by = $5
     WHERE restaurant_id = $1 AND id = $2`,
    [restaurantId, bill.id, paid, fullyPaid ? "paid" : "partial", userId]
  );

  if (fullyPaid) {
    await settle(client, restaurantId, bill.id, bill.order_id, bill.table_id, userId);

    // Points are earned once the money is actually in, and only once per bill
    // (a unique index on bill_id enforces that) — by the guest the order
    // names NOW, with the bill locked, never by a guest read before the lock.
    // The guest is locked first and the order read again under that lock: a
    // guest erased (or the order handed to another guest) a moment ago is
    // seen here, and the points go to nobody (or to the guest it names now),
    // never into an erased record.
    const customerId = await guestOfOrder(client, restaurantId, bill.order_id);

    if (customerId && (payment.earnPoints > 0 || Number(customerId) !== Number(payment.customerId || 0))) {
      await loyaltyRepository.recordPoints(
        client,
        restaurantId,
        {
          customerId,
          billId: bill.id,
          points: payment.earnPoints || 1,
          entryType: "earn",
          amount: Number(bill.total_amount),
          notes: `Earned on ${bill.bill_number}`,
        },
        userId
      );
    }
  }

  return { ok: true, dayId: intoDay, paid, settled: fullyPaid, paymentId: inserted.rows[0].id };
};

// The guest an order names now, locked (FOR UPDATE on the guest's record) and
// read again under that lock; null when it names none, or names a record
// that has been erased.
const guestOfOrder = async (client, restaurantId, orderId) => {
  const first = await client.query("SELECT customer_id FROM orders WHERE restaurant_id = $1 AND id = $2", [
    restaurantId,
    orderId,
  ]);
  const customerId = first.rows[0] ? first.rows[0].customer_id : null;

  if (!customerId) {
    return null;
  }

  const guest = await client.query(
    "SELECT id, erased_at FROM customers WHERE restaurant_id = $1 AND id = $2 FOR UPDATE",
    [restaurantId, customerId]
  );
  const again = await client.query("SELECT customer_id FROM orders WHERE restaurant_id = $1 AND id = $2", [
    restaurantId,
    orderId,
  ]);

  if (!guest.rows[0] || guest.rows[0].erased_at || Number(again.rows[0].customer_id || 0) !== Number(customerId)) {
    return again.rows[0] && again.rows[0].customer_id && Number(again.rows[0].customer_id) !== Number(customerId)
      ? guestOfOrder(client, restaurantId, orderId)
      : null;
  }

  return customerId;
};

// Corrects how one payment was taken — "sir, I paid by GPay" — while its
// business day is still open: the method, the owner's payment type and the
// reference change; the amount, the bill, its GST, the sales and the points
// do not. The day is held (FOR SHARE) so it cannot be closed half way, and
// the correction is kept with who made it, who approved it and why.
//
// data: { paymentId, method, paymentTypeId, reference, reason }
// who:  { userId, approverId }
const correctPayment = async (restaurantId, billId, outletId, data, who) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const locked = await client.query(
      `SELECT b.id, b.bill_number, b.bill_status FROM bills b
       WHERE b.restaurant_id = $1 AND b.id = $2 AND ${outletScope("$3")}
       FOR UPDATE OF b`,
      [restaurantId, billId, outletId]
    );
    const bill = locked.rows[0];

    if (!bill) {
      await client.query("ROLLBACK");
      return { error: "NOT_FOUND" };
    }

    const found = await client.query(
      `SELECT p.id, p.payment_method, p.payment_type_id, p.transaction_ref, p.amount, p.change_amount,
              p.payment_status, p.business_day_id, p.tip_amount
       FROM payments p
       WHERE p.restaurant_id = $1 AND p.bill_id = $2 AND p.id = $3
       FOR UPDATE`,
      [restaurantId, billId, data.paymentId]
    );
    const payment = found.rows[0];

    if (!payment) {
      await client.query("ROLLBACK");
      return { error: "PAYMENT_NOT_FOUND" };
    }

    const day = payment.business_day_id
      ? await client.query("SELECT id, day_status FROM business_days WHERE id = $1 FOR SHARE", [payment.business_day_id])
      : { rows: [] };
    const problem = correctionProblem(payment, day.rows[0], data);

    if (problem) {
      await client.query("ROLLBACK");
      return problem;
    }

    await client.query(
      `UPDATE payments SET payment_method = $2, payment_type_id = $3, transaction_ref = $4
       WHERE id = $1`,
      [payment.id, data.method, data.paymentTypeId || null, data.reference || null]
    );

    const inserted = await client.query(
      `INSERT INTO payment_corrections (restaurant_id, bill_id, payment_id, business_day_id, amount,
                                        old_method, new_method, old_payment_type_id, new_payment_type_id,
                                        old_reference, new_reference, reason, corrected_by, approved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        restaurantId,
        billId,
        payment.id,
        payment.business_day_id,
        payment.amount,
        payment.payment_method,
        data.method,
        payment.payment_type_id,
        data.paymentTypeId || null,
        payment.transaction_ref,
        data.reference || null,
        data.reason,
        who.userId,
        who.approverId || null,
      ]
    );

    await client.query("COMMIT");

    return {
      ok: true,
      correctionId: inserted.rows[0].id,
      billNumber: bill.bill_number,
      amount: Number(payment.amount),
      tip: Number(payment.tip_amount || 0),
      oldMethod: payment.payment_method,
      oldReference: payment.transaction_ref,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// Why a payment cannot be corrected this way, or null. Shared by the check
// made before anyone is asked for a PIN and the correction itself.
//
//   payment: payment_method, payment_type_id, transaction_ref, change_amount, payment_status
//   day:     the payment's business day ({ day_status }), or undefined
const correctionProblem = (payment, day, data) => {
  if (payment.payment_status !== "success") {
    return { error: "NOT_SUCCESS" };
  }

  if (!day || day.day_status !== "open") {
    return { error: "DAY_CLOSED" };
  }

  if (payment.payment_method === "advance" || data.method === "advance") {
    return { error: "ADVANCE" };
  }

  // Change handed back came out of the drawer in cash; a card or UPI payment
  // cannot have given change, so a cash payment that did cannot become one.
  if (Number(payment.change_amount || 0) > 0 && data.method !== "cash") {
    return { error: "CHANGE_GIVEN", change: Number(payment.change_amount) };
  }

  const sameType = Number(payment.payment_type_id || 0) === Number(data.paymentTypeId || 0);
  const sameRef = String(payment.transaction_ref || "") === String(data.reference || "");

  if (payment.payment_method === data.method && sameType && sameRef) {
    return { error: "NO_CHANGE" };
  }

  return null;
};

// Payment corrections in a period (by the payment's business date), newest
// first, a page at a time: for theft control and the owner's checks. Each
// with who made it, who approved it, the bill and both methods.
const findCorrections = async (restaurantId, { from, to, outletId = null, timezone, limit = 25, offset = 0 }) => {
  const result = await pool.query(
    `SELECT pc.id, pc.bill_id, b.bill_number, pc.amount, pc.old_method, pc.new_method, pc.old_reference, pc.new_reference,
            opt.name AS old_type_name, npt.name AS new_type_name, pc.reason, pc.corrected_at,
            pc.corrected_by AS user_id, COALESCE(cu.name, 'Unknown') AS user_name, au.name AS approver_name,
            COALESCE(bd.business_date, (pc.corrected_at AT TIME ZONE $5)::date)::text AS business_date,
            ol.name AS outlet_name,
            COUNT(*) OVER ()::int AS total_count,
            SUM(pc.amount) OVER () AS total_amount
     FROM payment_corrections pc
     JOIN bills b ON b.id = pc.bill_id
     LEFT JOIN business_days bd ON bd.id = pc.business_day_id
     LEFT JOIN payment_types opt ON opt.id = pc.old_payment_type_id
     LEFT JOIN payment_types npt ON npt.id = pc.new_payment_type_id
     LEFT JOIN users cu ON cu.id = pc.corrected_by
     LEFT JOIN users au ON au.id = pc.approved_by
     LEFT JOIN outlets ol ON ol.id = b.outlet_id
     WHERE pc.restaurant_id = $1
       AND COALESCE(bd.business_date, (pc.corrected_at AT TIME ZONE $5)::date) BETWEEN $2::date AND $3::date
       AND ($4::bigint IS NULL OR b.outlet_id = $4)
     ORDER BY pc.corrected_at DESC, pc.id DESC
     LIMIT $6 OFFSET $7`,
    [restaurantId, from, to, outletId, timezone || "Asia/Kolkata", limit, offset]
  );

  return result.rows;
};

// A payment on a bill, with its day, for the check before a PIN is asked.
const findPayment = async (restaurantId, billId, paymentId) => {
  const result = await pool.query(
    `SELECT p.id, p.bill_id, p.payment_method, p.payment_type_id, p.transaction_ref, p.amount, p.change_amount,
            p.payment_status, p.business_day_id, bd.day_status
     FROM payments p
     LEFT JOIN business_days bd ON bd.id = p.business_day_id
     WHERE p.restaurant_id = $1 AND p.bill_id = $2 AND p.id = $3`,
    [restaurantId, billId, paymentId]
  );

  return result.rows[0] || null;
};

// Money given back.
//
// On a settled bill it is money back against the SALE (a complaint, a dish
// sent back): a credit note is issued (CN-0001…) that takes the value and its
// GST off, the bill stays settled, and earned points can be taken back.
//
// On a bill not yet settled it is a part payment handed back (the wrong card
// was charged): the sale is unchanged and the guest owes that money again.
// Only that kind lets a bill be voided afterwards.
//
// Either way it belongs to the business day open now.
//
// `plan(client, bill)` is called with the bill locked and returns the credit
// note to write (for a settled bill): { note, taxes, items, pointsToReverse }
// or { error }.
const addRefund = async (restaurantId, billId, outletId, refund, plan, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // A part payment handed back on a bill on an account makes the account
    // owe more: its limit is checked with the account locked (first).
    const account = await lockAccountOfBill(client, restaurantId, billId);

    const locked = await client.query(
      `SELECT b.id, b.bill_number, b.outlet_id, b.business_day_id, b.total_amount, b.paid_amount,
              b.refunded_amount, b.credited_amount, b.bill_status, b.is_complimentary, b.round_off,
              b.taxable_amount, b.tax_amount, b.cess_amount, b.service_charge, b.subtotal, b.discount_amount,
              b.account_customer_id, o.customer_id
       FROM bills b
       JOIN orders o ON o.id = b.order_id
       WHERE b.restaurant_id = $1 AND b.id = $2 AND ${outletScope("$3")}
       FOR UPDATE OF b`,
      [restaurantId, billId, outletId]
    );

    const bill = locked.rows[0];

    if (!bill) {
      await client.query("ROLLBACK");
      return { error: "NOT_FOUND" };
    }

    if (accountChanged(account, bill)) {
      await client.query("ROLLBACK");
      return { error: "BUSY" };
    }

    if (bill.bill_status === "void") {
      await client.query("ROLLBACK");
      return { error: "VOID" };
    }

    const held = Math.round((Number(bill.paid_amount) - Number(bill.refunded_amount)) * 100) / 100;

    if (held <= 0.009) {
      await client.query("ROLLBACK");
      return { error: "NOT_PAID" };
    }

    if (refund.amount > held + 0.009) {
      await client.query("ROLLBACK");
      return { error: "TOO_MUCH", refundable: held };
    }

    // The money comes out of the day the bill's money goes into (see
    // openDayForBill): its outlet's open day, else the day it was raised in.
    const dayId = await openDayForBill(client, restaurantId, bill);

    if (!dayId) {
      await client.query("ROLLBACK");
      return { error: "NO_DAY" };
    }

    const settled = bill.bill_status === "paid";

    if (!settled && bill.account_customer_id) {
      const owes = Math.round((dueAt(bill, bill.total_amount) + Number(refund.amount)) * 100) / 100;
      const room = await accountRoom(client, restaurantId, bill.account_customer_id, billId, owes);

      if (!room.fits) {
        await client.query("ROLLBACK");
        return { error: "OVER_LIMIT", ...room };
      }
    }

    // How the money went back: as asked, or — when the screen did not say —
    // the way the bill was paid, if it was paid one way only.
    let method = refund.refundMethod;

    if (!method) {
      const methods = await client.query(
        "SELECT DISTINCT payment_method FROM payments WHERE bill_id = $1 AND payment_status = 'success'",
        [billId]
      );

      if (methods.rows.length !== 1) {
        await client.query("ROLLBACK");
        return { error: "METHOD_NEEDED", methods: methods.rows.map((row) => row.payment_method) };
      }

      method = methods.rows[0].payment_method;
    }

    if (!settled && refund.items && refund.items.length > 0) {
      await client.query("ROLLBACK");
      return { error: "RETURN_NOT_SETTLED" };
    }

    // Back onto the guest's advance: only as much as this bill took from an
    // advance and has not already put back. No money leaves the drawer; the
    // advance holds it again for the guest's next bill (or a refund of it).
    let advanceId = null;

    if (method === "advance") {
      const used = await client.query(
        `SELECT p.advance_id, SUM(p.amount) AS paid,
                COALESCE((SELECT SUM(r.amount) FROM refunds r WHERE r.bill_id = $1 AND r.advance_id = p.advance_id), 0) AS back
         FROM payments p
         WHERE p.bill_id = $1 AND p.advance_id IS NOT NULL AND p.payment_status = 'success'
         GROUP BY p.advance_id
         ORDER BY MAX(p.id) DESC`,
        [billId]
      );
      const room = used.rows.map((row) => ({ id: row.advance_id, left: Math.round((Number(row.paid) - Number(row.back)) * 100) / 100 }));
      const from = room.find((row) => row.left >= Number(refund.amount) - 0.009);

      if (!from) {
        await client.query("ROLLBACK");
        return { error: "ADVANCE_BACK_TOO_MUCH", left: room.reduce((most, row) => Math.max(most, row.left), 0) };
      }

      advanceId = from.id;
      await client.query("SELECT id FROM customer_advances WHERE id = $1 FOR UPDATE", [advanceId]);
      await client.query(
        "UPDATE customer_advances SET used_amount = used_amount - $2 WHERE id = $1",
        [advanceId, refund.amount]
      );
    }

    const note = settled ? await plan(client, bill) : null;

    if (note && note.error) {
      await client.query("ROLLBACK");
      return note;
    }

    const inserted = await client.query(
      `INSERT INTO refunds (restaurant_id, bill_id, business_day_id, amount, refund_method,
                            reason, refund_kind, created_by, payment_type_id, advance_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        restaurantId,
        billId,
        dayId,
        refund.amount,
        method,
        refund.reason,
        settled ? "credit_note" : "payment_reversal",
        userId,
        method === refund.refundMethod ? refund.paymentTypeId || null : null,
        advanceId,
      ]
    );

    let creditNoteNumber = null;

    if (settled) {
      // Numbered like the invoices: with yearly numbering, in the financial
      // year of the day the note is issued (CN/26-27/0001).
      const numbering = await client.query(
        `SELECT s.invoice_numbering, bd.business_date::text AS business_date
         FROM business_days bd
         LEFT JOIN restaurant_settings s ON s.restaurant_id = bd.restaurant_id
         WHERE bd.id = $1`,
        [dayId]
      );
      const yearly = numbering.rows[0] && numbering.rows[0].invoice_numbering === "financial_year";
      const cnSeries = numberSeries(
        await creditNoteSeries(client, restaurantId, bill.outlet_id, yearly ? FY_SERIES_MAX : CN_SERIES_MAX),
        numbering.rows[0],
        numbering.rows[0] && numbering.rows[0].business_date
      );

      creditNoteNumber = await nextNumber(
        client,
        restaurantId,
        "CN",
        cnSeries.prefix,
        "credit_notes",
        "credit_note_number",
        cnSeries.separator
      );

      // Points earned on money now given back are taken back, as far as the
      // guest still has them.
      let pointsReversed = 0;

      if (refund.reversePoints && bill.customer_id && note.pointsToReverse > 0) {
        const balance = await client.query(
          "SELECT loyalty_points FROM customers WHERE restaurant_id = $1 AND id = $2",
          [restaurantId, bill.customer_id]
        );
        pointsReversed = Math.min(note.pointsToReverse, balance.rows.length ? Number(balance.rows[0].loyalty_points) : 0);

        if (pointsReversed > 0) {
          await loyaltyRepository.recordPoints(
            client,
            restaurantId,
            {
              customerId: bill.customer_id,
              billId,
              points: -pointsReversed,
              entryType: "adjust",
              amount: refund.amount,
              notes: `Taken back with ${creditNoteNumber} on ${bill.bill_number}`,
            },
            userId
          );
        }
      }

      const cn = await client.query(
        `INSERT INTO credit_notes (restaurant_id, outlet_id, business_day_id, bill_id, refund_id,
                                   credit_note_number, kind, reason, taxable_value, service_charge_value,
                                   tax_amount, cess_amount, round_off, total_amount, points_reversed, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         RETURNING id`,
        [
          restaurantId,
          bill.outlet_id,
          dayId,
          billId,
          inserted.rows[0].id,
          creditNoteNumber,
          note.kind,
          refund.reason,
          note.taxableValue,
          note.serviceChargeValue,
          note.taxAmount,
          note.cessAmount,
          note.roundOff,
          refund.amount,
          pointsReversed,
          userId,
        ]
      );

      for (const row of note.taxes) {
        await client.query(
          `INSERT INTO credit_note_taxes (restaurant_id, credit_note_id, tax_percentage, cess_percentage,
                                          taxable_value, service_charge_taxable, cgst_amount, sgst_amount, cess_amount)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            restaurantId,
            cn.rows[0].id,
            row.taxPercentage,
            row.cessPercentage,
            row.taxableValue,
            row.serviceChargeTaxable,
            row.cgstAmount,
            row.sgstAmount,
            row.cessAmount,
          ]
        );
      }

      for (const item of note.items) {
        await client.query(
          `INSERT INTO credit_note_items (credit_note_id, bill_item_id, quantity, taxable_value, tax_amount, amount)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [cn.rows[0].id, item.billItemId, item.quantity, item.taxableValue, item.taxAmount, item.amount]
        );
        await client.query(
          "UPDATE bill_items SET returned_quantity = returned_quantity + $2 WHERE id = $1",
          [item.billItemId, item.quantity]
        );
      }
    }

    // A settled bill stays settled (the sale is smaller by the credit note); a
    // bill not settled owes the money handed back again.
    const refunded = Math.round((Number(bill.refunded_amount) + Number(refund.amount)) * 100) / 100;
    const credited = Math.round((Number(bill.credited_amount) + (settled ? Number(refund.amount) : 0)) * 100) / 100;
    const stillHeld = Math.round((Number(bill.paid_amount) - refunded) * 100) / 100;
    const status = settled ? "paid" : stillHeld > 0.009 ? "partial" : "unpaid";

    await client.query(
      `UPDATE bills SET refunded_amount = $3, credited_amount = $4, bill_status = $5, updated_by = $6
       WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, billId, refunded, credited, status, userId]
    );

    await client.query("COMMIT");
    return { ok: true, kind: settled ? "credit_note" : "payment_reversal", creditNoteNumber, method };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// Voiding a bill undoes what billing did: the ingredients go back on the
// shelf at the same outlet, because the dish was never really sold.
const restoreIngredients = async (client, restaurantId, bill, userId) => {
  // Reverse the recorded movements, including add-ons. Today's recipe may
  // differ from the recipe that was consumed when this bill was raised.
  const movements = await client.query(`SELECT inventory_item_id, SUM(quantity) AS quantity,
    SUM(quantity * unit_cost) / NULLIF(SUM(quantity),0) AS unit_cost
    FROM stock_transactions WHERE restaurant_id=$1 AND reference_type='bill' AND reference_id=$2
    GROUP BY inventory_item_id HAVING SUM(quantity)<0 ORDER BY inventory_item_id`,[restaurantId,bill.id]);
  for (const line of movements.rows) await inventoryRepository.recordMovement(client,restaurantId,{
    inventoryItemId:line.inventory_item_id,transactionType:'adjustment',quantity:-Number(line.quantity),
    reason:'Bill voided',referenceType:'bill',referenceId:bill.id,notes:bill.bill_number,
    outletId:bill.outlet_id || null,allowNegative:true,keepLastCost:true,revalue:true,unitCost:line.unit_cost,
  },userId);
};

// Voiding is for a bill raised by mistake, before any money is held on it.
// It reopens the order so it can be corrected and billed again, gives back a
// coupon's use and any points spent, and puts the ingredients back.
const voidBill = async (restaurantId, billId, outletId, reason, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const locked = await client.query(
      `SELECT b.id, b.order_id, b.outlet_id, b.bill_number, b.paid_amount, b.refunded_amount,
              b.credited_amount, b.bill_status, b.consume_stock, b.discount_id,
              b.loyalty_points_used, b.loyalty_discount, b.account_customer_id, o.customer_id, o.order_status
       FROM bills b
       JOIN orders o ON o.id = b.order_id
       WHERE b.restaurant_id = $1 AND b.id = $2 AND ${outletScope("$3")}
       FOR UPDATE OF b`,
      [restaurantId, billId, outletId]
    );

    const bill = locked.rows[0];

    if (!bill) {
      await client.query("ROLLBACK");
      return { error: "NOT_FOUND" };
    }

    if (bill.bill_status === "void") {
      await client.query("ROLLBACK");
      return { error: "ALREADY_VOID" };
    }

    const held = Math.round((Number(bill.paid_amount) - Number(bill.refunded_amount)) * 100) / 100;

    if (held > 0.009) {
      await client.query("ROLLBACK");
      return { error: "HAS_PAYMENTS", held };
    }

    if (bill.bill_status === "paid") {
      await client.query("ROLLBACK");
      return { error: "SETTLED" };
    }

    // Put on an account: the order is closed and the table freed, so there
    // is no running order to reopen (bill.service checkVoid says why).
    if (bill.account_customer_id || bill.order_status === "completed") {
      await client.query("ROLLBACK");
      return { error: "ON_ACCOUNT" };
    }

    await client.query(
      `UPDATE bills SET bill_status = 'void', void_reason = $3, updated_by = $4
       WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, billId, reason, userId]
    );

    if (bill.discount_id) {
      await giveCouponUseBack(client, restaurantId, bill.discount_id);
    }

    // Points spent on this bill go back to the guest.
    if (Number(bill.loyalty_points_used) > 0 && bill.customer_id) {
      await loyaltyRepository.recordPoints(
        client,
        restaurantId,
        {
          customerId: bill.customer_id,
          billId,
          points: Number(bill.loyalty_points_used),
          entryType: "adjust",
          amount: Number(bill.loyalty_discount),
          notes: `Returned from voided bill ${bill.bill_number}`,
        },
        userId
      );
    }

    if (bill.consume_stock) {
      await restoreIngredients(client, restaurantId, bill, userId);
    }

    // Reopen the order unless another live bill still covers part of it.
    const others = await client.query(
      "SELECT COUNT(*)::int AS count FROM bills WHERE order_id = $1 AND id <> $2 AND bill_status <> 'void'",
      [bill.order_id, billId]
    );

    if (others.rows[0].count === 0) {
      await client.query(
        "UPDATE orders SET order_status = 'open', updated_by = $2 WHERE id = $1",
        [bill.order_id, userId]
      );
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

// Counts a print. `firstOnly` counts it only if the bill has never been
// printed, so two first prints racing each other cannot both be "the
// original": the second is a reprint and has to be allowed as one.
const recordPrint = async (restaurantId, billId, outletId, firstOnly) => {
  const result = await pool.query(
    `UPDATE bills b
     SET print_count = print_count + 1, last_printed_at = NOW(),
         first_printed_at = COALESCE(first_printed_at, NOW())
     WHERE b.restaurant_id = $1 AND b.id = $2 AND ${outletScope("$3")}
       AND ($4::boolean IS NOT TRUE OR b.print_count = 0)
     RETURNING print_count`,
    [restaurantId, billId, outletId, firstOnly]
  );

  return result.rows[0] || null;
};

// The business days on the Bills screen (one outlet's day, or every day open
// in the restaurant): what was billed in them, and the money that moved in
// them — a due from an older bill collected today, or a refund given today
// on one, is today's money.
//
// `outletId` (staff pinned to an outlet) narrows the BILLS to that outlet's.
// The money is every rupee that went into these days' drawers, whatever
// outlet's bill it paid: a company's dues collected at this till are in this
// drawer, and the cashier hands them over with the rest.
const daySummary = async (restaurantId, dayIds, outletId = null) => {
  const [sales, money, byMethod, refunds, byType, advances] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE b.bill_status <> 'void')::int AS bill_count,
              COALESCE(SUM(b.total_amount) FILTER (WHERE b.bill_status <> 'void'), 0) AS sales_total,
              COALESCE(SUM(b.discount_amount) FILTER (WHERE b.bill_status <> 'void'), 0) AS discounts,
              COALESCE(SUM(b.service_charge) FILTER (WHERE b.bill_status <> 'void'), 0) AS service_charge,
              COALESCE(SUM(b.tax_amount) FILTER (WHERE b.bill_status <> 'void'), 0) AS tax,
              COUNT(*) FILTER (WHERE b.is_complimentary AND b.bill_status <> 'void')::int AS complimentary_count,
              COUNT(*) FILTER (WHERE b.bill_status = 'void')::int AS void_count,
              -- Still to collect at the till; what went on a guest's or
              -- company's account is owed there, and counted apart.
              COALESCE(SUM(GREATEST(b.total_amount - b.credited_amount - (b.paid_amount - b.refunded_amount), 0))
                         FILTER (WHERE b.bill_status IN ('unpaid', 'partial') AND b.account_customer_id IS NULL), 0)
                AS due_now,
              COALESCE(SUM(GREATEST(b.total_amount - b.credited_amount - (b.paid_amount - b.refunded_amount), 0))
                         FILTER (WHERE b.bill_status IN ('unpaid', 'partial') AND b.account_customer_id IS NOT NULL), 0)
                AS on_account
       FROM bills b
       WHERE b.restaurant_id = $1 AND b.business_day_id = ANY($2::bigint[]) AND ${outletScope("$3")}`,
      [restaurantId, dayIds, outletId]
    ),
    pool.query(
      `SELECT COALESCE(SUM(p.amount), 0) AS collected,
              COALESCE(SUM(p.amount) FILTER (WHERE b.business_day_id IS DISTINCT FROM p.business_day_id), 0)
                AS dues_collected
       FROM payments p
       JOIN bills b ON b.id = p.bill_id
       WHERE p.restaurant_id = $1 AND p.business_day_id = ANY($2::bigint[]) AND p.payment_status = 'success'`,
      [restaurantId, dayIds]
    ),
    pool.query(
      `SELECT p.payment_method, COALESCE(SUM(p.amount), 0) AS amount, COALESCE(SUM(p.tip_amount), 0) AS tips
       FROM payments p
       WHERE p.restaurant_id = $1 AND p.business_day_id = ANY($2::bigint[]) AND p.payment_status = 'success'
       GROUP BY p.payment_method
       ORDER BY p.payment_method`,
      [restaurantId, dayIds]
    ),
    pool.query(
      `SELECT COALESCE(SUM(r.amount), 0) AS refunded,
              COALESCE(SUM(r.amount) FILTER (WHERE r.refund_method = 'cash'), 0) AS cash_refunded
       FROM refunds r
       WHERE r.restaurant_id = $1 AND r.business_day_id = ANY($2::bigint[])`,
      [restaurantId, dayIds]
    ),
    // The owner's named payment types (meal cards, cheques…) taken in the
    // days, each apart: what a meal-card company's settlement is checked by.
    pool.query(
      `SELECT p.payment_method, pt.id AS payment_type_id, pt.name AS payment_type_name,
              COALESCE(SUM(p.amount), 0) AS amount, COUNT(*)::int AS count
       FROM payments p
       JOIN payment_types pt ON pt.id = p.payment_type_id
       WHERE p.restaurant_id = $1 AND p.business_day_id = ANY($2::bigint[]) AND p.payment_status = 'success'
       GROUP BY p.payment_method, pt.id, pt.name
       ORDER BY p.payment_method, pt.name`,
      [restaurantId, dayIds]
    ),
    // Advances taken and handed back in the days: money held for guests,
    // not sales (it becomes a sale on the bill it is used on).
    pool.query(
      `SELECT COALESCE((SELECT SUM(a.amount) FROM customer_advances a
                        WHERE a.restaurant_id = $1 AND a.business_day_id = ANY($2::bigint[])), 0) AS advances_taken,
              COALESCE((SELECT SUM(a.amount) FROM customer_advances a
                        WHERE a.restaurant_id = $1 AND a.business_day_id = ANY($2::bigint[])
                          AND a.payment_method = 'cash'), 0) AS cash_advances,
              COALESCE((SELECT SUM(r.amount) FROM customer_advance_refunds r
                        WHERE r.restaurant_id = $1 AND r.business_day_id = ANY($2::bigint[])), 0) AS advances_returned,
              COALESCE((SELECT SUM(r.amount) FROM customer_advance_refunds r
                        WHERE r.restaurant_id = $1 AND r.business_day_id = ANY($2::bigint[])
                          AND r.refund_method = 'cash'), 0) AS cash_advances_returned`,
      [restaurantId, dayIds]
    ),
  ]);

  return {
    ...sales.rows[0],
    ...money.rows[0],
    ...refunds.rows[0],
    ...advances.rows[0],
    byMethod: byMethod.rows,
    byType: byType.rows,
  };
};

// Every business day open now in the restaurant (the main counter's and each
// outlet's own), with the outlet's name.
const findOpenDays = async (restaurantId) => {
  const result = await pool.query(
    `SELECT bd.id, bd.business_date, bd.outlet_id, bd.day_status, ol.name AS outlet_name
     FROM business_days bd
     LEFT JOIN outlets ol ON ol.id = bd.outlet_id
     WHERE bd.restaurant_id = $1 AND bd.day_status = 'open'
     ORDER BY bd.outlet_id NULLS FIRST, ol.name`,
    [restaurantId]
  );

  return result.rows;
};

// These business days, with the outlet each belongs to (none: the main
// counter's), for saying whose day the figures are.
const findDays = async (restaurantId, dayIds) => {
  if (dayIds.length === 0) {
    return [];
  }

  const result = await pool.query(
    `SELECT bd.id, bd.business_date, bd.outlet_id, bd.day_status, ol.name AS outlet_name
     FROM business_days bd
     LEFT JOIN outlets ol ON ol.id = bd.outlet_id
     WHERE bd.restaurant_id = $1 AND bd.id = ANY($2::bigint[])
     ORDER BY bd.outlet_id NULLS FIRST, ol.name`,
    [restaurantId, dayIds]
  );

  return result.rows;
};

// Credit notes issued in a period (by the business date they were issued in).
const findCreditNotes = async (restaurantId, { from, to, outletId, timezone, limit = 200, offset = 0 }) => {
  const result = await pool.query(
    `SELECT cn.id, cn.credit_note_number, cn.kind, cn.reason, cn.taxable_value, cn.service_charge_value,
            cn.tax_amount, cn.cess_amount, cn.round_off, cn.total_amount, cn.points_reversed, cn.issued_at,
            b.id AS bill_id, b.bill_number, r.refund_method, u.name AS created_by_name,
            COALESCE(bd.business_date, (cn.issued_at AT TIME ZONE $5)::date) AS business_date,
            COUNT(*) OVER ()::int AS total_count
     FROM credit_notes cn
     JOIN bills b ON b.id = cn.bill_id
     LEFT JOIN refunds r ON r.id = cn.refund_id
     LEFT JOIN users u ON u.id = cn.created_by
     LEFT JOIN business_days bd ON bd.id = cn.business_day_id
     WHERE cn.restaurant_id = $1
       AND ($2::date IS NULL OR COALESCE(bd.business_date, (cn.issued_at AT TIME ZONE $5)::date) >= $2::date)
       AND ($3::date IS NULL OR COALESCE(bd.business_date, (cn.issued_at AT TIME ZONE $5)::date) <= $3::date)
       AND ${outletScope("$4")}
     ORDER BY cn.issued_at DESC, cn.id DESC
     LIMIT $6 OFFSET $7`,
    [restaurantId, from || null, to || null, outletId || null, timezone || "Asia/Kolkata", limit, offset]
  );

  return { rows: result.rows, total: result.rows.length ? result.rows[0].total_count : 0 };
};

// The points a bill earned, and how many of them credit notes already took back.
const findEarnedPoints = async (client, billId) => {
  const result = await client.query(
    `SELECT COALESCE((SELECT SUM(points) FROM loyalty_transactions WHERE bill_id = $1 AND entry_type = 'earn'), 0)::int AS earned,
            COALESCE((SELECT SUM(points_reversed) FROM credit_notes WHERE bill_id = $1), 0)::int AS reversed`,
    [billId]
  );

  return result.rows[0];
};

const findBillTaxes = async (client, billId) =>
  (
    await client.query(
      `SELECT tax_percentage, cess_percentage, items_taxable, service_charge_taxable, taxable_value,
              cgst_amount, sgst_amount, service_charge_tax, cess_amount
       FROM bill_taxes WHERE bill_id = $1 ORDER BY tax_percentage, cess_percentage`,
      [billId]
    )
  ).rows;

// Each line with what it was billed at and how much of it is already returned.
const findReturnableLines = async (client, billId) =>
  (
    await (client || pool).query(
      `SELECT bi.id AS bill_item_id, bi.order_item_id, bi.quantity, bi.returned_quantity,
              bi.taxable_value, bi.service_charge_share, bi.tax_amount, bi.cess_amount,
              bi.tax_percentage, bi.cess_percentage, bi.line_subtotal, bi.line_tax,
              oi.tax_percentage AS order_tax_percentage, oi.item_name
       FROM bill_items bi
       JOIN order_items oi ON oi.id = bi.order_item_id
       WHERE bi.bill_id = $1
       ORDER BY bi.id`,
      [billId]
    )
  ).rows;

module.exports = {
  findAll,
  findHeader,
  findById,
  nextNumber,
  deliveryChargedElsewhere,
  findBillableItems,
  findLinesForPricing,
  recordPrint,
  create,
  reprice,
  addPayment,
  applyPayment,
  openDayOfTill,
  accountRoom,
  accountRoomNow,
  dueAt,
  closeOrderIfDone,
  dueOf,
  addRefund,
  correctPayment,
  correctionProblem,
  findPayment,
  findCorrections,
  voidBill,
  daySummary,
  findOpenDays,
  findDays,
  findCreditNotes,
  findEarnedPoints,
  findBillTaxes,
  findReturnableLines,
};
