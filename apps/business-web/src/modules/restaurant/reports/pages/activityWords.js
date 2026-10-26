// Turning activity-log rows into words an owner reads: what happened, and the
// details that matter, without table names or internal ids.

// price_window -> "Price window". These are table names, and a person reading
// the activity log should not have to know that.
export const readable = (code) => {
  const words = String(code || "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();

  return words.charAt(0).toUpperCase() + words.slice(1);
};

// The sentence for a row: what the person did, in words an owner uses.
const PHRASES = {
  "void:bill": "Voided a bill",
  "refund:bill": "Gave a refund",
  "payment:bill": "Took a payment",
  "reprint:bill": "Reprinted a bill",
  "discount:bill": "Gave a discount",
  "complimentary:bill": "Made a bill complimentary",
  "cancel:order": "Cancelled an order",
  "cancel_item:order": "Took a dish off an order",
  "approval_granted:approval": "Got a manager's approval",
  "approval_denied:approval": "Wrong manager PIN at the approval prompt",
  "open:business_day": "Opened the business day",
  "close:business_day": "Closed the business day",
  "lock:user": "Account locked after wrong passwords",
  "lock:user_pin": "PIN locked after wrong tries",
  "lock:user_device": "Sign-in locked on a remembered device after wrong passwords",
  "lock:employee_pin": "Time-clock PIN locked",
  "unlock:user": "Unlocked a login",
  "reset_password:user": "Reset someone's password",
  "password_change:user": "Changed their own password",
  "sign_out_everywhere:user": "Signed out on every device",
  "create:user_pin": "Set a personal PIN",
  "reset:user_pin": "Changed a personal PIN",
  "delete:user_pin": "Removed a personal PIN",
  "loyalty_adjust:customer": "Adjusted loyalty points by hand",
  "pay:payroll_payment": "Marked salary paid",
  "delete:payroll_payment": "Undid a salary payment",
  "create:payroll_adjustment": "Recorded an advance, deduction or bonus",
  "delete:payroll_adjustment": "Removed an advance, deduction or bonus",
  "mark_remaining:attendance": "Marked the rest of the day's attendance",
  "copy:role": "Copied a role",
  "update:access_settings": "Changed the till lock",
  "update:payroll_settings": "Changed the pay policy",
  "wastage:inventory_item": "Recorded wastage",
  "stock_out:inventory_item": "Took stock out",
  // Tables and the floor.
  "mark_ready:dining_table": "Marked a table ready",
  "regenerate_qr:dining_table": "Made a new QR code for a table",
  // The floor settings hold one thing: how long a table takes to clear.
  "update:floor_settings": "Changed the table cleaning time",
  // Settings -> Features (the feature's name is the row's label).
  "feature.enabled:restaurant_feature": "Switched a feature on",
  "feature.disabled:restaurant_feature": "Switched a feature off",
  "move_table:order": "Moved an order to another table",
  "join_table:order": "Joined tables for one party",
  "unjoin_table:order": "Separated joined tables",
  "move_dishes:order": "Moved dishes to another order",
  "remove_item:order": "Took a dish off an order",
  "fire:order": "Sent a course to the kitchen",
  "accept:table_request": "Accepted an order from a table's QR",
  "reject:table_request": "Turned down an order from a table's QR",
  // Bookings and the waiting list.
  "confirm:reservation": "Confirmed a booking",
  "seat:reservation": "Seated a booking",
  "complete:reservation": "Finished a booking",
  "cancel:reservation": "Cancelled a booking",
  "no_show:reservation": "Marked a booking as a no-show",
  "seat:waitlist_entry": "Seated a guest from the waiting list",
  "notify:waitlist_entry": "Told a waiting guest their table is ready",
  "left:waitlist_entry": "Marked a waiting guest as gone",
  "remove:waitlist_entry": "Took a guest off the waiting list",
  // Bills.
  "on_account:bill": "Put a bill on a guest's account",
  "gst_recipient_set:bill": "Put a buyer's GSTIN on an invoice",
  "gst_recipient_cleared:bill": "Took the buyer's GSTIN off an invoice",
  "buyer_pan:bill": "Recorded the buyer's PAN on a bill",
  "service_charge_waived:bill": "Took the service charge off a bill",
  "service_charge_restored:bill": "Put the service charge back on a bill",
  // Kitchen.
  "recall:kot": "Recalled a kitchen ticket",
  "clear_old:kot": "Cleared old kitchen tickets",
  "route:category": "Sent a category to a kitchen station",
  "route:product": "Sent a dish to a kitchen station",
  "set_default:kitchen_station": "Made a kitchen station the default",
  // Menu.
  "availability:product": "Changed whether a dish can be ordered",
  "sold_out:product": "Marked a dish sold out",
  "back_on_sale:product": "Put a dish back on sale",
  "price_revision:product": "Changed dish prices",
  // GST rate changes by date (Menu > GST rate changes).
  "scheduled:tax_change": "Scheduled a GST rate change",
  "cancelled:tax_change": "Cancelled a GST rate change",
  "item_cancelled:tax_change": "Cancelled a GST rate change for a dish",
  "import:product": "Imported dishes",
  // Deliveries.
  "out_for_delivery:delivery": "Sent a delivery out",
  "delivered:delivery": "Marked a delivery delivered",
  "cancelled:delivery": "Cancelled a delivery",
  "undo_delivered:delivery": "Undid 'delivered' on a delivery",
  "recall:delivery": "Called a delivery back",
  // Guests.
  "view_contact:customer": "Looked at a guest's phone or email",
  "update_business:customer": "Changed a guest's company or GSTIN",
  "erase:customer": "Erased a guest's personal details",
  "merge:customer": "Merged two guest records",
  "not_duplicate:customer": "Marked two guests as different people",
  "consent_given:customer": "Recorded a guest's consent to offers",
  "consent_withdrawn:customer": "Recorded a guest withdrawing consent to offers",
  "compensate:complaint": "Made up for a guest's complaint",
  "export:guest_list": "Downloaded the guest list",
  "export:guest_book": "Downloaded the guest book",
  "export:customer_sales": "Downloaded guests' spending",
  "export:loyalty_report": "Downloaded the loyalty report",
  // Stock and suppliers.
  "stock_in:inventory_item": "Added stock",
  "transfer:inventory_item": "Moved stock between stores",
  "wastage_reversed:inventory_item": "Undid a wastage entry",
  "post:stock_count": "Posted a stock count",
  "cancel:stock_count": "Cancelled a stock count",
  "status_change:purchase_order": "Changed a purchase order's status",
  "receive:purchase_order": "Received goods against a purchase order",
  "void:purchase_bill": "Cancelled a supplier bill",
  "void:purchase_return": "Cancelled a return to a supplier",
  "payment:supplier": "Paid a supplier",
  "void:supplier_payment": "Cancelled a supplier payment",
  // Money out.
  "approved:expense": "Approved an expense",
  "rejected:expense": "Rejected an expense",
  "pending:expense": "Put an expense back to waiting for approval",
  "attach:expense": "Attached the paper bill to an expense",
  "remove_attachment:expense": "Removed a file from an expense",
  "attach:purchase_bill": "Attached the paper bill to a purchase bill",
  "remove_attachment:purchase_bill": "Removed a file from a purchase bill",
  // Tasks, issues and projects (written by the tasks module).
  "created:task": "Added a task",
  "updated:task": "Changed a task",
  "assigned:task": "Assigned a task",
  "completed:task": "Completed a task",
  "approved:task": "Approved a finished task",
  "sent_back:task": "Sent a task back to be done again",
  "cancelled:task": "Cancelled a task",
  "reopened:task": "Reopened a task",
  "deleted:task": "Deleted a task",
  "reported:issue": "Reported an issue",
  "updated:issue": "Changed an issue",
  "in_progress:issue": "Started work on an issue",
  "resolved:issue": "Resolved an issue",
  "closed:issue": "Closed an issue",
  "reopened:issue": "Reopened an issue",
  "deleted:issue": "Deleted an issue",
  "created:project": "Started a project",
  "updated:project": "Changed a project",
  "created:task_schedule": "Set up a recurring task",
  "updated:task_schedule": "Changed a recurring task",
  "paused:task_schedule": "Paused a recurring task",
  "resumed:task_schedule": "Resumed a recurring task",
  "created:task_template": "Added a checklist template",
  "updated:task_template": "Changed a checklist template",
  "archived:task_template": "Archived a checklist template",
  "restored:task_template": "Restored a checklist template",
  // People.
  "unlock:employee_pin": "Unlocked a time-clock PIN",
  "reset:employee_pin": "Reset a time-clock PIN",
  "enable:two_factor": "Turned on two-step sign-in",
  "reset:two_factor": "Reset someone's two-step sign-in",
  "use_recovery_code:two_factor": "Signed in with a recovery code",
  "renew_codes:two_factor": "Made new recovery codes",
};

const VERBS = { create: "Added", update: "Changed", delete: "Removed" };

export const describeAction = (row) =>
  PHRASES[`${row.action}:${row.entityType}`] ||
  (VERBS[row.action] ? `${VERBS[row.action]} ${readable(row.entityType).toLowerCase()}` : `${readable(row.action)} · ${readable(row.entityType).toLowerCase()}`);

const MONEY_KEYS = /amount|total|pay|earned|bonus|advance|deduction|salary|cash|refund|price/i;
// Counts that happen to share a word with money ("payable days").
const NOT_MONEY = /days|minutes|hours|count|points|percent|rate/i;

// ₹4,99,999.50 — whole rupees without paise, anything else to the paisa.
const rupees = (value) =>
  `₹${value.toLocaleString("en-IN", Number.isInteger(value) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const KIND_WORDS = { advance: "Advance to recover", arrears: "Pay still owed", bonus: "Bonus", deduction: "Deduction" };

// Field names an owner writes differently from the code ("Gstin").
const FIELD_WORDS = { gstin: "GSTIN", creditNote: "Credit note", upiId: "UPI ID", hsnCode: "HSN code", sku: "SKU", pan: "PAN", panDeclaration: "Form 97 declaration" };
const fieldName = (key) => FIELD_WORDS[key] || readable(key);

// Fields logged as [before, after] at the top level (a guest's company and
// GSTIN): read as a change, "GSTIN: — → 36AAGCL0460J1ZJ".
const PAIR_FIELDS = new Set(["companyName", "gstin"]);

// Payment methods as the bill prints them.
const METHOD_WORDS = { cash: "Cash", card: "Card", upi: "UPI", wallet: "Wallet", credit: "On account", online: "Online" };

const showValue = (key, value) => {
  if (value === null || value === undefined || value === "") {
    return "—";
  }

  if (Array.isArray(value)) {
    return value.length
      ? value.map((item) => (item && typeof item === "object" ? showValue(key, item) : String(item))).join(", ")
      : "none";
  }

  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }

  if (typeof value === "number" && MONEY_KEYS.test(key) && !NOT_MONEY.test(key)) {
    return rupees(value);
  }

  if (typeof value === "object") {
    // Internal ids inside a detail ("order item id 55267") mean nothing to
    // the reader and are left out, as they are at the top level.
    return Object.entries(value)
      .filter(([innerKey, inner]) => inner !== null && inner !== undefined && !/(^id$|Id$)/.test(innerKey))
      .map(([innerKey, inner]) => `${fieldName(innerKey)} ${showValue(innerKey, inner)}`)
      .join(", ");
  }

  if (typeof value === "string" && /^method$|Method$/.test(key) && METHOD_WORDS[value]) {
    return METHOD_WORDS[value];
  }

  // A stored code ("credit_note") as words ("Credit note").
  if (typeof value === "string" && /^[a-z]+(_[a-z]+)+$/.test(value)) {
    return readable(value);
  }

  return String(value);
};

// Details as short lines a person can read: "Salary: ₹18,000 → ₹20,000",
// "Reason: Guest walked out". Internal ids and approval fields are left out
// (the approving manager has a column of their own).
export const describeDetails = (details) => {
  if (!details || typeof details !== "object") {
    return [];
  }

  const lines = [];

  for (const [key, value] of Object.entries(details)) {
    if (["approvedFor", "approvalNote", "ip", "itemId", "approverId", "permission", "approvalNotNeeded"].includes(key)) {
      continue;
    }

    if (key === "approvalNotNeededWhy") {
      lines.push(String(value));
      continue;
    }

    // Pay taken out for someone without "see salaries" (see audit.repository).
    if (key === "payHidden") {
      lines.push("Pay amounts hidden: they need the 'see salaries' permission");
      continue;
    }

    // What a salary payment moved into the next pay period.
    if (key === "carriedForward" && Array.isArray(value)) {
      for (const item of value) {
        lines.push(`Carried to next period: ${KIND_WORDS[item.kind] || readable(item.kind)} ${rupees(Number(item.amount))}`);
      }

      continue;
    }

    if (key === "changes" && value && typeof value === "object") {
      for (const [field, pair] of Object.entries(value)) {
        if (Array.isArray(pair) && pair.length === 2) {
          lines.push(`${fieldName(field)}: ${showValue(field, pair[0])} → ${showValue(field, pair[1])}`);
        }
      }

      continue;
    }

    if (key === "before" || key === "after") {
      continue;
    }

    if (PAIR_FIELDS.has(key) && Array.isArray(value) && value.length === 2) {
      if (JSON.stringify(value[0] ?? null) !== JSON.stringify(value[1] ?? null)) {
        lines.push(`${fieldName(key)}: ${showValue(key, value[0])} → ${showValue(key, value[1])}`);
      }

      continue;
    }

    lines.push(`${fieldName(key)}: ${showValue(key, value)}`);
  }

  // An edit recorded as two snapshots (attendance): only what differs.
  if (details.after && typeof details.after === "object") {
    const before = details.before || {};

    for (const [field, now] of Object.entries(details.after)) {
      if (JSON.stringify(before[field] ?? null) !== JSON.stringify(now ?? null)) {
        lines.push(
          details.before
            ? `${readable(field)}: ${showValue(field, before[field])} → ${showValue(field, now)}`
            : `${readable(field)}: ${showValue(field, now)}`
        );
      }
    }
  }

  return lines;
};
