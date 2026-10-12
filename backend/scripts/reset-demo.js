// Clears one restaurant's demo data so the demo can be seeded again.
//
//   npm run seed:reset -- <restaurantId>          shows what would be cleared
//   npm run seed:reset -- <restaurantId> --yes    clears it
//
// What stays: the restaurant itself, its users and their sign-in data, roles
// and permissions, tax rates, settings, outlets and opening hours — everything
// a restaurant is set up with, so `npm run seed:demo` can fill it again.
// What goes: every other row that belongs to the restaurant (menu, tables,
// stock, purchasing, guests, staff, orders, bills, reports' source data, the
// kitchen, reservations, deliveries, time clock, logs…).
//
// The list is not written out by hand. A hand-kept list fell behind every new
// module and then crashed on a seeded database; instead the tables, and a safe
// order to clear them in, are read from the database itself:
//   - a table with a restaurant_id column is cleared WHERE restaurant_id = $1;
//   - a detail table without one is cleared through its parent (its cascade
//     takes it, or it is cleared first through the parent's rows);
//   - children go before parents, so no foreign key ever blocks a delete.
// Everything runs in one transaction: it all happens, or nothing does. Other
// restaurants' rows are never touched.
//
// It refuses to run on a live server (NODE_ENV other than development/test).
const pool = require("../src/config/database");
const config = require("../src/config/env");

// Set-up that survives a reset. Tables are kept whole for this restaurant.
const KEEP = new Set([
  "restaurants",
  "users",
  "user_roles",
  "roles",
  "role_permissions",
  "permissions",
  "tax_rates",
  "restaurant_settings",
  "outlets",
  "business_hours",
  "kitchen_stations",
  "sales_channels",
  "leave_types",
  "pgmigrations",
]);

// Configuration tables (kitchen timers, floor cleaning time, payroll rules…) are
// set-up too, whatever their module: a reset removes demo data, not settings.
const isSettingsTable = (name) => /_settings$/.test(name);

// A user's own account data stays with the user (sessions, sign-in history,
// trusted devices, two-step secrets…), whatever the module calls the table.
const isUserAccountTable = (name) =>
  /^user_/.test(name) || /(session|sign_in|signin|login|two_factor|totp|recovery_code|trusted_device)/.test(name);

const quote = (name) => `"${name.replace(/"/g, '""')}"`;

const readSchema = async (client) => {
  const tables = (
    await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    )
  ).rows.map((r) => r.table_name);

  const scoped = new Set(
    (
      await client.query(
        `SELECT table_name FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name = 'restaurant_id'`
      )
    ).rows.map((r) => r.table_name)
  );

  // Every single-column foreign key: child.column -> parent, with its rule.
  const keys = (
    await client.query(
      `SELECT con.conname AS name,
              child.relname AS child, ccol.attname AS column,
              parent.relname AS parent,
              con.confdeltype AS rule,
              NOT ccol.attnotnull AS nullable
       FROM pg_constraint con
       JOIN pg_class child ON child.oid = con.conrelid
       JOIN pg_class parent ON parent.oid = con.confrelid
       JOIN pg_namespace ns ON ns.oid = child.relnamespace
       JOIN pg_attribute ccol ON ccol.attrelid = con.conrelid AND ccol.attnum = con.conkey[1]
       WHERE con.contype = 'f' AND ns.nspname = 'public' AND array_length(con.conkey, 1) = 1`
    )
  ).rows;

  return { tables, scoped, keys };
};

// Which tables to clear, and in which order.
const plan = ({ tables, scoped, keys }) => {
  const kept = (t) => KEEP.has(t) || isUserAccountTable(t) || isSettingsTable(t);
  const direct = tables.filter((t) => scoped.has(t) && !kept(t)); // WHERE restaurant_id = $1
  const directSet = new Set(direct);

  // Detail tables without restaurant_id whose parent is cleared.
  const details = tables.filter((t) => !scoped.has(t) && !kept(t) && keys.some((k) => k.child === t && directSet.has(k.parent)));
  const cascadeParent = {}; // detail -> the cleared parent whose delete cascades to it
  for (const t of details) {
    const k = keys.find((x) => x.child === t && directSet.has(x.parent) && x.rule === "c");
    if (k) cascadeParent[t] = k.parent;
  }
  // Details with no cascade from a cleared parent are cleared explicitly, first.
  const explicit = details.filter((t) => !cascadeParent[t]);

  // Order the directly cleared tables. "A goes before B" when A (or a detail
  // cascading from A) points at B with any rule but CASCADE. Tables that point at each other — orders and the
  // riders they name, say — form a group cleared in ONE statement: PostgreSQL
  // checks NO ACTION keys at the end of the statement, when both sides are gone.
  const owner = (t) => (directSet.has(t) ? t : cascadeParent[t]);
  const after = new Map(direct.map((t) => [t, new Set()])); // t -> tables that go after t
  const restrict = []; // RESTRICT is checked at once, so it cannot sit inside a group
  for (const k of keys) {
    // Only a cascade is harmless in any order. SET NULL / SET DEFAULT would
    // rewrite rows that are about to be deleted anyway — and a rewritten row can
    // break its own checks (a delivery that is out must name its rider) — so
    // the pointing table goes first, exactly as for NO ACTION.
    if (k.rule === "c") continue;
    // Both ends are seen through their owners: a credit-note line pointing at a
    // bill line means credit notes go before bills.
    const from = owner(k.child);
    const to = owner(k.parent);
    if (!from || !to || from === to) continue;
    after.get(from).add(to);
    if (k.rule === "r") restrict.push({ from, to, name: k.name });
  }

  // Strongly connected components (Tarjan): each is a group cleared together.
  // Tarjan finishes a group only after every group it points at, so reversing
  // its output puts each group before the groups that must go after it.
  let counter = 0;
  const stack = [];
  const onStack = new Set();
  const index = new Map();
  const low = new Map();
  const found = [];
  const visit = (v) => {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of after.get(v)) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) === index.get(v)) {
      const group = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        group.push(w);
      } while (w !== v);
      found.push(group.sort());
    }
  };
  for (const t of [...direct].sort()) if (!index.has(t)) visit(t);
  const groups = found.reverse();

  for (const g of groups) {
    const bad = restrict.find((r) => g.length > 1 && g.includes(r.from) && g.includes(r.to));
    if (bad) throw new Error(`${bad.from} and ${bad.to} point at each other through a RESTRICT key (${bad.name}); they cannot be cleared safely.`);
  }

  return { groups, explicit, keys, directSet, cascadeParent };
};

const main = async () => {
  const args = process.argv.slice(2);
  const restaurantId = Number(args.find((a) => /^\d+$/.test(a)));
  const confirmed = args.includes("--yes");

  if (config.isLive) {
    throw new Error("Refusing to clear data on a live server. This is a demo tool for development and test databases.");
  }
  if (!restaurantId) {
    console.log("Usage: npm run seed:reset -- <restaurantId> [--yes]\n  Without --yes it only shows what would be cleared.");
    return;
  }

  const client = await pool.connect();
  try {
    const restaurant = (await client.query("SELECT id, name FROM restaurants WHERE id = $1", [restaurantId])).rows[0];
    if (!restaurant) throw new Error(`No restaurant with id ${restaurantId}.`);

    const schema = await readSchema(client);
    const { groups, explicit, keys, directSet } = plan(schema);
    const order = groups.flat();

    // Rows of an explicitly cleared detail table that belong to this restaurant:
    // those pointing at any cleared parent row of this restaurant.
    const detailWhere = (t) =>
      keys
        .filter((k) => k.child === t && directSet.has(k.parent))
        .map((k) => `${quote(k.column)} IN (SELECT id FROM ${quote(k.parent)} WHERE restaurant_id = $1)`)
        .join(" OR ");

    // ---------------------------------------------------------------- preview
    const counts = [];
    for (const t of explicit) {
      const n = Number((await client.query(`SELECT COUNT(*) AS n FROM ${quote(t)} WHERE ${detailWhere(t)}`, [restaurantId])).rows[0].n);
      if (n) counts.push([t, n]);
    }
    for (const t of order) {
      const n = Number((await client.query(`SELECT COUNT(*) AS n FROM ${quote(t)} WHERE restaurant_id = $1`, [restaurantId])).rows[0].n);
      if (n) counts.push([t, n]);
    }
    const total = counts.reduce((s, [, n]) => s + n, 0);

    console.log(`\n${restaurant.name} (id ${restaurant.id}): ${total} rows in ${counts.length} tables ${confirmed ? "will now be cleared" : "would be cleared"}.`);
    for (const [t, n] of counts) console.log(`  ${String(n).padStart(7)}  ${t}`);
    console.log("  (detail rows that belong to these — order lines, bill lines, … — go with them)");
    console.log("Kept: the restaurant, its users and their sign-in data, roles, tax rates, settings, outlets and opening hours.");

    if (!confirmed) {
      console.log(`\nNothing was changed. To clear it: npm run seed:reset -- ${restaurant.id} --yes\n`);
      return;
    }

    // ---------------------------------------------------------------- clear
    await client.query("BEGIN");
    for (const t of explicit) {
      await client.query(`DELETE FROM ${quote(t)} WHERE ${detailWhere(t)}`, [restaurantId]);
    }
    for (const group of groups) {
      if (group.length === 1) {
        await client.query(`DELETE FROM ${quote(group[0])} WHERE restaurant_id = $1`, [restaurantId]);
      } else {
        // One statement for tables that point at each other (see plan()).
        const parts = group.map((t, i) => `d${i} AS (DELETE FROM ${quote(t)} WHERE restaurant_id = $1 RETURNING 1)`);
        await client.query(`WITH ${parts.join(", ")} SELECT ${group.map((_, i) => `(SELECT COUNT(*) FROM d${i})`).join(" + ")} AS cleared`, [restaurantId]);
      }
    }
    await client.query("COMMIT");

    console.log(`\nCleared ${total} rows. Run npm run seed:demo to fill the restaurant again.\n`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

main()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error(`Reset failed — nothing was changed: ${error.message}`);
    await pool.end();
    process.exit(1);
  });
