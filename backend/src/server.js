const config = require("./config/env");
const app = require("./app");
const pool = require("./config/database");
const { assertMigrationsApplied } = require("./utils/migrationStatus");

const start = async () => {
  try {
    await pool.query("SELECT 1");
    await assertMigrationsApplied(pool);
    console.log(`Connected to PostgreSQL database "${config.db.database}"`);
  } catch (error) {
    console.error("Could not start API:", error.message);
    process.exit(1);
  }

  app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
  });
};

start();
