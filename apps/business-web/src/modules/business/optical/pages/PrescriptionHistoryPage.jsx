import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import { Badge, BusinessHeader } from "../../core/pages/ui";
import { businessToday, useOpenBusiness } from "../../core/pages/hooks";
import PrescriptionDialog from "./PrescriptionDialog";
import { LensTable, RxTable } from "./RxGrid";
import { printPrescription } from "./opticalPrint";
import { EYES, STATUSES, pdText, power, recallLink, rowOf } from "./optical";
// A reminder needs the customer's consent to reminders (asked first, in one tap).
import { useConsentGate } from "../../../personal-data/useConsentGate";
import { useShopPrivacy } from "../../../personal-data/usePrivacy";
import "../styles/optical.css";

// One customer's eye tests side by side, newest first: each power for each
// eye with how it moved since the test before, the PD and who examined;
// then each prescription in full (spectacles, or contact lenses), the
// spectacle orders made on them, and when the next eye test is due (by the
// shop's months, or a group's: child, contact-lens wearer, progressive wearer).

// The rows of the side-by-side table: what each eye's distance and near powers are.
const LINES = EYES.flatMap((eye) => [
  { key: `${eye.value}-sph`, label: `${eye.short} SPH`, eye: eye.value, zone: "distance", field: "sph" },
  { key: `${eye.value}-cyl`, label: `${eye.short} CYL`, eye: eye.value, zone: "distance", field: "cyl" },
  { key: `${eye.value}-axis`, label: `${eye.short} AXIS`, eye: eye.value, zone: "distance", field: "axis" },
  { key: `${eye.value}-add`, label: `${eye.short} ADD`, eye: eye.value, zone: "near", field: "add" },
  { key: `${eye.value}-acuity`, label: `${eye.short} acuity`, eye: eye.value, zone: "distance", field: "acuity" },
]);
// A near ADD may be written on the intermediate row only.
const valueOf = (p, line) => {
  const r = rowOf(p.rows, line.eye, line.zone) || (line.field === "add" ? rowOf(p.rows, line.eye, "intermediate") : null);
  const value = r ? r[line.field] : null;
  return value === undefined ? null : value;
};
const show = (line, value) => (value === null ? "" : ["sph", "cyl", "add"].includes(line.field) ? power(value) : String(value));

export default function PrescriptionHistoryPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const { contactId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState(null);
  const gate = useConsentGate(useShopPrivacy());
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `optical/customers/${contactId}`, undefined, controller.signal)
      .then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, contactId, version]);
  if (!data) return <div className="stack"><BusinessHeader icon="eye" title="Prescriptions" /><ErrorMessage message={error} />{!error && <Loading />}</div>;

  const { customer, prescriptions, orders, recall } = data;
  const latest = prescriptions[0] || null;
  // Spectacles are made from a spectacle prescription; the powers side by side are theirs.
  const spectacles = prescriptions.filter((p) => p.kind !== "contact_lens");
  const latestSpectacles = spectacles[0] || null;
  const today = businessToday(biz.business.timezone);
  const due = recall.due_on && recall.due_on <= today;
  const canRecord = biz.can("optical.create");
  const canBook = canRecord && biz.can("sales.create");
  const shown = spectacles.slice(0, 6);
  const remind = async () => {
    if (!(await gate.ensure("reminders", { id: customer.id, name: customer.name }))) return;
    if (customer.phone) window.open(recallLink(biz, { ...customer, examined_on: latest?.examined_on }), "_blank", "noopener");
    businessWrite(biz.id, `optical/recall/${customer.id}/reminders`, { channel: "whatsapp" }).then(() => setVersion((n) => n + 1)).catch((err) => toast.error(getErrorMessage(err)));
  };
  const print = async (p) => {
    try { printPrescription(biz, await businessRead(biz.id, `optical/prescriptions/${p.id}`)); } catch (err) { toast.error(getErrorMessage(err)); }
  };
  const correct = async (p) => {
    try { setDialog({ prescription: await businessRead(biz.id, `optical/prescriptions/${p.id}`) }); } catch (err) { toast.error(getErrorMessage(err)); }
  };

  return (
    <div className="stack">
      <BusinessHeader icon="eye" title={customer.name}
        description={[customer.phone, `${prescriptions.length} ${prescriptions.length === 1 ? "eye test" : "eye tests"}`, `${orders.length} spectacle ${orders.length === 1 ? "order" : "orders"}`].filter(Boolean).join(" · ")}
        primary={canRecord && <button type="button" className="button" onClick={() => setDialog({ customer })}><Icon name="plus" size={16} /> Record a prescription</button>}
        secondary={(
          <>
            <Link className="button button-secondary" to={biz.path("prescriptions")}><Icon name="arrow-left" size={15} /> All prescriptions</Link>
            {canBook && latestSpectacles && <button type="button" className="button button-secondary" onClick={() => navigate(biz.path(`spectacle-orders?new=1&prescription=${latestSpectacles.id}`))}><Icon name="clipboard" size={15} /> Book a spectacle order</button>}
          </>
        )} />
      <ErrorMessage message={error} />
      <div className="stat-grid">
        <StatTile icon="eye" tone="primary" label="Last eye test" value={latest ? dateShort(latest.examined_on, { year: true }) : "None"} note={latest ? `by ${latest.examiner_name}` : undefined} />
        <StatTile icon="calendar" tone={due ? "warning" : "neutral"} label="Next test due" value={recall.due_on ? dateShort(recall.due_on, { year: true }) : "—"}
          note={recall.reminded_at ? `reminded ${dateShort(recall.reminded_at)}` : `${recall.months} months after the last test${recall.groups?.length ? ` (${recall.groups.join(", ")})` : ""}`} />
        <StatTile icon="clipboard" label="Spectacle orders" value={String(orders.length)} note={orders[0] ? `last ${orders[0].order_no}` : undefined} />
      </div>
      {due && (
        <SectionCard icon="bell" title="Due for an eye test" description={`The last test was ${recall.months} or more months ago.`}
          actions={<button type="button" className="button button-secondary" onClick={remind}><Icon name="message" size={15} /> {customer.phone ? "Remind on WhatsApp" : "Note a reminder"}</button>} />
      )}
      {shown.length > 1 && (
        <SectionCard icon="chart" title="Powers side by side" description="Newest first. Each power shows how it changed since the test before it.">
          <div className="opt-rx-wrap">
            <table className="opt-history">
              <caption className="sr-only">Powers at each eye test</caption>
              <thead>
                <tr><th scope="col">Power</th>{shown.map((p) => <th key={p.id} scope="col">{dateShort(p.examined_on, { year: true })}<small>{p.examiner_name}</small></th>)}</tr>
              </thead>
              <tbody>
                {LINES.filter((line) => shown.some((p) => valueOf(p, line) !== null)).map((line) => (
                  <tr key={line.key}>
                    <th scope="row">{line.label}</th>
                    {shown.map((p, index) => {
                      const value = valueOf(p, line);
                      const older = shown[index + 1] ? valueOf(shown[index + 1], line) : null;
                      const change = ["sph", "cyl", "add"].includes(line.field) && value !== null && older !== null ? Number(value) - Number(older) : 0;
                      return (
                        <td key={p.id}>{show(line, value)}
                          {change !== 0 && <span className={`opt-change ${Math.abs(Number(value)) > Math.abs(Number(older)) ? "is-up" : "is-down"}`}
                            title={`${power(change)} since the test before`}>{power(change)}</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                <tr><th scope="row">PD</th>{shown.map((p) => <td key={p.id}>{pdText(p)}</td>)}</tr>
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}
      {prescriptions.map((p) => (
        <SectionCard key={p.id} icon="eye" title={`${p.kind === "contact_lens" ? "Contact-lens test" : "Eye test"} of ${dateShort(p.examined_on, { year: true })}`}
          description={[`by ${p.examiner_name}${p.registration_no ? ` (Reg. no. ${p.registration_no}${p.registration_council ? `, ${p.registration_council}` : ""})` : ""}`,
            p.kind === "contact_lens" ? null : `PD ${pdText(p) || "—"}`, p.vertex_distance ? `vertex ${Number(p.vertex_distance)} mm` : null,
            p.age_years !== null && p.age_years !== undefined ? `age ${p.age_years}` : null, p.referred_by ? `referred by ${p.referred_by}` : null,
            `valid until ${dateShort(p.valid_until, { year: true })}`].filter(Boolean).join(" · ")}
          actions={(
            <span className="bz-row-actions">
              {p.lapsed && <Badge tone="warning" label="Lapsed" />}
              {p.registration_lapsed && <Badge tone="danger" label="Registration ran out" />}
              {canBook && p.kind !== "contact_lens" && <button type="button" className="chip-button" onClick={() => navigate(biz.path(`spectacle-orders?new=1&prescription=${p.id}`))}>Book an order</button>}
              {canRecord && !p.orders && <button type="button" className="chip-button" onClick={() => correct(p)}>Correct</button>}
              {biz.can("optical.print") && <button type="button" className="chip-button" onClick={() => print(p)}><Icon name="print" size={13} /> Print</button>}
            </span>
          )}>
          {p.kind === "contact_lens" ? <LensTable lenses={p.lenses} caption={`Contact lenses of ${dateShort(p.examined_on, { year: true })}`} />
            : <RxTable rows={p.rows} caption={`Powers of ${dateShort(p.examined_on, { year: true })}`} />}
          {p.notes && <p className="muted small">{p.notes}</p>}
          {orders.filter((o) => o.prescription_id === p.id).length > 0 && (
            <p className="small">Orders on it: {orders.filter((o) => o.prescription_id === p.id).map((o, i) => (
              <span key={o.id}>{i > 0 && " · "}<Link to={biz.path(`spectacle-orders/${o.id}`)}>{o.order_no}</Link> ({STATUSES[o.status]?.label.toLowerCase()})</span>
            ))}</p>
          )}
        </SectionCard>
      ))}
      {!prescriptions.length && <SectionCard icon="eye" title="No eye test yet"><p className="muted">Record the powers from an eye test, or from a prescription the customer brought.</p></SectionCard>}
      {dialog && <PrescriptionDialog prescription={dialog.prescription || null} customer={dialog.customer || null} onClose={() => setDialog(null)}
        onSaved={() => { setDialog(null); toast.success("Prescription saved."); setVersion((n) => n + 1); }} />}
      {gate.dialog}
    </div>
  );
}
