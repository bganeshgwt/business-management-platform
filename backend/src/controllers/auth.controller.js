const authService = require("../services/auth.service");
const AppError = require("../utils/AppError");

const login = async (req, res) => {
  const { email, password } = req.body || {};

  if (typeof email !== "string" || typeof password !== "string" || !email.trim() || !password) {
    throw new AppError(400, "Email and password are required");
  }

  // bcrypt only uses the first 72 bytes; longer input is almost certainly not a real password.
  if (email.length > 150 || password.length > 72) {
    throw new AppError(401, "Invalid email or password");
  }

  const result = await authService.login(email.trim(), password);

  res.json({
    success: true,
    message: "Login successful",
    data: result,
  });
};

const me = (req, res) => {
  res.json({
    success: true,
    data: req.user,
  });
};

module.exports = {
  login,
  me,
};
