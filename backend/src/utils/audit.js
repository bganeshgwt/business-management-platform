const auditRepository = require("../modules/access/repositories/audit.repository");

// Why an action that normally needs a manager went through without one,
// written on the activity-log row (authorizeOrApprove's waiveWhen option).
// draft_bill stays so rows written before that waiver was withdrawn still
// read properly.
const WAIVED = {
  unpaid_bill: "Supplier bill not yet paid, so no manager was needed",
  draft_bill: "Bill not yet printed or paid, so no manager was needed",
};

// Records who did something that a manager would want to see later: cancelled
// orders, voided bills, refunds, approvals and changes to users or settings.
// Writing is best-effort and never blocks the action itself.
//
// When the action went through on a manager's approval (authorizeOrApprove set
// req.approval), the approving manager is written on the same row, so the log
// names both the person who did it and the person who allowed it. When no
// approval was needed because of what it was done to (req.approvalWaived),
// the row says so.
const logAction = (req, action, entityType, entity = {}) => {
  let details = entity.details || null;

  if (req.approval) {
    details = {
      ...(entity.details || {}),
      approvedFor: req.approval.label || undefined,
      approvalNote: req.approval.note || undefined,
    };
  } else if (req.approvalWaived) {
    details = {
      ...(entity.details || {}),
      approvalNotNeeded: req.approvalWaived,
      approvalNotNeededWhy: WAIVED[req.approvalWaived] || undefined,
    };
  }

  return auditRepository.record({
    restaurantId: req.user.restaurantId,
    userId: req.user.id,
    userName: req.user.name,
    action,
    entityType,
    entityId: entity.id || null,
    entityLabel: entity.label || null,
    details,
    approvedBy: req.approval ? req.approval.approverId : null,
    approverName: req.approval ? req.approval.approverName : null,
  });
};

// The same, for moments with no signed-in request to read from: a sign-in
// that failed, an account that locked itself.
const logFor = ({ restaurantId, userId, userName }, action, entityType, entity = {}) => {
  if (!restaurantId) {
    return Promise.resolve();
  }

  return auditRepository.record({
    restaurantId,
    userId,
    userName,
    action,
    entityType,
    entityId: entity.id || null,
    entityLabel: entity.label || null,
    details: entity.details || null,
    approvedBy: entity.approvedBy || null,
    approverName: entity.approverName || null,
  });
};

// Only the fields that changed, as { field: [before, after] }. Used for edits
// where "what did they change" is the whole point: a salary, a check-in time,
// a role's permissions.
const diff = (before, after, fields) => {
  const changes = {};

  for (const field of fields) {
    const was = before ? before[field] : undefined;
    const now = after ? after[field] : undefined;

    if (JSON.stringify(was ?? null) !== JSON.stringify(now ?? null)) {
      changes[field] = [was ?? null, now ?? null];
    }
  }

  return changes;
};

module.exports = { logAction, logFor, diff };
