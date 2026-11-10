// Runs the migrations, signed in as the login that owns the tables
// (DB_OWNER_USER; DB_USER when it is not set, as on a developer's machine).
// With a separate owner, the API's own login is then given the rows of any
// new table (GO_LIVE.md › The database logins).
// Usage: npm run migrate:up | npm run migrate:down
const path = require("path");
const { Client } = require("pg");
const config = require("../src/config/env");
const { grantAppLogin } = require("../src/utils/databaseLogin");

const direction = process.argv[2];

if (direction !== "up" && direction !== "down") {
  console.error('Usage: node scripts/migrate.js <up|down>');
  process.exit(1);
}

async function main() {
  // node-pg-migrate is an ES module, so it is loaded with import().
  const { runner } = await import("node-pg-migrate");

  await runner({
    databaseUrl: { host: config.dbOwner.host, port: config.dbOwner.port, database: config.dbOwner.database, user: config.dbOwner.user, password: config.dbOwner.password },
    dir: path.join(__dirname, "..", "migrations"),
    migrationsTable: "pgmigrations",
    direction,
    count: direction === "up" ? Infinity : 1,
    checkOrder: true,
    log: (message) => console.log(message),
  });

  if (direction === "up" && config.dbOwner.separate) {
    const owner = new Client({ ...config.dbOwner, connectionTimeoutMillis: 15000 });
    await owner.connect();
    try {
      await grantAppLogin(owner, { database: config.db.database, name: config.db.user });
    } finally {
      await owner.end();
    }
  }

  console.log(`Migrations ${direction} complete.`);
}

main().catch((error) => {
  console.error("Migration failed:", error.message);
  process.exit(1);
});
