import { businessWrite } from "../../../../services/business.service";

// A lab sample's steps, shared by the lab order's screen (LabOrderPage.jsx)
// and the lab workspace's collection desk (workspaces/lab): where a sample
// is, and collecting, receiving or rejecting it.

export const SAMPLE_WORDS = { awaited: ["warning", "To collect"], collected: ["info", "Collected"], received: ["success", "In the lab"], rejected: ["danger", "Rejected"] };

// Collects, receives (in the lab) or rejects (with the reason) a sample, and
// says what was done.
export async function sampleStep(businessId, sample, action, reason) {
  await businessWrite(businessId, `lab/samples/${sample.id}`, { action, reason });
  return action === "collect" ? `Sample ${sample.barcode} collected` : action === "receive" ? `Sample ${sample.barcode} received in the lab` : `Sample ${sample.barcode} rejected`;
}
