const config = require("./config/env");
const app = require("./app");
const pool = require("./config/database");

const start = async () => {
  try {
    await pool.query("SELECT 1");
    console.log(`Connected to PostgreSQL database "${config.db.database}"`);
  } catch (error) {
    console.error("Could not connect to PostgreSQL:", error.message);
    process.exit(1);
  }

  app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
  });
};

start();
