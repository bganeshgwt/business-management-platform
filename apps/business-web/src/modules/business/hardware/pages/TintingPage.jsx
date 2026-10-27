import { useEffect, useId, useState } from "react";
import { useSearchParams } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import { dateTime } from "@bmp/shared/format";
import ContentTabs from "../../../../components/ContentTabs";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import LiveIndicator from "../../../../components/LiveIndicator";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import useAuth from "../../../../hooks/useAuth";
import useLiveRefresh from "../../../../hooks/useLiveRefresh";
import { businessRead, businessWrite } from "../../../../services/business.service";
import api, { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import SheetImportModal from "../../../restaurant/inventory/pages/SheetImportModal";
import FormDialog from "../../core/pages/FormDialog";
import { DocumentDetail } from "../../core/pages/DocumentsPage";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { newKey, quantity, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import TintApproval from "./TintApproval";
import { approvalBody, emptyApproval, forgetTinting, formulaWords, shadeWords, useShades } from "./hardware";
import "../styles/hardware.css";

// Paint tinting: the tinting board and the shades. Tinted paint is made to
// order on the maker's own tinting machine (nothing here drives it): a bill's
// line of a base item in its pack, tinted to a maker's shade. Each such line
// is a job on the board, queued, then tinted (its base leaves stock then),
// then handed over; it is taken back only on a manager's PIN, as a return of
// the whole line that puts nothing back in stock. The shades, by maker, are
// typed or imported from a spreadsheet; the tinting charge is the service
// item billed beside a tinted line. ?tab=shades opens on the shades.

const TABS = [{ value: "board", label: "Tinting board" }, { value: "shades", label: "Shades" }];
const JOB_STATES = {
  queued: { label: "Queued", tone: "warning" },
  tinted: { label: "Tinted", tone: "info" },
  handed_over: { label: "Handed over", tone: "success" },
  taken_back: { label: "Taken back", tone: "neutral" },
};
const SHOW = [{ value: "", label: "Everything" }, ...Object.entries(JOB_STATES).map(([value, state]) => ({ value, label: state.label }))];
// The service items that are on: the tinting charge is one of them.
const SERVICES = "catalog?active=true&kind=service";

// How much of the base: "2 each", or as billed in a pack: "1 box (4 each)".
const howMany = (job) => (job.entered_unit ? `${quantity(job.entered_quantity, job.entered_unit)} (${quantity(job.quantity, job.unit)})` : quantity(job.quantity, job.unit));
// A formula as it is typed: "XR 1.25; YE 0.4".
const formulaText = (formula) => (formula || []).map((f) => `${f.colourant} ${Number(f.ml)}`).join("; ");

export default function TintingPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "shades" ? "shades" : "board";
  const showTab = (value) => setParams((p) => {
    const next = new URLSearchParams(p);
    if (value === "shades") next.set("tab", value);
    else next.delete("tab");
    return next;
  }, { replace: true });
  return (
    <div className="stack">
      <BusinessHeader icon="sparkles" title="Paint tinting"
        description="Tinted paint is made to order on the maker's own tinting machine: a base in its pack, tinted to a shade. Each tinted line of a bill waits on the tinting board until it is tinted and handed over." />
      <ContentTabs label="Paint tinting" value={tab} options={TABS} onChange={showTab}>
        {tab === "board" ? <Board /> : <Shades />}
      </ContentTabs>
    </div>
  );
}

// --- The tinting board ------------------------------------------------------------------------

function Board() {
  const biz = useOpenBusiness();
  const [status, setStatus] = useState("");
  const [picked, setPicked] = useState("");
  // Someone working at one location sees its board; with more, they choose.
  const location = biz.locations.length === 1 ? String(biz.locations[0].id) : picked;
  const list = useServerList("hardware/tinting", { gridId: "hardware-tint-jobs", params: { ...(status ? { status } : {}), ...(location ? { location } : {}) } });
  // A bill with a tinted line, or a job moved on another screen, shows here at once.
  const live = useLiveRefresh({ business: biz.id }, ["tinting"], list.reload);
  const [busy, setBusy] = useState(null);
  const [takingBack, setTakingBack] = useState(null);
  const [billId, setBillId] = useState(null);
  const canMove = biz.can("hardware_tinting.create");
  const seesBills = biz.can("sales.view");

  // Tinted (the base leaves stock) or handed over; asking again is the same.
  const move = async (job, step) => {
    setBusy(job.id);
    try {
      await businessWrite(biz.id, `hardware/tinting/${job.id}/${step}`, {});
      toast.success(step === "tinted" ? `${job.label} on ${job.document_no} is tinted. Its base has left stock.` : `${job.label} on ${job.document_no} is handed over.`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(null);
      list.reload();
    }
  };
  const takenBack = (job, result) => {
    setTakingBack(null);
    list.reload();
    const words = result?.return
      ? `${job.label} on ${job.document_no} is taken back on return ${result.return.return_no} (${biz.exact(result.return.total)}). Money paid for it goes back by a refund on the bill.`
      : `${job.label} on ${job.document_no} is taken back.`;
    toast.success(words, seesBills ? { action: { label: "Open the bill", onClick: () => setBillId(job.document_id) } } : undefined);
  };

  const columns = [
    { key: "document_no", header: "Bill", value: (j) => j.document_no, mobile: "subtitle", pin: true,
      render: (j) => (
        <span className="bz-two-line">
          {seesBills ? <button type="button" className="link-button bz-link-left mono" onClick={() => setBillId(j.document_id)}>{j.document_no}</button> : <span className="mono">{j.document_no}</span>}
          <small className="muted">{dateTime(j.billed_at)}</small>
        </span>
      ) },
    { key: "customer", header: "Customer", value: (j) => j.customer, mobile: "subtitle" },
    { key: "label", header: "Base", value: (j) => j.label, mobile: "title", minWidth: 180,
      render: (j) => <span className="bz-two-line"><span>{j.label}</span><small className="muted">{[howMany(j), j.lot_code && `batch ${j.lot_code}`].filter(Boolean).join(" · ")}</small></span> },
    { key: "shade", header: "Shade", value: (j) => shadeWords(j), mobile: "show", minWidth: 180,
      render: (j) => <span className="bz-two-line"><strong>{shadeWords(j)}</strong><small className="muted">{[`${j.base} base`, j.card].filter(Boolean).join(" · ")}</small></span> },
    { key: "formula", header: "Formula", value: (j) => formulaWords(j.formula, j.litres_per_unit), mobile: "show", minWidth: 200,
      render: (j) => {
        if (!formulaWords(j.formula)) return <span className="muted">No formula kept</span>;
        if (Number(j.litres_per_unit) > 0) return formulaWords(j.formula, j.litres_per_unit);
        return <span className="bz-two-line"><span>{formulaWords(j.formula)}</span><small className="muted">ml for one litre of base</small></span>;
      } },
    { key: "status", header: "Status", type: "status", value: (j) => JOB_STATES[j.status]?.label || j.status, mobile: "show",
      render: (j) => (
        <span className="bz-two-line" title={j.take_back_reason || undefined}>
          <Badge tone={JOB_STATES[j.status]?.tone} label={JOB_STATES[j.status]?.label || j.status} />
          {j.status === "taken_back" && <small className="muted">{[dateTime(j.taken_back_at), j.approved_by_name && `approved by ${j.approved_by_name}`].filter(Boolean).join(" · ")}</small>}
        </span>
      ) },
    { key: "tinted_at", header: "Tinted", type: "datetime", value: (j) => j.tinted_at,
      render: (j) => (j.tinted_at ? <span className="bz-two-line"><span>{dateTime(j.tinted_at)}</span><small className="muted">by {j.tinted_by_name}</small></span> : <span className="muted">—</span>) },
    { key: "handed_over_at", header: "Handed over", type: "datetime", value: (j) => j.handed_over_at,
      render: (j) => (j.handed_over_at ? <span className="bz-two-line"><span>{dateTime(j.handed_over_at)}</span><small className="muted">by {j.handed_over_by_name}</small></span> : <span className="muted">—</span>) },
    { key: "take_back_reason", header: "Why taken back", value: (j) => j.take_back_reason || "", defaultHidden: true },
    { key: "location_name", header: "Location", value: (j) => j.location_name, defaultHidden: biz.locations.length < 2 },
    canMove && { key: "actions", header: "", label: "Actions", type: "actions", render: (j) => (
      <span className="bz-row-actions">
        {j.status === "queued" && <button type="button" className="chip-button" disabled={busy === j.id} title="Its base leaves stock" onClick={() => move(j, "tinted")}>Tinted</button>}
        {j.status === "tinted" && <button type="button" className="chip-button" disabled={busy === j.id} onClick={() => move(j, "handed-over")}>Handed over</button>}
        {j.status !== "taken_back" && <button type="button" className="chip-button" disabled={busy === j.id} onClick={() => setTakingBack(j)}>Take back</button>}
      </span>
    ) },
  ].filter(Boolean);

  return (
    <>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="list" title="Tinting board" actions={<LiveIndicator status={live} />}
        description="Jobs waiting to be tinted come first, then those waiting to be handed over. Make the shade on the maker's tinting machine, then mark the job tinted: its base leaves stock then. A tinted line is taken back only with a manager's PIN, and never goes back into stock.">
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Bill, customer, shade or item" }} caption="Tinting board" columns={columns}
          rowNoun={["job", "jobs"]}
          toolbar={(
            <>
              <label className="field">
                <span>Status</span>
                <select value={status} onChange={(e) => setStatus(e.target.value)}>
                  {SHOW.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </label>
              {biz.locations.length > 1 && (
                <label className="field">
                  <span>Location</span>
                  <select value={picked} onChange={(e) => setPicked(e.target.value)}>
                    <option value="">All locations</option>
                    {biz.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </label>
              )}
            </>
          )}
          rowClassName={(j) => (j.status === "handed_over" || j.status === "taken_back" ? "dg-tone-muted" : "")}
          empty={status ? `Nothing ${JOB_STATES[status].label.toLowerCase()}` : "Nothing on the board yet"}
          emptyHint="A line of paint tinted to a shade on a bill comes here as a job, queued to be tinted." emptyIcon="sparkles" />
      </SectionCard>
      {takingBack && <TakeBackDialog job={takingBack} onClose={() => setTakingBack(null)} onSaved={(result) => takenBack(takingBack, result)} />}
      {billId && <DocumentDetail documentId={billId} onClose={() => setBillId(null)} onChanged={list.reload} />}
    </>
  );
}

// A tinted line taken back: a return of the whole line on the bill, on a
// manager's PIN (one who may take goods back). One request key while the
// dialog is open, so trying again is the same take-back.
function TakeBackDialog({ job, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const [requestKey] = useState(newKey);
  const [reason, setReason] = useState("");
  const [approval, setApproval] = useState(emptyApproval);
  return (
    <FormDialog title="Take back the tinted line" icon="undo" width={620} submitLabel="Take it back" onClose={onClose} onSaved={onSaved}
      description={`${job.document_no} · ${job.customer} · ${job.label}, ${howMany(job)} · ${shadeWords(job)}`}
      onSubmit={() => businessWrite(biz.id, `hardware/tinting/${job.id}/take-back`, { requestKey, reason: reason.trim(), approval: approvalBody(approval, user?.id) })}>
      <ul className="field-wide bz-notes">
        <li>The whole line comes back, as a return on the bill.</li>
        <li>{job.tinted_at ? "Nothing goes back into stock: a tinted tin is no longer base paint." : "It is not tinted yet, so its base never left stock: stock does not change."}</li>
        <li>Its money goes back by a refund on the bill, as for any return.</li>
      </ul>
      <Field label="Why it is taken back" wide><input required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. The customer changed the shade" /></Field>
      <TintApproval title="A manager approves it" value={approval} onChange={setApproval} />
    </FormDialog>
  );
}

// --- Shades -----------------------------------------------------------------------------------

function Shades() {
  const biz = useOpenBusiness();
  const canEdit = biz.can("hardware_tinting.edit");
  const [showOff, setShowOff] = useState(false);
  const list = useServerList("hardware/shades", { gridId: "hardware-shades", params: showOff ? {} : { active: "true" } });
  const [editing, setEditing] = useState(null);
  const [importing, setImporting] = useState(false);
  // A shade added, changed or imported is offered on bills at once.
  const changed = () => {
    forgetTinting(biz.id);
    list.reload();
  };
  const columns = [
    { key: "maker", header: "Maker", value: (s) => s.maker, mobile: "subtitle" },
    { key: "code", header: "Code", value: (s) => s.code, className: "mono", mobile: "subtitle" },
    { key: "name", header: "Shade", value: (s) => s.name, mobile: "title" },
    { key: "card", header: "Card", value: (s) => s.card || "" },
    { key: "base", header: "Base", value: (s) => s.base, mobile: "show" },
    { key: "formula", header: "Formula (ml per litre)", value: (s) => formulaWords(s.formula), minWidth: 180,
      render: (s) => formulaWords(s.formula) || <span className="muted">—</span> },
    { key: "active", header: "In use", type: "status", value: (s) => (s.active ? "In use" : "Switched off"),
      render: (s) => <Badge status={s.active ? "active" : "inactive"} label={s.active ? "In use" : "Switched off"} /> },
    { key: "job_count", header: "Jobs", type: "number", value: (s) => s.job_count },
    canEdit && { key: "actions", header: "", label: "Actions", type: "actions", render: (s) => <button type="button" className="chip-button" onClick={() => setEditing(s)}>Edit</button> },
  ].filter(Boolean);
  return (
    <>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="layers" title="Shades"
        description="Each maker's shades: the code and name on the shade card, the base the shade is tinted from and, if you keep it, its formula for one litre of base."
        actions={canEdit && (
          <>
            <button type="button" className="button button-secondary button-sm" onClick={() => setImporting(true)}><Icon name="upload" size={15} /> Import shades</button>
            <button type="button" className="button button-sm" onClick={() => setEditing({})}><Icon name="plus" size={15} /> Add a shade</button>
          </>
        )}>
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Maker, code, name or base" }} caption="Shades" columns={columns} rowNoun={["shade", "shades"]}
          toolbar={<label className="checkbox bz-check"><input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} /> Show switched-off shades</label>}
          rowClassName={(s) => (!s.active ? "dg-tone-muted" : "")}
          empty="No shades yet" emptyHint={canEdit ? "Add the shades you tint, or import a maker's shade card from a spreadsheet." : "Someone who may change shades adds them."} emptyIcon="layers" />
      </SectionCard>
      <TintCharge />
      {editing && <ShadeDialog shade={editing} onClose={() => setEditing(null)} onSaved={(s) => { setEditing(null); toast.success(`${shadeWords(s)} saved.`); changed(); }} />}
      {importing && (
        <SheetImportModal title="Import shades" noun="shade" nounPlural="shades" sampleName="shades.csv"
          description="A maker's shade card from a spreadsheet: new shades are added and the shades kept are updated, after you see every change."
          lead="A shade is found by its maker and code: one kept already is updated, any other is added. A formula is each colourant's code and its millilitres for one litre of base, e.g. XR 1.25; YE 0.4."
          loadGuide={() => businessRead(biz.id, "hardware/shades/import-guide")}
          runImport={(payload) => api.post(`/businesses/${biz.id}/hardware/shades/import`, payload).then((r) => r.data)}
          onClose={() => setImporting(false)}
          onImported={(message) => { setImporting(false); toast.success(message); changed(); }} />
      )}
    </>
  );
}

function ShadeDialog({ shade, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(shade.id);
  const id = useId();
  // The makers and bases already kept, offered as they are typed.
  const known = useShades(biz) || [];
  const makers = [...new Set(known.map((s) => s.maker))].sort();
  const bases = [...new Set(known.map((s) => s.base))].sort();
  const [form, setForm] = useState({ maker: shade.maker || "", code: shade.code || "", name: shade.name || "", card: shade.card || "", base: shade.base || "",
    formula: formulaText(shade.formula), active: shade.active ?? true });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const submit = () => {
    const body = { maker: form.maker.trim(), code: form.code.trim(), name: form.name.trim(), card: form.card.trim() || null, base: form.base.trim(), formula: form.formula.trim() };
    return editing ? businessWrite(biz.id, `hardware/shades/${shade.id}`, { ...body, active: form.active }, "patch") : businessWrite(biz.id, "hardware/shades", body);
  };
  return (
    <FormDialog title={editing ? `Edit ${shadeWords(shade)}` : "Add a shade"} icon="layers" width={620} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      description={editing ? "A shade switched off goes on no new bill or quotation; jobs already tinted to it keep it." : "A shade from a maker's shade card, and the base it is tinted from."}>
      <Field label="Paint maker"><input required maxLength={80} list={`${id}-makers`} value={form.maker} onChange={set("maker")} /></Field>
      <Field label="Shade code"><input required maxLength={30} className="mono" value={form.code} onChange={set("code")} placeholder="As on the shade card" /></Field>
      <Field label="Shade name"><input required maxLength={100} value={form.name} onChange={set("name")} /></Field>
      <Field label="Shade card (optional)"><input maxLength={100} value={form.card} onChange={set("card")} placeholder="The card or collection" /></Field>
      <Field label="Base it needs" hint="Only paint whose item names this base is tinted to it.">
        <input required maxLength={40} list={`${id}-bases`} value={form.base} onChange={set("base")} placeholder="e.g. Pastel, Deep or Clear" />
      </Field>
      <Field label="Formula (optional)" hint="Colourant and millilitres for one litre of base, e.g. XR 1.25; YE 0.4" wide>
        <input maxLength={300} className="mono" value={form.formula} onChange={set("formula")} />
      </Field>
      {editing && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={set("active")} /> In use (put on new bills and quotations)</label>}
      <datalist id={`${id}-makers`}>{makers.map((m) => <option key={m} value={m} />)}</datalist>
      <datalist id={`${id}-bases`}>{bases.map((b) => <option key={b} value={b} />)}</datalist>
    </FormDialog>
  );
}

// The tinting charge: the service item billed for tinting one tin, at its
// own GST slab. None chosen: no charge goes on a bill by itself.
function TintCharge() {
  const biz = useOpenBusiness();
  const canEdit = biz.can("hardware_tinting.edit");
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState("");
  const [chosen, setChosen] = useState("");
  const [saving, setSaving] = useState(false);
  const { options, error: optionsError } = useOptions(canEdit ? [SERVICES] : []);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "hardware/tinting/settings", undefined, controller.signal)
      .then((s) => { setSettings(s); setChosen(s.chargeSkuId ? String(s.chargeSkuId) : ""); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id]);
  // Items kept for the shop's own use are not billed.
  const services = (options?.[SERVICES] || []).filter((s) => !s.internal_use);
  const current = settings?.charge || null;
  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const saved = await businessWrite(biz.id, "hardware/tinting/settings", { chargeSkuId: chosen || null }, "put");
      setSettings(saved);
      setChosen(saved.chargeSkuId ? String(saved.chargeSkuId) : "");
      forgetTinting(biz.id);
      toast.success(saved.charge ? `${saved.charge.label} is billed for tinting now.` : "No tinting charge goes on a bill by itself now.");
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  const slab = (rate) => (rate === null || rate === undefined ? "" : `GST ${Number(rate)}%`);
  const now = !current ? "No charge goes on by itself: none is chosen."
    : current.active ? `${current.label} is billed for tinting: ${[`${biz.exact(current.price)} for one tin`, slab(current.taxRate)].filter(Boolean).join(", ")}.`
      : `${current.label} is chosen, but it is switched off: no charge goes on until it is switched on again or another is chosen.`;
  return (
    <SectionCard icon="tag" title="Tinting charge"
      description="The service item billed for tinting one tin, at its own GST slab. When a line is tinted, it goes on the bill or quotation by itself; with none chosen, no charge goes on by itself.">
      <ErrorMessage message={error || optionsError} />
      {settings && canEdit && (
        <form className="hw-setting" onSubmit={save}>
          <Field label="Service item">
            <select value={chosen} onChange={(e) => setChosen(e.target.value)} disabled={!options || saving}>
              <option value="">None: no charge goes on by itself</option>
              {current && !services.some((s) => String(s.id) === String(current.id)) && <option value={current.id}>{current.label}{current.active ? "" : " (switched off)"}</option>}
              {services.map((s) => <option key={s.id} value={s.id}>{[s.label, biz.exact(s.price), slab(s.tax_rate)].filter(Boolean).join(" · ")}</option>)}
            </select>
          </Field>
          <button type="submit" className="button" disabled={saving || chosen === String(settings.chargeSkuId || "")}>{saving ? "Saving…" : "Save"}</button>
        </form>
      )}
      {settings && <p className={canEdit ? "small muted hw-setting-now" : "hw-setting-now"}>{now}</p>}
      {canEdit && options && !services.length && (
        <p className="small muted">No service items yet: add one, such as “Tinting charge”, on the Products & services screen with the kind Service.</p>
      )}
    </SectionCard>
  );
}
