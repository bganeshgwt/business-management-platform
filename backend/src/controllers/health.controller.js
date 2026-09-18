const pool = require("../config/database");

const getHealth = (req, res) => {
  res.json({
    success: true,
    message: "Restaurant Management API is running",
  });
};

const getDbHealth = async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW() AS current_time");

    res.json({
      success: true,
      message: "PostgreSQL connection successful",
      time: result.rows[0].current_time,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Database connection failed",
    });
  }
};

module.exports = {
  getHealth,
  getDbHealth,
};
