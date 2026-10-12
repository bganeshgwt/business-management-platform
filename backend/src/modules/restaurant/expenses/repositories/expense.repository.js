const pool = require("../../../../config/database");

// --- Expense categories ---

const findCategories = async (restaurantId) => {
  const result = await pool.query(
    `SELECT ec.id, ec.name, ec.description, ec.status,
            COUNT(e.id)::int AS expense_count
     FROM expense_categories ec
     LEFT JOIN expenses e ON e.expense_category_id = ec.id
     WHERE ec.restaurant_id = $1
     GROUP BY ec.id
     ORDER BY ec.name`,
    [restaurantId]
  );

  return result.rows;
};

const findCategoryById = async (restaurantId, id) => {
  const result = await pool.query(
    "SELECT id, name, description, status FROM expense_categories WHERE restaurant_id = $1 AND id = $2",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

const createCategory = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO expense_categories (restaurant_id, name, description, status, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $5)
     RETURNING id, name, description, status`,
    [restaurantId, data.name, data.description, data.status, userId]
  );

  return result.rows[0];
};

const updateCategory = async (restaurantId, id, data, userId) => {
  const result = await pool.query(
    `UPDATE expense_categories SET name = $3, description = $4, status = $5, updated_by = $6
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id, name, description, status`,
    [restaurantId, id, data.name, data.description, data.status, userId]
  );

  return result.rows[0] || null;
};

const countCategoryExpenses = async (categoryId) => {
  const result = await pool.query(
    "SELECT COUNT(*)::int AS count FROM expenses WHERE expense_category_id = $1",
    [categoryId]
  );

  return result.rows[0].count;
};

const removeCategory = async (restaurantId, id) => {
  const result = await pool.query(
    "DELETE FROM expense_categories WHERE restaurant_id = $1 AND id = $2 RETURNING id",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// --- Expenses ---

// The business day whose drawer an expense of this outlet and date comes out
// of: the outlet's own day of that date when it traded one, otherwise the
// main counter's — the rule the day-end sheet uses (report.repository
// EXPENSE_OF_DRAWER), so the expense screen and the drawer never disagree.
const DRAWER_DAY = (e) => `(SELECT bd.id FROM business_days bd
      WHERE bd.restaurant_id = ${e}.restaurant_id AND bd.business_date = ${e}.expense_date
        AND (bd.outlet_id = ${e}.outlet_id
             OR (bd.outlet_id IS NULL AND NOT EXISTS (
                   SELECT 1 FROM business_days ox
                   WHERE ox.restaurant_id = ${e}.restaurant_id AND ox.outlet_id = ${e}.outlet_id
                     AND ox.business_date = ${e}.expense_date)))
      ORDER BY bd.outlet_id NULLS LAST LIMIT 1)`;

const EXPENSE_COLUMNS = `e.id, e.outlet_id, (SELECT name FROM outlets WHERE id=e.outlet_id) AS outlet_name,
                         e.expense_category_id, e.supplier_id, e.expense_date, e.amount,
                         e.payment_mode, e.reference_no, e.notes, e.expense_status,
                         e.approved_at, e.created_at,
                         dd.id AS drawer_day_id, dd.day_status AS drawer_day_status,
                         (SELECT cm.id FROM cash_movements cm WHERE cm.expense_id = e.id LIMIT 1) AS movement_id,
                         (SELECT COUNT(*)::int FROM document_attachments da
                          WHERE da.restaurant_id = e.restaurant_id AND da.entity_type = 'expense'
                            AND da.entity_id = e.id AND da.removed_at IS NULL) AS attachment_count`;

const DRAWER_JOIN = `LEFT JOIN business_days dd ON dd.id = ${DRAWER_DAY("e")}`;

// The filters every list query shares (status, category, dates, outlet), so
// a page of rows and the count of all of them can never disagree.
const LIST_WHERE = `e.restaurant_id = $1
       AND ($2::text IS NULL OR e.expense_status = $2)
       AND ($3::bigint IS NULL OR e.expense_category_id = $3)
       AND ($4::date IS NULL OR e.expense_date >= $4)
       AND ($5::date IS NULL OR e.expense_date <= $5)
       AND ($6::bigint IS NULL OR e.outlet_id = $6)`;

const listParams = (restaurantId, filters) => [
  restaurantId,
  filters.status || null,
  filters.categoryId || null,
  filters.from || null,
  filters.to || null,
  filters.outletId || null,
];

// Newest first. With a page asked for (the Expenses screen pages them), one
// page of pageSize rows; without one (older callers), the 300 most recent.
const findAll = async (restaurantId, filters = {}) => {
  const paged = Boolean(filters.pageSize);
  const limit = paged ? filters.pageSize : 300;
  const offset = paged ? (Math.max(1, filters.page || 1) - 1) * filters.pageSize : 0;
  const result = await pool.query(
    `SELECT ${EXPENSE_COLUMNS},
            ec.name AS category_name, s.name AS supplier_name,
            a.name AS approved_by_name, cr.name AS created_by_name
     FROM expenses e
     JOIN expense_categories ec ON ec.id = e.expense_category_id
     LEFT JOIN suppliers s ON s.id = e.supplier_id
     LEFT JOIN users a ON a.id = e.approved_by
     LEFT JOIN users cr ON cr.id = e.created_by
     ${DRAWER_JOIN}
     WHERE ${LIST_WHERE}
     ORDER BY e.expense_date DESC, e.id DESC
     LIMIT $7 OFFSET $8`,
    [...listParams(restaurantId, filters), limit, offset]
  );

  return result.rows;
};

// How many expenses the filters match in all (the pager's "of 312").
const countAll = async (restaurantId, filters = {}) => {
  const result = await pool.query(`SELECT COUNT(*)::int AS total FROM expenses e WHERE ${LIST_WHERE}`, listParams(restaurantId, filters));

  return result.rows[0].total;
};

const findById = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT ${EXPENSE_COLUMNS}, ec.name AS category_name, s.name AS supplier_name,
            a.name AS approved_by_name, cr.name AS created_by_name
     FROM expenses e
     JOIN expense_categories ec ON ec.id = e.expense_category_id
     LEFT JOIN suppliers s ON s.id = e.supplier_id
     LEFT JOIN users a ON a.id = e.approved_by
     LEFT JOIN users cr ON cr.id = e.created_by
     ${DRAWER_JOIN}
     WHERE e.restaurant_id = $1 AND e.id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// The business day whose drawer cash of this outlet (null: shared) and date
// comes out of, or null when no day was opened on that date.
const findDrawerDay = async (restaurantId, outletId, expenseDate) => {
  const result = await pool.query(
    `SELECT bd.id, bd.business_date, bd.day_status, bd.outlet_id
     FROM business_days bd
     WHERE bd.restaurant_id = $1 AND bd.business_date = $3::date
       AND (bd.outlet_id = $2::bigint
            OR (bd.outlet_id IS NULL AND NOT EXISTS (
                  SELECT 1 FROM business_days ox
                  WHERE ox.restaurant_id = $1 AND ox.outlet_id = $2::bigint AND ox.business_date = $3::date)))
     ORDER BY bd.outlet_id NULLS LAST
     LIMIT 1`,
    [restaurantId, outletId || null, expenseDate]
  );

  return result.rows[0] || null;
};

// Petty cash paid from a drawer: written approved at once, because the cash
// has already left the drawer and the person recording it was allowed to
// move cash (or a manager's PIN allowed it). Inside the caller's transaction.
const createApproved = async (client, restaurantId, data, userId, approverId) => {
  const result = await client.query(
    `INSERT INTO expenses (restaurant_id, expense_category_id, supplier_id, expense_date,
                           amount, payment_mode, reference_no, notes, expense_status,
                           approved_by, approved_at, created_by, updated_by, outlet_id)
     VALUES ($1, $2, NULL, $3, $4, 'cash', NULL, $5, 'approved', $6, NOW(), $7, $7, $8)
     RETURNING id`,
    [restaurantId, data.expenseCategoryId, data.expenseDate, data.amount, data.notes, approverId || userId, userId, data.outletId || null]
  );

  return result.rows[0].id;
};

// A petty cash expense whose movement was cancelled: rejected, so it stays on
// record but out of the accounts and the drawer.
const rejectInTransaction = async (client, restaurantId, id, userId) => {
  await client.query(
    `UPDATE expenses SET expense_status = 'rejected', approved_by = NULL, approved_at = NULL, updated_by = $3
     WHERE restaurant_id = $1 AND id = $2`,
    [restaurantId, id, userId]
  );
};

// "Petty cash", the category a drawer's petty cash goes under when the
// person paying it did not pick one; made the first time it is needed.
const findOrCreatePettyCategory = async (client, restaurantId, userId) => {
  const found = await client.query(
    "SELECT id FROM expense_categories WHERE restaurant_id = $1 AND LOWER(name) = 'petty cash' LIMIT 1",
    [restaurantId]
  );

  if (found.rows.length) {
    return found.rows[0].id;
  }

  const made = await client.query(
    `INSERT INTO expense_categories (restaurant_id, name, description, status, created_by, updated_by)
     VALUES ($1, 'Petty cash', 'Small cash paid from the drawer: ice, an auto, a quick repair', 'active', $2, $2)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [restaurantId, userId]
  );

  if (made.rows.length) {
    return made.rows[0].id;
  }

  const again = await client.query(
    "SELECT id FROM expense_categories WHERE restaurant_id = $1 AND LOWER(name) = 'petty cash' LIMIT 1",
    [restaurantId]
  );

  return again.rows[0].id;
};

// Cash expenses of a drawer's day still waiting for approval: their cash has
// left the drawer but the drawer does not count it yet, so the day cannot be
// closed until each is approved or rejected.
const findPendingCashOfDay = async (restaurantId, day) => {
  const result = await pool.query(
    `SELECT e.id, e.amount, e.notes, ec.name AS category_name
     FROM expenses e
     JOIN expense_categories ec ON ec.id = e.expense_category_id
     JOIN business_days bd ON bd.id = $2
     WHERE e.restaurant_id = $1 AND e.expense_status = 'pending' AND e.payment_mode = 'cash'
       AND e.expense_date = bd.business_date
       AND (CASE WHEN bd.outlet_id IS NOT NULL THEN e.outlet_id = bd.outlet_id
                 ELSE (e.outlet_id IS NULL
                       OR NOT EXISTS (SELECT 1 FROM business_days ox
                                      WHERE ox.restaurant_id = bd.restaurant_id AND ox.outlet_id = e.outlet_id
                                        AND ox.business_date = bd.business_date))
            END)
     ORDER BY e.id`,
    [restaurantId, day.id]
  );

  return result.rows;
};

const create = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO expenses (restaurant_id, expense_category_id, supplier_id, expense_date,
                           amount, payment_mode, reference_no, notes, expense_status,
                           created_by, updated_by, outlet_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $9, $10)
     RETURNING id`,
    [
      restaurantId,
      data.expenseCategoryId,
      data.supplierId,
      data.expenseDate,
      data.amount,
      data.paymentMode,
      data.referenceNo,
      data.notes,
      userId,
      data.outletId || null,
    ]
  );

  return findById(restaurantId, result.rows[0].id);
};

// Only a pending expense can be edited: approved ones are part of the accounts.
const update = async (restaurantId, id, data, userId) => {
  const result = await pool.query(
    `UPDATE expenses
     SET expense_category_id = $3, supplier_id = $4, expense_date = $5, amount = $6,
         payment_mode = $7, reference_no = $8, notes = $9, updated_by = $10
     WHERE restaurant_id = $1 AND id = $2 AND expense_status = 'pending'
     RETURNING id`,
    [
      restaurantId,
      id,
      data.expenseCategoryId,
      data.supplierId,
      data.expenseDate,
      data.amount,
      data.paymentMode,
      data.referenceNo,
      data.notes,
      userId,
    ]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return findById(restaurantId, id);
};

const setStatus = async (restaurantId, id, status, userId) => {
  const result = await pool.query(
    // $3 is both stored and compared, so it is cast the same way in each place;
    // otherwise PostgreSQL deduces two different types for one parameter.
    `UPDATE expenses
     SET expense_status = $3::varchar,
         approved_by = CASE WHEN $3::varchar = 'approved' THEN $4::bigint ELSE NULL END,
         approved_at = CASE WHEN $3::varchar = 'approved' THEN NOW() ELSE NULL END,
         updated_by = $4::bigint
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id`,
    [restaurantId, id, status, userId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return findById(restaurantId, id);
};

// "Approve selected": several waiting expenses in ONE transaction. The rows
// are locked first; `check(rows)` (the service's rules) sees them as they are
// now and throws to refuse the lot. Either every one is approved or none.
const approveMany = async (restaurantId, ids, userId, check) => {
  const client = await pool.connect();
  const select = `SELECT ${EXPENSE_COLUMNS}, ec.name AS category_name, s.name AS supplier_name,
            a.name AS approved_by_name, cr.name AS created_by_name
     FROM expenses e
     JOIN expense_categories ec ON ec.id = e.expense_category_id
     LEFT JOIN suppliers s ON s.id = e.supplier_id
     LEFT JOIN users a ON a.id = e.approved_by
     LEFT JOIN users cr ON cr.id = e.created_by
     ${DRAWER_JOIN}
     WHERE e.restaurant_id = $1 AND e.id = ANY($2::bigint[])
     ORDER BY e.id`;

  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM expenses WHERE restaurant_id = $1 AND id = ANY($2::bigint[]) ORDER BY id FOR UPDATE", [
      restaurantId,
      ids,
    ]);

    const before = (await client.query(select, [restaurantId, ids])).rows;
    check(before);

    await client.query(
      `UPDATE expenses
       SET expense_status = 'approved', approved_by = $3, approved_at = NOW(), updated_by = $3
       WHERE restaurant_id = $1 AND id = ANY($2::bigint[]) AND expense_status = 'pending'`,
      [restaurantId, ids, userId]
    );

    const after = (await client.query(select, [restaurantId, ids])).rows;

    await client.query("COMMIT");
    return { before, after };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const remove = async (restaurantId, id) => {
  const result = await pool.query(
    "DELETE FROM expenses WHERE restaurant_id = $1 AND id = $2 AND expense_status = 'pending' RETURNING id",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// Totals for the cards at the top of the expenses screen.
const summary = async (restaurantId, filters = {}) => {
  const result = await pool.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE expense_status = 'approved' AND in_range), 0) AS approved_total,
            COALESCE(SUM(amount) FILTER (WHERE expense_status = 'pending' AND in_range), 0) AS pending_total,
            COUNT(*) FILTER (WHERE expense_status = 'pending' AND in_range)::int AS pending_count,
            -- Waiting on any day: the screen opens on today, and an entry
            -- left from last week still needs someone to decide on it.
            COUNT(*) FILTER (WHERE expense_status = 'pending')::int AS waiting_count,
            COALESCE(SUM(amount) FILTER (WHERE expense_status = 'pending'), 0) AS waiting_total
     FROM (SELECT amount, expense_status,
                  ($2::date IS NULL OR expense_date >= $2) AND ($3::date IS NULL OR expense_date <= $3) AS in_range
           FROM expenses
           WHERE restaurant_id = $1
             AND ($4::bigint IS NULL OR outlet_id = $4)) e`,
    [restaurantId, filters.from || null, filters.to || null, filters.outletId || null]
  );

  return result.rows[0];
};

module.exports = {
  findCategories,
  findCategoryById,
  createCategory,
  updateCategory,
  countCategoryExpenses,
  removeCategory,
  findAll,
  countAll,
  findById,
  findDrawerDay,
  findPendingCashOfDay,
  findOrCreatePettyCategory,
  createApproved,
  rejectInTransaction,
  create,
  update,
  setStatus,
  approveMany,
  remove,
  summary,
};
