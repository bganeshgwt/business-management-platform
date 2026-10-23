const pool = require("../../../config/database");

// Audit writing must never break the action being recorded, so failures are
// logged and swallowed rather than thrown.
const record = async (entry, db = pool) => {
  try {
    await db.query(
      `INSERT INTO audit_logs (restaurant_id, user_id, user_name, action, entity_type,
                               entity_id, entity_label, details, approved_by, approver_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        entry.restaurantId,
        entry.userId || null,
        entry.userName || null,
        entry.action,
        entry.entityType,
        entry.entityId || null,
        entry.entityLabel || null,
        entry.details ? JSON.stringify(entry.details) : null,
        entry.approvedBy || null,
        entry.approverName || null,
      ]
    );
  } catch (error) {
    console.error("Could not write audit log:", error.message);
  }
};

// --- Salaries -----------------------------------------------------------
//
// Pay is only for people with "see salaries" (staff.salaries). The activity
// log records salary changes and payroll money, and "read the activity log"
// (audit.view) is given to supervisors on its own, so the money is taken out
// of those rows for anyone without salaries. The row itself stays: that a
// salary was changed, or a period paid, is not secret; the amount is.
const SALARY_ROWS = new Set(["employee", "payroll_payment", "payroll_adjustment"]);
const SALARY_FIELDS = new Set([
  "salaryAmount",
  "salaryType",
  "earned",
  "bonus",
  "advances",
  "deductions",
  "netPay",
  "amountPaid",
  "amount",
  "carriedForward",
]);

const redactSalaryMoney = (row) => {
  if (!SALARY_ROWS.has(row.entity_type) || !row.details || typeof row.details !== "object") {
    return row;
  }

  let hidden = false;
  const strip = (object) =>
    Object.fromEntries(
      Object.entries(object).filter(([key]) => {
        if (SALARY_FIELDS.has(key)) {
          hidden = true;
          return false;
        }

        return true;
      })
    );

  const details = strip(row.details);

  if (details.changes && typeof details.changes === "object") {
    details.changes = strip(details.changes);
  }

  return { ...row, details: hidden ? { ...details, payHidden: true } : details };
};

// The old reports endpoint (GET /api/reports/audit-log) cannot tell who is
// asking, so it never shows pay; the activity log screen shows it to those
// allowed to see salaries.
const findAll = async (restaurantId, filters = {}) => {
  const result = await pool.query(
    `SELECT id, user_name, action, entity_type, entity_id, entity_label, details, created_at,
            approved_by, approver_name,
            COUNT(*) OVER ()::int AS total_count
     FROM audit_logs
     WHERE restaurant_id = $1
       AND ($2::text IS NULL OR entity_type = $2)
       AND ($3::text IS NULL OR action = $3)
     ORDER BY created_at DESC
     LIMIT $4`,
    [restaurantId, filters.entityType || null, filters.action || null, filters.limit || 200]
  );

  return {
    rows: result.rows.map(redactSalaryMoney),
    total: result.rows.length > 0 ? result.rows[0].total_count : 0,
  };
};

// "Money-sensitive": what an owner checks for leakage and theft. Voids,
// refunds, cancellations, discounts and reprints of bills; dishes taken off an
// order; price and offer changes; points and dues by hand; cash at day close;
// expenses, wastage and stock taken out; salary changes and payroll money;
// and anything that went through on a manager's approval (or a wrong PIN at
// the approval prompt). Routine rows — a payment taken, a table created —
// are left out, which is what makes the view short enough to read.
const SENSITIVE = `(
  a.approved_by IS NOT NULL
  OR a.action IN ('approval_granted', 'approval_denied')
  OR (a.entity_type = 'bill' AND a.action <> 'payment')
  OR (a.entity_type = 'order' AND a.action ~ '(cancel|void|reduce|remove|discount|complimentary)')
  OR (a.entity_type IN ('product', 'product_variant', 'price_window', 'price_window_items', 'combo',
                        'discount', 'modifier', 'tax_rate', 'product_modifiers')
      AND a.action IN ('create', 'update', 'delete', 'import', 'availability'))
  OR (a.entity_type = 'customer' AND a.action ~ '(loyalty|credit|points|dues)')
  OR a.entity_type IN ('business_day', 'expense', 'payroll_payment', 'payroll_adjustment',
                       'payroll_settings')
  OR (a.entity_type = 'employee' AND (a.details -> 'changes') ? 'salaryAmount')
  OR (a.entity_type = 'inventory_item' AND a.action IN ('wastage', 'stock_out', 'wastage_reversed'))
  OR (a.entity_type = 'supplier' AND a.action = 'payment')
)`;

// The activity log's filters, shared by the paged list, the count and the
// export so all three always mean the same rows. Parameters $1 to $9, in the
// order filterValues gives them.
const FILTERS = `a.restaurant_id = $1
       AND ($2::timestamptz IS NULL OR a.created_at >= $2::timestamptz)
       AND ($3::timestamptz IS NULL OR a.created_at < $3::timestamptz)
       AND ($4::bigint IS NULL OR a.user_id = $4 OR a.approved_by = $4)
       AND ($5::text IS NULL OR a.entity_type = $5)
       AND ($6::text IS NULL OR a.action = $6)
       AND ($7::boolean IS NOT TRUE OR ${SENSITIVE})
       AND ($8::text IS NULL
            OR a.entity_label ILIKE '%' || $8 || '%'
            OR a.user_name ILIKE '%' || $8 || '%'
            OR a.approver_name ILIKE '%' || $8 || '%'
            -- Searching inside pay rows would find a salary by its number
            -- (search "30000"), so they are searched only for those who may
            -- see salaries.
            OR (($9::boolean OR a.entity_type NOT IN ('employee', 'payroll_payment', 'payroll_adjustment'))
                AND a.details::text ILIKE '%' || $8 || '%'))`;

const filterValues = (restaurantId, filters) => [
  restaurantId,
  filters.fromInstant || null,
  filters.toInstant || null,
  filters.userId || null,
  filters.entityType || null,
  filters.action || null,
  Boolean(filters.sensitive),
  filters.search || null,
  Boolean(filters.seesSalaries),
];

const ENTRY_COLUMNS = `a.id, a.user_id, a.user_name, a.action, a.entity_type, a.entity_id, a.entity_label,
            a.details, a.created_at, a.approved_by, a.approver_name,
            ${SENSITIVE} AS sensitive`;

// The activity log for an owner: a time range, one person (as the doer or as
// the approving manager), an area, an action, money-sensitive only, and free
// text across the reference, the name and the details. Paged, newest first.
const search = async (restaurantId, filters = {}) => {
  const result = await pool.query(
    `SELECT ${ENTRY_COLUMNS},
            COUNT(*) OVER ()::int AS total_count
     FROM audit_logs a
     WHERE ${FILTERS}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT $10 OFFSET $11`,
    [...filterValues(restaurantId, filters), filters.limit || 100, filters.offset || 0]
  );

  return {
    rows: filters.seesSalaries ? result.rows : result.rows.map(redactSalaryMoney),
    total: result.rows.length > 0 ? result.rows[0].total_count : 0,
  };
};

// How many rows the filters match, for an export to say how big it is (and
// refuse one no file should hold) before reading any.
const countMatching = async (restaurantId, filters = {}) => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count FROM audit_logs a WHERE ${FILTERS}`,
    filterValues(restaurantId, filters)
  );

  return result.rows[0].count;
};

// One page of an export, newest first, continuing below `beforeId`. Paging
// by id rather than by offset keeps a long export exact while the till goes
// on writing: new rows have higher ids and never shift the pages still to
// come, so nothing is read twice or skipped.
const exportPage = async (restaurantId, filters = {}, { beforeId = null, limit = 2000 } = {}) => {
  const result = await pool.query(
    `SELECT ${ENTRY_COLUMNS}
     FROM audit_logs a
     WHERE ${FILTERS}
       AND ($10::bigint IS NULL OR a.id < $10)
     ORDER BY a.id DESC
     LIMIT $11`,
    [...filterValues(restaurantId, filters), beforeId, limit]
  );

  return filters.seesSalaries ? result.rows : result.rows.map(redactSalaryMoney);
};

// The counts an owner scans first, for the same time range and person:
// voids, refunds, cancelled orders and dishes, approvals given, wrong PINs.
// Every void counts, however it was let through: a bill "not yet printed"
// may still have been shown to the guest and paid in cash.
const summary = async (restaurantId, filters = {}) => {
  const result = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE a.entity_type = 'bill' AND a.action = 'void')::int AS voids,
       COUNT(*) FILTER (WHERE a.entity_type = 'bill' AND a.action = 'refund')::int AS refunds,
       COUNT(*) FILTER (WHERE a.entity_type = 'order' AND a.action ~ '(cancel|reduce|remove)')::int AS cancellations,
       COUNT(*) FILTER (WHERE a.entity_type = 'bill' AND a.action = 'reprint')::int AS reprints,
       COUNT(*) FILTER (WHERE a.action = 'approval_granted')::int AS approvals,
       COUNT(*) FILTER (WHERE a.action = 'approval_denied')::int AS denied
     FROM audit_logs a
     WHERE a.restaurant_id = $1
       AND ($2::timestamptz IS NULL OR a.created_at >= $2::timestamptz)
       AND ($3::timestamptz IS NULL OR a.created_at < $3::timestamptz)
       AND ($4::bigint IS NULL OR a.user_id = $4 OR a.approved_by = $4)`,
    [restaurantId, filters.fromInstant || null, filters.toInstant || null, filters.userId || null]
  );

  return result.rows[0];
};

// Who appears in the log, and which areas and actions it holds, for the
// filter lists. From the log itself, so someone who has since left still
// appears against what they did.
const facets = async (restaurantId) => {
  const [people, areas, actions] = await Promise.all([
    pool.query(
      `SELECT user_id AS id, MAX(user_name) AS name
       FROM audit_logs
       WHERE restaurant_id = $1 AND user_id IS NOT NULL
       GROUP BY user_id
       ORDER BY MAX(user_name)`,
      [restaurantId]
    ),
    pool.query(
      "SELECT DISTINCT entity_type FROM audit_logs WHERE restaurant_id = $1 ORDER BY entity_type",
      [restaurantId]
    ),
    pool.query(
      "SELECT DISTINCT action FROM audit_logs WHERE restaurant_id = $1 ORDER BY action",
      [restaurantId]
    ),
  ]);

  return {
    people: people.rows,
    areas: areas.rows.map((row) => row.entity_type),
    actions: actions.rows.map((row) => row.action),
  };
};

// The "Staff member" picker on the activity log: people who have done
// something here, matching what was typed (all of them, A to Z, when nothing
// was), a short list at a time.
const findPeople = async (restaurantId, q, limit) => {
  const result = await pool.query(
    `SELECT user_id AS id, MAX(user_name) AS name, COUNT(*)::int AS entries, MAX(created_at) AS last_at
     FROM audit_logs
     WHERE restaurant_id = $1 AND user_id IS NOT NULL
       AND ($2::text IS NULL OR user_name ILIKE '%' || $2 || '%' ESCAPE '\\')
     GROUP BY user_id
     ORDER BY MAX(user_name), user_id
     LIMIT $3`,
    // "%" and "_" typed are text, not wildcards.
    [restaurantId, q === null ? null : String(q).replace(/[\\%_]/g, (match) => `\\${match}`), limit]
  );

  return result.rows;
};

module.exports = { record, findAll, search, countMatching, exportPage, summary, facets, findPeople };
