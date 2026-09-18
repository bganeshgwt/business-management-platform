const pool = require("../config/database");

const findById = async (id) => {
  const result = await pool.query(
    `SELECT id, name, code, contact, email, address, status, created_at, updated_at
     FROM restaurants
     WHERE id = $1`,
    [id]
  );

  return result.rows[0] || null;
};

module.exports = {
  findById,
};
