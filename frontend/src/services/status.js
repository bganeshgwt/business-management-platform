// The app's one status vocabulary: which tone a status code is drawn in and
// the word for it. Used by components/StatusBadge.jsx; pages that colour a
// row or a chip by status read statusTone() so they agree with the badge.
//
//   success  done, paid, active, received        warning  needs attention soon
//   danger   failed, overdue, out of stock         info     in progress, booked
//   neutral  draft, off, closed, a plain kind      (inactive / locked: grey)

const TONES = {
  // success — done, paid, on
  active: "active",
  completed: "success",
  complete: "success",
  received: "success",
  posted: "success",
  paid: "success",
  settled: "success",
  delivered: "success",
  approved: "success",
  ready: "success",
  served: "success",
  available: "success",
  in_stock: "success",
  cleared: "success",
  confirmed: "success",
  // warning — attention soon
  pending: "warning",
  partial: "warning",
  partially_paid: "warning",
  due: "warning",
  due_soon: "warning",
  low: "warning",
  low_stock: "warning",
  running_low: "warning",
  waiting: "warning",
  held: "warning",
  on_hold: "warning",
  in_transit: "warning",
  no_show: "warning",
  expiring: "warning",
  awaiting_approval: "warning",
  // danger — failed, overdue, out
  overdue: "danger",
  failed: "danger",
  rejected: "danger",
  bounced: "danger",
  void: "danger",
  voided: "danger",
  out_of_stock: "danger",
  sold_out: "danger",
  expired: "danger",
  blocked: "danger",
  // info — in progress
  open: "info",
  booked: "info",
  sale: "info",
  in_progress: "info",
  ordered: "info",
  preparing: "info",
  sent: "info",
  seated: "info",
  dispatched: "info",
  deposited: "info",
  // neutral / grey — off, draft, a plain kind
  inactive: "inactive",
  locked: "locked",
  cancelled: "inactive",
  canceled: "inactive",
  closed: "neutral",
  draft: "neutral",
  purchase: "neutral",
  archived: "inactive",
  disabled: "inactive",
};

const WORDS = {
  in_transit: "In transit",
  no_show: "No-show",
  out_of_stock: "Out of stock",
  sold_out: "Sold out",
  low_stock: "Low stock",
  in_progress: "In progress",
  on_hold: "On hold",
  partially_paid: "Part paid",
  awaiting_approval: "Waiting for approval",
};

export const statusTone = (status) => TONES[String(status || "").toLowerCase()] || null;

export const statusWord = (status) =>
  WORDS[String(status || "").toLowerCase()] ||
  String(status || "")
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase());

