// Adds the five local demo roles without replacing existing accounts/passwords.
// Generated credentials stay in .local/ (gitignored), never in console output.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const bcrypt = require("bcrypt");
const config = require("../src/config/env");
const pool = require("../src/config/database");

async function main() {
  if (config.isLive) throw new Error("Demo accounts can only be created in development or test.");
  const code = process.argv[2];
  if (!code) throw new Error("Usage: npm run user:demo -- RESTAURANT_CODE");
  const client = await pool.connect();
  let credentialsPath;
  try {
    await client.query("BEGIN");
    const restaurant = (await client.query("SELECT id,name FROM restaurants WHERE code=$1 AND status='active'", [code])).rows[0];
    if (!restaurant) throw new Error("Active restaurant not found for that code.");
    const credentials = [];
    for (const [name, role] of [["Owner","RESTAURANT_ADMIN"],["Manager","MANAGER"],["Cashier","CASHIER"],["Captain","CAPTAIN"],["Kitchen","KITCHEN"]]) {
      const email = `${name.toLowerCase()}@foodex.com`;
      const existing = await client.query("SELECT id,restaurant_id FROM users WHERE LOWER(email)=LOWER($1)", [email]);
      if (existing.rows.length) {
        if (Number(existing.rows[0].restaurant_id) !== Number(restaurant.id)) {
          throw new Error(`${email} belongs to another restaurant; nothing was changed.`);
        }
        continue;
      }
      const password = crypto.randomBytes(18).toString("base64url");
      const pin = String(crypto.randomInt(0, 10000)).padStart(4, "0");
      const user = (await client.query(
        "INSERT INTO users(restaurant_id,name,email,password_hash,pin_hash,pin_set_at) VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING id",
        [restaurant.id,name,email,await bcrypt.hash(password,12),await bcrypt.hash(pin,12)]
      )).rows[0];
      const linked = await client.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code=$2 AND restaurant_id IS NULL AND is_system=true RETURNING role_id", [user.id,role]);
      if (linked.rowCount !== 1) throw new Error(`System role ${role} is missing.`);
      credentials.push({ role, email, password, pin });
    }
    if (credentials.length) {
      const directory = path.resolve(__dirname,"../.local");
      fs.mkdirSync(directory,{recursive:true});
      credentialsPath = path.join(directory,`demo-logins-${crypto.randomBytes(6).toString("hex")}.json`);
      fs.writeFileSync(credentialsPath,JSON.stringify({ restaurant:restaurant.name,restaurantCode:code,accounts:credentials },null,2)+"\n",{flag:"wx",mode:0o600});
    }
    await client.query("COMMIT");
    console.log(`Created ${credentials.length} demo accounts. Existing accounts were left unchanged.`);
    if (credentialsPath) console.log(`Local credentials: ${credentialsPath}`);
  } catch (error) {
    await client.query("ROLLBACK");
    if (credentialsPath && fs.existsSync(credentialsPath)) fs.unlinkSync(credentialsPath);
    throw error;
  } finally { client.release(); }
}
main().catch(error => { console.error(error.message); process.exitCode=1; }).finally(()=>pool.end());
