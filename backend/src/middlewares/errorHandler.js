const AppError = require("../utils/AppError");

// A manager's approval is spent before the action runs and is never handed
// back (see authorizeOrApprove), so when the action itself fails the person
// is told the approval is gone: they fix the problem and ask again, instead
// of wondering why the PIN prompt opens a second time.
const APPROVAL_USED = "The manager's approval was used on this try, so ask them to approve again when you retry.";

const withApprovalNote = (req, message, details) => {
  if (!req.approval) {
    return { message, details };
  }

  const plainDetails = details === undefined || (details && typeof details === "object" && !Array.isArray(details));

  return {
    message: `${message.replace(/\s*$/, "")}${/[.!?]$/.test(message.trim()) ? "" : "."} ${APPROVAL_USED}`,
    details: plainDetails ? { ...(details || {}), approvalUsed: true } : details,
  };
};

// Express recognises an error handler by its four arguments, so `next` must stay.
const errorHandler = (error, req, res, next) => {
  if (error instanceof AppError) {
    const { message, details } = withApprovalNote(req, error.message, error.details);

    return res.status(error.statusCode).json({
      success: false,
      message,
      ...(details !== undefined ? { data: details } : {}),
    });
  }

  // An upload multer refused: too big, too many files, or the wrong field.
  if (error.name === "MulterError") {
    const message =
      error.code === "LIMIT_FILE_SIZE"
        ? "That image is larger than 2 MB"
        : "That upload could not be accepted";

    return res.status(400).json({ success: false, message });
  }

  // Invalid JSON in the request body.
  if (error.type === "entity.parse.failed") {
    return res.status(400).json({
      success: false,
      message: "Invalid JSON in request body",
    });
  }

  // Two tills changing the same rows at the same instant: PostgreSQL picked one
  // of them to give way (deadlock 40P01, serialization failure 40001). Nothing
  // was saved for this request, so pressing the button again is the right fix —
  // say that, instead of "Internal server error".
  if (error.code === "40P01" || error.code === "40001") {
    console.warn(`Database conflict (${error.code}) on ${req.method} ${req.originalUrl}: the request was rolled back`);

    const { message, details } = withApprovalNote(
      req,
      "Someone else was changing the same record at that moment. Nothing was saved — please try again.",
      { reason: "conflict_retry" }
    );

    return res.status(409).json({ success: false, message, data: details });
  }

  console.error(error);

  const { message, details } = withApprovalNote(req, "Internal server error", undefined);

  res.status(500).json({
    success: false,
    message,
    ...(details !== undefined ? { data: details } : {}),
  });
};

module.exports = errorHandler;
