const { Pool, types } = require("pg");
const config = require("./env");

// pg returns BIGINT (type 20) as a string by default. Our ids and counts never
// exceed JavaScript's safe integer range, so return them as numbers.
// Money columns will use NUMERIC, which is not affected by this.
types.setTypeParser(20, (value) => Number(value));

const pool = new Pool(config.db);

// An idle client losing its connection must not crash the whole server.
pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error.message);
});

module.exports = pool;
