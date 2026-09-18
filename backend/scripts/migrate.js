// Runs migrations using the same DB_* settings as the API.
// Usage: npm run migrate:up | npm run migrate:down
const path = require("path");
const config = require("../src/config/env");

const direction = process.argv[2];

if (direction !== "up" && direction !== "down") {
  console.error('Usage: node scripts/migrate.js <up|down>');
  process.exit(1);
}

async function main() {
  // node-pg-migrate is an ES module, so it is loaded with import().
  const { runner } = await import("node-pg-migrate");

  await runner({
    databaseUrl: config.db,
    dir: path.join(__dirname, "..", "migrations"),
    migrationsTable: "pgmigrations",
    direction,
    count: direction === "up" ? Infinity : 1,
    checkOrder: true,
    log: (message) => console.log(message),
  });

  console.log(`Migrations ${direction} complete.`);
}

main().catch((error) => {
  console.error("Migration failed:", error.message);
  process.exit(1);
});
