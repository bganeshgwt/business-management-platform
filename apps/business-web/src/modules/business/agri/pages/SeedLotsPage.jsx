import { useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../../components/Modal";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, newKey, quantity, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { seedClassWord } from "./agri";
import "../styles/agri.css";

// Seed lots: each lot of a seed item received, with its tag kept: the date
// of test, germination, physical purity, the tag number and the SATHI QR
// texts scanned for it. A lot is valid for 9 months from its test; a passing
// retest makes it valid 6 months longer, and every retest is kept. The lot's
// expiry follows the validity wherever it is held, so the counter sells it
// until then and not after. The tag's test is corrected only until a retest.

const VALID_MONTHS = 9;
const RETEST_MONTHS = 6;
const STATES = [
  { value: "", label: "Every lot" }, { value: "lapsed", label: "Lapsed" }, { value: "expiring", label: "Running out (30 days)" },
  { value: "no_tag", label: "Tag not kept" },
];
const STATE_BADGES = { lapsed: { tone: "danger", label: "Lapsed" }, expiring: { tone: "warning", label: "Running out" }, no_date: { tone: "neutral", label: "No date" } };

// A date some months on, as the server works it out (a month's last day when the day is past its end).
function addMonths(day, months) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || "")) return "";
  const [y, m, d] = day.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}
const percent = (value) => (value === null || value === undefined ? "" : `${Number(value)}%`);

export default function SeedLotsPage() {
  const biz = useOpenBusiness();
  const locations = biz.locations.filter((l) => l.active);
  const [location, setLocation] = useState("");
  const [state, setState] = useState("");
  const [inStock, setInStock] = useState(true);
  const [tagging, setTagging] = useState(null);
  const [openId, setOpenId] = useState(null);
  const canEdit = biz.can("inventory.edit");
  const params = { ...(location ? { location } : {}), ...(state === "no_tag" ? { no_tag: "true" } : state ? { state } : {}), ...(inStock ? { in_stock: "true" } : {}) };
  const list = useServerList("agri/seed-lots", { gridId: "agri-seed-lots", params });
  const columns = useMemo(() => [
    { key: "label", header: "Seed", value: (l) => l.label, mobile: "title", pin: true,
      render: (l) => <span className="bz-two-line"><span>{l.label}</span>{(l.crop || l.variety) && <small className="muted">{[l.crop, l.variety].filter(Boolean).join(" · ")}</small>}</span> },
    { key: "lot_code", header: "Lot", value: (l) => l.lot_code, className: "mono", mobile: "subtitle" },
    locations.length > 1 && { key: "location_name", header: "At", value: (l) => l.location_name },
    { key: "quantity", header: "In stock", type: "number", value: (l) => Number(l.quantity), render: (l) => quantity(l.quantity, l.unit) },
    { key: "seed_class", header: "Class", value: (l) => seedClassWord(l.seed_class), defaultHidden: true },
    { key: "tag_no", header: "Tag no.", value: (l) => l.tag_no || "", className: "mono" },
    { key: "tested_on", header: "Tested", type: "date", value: (l) => l.tested_on },
    { key: "germination", header: "Germination", value: (l) => percent(l.germination) },
    { key: "purity", header: "Purity", value: (l) => percent(l.purity), defaultHidden: true },
    { key: "expires_on", header: "Valid until", type: "date", value: (l) => l.expires_on, mobile: "show",
      render: (l) => <span className="bz-inline">{l.expires_on ? dateShort(l.expires_on, { year: true }) : <span className="muted">—</span>}{STATE_BADGES[l.state] && <Badge {...STATE_BADGES[l.state]} />}</span> },
    { key: "retests", header: "Retests", type: "number", value: (l) => l.retests, defaultHidden: true },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (l) => (l.no_tag
      ? canEdit && <button type="button" className="chip-button" onClick={() => setTagging(l)}>Keep the tag</button>
      : <button type="button" className="chip-button" onClick={() => setOpenId(l.seed_lot_id)}>Open</button>) },
  ].filter(Boolean), [canEdit, locations.length]);
  return (
    <div className="stack">
      <BusinessHeader icon="leaf" title="Seed lots"
        description="Each seed lot's tag: the date of test, germination, purity, the tag number and its SATHI QR. A lot is valid 9 months from its test and 6 months more for each passing retest; the counter sells it until then." />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="leaf" title="Lots">
        <DataGrid {...list.gridProps} caption="Seed lots" columns={columns} rowNoun={["lot", "lots"]}
          rowClassName={(l) => (l.state === "lapsed" ? "dg-tone-danger" : l.no_tag || l.state === "expiring" ? "dg-tone-warning" : "")}
          toolbar={(
            <>
              {locations.length > 1 && (
                <label className="field">
                  <span>At</span>
                  <select value={location} onChange={(e) => setLocation(e.target.value)}>
                    <option value="">Every location</option>
                    {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </label>
              )}
              <label className="field">
                <span>Show</span>
                <select value={state} onChange={(e) => setState(e.target.value)}>{STATES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select>
              </label>
              <label className="checkbox bz-check"><input type="checkbox" checked={inStock} onChange={(e) => setInStock(e.target.checked)} /> In stock only</label>
            </>
          )}
          exportName={biz.can("inventory.export") ? `${biz.business.code}-seed-lots` : undefined}
          empty="No seed lots" emptyHint="Seed received with a lot number shows here; keep each lot's tag so the counter knows its validity." emptyIcon="leaf" />
      </SectionCard>
      {tagging && <TagDialog lot={tagging} onClose={() => setTagging(null)}
        onSaved={(d) => { setTagging(null); list.reload(); toast.success(`Lot ${d.lot_code}'s tag kept: valid until ${dateShort(d.valid_until, { year: true })}.`); setOpenId(d.id); }} />}
      {openId && <SeedLotDetail seedLotId={openId} onClose={() => { setOpenId(null); list.reload(); }} />}
    </div>
  );
}

// The test fields a tag and a retest share.
function TestFields({ form, set, today, label = "Date of test" }) {
  return (
    <>
      <Field label={label}><input type="date" required max={today} value={form.testedOn} onChange={set("testedOn")} /></Field>
      <Field label="Germination %"><input type="number" required min="0" max="100" step="0.01" inputMode="decimal" value={form.germination} onChange={set("germination")} /></Field>
      <Field label="Physical purity %"><input type="number" required min="0" max="100" step="0.01" inputMode="decimal" value={form.purity} onChange={set("purity")} /></Field>
    </>
  );
}

function TagDialog({ lot, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [form, setForm] = useState({ testedOn: "", germination: "", purity: "", tagNo: "", qrText: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const validUntil = addMonths(form.testedOn, VALID_MONTHS);
  const submit = () => businessWrite(biz.id, "agri/seed-lots", { skuId: lot.sku_id, lotCode: lot.lot_code, testedOn: form.testedOn, germination: form.germination, purity: form.purity,
    tagNo: form.tagNo.trim() || null, qrText: form.qrText.trim() || null });
  return (
    <FormDialog title={`Keep the tag of lot ${lot.lot_code}`} icon="leaf" width={620} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      description={`${lot.label}. The lot is valid for ${VALID_MONTHS} months from its date of test, at every location that holds it.`}>
      <TestFields form={form} set={set} today={today} />
      <Field label="Tag number (optional)"><input maxLength={60} className="mono" value={form.tagNo} onChange={set("tagNo")} /></Field>
      <Field label="SATHI QR (optional)" wide hint="Scan the tag's QR into this box; more can be added later.">
        <input maxLength={1000} className="mono" value={form.qrText} onChange={set("qrText")} />
      </Field>
      {validUntil && <p className="field-wide small">Valid until <strong>{dateShort(validUntil, { year: true })}</strong>{validUntil < today ? ": already lapsed, so the counter will not sell it." : "."}</p>}
    </FormDialog>
  );
}

function SeedLotDetail({ seedLotId, onClose }) {
  const biz = useOpenBusiness();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [action, setAction] = useState(null);
  const canEdit = biz.can("inventory.edit");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `agri/seed-lots/${seedLotId}`, undefined, controller.signal)
      .then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, seedLotId, version]);
  const saved = (d, message) => { setData(d); setAction(null); toast.success(message); };
  const lapsed = data && data.valid_until < data.today;
  return (
    <>
      <Modal title={data ? `${data.label}: lot ${data.lot_code}` : "Loading…"} icon="leaf" width={860} onClose={() => { if (!action) onClose(); }}
        description={data ? [data.crop, data.variety, seedClassWord(data.seed_class)].filter(Boolean).join(" · ") : undefined}>
        <ErrorMessage message={error} />
        {!data && !error && <Loading />}
        {data && (
          <div className="stack bz-detail">
            <dl className="agri-facts">
              <div><dt>Valid until</dt><dd className="bz-inline">{dateShort(data.valid_until, { year: true })}{lapsed && <Badge tone="danger" label="Lapsed" />}</dd></div>
              <div><dt>Tested on</dt><dd>{dateShort(data.tested_on, { year: true })}</dd></div>
              <div><dt>Germination</dt><dd>{percent(data.germination)}</dd></div>
              <div><dt>Physical purity</dt><dd>{percent(data.purity)}</dd></div>
              {data.tag_no && <div><dt>Tag no.</dt><dd className="mono">{data.tag_no}</dd></div>}
            </dl>
            <DataGrid variant="compact" id="agri-seed-lot-held" caption="Where it is held" rows={data.held} rowNoun={["location", "locations"]} empty="Not held anywhere"
              columns={[
                { key: "location_name", header: "At", value: (h) => h.location_name, mobile: "title" },
                { key: "quantity", header: "In stock", type: "number", value: (h) => Number(h.quantity), render: (h) => quantity(h.quantity, data.unit), mobile: "show" },
                { key: "expires_on", header: "Expiry on the lot", type: "date", value: (h) => h.expires_on },
              ]} />
            <DataGrid variant="compact" id="agri-seed-retests" caption="Retests" rows={data.retests} rowNoun={["retest", "retests"]} empty="Not retested"
              columns={[
                { key: "tested_on", header: "Retested", type: "date", value: (r) => r.tested_on, mobile: "title" },
                { key: "passed", header: "Result", value: (r) => (r.passed ? "Passed" : "Failed"), render: (r) => <Badge tone={r.passed ? "success" : "danger"} label={r.passed ? "Passed" : "Failed"} />, mobile: "subtitle" },
                { key: "germination", header: "Germination", value: (r) => percent(r.germination) },
                { key: "purity", header: "Purity", value: (r) => percent(r.purity) },
                { key: "report_no", header: "Report no.", value: (r) => r.report_no || "", className: "mono" },
                { key: "valid_after", header: "Valid until after it", type: "date", value: (r) => r.valid_after, mobile: "show" },
                { key: "created_by_name", header: "Kept by", value: (r) => r.created_by_name, defaultHidden: true },
                { key: "notes", header: "Notes", value: (r) => r.notes || "", defaultHidden: true },
              ]} />
            <div>
              <h3 className="agri-subhead">SATHI QR scanned</h3>
              {data.qr_codes.length ? (
                <ul className="agri-qr-list">{data.qr_codes.map((q) => <li key={q.id}><span className="mono">{q.qr_text}</span> <small className="muted">{q.created_by_name}, {dateShort(q.created_at)}</small></li>)}</ul>
              ) : <p className="small muted">None scanned yet.</p>}
            </div>
            {canEdit && (
              <div className="form-actions bz-start">
                <button type="button" className="button" onClick={() => setAction("retest")}><Icon name="refresh" size={15} /> Record a retest</button>
                <button type="button" className="button button-secondary" onClick={() => setAction("qr")}><Icon name="qr" size={15} /> Scan a QR</button>
                {data.retests.length === 0 && <button type="button" className="button button-secondary" onClick={() => setAction("correct")}><Icon name="edit" size={15} /> Correct the tag</button>}
              </div>
            )}
          </div>
        )}
      </Modal>
      {action === "retest" && <RetestDialog lot={data} onClose={() => setAction(null)}
        onSaved={(d) => saved(d, d.valid_until !== data.valid_until ? `Retest kept: lot ${d.lot_code} is valid until ${dateShort(d.valid_until, { year: true })}.` : "Retest kept; the lot's validity stays as it was.")} />}
      {action === "qr" && <QrDialog lot={data} onClose={() => setAction(null)} onSaved={(d) => saved(d, "QR kept.")} />}
      {action === "correct" && <CorrectDialog lot={data} onClose={() => setAction(null)} onSaved={(d) => { saved(d, "Tag corrected."); setVersion((n) => n + 1); }} />}
    </>
  );
}

function RetestDialog({ lot, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ testedOn: today, germination: "", purity: "", passed: "yes", reportNo: "", notes: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const submit = () => businessWrite(biz.id, `agri/seed-lots/${lot.id}/retests`, { requestKey, testedOn: form.testedOn, germination: form.germination, purity: form.purity,
    passed: form.passed === "yes", reportNo: form.reportNo.trim() || null, notes: form.notes.trim() || null });
  return (
    <FormDialog title={`Retest of lot ${lot.lot_code}`} icon="refresh" width={620} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      description={`Valid until ${dateShort(lot.valid_until, { year: true })} now. A passing retest makes it valid until ${dateShort(addMonths(lot.valid_until, RETEST_MONTHS), { year: true })}; a failed one is kept and changes nothing.`}>
      <TestFields form={form} set={set} today={today} label="Date of the retest" />
      <Field label="Result">
        <select value={form.passed} onChange={set("passed")}><option value="yes">Passed</option><option value="no">Failed</option></select>
      </Field>
      <Field label="Report number (optional)"><input maxLength={60} className="mono" value={form.reportNo} onChange={set("reportNo")} /></Field>
      <Field label="Notes (optional)" wide><input maxLength={300} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

function QrDialog({ lot, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [qrText, setQrText] = useState("");
  const submit = () => businessWrite(biz.id, `agri/seed-lots/${lot.id}/qr-codes`, { qrText: qrText.trim() });
  return (
    <FormDialog title={`Scan a QR for lot ${lot.lot_code}`} icon="qr" width={560} submitLabel="Keep it" onClose={onClose} onSaved={onSaved} onSubmit={submit}
      description="The SATHI QR on the lot's tag or on one of its packs. Each QR is kept once.">
      <Field label="QR text" wide><input required autoFocus maxLength={1000} className="mono" value={qrText} onChange={(e) => setQrText(e.target.value)} /></Field>
    </FormDialog>
  );
}

function CorrectDialog({ lot, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [form, setForm] = useState({ testedOn: lot.tested_on, germination: String(Number(lot.germination)), purity: String(Number(lot.purity)), tagNo: lot.tag_no || "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const validUntil = form.testedOn === lot.tested_on ? lot.valid_until : addMonths(form.testedOn, VALID_MONTHS);
  const submit = () => businessWrite(biz.id, `agri/seed-lots/${lot.id}`, { testedOn: form.testedOn, germination: form.germination, purity: form.purity, tagNo: form.tagNo.trim() || null }, "put");
  return (
    <FormDialog title={`Correct the tag of lot ${lot.lot_code}`} icon="edit" width={620} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      description="As the tag says, until the lot is retested. A new date of test moves the validity with it.">
      <TestFields form={form} set={set} today={today} />
      <Field label="Tag number (optional)"><input maxLength={60} className="mono" value={form.tagNo} onChange={set("tagNo")} /></Field>
      {validUntil && <p className="field-wide small">Valid until <strong>{dateShort(validUntil, { year: true })}</strong>.</p>}
    </FormDialog>
  );
}
