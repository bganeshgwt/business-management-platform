// The time machine of the realistic demo: runs one action through the app's own
// services (so totals, stock, ledgers and number series come out exactly as
// they would at the counter) and then dates what that action wrote to the
// moment it is supposed to have happened in the story.
//
// This is the back-dating the other demo scripts already do by hand after a
// posting (demo-retail.js and friends move created_at on the document and its
// payments, stock movements, discounts and points); here it is done once,
// generically:
//
//   - every row the action created (found by id above the high-water mark
//     taken just before it, and by business) gets its time stamps moved by
//     (when - now) and its calendar dates by the same number of days, so a
//     sale's due date or a repair's promised date stays where it belongs;
//   - rows the action only changed (a repair job delivered, an order closed)
//     are named by the caller in `touch` and get the stamps the action just
//     wrote moved the same way.
//
// What is never moved: the activity log (business_audit) and the events
// outbox, which keep the moment the data was really entered; and every row
// the database keeps append-only. Where a guard allows the time stamp alone
// to be corrected (points, discounts, cutting batches, wastage, exchanges,
// repair history, packages: "only the timestamp may be corrected
// (the demo set-up spreads sample records)"), only created_at moves; where a
// guard allows no change at all (collection receipts, supplier payment
// vouchers, credit vouchers, settlements, day closes, rate history,
// warranties), the row
// is left as posted, so the story uses those only for today.
//
// Stock lots carry no time stamp and are never moved; tasks, issues and
// projects are dated by the tasks seeding itself.
const repo = require('../../src/modules/business/core/repositories/business.repository');

const SKIP_TABLES = new Set(['business_stock_lots', 'business_tasks', 'business_task_items', 'business_task_history', 'business_task_comments', 'business_task_files',
  'business_task_assignees', 'business_task_schedules', 'business_task_templates', 'business_task_template_items', 'business_issues', 'business_projects',
  'business_project_lists', 'business_project_members', 'business_project_milestones',
  // The activity log, the events outbox and rows that may not change at all.
  'business_audit', 'business_events', 'business_collections', 'business_supplier_payments', 'wholesale_settlements', 'wholesale_settlement_receipts',
  'business_exchange_vouchers', 'business_exchange_voucher_uses', 'weight_day_closes', 'weight_rate_history', 'business_number_series', 'business_collection_cheques',
  'electronics_warranties']);
// Append-only rows whose guard allows the time stamp alone to be corrected.
const STAMP_ONLY = new Set(['retail_loyalty_entries', 'retail_sale_discounts', 'salon_line_staff', 'salon_membership_uses', 'salon_package_redemptions', 'salon_tips',
  'salon_client_notes', 'salon_commission_payouts', 'salon_client_plan_services', 'salon_client_plans', 'weight_processing_batches', 'weight_processing_outputs',
  'weight_wastage_entries', 'electronics_repair_events', 'business_exchanges',
  // Round 2: EMI cases and financier payouts (one-way / kept as recorded).
  'electronics_finance_cases', 'electronics_finance_settlements']);
// Rows keyed by their parent (no id of their own): found by their own stamp.
const CHILD_TABLES = { salon_appointment_details: 'created_at', salon_line_staff: 'created_at' };
const ANCHORS = ['created_at', 'changed_at', 'arrived_at'];

let tables = null; // [{ name, anchor, times: [...], dates: [...] }]
let markSql = null;
const touchSql = new Map();

async function init() {
  if (tables) return;
  const columns = await repo.all(repo.pool, `SELECT table_name AS t, column_name AS c, data_type AS type FROM information_schema.columns
    WHERE table_schema='public' AND table_name IN (SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='business_id')
    ORDER BY table_name, ordinal_position`);
  const byTable = new Map();
  for (const row of columns) {
    if (!byTable.has(row.t)) byTable.set(row.t, []);
    byTable.get(row.t).push(row);
  }
  tables = [];
  for (const [name, cols] of byTable) {
    if (SKIP_TABLES.has(name) || name.startsWith('restaurant') || name.startsWith('platform')) continue;
    const has = (c) => cols.some((x) => x.c === c);
    const stampOnly = STAMP_ONLY.has(name);
    const times = cols.filter((x) => x.type.startsWith('timestamp') && (!stampOnly || x.c === 'created_at')).map((x) => x.c);
    const dates = stampOnly ? [] : cols.filter((x) => x.type === 'date').map((x) => x.c);
    const entry = { name, times, dates, child: CHILD_TABLES[name] || null, hasId: has('id') && cols.find((x) => x.c === 'id').type === 'bigint' };
    entry.anchor = ANCHORS.find((a) => times.includes(a)) || null;
    if (!entry.anchor) continue;
    if (!entry.hasId && !entry.child) continue;
    tables.push(entry);
  }
  const idTables = tables.filter((t) => t.hasId);
  markSql = `SELECT clock_timestamp() AS now, ${idTables.map((t, i) => `(SELECT COALESCE(max(id),0) FROM ${t.name}) AS m${i}`).join(', ')}`;
  idTables.forEach((t, i) => { t.mark = `m${i}`; });
  for (const t of tables) {
    // New rows: every stamp the action wrote moves by the delta; dates by whole days.
    const sets = [
      ...t.times.map((c) => (c === t.anchor ? `${c} = ${c} + ($3::double precision * interval '1 millisecond')`
        : `${c} = CASE WHEN ${c} >= $2 THEN ${c} + ($3::double precision * interval '1 millisecond') ELSE ${c} END`)),
      ...t.dates.map((c) => `${c} = ${c} + $4::int`),
    ];
    t.sql = (skip) => {
      const list = sets.filter((s) => !skip.some((c) => s.startsWith(`${c} =`)));
      return t.hasId
        ? `UPDATE ${t.name} SET ${list.join(', ')} WHERE business_id = $1 AND id > $5 AND ${t.anchor} >= $2 AND $4::int IS NOT NULL`
        : `UPDATE ${t.name} SET ${list.join(', ')} WHERE business_id = $1 AND ${t.child} >= $2 AND $4::int IS NOT NULL`;
    };
  }
}

// Rows the action changed but did not create: their stamps written now move too.
function touchStatement(table, key) {
  const name = `${table}|${key}`;
  if (!touchSql.has(name)) {
    const t = tables.find((x) => x.name === table);
    const times = t ? t.times : ['updated_at'];
    touchSql.set(name, `UPDATE ${table} SET ${times.map((c) => `${c} = CASE WHEN ${c} >= $3 THEN ${c} + ($4::double precision * interval '1 millisecond') ELSE ${c} END`).join(', ')}
      WHERE business_id = $1 AND ${key} = $2`);
  }
  return touchSql.get(name);
}

const localDay = (date) => date.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const dayGap = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

// Runs `work` as if it happened at `when` (a Date in the past, or now).
// options.touch: [[table, keyColumn, keyValue], …] rows changed (not created).
// options.skip: columns not to move on new rows (e.g. a booking's own start).
// options.keepDates: calendar dates were given as meant (set-up), only stamps move.
async function at(businessId, when, work, { touch = [], skip = [], children = [], keepDates = false } = {}) {
  await init();
  const before = await repo.one(repo.pool, markSql);
  const result = await work();
  const delta = when.getTime() - new Date(before.now).getTime();
  // An action dated now (or a moment ago) stays as it is.
  if (Math.abs(delta) < 1000) return result;
  const after = await repo.one(repo.pool, markSql);
  const days = keepDates ? 0 : dayGap(localDay(new Date(before.now)), localDay(when));
  const start = before.now;
  for (const t of tables) {
    if (t.hasId) {
      if (Number(after[t.mark]) <= Number(before[t.mark])) continue;
      await repo.pool.query(t.sql(skip), [businessId, start, delta, days, before[t.mark]]);
    } else if (children.includes(t.name)) {
      await repo.pool.query(t.sql(skip), [businessId, start, delta, days]);
    }
  }
  for (const [table, key, value] of touch) await repo.pool.query(touchStatement(table, key), [businessId, value, start, delta]);
  return result;
}

module.exports = { at, init };
