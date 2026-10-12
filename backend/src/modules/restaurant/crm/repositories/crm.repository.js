const pool = require("../../../../config/database");

// --- Customers ---

// Other modules read guests through findCustomerById (billing prints the
// company name and GSTIN on a B2B invoice, reservations and orders link a
// guest). New columns are added to this list, never taken away.
const CUSTOMER_COLUMNS = `id, name, mobile, email, address, date_of_birth, anniversary_date,
                          loyalty_points, notes, status, created_at,
                          company_name, gstin, tags, allergies,
                          marketing_opt_in, marketing_opt_in_at,
                          duplicate_of, erased_at`;

const customerColumns = (alias) =>
  CUSTOMER_COLUMNS.split(",")
    .map((column) => `${alias}.${column.trim()}`)
    .join(", ");

// "%" and "_" typed into a search box are text, not wildcards.
const likeText = (text) => String(text).replace(/[\\%_]/g, (match) => `\\${match}`);

// How many rows match, for a page read with COUNT(*) OVER (). A page past the
// last one has no row to read that from (the screen just erased the only guest
// on the last page, say), so the first page is asked for the count instead of
// answering "0 in all" and leaving the screen with no way back.
const pageTotal = async (result, offset, readFirstPage) => {
  if (result.rows.length) {
    return result.rows[0].total_count;
  }

  if (offset > 0) {
    const first = await readFirstPage();

    return first.rows.length ? first.rows[0].total_count : 0;
  }

  return 0;
};

// How a search box is read against a mobile column: a LIKE pattern. The
// service decides it (crm.service readSearch): "%3210%" for staff who see
// every number, and for staff who see numbers masked only the whole number
// ("9876543210") or the last digits they can already see ("%3210"). An empty
// pattern matches nothing. Older callers pass `digits`, read as "contains".
const mobilePatternOf = ({ mobilePattern, digits }) =>
  mobilePattern !== undefined && mobilePattern !== null ? mobilePattern : digits ? `%${digits}%` : null;

// A name search reads the email too. For staff who see emails masked
// (emailExact), only the whole address matches: part of one, typed a letter
// at a time, would spell out a hidden address.
const EMAIL_MATCH = (column, nameParam, exactParam) =>
  `(CASE WHEN ${exactParam}::boolean THEN ${column} ILIKE ${nameParam} ESCAPE '\\'
         ELSE ${column} ILIKE '%' || ${nameParam} || '%' ESCAPE '\\' END)`;

const findCustomers = async (restaurantId, filters = {}) => {
  const result = await pool.query(
    `SELECT ${CUSTOMER_COLUMNS}
     FROM customers
     WHERE restaurant_id = $1
       AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%' OR mobile ILIKE '%' || $2 || '%')
     ORDER BY name
     LIMIT $3`,
    [restaurantId, filters.search || null, filters.limit || 500]
  );

  return result.rows;
};

// The quick lookup behind the till's guest search and the pickers: a name or
// part of a mobile written any way (the digits come in already tidied, see
// utils/phone.js mobileSearchDigits). Returns the page and how many matched,
// so no screen can mistake the first N for all of them.
const searchCustomers = async (
  restaurantId,
  { name = null, digits = null, mobilePattern = null, emailExact = false, limit = 20, includeErased = false } = {}
) => {
  const result = await pool.query(
    `SELECT ${CUSTOMER_COLUMNS}, COUNT(*) OVER ()::int AS total_count
     FROM customers
     WHERE restaurant_id = $1
       AND ($4::boolean OR erased_at IS NULL)
       AND (
         ($2::text IS NULL AND $3::text IS NULL)
         OR ($3::text <> '' AND mobile LIKE $3)
         OR ($2::text IS NOT NULL AND (name ILIKE '%' || $2 || '%' ESCAPE '\\'
                                       OR ${EMAIL_MATCH("email", "$2", "$7")}
                                       OR company_name ILIKE '%' || $2 || '%' ESCAPE '\\'))
       )
     ORDER BY
       -- An exact number first, then names that start with what was typed.
       CASE WHEN $6::text IS NOT NULL AND mobile = $6 THEN 0
            WHEN $2::text IS NOT NULL AND name ILIKE $2 || '%' ESCAPE '\\' THEN 1
            ELSE 2 END,
       LOWER(name), id
     LIMIT $5`,
    [
      restaurantId,
      name === null ? null : likeText(name),
      mobilePatternOf({ mobilePattern, digits }),
      includeErased,
      limit,
      digits,
      emailExact,
    ]
  );

  return { rows: result.rows, total: result.rows.length ? result.rows[0].total_count : 0 };
};

const findCustomerById = async (restaurantId, id, db = pool) => {
  const result = await db.query(
    `SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE restaurant_id = $1 AND id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

const findCustomerByMobile = async (restaurantId, mobile) => {
  if (!mobile) {
    return null;
  }

  const result = await pool.query(
    `SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE restaurant_id = $1 AND mobile = $2`,
    [restaurantId, mobile]
  );

  return result.rows[0] || null;
};

// Every guest holding one of these stored mobiles (a number and its other
// ten-digit form, see utils/phone.js tenDigitTwin), read inside the caller's
// transaction.
const findCustomersByMobiles = async (client, restaurantId, mobiles) => {
  const list = mobiles.filter(Boolean);

  if (list.length === 0) {
    return [];
  }

  const result = await client.query(
    `SELECT ${CUSTOMER_COLUMNS} FROM customers
     WHERE restaurant_id = $1 AND mobile = ANY($2::text[])
     ORDER BY id`,
    [restaurantId, list]
  );

  return result.rows;
};

// Held from the duplicate check to the write, so two saves of one number
// (or of its two ten-digit forms) are decided one after the other. Released
// with the caller's transaction.
const lockMobile = async (client, restaurantId, mobile) => {
  if (!mobile) {
    return;
  }

  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `crm.mobile:${restaurantId}:${String(mobile).slice(-10)}`,
  ]);
};

// client: optional, to write inside the caller's transaction.
const createCustomer = async (restaurantId, data, userId, client = pool) => {
  const optIn = data.marketingOptIn === true;
  const result = await client.query(
    `INSERT INTO customers (restaurant_id, name, mobile, email, address, date_of_birth,
                            notes, status, created_by, updated_by,
                            company_name, gstin, tags, allergies,
                            marketing_opt_in, marketing_opt_in_at, marketing_opt_in_by,
                            anniversary_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9,
             $10, $11, COALESCE($12::text[], '{}'), $13,
             $14, CASE WHEN $14 THEN NOW() END, CASE WHEN $14 THEN $9::bigint END,
             $15)
     RETURNING ${CUSTOMER_COLUMNS}`,
    [
      restaurantId,
      data.name,
      data.mobile,
      data.email,
      data.address,
      data.dateOfBirth,
      data.notes,
      data.status,
      userId,
      data.companyName ?? null,
      data.gstin ?? null,
      data.tags ?? null,
      data.allergies ?? null,
      optIn,
      data.anniversaryDate ?? null,
    ]
  );

  return result.rows[0];
};

// The fields every edit sends are replaced, as before. The newer ones
// (business details, tags, consent) are changed only when the edit carries
// them, so an older screen or script that sends name and mobile alone does
// not wipe a guest's GSTIN or their consent.
const OPTIONAL_UPDATES = [
  ["companyName", "company_name"],
  ["gstin", "gstin"],
  ["tags", "tags", "::text[]"],
  ["allergies", "allergies"],
  ["anniversaryDate", "anniversary_date", "::date"],
];

// client: optional, to write inside the caller's transaction.
const updateCustomer = async (restaurantId, id, data, userId, client = pool) => {
  const values = [
    restaurantId,
    id,
    data.name,
    data.mobile,
    data.email,
    data.address,
    data.dateOfBirth,
    data.notes,
    data.status,
    userId,
  ];
  const sets = [
    "name = $3",
    "mobile = $4",
    "email = $5",
    "address = $6",
    "date_of_birth = $7",
    "notes = $8",
    "status = $9",
    "updated_by = $10",
  ];

  for (const [field, column, cast = ""] of OPTIONAL_UPDATES) {
    if (data[field] !== undefined) {
      values.push(data[field]);
      sets.push(`${column} = $${values.length}${cast}`);
    }
  }

  // Consent keeps who recorded it and when; saving the same answer again
  // leaves that alone.
  if (typeof data.marketingOptIn === "boolean") {
    values.push(data.marketingOptIn);
    const at = `$${values.length}::boolean`;
    sets.push(
      `marketing_opt_in = ${at}`,
      `marketing_opt_in_at = CASE WHEN ${at} IS DISTINCT FROM marketing_opt_in THEN
                               CASE WHEN ${at} THEN NOW() END
                             ELSE marketing_opt_in_at END`,
      `marketing_opt_in_by = CASE WHEN ${at} IS DISTINCT FROM marketing_opt_in THEN
                               CASE WHEN ${at} THEN $10::bigint END
                             ELSE marketing_opt_in_by END`
    );
  }

  const result = await client.query(
    `UPDATE customers
     SET ${sets.join(", ")}
     WHERE restaurant_id = $1 AND id = $2
     RETURNING ${CUSTOMER_COLUMNS}`,
    values
  );

  return result.rows[0] || null;
};

const removeCustomer = async (restaurantId, id) => {
  const result = await pool.query(
    "DELETE FROM customers WHERE restaurant_id = $1 AND id = $2 RETURNING id",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// --- The guest book ---
//
// One row per guest with the numbers a manager recognises regulars by. The
// definitions are the ones guest insights and the history panel use, so a
// guest reads the same on every screen:
//   a visit = an order linked to the guest that was not cancelled
//   spend   = the total of the non-void bills on those orders, less what
//             was refunded on them (credit notes): a ₹762 bill refunded in
//             full is ₹0 spent, as the loyalty screen already counted it
const NET_OF_REFUNDS = (b) => `(${b}.total_amount - COALESCE(${b}.credited_amount, 0))`;

const GUEST_FACTS = `
  guest_facts AS (
    SELECT o.customer_id,
           COUNT(*)::int AS visits,
           MAX(o.placed_at) AS last_visit,
           COALESCE(SUM(s.amount), 0) AS spend
    FROM orders o
    LEFT JOIN (
      SELECT b.order_id, SUM(${NET_OF_REFUNDS("b")}) AS amount
      FROM bills b
      WHERE b.restaurant_id = $1 AND b.bill_status <> 'void'
      GROUP BY b.order_id
    ) s ON s.order_id = o.id
    WHERE o.restaurant_id = $1 AND o.customer_id IS NOT NULL AND o.order_status <> 'cancelled'
    GROUP BY o.customer_id
  )`;

const BOOK_SORTS = {
  name: "LOWER(c.name)",
  visits: "COALESCE(f.visits, 0)",
  lastVisit: "f.last_visit",
  spend: "COALESCE(f.spend, 0)",
  points: "c.loyalty_points",
  created: "c.created_at",
};

// "All" is every guest still in the book; records erased on request are a
// list of their own, since there is nobody left in them to look up.
const BOOK_STATUS = {
  active: "c.status = 'active' AND c.erased_at IS NULL",
  inactive: "c.status = 'inactive' AND c.erased_at IS NULL",
  all: "c.erased_at IS NULL",
  erased: "c.erased_at IS NOT NULL",
};

// "Lapsed": no visit in this many days.
const LAPSED_DAYS = 60;

const findGuestBook = async (restaurantId, filters = {}) => {
  const {
    name = null,
    digits = null,
    mobilePattern = null,
    emailExact = false,
    status = "active",
    tag = null,
    optedIn = false,
    business = false,
    view = null,
    today = null,
    sort = "name",
    ascending = true,
    limit = 25,
    offset = 0,
  } = filters;

  // Whitelisted above: never a client string in the SQL.
  const orderBy = BOOK_SORTS[sort] || BOOK_SORTS.name;
  const where = BOOK_STATUS[status] || BOOK_STATUS.active;

  const read = (pageLimit, pageOffset) => pool.query(
    `WITH ${GUEST_FACTS}
     SELECT ${customerColumns("c")},
            COALESCE(f.visits, 0) AS visits,
            f.last_visit,
            COALESCE(f.spend, 0) AS spend,
            COUNT(*) OVER ()::int AS total_count
     FROM customers c
     LEFT JOIN guest_facts f ON f.customer_id = c.id
     WHERE c.restaurant_id = $1
       AND ${where}
       AND (
         ($2::text IS NULL AND $3::text IS NULL)
         OR ($3::text <> '' AND c.mobile LIKE $3)
         OR ($2::text IS NOT NULL AND (c.name ILIKE '%' || $2 || '%' ESCAPE '\\'
                                       OR ${EMAIL_MATCH("c.email", "$2", "$9")}
                                       OR c.company_name ILIKE '%' || $2 || '%' ESCAPE '\\'
                                       OR c.gstin ILIKE '%' || $2 || '%' ESCAPE '\\'))
       )
       AND ($4::text IS NULL OR $4 = ANY(c.tags))
       AND (NOT $5::boolean OR c.marketing_opt_in)
       AND (NOT $6::boolean OR c.gstin IS NOT NULL)
       -- The quick views ($10, with the restaurant's today in $11):
       --   occasion  a birthday or anniversary in the next 7 days (today included)
       --   lapsed    came before, but not in the last ${LAPSED_DAYS} days
       --   top       has spent something (the screen sorts by spend)
       AND ($10::text IS NULL
            OR ($10 = 'occasion' AND EXISTS (
                  SELECT 1 FROM generate_series(0, 6) AS ahead(n)
                  WHERE to_char($11::date + ahead.n, 'MM-DD') = to_char(c.date_of_birth, 'MM-DD')
                     OR to_char($11::date + ahead.n, 'MM-DD') = to_char(c.anniversary_date, 'MM-DD')))
            OR ($10 = 'lapsed' AND f.last_visit IS NOT NULL
                AND f.last_visit < ($11::date - ${LAPSED_DAYS})::timestamp)
            OR ($10 = 'top' AND COALESCE(f.spend, 0) > 0))
     ORDER BY ${orderBy} ${ascending ? "ASC" : "DESC"} NULLS LAST, LOWER(c.name), c.id
     LIMIT $7 OFFSET $8`,
    [
      restaurantId,
      name === null ? null : likeText(name),
      mobilePatternOf({ mobilePattern, digits }),
      tag,
      optedIn,
      business,
      pageLimit,
      pageOffset,
      emailExact,
      view,
      today,
    ]
  );

  const result = await read(limit, offset);

  return { rows: result.rows, total: await pageTotal(result, offset, () => read(1, 0)) };
};

// The counts on the guest book's filter chips.
const guestBookCounts = async (restaurantId) => {
  const result = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'active' AND erased_at IS NULL)::int AS active,
            COUNT(*) FILTER (WHERE status = 'inactive' AND erased_at IS NULL)::int AS inactive,
            COUNT(*) FILTER (WHERE erased_at IS NOT NULL)::int AS erased,
            COUNT(*) FILTER (WHERE erased_at IS NULL)::int AS "all",
            COUNT(*) FILTER (WHERE marketing_opt_in AND erased_at IS NULL)::int AS opted_in,
            COUNT(*) FILTER (WHERE gstin IS NOT NULL)::int AS business,
            COUNT(*) FILTER (WHERE duplicate_of IS NOT NULL)::int AS duplicates,
            COALESCE(SUM(loyalty_points), 0)::int AS points
     FROM customers
     WHERE restaurant_id = $1`,
    [restaurantId]
  );

  return result.rows[0];
};

// Every row of the guest book that matches, for the CSV export (capped by the
// caller, who says so when the cap is reached).
const findGuestBookForExport = async (restaurantId, filters, cap) =>
  findGuestBook(restaurantId, { ...filters, limit: cap, offset: 0 });

// --- One guest's history ---

// One row per visit (order), however many bills it was paid on: a split bill
// used to show the same visit twice. Cancelled orders are listed, marked, and
// not counted as visits.
const findVisitsForCustomer = async (restaurantId, customerId, { limit = 50, offset = 0 } = {}) => {
  const result = await pool.query(
    `SELECT o.id, o.order_number, o.order_type, o.placed_at, o.order_status,
            o.total_amount AS order_total,
            bills.bill_numbers, bills.bill_total, bills.bill_count,
            items.item_count, items.items,
            COUNT(*) OVER ()::int AS total_count
     FROM orders o
     LEFT JOIN LATERAL (
       SELECT ARRAY_AGG(b.bill_number ORDER BY b.id) AS bill_numbers,
              SUM(${NET_OF_REFUNDS("b")}) AS bill_total,
              COUNT(*)::int AS bill_count
       FROM bills b
       WHERE b.order_id = o.id AND b.bill_status <> 'void'
     ) bills ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS item_count,
              STRING_AGG(DISTINCT oi.item_name, ', ') AS items
       FROM order_items oi
       WHERE oi.order_id = o.id AND oi.item_status <> 'cancelled'
     ) items ON TRUE
     WHERE o.restaurant_id = $1 AND o.customer_id = $2
     ORDER BY o.placed_at DESC, o.id DESC
     LIMIT $3 OFFSET $4`,
    [restaurantId, customerId, limit, offset]
  );

  return result.rows;
};

// The tiles above the history, with the same definitions as the rows.
const customerTotals = async (restaurantId, customerId) => {
  const result = await pool.query(
    `WITH per_order AS (
       SELECT o.id, o.order_status, o.placed_at,
              (SELECT SUM(${NET_OF_REFUNDS("b")}) FROM bills b
               WHERE b.order_id = o.id AND b.bill_status <> 'void') AS amount
       FROM orders o
       WHERE o.restaurant_id = $1 AND o.customer_id = $2
     )
     SELECT COUNT(*) FILTER (WHERE order_status <> 'cancelled')::int AS visits,
            COUNT(*) FILTER (WHERE order_status = 'cancelled')::int AS cancelled,
            COUNT(amount) FILTER (WHERE order_status <> 'cancelled')::int AS billed_visits,
            COALESCE(SUM(amount) FILTER (WHERE order_status <> 'cancelled'), 0) AS total_spent,
            MAX(placed_at) FILTER (WHERE order_status <> 'cancelled') AS last_visit,
            MIN(placed_at) FILTER (WHERE order_status <> 'cancelled') AS first_visit
     FROM per_order`,
    [restaurantId, customerId]
  );

  return result.rows[0];
};

// Where a guest came from: the records merged into them, and what their
// mobile looked like before the clean-up.
const findMergesInto = async (restaurantId, customerId) => {
  const result = await pool.query(
    `SELECT m.id, m.merged_customer_id, m.merged_name, m.merged_mobile, m.points_moved,
            m.records_moved, m.created_at, u.name AS merged_by_name
     FROM customer_merges m
     LEFT JOIN users u ON u.id = m.created_by
     WHERE m.restaurant_id = $1 AND m.kept_customer_id = $2
     ORDER BY m.created_at DESC`,
    [restaurantId, customerId]
  );

  return result.rows;
};

// What is on record against a guest, which decides whether the record may be
// deleted outright or only erased.
const historyCounts = async (restaurantId, customerId) => {
  const result = await pool.query(
    `SELECT (SELECT COUNT(*) FROM orders WHERE restaurant_id = $1 AND customer_id = $2)::int AS orders,
            (SELECT COUNT(*) FROM feedback WHERE restaurant_id = $1 AND customer_id = $2)::int AS feedback,
            (SELECT COUNT(*) FROM complaints WHERE restaurant_id = $1 AND customer_id = $2)::int AS complaints,
            (SELECT COUNT(*) FROM loyalty_transactions WHERE restaurant_id = $1 AND customer_id = $2)::int AS points`,
    [restaurantId, customerId]
  );

  return result.rows[0];
};

// --- Duplicates and merging ---

// Pairs the mobile clean-up found (two records, one number), with enough about
// each side to decide which to keep.
const findDuplicatePairs = async (restaurantId) => {
  const result = await pool.query(
    `WITH ${GUEST_FACTS}
     SELECT d.id, d.name, d.email, d.mobile, d.loyalty_points, d.created_at, d.status,
            d.gstin, d.company_name, k.gstin AS keep_gstin, k.company_name AS keep_company_name,
            COALESCE(fd.visits, 0) AS visits, fd.last_visit, COALESCE(fd.spend, 0) AS spend,
            (SELECT m.old_mobile FROM customer_mobile_cleanup m
             WHERE m.customer_id = d.id ORDER BY m.id DESC LIMIT 1) AS typed_mobile,
            k.id AS keep_id, k.name AS keep_name, k.mobile AS keep_mobile, k.email AS keep_email,
            k.loyalty_points AS keep_points, k.created_at AS keep_created_at, k.status AS keep_status,
            COALESCE(fk.visits, 0) AS keep_visits, fk.last_visit AS keep_last_visit,
            COALESCE(fk.spend, 0) AS keep_spend
     FROM customers d
     JOIN customers k ON k.id = d.duplicate_of AND k.restaurant_id = d.restaurant_id
     LEFT JOIN guest_facts fd ON fd.customer_id = d.id
     LEFT JOIN guest_facts fk ON fk.customer_id = k.id
     WHERE d.restaurant_id = $1
     ORDER BY LOWER(k.name), k.id, d.id`,
    [restaurantId]
  );

  return result.rows;
};

const clearDuplicateMark = async (restaurantId, id, userId) => {
  const result = await pool.query(
    `UPDATE customers SET duplicate_of = NULL, updated_by = $3
     WHERE restaurant_id = $1 AND id = $2 AND duplicate_of IS NOT NULL
     RETURNING id`,
    [restaurantId, id, userId]
  );

  return result.rows[0] || null;
};

// A guest's bills, then their orders, locked inside the caller's transaction
// — the order billing takes them in (a payment locks its bill, settles its
// order, then credits the guest's points). Anything that will lock the guest
// AND write to their bills or orders (an erase, an edit that re-issues their
// invoices) takes these first, so it waits for a payment in progress, or the
// payment waits for it, instead of each holding what the other needs.
//
// customerIds: one guest's id, or several (a merge takes both guests').
const lockGuestBillsAndOrders = async (client, restaurantId, customerIds) => {
  const ids = [].concat(customerIds);

  await client.query(
    `SELECT b.id FROM bills b
     JOIN orders o ON o.id = b.order_id
     WHERE b.restaurant_id = $1 AND o.customer_id = ANY($2::bigint[])
     ORDER BY b.id
     FOR UPDATE OF b`,
    [restaurantId, ids]
  );

  await client.query(
    `SELECT id FROM orders WHERE restaurant_id = $1 AND customer_id = ANY($2::bigint[]) ORDER BY id FOR UPDATE`,
    [restaurantId, ids]
  );
};

const lockCustomers = async (client, restaurantId, ids) => {
  const result = await client.query(
    `SELECT ${CUSTOMER_COLUMNS} FROM customers
     WHERE restaurant_id = $1 AND id = ANY($2::bigint[])
     ORDER BY id
     FOR UPDATE`,
    [restaurantId, ids]
  );

  return result.rows;
};

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

// Every column in the database that points at a guest, read from the
// database's own list of foreign keys rather than written out here. A module
// added next month (credit accounts, say) that links to customers is moved by
// a merge without anyone remembering to add it.
const findGuestReferences = async (client) => {
  const result = await client.query(
    `SELECT n.nspname AS schema_name, t.relname AS table_name, a.attname AS column_name,
            EXISTS (SELECT 1 FROM pg_attribute r
                    WHERE r.attrelid = t.oid AND r.attname = 'restaurant_id' AND NOT r.attisdropped)
              AS has_restaurant
     FROM pg_constraint k
     JOIN pg_class t ON t.oid = k.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
     WHERE k.contype = 'f'
       AND k.confrelid = 'customers'::regclass
       AND array_length(k.conkey, 1) = 1
       AND t.relname <> 'customers'
     ORDER BY t.relname, a.attname`
  );

  return result.rows;
};

const moveGuestReferences = async (client, restaurantId, reference, fromId, toId) => {
  const table = `${quoteIdent(reference.schema_name)}.${quoteIdent(reference.table_name)}`;
  const column = quoteIdent(reference.column_name);
  const result = await client.query(
    `UPDATE ${table} SET ${column} = $2 WHERE ${column} = $1
     ${reference.has_restaurant ? "AND restaurant_id = $3" : ""}`,
    reference.has_restaurant ? [fromId, toId, restaurantId] : [fromId, toId]
  );

  return result.rowCount;
};

// After two points ledgers become one, each entry's "balance after" is worked
// out again in time order, ending on the combined balance.
const recomputeLedger = async (client, restaurantId, customerId, balance) => {
  await client.query(
    `UPDATE loyalty_transactions lt
     SET balance_after = GREATEST(0, $3::int - (x.total - x.running))
     FROM (
       SELECT id,
              SUM(points) OVER (ORDER BY created_at, id) AS running,
              SUM(points) OVER () AS total
       FROM loyalty_transactions
       WHERE restaurant_id = $1 AND customer_id = $2
     ) x
     WHERE lt.id = x.id`,
    [restaurantId, customerId, balance]
  );
};

// The kept record takes what it lacks from the merged one; nothing it already
// has is overwritten.
//
// options.business ({ companyName, gstin }): what the kept record ends with
// for GST invoices, decided by the service (crm.service mergeCustomers), in
// place of "keep ours, else take theirs". options.note: a line added to the
// kept record's notes saying why.
const absorbCustomer = async (client, restaurantId, keep, merged, userId, options = {}) => {
  const notes = [keep.notes, merged.notes ? `From ${merged.name}: ${merged.notes}` : null, options.note || null]
    .filter(Boolean)
    .join("\n");
  const business = options.business || null;
  const takeConsent = !keep.marketing_opt_in && merged.marketing_opt_in;

  // The merged record gives up its number first, so the kept one can take it.
  await client.query("UPDATE customers SET mobile = NULL WHERE restaurant_id = $1 AND id = $2", [
    restaurantId,
    merged.id,
  ]);

  const result = await client.query(
    `UPDATE customers
     SET mobile = COALESCE(mobile, $3),
         email = COALESCE(email, $4),
         address = COALESCE(address, $5),
         date_of_birth = COALESCE(date_of_birth, $6),
         anniversary_date = COALESCE(anniversary_date, $18::date),
         company_name = CASE WHEN $17::boolean THEN $7 ELSE COALESCE(company_name, $7) END,
         gstin = CASE WHEN $17::boolean THEN $8 ELSE COALESCE(gstin, $8) END,
         allergies = COALESCE(allergies, $9),
         tags = ARRAY(SELECT DISTINCT UNNEST(tags || $10::text[]) ORDER BY 1),
         notes = NULLIF($11, ''),
         loyalty_points = loyalty_points + $12,
         marketing_opt_in = marketing_opt_in OR $13,
         marketing_opt_in_at = CASE WHEN $13 AND NOT marketing_opt_in THEN $14 ELSE marketing_opt_in_at END,
         status = CASE WHEN status = 'active' OR $15 = 'active' THEN 'active' ELSE status END,
         duplicate_of = NULL,
         updated_by = $16
     WHERE restaurant_id = $1 AND id = $2
     RETURNING ${CUSTOMER_COLUMNS}`,
    [
      restaurantId,
      keep.id,
      merged.mobile,
      merged.email,
      merged.address,
      merged.date_of_birth,
      business ? business.companyName : merged.company_name,
      business ? business.gstin : merged.gstin,
      merged.allergies,
      merged.tags || [],
      notes,
      Number(merged.loyalty_points) || 0,
      takeConsent,
      merged.marketing_opt_in_at,
      merged.status,
      userId,
      Boolean(business),
      merged.anniversary_date ?? null,
    ]
  );

  // Anyone else marked as a duplicate of the merged record is now a possible
  // duplicate of the one that stays.
  await client.query(
    `UPDATE customers SET duplicate_of = $3
     WHERE restaurant_id = $1 AND duplicate_of = $2 AND id <> $3`,
    [restaurantId, merged.id, keep.id]
  );

  return result.rows[0];
};

const deleteMergedCustomer = async (client, restaurantId, id) => {
  await client.query("DELETE FROM customers WHERE restaurant_id = $1 AND id = $2", [restaurantId, id]);
};

const recordMerge = async (client, restaurantId, entry, userId) => {
  const result = await client.query(
    `INSERT INTO customer_merges (restaurant_id, kept_customer_id, merged_customer_id, merged_name,
                                  merged_mobile, points_moved, records_moved, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      restaurantId,
      entry.keptId,
      entry.mergedId,
      entry.mergedName,
      entry.mergedMobile,
      entry.pointsMoved,
      JSON.stringify(entry.recordsMoved || {}),
      userId,
    ]
  );

  return result.rows[0].id;
};

// --- Who a tax invoice was made out to ---
//
// A tax invoice, once issued, must not change. Billing writes the buyer onto
// the bill the moment it is raised (recordInvoiceBuyer below, for a guest
// whose record carries a GSTIN), migration 1790840000000 did it for the bills
// raised before that, and the GST pack, the day book and the reprint read
// only the bill's own row (bill_gst_recipients). So a later change to the
// guest — a new or removed GSTIN, an erase, a merge — writes nothing on their
// bills. (The guest book used to write the guest's current GSTIN onto every
// bill of theirs without a buyer before such a change: that turned their
// earlier ordinary bills into B2B invoices after they were issued.)
const INVOICE_BUYER = `COALESCE(NULLIF(BTRIM(g.company_name), ''), g.name)`;
// The buyer's address goes on the invoice too (a tax invoice to a registered
// buyer prints it), frozen with the name and GSTIN so a reprint next year
// shows the address the invoice was made out to, not the guest's new one.
const INVOICE_ADDRESS = `NULLIF(LEFT(BTRIM(g.address), 300), '')`;

// One bill's buyer, written by billing the moment the bill is raised. Rows
// already there (the accountant's own) are never touched.
const recordInvoiceBuyer = async (client, restaurantId, billId, userId) => {
  const result = await client.query(
    `INSERT INTO bill_gst_recipients (restaurant_id, bill_id, gstin, legal_name, address, created_by, updated_by)
     SELECT b.restaurant_id, b.id, g.gstin, LEFT(${INVOICE_BUYER}, 150), ${INVOICE_ADDRESS}, $3, $3
     FROM bills b
     JOIN orders o ON o.id = b.order_id
     JOIN customers g ON g.id = o.customer_id AND g.gstin IS NOT NULL
     WHERE b.restaurant_id = $1 AND b.id = $2
     ON CONFLICT (bill_id) DO NOTHING`,
    [restaurantId, billId, userId]
  );

  return result.rowCount;
};

// Buyers frozen before the address was copied with them: each gets the
// guest's address, but only while the guest still carries the GSTIN the
// invoice was made out to (a guest whose GSTIN has since changed is now a
// different buyer, and their address is not this invoice's). An address
// someone wrote on the bill by hand is never touched. Returns how many.
const backfillInvoiceBuyerAddresses = async (client, restaurantId) => {
  const result = await client.query(
    `UPDATE bill_gst_recipients r
     SET address = ${INVOICE_ADDRESS}
     FROM bills b
     JOIN orders o ON o.id = b.order_id
     JOIN customers g ON g.id = o.customer_id
     WHERE r.restaurant_id = $1 AND b.id = r.bill_id AND b.restaurant_id = r.restaurant_id
       AND r.address IS NULL AND g.gstin = r.gstin AND ${INVOICE_ADDRESS} IS NOT NULL`,
    [restaurantId]
  );

  return result.rowCount;
};

// Bills of these guests with no buyer on the bill: their ordinary (B2C)
// sales. Read before a merge decides whether
// the guest who stays may carry a GSTIN.
const countOrdinaryBills = async (client, restaurantId, customerIds) => {
  const result = await client.query(
    `SELECT COUNT(*)::int AS bills
     FROM bills b
     JOIN orders o ON o.id = b.order_id
     WHERE b.restaurant_id = $1 AND o.customer_id = ANY($2::bigint[])
       AND NOT EXISTS (SELECT 1 FROM bill_gst_recipients r WHERE r.bill_id = b.id)`,
    [restaurantId, customerIds]
  );

  return result.rows[0].bills;
};

// --- Erasing a guest's personal details ---
//
// The record and its bills stay (GST law wants the invoices kept for years,
// and visit counts and sales must still add up); everything that says who the
// person was goes, wherever a copy of it was made. Returns how many rows of
// each kind were cleared.
const DIGITS_10 = (column) => `RIGHT(REGEXP_REPLACE(COALESCE(${column}, ''), '[^0-9]', '', 'g'), 10)`;

// A copy of a mobile typed anywhere (a QR form, a complaint) in the stored
// form, so it can be compared with the guest's own: an Indian number as its
// last 10 digits, a foreign one as "+" and all its digits. Comparing last 10
// digits alone would take +44 7700 900123 for the Indian 77009 00123, and an
// erasure must never touch somebody else's records.
const MOBILE_KEY = (column) => {
  const digits = `REGEXP_REPLACE(COALESCE(${column}, ''), '[^0-9]', '', 'g')`;

  return `(CASE WHEN BTRIM(COALESCE(${column}, '')) ~ '^\\(?\\s*\\+' AND ${digits} !~ '^91' THEN '+' || ${digits}
               WHEN ${digits} ~ '^00' AND ${digits} !~ '^0091' THEN '+' || SUBSTR(${digits}, 3)
               ELSE RIGHT(${digits}, 10) END)`;
};

const eraseCustomer = async (client, restaurantId, customer, userId) => {
  const id = customer.id;
  // The guest's own number is already in the stored form.
  const ten = customer.mobile || null;
  const cleared = {};

  const run = async (key, sql, params) => {
    const result = await client.query(sql, params);
    cleared[key] = result.rowCount;
  };

  await run(
    "feedback",
    `UPDATE feedback SET customer_name = NULL, customer_mobile = NULL, updated_by = $3
     WHERE restaurant_id = $1
       AND (customer_id = $2 OR ($4::text IS NOT NULL AND ${MOBILE_KEY("customer_mobile")} = $4))`,
    [restaurantId, id, userId, ten]
  );
  await run(
    "complaints",
    `UPDATE complaints SET customer_name = NULL, customer_mobile = NULL, updated_by = $3
     WHERE restaurant_id = $1
       AND (customer_id = $2 OR ($4::text IS NOT NULL AND ${MOBILE_KEY("customer_mobile")} = $4))`,
    [restaurantId, id, userId, ten]
  );
  // The orders stay, with their bills and amounts, still linked to the (now
  // nameless) record so reports and visit counts do not change.
  await run(
    "orders",
    `UPDATE orders
     SET customer_name = NULL, customer_mobile = NULL, delivery_address = NULL, delivery_landmark = NULL
     WHERE restaurant_id = $1
       AND (customer_id = $2 OR ($3::text IS NOT NULL AND ${MOBILE_KEY("customer_mobile")} = $3))`,
    [restaurantId, id, ten]
  );
  await run(
    "reservations",
    `UPDATE reservations SET guest_name = 'Erased guest', guest_mobile = NULL
     WHERE restaurant_id = $1
       AND (customer_id = $2 OR ($3::text IS NOT NULL AND ${MOBILE_KEY("guest_mobile")} = $3))`,
    [restaurantId, id, ten]
  );
  await run(
    "waitlist",
    `UPDATE waitlist_entries SET guest_name = 'Erased guest', guest_mobile = NULL
     WHERE restaurant_id = $1
       AND (customer_id = $2 OR ($3::text IS NOT NULL AND ${MOBILE_KEY("guest_mobile")} = $3))`,
    [restaurantId, id, ten]
  );
  await run(
    "tableRequests",
    `UPDATE table_requests SET guest_name = NULL, guest_mobile = NULL
     WHERE restaurant_id = $1 AND $2::text IS NOT NULL AND ${MOBILE_KEY("guest_mobile")} = $2`,
    [restaurantId, ten]
  );
  await client.query(
    `UPDATE customer_merges SET merged_name = NULL, merged_mobile = NULL
     WHERE restaurant_id = $1 AND kept_customer_id = $2`,
    [restaurantId, id]
  );
  await client.query(
    `UPDATE customer_mobile_cleanup SET old_mobile = NULL, old_notes = NULL
     WHERE restaurant_id = $1 AND customer_id = $2`,
    [restaurantId, id]
  );

  const result = await client.query(
    `UPDATE customers
     SET name = 'Erased guest #' || id,
         mobile = NULL, email = NULL, address = NULL, date_of_birth = NULL, anniversary_date = NULL, notes = NULL,
         company_name = NULL, gstin = NULL, tags = '{}', allergies = NULL,
         marketing_opt_in = FALSE, marketing_opt_in_at = NULL, marketing_opt_in_by = NULL,
         duplicate_of = NULL, status = 'inactive',
         erased_at = NOW(), erased_by = $3, updated_by = $3
     WHERE restaurant_id = $1 AND id = $2
     RETURNING ${CUSTOMER_COLUMNS}`,
    [restaurantId, id, userId]
  );

  // Nobody should be left pointing at an erased record as "probably the same
  // person": there is no person left to compare.
  await client.query(
    "UPDATE customers SET duplicate_of = NULL WHERE restaurant_id = $1 AND duplicate_of = $2",
    [restaurantId, id]
  );

  return { customer: result.rows[0], cleared };
};

// What is still running for a guest when they are erased: an order not yet
// paid, a booking not yet seated, a party still waiting. Left linked, each
// would go on filling the erased record: the order earns points when it is
// paid, and seating the booking opens an order in the guest's name. They
// carry on as walk-ins instead. Finished orders stay linked, so the visit
// counts and sales of the record still add up.
const detachLiveRecords = async (client, restaurantId, customerId) => {
  const orders = await client.query(
    `UPDATE orders SET customer_id = NULL
     WHERE restaurant_id = $1 AND customer_id = $2 AND order_status IN ('open', 'billed')`,
    [restaurantId, customerId]
  );
  const bookings = await client.query(
    `UPDATE reservations SET customer_id = NULL
     WHERE restaurant_id = $1 AND customer_id = $2 AND status IN ('booked', 'confirmed')`,
    [restaurantId, customerId]
  );
  const waiting = await client.query(
    `UPDATE waitlist_entries SET customer_id = NULL
     WHERE restaurant_id = $1 AND customer_id = $2 AND status = 'waiting'`,
    [restaurantId, customerId]
  );

  return { openOrders: orders.rowCount, upcomingBookings: bookings.rowCount, waiting: waiting.rowCount };
};

// --- Opening one guest's number on purpose ---

// How many different guests' contact details this person has opened in the
// last day (the activity log is the record of it).
const countContactViews = async (restaurantId, userId, hours = 24) => {
  const result = await pool.query(
    `SELECT COUNT(DISTINCT entity_id)::int AS guests
     FROM audit_logs
     WHERE restaurant_id = $1 AND user_id = $2 AND action = 'view_contact' AND entity_type = 'customer'
       AND created_at > NOW() - make_interval(hours => $3::int)`,
    [restaurantId, userId, hours]
  );

  return result.rows[0].guests;
};

// Opening a guest's contact details, decided and written in one transaction
// the caller holds: a lock per person first, so twenty requests sent at once
// are counted one after another rather than all reading "0 so far" before
// any of them is written down.
const lockContactViews = async (client, restaurantId, userId) => {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `crm.view_contact:${restaurantId}:${userId}`,
  ]);
};

// { guests: different guests opened in the last day, seen: whether this one
// was among them }, read inside the caller's transaction.
const contactViewsToday = async (client, restaurantId, userId, customerId, hours = 24) => {
  const result = await client.query(
    `SELECT COUNT(DISTINCT entity_id)::int AS guests,
            COALESCE(BOOL_OR(entity_id = $3), FALSE) AS seen
     FROM audit_logs
     WHERE restaurant_id = $1 AND user_id = $2 AND action = 'view_contact' AND entity_type = 'customer'
       AND created_at > NOW() - make_interval(hours => $4::int)`,
    [restaurantId, userId, customerId, hours]
  );

  return result.rows[0];
};

// The activity-log row for an opening, written in the same transaction as the
// count (the same row utils/audit.js logAction writes).
const recordContactView = async (client, entry) => {
  await client.query(
    `INSERT INTO audit_logs (restaurant_id, user_id, user_name, action, entity_type, entity_id, entity_label)
     VALUES ($1, $2, $3, 'view_contact', 'customer', $4, $5)`,
    [entry.restaurantId, entry.userId, entry.userName || null, entry.customerId, entry.label || null]
  );
};

const hasViewedContact = async (restaurantId, userId, customerId, hours = 24) => {
  const result = await pool.query(
    `SELECT 1 FROM audit_logs
     WHERE restaurant_id = $1 AND user_id = $2 AND action = 'view_contact' AND entity_type = 'customer'
       AND entity_id = $3 AND created_at > NOW() - make_interval(hours => $4::int)
     LIMIT 1`,
    [restaurantId, userId, customerId, hours]
  );

  return result.rows.length > 0;
};

// --- Feedback ---

const findFeedback = async (restaurantId, filters = {}) => {
  const result = await pool.query(
    `SELECT f.id, f.customer_id, f.customer_name, f.customer_mobile, f.rating, f.comments,
            f.source, f.feedback_status, f.created_at,
            c.name AS linked_customer_name
     FROM feedback f
     LEFT JOIN customers c ON c.id = f.customer_id
     WHERE f.restaurant_id = $1
       AND ($2::text IS NULL OR f.feedback_status = $2)
     ORDER BY f.created_at DESC
     LIMIT 200`,
    [restaurantId, filters.status || null]
  );

  return result.rows;
};

// A page of feedback, newest first, with how many there are in all. Search
// reads the guest's name, their mobile (any way it was written) and the
// comment itself.
const findFeedbackPage = async (restaurantId, filters = {}) => {
  const {
    status = null,
    rating = null,
    name = null,
    digits = null,
    mobilePattern = null,
    limit = 25,
    offset = 0,
  } = filters;

  const read = (pageLimit, pageOffset) => pool.query(
    `SELECT f.id, f.customer_id, f.customer_name, f.customer_mobile, f.rating, f.comments,
            f.source, f.feedback_status, f.created_at,
            c.name AS linked_customer_name,
            COUNT(*) OVER ()::int AS total_count
     FROM feedback f
     LEFT JOIN customers c ON c.id = f.customer_id
     WHERE f.restaurant_id = $1
       AND ($2::text IS NULL OR f.feedback_status = $2)
       AND ($3::text IS NULL OR
            (($3 = 'unhappy' AND f.rating <= 2) OR ($3 = 'happy' AND f.rating >= 4)
             OR ($3 = 'neutral' AND f.rating = 3)))
       AND (
         ($4::text IS NULL AND $5::text IS NULL)
         OR ($5::text <> '' AND f.customer_mobile IS NOT NULL AND ${MOBILE_KEY("f.customer_mobile")} LIKE $5)
         OR ($4::text IS NOT NULL AND (COALESCE(c.name, f.customer_name) ILIKE '%' || $4 || '%' ESCAPE '\\'
                                       OR f.comments ILIKE '%' || $4 || '%' ESCAPE '\\'))
       )
     ORDER BY f.created_at DESC, f.id DESC
     LIMIT $6 OFFSET $7`,
    [
      restaurantId,
      status,
      rating,
      name === null ? null : likeText(name),
      mobilePatternOf({ mobilePattern, digits }),
      pageLimit,
      pageOffset,
    ]
  );

  const result = await read(limit, offset);

  return { rows: result.rows, total: await pageTotal(result, offset, () => read(1, 0)) };
};

const findFeedbackById = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT f.id, f.customer_id, f.customer_name, f.customer_mobile, f.rating, f.comments,
            f.source, f.feedback_status, f.created_at,
            c.name AS linked_customer_name
     FROM feedback f
     LEFT JOIN customers c ON c.id = f.customer_id
     WHERE f.restaurant_id = $1 AND f.id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

const countFeedback = async (restaurantId, filters = {}) => {
  const page = await findFeedbackPage(restaurantId, { ...filters, limit: 1, offset: 0 });
  return page.total || 0;
};

const createFeedback = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO feedback (restaurant_id, customer_id, customer_name, customer_mobile,
                           rating, comments, source, feedback_status, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     RETURNING id`,
    [
      restaurantId,
      data.customerId,
      data.customerName,
      data.customerMobile,
      data.rating,
      data.comments,
      data.source,
      data.feedbackStatus,
      userId,
    ]
  );

  return result.rows[0].id;
};

const updateFeedbackStatus = async (restaurantId, id, status, userId) => {
  const result = await pool.query(
    `UPDATE feedback SET feedback_status = $3, updated_by = $4
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id`,
    [restaurantId, id, status, userId]
  );

  return result.rows[0] || null;
};

// Average rating and the count per star, for the summary on the feedback screen.
const feedbackSummary = async (restaurantId) => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COALESCE(ROUND(AVG(rating)::numeric, 2), 0) AS average,
            COUNT(*) FILTER (WHERE rating >= 4)::int AS happy,
            COUNT(*) FILTER (WHERE rating <= 2)::int AS unhappy,
            COUNT(*) FILTER (WHERE feedback_status = 'new')::int AS unread
     FROM feedback
     WHERE restaurant_id = $1`,
    [restaurantId]
  );

  return result.rows[0];
};

// --- Complaints ---

const COMPLAINT_COLUMNS = `c.id, c.customer_id, c.customer_name, c.customer_mobile, c.subject,
                           c.description, c.category, c.priority, c.complaint_status,
                           c.assigned_to, c.resolution, c.resolved_at, c.created_at,
                           c.bill_id, c.order_id, c.compensation_type, c.compensation_value,
                           c.compensation_notes, c.outlet_id,
                           b.bill_number, o.order_number`;

const COMPLAINT_JOINS = `LEFT JOIN users u ON u.id = c.assigned_to
     LEFT JOIN bills b ON b.id = c.bill_id
     LEFT JOIN orders o ON o.id = c.order_id`;

const findComplaints = async (restaurantId, filters = {}) => {
  const result = await pool.query(
    `SELECT ${COMPLAINT_COLUMNS}, u.name AS assigned_to_name
     FROM complaints c
     ${COMPLAINT_JOINS}
     WHERE c.restaurant_id = $1
       AND ($2::text[] IS NULL OR c.complaint_status = ANY($2))
     ORDER BY
       CASE c.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
       c.created_at DESC
     LIMIT 200`,
    [restaurantId, filters.status || null]
  );

  return result.rows;
};

// A page of complaints: open and urgent first, with how many match in all.
const findComplaintsPage = async (restaurantId, filters = {}) => {
  const { status = null, name = null, digits = null, mobilePattern = null, limit = 25, offset = 0, outletId = null, oldestFirst = false } = filters;

  const read = (pageLimit, pageOffset) => pool.query(
    `SELECT ${COMPLAINT_COLUMNS}, u.name AS assigned_to_name,
            COUNT(*) OVER ()::int AS total_count
     FROM complaints c
     ${COMPLAINT_JOINS}
     WHERE c.restaurant_id = $1
       AND ($2::text[] IS NULL OR c.complaint_status = ANY($2))
       AND (
         ($3::text IS NULL AND $4::text IS NULL)
         OR ($7::text <> '' AND c.customer_mobile IS NOT NULL AND ${MOBILE_KEY("c.customer_mobile")} LIKE $7)
         OR ($4::text IS NOT NULL AND (b.bill_number LIKE '%' || $4 || '%'
                                       OR o.order_number LIKE '%' || $4 || '%'))
         OR ($3::text IS NOT NULL AND (c.subject ILIKE '%' || $3 || '%' ESCAPE '\\'
                                       OR c.customer_name ILIKE '%' || $3 || '%' ESCAPE '\\'
                                       OR c.description ILIKE '%' || $3 || '%' ESCAPE '\\'
                                       OR b.bill_number ILIKE '%' || $3 || '%' ESCAPE '\\'
                                       OR o.order_number ILIKE '%' || $3 || '%' ESCAPE '\\'))
       )
       -- One outlet's complaints (the dashboard's count with an outlet chosen).
       AND ($8::bigint IS NULL OR c.outlet_id = $8::bigint)
     ORDER BY
       CASE WHEN c.complaint_status IN ('open', 'in_progress') THEN 0 ELSE 1 END,
       CASE c.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
       -- ?sort=age: the longest-waiting first within each priority (the
       -- complaints screen's "Still open" view); otherwise newest first.
       ${oldestFirst ? "c.created_at ASC, c.id ASC" : "c.created_at DESC, c.id DESC"}
     LIMIT $5 OFFSET $6`,
    [
      restaurantId,
      status,
      name === null ? null : likeText(name),
      digits,
      pageLimit,
      pageOffset,
      mobilePatternOf({ mobilePattern, digits }),
      outletId,
    ]
  );

  const result = await read(limit, offset);

  return { rows: result.rows, total: await pageTotal(result, offset, () => read(1, 0)) };
};

const findComplaintById = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT ${COMPLAINT_COLUMNS}, u.name AS assigned_to_name
     FROM complaints c
     ${COMPLAINT_JOINS}
     WHERE c.restaurant_id = $1 AND c.id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

const createComplaint = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO complaints (restaurant_id, customer_id, customer_name, customer_mobile,
                             subject, description, category, priority, complaint_status,
                             assigned_to, created_by, updated_by,
                             bill_id, order_id, compensation_type, compensation_value,
                             compensation_notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12, $13, $14, $15, $16)
     RETURNING id`,
    [
      restaurantId,
      data.customerId,
      data.customerName,
      data.customerMobile,
      data.subject,
      data.description,
      data.category,
      data.priority,
      data.complaintStatus,
      data.assignedTo,
      userId,
      data.billId ?? null,
      data.orderId ?? null,
      data.compensationType ?? null,
      data.compensationValue ?? 0,
      data.compensationNotes ?? null,
    ]
  );

  return result.rows[0].id;
};

// resolved_at is stamped by the database the moment the status becomes resolved
// or closed, and cleared if the complaint is reopened. The bill link and the
// compensation are changed only when the edit carries them.
const updateComplaint = async (restaurantId, id, data, userId) => {
  const values = [
    restaurantId,
    id,
    data.subject,
    data.description,
    data.category,
    data.priority,
    data.complaintStatus,
    data.assignedTo,
    data.resolution,
    userId,
  ];
  const sets = [
    "subject = $3",
    "description = $4",
    "category = $5",
    "priority = $6",
    // $7 is both stored and compared, so it is cast the same way in both
    // places; otherwise PostgreSQL deduces two types for one parameter.
    "complaint_status = $7::varchar",
    "assigned_to = $8",
    "resolution = $9",
    `resolved_at = CASE WHEN $7::varchar IN ('resolved', 'closed')
                        THEN COALESCE(resolved_at, NOW())
                        ELSE NULL END`,
    "updated_by = $10",
  ];

  for (const [field, column] of [
    ["billId", "bill_id"],
    ["orderId", "order_id"],
    ["customerId", "customer_id"],
    ["customerName", "customer_name"],
    ["customerMobile", "customer_mobile"],
    ["compensationType", "compensation_type"],
    ["compensationValue", "compensation_value"],
    ["compensationNotes", "compensation_notes"],
  ]) {
    if (data[field] !== undefined) {
      values.push(data[field]);
      sets.push(`${column} = $${values.length}`);
    }
  }

  const result = await pool.query(
    `UPDATE complaints
     SET ${sets.join(", ")}
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id`,
    values
  );

  return result.rows[0] || null;
};

const complaintSummary = async (restaurantId) => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE complaint_status = 'open')::int AS open,
            COUNT(*) FILTER (WHERE complaint_status = 'in_progress')::int AS in_progress,
            COUNT(*) FILTER (WHERE complaint_status IN ('resolved', 'closed'))::int AS resolved
     FROM complaints
     WHERE restaurant_id = $1`,
    [restaurantId]
  );

  return result.rows[0];
};

// What putting things right has cost, this month and in all, and how quickly
// complaints are closed.
const complaintCosts = async (restaurantId, timezone) => {
  const result = await pool.query(
    `SELECT COALESCE(SUM(compensation_value) FILTER (
              WHERE DATE_TRUNC('month', created_at AT TIME ZONE $2)
                    = DATE_TRUNC('month', NOW() AT TIME ZONE $2)), 0) AS compensation_month,
            COALESCE(SUM(compensation_value), 0) AS compensation_total,
            COUNT(*) FILTER (WHERE compensation_type IS NOT NULL)::int AS compensated,
            COUNT(*) FILTER (WHERE bill_id IS NOT NULL OR order_id IS NOT NULL)::int AS linked,
            ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600)
                  FILTER (WHERE resolved_at IS NOT NULL)::numeric, 1) AS hours_to_resolve
     FROM complaints
     WHERE restaurant_id = $1`,
    [restaurantId, timezone]
  );

  return result.rows[0];
};

// Who a complaint can be handed to: this restaurant's own active staff.
const findAssignees = async (restaurantId) => {
  const result = await pool.query(
    `SELECT u.id, u.name,
            (SELECT STRING_AGG(r.name, ', ' ORDER BY r.name)
             FROM user_roles ur JOIN roles r ON r.id = ur.role_id
             WHERE ur.user_id = u.id) AS roles
     FROM users u
     WHERE u.restaurant_id = $1 AND u.status = 'active'
     ORDER BY LOWER(u.name)`,
    [restaurantId]
  );

  return result.rows;
};

const findAssignee = async (restaurantId, userId) => {
  const result = await pool.query(
    "SELECT id, name, status FROM users WHERE restaurant_id = $1 AND id = $2",
    [restaurantId, userId]
  );

  return result.rows[0] || null;
};

// A bill or order a complaint is about, by the number printed on it. Typing
// just "42" finds INV-0042 when only one bill ends that way.
const findBillsByNumber = async (restaurantId, text) => {
  const typed = String(text).trim();
  const digitsOnly = /^\d+$/.test(typed);

  const result = await pool.query(
    `SELECT b.id AS bill_id, b.bill_number, b.total_amount, b.bill_status, b.billed_at,
            o.id AS order_id, o.order_number, o.order_type, o.placed_at, o.order_status,
            o.customer_id, COALESCE(g.name, o.customer_name) AS guest_name,
            COALESCE(g.mobile, o.customer_mobile) AS guest_mobile
     FROM bills b
     JOIN orders o ON o.id = b.order_id
     LEFT JOIN customers g ON g.id = o.customer_id
     WHERE b.restaurant_id = $1
       AND (UPPER(b.bill_number) = UPPER($2)
            OR ($3::boolean AND b.bill_number ~ ('(^|[^0-9])0*' || LTRIM($2, '0') || '$')))
     ORDER BY b.billed_at DESC, b.id DESC
     LIMIT 5`,
    [restaurantId, typed, digitsOnly]
  );

  return result.rows;
};

const findOrdersByNumber = async (restaurantId, text) => {
  const typed = String(text).trim();
  const digitsOnly = /^\d+$/.test(typed);

  const result = await pool.query(
    `SELECT NULL::bigint AS bill_id, NULL::text AS bill_number,
            o.total_amount, NULL::text AS bill_status, NULL::timestamptz AS billed_at,
            o.id AS order_id, o.order_number, o.order_type, o.placed_at, o.order_status,
            o.customer_id, COALESCE(g.name, o.customer_name) AS guest_name,
            COALESCE(g.mobile, o.customer_mobile) AS guest_mobile,
            (SELECT b.id FROM bills b WHERE b.order_id = o.id AND b.bill_status <> 'void'
             ORDER BY b.id DESC LIMIT 1) AS latest_bill_id,
            (SELECT b.bill_number FROM bills b WHERE b.order_id = o.id AND b.bill_status <> 'void'
             ORDER BY b.id DESC LIMIT 1) AS latest_bill_number
     FROM orders o
     LEFT JOIN customers g ON g.id = o.customer_id
     WHERE o.restaurant_id = $1
       AND (UPPER(o.order_number) = UPPER($2)
            OR ($3::boolean AND o.order_number ~ ('(^|[^0-9])0*' || LTRIM($2, '0') || '$')))
     ORDER BY o.placed_at DESC, o.id DESC
     LIMIT 5`,
    [restaurantId, typed, digitsOnly]
  );

  return result.rows;
};

const findBillLink = async (restaurantId, billId) => {
  const result = await pool.query(
    `SELECT b.id AS bill_id, b.bill_number, b.order_id, o.customer_id
     FROM bills b JOIN orders o ON o.id = b.order_id
     WHERE b.restaurant_id = $1 AND b.id = $2`,
    [restaurantId, billId]
  );

  return result.rows[0] || null;
};

const findOrderLink = async (restaurantId, orderId) => {
  const result = await pool.query(
    `SELECT o.id AS order_id, o.order_number, o.customer_id
     FROM orders o
     WHERE o.restaurant_id = $1 AND o.id = $2`,
    [restaurantId, orderId]
  );

  return result.rows[0] || null;
};

// --- Reports ---

const findReportContext = async (restaurantId) => {
  const result = await pool.query(
    `SELECT COALESCE(rs.timezone, 'Asia/Kolkata') AS timezone,
            COALESCE(rs.currency_symbol, '₹') AS currency_symbol,
            ('guest_loyalty' = ANY (restaurant_features(r.id))) AS loyalty_enabled,
            COALESCE(rs.loyalty_point_value, 1) AS loyalty_point_value,
            COALESCE(rs.loyalty_earn_amount, 100) AS loyalty_earn_amount,
            (NOW() AT TIME ZONE COALESCE(rs.timezone, 'Asia/Kolkata'))::date AS today
     FROM restaurants r
     LEFT JOIN restaurant_settings rs ON rs.restaurant_id = r.id
     WHERE r.id = $1`,
    [restaurantId]
  );

  return result.rows[0] || null;
};

// The day a points movement belongs to: the business day of its bill when it
// has one (a redemption at 00:30 belongs to the night before), otherwise the
// restaurant's own calendar day.
const LEDGER_DAY = `COALESCE(bd.business_date, (lt.created_at AT TIME ZONE $2)::date)`;

// Every movement in the period, sorted into what it was:
//   earned    points given on a paid bill
//   redeemed  points spent on a bill that was not later voided
//   returned  points taken back or given back on a bill (refunds)
//   manual    points added or removed by hand
//   opening   balances brought over from an old system by the guest import
//   expired   points cancelled (expiry, or a guest's data erased)
// A redemption on a bill that was voided, and the points handed back by that
// void, cancel out and are left out of both columns.
const LEDGER_KIND = `CASE
    WHEN lt.entry_type = 'earn' THEN 'earned'
    WHEN lt.entry_type = 'redeem' THEN 'redeemed'
    WHEN lt.entry_type = 'expire' THEN 'expired'
    WHEN lt.bill_id IS NULL AND lt.notes = 'Opening balance (import)' THEN 'opening'
    WHEN lt.bill_id IS NULL THEN 'manual'
    ELSE 'returned' END`;

const LEDGER_FROM = `FROM loyalty_transactions lt
     LEFT JOIN bills b ON b.id = lt.bill_id
     LEFT JOIN business_days bd ON bd.id = b.business_day_id
     WHERE lt.restaurant_id = $1
       AND NOT (lt.bill_id IS NOT NULL AND b.bill_status = 'void' AND lt.entry_type IN ('redeem', 'adjust'))
       AND ${LEDGER_DAY} BETWEEN $3::date AND $4::date`;

const loyaltyTotals = async (restaurantId, timezone, from, to) => {
  const result = await pool.query(
    `SELECT ${LEDGER_KIND} AS kind,
            COALESCE(SUM(lt.points), 0)::int AS points,
            COALESCE(SUM(lt.amount) FILTER (WHERE lt.entry_type = 'redeem'), 0) AS amount,
            COUNT(*)::int AS entries,
            COUNT(DISTINCT lt.bill_id)::int AS bills
     ${LEDGER_FROM}
     GROUP BY 1`,
    [restaurantId, timezone, from, to]
  );

  return result.rows;
};

const loyaltyByDay = async (restaurantId, timezone, from, to) => {
  const result = await pool.query(
    `SELECT ${LEDGER_DAY} AS day,
            COALESCE(SUM(lt.points) FILTER (WHERE lt.entry_type = 'earn'), 0)::int AS earned,
            COALESCE(-SUM(lt.points) FILTER (WHERE lt.entry_type = 'redeem'), 0)::int AS redeemed,
            COALESCE(SUM(lt.amount) FILTER (WHERE lt.entry_type = 'redeem'), 0) AS redeemed_value,
            COUNT(DISTINCT lt.bill_id) FILTER (WHERE lt.entry_type = 'redeem')::int AS redeemed_bills,
            COALESCE(SUM(lt.points) FILTER (WHERE lt.entry_type NOT IN ('earn', 'redeem')), 0)::int AS other
     ${LEDGER_FROM}
     GROUP BY 1
     ORDER BY 1`,
    [restaurantId, timezone, from, to]
  );

  return result.rows;
};

// Points owed right now, the liability the accountant carries.
const pointsOwed = async (restaurantId) => {
  const result = await pool.query(
    `SELECT COALESCE(SUM(loyalty_points), 0)::int AS points,
            COUNT(*) FILTER (WHERE loyalty_points > 0)::int AS guests
     FROM customers
     WHERE restaurant_id = $1`,
    [restaurantId]
  );

  return result.rows[0];
};

const findPointHolders = async (restaurantId, { limit = 25, offset = 0 } = {}) => {
  const read = (pageLimit, pageOffset) => pool.query(
    `SELECT c.id, c.name, c.mobile, c.loyalty_points, c.tags,
            (SELECT MAX(o.placed_at) FROM orders o
             WHERE o.restaurant_id = $1 AND o.customer_id = c.id AND o.order_status <> 'cancelled') AS last_visit,
            COUNT(*) OVER ()::int AS total_count
     FROM customers c
     WHERE c.restaurant_id = $1 AND c.loyalty_points > 0
     ORDER BY c.loyalty_points DESC, LOWER(c.name), c.id
     LIMIT $2 OFFSET $3`,
    [restaurantId, pageLimit, pageOffset]
  );

  const result = await read(limit, offset);

  return { rows: result.rows, total: await pageTotal(result, offset, () => read(1, 0)) };
};

// Sales by guest between two business dates, bills on the business day they
// were raised (the restaurant's calendar day when no day was open).
const BILL_DAY = `COALESCE(bd.business_date, (b.billed_at AT TIME ZONE $2)::date)`;

const CUSTOMER_SALES_SORTS = {
  spend: "s.spend",
  visits: "s.visits",
  bills: "s.bills",
  average: "s.spend / NULLIF(s.visits, 0)",
  lastVisit: "s.last_bill",
  name: "LOWER(c.name)",
};

const customerSales = async (restaurantId, timezone, from, to, options = {}) => {
  const {
    sort = "spend",
    ascending = false,
    limit = 25,
    offset = 0,
    name = null,
    digits = null,
    mobilePattern = null,
  } = options;
  const orderBy = CUSTOMER_SALES_SORTS[sort] || CUSTOMER_SALES_SORTS.spend;

  const read = (pageLimit, pageOffset) => pool.query(
    `WITH sales AS (
       SELECT o.customer_id,
              COUNT(DISTINCT o.id)::int AS visits,
              COUNT(*)::int AS bills,
              SUM(${NET_OF_REFUNDS("b")}) AS spend,
              SUM(b.discount_amount) AS discounts,
              SUM(b.loyalty_discount) AS points_value,
              MAX(b.billed_at) AS last_bill
       FROM bills b
       JOIN orders o ON o.id = b.order_id
       LEFT JOIN business_days bd ON bd.id = b.business_day_id
       WHERE b.restaurant_id = $1 AND b.bill_status <> 'void' AND o.customer_id IS NOT NULL
         AND ${BILL_DAY} BETWEEN $3::date AND $4::date
       GROUP BY o.customer_id
     )
     SELECT c.id, c.name, c.mobile, c.tags, c.company_name, c.gstin, c.erased_at,
            s.visits, s.bills, s.spend, s.discounts, s.points_value, s.last_bill,
            COUNT(*) OVER ()::int AS total_count
     FROM sales s
     JOIN customers c ON c.id = s.customer_id AND c.restaurant_id = $1
     WHERE ($7::text IS NULL AND $8::text IS NULL)
        OR ($8::text <> '' AND c.mobile LIKE $8)
        OR ($7::text IS NOT NULL AND (c.name ILIKE '%' || $7 || '%' ESCAPE '\\'
                                      OR c.company_name ILIKE '%' || $7 || '%' ESCAPE '\\'))
     ORDER BY ${orderBy} ${ascending ? "ASC" : "DESC"} NULLS LAST, LOWER(c.name), c.id
     LIMIT $5 OFFSET $6`,
    [
      restaurantId,
      timezone,
      from,
      to,
      pageLimit,
      pageOffset,
      name === null ? null : likeText(name),
      mobilePatternOf({ mobilePattern, digits }),
    ]
  );

  const result = await read(limit, offset);

  return { rows: result.rows, total: await pageTotal(result, offset, () => read(1, 0)) };
};

// All sales in the period, split into guests in the book and everyone else,
// so the report can say what share of the takings the guest book explains.
const salesSplit = async (restaurantId, timezone, from, to) => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS bills,
            COALESCE(SUM(${NET_OF_REFUNDS("b")}), 0) AS sales,
            COUNT(*) FILTER (WHERE o.customer_id IS NOT NULL)::int AS guest_bills,
            COALESCE(SUM(${NET_OF_REFUNDS("b")}) FILTER (WHERE o.customer_id IS NOT NULL), 0) AS guest_sales,
            COUNT(DISTINCT o.customer_id)::int AS guests
     FROM bills b
     JOIN orders o ON o.id = b.order_id
     LEFT JOIN business_days bd ON bd.id = b.business_day_id
     WHERE b.restaurant_id = $1 AND b.bill_status <> 'void'
       AND ${BILL_DAY} BETWEEN $3::date AND $4::date`,
    [restaurantId, timezone, from, to]
  );

  return result.rows[0];
};

module.exports = {
  findCustomers,
  searchCustomers,
  findCustomerById,
  findCustomerByMobile,
  findCustomersByMobiles,
  lockMobile,
  createCustomer,
  updateCustomer,
  removeCustomer,
  findGuestBook,
  findGuestBookForExport,
  guestBookCounts,
  findVisitsForCustomer,
  customerTotals,
  findMergesInto,
  historyCounts,
  findDuplicatePairs,
  clearDuplicateMark,
  lockCustomers,
  lockGuestBillsAndOrders,
  findGuestReferences,
  moveGuestReferences,
  recomputeLedger,
  absorbCustomer,
  deleteMergedCustomer,
  recordMerge,
  recordInvoiceBuyer,
  backfillInvoiceBuyerAddresses,
  countOrdinaryBills,
  eraseCustomer,
  detachLiveRecords,
  countContactViews,
  hasViewedContact,
  lockContactViews,
  contactViewsToday,
  recordContactView,
  findFeedback,
  findFeedbackPage,
  findFeedbackById,
  countFeedback,
  createFeedback,
  updateFeedbackStatus,
  feedbackSummary,
  findComplaints,
  findComplaintsPage,
  findComplaintById,
  createComplaint,
  updateComplaint,
  complaintSummary,
  complaintCosts,
  findAssignees,
  findAssignee,
  findBillsByNumber,
  findOrdersByNumber,
  findBillLink,
  findOrderLink,
  findReportContext,
  loyaltyTotals,
  loyaltyByDay,
  pointsOwed,
  findPointHolders,
  customerSales,
  salesSplit,
};
