import { dateShort } from "@bmp/shared/format";
import { whatsappLink } from "../../retail/pages/retail";

// Garages: the words, formats and messages the job card, vehicle and
// service-due screens share. The server checks every step and figure again
// (garage/services); these only show and prepare them.

// A garage with its tools on.
export const usesGarage = (biz) => biz.type === "garage" && biz.has("garage");

export const STATUSES = {
  received: { label: "Received", tone: "info" }, estimate_sent: { label: "Estimate sent", tone: "warning" }, approved: { label: "Approved", tone: "info" },
  in_progress: { label: "In progress", tone: "info" }, waiting_parts: { label: "Waiting for parts", tone: "warning" }, ready: { label: "Ready", tone: "success" },
  delivered: { label: "Delivered", tone: "neutral" }, cancelled: { label: "Cancelled", tone: "neutral" },
};
// The board's columns: every open status, in the order a job moves.
export const BOARD = ["received", "estimate_sent", "approved", "in_progress", "waiting_parts", "ready"];
export const OPEN = BOARD;
// Each next step as its button says it.
export const STEP_WORDS = { estimate_sent: "Send the estimate", in_progress: "Start work", waiting_parts: "Waiting for parts", ready: "Work done: ready" };
export const FUELS = [{ value: "petrol", label: "Petrol" }, { value: "diesel", label: "Diesel" }, { value: "cng", label: "CNG" }, { value: "petrol_cng", label: "Petrol + CNG" },
  { value: "lpg", label: "LPG" }, { value: "electric", label: "Electric" }, { value: "hybrid", label: "Hybrid" }];
export const FUEL_LEVELS = [{ value: "empty", label: "Empty" }, { value: "quarter", label: "A quarter" }, { value: "half", label: "Half" },
  { value: "three_quarters", label: "Three quarters" }, { value: "full", label: "Full" }];
export const LINE_KINDS = [{ value: "part", label: "Part" }, { value: "labour", label: "Labour" }, { value: "sublet", label: "Outside work" }];
export const PAYERS = [{ value: "customer", label: "Customer" }, { value: "insurer", label: "Insurer" }];
export const CHANNELS = [{ value: "in_person", label: "In person" }, { value: "phone", label: "On the phone" }, { value: "whatsapp", label: "On WhatsApp" }];
export const DUE_KINDS = { service: "Service", insurance: "Insurance", puc: "PUC" };
export const CLAIM_MODES = [{ value: "cashless", label: "Cashless (the insurer pays the garage)" }, { value: "reimbursement", label: "Reimbursement (the owner pays and claims)" }];
export const wordOf = (list, value) => list.find((x) => x.value === value)?.label || "";
// A claim's progress, in order: intimated, then the steps the desk records, then invoiced (the bills) and settled.
export const CLAIM_STEPS = [{ value: "intimated", label: "Intimated" }, { value: "surveyed", label: "Surveyed" }, { value: "approved", label: "Approved" },
  { value: "work_done", label: "Work done" }, { value: "reinspected", label: "Re-inspected" }, { value: "invoiced", label: "Invoiced" }, { value: "settled", label: "Settled" }];
// What became of a part line's old part (salvage).
export const OLD_PARTS = [{ value: "returned", label: "Handed back to the customer" }, { value: "surveyor", label: "Kept for the surveyor" }, { value: "scrap", label: "Sold as scrap" }];
// The steps the desk records itself (invoiced and settled come with the bills and the insurer's payments).
export const CLAIM_DESK_STEPS = ["surveyed", "approved", "work_done", "reinspected"];
// Whether a person's role works only on the job cards assigned to it (a mechanic: garage.edit without garage.view).
export const mechanicOnly = (biz) => biz.can("garage.edit") && !biz.can("garage.view");

// Kilometres as Indian readers group them: 41,603 km.
export const km = (value) => (value === null || value === undefined || value === "" ? "—" : `${Number(value).toLocaleString("en-IN")} km`);
// A registration number as printed on the plate, read the way it is typed.
export const plateOf = (value) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
// A moment as a datetime-local input takes it (the browser's own clock), and back.
export const toLocalInput = (iso) => {
  if (!iso) return "";
  const at = new Date(iso);
  return new Date(at.getTime() - at.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
export const fromLocalInput = (value) => (value ? new Date(value).toISOString() : undefined);
export const atWords = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—");

// A manager's say-so in a form (GarageApproval.jsx): empty, and as the API takes it.
export const emptyApproval = () => ({ reason: "", approverId: "", pin: "" });
export function approvalBody(value, userId) {
  const approverId = value.approverId || String(userId || "");
  return { reason: value.reason, ...(approverId ? { approverId } : {}), ...(value.pin ? { pin: value.pin } : {}) };
}

// The lines of a job card in words, and what the work is.
export const lineWords = (l) => [l.label, l.description, l.kind === "sublet" && l.vendor_name ? `by ${l.vendor_name}${l.vendor_bill_no ? ` (bill ${l.vendor_bill_no})` : ""}` : null].filter(Boolean).join(" · ");

// The prepared WhatsApp messages to a customer: their job card's stage, and a reminder.
export function jobMessage(biz, job, stage) {
  const shop = biz.settings.display_name || biz.business.name;
  const name = job.customer_name;
  const vehicle = `${job.registration_no}${job.vehicle_name ? ` (${job.vehicle_name})` : ""}`;
  const due = job.bill && Number(job.bill.customer?.total ?? job.bill.total) > 0 ? biz.exact(job.bill.due) : null;
  const lines = {
    received: `Namaste ${name}, we have received your vehicle ${vehicle} (job card ${job.job_no}).${job.promised_at ? ` We expect it to be ready by ${atWords(job.promised_at)}.` : ""}`,
    estimate: `Namaste ${name}, the estimate for your vehicle ${vehicle} (job card ${job.job_no}) comes to ${biz.exact(job.total)}. Please reply to tell us to go ahead.`,
    ready: `Namaste ${name}, your vehicle ${vehicle} is ready (job card ${job.job_no}).${due ? ` Amount to pay: ${due}.` : ""}`,
    delayed: `Namaste ${name}, your vehicle ${vehicle} (job card ${job.job_no}) needs a little more time. Sorry for the wait; we will message you when it is ready.`,
    reminder: `Namaste ${name}, your vehicle ${vehicle} is ready and waiting for you (job card ${job.job_no}).${due ? ` Amount to pay: ${due}.` : ""}`,
  };
  return `${lines[stage] || lines.received}${biz.settings.phone ? ` Call us on ${biz.settings.phone}.` : ""}\n— ${shop}`;
}
export const MESSAGE_STAGES = [{ value: "received", label: "Vehicle received" }, { value: "estimate", label: "Estimate for approval" }, { value: "ready", label: "Ready to collect" },
  { value: "delayed", label: "Running late" }, { value: "reminder", label: "Collect reminder" }];
// The stage that fits the job card's status (the button offered first).
export const stageFor = (status) => (status === "ready" ? "ready" : status === "estimate_sent" ? "estimate" : "received");

export function reminderMessage(biz, row) {
  const shop = biz.settings.display_name || biz.business.name;
  const vehicle = `${row.registration_no}${row.vehicle_name ? ` (${row.vehicle_name})` : ""}`;
  const when = row.due_by ? dateShort(row.due_by, { year: true }) : null;
  const lines = {
    service: `Namaste ${row.owner_name}, your vehicle ${vehicle} is due for its service${when ? ` around ${when}` : ""}${row.next_service_km ? ` or at ${km(row.next_service_km)}` : ""}. Please call us to book a time.`,
    insurance: `Namaste ${row.owner_name}, the insurance of your vehicle ${vehicle} ${row.days_left < 0 ? "ran out" : "runs out"} on ${when}. Please renew it in time.`,
    puc: `Namaste ${row.owner_name}, the PUC certificate of your vehicle ${vehicle} ${row.days_left < 0 ? "ran out" : "runs out"} on ${when}. Please get it renewed in time.`,
  };
  return `${lines[row.kind] || lines.service}${biz.settings.phone ? ` Call ${biz.settings.phone}.` : ""}\n— ${shop}`;
}
export const reminderLink = (biz, row) => whatsappLink(row.owner_phone, reminderMessage(biz, row));
