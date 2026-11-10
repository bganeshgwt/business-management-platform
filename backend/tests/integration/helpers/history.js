// Moves a kept record (a posted bill, a payment, a stock movement) back in
// time for a test, as days passing would. The database keeps those records as
// they were saved (migration 1791990000070): only the login that owns the
// tables may rewrite them, and only in a transaction that asks for it. The
// API's requests in the same test never ask, so they stay held to the rule.
async function rewriteHistory(pool, sql, values = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.edit_history', 'on', true)");
    const result = await client.query(sql, values);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { rewriteHistory };
