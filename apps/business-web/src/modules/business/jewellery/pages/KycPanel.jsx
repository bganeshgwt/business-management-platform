import { useEffect, useState } from "react";
import Icon from "@bmp/ui/Icon";
import SidePanel from "../../../../components/SidePanel";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import { dateShort } from "@bmp/shared/format";
import { Badge, Field } from "../../core/pages/ui";
import { businessToday, dateTime, newKey } from "../../core/pages/hooks";
import JewelleryPhoto from "./JewelleryPhoto";
import "../styles/jewellery.css";

// A customer's KYC: the documents they showed (the type as the shop names it
// in Jewellery settings, the number, the name on it, the day it was seen and
// a copy) and a firm's beneficial owners. Numbers, PANs and copies are shown
// in full only to those who may see KYC (jewellery.manage); the counter sees
// the last four. Kept at least five years after the customer's last
// transaction, whatever an erasure does; one entered by mistake is set aside
// with why, never deleted.
// contact: { id, name }
export default function KycPanel({ biz, contact, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(null);
  const [owner, setOwner] = useState(null);
  const [aside, setAside] = useState(null);
  const [busy, setBusy] = useState(false);
  const canAdd = biz.can("jewellery.create");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `jewellery/kyc/${contact.id}`, undefined, controller.signal).then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, contact.id, version]);
  const reload = () => setVersion((n) => n + 1);
  const run = async (work, message) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      setData(await work());
      if (message) toast.success(message);
      setAdding(null);
      setOwner(null);
      setAside(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const addDocument = (event) => {
    event.preventDefault();
    run(() => businessWrite(biz.id, `jewellery/kyc/${contact.id}/documents`, { requestKey: adding.requestKey, kind: adding.kind, number: adding.number.trim(),
      nameOnDocument: adding.nameOnDocument.trim() || undefined, seenOn: adding.seenOn, notes: adding.notes.trim() || undefined }), "KYC document recorded.");
  };
  const addOwner = (event) => {
    event.preventDefault();
    run(() => businessWrite(biz.id, `jewellery/kyc/${contact.id}/owners`, { name: owner.name.trim(), role: owner.role.trim(), sharePercent: owner.sharePercent || undefined,
      pan: owner.pan.trim() || undefined }), "Beneficial owner recorded.");
  };
  const setDocAside = (event) => {
    event.preventDefault();
    run(() => businessWrite(biz.id, `jewellery/kyc/${contact.id}/documents/${aside.doc.id}/set-aside`, { reason: aside.reason.trim() }), "Set aside.");
  };
  const aadhaar = adding && /aadhaar/i.test(adding.kind);
  return (
    <SidePanel open title={`KYC · ${contact.name}`} icon="users" wide onClose={onClose}
      rule={data ? (data.keepUntil ? `Kept at least until ${dateShort(data.keepUntil, { year: true })} (five years after the last transaction)` : "Kept at least five years after the last transaction") : undefined}
      footer={data && canAdd && !adding && !owner && (
        <div className="jw-panel-actions">
          <button type="button" className="button" disabled={!data.kinds.length} onClick={() => setAdding({ requestKey: newKey(), kind: data.kinds[0], number: "", nameOnDocument: contact.name || "",
            seenOn: businessToday(biz.business.timezone), notes: "" })}><Icon name="plus" size={15} /> Record a document</button>
          <button type="button" className="button button-secondary" onClick={() => setOwner({ name: "", role: "", sharePercent: "", pan: "" })}><Icon name="user" size={15} /> A beneficial owner</button>
        </div>
      )}>
      <ErrorMessage message={error} />
      {!data ? !error && <Loading /> : (
        <div className="stack">
          {!data.full && <p className="jw-note">Numbers show their last four characters; those who may see KYC see them in full and open the copies.</p>}
          {canAdd && !data.kinds.length && <p className="jw-note">Name the KYC documents the shop accepts in Jewellery settings first.</p>}
          {adding && (
            <form className="form-grid bz-form" onSubmit={addDocument}>
              <Field label="Document"><select value={adding.kind} onChange={(e) => setAdding((a) => ({ ...a, kind: e.target.value }))}>{data.kinds.map((k) => <option key={k} value={k}>{k}</option>)}</select></Field>
              <Field label={aadhaar ? "Last 4 digits of the Aadhaar number" : "Its number"} hint={aadhaar ? data.aadhaarRule : undefined}>
                <input required className="mono" maxLength={aadhaar ? 4 : 40} inputMode={aadhaar ? "numeric" : undefined} value={adding.number}
                  onChange={(e) => setAdding((a) => ({ ...a, number: e.target.value.toUpperCase() }))} />
              </Field>
              <Field label="Name on it"><input maxLength={150} value={adding.nameOnDocument} onChange={(e) => setAdding((a) => ({ ...a, nameOnDocument: e.target.value }))} /></Field>
              <Field label="Seen on"><input required type="date" max={businessToday(biz.business.timezone)} value={adding.seenOn} onChange={(e) => setAdding((a) => ({ ...a, seenOn: e.target.value }))} /></Field>
              <Field label="Notes (optional)" wide><input maxLength={300} value={adding.notes} onChange={(e) => setAdding((a) => ({ ...a, notes: e.target.value }))} /></Field>
              <div className="form-actions field-wide">
                <button type="button" className="button button-secondary" disabled={busy} onClick={() => setAdding(null)}>Cancel</button>
                <button type="submit" className="button" disabled={busy}><Icon name="check" size={16} /> Record it</button>
              </div>
            </form>
          )}
          {owner && (
            <form className="form-grid bz-form" onSubmit={addOwner}>
              <Field label="Owner's name"><input required maxLength={150} value={owner.name} onChange={(e) => setOwner((o) => ({ ...o, name: e.target.value }))} /></Field>
              <Field label="Role"><input required maxLength={60} value={owner.role} onChange={(e) => setOwner((o) => ({ ...o, role: e.target.value }))} placeholder="Partner, director, shareholder…" /></Field>
              <Field label="Share (%)"><input type="number" min="0.01" max="100" step="0.01" value={owner.sharePercent} onChange={(e) => setOwner((o) => ({ ...o, sharePercent: e.target.value }))} /></Field>
              <Field label="PAN"><input className="mono" maxLength={10} value={owner.pan} onChange={(e) => setOwner((o) => ({ ...o, pan: e.target.value.toUpperCase() }))} placeholder="ABCDE1234F" /></Field>
              <div className="form-actions field-wide">
                <button type="button" className="button button-secondary" disabled={busy} onClick={() => setOwner(null)}>Cancel</button>
                <button type="submit" className="button" disabled={busy}><Icon name="check" size={16} /> Record the owner</button>
              </div>
            </form>
          )}
          <section>
            <h3 className="jw-subhead">Documents</h3>
            {data.documents.length === 0 ? <p className="jw-note">No KYC document recorded yet.</p> : data.documents.map((d) => (
              <div key={d.id} className={`jw-kyc ${d.removed_at ? "dg-tone-muted" : ""}`}>
                <div className="jw-piece-head">
                  <strong>{d.kind}</strong><span className="mono">{d.number}</span>
                  {d.removed_at ? <Badge tone="neutral" label="Set aside" /> : null}
                </div>
                <p className="muted small">{d.name_on_document ? `${d.name_on_document} · ` : ""}Seen on {dateShort(d.seen_on, { year: true })} · recorded {dateTime(d.created_at)} by {d.by_name}
                  {d.removed_at ? ` · set aside ${dateTime(d.removed_at)} by ${d.removed_by_name}: ${d.remove_reason}` : ""}</p>
                {data.full && (d.copy_id || (!d.removed_at && canAdd)) && (
                  <JewelleryPhoto biz={biz} fileId={d.copy_id} kycId={d.id} pdf canChange={!d.removed_at && canAdd} label="Copy" onChanged={reload} />
                )}
                {!data.full && !d.removed_at && canAdd && !d.has_copy && <JewelleryPhoto biz={biz} kycId={d.id} pdf canChange label="Copy" onChanged={reload} />}
                {!data.full && d.has_copy && <p className="muted small">A copy is kept.</p>}
                {data.full && !d.removed_at && aside?.doc.id !== d.id && <button type="button" className="link-button danger" disabled={busy} onClick={() => setAside({ doc: d, reason: "" })}>Set aside</button>}
                {aside?.doc.id === d.id && (
                  <form className="jw-row" onSubmit={setDocAside}>
                    <Field label="Why it is set aside (it is kept)"><input required maxLength={300} value={aside.reason} onChange={(e) => setAside((a) => ({ ...a, reason: e.target.value }))} placeholder="e.g. Typed by mistake" /></Field>
                    <button type="button" className="button button-secondary" disabled={busy} onClick={() => setAside(null)}>Cancel</button>
                    <button type="submit" className="button danger" disabled={busy}>Set aside</button>
                  </form>
                )}
              </div>
            ))}
          </section>
          {(data.owners.length > 0 || owner) && (
            <section>
              <h3 className="jw-subhead">Beneficial owners</h3>
              <table className="jw-rates">
                <thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Share</th><th scope="col">PAN</th><th scope="col">Action</th></tr></thead>
                <tbody>{data.owners.map((o) => (
                  <tr key={o.id} className={o.removed_at ? "dg-tone-muted" : ""}>
                    <th scope="row">{o.name}</th><td>{o.role}</td><td>{o.share_percent ? `${Number(o.share_percent)}%` : "—"}</td><td className="mono">{o.pan || "—"}</td>
                    <td>{o.removed_at ? "Set aside" : data.full && <button type="button" className="link-button danger" disabled={busy}
                      onClick={() => run(() => businessWrite(biz.id, `jewellery/kyc/${contact.id}/owners/${o.id}/set-aside`, {}), "Set aside.")}>Set aside</button>}</td>
                  </tr>
                ))}</tbody>
              </table>
            </section>
          )}
          <p className="muted small">Last transaction: {data.lastTransaction ? dateShort(data.lastTransaction, { year: true }) : "none yet"}.</p>
        </div>
      )}
    </SidePanel>
  );
}
