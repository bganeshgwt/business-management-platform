const AppError = require("../utils/AppError");

// Express recognises an error handler by its four arguments, so `next` must stay.
const errorHandler = (error, req, res, next) => {
  if (error instanceof AppError) {
    return res.status(error.statusCode).json({
      success: false,
      message: error.message,
    });
  }

  // Invalid JSON in the request body.
  if (error.type === "entity.parse.failed") {
    return res.status(400).json({
      success: false,
      message: "Invalid JSON in request body",
    });
  }

  console.error(error);

  res.status(500).json({
    success: false,
    message: "Internal server error",
  });
};

module.exports = errorHandler;
