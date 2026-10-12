const approvalService = require("../modules/access/services/approval.service");
const authorize = require("./authorize");
const AppError = require("../utils/AppError");

// Like authorize(permission), but a person without the permission can still
// go ahead when a manager standing next to them approves this one action.
//
//   router.patch("/:id/void", authorize("billing.manage"), authorizeOrApprove("bills.void"), ...)
//
// 1. The user holds the permission: straight through.
// 2. options.waiveWhen(req) names a reason no approval is needed for THIS
//    record, read from the database (purchase.routes.js: a supplier bill
//    nobody has paid yet): through, with req.approvalWaived set so the
//    activity log says why. Only use it where the database can prove nothing
//    can go missing; bill voids have no waiver for that reason.
// 3. The request carries X-Approval-Token, issued by POST /api/auth/approvals
//    for this user and this permission (and, when the screen said which,
//    this exact request): it is spent for good and the request goes through, with
//    req.approval = { approverId, approverName, ... }. logAction then writes
//    the approving manager on the activity-log row by itself.
// 4. Otherwise: 403 { data: { reason: "approval_required", permission,
//    scope } }, which the screen answers by opening the manager-PIN prompt
//    (showing what `scope` says) and retrying.
//
// options.scope(req) ties approvals to what the manager was shown. It reads
// the facts that matter off the request, in approval.service's terms:
//
//   authorizeOrApprove("bills.refund", {
//     scope: (req) => ({ billId: req.params.id, amount: req.body?.amount }),
//   })
//
// With it, a token must have been approved for those same facts (the same
// bill; an amount no higher than approved), or it is refused and the prompt
// opens again with the real figures. A manager who approved "Refund ₹50 on
// INV-0042" has not approved ₹2,400. Without it (routes not bound yet), a
// token is tied to the person, the permission and, when given, the request.
//
// A token is spent before the action runs, in one step that also checks it
// against the request, and it stays spent. Of several requests sent with one
// token, exactly one goes through; the rest are told it has already been
// used. If the action then fails (a missing reason, a bill that is already
// paid), the approval is NOT handed back: the cashier fixes the problem and
// asks the manager again. Handing it back is what let a deliberately failing
// ₹50 refund keep the token free for a ₹2,400 one racing behind it.
const authorizeOrApprove = (permission, options = {}) => {
  // The role editor shows which permissions something actually checks.
  authorize.noteEnforced(permission);

  return async (req, res, next) => {
    const granted = req.user?.permissions || [];

    if (granted.includes(permission)) {
      next();
      return;
    }

    const token = req.get("X-Approval-Token");

    if (!token && options.waiveWhen) {
      const waived = await options.waiveWhen(req);

      if (waived) {
        req.approvalWaived = waived;
        next();
        return;
      }
    }

    // What this request would do, in the facts an approval is tied to. A
    // figure that is not a number is refused here, before anyone is asked
    // for a PIN.
    const scope = options.scope ? approvalService.normaliseScope(await options.scope(req)) : null;

    if (!token) {
      throw new AppError(403, `A manager's approval is needed to ${approvalService.actionLabel(permission)}`, {
        reason: "approval_required",
        permission,
        action: approvalService.actionLabel(permission),
        scope,
      });
    }

    const approval = await approvalService.redeem({
      token,
      restaurantId: req.user.restaurantId,
      userId: req.user.id,
      permission,
      method: req.method,
      url: req.originalUrl,
      scope,
      scopeRequired: Boolean(options.scope),
    });

    req.approval = {
      id: approval.id,
      permission,
      approverId: approval.approved_by,
      approverName: approval.approver_name,
      label: approval.label,
      note: approval.note,
      scope: approval.scope || null,
    };

    next();
  };
};

module.exports = authorizeOrApprove;
