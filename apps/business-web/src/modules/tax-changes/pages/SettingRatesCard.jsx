import { useCallback, useEffect, useState } from "react";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../components/Modal";
import SectionCard from "../../../components/SectionCard";
import DataGrid from "../../../components/DataGrid/DataGrid";
import StatusBadge from "../../../components/StatusBadge";
import { ErrorMessage } from "../../../components/Feedback";
import { getErrorMessage } from "../../../services/api";
import { dateTime } from "@bmp/shared/format";
import { SETTING_WORDS, STATES, addDays, nextApril, onDate } from "../taxChanges";
import "../styles/tax-changes.css";

// A rate kept in settings, changed by date like an item's: a fashion shop's
// GST by price, a lodge's room-night slabs, a restaurant's default GST rate.
// The card shows the values now and every change of them, those to come
// first; a change is entered ahead, cancelled before its date, and kept for
// good from it with what the setting was. Nothing shows for a business that
// keeps no such rate.
//
// api: shopChanges(id) or menuChanges(); canEdit: may change the settings;
// rates: [{ id, name, rate }] the slabs in use (room nights).
export default function SettingRatesCard({ api, canEdit, rates = [] }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [cancelling, setCancelling] = useState(null);

  const load = useCallback((signal) => api.settings(signal).then(setData).catch((err) => { if (!signal?.aborted) setError(getErrorMessage(err)); }), [api]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (!data?.setting) return error ? <ErrorMessage message={error} /> : null;
  const words = SETTING_WORDS[data.setting];
  const columns = [
    { key: "starts", header: "From", type: "date", value: (c) => c.startsOn, mobile: "title", pin: true, render: (c) => <strong>{onDate(c.startsOn)}</strong> },
    { key: "values", header: "Becomes", value: (c) => c.words, mobile: "subtitle" },
    { key: "before", header: "Was", value: (c) => c.beforeWords || "", render: (c) => (c.beforeWords ? c.beforeWords : <span className="muted">On its date</span>) },
    { key: "reason", header: "Reason", value: (c) => c.reason,
      render: (c) => <span className="txc-two-line"><span>{c.reason}</span>{c.state === "cancelled" ? <small className="muted">Cancelled: {c.cancelReason} · {c.cancelledByName}</small>
        : c.note ? <small className="text-danger">{c.note}</small> : null}</span> },
    { key: "by", header: "Entered by", value: (c) => c.createdByName, render: (c) => <span className="txc-two-line"><span>{c.createdByName}</span><small className="muted">{dateTime(c.createdAt)}</small></span>, defaultHidden: true },
    { key: "state", header: "State", type: "status", value: (c) => c.state, mobile: "show",
      render: (c) => <StatusBadge status={c.state} label={STATES[c.state]?.label || c.state} tone={STATES[c.state]?.tone || "neutral"} /> },
    canEdit && { key: "actions", header: "", label: "Actions", type: "actions",
      render: (c) => (c.state === "scheduled" ? <button type="button" className="chip-button" onClick={() => setCancelling(c)}>Cancel</button> : null) },
  ].filter(Boolean);

  return (
    <SectionCard flush icon="sliders" title={`${words.title}, by date`}
      description={`Now: ${data.currentWords}. ${words.help} A change entered here takes effect on its date by itself; to change it from today, use ${data.where}.`}
      actions={canEdit && <button type="button" className="button button-secondary" onClick={() => setCreating(true)} disabled={!data.current}><Icon name="calendar" size={15} /> Change from a date</button>}>
      <ErrorMessage message={error} />
      <DataGrid id={`tax-setting-changes-${data.setting}`} rows={data.changes} rowKey={(c) => c.id} caption={`Changes of ${words.name}`} columns={columns}
        rowNoun={["change", "changes"]} rowClassName={(c) => (c.state === "cancelled" ? "dg-tone-muted" : c.state === "refused" ? "dg-tone-danger" : "")}
        empty={`No change of ${words.name} yet`} emptyIcon="calendar"
        emptyHint={data.current ? "When the GST Council changes it, enter the change ahead of its day." : `Set it up first, under ${data.where}.`} />
      {creating && <SettingChangeDialog api={api} data={data} rates={rates} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load(); }} />}
      {cancelling && <CancelSettingDialog api={api} change={cancelling} onClose={() => setCancelling(null)} onSaved={() => { setCancelling(null); load(); }} />}
    </SectionCard>
  );
}

// The new values, the first day they apply and why.
function SettingChangeDialog({ api, data, rates, onClose, onSaved }) {
  const now = data.current || {};
  const [form, setForm] = useState({
    startsOn: nextApril(data.today), reason: "",
    threshold: now.threshold ? String(Number(now.threshold)) : "", rateLow: now.rateLow ? String(Number(now.rateLow)) : "", rateHigh: now.rateHigh ? String(Number(now.rateHigh)) : "",
    lowTaxRateId: now.lowTaxRateId ? String(now.lowTaxRateId) : "", highTaxRateId: now.highTaxRateId ? String(now.highTaxRateId) : "", slabLimit: now.slabLimit ? String(Number(now.slabLimit)) : "",
    rate: now.rate ? String(Number(now.rate)) : "",
  });
  const [requestKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (name) => (event) => setForm((f) => ({ ...f, [name]: event.target.value }));
  const values = data.setting === "fashion_price" ? { threshold: form.threshold, rateLow: form.rateLow, rateHigh: form.rateHigh }
    : data.setting === "lodging_slabs" ? { lowTaxRateId: form.lowTaxRateId, highTaxRateId: form.highTaxRateId, slabLimit: form.slabLimit } : { rate: form.rate };
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.scheduleSetting({ requestKey, startsOn: form.startsOn, reason: form.reason.trim(), values });
      onSaved();
    } catch (err) {
      setError(getErrorMessage(err));
      setBusy(false);
    }
  };
  const words = SETTING_WORDS[data.setting];
  return (
    <Modal title={`Change ${words.name} from a date`} icon="calendar" width={560} onClose={busy ? () => {} : onClose} dismissible={!busy}
      description={`Now: ${data.currentWords}. From the day you choose, on your own date, every bill uses the new values; bills before keep theirs.`}>
      <form className="form-grid" onSubmit={submit}>
        {error && <div className="field-wide"><ErrorMessage message={error} /></div>}
        {data.setting === "fashion_price" && (
          <>
            <label className="field"><span>Price per piece (₹, before GST)</span><input required type="number" min="1" step="0.01" value={form.threshold} onChange={set("threshold")} /></label>
            <label className="field"><span>GST up to it (%)</span><input required type="number" min="0" max="100" step="0.01" value={form.rateLow} onChange={set("rateLow")} /></label>
            <label className="field"><span>GST above it (%)</span><input required type="number" min="0" max="100" step="0.01" value={form.rateHigh} onChange={set("rateHigh")} /></label>
          </>
        )}
        {data.setting === "lodging_slabs" && (
          <>
            <label className="field"><span>A room a night up to (₹, before GST)</span><input required type="number" min="1" step="0.01" value={form.slabLimit} onChange={set("slabLimit")} /></label>
            <label className="field"><span>Slab at or below it</span>
              <select required value={form.lowTaxRateId} onChange={set("lowTaxRateId")}>
                <option value="">Choose…</option>
                {rates.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
            <label className="field"><span>Slab above it</span>
              <select required value={form.highTaxRateId} onChange={set("highTaxRateId")}>
                <option value="">Choose…</option>
                {rates.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
          </>
        )}
        {data.setting === "restaurant_default" && (
          <label className="field"><span>Default GST rate (%)</span><input required type="number" min="0" max="100" step="0.01" value={form.rate} onChange={set("rate")} /></label>
        )}
        <label className="field">
          <span>From</span>
          <input type="date" required min={addDays(data.today, 1)} value={form.startsOn} onChange={set("startsOn")} />
          <small className="muted">The first day of the new values, on your own date.</small>
        </label>
        <label className="field field-wide">
          <span>Reason</span>
          <input required maxLength={300} value={form.reason} onChange={set("reason")} placeholder="e.g. GST Council notification of 15 March 2027" />
        </label>
        <div className="form-actions field-wide">
          <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="button" disabled={busy}>{busy ? "Scheduling…" : `Schedule from ${onDate(form.startsOn)}`}</button>
        </div>
      </form>
    </Modal>
  );
}

function CancelSettingDialog({ api, change, onClose, onSaved }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.cancelSetting(change.id, reason.trim());
      onSaved();
    } catch (err) {
      setError(getErrorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Modal title={`Cancel the change of ${onDate(change.startsOn)}`} icon="ban" width={520} onClose={busy ? () => {} : onClose} dismissible={!busy}
      description={`${change.name}: ${change.words}. Cancelled, it stays on the list and never takes effect.`}>
      <form className="form-grid" onSubmit={submit}>
        {error && <div className="field-wide"><ErrorMessage message={error} /></div>}
        <label className="field field-wide"><span>Why</span><input required autoFocus maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Notification withdrawn" /></label>
        <div className="form-actions field-wide">
          <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Keep it</button>
          <button type="submit" className="button button-danger" disabled={busy || !reason.trim()}>{busy ? "Cancelling…" : "Cancel the change"}</button>
        </div>
      </form>
    </Modal>
  );
}
