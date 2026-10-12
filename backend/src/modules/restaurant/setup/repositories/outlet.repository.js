const pool = require("../../../../config/database");

const COLUMNS = `id, restaurant_id, name, code, contact, address, gst_number, order_prefix, invoice_prefix, status, own_store,
  fssai_number, upi_vpa, upi_payee_name, created_at, updated_at`;

// Every query filters by restaurant_id: one restaurant can never see another's outlets.
const findAll = async (restaurantId) => {
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM outlets WHERE restaurant_id = $1 ORDER BY name`,
    [restaurantId]
  );

  return result.rows;
};

const findById = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM outlets WHERE restaurant_id = $1 AND id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

const create = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO outlets (restaurant_id, name, code, contact, address, gst_number, order_prefix, invoice_prefix, status, created_by, updated_by,
                          fssai_number, upi_vpa, upi_payee_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12, $13)
     RETURNING ${COLUMNS}`,
    [restaurantId, data.name, data.code, data.contact, data.address, data.gstNumber || null,
      data.orderPrefix || null, data.invoicePrefix || null, data.status, userId,
      data.fssaiNumber || null, data.upiVpa || null, data.upiPayeeName || null]
  );

  return result.rows[0];
};

const update = async (restaurantId, id, data, userId) => {
  const result = await pool.query(
    `UPDATE outlets
     SET name = $3, code = $4, contact = $5, address = $6,
         gst_number = CASE WHEN $12::boolean THEN $7 ELSE gst_number END,
         order_prefix = $8, invoice_prefix = $9, status = $10, updated_by = $11,
         -- Not sent (an older screen): what is on file is kept.
         fssai_number = CASE WHEN $13::boolean THEN $14 ELSE fssai_number END,
         upi_vpa = CASE WHEN $15::boolean THEN $16 ELSE upi_vpa END,
         upi_payee_name = CASE WHEN $15::boolean THEN $17 ELSE upi_payee_name END
     WHERE restaurant_id = $1 AND id = $2
     RETURNING ${COLUMNS}`,
    [
      restaurantId,
      id,
      data.name,
      data.code,
      data.contact,
      data.address,
      data.gstNumber || null,
      data.orderPrefix || null,
      data.invoicePrefix || null,
      data.status,
      userId,
      data.gstNumber !== undefined,
      data.fssaiNumber !== undefined,
      data.fssaiNumber || null,
      data.upiVpa !== undefined,
      data.upiVpa || null,
      data.upiPayeeName || null,
    ]
  );

  return result.rows[0] || null;
};

const countUsers = async (outletId) => {
  const result = await pool.query("SELECT COUNT(*)::int AS count FROM users WHERE outlet_id = $1", [
    outletId,
  ]);

  return result.rows[0].count;
};

// What still points at an outlet, in two kinds.
//
//   history  sales, stock and money already recorded there. It can never be
//            moved or deleted — the accounts and the GST return depend on it
//            — so an outlet with any of it is closed (made inactive), never
//            deleted.
//   setup    people, tables and floors arranged there. These can be moved
//            to another outlet, after which the outlet can go.
//
// Counted per table so the screen can say what is in the way ("1,204 bills,
// 3 tables") instead of a database error — each with its word for one and
// for many, because "1 orders, 1 bills" is what a new outlet's owner reads.
const HISTORY = [
  ["orders", "order", "orders"],
  ["bills", "bill", "bills"],
  ["business_days", "business day", "business days"],
  ["stock_transactions", "stock movement", "stock movements"],
  ["purchase_orders", "purchase order", "purchase orders"],
  ["goods_receipts", "supplier bill", "supplier bills"],
  ["stock_counts", "stock count", "stock counts"],
  ["expenses", "expense", "expenses"],
  ["kots", "kitchen ticket", "kitchen tickets"],
  ["reservations", "reservation", "reservations"],
  ["waitlist_entries", "waitlist entry", "waitlist entries"],
  ["table_requests", "table request", "table requests"],
  ["complaints", "complaint", "complaints"],
  ["feedback", "feedback entry", "feedback entries"],
];

const SETUP = [
  ["users", "sign-in", "sign-ins"],
  ["employees", "member of staff", "staff"],
  ["dining_tables", "table", "tables"],
  ["floors", "floor", "floors"],
  ["shifts", "shift", "shifts"],
];

// Stock still on the outlet's shelf would vanish with it (the balance row is
// removed along with the outlet), so it counts as history too.
const usage = async (restaurantId, outletId) => {
  const count = (table) =>
    `(SELECT COUNT(*) FROM ${table} WHERE outlet_id = $2 AND restaurant_id = $1)::int AS "${table}"`;

  const result = await pool.query(
    `SELECT ${[...HISTORY, ...SETUP].map(([table]) => count(table)).join(",\n            ")},
            (SELECT COUNT(*) FROM stock_balances
             WHERE outlet_id = $2 AND restaurant_id = $1 AND quantity <> 0)::int AS stock_on_hand,
            (SELECT MAX(billed_at) FROM bills WHERE outlet_id = $2 AND restaurant_id = $1) AS last_bill_at`,
    [restaurantId, outletId]
  );

  const row = result.rows[0];
  const listOf = (tables) =>
    tables
      .map(([table, one, many]) => ({ table, label: row[table] === 1 ? one : many, count: row[table] }))
      .filter((item) => item.count > 0);

  const history = listOf(HISTORY);

  if (row.stock_on_hand > 0) {
    history.push({
      table: "stock_balances",
      label: row.stock_on_hand === 1 ? "item still in stock" : "items still in stock",
      count: row.stock_on_hand,
    });
  }

  return { history, setup: listOf(SETUP), lastBillAt: row.last_bill_at };
};

const remove = async (restaurantId, id) => {
  const result = await pool.query(
    "DELETE FROM outlets WHERE restaurant_id = $1 AND id = $2 RETURNING id",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

module.exports = {
  findAll,
  findById,
  create,
  update,
  countUsers,
  usage,
  remove,
};
