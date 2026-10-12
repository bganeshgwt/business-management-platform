// The manager's say-so as the API takes it (see ManagerApproval.jsx).
export const emptyApproval = () => ({ reason: "", approverId: "", pin: "" });

// { reason, approverId, pin }, with "Me" made explicit when no one else was chosen.
export function approvalFor(value, userId) {
  const approverId = value.approverId || String(userId || "");
  return { reason: value.reason, ...(approverId ? { approverId } : {}), ...(value.pin ? { pin: value.pin } : {}) };
}
