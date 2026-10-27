import { Outlet } from "react-router-dom";
import BusinessWorkspace, { WorkspaceFrame } from "../../layouts/BusinessWorkspace";
import { useOpenBusiness } from "../../modules/business/core/pages/hooks";
import { DeskContext } from "./deskContext";
import useClinicDesk from "./useClinicDesk";
import "../../modules/business/health/styles/health.css";
import "./styles/clinic.css";

// The clinic workspace (/clinic/<clinic>): one screen for the front desk and
// the doctors. A route group of the staff app with a layout of its own, built
// from the clinic's own screens and APIs (docs/ARCHITECTURE.md › Turn a
// planned screen into a real one):
//
//   /clinic/<id>                  the desk: the patient at the desk (found, or
//                                 registered with consent, and given a token)
//                                 beside the queue by doctor with waiting
//                                 times; a doctor's own queue first
//   /clinic/<id>/visits/<visit>   the consultation (the clinic's own visit
//                                 screen), with the doctor's queue and the
//                                 patient's history beside it
//   /clinic/<id>/today            today's appointments (Today's patients)
//   /clinic/<id>/patients[/<id>]  patients, and a patient's page
//   /clinic/<id>/visits           visits and the follow-ups due
//
// Who may open it is the clinic's own rule, as for its Token queue
// (patients.view); each screen asks the API only what the person may read,
// and the clinical record opens only to clinical roles. The queue is read
// once here and shared by the screens (deskContext), live within a second.
export default function ClinicLayout() {
  return (
    <BusinessWorkspace kind="clinic">
      <ClinicShell />
    </BusinessWorkspace>
  );
}

function ClinicShell() {
  const biz = useOpenBusiness();
  const desk = useClinicDesk();
  const base = `/clinic/${biz.id}`;
  const waiting = desk.mine ? desk.counts.mine : desk.counts.all;
  const tabs = [
    { to: base, label: waiting ? `Queue · ${waiting}` : "Queue", icon: "users" },
    { to: `${base}/today`, label: "Today", icon: "reservations" },
    { to: `${base}/patients`, label: "Patients", icon: "customers" },
    { to: `${base}/visits`, label: "Visits", icon: "logbook" },
  ];
  return (
    <DeskContext.Provider value={desk}>
      <WorkspaceFrame kind="clinic" live={desk.live} tabs={tabs}>
        <Outlet />
      </WorkspaceFrame>
    </DeskContext.Provider>
  );
}
