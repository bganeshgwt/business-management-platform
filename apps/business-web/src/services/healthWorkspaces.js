// The clinic's two workspaces, screens of their own outside Business Admin
// (src/workspaces/clinic, src/workspaces/lab): the front desk and the doctors
// at /clinic/<clinic>, sample collection and the lab at /lab/<clinic>. The
// bare /clinic and /lab open the clinic chosen last. Who may open each is the
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

// The clinics a workspace can open for this person: their healthcare
// businesses with its tool switched on (their role is checked as it opens),
// the one opened last first.
export function workspaceClinics(businesses, kind) {
  const module = HEALTH_WORKSPACES[kind].module;
  return (businesses || [])
    .filter((business) => business.business_type === "healthcare" && (business.capabilities || []).includes(module))
    .sort((a, b) => String(b.last_opened_at || "").localeCompare(String(a.last_opened_at || "")) || String(a.name).localeCompare(String(b.name)));
}

// The clinic the bare address opens: the only one, or the one chosen last
// (in a workspace or Business Admin's switcher); null when the person must
// choose.
export const chosenClinic = (clinics) => (clinics.length === 1 ? clinics[0] : clinics.find((clinic) => clinic.last_opened_at) || null);
