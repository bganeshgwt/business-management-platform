// Makes the API's own database login (DB_USER, with the password in
// DB_PASSWORD), or brings it up to date, signed in as the login that owns the
// tables (DB_OWNER_USER, DB_OWNER_PASSWORD). The API's login reads and writes
// rows and nothing more. Run once when a server is set up, and again after
// DB_PASSWORD changes; npm run migrate:up keeps its rights current as tables
// are added. GO_LIVE.md › The database logins.
// Usage: npm run db:app-login
const { Client } = require("pg");
const config = require("../src/config/env");
const { createAppLogin, grantAppLogin, loginProblem } = require("../src/utils/databaseLogin");

async function main() {
  if (!config.dbOwner.separate) {
    throw new Error("Set DB_OWNER_USER and DB_OWNER_PASSWORD in backend/.env to the login that owns the tables, and DB_USER to another name for the API's own login.");
  }
  const owner = new Client({ ...config.dbOwner, connectionTimeoutMillis: 15000 });
  await owner.connect();
  try {
    const { created } = await createAppLogin(owner, { name: config.db.user, password: config.db.password });
    await grantAppLogin(owner, { database: config.db.database, name: config.db.user });
    console.log(`${created ? "Made" : "Brought up to date"} the API's database login "${config.db.user}".`);
  } finally {
    await owner.end();
  }
  // Signed in as the API would be: it must read rows and be no stronger.
  const app = new Client({ ...config.db, connectionTimeoutMillis: 15000 });
  await app.connect();
  try {
    await app.query("SELECT count(*) FROM pgmigrations");
    const problem = await loginProblem(app);
    if (problem) throw new Error(`The API's login is still too strong: ${problem}.`);
  } finally {
    await app.end();
  }
  console.log("It signs in, reads and writes rows, and cannot create, change or drop a table.");
}

main().catch((error) => {
  console.error("Could not set up the API's database login:", error.message);
  process.exit(1);
});
