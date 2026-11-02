import { useCallback, useEffect, useMemo, useState } from "react";
import Icon from "@bmp/ui/Icon";
import DataGrid from "../../../components/DataGrid/DataGrid";
import SectionCard from "../../../components/SectionCard";
import StatusBadge from "../../../components/StatusBadge";
import LiveIndicator from "../../../components/LiveIndicator";
import { ErrorMessage } from "../../../components/Feedback";
import useLiveRefresh from "../../../hooks/useLiveRefresh";
import { businessRead, businessWrite } from "../../../services/business.service";
import { getErrorMessage } from "../../../services/api";
import { relative } from "@bmp/shared/format";
import { toast } from "../../../services/toast";
import FormDialog from "../core/pages/FormDialog";
import { BusinessHeader, Field } from "../core/pages/ui";
import { useOpenBusiness } from "../core/pages/hooks";
import "./till.css";

// Settings › Tills: every computer set up as an offline till, live (online
// now, last seen, bills waiting, last sync, bills received and still to
// review), renamed, or retired: never while bills wait on it, unless it is
// lost or broken (its numbers that never arrived are then noted, for GSTR-1).
// And the business's limits: warn after hours offline, stop after hours
// offline, the most bills a till may hold unsent; the UPI ID its QR asks the
// exact amount to.
const STATUS = { online: { tone: "success", label: "Online" }, offline: { tone: "warning", label: "Offline" }, retired: { tone: "neutral", label: "Retired" } };

export default function TillsPage() {
  const biz = useOpenBusiness();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState(null);
  const [retiring, setRetiring] = useState(null);
  const canManage = biz.can("offline_till.manage");

  const load = useCallback(() => businessRead(biz.id, "till/devices")
    .then((answer) => { setData(answer); setError(""); })
    .catch((err) => setError(getErrorMessage(err))), [biz.id]);
  useEffect(() => {
    let live = true;
    businessRead(biz.id, "till/devices").then((answer) => live && setData(answer)).catch((err) => live && setError(getErrorMessage(err)));
    return () => { live = false; };
  }, [biz.id]);
  const live = useLiveRefresh({ business: biz.id }, ["till"], load);

  const columns = useMemo(() => [
    { key: "code", header: "Till", value: (d) => d.code, pin: true, mobile: "title", minWidth: 180,
      render: (d) => <span className="bz-two-line"><strong>{d.code} · {d.name}</strong><small className="muted">{d.location_name}</small></span> },
    { key: "status", header: "Now", type: "status", value: (d) => STATUS[d.status]?.label, mobile: "subtitle",
      render: (d) => <span className="till-status"><StatusBadge tone={STATUS[d.status]?.tone} label={d.lost ? "Retired · lost" : STATUS[d.status]?.label} /></span> },
    { key: "waiting", header: "Bills waiting", type: "number", value: (d) => Number(d.pending_count) + Number(d.attention_count),
      render: (d) => {
        const n = Number(d.pending_count) + Number(d.attention_count);
        if (!n) return <span className="muted">None</span>;
        return <span>{n}{Number(d.attention_count) ? <small className="muted"> · {d.attention_count} need attention</small> : null}{d.oldest_pending_at ? <small className="muted"> · oldest {relative(d.oldest_pending_at)}</small> : null}</span>;
      }, mobile: "show" },
    { key: "last_seen_at", header: "Last seen", type: "date", value: (d) => d.last_seen_at, render: (d) => (d.last_seen_at ? relative(d.last_seen_at) : <span className="muted">Never</span>) },
    { key: "last_sync_at", header: "Last bills received", type: "date", value: (d) => d.last_sync_at, render: (d) => (d.last_sync_at ? relative(d.last_sync_at) : <span className="muted">None yet</span>) },
    { key: "received", header: "Offline bills", type: "number", value: (d) => Number(d.received) },
    { key: "to_review", header: "To review", type: "number", value: (d) => Number(d.to_review), render: (d) => (Number(d.to_review) ? <strong>{d.to_review}</strong> : <span className="muted">0</span>) },
    { key: "missing", header: "Numbers missing", type: "number", value: (d) => Number(d.missing), defaultHidden: true },
    { key: "registered_at", header: "Set up", type: "date", value: (d) => d.registered_at, render: (d) => <span className="bz-two-line"><span>{relative(d.registered_at)}</span><small className="muted">by {d.registered_by_name}</small></span>, defaultHidden: true },
    { key: "retire_reason", header: "Retired because", value: (d) => d.retire_reason || "", defaultHidden: true },
    { key: "app_version", header: "App version", value: (d) => d.app_version || "", defaultHidden: true },
    canManage && { key: "actions", header: "", label: "Actions", type: "actions", render: (d) => (d.status === "retired" ? null : (
      <span className="bz-row-actions">
        <button type="button" className="chip-button" onClick={() => setRenaming(d)}>Rename</button>
        <button type="button" className="chip-button" onClick={() => setRetiring(d)}>Retire…</button>
      </span>
    )) },
  ].filter(Boolean), [canManage]);

  return (
    <div className="stack">
      <BusinessHeader icon="pos" title="Tills"
        description="Computers set up to bill when the internet drops. Each numbers its offline bills in its own series (T1/2627/00001) and sends them when the internet is back. Set one up from Quick bill, on that computer." />
      <ErrorMessage message={error} />
      <SectionCard flush icon="pos" title="Offline tills" actions={<LiveIndicator status={live} />}>
        <DataGrid id="business-tills" caption="Tills" rows={data?.items || []} loading={!data && !error} error={data ? "" : error} onRetry={load}
          columns={columns} rowNoun={["till", "tills"]} rowKey={(d) => d.id}
          empty="No tills yet" emptyIcon="receipt" emptyHint="Open Quick bill on the shop's computer, press Offline billing, then Set up offline billing on this computer." />
      </SectionCard>
      {data && <Limits biz={biz} settings={data.settings} canManage={canManage} onSaved={(settings) => setData((d) => ({ ...d, settings }))} />}
      {renaming && <RenameDialog biz={biz} till={renaming} onClose={() => setRenaming(null)} onDone={() => { setRenaming(null); load(); }} />}
      {retiring && <RetireDialog biz={biz} till={retiring} onClose={() => setRetiring(null)} onDone={() => { setRetiring(null); load(); }} />}
    </div>
  );
}

function Limits({ biz, settings, canManage, onSaved }) {
  const [form, setForm] = useState(() => ({ warnHours: String(settings.warnHours), stopHours: String(settings.stopHours), waitingCap: String(settings.waitingCap),
    upiId: settings.upiId || "", upiPayee: settings.upiPayee || "" }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onSaved(await businessWrite(biz.id, "till/settings", { ...form, upiId: form.upiId.trim() || null, upiPayee: form.upiPayee.trim() || null }, "put"));
      toast.success("Till limits saved");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <SectionCard as="form" icon="clock" title="How long a till may bill offline" onSubmit={save}
      description="A till warns after some hours with no internet, and stops making new offline bills at the limit, or when too many wait, until it is connected and they are sent.">
      <ErrorMessage message={error} />
      <div className="till-limits-form">
        <Field label="Warn after (hours)"><input type="number" min="1" max="120" step="1" required disabled={!canManage} value={form.warnHours} onChange={set("warnHours")} /></Field>
        <Field label="Stop after (hours)" hint="1 to 120; 72 is three days"><input type="number" min="1" max="120" step="1" required disabled={!canManage} value={form.stopHours} onChange={set("stopHours")} /></Field>
        <Field label="Most bills waiting" hint="50 to 2,000"><input type="number" min="50" max="2000" step="1" required disabled={!canManage} value={form.waitingCap} onChange={set("waitingCap")} /></Field>
        <Field label="UPI ID for the till's QR" hint="The exact amount, asked of the customer's UPI app. Empty: your own QR stand."><input maxLength={100} placeholder="shopname@okaxis" disabled={!canManage} value={form.upiId} onChange={set("upiId")} /></Field>
        <Field label="Name the QR shows"><input maxLength={60} placeholder={biz.business.name} disabled={!canManage || !form.upiId.trim()} value={form.upiPayee} onChange={set("upiPayee")} /></Field>
      </div>
      {canManage && <div className="form-actions bz-start"><button type="submit" className="button" disabled={busy}><Icon name="check" size={15} /> {busy ? "Saving…" : "Save"}</button></div>}
    </SectionCard>
  );
}

function RenameDialog({ biz, till, onClose, onDone }) {
  const [name, setName] = useState(till.name);
  return (
    <FormDialog title={`Rename till ${till.code}`} icon="edit" width={480} submitLabel="Rename" onClose={onClose}
      onSubmit={() => businessWrite(biz.id, `till/devices/${till.id}`, { name }, "patch")} onSaved={onDone} successMessage="Till renamed">
      <Field label="Name"><input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
    </FormDialog>
  );
}

function RetireDialog({ biz, till, onClose, onDone }) {
  const waiting = Number(till.pending_count) + Number(till.attention_count);
  const [lost, setLost] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <FormDialog title={`Retire till ${till.code} (${till.name})?`} icon="ban" width={560} submitLabel={lost ? "Retire it as lost" : "Retire it"} onClose={onClose}
      description="A retired till bills online only: its secret stops working, and its code is never given again. Set the computer up again to bill offline on it."
      onSubmit={() => businessWrite(biz.id, `till/devices/${till.id}/retire`, { reason, lost })}
      onSaved={(result) => { toast.success(result.numbersLost ? `${result.code} retired; ${result.numbersLost} numbers to explain under Daily money › Offline bills` : `${result.code} retired`); onDone(); }}>
      {waiting > 0 && <p className="alert alert-notice">{waiting} {waiting === 1 ? "bill waits" : "bills wait"} on this till, as it last reported. Send {waiting === 1 ? "it" : "them"} from the till first: once it is retired, {waiting === 1 ? "it" : "they"} can no longer be sent from it.</p>}
      <Field label="Why"><input required maxLength={300} placeholder="Replaced by a new computer" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <label className="checkbox"><input type="checkbox" checked={lost} onChange={(e) => setLost(e.target.checked)} /> It is lost, stolen or broken: what waits on it will never arrive</label>
      {lost && <p className="small muted">The numbers it said it used that never arrived are listed under Daily money › Offline bills, to note why: GSTR-1 counts every number issued.</p>}
    </FormDialog>
  );
}
