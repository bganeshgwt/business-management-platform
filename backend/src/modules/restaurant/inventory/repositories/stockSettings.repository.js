const pool = require("../../../../config/database");

// Settings → Stock & purchasing: the approval limits and how transfers are
// received. One row per restaurant, made the first time the screen is saved;
// until then every limit is blank (no approval needed) and transfers land at
// once, which is how the app has always behaved.
const DEFAULTS = {
  po_approval_limit: null,
  writeoff_approval_limit: null,
  transfer_receipt_required: false,
  updated_at: null,
  updated_by_name: null,
};

const find = async (restaurantId, client = pool) => {
  const result = await client.query(
    `SELECT s.po_approval_limit, s.writeoff_approval_limit, s.transfer_receipt_required,
            s.updated_at, u.name AS updated_by_name
     FROM stock_settings s
     LEFT JOIN users u ON u.id = s.updated_by
     WHERE s.restaurant_id = $1`,
    [restaurantId]
  );

  return result.rows[0] || { ...DEFAULTS };
};

const save = async (restaurantId, data, userId) => {
  await pool.query(
    `INSERT INTO stock_settings (restaurant_id, po_approval_limit, writeoff_approval_limit,
                                 transfer_receipt_required, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (restaurant_id) DO UPDATE
       SET po_approval_limit = EXCLUDED.po_approval_limit,
           writeoff_approval_limit = EXCLUDED.writeoff_approval_limit,
           transfer_receipt_required = EXCLUDED.transfer_receipt_required,
           updated_by = EXCLUDED.updated_by`,
    [restaurantId, data.poApprovalLimit, data.writeoffApprovalLimit, data.transferReceiptRequired, userId]
  );

  return find(restaurantId);
};

module.exports = { find, save };
