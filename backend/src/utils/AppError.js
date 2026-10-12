// An expected error with an HTTP status, safe to show to the client.
//
// `details` is optional structured data the screen can act on — for example
// the list of tables still open when a day cannot be closed. It is sent as the
// response's `data`, so a refusal can say exactly what is in the way instead
// of leaving the user to go and find it.
class AppError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

module.exports = AppError;
