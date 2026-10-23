// Manager approval ("manager PIN") on the screen side.
//
// Some actions need a permission the person at the till may not have — void a
// bill, refund, close the day. The server then answers 403 with
// { data: { reason: "approval_required", permission } }. Instead of an error,
// the global PIN dialog opens; a manager standing there taps their name and
// types their PIN; the call is sent again carrying a one-time approval token.
//
// Every request goes through this automatically (see the response interceptor
// in api.js). Wrapping a call in withApproval adds the words the dialog shows:
//
//   await withApproval((headers) => addRefund(id, payload, headers), `Refund ₹50 on INV-0042`, {
//     permission: "bills.refund",
//     scope: { billId: id, amount: 50 },
//   });
//
// `scope` is what is being approved, as facts: the bill, the amount, the
// dish. The prompt shows the server's own wording of those facts, and the
// approval is tied to them: a refund approved for ₹50 cannot refund more,
// and cannot be used on another bill. Routes that bind their approvals
// (refund, void, day close) refuse an approval without the facts; when a
// screen leaves them out, the server's refusal carries them and the prompt
// opens again, so pass them up front.
//
// The service function takes an optional `headers` argument and passes it to
// axios, so the call can also be retried here if the dialog host is missing.

let handler = null;
const labels = [];
// What the signed-in person may do, kept here by AuthProvider, so a call the
// screen already knows needs approval can ask for it up front instead of
// sending a request that is bound to be refused.
let granted = null;

export const setApprovalPermissions = (permissions) => {
  granted = permissions ? new Set(permissions) : null;
};

// ApprovalDialog registers itself here once, when the app mounts.
export const setApprovalHandler = (next) => {
  handler = next;

  return () => {
    if (handler === next) {
      handler = null;
    }
  };
};

export const hasApprovalHandler = () => handler !== null;

// What the innermost withApproval call is doing, for the dialog's heading.
export const currentApprovalLabel = () => (labels.length > 0 ? labels[labels.length - 1] : null);

const approvalReason = (error) => error?.response?.data?.data?.reason || null;

export const isApprovalRequired = (error) =>
  error?.response?.status === 403 &&
  ["approval_required", "approval_invalid"].includes(approvalReason(error));

// The words the prompt uses for each permission ("…needed to void a bill"),
// matching the server's, for prompts opened before any request is sent.
const ACTIONS = {
  "orders.cancel_after_kot": "take off a dish the kitchen already has",
  "bills.void": "void a bill",
  "bills.refund": "give a refund",
  "bills.reprint": "reprint a bill",
  "bills.discount": "give a discount",
  "bills.complimentary": "make a bill complimentary",
  "business_day.close": "close the business day",
  "menu.availability": "mark a dish sold out",
  "loyalty.adjust": "add or remove points by hand",
  "customers.credit": "put a bill on a guest's account",
};

// Opens the dialog and resolves with a token, or null when it was cancelled.
export const requestApproval = (request) => {
  if (!handler) {
    return Promise.resolve(null);
  }

  return handler({ ...request, action: request.action || ACTIONS[request.permission] || null });
};

// A request marked with this header is not sent: api.js stops it and hands
// back its method and address, so an approval asked for up front is tied to
// that one request ("PATCH /bills/42/void") exactly as one asked for after a
// refusal is. A token for "void bill INV-0042" then cannot void another bill.
export const CAPTURE_HEADER = "X-Approval-Capture";

const isCapture = (error) => Boolean(error && error.approvalCapture);

// Runs fn once with the capture header, to learn which request it makes
// without sending it: { target }. A service that does not pass the headers on
// to axios sends its request for real, and any refusal is answered by the
// interceptor, which knows the request; its outcome comes back as { done }
// so the call is never made twice.
const captureTarget = async (fn) => {
  try {
    return { done: true, result: await fn({ [CAPTURE_HEADER]: "1" }) };
  } catch (error) {
    if (isCapture(error)) {
      return { target: { method: error.approvalCapture.method, url: error.approvalCapture.url } };
    }

    throw error;
  }
};

//   options.permission  the permission the action needs. When the person
//                       plainly does not hold it, the PIN prompt opens first
//                       and the call goes out once, already approved.
//   options.scope       what exactly is being approved ({ billId, amount },
//                       { businessDayId, closingCash, carryUnpaid }, ...):
//                       the same figures the call sends.
export const withApproval = async (fn, label, options = {}) => {
  labels.push(label || null);

  try {
    if (options.permission && granted && !granted.has(options.permission) && handler) {
      const probe = await captureTarget(fn);

      if (probe.done) {
        return probe.result;
      }

      const { target } = probe;
      const token = await requestApproval({
        permission: options.permission,
        action: options.action,
        label,
        method: target.method,
        url: target.url,
        scope: options.scope || null,
      });

      if (!token) {
        const cancelled = new Error("Manager approval was cancelled");
        cancelled.approvalCancelled = true;
        cancelled.response = { status: 403, data: { message: "Cancelled — nothing was changed without a manager's approval." } };
        throw cancelled;
      }

      return await fn({ "X-Approval-Token": token });
    }

    return await fn({});
  } catch (error) {
    // The interceptor normally answers the approval prompt itself. This is the
    // fallback for a call it did not handle.
    if (!isApprovalRequired(error) || error.approvalHandled) {
      throw error;
    }

    const details = error.response.data.data;
    const token = await requestApproval({
      permission: details.permission,
      action: details.action,
      label,
      method: error.config?.method,
      url: error.config?.url,
      // The server's reading of the request wins over the screen's.
      scope: details.scope || options.scope || null,
      message: details.reason === "approval_invalid" ? error.response.data.message : null,
    });

    if (!token) {
      error.approvalCancelled = true;
      throw error;
    }

    return fn({ "X-Approval-Token": token });
  } finally {
    labels.pop();
  }
};
