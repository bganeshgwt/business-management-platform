const fs = require("node:fs");
const path = require("node:path");

// Check only; starting the API must never silently change the database.
async function assertMigrationsApplied(pool, files = fs.readdirSync(path.resolve(__dirname, "../../migrations"))) {
  let applied;
  try {
    applied = new Set((await pool.query("SELECT name FROM pgmigrations")).rows.map(row => row.name));
  } catch (error) {
    if (error.code === "42P01") throw new Error("Database migrations have not been initialized. Run npm run migrate:up in backend, then restart.");
    throw error;
  }
  const pending = files.filter(file => file.endsWith(".sql") && !applied.has(file.slice(0, -4))).sort();
  if (pending.length) {
    throw new Error(`${pending.length} database migration(s) pending (${pending[0]} first). Run npm run migrate:up in backend, then restart.`);
  }
}

module.exports = { assertMigrationsApplied };
