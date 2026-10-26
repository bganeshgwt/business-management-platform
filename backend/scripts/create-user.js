// Creates a login user from the terminal (there is no sign-up page yet).
// Usage: npm run user:create
//
// The same rules are exported as createUser(db, details) for code that makes
// a login itself: the browser tests make their platform admin with it, in
// their own database (e2e/global-setup.mjs).
//
// The password typed here is one someone else set, as every new login's is:
// the database marks it (migration 1791971000000), and the person chooses
// their own when they first sign in.
const readline = require("readline");
const bcrypt = require("bcrypt");

// Saves one login with its role, or nothing when a rule is broken (it throws
// with the reason). `db` is a pg pool. An empty restaurant code makes a
// platform Super Admin; a restaurant's user gets one of the built-in roles.
async function createUser(db, details) {
  const restaurantCode = String(details.restaurantCode || "").trim();
  const name = String(details.name || "").trim();
  const email = String(details.email || "").trim().toLowerCase();
  const mobile = String(details.mobile || "").trim();
  const password = String(details.password || "");
  const roleCode = restaurantCode ? String(details.roleCode || "").trim().toUpperCase() : "SUPER_ADMIN";

  if (!name || !email || password.length < 8 || password.length > 72) {
    throw new Error("Name and email are required, and the password must be 8 to 72 characters.");
  }

  if (restaurantCode && roleCode === "SUPER_ADMIN") {
    throw new Error("SUPER_ADMIN is only for platform users without a restaurant.");
  }

  let restaurantId = null;

  if (restaurantCode) {
    const restaurant = await db.query("SELECT id FROM restaurants WHERE code = $1", [restaurantCode]);

    if (restaurant.rows.length === 0) {
      throw new Error(`No restaurant found with code "${restaurantCode}".`);
    }

    restaurantId = restaurant.rows[0].id;
  }

  const role = await db.query(
    "SELECT id FROM roles WHERE code = $1 AND restaurant_id IS NULL AND is_system = TRUE",
    [roleCode]
  );

  if (role.rows.length === 0) {
    throw new Error(`Unknown role "${roleCode}".`);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const client = await db.connect();

  // The user and their role are saved together, or not at all.
  try {
    await client.query("BEGIN");

    const user = await client.query(
      `INSERT INTO users (restaurant_id, name, email, mobile, password_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [restaurantId, name, email, mobile || null, passwordHash]
    );

    await client.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [
      user.rows[0].id,
      role.rows[0].id,
    ]);

    await client.query("COMMIT");
    return { id: Number(user.rows[0].id), email, roleCode };
  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === "23505") {
      throw new Error("A user with this email or mobile already exists.");
    }

    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  // The API's own database settings (backend/.env), loaded only when run from
  // the terminal: code that imports createUser brings its own pool.
  const pool = require("../src/config/database");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const lines = rl[Symbol.asyncIterator]();

  const ask = async (question) => {
    process.stdout.write(question);
    const { value } = await lines.next();
    return (value || "").trim();
  };

  try {
    const restaurantCode = await ask("Restaurant code (leave empty for a platform Super Admin): ");
    const name = await ask("Full name: ");
    const email = (await ask("Email: ")).toLowerCase();
    const mobile = await ask("Mobile (optional): ");
    const password = await ask("Password (min 8 characters): ");
    const roleCode = restaurantCode
      ? (await ask("Role [RESTAURANT_ADMIN, MANAGER, CASHIER, CAPTAIN, KITCHEN, ACCOUNTANT, STORE_KEEPER]: ")).toUpperCase()
      : "SUPER_ADMIN";

    const user = await createUser(pool, { restaurantCode, name, email, mobile, password, roleCode });
    console.log(`\nCreated user #${user.id} (${user.email}) with role ${user.roleCode}.`);
    console.log("They choose their own password the first time they sign in.");
  } finally {
    rl.close();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\nFailed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { createUser };
