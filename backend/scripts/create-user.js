// Creates a login user from the terminal (there is no sign-up page yet).
// Usage: npm run user:create
const readline = require("readline");
const bcrypt = require("bcrypt");
const pool = require("../src/config/database");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
const lines = rl[Symbol.asyncIterator]();

const ask = async (question) => {
  process.stdout.write(question);
  const { value } = await lines.next();
  return (value || "").trim();
};

async function main() {
  const restaurantCode = await ask("Restaurant code (leave empty for a platform Super Admin): ");
  const name = await ask("Full name: ");
  const email = (await ask("Email: ")).toLowerCase();
  const mobile = await ask("Mobile (optional): ");
  const password = await ask("Password (min 8 characters): ");
  const roleCode = restaurantCode
    ? (await ask("Role [RESTAURANT_ADMIN, MANAGER, CASHIER, CAPTAIN, KITCHEN, ACCOUNTANT, STORE_KEEPER]: ")).toUpperCase()
    : "SUPER_ADMIN";

  if (!name || !email || password.length < 8 || password.length > 72) {
    throw new Error("Name and email are required, and the password must be 8 to 72 characters.");
  }

  if (restaurantCode && roleCode === "SUPER_ADMIN") {
    throw new Error("SUPER_ADMIN is only for platform users without a restaurant.");
  }

  let restaurantId = null;

  if (restaurantCode) {
    const restaurant = await pool.query("SELECT id FROM restaurants WHERE code = $1", [restaurantCode]);

    if (restaurant.rows.length === 0) {
      throw new Error(`No restaurant found with code "${restaurantCode}".`);
    }

    restaurantId = restaurant.rows[0].id;
  }

  const role = await pool.query(
    "SELECT id FROM roles WHERE code = $1 AND restaurant_id IS NULL AND is_system = TRUE",
    [roleCode]
  );

  if (role.rows.length === 0) {
    throw new Error(`Unknown role "${roleCode}".`);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const client = await pool.connect();

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
    console.log(`\nCreated user #${user.rows[0].id} (${email}) with role ${roleCode}.`);
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

main()
  .catch((error) => {
    console.error(`\nFailed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    rl.close();
    await pool.end();
  });
