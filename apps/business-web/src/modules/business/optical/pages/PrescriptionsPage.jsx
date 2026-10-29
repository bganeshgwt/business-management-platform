import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import { Badge, BusinessHeader } from "../../core/pages/ui";
import { useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { Segmented } from "../../fashion/pages/shared";
import PrescriptionDialog from "./PrescriptionDialog";
import { printPrescription } from "./opticalPrint";
import { KINDS, pdText, powersSummary } from "./optical";
import "../styles/optical.css";

// Prescriptions: every eye test recorded here or brought in, newest first,
// spectacles or contact lenses, each with its customer, who examined (a
// registration that had run out marked), the powers in one line, the PD,
// the doctor who referred them and the day it is valid until. A customer's
// name opens their history (the powers side by side). A prescription no
// spectacle order uses yet can be corrected; one on an order never changes.
export default function PrescriptionsPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [latestOnly, setLatestOnly] = useState(true);
  const [kind, setKind] = useState("spectacles");
  const list = useServerList("optical/prescriptions", { gridId: "optical-prescriptions", params: { kind, ...(latestOnly ? { latest: "true" } : {}) } });
  const canRecord = biz.can("optical.create");
  const canBook = canRecord && biz.can("sales.create");
  const [editing, setEditing] = useState(() => (params.get("new") === "1" && canRecord ? {} : null));
  useEffect(() => {
    if (params.get("new")) setParams((p) => { const next = new URLSearchParams(p); next.delete("new"); return next; }, { replace: true });
  }, [params, setParams]);
  const correct = async (row) => {
    try { setEditing(await businessRead(biz.id, `optical/prescriptions/${row.id}`)); } catch (err) { toast.error(getErrorMessage(err)); }
  };
  const print = async (row) => {
    try { printPrescription(biz, await businessRead(biz.id, `optical/prescriptions/${row.id}`)); } catch (err) { toast.error(getErrorMessage(err)); }
  };

  const columns = useMemo(() => [
    { key: "customer", header: "Customer", value: (p) => `${p.customer_name} ${p.customer_phone || ""}`, mobile: "title", pin: true,
      render: (p) => <span className="bz-two-line"><button type="button" className="link-button bz-link-left" onClick={() => navigate(biz.path(`prescriptions/${p.contact_id}`))}>{p.customer_name}</button>
        {p.customer_phone && <small className="muted">{p.customer_phone}</small>}</span> },
    { key: "examined_on", header: "Eye test", type: "date", value: (p) => p.examined_on, render: (p) => dateShort(p.examined_on, { year: true }), mobile: "subtitle" },
    { key: "examiner", header: "Examined by", value: (p) => p.examiner_name,
      render: (p) => <span className="bz-two-line"><span>{p.examiner_name}</span>{p.registration_no && <small className={p.registration_lapsed ? "bz-due" : "muted"}>Reg. no. {p.registration_no}{p.registration_lapsed ? " · ran out before the test" : ""}</small>}</span> },
    { key: "powers", header: kind === "contact_lens" ? "Lenses" : "Powers", value: (p) => powersSummary(p), className: "mono", mobile: "show" },
    { key: "pd", header: "PD", value: (p) => pdText(p), defaultHidden: true },
    { key: "referred_by", header: "Referred by", value: (p) => p.referred_by || "", defaultHidden: true },
    { key: "valid_until", header: "Valid until", type: "date", value: (p) => p.valid_until,
      render: (p) => (p.lapsed ? <Badge tone="warning" label={`Lapsed ${dateShort(p.valid_until, { year: true })}`} /> : dateShort(p.valid_until, { year: true })) },
    { key: "orders", header: "Orders", type: "number", value: (p) => p.orders, defaultHidden: true },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (p) => (
      <span className="bz-row-actions">
        {canBook && p.kind === "spectacles" && <button type="button" className="chip-button" onClick={() => navigate(biz.path(`spectacle-orders?new=1&prescription=${p.id}`))}>Book an order</button>}
        {canRecord && !p.orders && <button type="button" className="chip-button" onClick={() => correct(p)}>Correct</button>}
        {biz.can("optical.print") && <button type="button" className="chip-button" onClick={() => print(p)}><Icon name="print" size={13} /> Print</button>}
      </span>
    ) },
  ], [biz, navigate, canBook, canRecord, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="stack">
      <BusinessHeader icon="eye" title="Prescriptions"
        description="Every eye test, with who examined, the powers for each eye (or each contact lens), the PD and the day it is valid until. A customer's name opens their tests side by side. A prescription on a spectacle order never changes: a correction is a new one."
        primary={canRecord && <button type="button" className="button" onClick={() => setEditing({})}><Icon name="plus" size={16} /> Record a prescription</button>} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="eye" title={latestOnly ? "Each customer's latest prescription" : "All prescriptions"}
        actions={<Segmented label="Prescriptions for" options={KINDS} value={kind} onChange={setKind} />}>
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Customer, phone, examiner or registration number" }} caption="Prescriptions"
          columns={columns} rowNoun={["prescription", "prescriptions"]}
          toolbar={<label className="checkbox bz-check"><input type="checkbox" checked={latestOnly} onChange={(e) => setLatestOnly(e.target.checked)} /> Latest of each customer only</label>}
          rowClassName={(p) => (p.lapsed ? "dg-tone-muted" : "")}
          empty="No prescriptions yet" emptyHint={canRecord ? "Record the powers from an eye test, or from a prescription the customer brought." : undefined} emptyIcon="eye" />
      </SectionCard>
      {editing && <PrescriptionDialog prescription={editing.id ? editing : null} onClose={() => setEditing(null)}
        onSaved={(p) => { setEditing(null); toast.success(`${p.customer_name}'s prescription saved.`); list.reload(); }} />}
    </div>
  );
}
