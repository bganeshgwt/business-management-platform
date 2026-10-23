import { businessWrite } from "../../../../services/business.service";
import { dateShort } from "@bmp/shared/format";
import { whatsappLink } from "../../retail/pages/retail";

// Telling a repair customer: one message per stage, sent
// from the person's own WhatsApp (wa.me) or a call, and logged on the job.

export const MESSAGE_STAGES = [
  { value: "received", label: "Job received" },
  { value: "parts", label: "Waiting for parts" },
  { value: "approval", label: "Ask to approve" },
  { value: "ready", label: "Ready to collect" },
  { value: "delayed", label: "Running late" },
  { value: "reminder", label: "Collect reminder" },
];

// The stage that fits the job's status (the button offered first).
export const stageFor = (status) => ({ received: "received", diagnosing: "received", waiting_parts: "parts", in_repair: "delayed", awaiting_approval: "approval", ready: "ready" }[status] || "received");

function repairMessage(job, stage, biz, amountDue) {
  const shop = biz.settings.display_name || biz.business.name;
  const phone = biz.settings.phone ? ` Call us on ${biz.settings.phone}.` : "";
  const due = amountDue > 0 ? ` Amount to pay: ${biz.exact(amountDue)}.` : "";
  const lines = {
    received: `Namaste ${job.customer_name}, we have received your ${job.device} for repair (job ${job.job_no}).${job.estimate !== null && job.estimate !== undefined ? ` Estimate: ${biz.exact(job.estimate)}.` : ""}${job.promised_on ? ` Expected by ${dateShort(job.promised_on)}.` : ""}`,
    parts: `Namaste ${job.customer_name}, the part for your ${job.device} (job ${job.job_no}) has been ordered. We will tell you as soon as it is fitted.`,
    approval: `Namaste ${job.customer_name}, your ${job.device} (job ${job.job_no}) needs work costing ${biz.exact(job.lines_total || 0)}, more than the estimate. Please reply YES to go ahead, or call us.`,
    ready: `Namaste ${job.customer_name}, your ${job.device} is ready to collect (job ${job.job_no}).${due} Please bring the job card.`,
    delayed: `Namaste ${job.customer_name}, your ${job.device} (job ${job.job_no}) needs a little more time. Sorry for the wait; we will message you when it is ready.`,
    reminder: `Namaste ${job.customer_name}, your ${job.device} (job ${job.job_no}) is ready and waiting for you.${due}`,
  };
  return `${lines[stage] || lines.received}${phone}\n— ${shop}`;
}

// Opens WhatsApp with the message and records it on the job's history.
export function sendWhatsApp(biz, job, stage, amountDue) {
  window.open(whatsappLink(job.customer_phone, repairMessage(job, stage, biz, amountDue)), "_blank", "noopener");
  return businessWrite(biz.id, `repairs/${job.id}/messages`, { channel: "whatsapp", stage });
}
export function logCall(biz, job, stage) {
  return businessWrite(biz.id, `repairs/${job.id}/messages`, { channel: "call", stage });
}

// Condition seen at intake: ticked when present.
export const CHECKLIST = [
  ["powers_on", "Powers on"], ["screen_cracked", "Screen cracked"], ["water_damage", "Water damage"], ["body_dent", "Body dent or bend"],
  ["back_broken", "Back glass broken"], ["camera_ok", "Camera works"], ["charging_ok", "Charges"], ["battery_swollen", "Battery swollen"], ["sim_tray", "SIM tray with it"],
];

export const JOB_TERMS = [
  "Devices not collected within 30 days of the ready message are at the owner's risk.",
  "We are not responsible for data on the device; please keep a backup.",
  "Water-damaged and dead devices may stop working during or after repair.",
  "The estimate may change once the device is opened; we will ask before going ahead.",
  "Parts replaced carry the warranty shown on the bill. Bring this card to collect.",
];
