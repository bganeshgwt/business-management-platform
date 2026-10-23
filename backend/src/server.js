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

  // Express hands a failed listen (a port already in use) to this callback:
  // say so and stop, rather than report a server that is not there.
  app.listen(config.port, (error) => {
    if (error) {
      console.error(error.code === "EADDRINUSE"
        ? `Could not start API: port ${config.port} is already in use. Is the API already running in another terminal?`
        : `Could not start API: ${error.message}`);
      process.exit(1);
    }

    console.log(`Server running on port ${config.port}`);
  });
};

start();
