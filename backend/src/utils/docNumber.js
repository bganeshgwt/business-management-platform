// The next number in a per-restaurant series: PO-0007, GRN-0012, SC-0003.
//
// Purchase orders used to be numbered COUNT(*) + 1. Deleting an older draft
// lowered the count, so the next number was one already in use and every new
// order failed on the unique key until a developer stepped in.
//
// Taking "the highest number + 1" fixed that, but still handed out a number
// again when the newest draft was deleted — and a draft may already have been
// printed or sent on WhatsApp, so a supplier could hold two different orders
// with the same number. The series now keeps its own counter, which only ever
// goes up: a number, once given out, is never given out again. The counter
// is also never behind the documents themselves (numbers typed in or
// imported before it existed), so it cannot run into one either.
//
// Two tills saving at the same moment queue on the counter row (and on the
// advisory lock for the very first number of a series), for the rest of the
// transaction; they get different numbers.
//
// `client` must be inside a transaction (BEGIN already run).
const TABLES = {
  PO: { table: "purchase_orders", column: "po_number" },
  PR: { table: "purchase_returns", column: "return_number" },
  GRN: { table: "goods_receipts", column: "receipt_number" },
  SC: { table: "stock_counts", column: "count_number" },
};

const nextNumber = async (client, restaurantId, prefix) => {
  const series = TABLES[prefix];

  if (!series) {
    throw new Error(`Unknown number series ${prefix}`);
  }

  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `doc-number:${prefix}:${restaurantId}`,
  ]);

  // Only numbers in this exact shape count, so a hand-typed "PO-12A" or an
  // imported number from another system cannot break the series.
  const highest = await client.query(
    `SELECT COALESCE(MAX(SUBSTRING(${series.column} FROM '^${prefix}-([0-9]+)$')::int), 0) AS highest
     FROM ${series.table}
     WHERE restaurant_id = $1`,
    [restaurantId]
  );

  const result = await client.query(
    `INSERT INTO document_counters (restaurant_id, series, last_number)
     VALUES ($1, $2, $3 + 1)
     ON CONFLICT (restaurant_id, series)
     DO UPDATE SET last_number = GREATEST(document_counters.last_number, $3) + 1,
                   updated_at = NOW()
     RETURNING last_number`,
    [restaurantId, prefix, Number(highest.rows[0].highest)]
  );

  return `${prefix}-${String(result.rows[0].last_number).padStart(4, "0")}`;
};

module.exports = { nextNumber };
