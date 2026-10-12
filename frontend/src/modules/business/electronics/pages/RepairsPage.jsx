import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import SearchPicker from "../../../../components/SearchPicker";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort, duration } from "../../../../services/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field, FormError, PeriodFilter } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { RepairBadge, Segmented } from "../../fashion/pages/shared";
import { REPAIR_STATES, refuse } from "../../fashion/pages/feFormat";
import { CHECKLIST, sendWhatsApp, stageFor } from "./repairParts";

// Repair jobs: the service desk. Open jobs (whatever their date) with a chip
// per status and its count, each row with WhatsApp and the next step; all
// jobs by date; and taking a device in with the customer found by name or
// phone, the IMEI looked up, the screen lock, a damage checklist and an advance.

const NEXT_WORDS = { diagnosing: "Start diagnosis", waiting_parts: "Waiting for parts", in_repair: "Start repair", awaiting_approval: "Ask the customer", ready: "Mark ready" };
const NEXT = { received: "diagnosing", diagnosing: "in_repair", waiting_parts: "in_repair", in_repair: "ready" };
const CHIPS = [
  ["open", "All open"], ["received", "Received"], ["diagnosing", "Diagnosing"], ["waiting_parts", "Waiting for parts"], ["in_repair", "In repair"],
  ["awaiting_approval", "Awaiting approval"], ["ready", "Ready"], ["overdue", "Late"], ["not_collected", "Not collected"],
];

export default function RepairsPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const [view, setView] = useState("open");
  const [chip, setChip] = useState("open");
  const [counts, setCounts] = useState(null);
  const [version, setVersion] = useState(0);
  const params = chip === "overdue" ? { stage: "open", overdue: "true" } : chip === "not_collected" ? { not_collected: "true" } : chip === "open" ? { stage: "open" } : { stage: "open", status: chip };
  const open = useServerList("repairs", { gridId: "electronics-repairs-open", params });
  const all = useServerList("repairs", { gridId: "electronics-repairs", period: true });
  const list = view === "open" ? open : all;
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "repairs/counts", undefined, controller.signal).then(setCounts).catch(() => {});
    return () => controller.abort();
  }, [biz.id, version]);
  const refresh = () => { setVersion((n) => n + 1); open.reload(); all.reload(); };

  const move = async (job, status) => {
    setBusy(job.id);
    try {
      await businessWrite(biz.id, `repairs/${job.id}/status`, { status });
      toast.success(`${job.job_no}: ${REPAIR_STATES[status][1].toLowerCase()}.`);
      refresh();
    } catch (err) { toast.error(getErrorMessage(err)); } finally { setBusy(null); }
  };
  const whatsapp = (job) => sendWhatsApp(biz, job, stageFor(job.status)).then(() => refresh()).catch((err) => toast.error(getErrorMessage(err)));

  const columns = useMemo(() => [
    { key: "job_no", header: "Job", value: (j) => j.job_no, className: "mono", mobile: "title", pin: true },
    { key: "created_at", header: "Taken in", type: "datetime", value: (j) => j.created_at, defaultHidden: view === "open" },
    { key: "customer", header: "Customer", value: (j) => `${j.customer_name} ${j.customer_phone}`, render: (j) => <span className="bz-two-line"><span>{j.customer_name}</span><small className="muted">{j.customer_phone}</small></span>, mobile: "show" },
    { key: "device", header: "Device", value: (j) => `${j.device} ${j.serial || ""}`, mobile: "subtitle",
      render: (j) => <span className="bz-two-line"><span>{j.device}{j.under_warranty && <> <Badge tone="active" label="Warranty" /></>}</span><small className="muted mono">{j.serial || ""}</small></span> },
    { key: "problem", header: "Problem", value: (j) => j.problem },
    { key: "status", header: "Status", type: "status", value: (j) => j.status, mobile: "show",
      render: (j) => <span className="bz-two-line"><RepairBadge status={j.status} />{j.status_since && !["delivered", "cancelled"].includes(j.status) && <small className="muted">for {duration(j.status_since)}</small>}</span>,
      filter: "select", filterOptions: Object.entries(REPAIR_STATES).map(([value, [, label]]) => ({ value, label })) },
    { key: "promised_on", header: "Promised", type: "date", value: (j) => j.promised_on, render: (j) => (j.promised_on ? <span className={j.overdue ? "bz-minus" : ""}>{dateShort(j.promised_on)}{j.overdue ? " · late" : ""}</span> : "—") },
    { key: "technician", header: "Technician", value: (j) => j.technician || "", defaultHidden: true },
    { key: "bill", header: "Bill", type: "money", exact: true, value: (j) => (j.bill_total === null ? null : Number(j.bill_total)), total: "sum", defaultHidden: view === "open" },
    { key: "advance", header: "Advance", type: "money", exact: true, value: (j) => (j.advance === null ? null : Number(j.advance)), total: "sum", defaultHidden: view === "open",
      render: (j) => (j.advance === null ? "—" : j.advance_to_refund ? <span className="bz-two-line"><span>{biz.exact(j.advance)}</span><small className="bz-minus">{biz.exact(j.advance_left)} to refund</small></span> : biz.exact(j.advance)) },
    { key: "location", header: "Location", value: (j) => j.location_name, defaultHidden: biz.locations.length < 2 },
    view === "open" && { key: "actions", header: "", label: "Actions", type: "actions", render: (j) => (
      <div className="row-actions">
        <button type="button" className="chip-button" onClick={(e) => { e.stopPropagation(); whatsapp(j); }} title="Message the customer on WhatsApp"><Icon name="message" size={14} /> WhatsApp</button>
        {biz.can("repairs.edit") && NEXT[j.status] && <button type="button" className="chip-button" disabled={busy === j.id} onClick={(e) => { e.stopPropagation(); move(j, NEXT[j.status]); }}>{NEXT_WORDS[NEXT[j.status]]}</button>}
        {j.status === "ready" && biz.can("repairs.approve") && <button type="button" className="chip-button" onClick={(e) => { e.stopPropagation(); navigate(biz.path(`repairs/${j.id}`)); }}>Deliver</button>}
      </div>
    ) },
  ].filter(Boolean), [biz, view, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="stack">
      <BusinessHeader icon="settings" title="Repairs"
        description="Take a device in, keep the customer's job card, track the work, tell the customer, and bill it when it goes back. Parts leave stock only at delivery."
        primary={biz.can("repairs.create") && <button type="button" className="button" onClick={() => setCreating(true)}><Icon name="plus" size={16} /> Take in a device</button>} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="settings" title={view === "open" ? "Open jobs" : "All jobs"}
        actions={<Segmented label="Show" options={[{ value: "open", label: "Open jobs" }, { value: "all", label: "All jobs by date" }]} value={view} onChange={setView} />}>
        {view === "open" && (
          <div className="fe-chips" role="group" aria-label="Open jobs by status">
            {CHIPS.map(([value, label]) => {
              const n = counts ? counts[value] : null;
              if (n === 0 && !["open", chip].includes(value)) return null;
              return (
                <button key={value} type="button" aria-pressed={chip === value} className={`fe-chip ${chip === value ? "is-active" : ""} ${["overdue", "not_collected", "awaiting_approval"].includes(value) && n ? "is-alert" : ""}`}
                  onClick={() => setChip(value)}>{label}{n !== null && n !== undefined && <b>{n}</b>}</button>
              );
            })}
          </div>
        )}
        <DataGrid key={view} {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Job, customer, phone, device or IMEI" }} caption="Repair jobs" columns={columns}
          currency={biz.symbol} rowNoun={["job", "jobs"]} onRowClick={(j) => navigate(biz.path(`repairs/${j.id}`))}
          rowClassName={(j) => (j.overdue ? "dg-tone-danger" : j.status === "awaiting_approval" ? "dg-tone-warning" : j.status === "ready" ? "dg-tone-success" : ["delivered", "cancelled"].includes(j.status) ? "dg-tone-muted" : "")}
          toolbar={view === "all" ? <PeriodFilter list={all} /> : undefined}
          exportName={biz.can("repairs.export") ? `${biz.business.code}-repairs` : undefined}
          empty={view === "open" ? "No open repair jobs here" : "No repair jobs in these dates"} emptyHint={view === "open" ? "Take in a device to start a job card." : "Pick other dates."} emptyIcon="settings" />
      </SectionCard>
      {creating && <IntakeDialog onClose={() => setCreating(false)}
        onSaved={(job) => { setCreating(false); toast.success(`Job ${job.job_no} opened${job.under_warranty ? " under warranty" : ""}.`); navigate(biz.path(`repairs/${job.id}`)); }} />}
    </div>
  );
}

function IntakeDialog({ onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options, error } = useOptions(["catalog?active=true&kind=goods"]);
  const models = (options?.["catalog?active=true&kind=goods"] || []).filter((s) => s.tracking === "serial");
  const locations = biz.locations.filter((l) => l.active);
  const canAdvance = biz.can("sales.edit");
  const [requestKey] = useState(newKey);
  const [customer, setCustomer] = useState(null);
  const [form, setForm] = useState({ locationId: String(locations[0]?.id || ""), customerName: "", customerPhone: "", skuId: "", device: "", serial: "",
    problem: "", accessories: "", conditionNotes: "", estimate: "", promisedOn: "", technician: "", passcode: "", advance: "", advanceMethod: "cash" });
  const [checks, setChecks] = useState({});
  const [showCode, setShowCode] = useState(false);
  const [lookup, setLookup] = useState(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [ownerOk, setOwnerOk] = useState(false);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const phone = (customer?.phone || form.customerPhone || "").replace(/\D/g, "").slice(-10);
  const warranty = lookup?.warranties?.find((w) => w.state === "active" || w.state === "expiring");
  const otherOwner = warranty && phone.length >= 6 && warranty.phone_digits !== phone;

  // The IMEI tells us the sale, the warranty and earlier repairs.
  const findImei = async () => {
    const code = form.serial.trim();
    if (code.length < 4 || !biz.can("warranties.view")) return;
    setLookupBusy(true);
    try {
      const found = await businessRead(biz.id, "warranties/lookup", { q: code });
      setLookup(found);
      const w = found.warranties[0];
      if (w && !customer) setForm((f) => ({ ...f, customerName: f.customerName || w.customer_name, customerPhone: f.customerPhone || w.customer_phone, device: f.device || w.item_label, skuId: f.skuId || String(w.sku_id) }));
    } catch { setLookup(null); } finally { setLookupBusy(false); }
  };
  const submit = () => {
    if (otherOwner && !ownerOk) return Promise.reject(refuse(`The warranty on this IMEI is ${warranty.customer_name}'s (${warranty.customer_phone}). Tick that the desk has checked, or correct the customer.`));
    return businessWrite(biz.id, "repairs", {
      locationId: form.locationId, requestKey, contactId: customer?.id || undefined, customerName: form.customerName || undefined, customerPhone: form.customerPhone || undefined,
      skuId: form.skuId || undefined, device: form.device || undefined, serial: form.serial.trim() || undefined, problem: form.problem, accessories: form.accessories || undefined,
      conditionNotes: form.conditionNotes || undefined, estimate: form.estimate || undefined, promisedOn: form.promisedOn || undefined, technician: form.technician || undefined,
      passcode: form.passcode || undefined, checklist: checks, warrantyOwnerConfirmed: otherOwner && ownerOk ? true : undefined,
      ...(canAdvance && Number(form.advance) > 0 ? { advance: { amount: form.advance, method: form.advanceMethod } } : {}),
    });
  };
  return (
    <FormDialog title="Take in a device" icon="settings" width={860} onClose={onClose} onSaved={onSaved} onSubmit={submit} disabled={!options} submitLabel="Open job card"
      description="Scan the IMEI first: the sale, the warranty and earlier repairs come up. A live warranty from this shop puts the job under warranty (parts free unless priced).">
      <FormError message={error} />
      {!options && !error && <div className="field-wide"><Loading /></div>}
      <Field label="IMEI / serial" hint={lookupBusy ? "Looking it up…" : "Scan or type, then press Enter."}>
        <input className="mono" maxLength={100} autoFocus value={form.serial} onChange={set("serial")} onBlur={findImei} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); findImei(); } }} />
      </Field>
      {locations.length > 1 ? (
        <Field label="Taken in at"><select value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
      ) : <span />}
      {lookup && (lookup.warranties.length > 0 || lookup.repairs.length > 0 || lookup.unregistered.length > 0) && (
        <div className="field-wide fe-lookup">
          {lookup.warranties.slice(0, 1).map((w) => (
            <p key={w.id}><Icon name="shield" size={15} /> <strong>{w.state === "active" || w.state === "expiring" ? "Under warranty" : "Warranty ended"}</strong> · {w.item_label} · sold on {w.document_no} to {w.customer_name} ({w.customer_phone}) · until {dateShort(w.ends_on, { year: true })}</p>
          ))}
          {lookup.unregistered.slice(0, 1).map((u) => <p key={u.line_id}><Icon name="receipt" size={15} /> Sold here on {u.document_no} to {u.contact_name || "a walk-in"}, no warranty registered.</p>)}
          {lookup.repairs.length > 0 && <p><Icon name="history" size={15} /> Earlier repairs: {lookup.repairs.slice(0, 3).map((r) => `${r.job_no} (${r.problem})`).join(" · ")}</p>}
          {otherOwner && <label className="checkbox bz-check"><input type="checkbox" checked={ownerOk} onChange={(e) => setOwnerOk(e.target.checked)} /> Brought in by someone other than {warranty.customer_name}: the desk has checked the bill or spoken to the owner.</label>}
        </div>
      )}
      <div className="field-wide">
        <SearchPicker label="Customer on file (optional)" placeholder="Name or phone" value={customer} onChange={setCustomer} minChars={2}
          search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 15 }, signal).then((page) => page.items)}
          getLabel={(c) => c.name} getDescription={(c) => c.phone || ""} hint="Leave empty for a walk-in and type the name and phone below." />
      </div>
      {!customer && (
        <>
          <Field label="Customer name"><input required maxLength={150} value={form.customerName} onChange={set("customerName")} /></Field>
          <Field label="Phone" hint="For the ready message on WhatsApp."><input required maxLength={30} inputMode="tel" value={form.customerPhone} onChange={set("customerPhone")} /></Field>
        </>
      )}
      <Field label="Model sold here (optional)">
        <select value={form.skuId} onChange={set("skuId")}><option value="">Other device</option>{models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
      </Field>
      <Field label="Device" hint="Brand, model and colour."><input required={!form.skuId} maxLength={150} value={form.device} onChange={set("device")} placeholder={models.find((m) => String(m.id) === form.skuId)?.label || "e.g. Redmi Note 12, blue"} /></Field>
      <Field label="Problem reported" wide><textarea required rows={2} maxLength={1000} value={form.problem} onChange={set("problem")} placeholder="e.g. Screen cracked, touch not working" /></Field>
      <fieldset className="field-wide bz-plain-fieldset">
        <legend>Condition when taken in</legend>
        <div className="fe-checks">{CHECKLIST.map(([key, label]) => (
          <label key={key} className="checkbox"><input type="checkbox" checked={Boolean(checks[key])} onChange={(e) => setChecks((c) => ({ ...c, [key]: e.target.checked }))} /> {label}</label>
        ))}</div>
      </fieldset>
      <Field label="Left with the device (optional)"><input maxLength={300} value={form.accessories} onChange={set("accessories")} placeholder="e.g. Back cover, SIM tray" /></Field>
      <Field label="Other marks (optional)"><input maxLength={500} value={form.conditionNotes} onChange={set("conditionNotes")} placeholder="e.g. Scratches on the back" /></Field>
      <Field label="Screen lock / pattern (optional)" hint="Kept only until the job closes.">
        <span className="fe-secret">
          <input type={showCode ? "text" : "password"} autoComplete="off" maxLength={60} value={form.passcode} onChange={set("passcode")} />
          <button type="button" className="link-button" onClick={() => setShowCode((v) => !v)}>{showCode ? "Hide" : "Show"}</button>
        </span>
      </Field>
      <Field label="Estimate (optional)" hint="Work above it waits for the customer's OK."><input type="number" min="0" step="0.01" value={form.estimate} onChange={set("estimate")} /></Field>
      <Field label="Promised for (optional)"><input type="date" min={businessToday(biz.business.timezone)} value={form.promisedOn} onChange={set("promisedOn")} /></Field>
      <Field label="Technician (optional)"><input maxLength={100} value={form.technician} onChange={set("technician")} /></Field>
      {canAdvance && (
        <>
          <Field label="Advance taken (optional)" hint="Credited on the final bill."><input type="number" min="0" step="1" value={form.advance} onChange={set("advance")} /></Field>
          {Number(form.advance) > 0 && (
            <Field label="Advance paid by"><select value={form.advanceMethod} onChange={set("advanceMethod")}>{["cash", "upi", "card", "bank"].map((m) => <option key={m} value={m}>{m === "upi" ? "UPI" : m[0].toUpperCase() + m.slice(1)}</option>)}</select></Field>
          )}
        </>
      )}
    </FormDialog>
  );
}
