import { useState } from "react";
import { useParams } from "react-router-dom";
import VisitPage from "../../modules/business/health/pages/VisitPage";
import { QueueCard } from "../../modules/business/health/pages/TokenQueuePage";
import { useDesk } from "./deskContext";
import { queueOf } from "./clinicDesk.js";
import PatientHistory from "./PatientHistory";

// Tests ordered from the consultation stay with it: the order joins the
// visit's lab orders and reaches the lab's bench, and the doctor carries on.
const stayOnTheConsultation = () => {};

// A visit in the clinic workspace: the consultation (the clinic's own visit
// screen, never a copy) with the doctor's queue beside it, so the next patient
// is called and started without leaving it, and, for clinical roles, the
// patient's history (the clinical card and earlier visits). On a narrower
// screen the queue comes first, then the consultation, then the history.
export default function ClinicVisitPage() {
  const desk = useDesk();
  const { visitId } = useParams();
  const [loaded, setLoaded] = useState(null);
  // What VisitPage last read, while it is this visit's.
  const visit = loaded && String(loaded.id) === String(visitId) ? loaded : null;
  const doctorId = visit?.resource_id || desk.mine?.resourceId || null;
  const doctor = doctorId ? queueOf(desk.doctors, doctorId, visit?.doctor_name || desk.mine?.name) : null;
  const mine = Boolean(desk.mine) && String(doctorId) === String(desk.mine.resourceId);
  return (
    <div className="cw-consult">
      {doctor && (
        <div className="cw-consult-queue">
          <QueueCard doctor={doctor} tokens={desk.tokens} now={desk.now} canAct={desk.can.act} onAct={desk.act} onNext={desk.next} onOpenVisit={desk.openVisit} mine={mine} />
        </div>
      )}
      <div className="cw-consult-main">
        <VisitPage onLoaded={setLoaded} onOrdered={stayOnTheConsultation} />
      </div>
      {visit?.clinical_access && (
        <div className="cw-consult-history">
          <PatientHistory contactId={visit.contact_id} visitId={visit.id} />
        </div>
      )}
    </div>
  );
}
