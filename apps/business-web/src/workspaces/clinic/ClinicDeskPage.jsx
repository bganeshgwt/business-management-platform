import { useState } from "react";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../components/SectionCard";
import { ErrorMessage, Loading } from "../../components/Feedback";
import { dateLong } from "@bmp/shared/format";
import { toast } from "../../services/toast";
import { BusinessHeader } from "../../modules/business/core/pages/ui";
import { useOpenBusiness } from "../../modules/business/core/pages/hooks";
import { DisplayBoard, IssueDialog, QueueCard, QueueTiles } from "../../modules/business/health/pages/TokenQueuePage";
import { OrderTestsDialog } from "../../modules/business/health/pages/VisitPage";
import { useDesk } from "./deskContext";
import PatientAtDesk from "./PatientAtDesk";

// The clinic workspace's desk. The front desk finds or registers the patient
// in front of them and gives them a token for a doctor (or orders their
// tests); beside it, the day's figures and the queue by doctor, each patient
// with how long they have waited, called, skipped, called back or cancelled
// as on the Token queue (Next patient finishes the one being seen and skips a
// called patient who did not come in).
//
// A doctor with a calendar of their own sees their queue first, the width of
// the screen: Next patient, then Start opens the consultation, with the queue
// still beside it; the other doctors' queues below. Giving a token stays in
// More, for a doctor who also keeps the desk.
export default function ClinicDeskPage() {
  const biz = useOpenBusiness();
  const desk = useDesk();
  const [issuing, setIssuing] = useState(null);
  const [testing, setTesting] = useState(null);
  const [board, setBoard] = useState(false);
  const data = desk.data;
  if (board) return <DisplayBoard data={data} name={biz.business.name} onClose={() => setBoard(false)} />;
  const doctorsView = Boolean(desk.mine);
  const frontDesk = desk.can.desk && !doctorsView;
  const isMine = (doctor) => doctorsView && String(doctor.resource_id) === String(desk.mine.resourceId);
  const giveToken = { label: "Give a token", icon: "plus", onClick: () => setIssuing({ patient: null }) };
  return (
    <div className="stack">
      <BusinessHeader icon="users" title={doctorsView ? "Your queue" : "Clinic desk"}
        description={data ? `${dateLong(data.day)}: ${doctorsView ? "call your next patient and start the consultation; the queue stays beside it." : "register the patient, give a token; doctors call the next patient."}` : "Today's queue"}
        primary={frontDesk && <button type="button" className="button" onClick={giveToken.onClick}><Icon name="plus" size={16} /> Give a token</button>}
        secondary={<button type="button" className="button button-secondary" onClick={() => setBoard(true)}><Icon name="grid" size={16} /> Display board</button>}
        more={doctorsView && desk.can.desk ? [giveToken] : undefined} />
      <ErrorMessage message={desk.error} />
      <div className={`cw-desk${frontDesk ? " has-desk" : ""}`}>
        {frontDesk && <PatientAtDesk onToken={(patient) => setIssuing({ patient })} onTests={setTesting} />}
        <section className="cw-queue stack" aria-label="The queue by doctor">
          {!doctorsView && <QueueTiles tokens={desk.tokens} loading={!data} />}
          {!data ? (!desk.error && <Loading label="Reading the queue…" />) : desk.doctors.length === 0 ? (
            <SectionCard icon="users" title="No tokens yet today"><p className="muted">Give the first patient a token when they arrive: find or register them, then choose their doctor.</p></SectionCard>
          ) : (
            <div className="hl-queue">
              {desk.doctors.map((doctor) => (
                <QueueCard key={doctor.resource_id || 0} doctor={doctor} tokens={desk.tokens} now={desk.now} canAct={desk.can.act}
                  onAct={desk.act} onNext={desk.next} onOpenVisit={desk.openVisit} mine={isMine(doctor)} />
              ))}
            </div>
          )}
        </section>
      </div>
      {issuing && (
        <IssueDialog patient={issuing.patient} resourceId={doctorsView && !issuing.patient ? desk.mine.resourceId : ""} onClose={() => setIssuing(null)}
          onSaved={(token) => { setIssuing(null); toast.success(`Token ${token.token_no} for ${token.patient_name}${token.doctor_name ? ` (${token.doctor_name})` : ""}`); desk.reload(); }} />
      )}
      {testing && <OrderTestsDialog patient={testing} onClose={() => setTesting(null)} onSaved={() => setTesting(null)} />}
    </div>
  );
}
