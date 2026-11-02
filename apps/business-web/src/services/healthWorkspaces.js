// The clinic's two workspaces, screens of their own outside Business Admin
// (src/workspaces/clinic, src/workspaces/lab): the front desk and the doctors
// at /clinic/<clinic>, sample collection and the lab at /lab/<clinic>. The
// bare /clinic and /lab open the clinic chosen last (services/workspaceApps.js,
// shared with the other workspaces of a business). Who may open each is the
// clinic's own roles and permissions, as for the screens they gather.
//
// Kept free of React, so the rules can be tested on their own.

export const HEALTH_WORKSPACES = {
  clinic: {
    title: "Clinic workspace",
    module: "patients",
    need: "patients.view",
    lead: "The front desk and the doctors: patients registered and given tokens, the queue by doctor, and the consultation beside it.",
    refused: "the clinic workspace",
  },
  lab: {
    title: "Lab workspace",
    module: "lab",
    need: "lab.view",
    lead: "Sample collection and the lab: samples collected and received, worklists by department and test, the pathologist's approval and the reports released.",
    refused: "the lab workspace",
  },
};

// Where a link of the clinic's and the lab's screens leads inside the
// workspaces (BusinessProvider's paths): their own screens there, any other
// in Business Admin (null).
export function healthWorkspacePath(businessId, section) {
  const [area, id] = String(section || "").split("/");
  const clinic = `/clinic/${businessId}`;
  const lab = `/lab/${businessId}`;
  switch (area) {
    case "clinic-queue": return clinic;
    case "clinic-today": return `${clinic}/today`;
    case "patients": return id ? `${clinic}/patients/${id}` : `${clinic}/patients`;
    case "visits": return id ? `${clinic}/visits/${id}` : `${clinic}/visits`;
    case "lab-orders": return id ? `${lab}/orders/${id}` : `${lab}/orders`;
    case "lab-qc": return `${lab}/qc`;
    case "lab-tests": return `${lab}/tests`;
    default: return null;
  }
}
