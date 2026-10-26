const config = require("./config/env");
const app = require("./app");
const pool = require("./config/database");
const live = require("./modules/live/services/liveHub");
const { assertMigrationsApplied } = require("./utils/migrationStatus");

// How long a stop may take before the process ends regardless.
const STOP_WITHIN_MS = 10000;

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
  const server = app.listen(config.port, (error) => {
    if (error) {
      console.error(error.code === "EADDRINUSE"
        ? `Could not start API: port ${config.port} is already in use. Is the API already running in another terminal?`
        : `Could not start API: ${error.message}`);
      process.exit(1);
    }

    console.log(`Server running on port ${config.port}`);

    // Live updates: this process's own connection, listening for the
    // changes the database announces (modules/live).
    live.start();

    // Stopped by a service manager (SIGTERM) or Ctrl+C: the screens' live
    // streams are told to reconnect and closed, then the server, the live
    // updates' connection and the pool, so nothing is left open.
    let stopping = false;
    const stop = () => {
      if (stopping) {
        return;
      }

      stopping = true;
      setTimeout(() => process.exit(0), STOP_WITHIN_MS).unref();
      live.stop()
        .then(() => new Promise((resolve) => server.close(resolve)))
        .then(() => pool.end())
        .catch((stopError) => console.error("Stopping the API:", stopError.message))
        .finally(() => process.exit(0));
    };

    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
};

start();
