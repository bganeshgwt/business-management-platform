const pool = require("../../../../config/database");

const COLUMNS = `id, code, name, description, discount_type, value, max_discount_amount,
                 min_order_amount, valid_from, valid_to, usage_limit, used_count,
                 applies_to, status, offer_type, product_ids, category_ids, weekdays,
                 to_char(time_from, 'HH24:MI') AS time_from, to_char(time_to, 'HH24:MI') AS time_to,
                 once_per_guest, buy_quantity, get_quantity, get_discount_percent`;

// With what each offer has given so far (bills not voided): the owner's view
// of which rules are used and what they cost.
const findAll = async (restaurantId, db = pool) => {
  const result = await db.query(
    `SELECT ${COLUMNS},
            (SELECT COUNT(*) FROM bills b
             WHERE b.restaurant_id = d.restaurant_id AND b.discount_id = d.id AND b.bill_status <> 'void')::int AS bill_count,
            (SELECT COALESCE(SUM(b.coupon_discount), 0) FROM bills b
             WHERE b.restaurant_id = d.restaurant_id AND b.discount_id = d.id AND b.bill_status <> 'void') AS discount_given
     FROM discounts d WHERE d.restaurant_id = $1 ORDER BY d.status, d.code`,
    [restaurantId]
  );

  return result.rows;
};

// Dishes and categories of this restaurant among the ids given, for checking
// an offer's chosen dishes (another restaurant's ids are simply not found).
const findMenuNames = async (restaurantId, productIds, categoryIds) => {
  const [products, categories] = await Promise.all([
    productIds && productIds.length
      ? pool.query("SELECT id, name FROM products WHERE restaurant_id = $1 AND id = ANY($2::bigint[])", [restaurantId, productIds])
      : { rows: [] },
    categoryIds && categoryIds.length
      ? pool.query("SELECT id, name FROM categories WHERE restaurant_id = $1 AND id = ANY($2::bigint[])", [
          restaurantId,
          categoryIds,
        ])
      : { rows: [] },
  ]);

  return { products: products.rows, categories: categories.rows };
};

// The guest's earlier bill with this offer (not voided), for "once per guest".
const findGuestUse = async (restaurantId, discountId, customerId, exceptBillId = null, db = pool) => {
  const result = await db.query(
    `SELECT b.bill_number FROM bills b
     JOIN orders o ON o.id = b.order_id
     WHERE b.restaurant_id = $1 AND b.discount_id = $2 AND o.customer_id = $3
       AND b.bill_status <> 'void' AND ($4::bigint IS NULL OR b.id <> $4)
     ORDER BY b.id
     LIMIT 1`,
    [restaurantId, discountId, customerId, exceptBillId]
  );

  return result.rows[0] || null;
};

const findById = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM discounts d WHERE restaurant_id = $1 AND id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// The offer's rules (SW-B-17), in the order the inserts and updates take them.
const ruleValues = (data) => [
  data.offerType || "discount",
  data.productIds && data.productIds.length ? data.productIds : null,
  data.categoryIds && data.categoryIds.length ? data.categoryIds : null,
  data.weekdays && data.weekdays.length ? data.weekdays : null,
  data.timeFrom || null,
  data.timeTo || null,
  Boolean(data.oncePerGuest),
  data.offerType === "buy_get" ? data.buyQuantity : null,
  data.offerType === "buy_get" ? data.getQuantity : null,
  data.offerType === "buy_get" ? data.getDiscountPercent : null,
];

const create = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO discounts (restaurant_id, code, name, description, discount_type, value,
                            max_discount_amount, min_order_amount, valid_from, valid_to,
                            usage_limit, applies_to, status, created_by, updated_by,
                            offer_type, product_ids, category_ids, weekdays, time_from, time_to,
                            once_per_guest, buy_quantity, get_quantity, get_discount_percent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14,
             $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
     RETURNING ${COLUMNS}`,
    [
      restaurantId,
      data.code,
      data.name,
      data.description,
      data.discountType,
      data.value,
      data.maxDiscountAmount,
      data.minOrderAmount,
      data.validFrom,
      data.validTo,
      data.usageLimit,
      data.appliesTo,
      data.status,
      userId,
      ...ruleValues(data),
    ]
  );

  return result.rows[0];
};

const update = async (restaurantId, id, data, userId) => {
  const result = await pool.query(
    `UPDATE discounts
     SET name = $3, description = $4, discount_type = $5, value = $6, max_discount_amount = $7,
         min_order_amount = $8, valid_from = $9, valid_to = $10, usage_limit = $11,
         applies_to = $12, status = $13, updated_by = $14,
         offer_type = $15, product_ids = $16, category_ids = $17, weekdays = $18, time_from = $19,
         time_to = $20, once_per_guest = $21, buy_quantity = $22, get_quantity = $23, get_discount_percent = $24
     WHERE restaurant_id = $1 AND id = $2
     RETURNING ${COLUMNS}`,
    [
      restaurantId,
      id,
      data.name,
      data.description,
      data.discountType,
      data.value,
      data.maxDiscountAmount,
      data.minOrderAmount,
      data.validFrom,
      data.validTo,
      data.usageLimit,
      data.appliesTo,
      data.status,
      userId,
      ...ruleValues(data),
    ]
  );

  return result.rows[0] || null;
};

const remove = async (restaurantId, id) => {
  const result = await pool.query(
    "DELETE FROM discounts WHERE restaurant_id = $1 AND id = $2 RETURNING id",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// Discounts given at the till (on the bill or on single dishes) and
// no-charge bills, in a period of business dates: the owner's list of what
// was given away, by whom, approved by whom and why. Void bills gave nothing.
// A page at a time when the screen pages (limit and offset); left out, the
// 500 most recent (older callers). outletId: that outlet's bills only (the
// outlet in the top bar, or the one a person is tied to); null, the whole
// restaurant.
const findGiven = async (restaurantId, { from, to, timezone, limit = 500, offset = 0, outletId = null }) => {
  const result = await pool.query(
    `SELECT b.id AS bill_id, b.bill_number, b.billed_at, b.bill_status, b.subtotal, b.total_amount,
            COALESCE(bd.business_date, (b.billed_at AT TIME ZONE $4)::date) AS business_date,
            CASE WHEN b.is_complimentary THEN 'complimentary' ELSE 'discount' END AS kind,
            CASE WHEN b.is_complimentary THEN b.subtotal
                 ELSE b.manual_discount_amount + b.item_discount_amount END AS amount,
            b.manual_discount_type, b.manual_discount_value, b.item_discount_amount,
            CASE WHEN b.is_complimentary THEN b.complimentary_reason ELSE b.discount_reason END AS reason,
            CASE WHEN b.is_complimentary THEN b.complimentary_note ELSE b.discount_note END AS note,
            gu.name AS given_by, au.name AS approved_by,
            o.order_number, o.order_type, o.customer_name, t.table_no
     FROM bills b
     JOIN orders o ON o.id = b.order_id
     LEFT JOIN dining_tables t ON t.id = o.table_id
     LEFT JOIN business_days bd ON bd.id = b.business_day_id
     LEFT JOIN users gu ON gu.id = CASE WHEN b.is_complimentary THEN b.complimentary_by ELSE b.discount_given_by END
     LEFT JOIN users au ON au.id = CASE WHEN b.is_complimentary THEN b.complimentary_approved_by ELSE b.discount_approved_by END
     WHERE b.restaurant_id = $1
       AND b.bill_status <> 'void'
       AND (b.is_complimentary OR b.manual_discount_amount + b.item_discount_amount > 0)
       AND COALESCE(bd.business_date, (b.billed_at AT TIME ZONE $4)::date) BETWEEN $2::date AND $3::date
       AND ($7::bigint IS NULL OR b.outlet_id = $7::bigint)
     ORDER BY b.billed_at DESC, b.id DESC
     LIMIT $5 OFFSET $6`,
    [restaurantId, from, to, timezone || "Asia/Kolkata", limit, offset, outletId || null]
  );

  return result.rows;
};

// The same, added up by reason and by the person who gave it — over the
// whole period, however long the list is.
const findGivenTotals = async (restaurantId, { from, to, timezone, outletId = null }) => {
  const result = await pool.query(
    `WITH given AS (
       SELECT CASE WHEN b.is_complimentary THEN 'complimentary' ELSE 'discount' END AS kind,
              CASE WHEN b.is_complimentary THEN b.subtotal
                   ELSE b.manual_discount_amount + b.item_discount_amount END AS amount,
              CASE WHEN b.is_complimentary THEN b.complimentary_reason ELSE b.discount_reason END AS reason,
              COALESCE(gu.name, 'Unknown') AS given_by,
              (CASE WHEN b.is_complimentary THEN b.complimentary_approved_by ELSE b.discount_approved_by END) IS NOT NULL
                AS approved
       FROM bills b
       LEFT JOIN business_days bd ON bd.id = b.business_day_id
       LEFT JOIN users gu ON gu.id = CASE WHEN b.is_complimentary THEN b.complimentary_by ELSE b.discount_given_by END
       WHERE b.restaurant_id = $1
         AND b.bill_status <> 'void'
         AND (b.is_complimentary OR b.manual_discount_amount + b.item_discount_amount > 0)
         AND COALESCE(bd.business_date, (b.billed_at AT TIME ZONE $4)::date) BETWEEN $2::date AND $3::date
         AND ($5::bigint IS NULL OR b.outlet_id = $5::bigint)
     )
     SELECT 'reason' AS grouping, kind, reason AS label, COUNT(*)::int AS bills, SUM(amount) AS amount,
            COUNT(*) FILTER (WHERE approved)::int AS approved
     FROM given GROUP BY kind, reason
     UNION ALL
     SELECT 'staff', kind, given_by, COUNT(*)::int, SUM(amount), COUNT(*) FILTER (WHERE approved)::int
     FROM given GROUP BY kind, given_by
     ORDER BY 5 DESC`,
    [restaurantId, from, to, timezone || "Asia/Kolkata", outletId || null]
  );

  return result.rows;
};

module.exports = {
  findMenuNames,
  findGuestUse,
  findGiven,
  findGivenTotals,
  findAll,
  findById,
  create,
  update,
  remove,
};
