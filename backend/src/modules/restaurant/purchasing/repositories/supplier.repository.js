const pool = require("../../../../config/database");

const COLUMNS = `id, name, code, contact_person, mobile, email, address, gst_number,
                 payment_terms, credit_days, status`;

const findAll = async (restaurantId) => {
  const result = await pool.query(
    `SELECT s.id, s.name, s.code, s.contact_person, s.mobile, s.email, s.address,
            s.gst_number, s.payment_terms, s.credit_days, s.status,
            (SELECT COUNT(*)::int FROM purchase_orders po WHERE po.supplier_id = s.id) AS order_count,
            (SELECT COUNT(*)::int FROM goods_receipts gr
              WHERE gr.supplier_id = s.id AND gr.receipt_status = 'posted') AS bill_count,
            (SELECT MAX(gr.bill_date) FROM goods_receipts gr
              WHERE gr.supplier_id = s.id AND gr.receipt_status = 'posted') AS last_bill_date
     FROM suppliers s
     WHERE s.restaurant_id = $1
     ORDER BY s.name`,
    [restaurantId]
  );

  return result.rows;
};

const findById = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM suppliers WHERE restaurant_id = $1 AND id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

const create = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO suppliers (restaurant_id, name, code, contact_person, mobile, email,
                            address, gst_number, payment_terms, status, created_by, updated_by,
                            credit_days)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12)
     RETURNING ${COLUMNS}`,
    [
      restaurantId,
      data.name,
      data.code,
      data.contactPerson,
      data.mobile,
      data.email,
      data.address,
      data.gstNumber,
      data.paymentTerms,
      data.status,
      userId,
      data.creditDays ?? null,
    ]
  );

  return result.rows[0];
};

const update = async (restaurantId, id, data, userId) => {
  const result = await pool.query(
    `UPDATE suppliers
     SET name = $3, code = $4, contact_person = $5, mobile = $6, email = $7,
         address = $8, gst_number = $9, payment_terms = $10, status = $11, updated_by = $12,
         credit_days = $13
     WHERE restaurant_id = $1 AND id = $2
     RETURNING ${COLUMNS}`,
    [
      restaurantId,
      id,
      data.name,
      data.code,
      data.contactPerson,
      data.mobile,
      data.email,
      data.address,
      data.gstNumber,
      data.paymentTerms,
      data.status,
      userId,
      data.creditDays ?? null,
    ]
  );

  return result.rows[0] || null;
};

// Everything that records goods or money with this supplier. Any of it keeps
// the supplier on the books: deleting them would orphan the history (and the
// database refuses anyway, which used to surface as a bare server error).
const countHistory = async (restaurantId, supplierId) => {
  const result = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM purchase_orders WHERE restaurant_id = $1 AND supplier_id = $2) AS orders,
       (SELECT COUNT(*)::int FROM goods_receipts WHERE restaurant_id = $1 AND supplier_id = $2) AS bills,
       (SELECT COUNT(*)::int FROM purchase_returns WHERE restaurant_id = $1 AND supplier_id = $2) AS returns,
       (SELECT COUNT(*)::int FROM supplier_payments WHERE restaurant_id = $1 AND supplier_id = $2) AS payments,
       (SELECT COUNT(*)::int FROM expenses WHERE restaurant_id = $1 AND supplier_id = $2) AS expenses`,
    [restaurantId, supplierId]
  );

  return result.rows[0];
};

const remove = async (restaurantId, id) => {
  const result = await pool.query(
    "DELETE FROM suppliers WHERE restaurant_id = $1 AND id = $2 RETURNING id",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

module.exports = {
  findAll,
  findById,
  create,
  update,
  countHistory,
  remove,
};
