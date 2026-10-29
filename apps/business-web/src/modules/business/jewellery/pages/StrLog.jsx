import { useEffect, useState } from "react";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import SidePanel from "../../../../components/SidePanel";
import SearchPicker from "../../../../components/SearchPicker";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import { dateShort } from "@bmp/shared/format";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, Field } from "../../core/pages/ui";
import { businessToday, dateTime, newKey } from "../../core/pages/hooks";
import { STR_STATUSES } from "./jewellery";
import "../styles/jewellery.css";

// The suspicious transaction log: a case for each transaction the shop finds
// suspicious, whatever its amount, with notes as it is looked into and the
// decision once: reported to FIU-IND by the shop's principal officer (outside
// the platform: the day and the acknowledgement are typed in) or not
// reported, with why. Telling the customer is forbidden, so it is seen only by
// those who keep the log (jewellery.review: the owner, and whoever the owner
// gives it); every case opened to read is written in its history.

const ENTRY_WORDS = { opened: "Opened", note: "Note", viewed: "Read", decided: "Decided" };

function OpenCase({ biz, onClose, onSaved }) {
  const [requestKey] = useState(newKey);
  const [customer, setCustomer] = useState(null);
  const [form, setForm] = useState({ subject: "", grounds: "", transactions: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title="Open a case" icon="shield" width={720} onClose={onClose} onSaved={onSaved} submitLabel="Open the case" successMessage={(c) => `Case ${c.case_no} opened.`}
      description="Write what was seen as it happened. The customer is never told: the log is seen only by those who keep it."
      onSubmit={() => businessWrite(biz.id, "jewellery/str", { requestKey, ...(customer ? { contactId: customer.id } : {}), subject: form.subject.trim() || undefined,
        grounds: form.grounds.trim(), transactions: form.transactions.trim() || undefined })}>
      <div className="field-wide">
        <SearchPicker label="Customer (if known)" placeholder="Name or phone" value={customer} onChange={setCustomer} minChars={2}
          search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", q, limit: 15 }, signal).then((page) => page.items)}
          getLabel={(x) => x.name} getDescription={(x) => x.phone || ""} />
      </div>
      {!customer && <Field label="Who, as known" wide><input required maxLength={150} value={form.subject} onChange={set("subject")} placeholder="e.g. A man who would not give his name" /></Field>}
      <Field label="What was seen" wide><textarea required rows={5} maxLength={4000} value={form.grounds} onChange={set("grounds")} /></Field>
      <Field label="The bills and vouchers it concerns (optional)" wide><input maxLength={500} value={form.transactions} onChange={set("transactions")} /></Field>
    </FormDialog>
  );
}

function CasePanel({ biz, caseId, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [deciding, setDeciding] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `jewellery/str/${caseId}`, undefined, controller.signal).then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, caseId]);
  const run = async (work, message) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      setData(await work());
      toast.success(message);
      setNote("");
      setDeciding(null);
      onChanged?.();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const status = data ? STR_STATUSES[data.status] : null;
  return (
    <SidePanel open title={data ? `Case ${data.case_no}` : "Case"} icon="shield" wide onClose={onClose}>
      <ErrorMessage message={error} />
      {!data ? !error && <Loading /> : (
        <div className="stack">
          <div className="jw-piece-head"><Badge tone={status?.tone} label={status?.label || data.status} /><strong>{data.customer_name || data.subject}</strong></div>
          <dl className="jw-facts">
            {[["Who", data.subject], ["What was seen", data.grounds], ["Transactions", data.transactions], ["Opened", `${dateTime(data.created_at)} · ${data.by_name}`],
              ["Reported", data.reported_on ? `${dateShort(data.reported_on, { year: true })}${data.report_ref ? ` · ${data.report_ref}` : ""}` : null],
              ["Decided", data.decided_at ? `${dateTime(data.decided_at)} · ${data.decided_by_name}: ${data.decision_note}` : null]]
              .filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
          <section>
            <h3 className="jw-subhead">Its history</h3>
            <ol className="jw-history">{data.entries.map((e) => <li key={e.id}><span>{dateTime(e.created_at)} · {e.by_name}</span><span>{ENTRY_WORDS[e.kind]}{e.note ? `: ${e.note}` : ""}</span></li>)}</ol>
          </section>
          {data.status === "open" && !deciding && (
            <form className="jw-row" onSubmit={(e) => { e.preventDefault(); run(() => businessWrite(biz.id, `jewellery/str/${data.id}/notes`, { note: note.trim() }), "Note added."); }}>
              <Field label="A note"><input required maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              <button type="submit" className="button button-secondary" disabled={busy}>Add the note</button>
              <button type="button" className="button" disabled={busy} onClick={() => setDeciding({ decision: "reported", note: "", reportedOn: businessToday(biz.business.timezone), reportRef: "" })}>Decide</button>
            </form>
          )}
          {deciding && (
            <form className="form-grid bz-form" onSubmit={(e) => { e.preventDefault(); run(() => businessWrite(biz.id, `jewellery/str/${data.id}/decide`, { decision: deciding.decision,
              note: deciding.note.trim(), ...(deciding.decision === "reported" ? { reportedOn: deciding.reportedOn, reportRef: deciding.reportRef.trim() || undefined } : {}) }), "Decided."); }}>
              <Field label="Decision"><select value={deciding.decision} onChange={(e) => setDeciding((d) => ({ ...d, decision: e.target.value }))}>
                <option value="reported">Reported to FIU-IND</option><option value="not_reported">Not reported</option></select></Field>
              {deciding.decision === "reported" && <>
                <Field label="Reported on"><input required type="date" max={businessToday(biz.business.timezone)} value={deciding.reportedOn} onChange={(e) => setDeciding((d) => ({ ...d, reportedOn: e.target.value }))} /></Field>
                <Field label="Acknowledgement (optional)"><input maxLength={80} value={deciding.reportRef} onChange={(e) => setDeciding((d) => ({ ...d, reportRef: e.target.value }))} /></Field>
              </>}
              <Field label={deciding.decision === "reported" ? "What was reported" : "Why it is not reported"} wide><textarea required rows={3} maxLength={4000} value={deciding.note} onChange={(e) => setDeciding((d) => ({ ...d, note: e.target.value }))} /></Field>
              <p className="field-wide muted small">A case is decided once.</p>
              <div className="form-actions field-wide">
                <button type="button" className="button button-secondary" disabled={busy} onClick={() => setDeciding(null)}>Cancel</button>
                <button type="submit" className="button" disabled={busy}><Icon name="check" size={16} /> Decide</button>
              </div>
            </form>
          )}
        </div>
      )}
    </SidePanel>
  );
}

export default function StrLog({ biz }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "jewellery/str", undefined, controller.signal).then((d) => { setList(d.items); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);
  return (
    <SectionCard icon="shield" title="Suspicious transaction log" description="Only those who keep the log see it; the customer is never told. Reports are filed with FIU-IND by the shop's principal officer, outside the platform."
      actions={<button type="button" className="button button-secondary" onClick={() => setOpening(true)}><Icon name="plus" size={15} /> Open a case</button>}>
      <ErrorMessage message={error} />
      {!list ? !error && <Loading /> : list.length === 0 ? <p className="jw-note">No cases.</p> : (
        <table className="jw-rates">
          <thead><tr><th scope="col">Case</th><th scope="col">Who</th><th scope="col">Opened</th><th scope="col">Notes</th><th scope="col">Where it stands</th></tr></thead>
          <tbody>{list.map((k) => (
            <tr key={k.id}>
              <th scope="row"><button type="button" className="link-button" onClick={() => setOpenId(k.id)}>Case {k.case_no}</button></th>
              <td>{k.customer_name || k.subject}</td><td>{dateTime(k.created_at)} · {k.by_name}</td><td>{k.notes}</td>
              <td><Badge tone={STR_STATUSES[k.status]?.tone} label={STR_STATUSES[k.status]?.label || k.status} /></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {opening && <OpenCase biz={biz} onClose={() => setOpening(false)} onSaved={(c) => { setOpening(false); setVersion((n) => n + 1); setOpenId(c.id); }} />}
      {openId && <CasePanel biz={biz} caseId={openId} onClose={() => setOpenId(null)} onChanged={() => setVersion((n) => n + 1)} />}
    </SectionCard>
  );
}
