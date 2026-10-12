import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import StatusBadge from "../../../../components/StatusBadge";
import { ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { escapeHtml, printDocument } from "../../../../services/print";
import FormDialog from "../../core/pages/FormDialog";
import ReasonDialog from "../../core/pages/ReasonDialog";
import { Badge, BusinessHeader, Field, FormError, PeriodFilter } from "../../core/pages/ui";
import { businessToday, dateTime, newKey, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { Segmented } from "../../fashion/pages/shared";
import { businessDate, refuse } from "../../fashion/pages/feFormat";
import { dateShort } from "../../../../services/format";
import { barcodeSvg } from "../../retail/services/barcode";
import { ClaimStatusDialog } from "./RepairJobPage";

// Warranties: registered from a sold serial / IMEI line (start = the sale
// date, months and terms from the model), found again by IMEI or by the
// customer's phone, printed as a card, cancelled only with a reason.

const WARRANTY_STATES = {
  active: ["active", "In warranty"], expiring: ["warning", "Ends within 30 days"], expired: ["inactive", "Expired"],
  returned: ["neutral", "Unit returned"], cancelled: ["inactive", "Cancelled"], not_started: ["info", "Not started"],
};
const STATE_FILTERS = [{ value: "", label: "All" }, { value: "active", label: "In warranty" }, { value: "expiring", label: "Ending soon" }, { value: "expired", label: "Expired" }, { value: "cancelled", label: "Cancelled" }];

export default function WarrantiesPage() {
  const biz = useOpenBusiness();
  const [state, setState] = useState("");
  const list = useServerList("warranties", { gridId: "electronics-warranties", period: true, params: state ? { state } : {} });
  const [registering, setRegistering] = useState(null);
  const [cancelling, setCancelling] = useState(null);
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState("warranties");
  const canClaims = biz.has("repairs") && biz.can("repairs.view");

  const columns = useMemo(() => [
    { key: "serial", header: "IMEI / serial", value: (w) => w.serial, className: "mono", mobile: "title", pin: true },
    { key: "item", header: "Item", value: (w) => w.item_label, mobile: "subtitle" },
    { key: "customer", header: "Customer", value: (w) => `${w.customer_name} ${w.customer_phone}`, render: (w) => <span className="bz-two-line"><span>{w.customer_name}</span><small className="muted">{w.customer_phone}</small></span>, mobile: "show" },
    { key: "starts_on", header: "From", type: "date", value: (w) => w.starts_on },
    { key: "ends_on", header: "Until", type: "date", value: (w) => w.ends_on, mobile: "show" },
    { key: "state", header: "Status", type: "status", value: (w) => w.state, render: (w) => <Badge tone={WARRANTY_STATES[w.state]?.[0]} label={WARRANTY_STATES[w.state]?.[1]} /> },
    { key: "document_no", header: "Bill", value: (w) => w.document_no, className: "mono", defaultHidden: true },
    { key: "created_at", header: "Registered", type: "datetime", value: (w) => w.created_at, defaultHidden: true },
    (biz.can("warranties.print") || biz.can("warranties.cancel")) && { key: "actions", header: "", label: "Actions", type: "actions", render: (w) => (
      <div className="row-actions">
        {biz.can("warranties.print") && <button type="button" className="chip-button" onClick={() => printCard(biz, w.id)}><Icon name="print" size={14} /> Card</button>}
        {biz.can("warranties.cancel") && w.status === "active" && <button type="button" className="chip-button" onClick={() => setCancelling(w)}>Cancel</button>}
      </div>
    ) },
  ].filter(Boolean), [biz]);

  return (
    <div className="stack">
      <BusinessHeader icon="shield" title="Warranties"
        description="Register a warranty from a sold handset or appliance, and find it again by IMEI, serial or the customer's phone number."
        actions={biz.can("warranties.create") && <button type="button" className="button" onClick={() => setRegistering({})}><Icon name="plus" size={16} /> Register a warranty</button>} />
      <SuccessMessage message={notice} />
      <Lookup onRegister={(line) => setRegistering(line)} />
      {canClaims && <Segmented label="Show" options={[{ value: "warranties", label: "Registered warranties" }, { value: "claims", label: "Claims with brands" }]} value={tab} onChange={setTab} />}
      {tab === "claims" && canClaims ? <Claims /> : (
      <>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="shield" title="Registered warranties" description="Registered in the dates chosen.">
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "IMEI, customer, phone or bill" }} caption="Warranties" columns={columns}
          rowNoun={["warranty", "warranties"]} rowClassName={(w) => (w.state === "expiring" ? "dg-tone-warning" : ["cancelled", "expired", "returned"].includes(w.state) ? "dg-tone-muted" : "")}
          toolbar={<><PeriodFilter list={list} /><Segmented label="Status" options={STATE_FILTERS} value={state} onChange={setState} /></>}
          exportName={biz.can("warranties.export") ? `${biz.business.code}-warranties` : undefined}
          empty="No warranties registered in these dates" emptyHint="Register one from a sale, or pick other dates." emptyIcon="shield" />
      </SectionCard>
      </>
      )}
      {registering && <RegisterDialog preset={registering.line_id ? registering : null} onClose={() => setRegistering(null)}
        onSaved={(w) => { setRegistering(null); setNotice(`Warranty registered for ${w.serial} until ${businessDate(w.ends_on, biz.settings.date_format)}.`); list.reload(); }} />}
      {cancelling && (
        <ReasonDialog title={`Cancel the warranty for ${cancelling.serial}`} submitLabel="Cancel warranty" description="Only for a registration made by mistake. The sale is not changed."
          onClose={() => setCancelling(null)} onSubmit={(reason) => businessWrite(biz.id, `warranties/${cancelling.id}/cancel`, { reason })}
          onSaved={() => { setCancelling(null); setNotice("Warranty cancelled."); list.reload(); }} />
      )}
    </div>
  );
}

// Look up by IMEI / serial / phone: warranties, sold units not yet registered, repairs.
function Lookup({ onRegister }) {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const find = async (event) => {
    event.preventDefault();
    setBusy(true); setError("");
    try { setResult(await businessRead(biz.id, "warranties/lookup", { q: q.trim() })); } catch (err) { setError(getErrorMessage(err)); setResult(null); } finally { setBusy(false); }
  };
  const nothing = result && !result.warranties.length && !result.unregistered.length && !result.repairs.length;
  return (
    <SectionCard icon="search" title="Look up" description="Type or scan an IMEI or serial, or the customer's phone number.">
      <form className="fe-find" onSubmit={find}>
        <label className="field"><span>IMEI, serial or phone</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. 352099001761481 or 98860 22222" /></label>
        <button type="submit" className="button" disabled={busy || q.trim().length < 4}><Icon name="search" size={15} /> {busy ? "Looking…" : "Look up"}</button>
      </form>
      <ErrorMessage message={error} />
      {nothing && <p className="muted">Nothing found for {result.query}.</p>}
      {result && result.warranties.length > 0 && (
        <ul className="fe-results">
          {result.warranties.map((w) => (
            <li key={w.id} className="fe-result">
              <Badge tone={WARRANTY_STATES[w.state]?.[0]} label={WARRANTY_STATES[w.state]?.[1]} />
              <span className="bz-two-line"><strong>{w.item_label} · <span className="mono">{w.serial}</span></strong>
                <small className="muted">{w.customer_name} · {w.customer_phone} · {businessDate(w.starts_on, biz.settings.date_format)} to {businessDate(w.ends_on, biz.settings.date_format)}{w.days_left >= 0 && w.status === "active" ? ` · ${w.days_left} days left` : ""} · bill {w.document_no}</small></span>
              {biz.can("warranties.print") && <button type="button" className="chip-button" onClick={() => printCard(biz, w.id)}><Icon name="print" size={14} /> Card</button>}
            </li>
          ))}
        </ul>
      )}
      {result && result.unregistered.length > 0 && (
        <ul className="fe-results">
          {result.unregistered.map((line) => (
            <li key={line.line_id} className="fe-result">
              <Badge tone="warning" label="Not registered" />
              <span className="bz-two-line"><strong>{line.label} · <span className="mono">{line.serial}</span></strong><small className="muted">Sold on {line.document_no} · {dateTime(line.sold_at)} · {line.contact_name || "walk-in"}</small></span>
              <button type="button" className="chip-button" onClick={() => onRegister(line)}>Register</button>
            </li>
          ))}
        </ul>
      )}
      {result && result.repairs.length > 0 && (
        <ul className="fe-results">
          {result.repairs.map((r) => (
            <li key={r.id} className="fe-result">
              <Badge tone="info" label="Repair" />
              <span className="bz-two-line"><strong className="mono">{r.job_no}</strong><small className="muted">{r.device} · {r.problem} · {dateTime(r.created_at)}</small></span>
              <button type="button" className="chip-button" onClick={() => navigate(biz.path(`repairs/${r.id}`))}>Open</button>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function RegisterDialog({ preset, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const [q, setQ] = useState("");
  const [lines, setLines] = useState(null);
  const formOf = (l) => (l ? { startsOn: l.sold_on, months: String(l.warranty_months || ""), terms: l.warranty_terms || "", customerName: l.contact_name || "", customerPhone: l.contact_phone || "" } : {});
  const [line, setLine] = useState(preset);
  const [error, setError] = useState("");
  const [form, setForm] = useState(() => formOf(preset));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const pick = (l) => { setLine(l); setForm(formOf(l)); };
  useEffect(() => {
    if (line) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => businessRead(biz.id, "warranties/eligible", { q: q.trim() || undefined }, controller.signal)
      .then((rows) => { setLines(rows); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); }), 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [biz.id, q, line]);
  const today = businessToday(biz.business.timezone);
  return (
    <FormDialog title="Register a warranty" icon="shield" width={760} onClose={onClose} onSaved={onSaved}
      submitLabel="Register" description="Choose the sold unit; the start date, months and terms come from the sale and the model."
      onSubmit={async () => { if (!line) throw refuse("Choose the sold unit first."); return businessWrite(biz.id, "warranties", { lineId: line.line_id, requestKey, startsOn: form.startsOn, months: form.months, terms: form.terms || null,
        customerName: form.customerName || undefined, customerPhone: form.customerPhone || undefined }); }}>
      <FormError message={error} />
      {!line ? (
        <div className="field-wide stack">
          <label className="field"><span>Find the sale</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="IMEI, bill number, customer or phone" /></label>
          {!lines && !error && <Loading />}
          {lines && (
            <DataGrid variant="compact" id="warranty-eligible" caption="Sold units without a warranty" rows={lines} rowKey={(l) => l.line_id} rowNoun={["unit", "units"]}
              empty="No sold unit waiting for a warranty" emptyHint="Serial-numbered items appear here once sold."
              columns={[
                { key: "serial", header: "IMEI / serial", value: (l) => l.serial, className: "mono", mobile: "title" },
                { key: "label", header: "Item", value: (l) => l.label, mobile: "subtitle" },
                { key: "document_no", header: "Bill", value: (l) => l.document_no, className: "mono" },
                { key: "sold_at", header: "Sold", type: "datetime", value: (l) => l.sold_at },
                { key: "customer", header: "Customer", value: (l) => l.contact_name || "Walk-in", mobile: "show" },
                { key: "pick", header: "", label: "Choose", type: "actions", render: (l) => <button type="button" className="chip-button" onClick={() => pick(l)}>Choose</button> },
              ]} />
          )}
        </div>
      ) : (
        <>
          <div className="field-wide fe-sale-head">
            <span><strong>{line.label}</strong> · <span className="mono">{line.serial}</span> · sold on {line.document_no}</span>
            {!preset && <button type="button" className="link-button" onClick={() => pick(null)}>Choose another</button>}
          </div>
          <Field label="Customer name"><input required={!line.contact_name} maxLength={150} value={form.customerName || ""} onChange={set("customerName")} /></Field>
          <Field label="Customer phone" hint="The warranty is found again by this number."><input required maxLength={30} inputMode="tel" value={form.customerPhone || ""} onChange={set("customerPhone")} /></Field>
          <Field label="Starts on" hint="Usually the sale date."><input required type="date" min={line.sold_on} max={today} value={form.startsOn || ""} onChange={set("startsOn")} /></Field>
          <Field label="Months"><input required type="number" min="1" max="120" step="1" value={form.months || ""} onChange={set("months")} /></Field>
          <Field label="Terms (printed on the card)" wide><textarea rows={3} maxLength={1000} value={form.terms || ""} onChange={set("terms")} /></Field>
        </>
      )}
    </FormDialog>
  );
}

// A warranty card from what was registered: any state can be reprinted
// (an ended or cancelled one says so across the top).
async function printCard(biz, warrantyId) {
  const w = await businessRead(biz.id, `warranties/${warrantyId}`);
  const seller = w.seller || {};
  const fmt = (value) => escapeHtml(dateShort(value, { year: true }));
  let code = "";
  try { code = barcodeSvg(w.serial).svg; } catch { code = ""; }
  const banner = w.state === "cancelled" ? "CANCELLED" : w.state === "expired" ? "EXPIRED" : w.state === "returned" ? "UNIT RETURNED" : "";
  printDocument({
    title: `Warranty ${w.serial}`,
    styles: "body{font:13px system-ui;color:#111} h1{font-size:18px;margin:0} .card{border:1px solid #333;border-radius:8px;padding:16px;max-width:560px} dl{display:grid;grid-template-columns:140px 1fr;gap:6px 12px;margin:12px 0} dt{color:#555} small{color:#555} .bc{height:44px;width:260px} .bc svg{width:100%;height:100%} .banner{border:2px solid #b91c1c;color:#b91c1c;font-weight:800;text-align:center;padding:4px;margin-bottom:8px;letter-spacing:2px} .stamp{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin-top:28px} .stamp span{flex:1;border-top:1px solid #000;padding-top:4px;font-size:11px} .box{height:60px;border:1px dashed #555;flex:0 0 120px;font-size:10px;color:#555;padding:4px}",
    body: `<div class="card">${banner ? `<div class="banner">${banner}</div>` : ""}<h1>${escapeHtml(seller.legal_name || seller.display_name || biz.business.name)}</h1>
      <small>${escapeHtml([seller.address_line1, seller.city, seller.postal_code].filter(Boolean).join(", "))}${seller.phone ? ` · ${escapeHtml(seller.phone)}` : ""}${seller.gstin ? ` · GSTIN ${escapeHtml(seller.gstin)}` : ""}</small>
      <h2 style="font-size:15px;margin:14px 0 0">Warranty card</h2>
      <dl><dt>Item</dt><dd>${escapeHtml(w.item_label)}${w.model_number ? ` (${escapeHtml(w.model_number)})` : ""}</dd>
      <dt>IMEI / serial</dt><dd>${escapeHtml(w.serial)}${w.imei2 ? ` · IMEI 2 ${escapeHtml(w.imei2)}` : ""}</dd>
      <dt>Customer</dt><dd>${escapeHtml(w.customer_name)} · ${escapeHtml(w.customer_phone)}</dd>
      <dt>Bill</dt><dd>${escapeHtml(w.document_no)} · ${fmt(w.sold_at)}${w.line_value ? ` · ${escapeHtml(biz.exact(w.line_value))}` : ""}</dd>
      <dt>Warranty</dt><dd>${escapeHtml(String(w.months))} months: ${fmt(w.starts_on)} to ${fmt(w.ends_on)}</dd>
      ${w.helpline ? `<dt>Brand helpline</dt><dd>${escapeHtml(w.helpline)}</dd>` : ""}</dl>
      <div class="bc">${code}</div>
      ${w.terms ? `<p><small>${escapeHtml(w.terms)}</small></p>` : ""}
      <div class="stamp"><div class="box">Shop stamp</div><span>Authorised signature</span></div></div>`,
  });
}

const CLAIM_WORDS = { raised: "Raised", submitted: "Sent to brand", approved: "Approved", rejected: "Rejected", credited: "Credited" };
const CLAIM_TONES = { raised: "pending", submitted: "info", approved: "active", rejected: "danger", credited: "active" };

// Warranty claims against brands and distributors, with what is pending per brand.
function Claims() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const [state, setState] = useState("");
  const list = useServerList("warranty-claims", { gridId: "electronics-warranty-claims", period: true, params: state ? { status: state } : {} });
  const [summary, setSummary] = useState([]);
  const [editing, setEditing] = useState(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "warranty-claims/summary", undefined, controller.signal).then(setSummary).catch(() => {});
    return () => controller.abort();
  }, [biz.id, version]);
  return (
    <>
      {summary.length > 0 && (
        <div className="stat-grid">
          {summary.slice(0, 4).map((s) => <StatTile key={s.brand} icon="shield" tone="warning" label={`Due from ${s.brand}`} money={Number(s.pending)} note={`${s.claims} open claim${s.claims === 1 ? "" : "s"}`} />)}
        </div>
      )}
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="shield" title="Claims with brands" description="Parts fitted free under warranty, claimed back from the brand or distributor. Raise a claim from the repair job.">
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Brand, claim no., job, device or IMEI" }} caption="Warranty claims" currency={biz.symbol}
          rowNoun={["claim", "claims"]} onRowClick={(c) => navigate(biz.path(`repairs/${c.job_id}`))}
          toolbar={<><PeriodFilter list={list} /><Segmented label="Status" options={[{ value: "", label: "All" }, ...Object.entries(CLAIM_WORDS).map(([value, label]) => ({ value, label }))]} value={state} onChange={setState} /></>}
          columns={[
            { key: "brand", header: "With", value: (c) => c.brand, mobile: "title", pin: true, render: (c) => <span className="bz-two-line"><strong>{c.brand}</strong><small className="muted">{c.supplier_name || "Direct"}</small></span> },
            { key: "job_no", header: "Job", value: (c) => c.job_no, className: "mono", mobile: "subtitle" },
            { key: "device", header: "Device", value: (c) => `${c.device} ${c.serial || ""}`, render: (c) => <span className="bz-two-line"><span>{c.device}</span><small className="muted mono">{c.serial || ""}</small></span> },
            { key: "claim_no", header: "Claim no.", value: (c) => c.claim_no || "", className: "mono" },
            { key: "part_cost", header: "Part cost", type: "money", exact: true, value: (c) => Number(c.part_cost), total: "sum", mobile: "show" },
            { key: "status", header: "Status", value: (c) => c.status, render: (c) => <StatusBadge status={CLAIM_TONES[c.status]} label={CLAIM_WORDS[c.status]} />, mobile: "show" },
            { key: "credited", header: "Credited", type: "money", exact: true, value: (c) => (c.credited_amount === null ? null : Number(c.credited_amount)), total: "sum" },
            { key: "created_at", header: "Raised", type: "date", value: (c) => c.created_at },
            biz.can("repairs.edit") && { key: "actions", header: "", label: "Actions", type: "actions", render: (c) => (!["credited", "rejected"].includes(c.status)
              ? <button type="button" className="chip-button" onClick={(e) => { e.stopPropagation(); setEditing(c); }}>Update</button> : null) },
          ].filter(Boolean)} empty="No claims in these dates" emptyHint="Claims are raised from a repair job under warranty." emptyIcon="shield" />
      </SectionCard>
      {editing && <ClaimStatusDialog claim={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setVersion((n) => n + 1); list.reload(); }} />}
    </>
  );
}
