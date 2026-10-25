import { useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../../components/Modal";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import ReasonDialog from "../../core/pages/ReasonDialog";
import { Badge, BusinessHeader, Field, FormError, PeriodFilter } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { OutletPicker } from "./FuelParts";
import { RECEIPT_STATES, atWords, dayWords, densityCheck, densityNote, densityText, dipsCheck, firstOutlet, qty, signed } from "./fuel";
import "../styles/fuel.css";

// Tanker receipts: every tanker load at an outlet. Each comes with the oil
// company's invoice (its litres, value and density at 15 °C for each tank it
// goes into), the lorry and its seals; the lorry's sample is checked against
// the invoice's density (within the tolerance either way, or the load is
// refused unless a manager accepts it saying why), and each tank is dipped
// before and after decanting (what came in, and a short receipt). An
// accepted load is a purchase of the fuel at the invoice's value; a manager
// cancels one entered wrongly. The value is for those who see purchases.

export default function ReceiptsPage() {
  const biz = useOpenBusiness();
  const [outlet, setOutlet] = useState(() => firstOutlet(biz));
  const [dialog, setDialog] = useState(null);
  const list = useServerList("fuel/receipts", { gridId: "fuel-receipts", period: true, params: outlet ? { location: outlet } : {} });
  const money = biz.can("purchasing.view");
  const many = biz.locations.length > 1;
  const columns = useMemo(() => [
    { key: "invoice_no", header: "Invoice", value: (r) => r.invoice_no, className: "mono", mobile: "title", pin: true },
    { key: "supplier", header: "Supplier", value: (r) => r.supplier_name, mobile: "subtitle" },
    { key: "lorry_no", header: "Lorry", value: (r) => r.lorry_no, className: "mono" },
    { key: "received_at", header: "Decanted", type: "datetime", value: (r) => r.received_at, render: (r) => atWords(r.received_at, biz) },
    { key: "loads", header: "Tanks", value: (r) => r.loads || "" },
    { key: "short", header: "Short by the dips", value: (r) => (r.short_litres === null ? "" : Number(r.short_litres)),
      render: (r) => (r.short_litres === null ? "—" : qty(r.short_litres, "")) },
    { key: "density", header: "Density", value: (r) => (r.density_outside ? "Outside the tolerance" : "Within"), mobile: "show",
      render: (r) => (r.density_outside ? <Badge tone="warning" label={r.status === "accepted" ? "Accepted outside" : "Outside"} /> : <Badge tone="success" label="Within" />) },
    { key: "status", header: "Load", type: "status", value: (r) => RECEIPT_STATES[r.status]?.label || r.status, mobile: "show",
      render: (r) => <Badge tone={RECEIPT_STATES[r.status]?.tone} label={RECEIPT_STATES[r.status]?.label || r.status} />,
      filter: "select", filterOptions: Object.values(RECEIPT_STATES).map((s) => ({ value: s.label, label: s.label })) },
    { key: "document_no", header: "Purchase", value: (r) => r.document_no || "", className: "mono" },
    money && { key: "amount", header: "Value", type: "money", exact: true, value: (r) => (r.amount === null ? null : Number(r.amount)), total: "sum" },
    { key: "location", header: "Outlet", value: (r) => r.location_name, defaultHidden: !many },
  ].filter(Boolean), [biz, money, many]);
  const canRecord = biz.can("fuel.create") && biz.can("contacts.view");

  return (
    <div className="stack">
      <BusinessHeader icon="truck" title="Tanker receipts"
        description="Each tanker load with its invoice, checked before it is decanted: the seals, the lorry's density against the invoice's, and each tank dipped before and after. An accepted load is a purchase of the fuel at the invoice's value."
        primary={canRecord && <button type="button" className="button" onClick={() => setDialog({ kind: "new" })}><Icon name="plus" size={16} /> Record a tanker load</button>} />
      <div className="fuel-toolbar"><OutletPicker biz={biz} value={outlet} onChange={setOutlet} /></div>
      <SectionCard flush icon="truck" title="Loads">
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Invoice, lorry, supplier, tank or purchase" }} caption="Tanker loads" columns={columns}
          currency={biz.symbol} rowNoun={["load", "loads"]} onRowClick={(r) => setDialog({ kind: "open", id: r.id })} toolbar={<PeriodFilter list={list} />}
          rowClassName={(r) => (r.status === "cancelled" ? "dg-tone-muted" : r.status === "refused" ? "dg-tone-danger" : r.density_outside ? "dg-tone-warning" : "")}
          exportName={biz.can("fuel.export") ? `${biz.business.code}-tanker-receipts` : undefined}
          empty="No tanker loads in these dates" emptyHint="Record each load as it comes in, before it is decanted." emptyIcon="truck" />
      </SectionCard>
      {dialog?.kind === "new" && <ReceiptDialog biz={biz} outlet={outlet} onClose={() => setDialog(null)}
        onSaved={(r) => { setDialog({ kind: "open", id: r.id }); toast.success(r.status === "accepted" ? `Load ${r.invoice_no} received${r.document_no ? `: purchase ${r.document_no}` : ""}.` : `Load ${r.invoice_no} refused.`); list.reload(); }} />}
      {dialog?.kind === "open" && <ReceiptDetail biz={biz} receiptId={dialog.id} onClose={() => setDialog(null)} onChanged={list.reload} />}
    </div>
  );
}

const blankLine = () => ({ key: newKey(), tankId: "", invoiceLitres: "", invoiceAmount: "", invoiceDensity: "", receiptDensity: "", dipBefore: "", dipAfter: "", decantDensity: "" });

// A tanker load recorded: the invoice, the lorry, and each tank it goes into with the density check and the dips.
function ReceiptDialog({ biz, outlet, onClose, onSaved }) {
  const [key] = useState(newKey);
  const { options, error: optionsError } = useOptions(["contacts?kind=supplier&active=true"]);
  const suppliers = options?.["contacts?kind=supplier&active=true"] || [];
  const [setup, setSetup] = useState(null);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "fuel/setup", undefined, controller.signal).then(setSetup).catch((err) => { if (!controller.signal.aborted) setLoadError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id]);
  const locationId = outlet || String(biz.locations[0]?.id || "");
  const tanks = (setup?.tanks || []).filter((t) => t.active && String(t.location_id) === String(locationId));
  const tolerance = setup?.settings.densityTolerance ?? "3.0";
  const [form, setForm] = useState({ contactId: "", invoiceNo: "", invoiceDate: businessToday(biz.business.timezone), lorryNo: "", sealsOk: true, receivedAt: "",
    status: "accepted", refuseReason: "", densityNote: "", notes: "" });
  const [lines, setLines] = useState(() => [blankLine()]);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const setLine = (k, name) => (e) => setLines((all) => all.map((l) => (l.key === k ? { ...l, [name]: e.target.value } : l)));
  const checks = lines.map((l) => densityCheck(l.invoiceDensity, l.receiptDensity, tolerance));
  const outside = checks.some((c) => c && !c.within);
  const accepted = form.status === "accepted";
  const canAccept = biz.can("purchasing.create");
  const manager = biz.can("fuel.approve");
  const submit = () => businessWrite(biz.id, "fuel/receipts", {
    requestKey: key, locationId, contactId: form.contactId, invoiceNo: form.invoiceNo.trim(), invoiceDate: form.invoiceDate, lorryNo: form.lorryNo.trim(), sealsOk: form.sealsOk,
    ...(form.receivedAt ? { receivedAt: form.receivedAt } : {}), status: form.status,
    ...(form.status === "refused" ? { refuseReason: form.refuseReason.trim() } : {}),
    ...(accepted && outside && form.densityNote.trim() ? { densityNote: form.densityNote.trim() } : {}),
    ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
    lines: lines.map((l) => ({ tankId: l.tankId, invoiceLitres: l.invoiceLitres.trim(), invoiceAmount: l.invoiceAmount.trim() || "0", invoiceDensity: l.invoiceDensity.trim(),
      receiptDensity: l.receiptDensity.trim(), ...(accepted || l.dipBefore.trim() ? { dipBefore: l.dipBefore.trim(), dipAfter: l.dipAfter.trim() } : {}),
      ...(accepted && l.decantDensity.trim() ? { decantDensity: l.decantDensity.trim() } : {}) })),
  });
  return (
    <FormDialog title="Record a tanker load" icon="truck" width={900} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      submitLabel={accepted ? "Accept the load" : "Refuse the load"} description={densityNote(tolerance)}>
      <FormError message={optionsError || loadError} />
      <Field label="Supplier (the oil company's depot or terminal)" wide>
        <select required value={form.contactId} onChange={set("contactId")}>
          <option value="">Choose the supplier</option>
          {suppliers.map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
        </select>
      </Field>
      <Field label="Invoice number"><input required maxLength={60} className="mono" value={form.invoiceNo} onChange={set("invoiceNo")} /></Field>
      <Field label="Invoice date"><input type="date" required value={form.invoiceDate} onChange={set("invoiceDate")} /></Field>
      <Field label="Tank lorry number"><input required maxLength={15} className="mono" value={form.lorryNo} onChange={set("lorryNo")} placeholder="TS07UA1234" /></Field>
      <Field label="Decanted at (optional)" hint="Left empty: now."><input type="datetime-local" value={form.receivedAt} onChange={set("receivedAt")} /></Field>
      <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.sealsOk} onChange={set("sealsOk")} /> The seals were intact and matched the invoice</label>
      <fieldset className="field-wide fuel-fieldset">
        <legend>Tanks it goes into</legend>
        {lines.map((l, index) => {
          const tank = tanks.find((t) => String(t.id) === l.tankId);
          const check = checks[index];
          const dips = dipsCheck(l.invoiceLitres, l.dipBefore, l.dipAfter);
          return (
            <div key={l.key} className="fuel-row fuel-row-wide" role="group" aria-label={`Tank ${index + 1}`}>
              <Field label="Tank">
                <select required value={l.tankId} onChange={setLine(l.key, "tankId")}>
                  <option value="">Choose the tank</option>
                  {tanks.map((t) => <option key={t.id} value={String(t.id)}>Tank {t.tank_no} · {t.product_name}</option>)}
                </select>
              </Field>
              <Field label="Litres on the invoice"><input required inputMode="decimal" className="mono" value={l.invoiceLitres} onChange={setLine(l.key, "invoiceLitres")} /></Field>
              <Field label={`Value on the invoice (${biz.symbol})`}><input required inputMode="decimal" className="mono" value={l.invoiceAmount} onChange={setLine(l.key, "invoiceAmount")} /></Field>
              <Field label="Invoice density at 15 °C"><input required inputMode="decimal" className="mono" value={l.invoiceDensity} onChange={setLine(l.key, "invoiceDensity")} placeholder="745.0" /></Field>
              <Field label="Lorry's density at 15 °C"><input required inputMode="decimal" className="mono" value={l.receiptDensity} onChange={setLine(l.key, "receiptDensity")} /></Field>
              <Field label="Dip before decanting (litres)"><input required={accepted} inputMode="decimal" className="mono" value={l.dipBefore} onChange={setLine(l.key, "dipBefore")} /></Field>
              <Field label="Dip after decanting (litres)" hint={tank ? `Holds at most ${qty(tank.capacity, tank.unit)}` : undefined}>
                <input required={accepted} inputMode="decimal" className="mono" value={l.dipAfter} onChange={setLine(l.key, "dipAfter")} />
              </Field>
              {accepted && <Field label="Density after decanting (optional)" hint="After 50 litres are dispensed."><input inputMode="decimal" className="mono" value={l.decantDensity} onChange={setLine(l.key, "decantDensity")} /></Field>}
              <p className="fuel-line-check" role="status">
                {check ? <Badge tone={check.within ? "success" : "danger"} label={`${signed(check.difference)} kg/m³ · ${check.within ? "within the tolerance" : "outside the tolerance"}`} />
                  : <span className="muted small">The density check shows once both densities are typed.</span>}
                {dips && <span className="small"> Received {qty(dips.received, tank?.unit)} by the dips{dips.short > 0 ? `, ${qty(dips.short, tank?.unit)} short of the invoice` : dips.short < 0 ? `, ${qty(-dips.short, tank?.unit)} over the invoice` : ""}.</span>}
              </p>
              {lines.length > 1 && <button type="button" className="link-button danger" onClick={() => setLines((all) => all.filter((x) => x.key !== l.key))}>Remove</button>}
            </div>
          );
        })}
        {lines.length < 12 && <button type="button" className="chip-button" onClick={() => setLines((all) => [...all, blankLine()])}><Icon name="plus" size={13} /> Another tank</button>}
      </fieldset>
      <Field label="The load is" wide>
        <select value={form.status} onChange={set("status")}>
          <option value="accepted" disabled={!canAccept}>Accepted: decanted into the tanks</option>
          <option value="refused">Refused: sent back undecanted</option>
        </select>
      </Field>
      {!canAccept && <p className="fuel-note field-wide">Accepting a load buys it: someone who makes purchases accepts it.</p>}
      {form.status === "refused" && <Field label="Why the load is refused" wide><input required maxLength={300} value={form.refuseReason} onChange={set("refuseReason")} /></Field>}
      {accepted && outside && (manager
        ? <Field label="Why the load is accepted outside the tolerance" wide hint="A manager's note, kept with the load and shown on the bell for a week.">
          <input required maxLength={300} value={form.densityNote} onChange={set("densityNote")} placeholder="e.g. the sales officer checked the sample and allowed decanting" />
        </Field>
        : <p className="fuel-note fuel-warn field-wide" role="status">A density outside the tolerance: refuse the load, or ask a manager to accept it.</p>)}
      <Field label="Notes (optional)" wide><input maxLength={500} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

// A load as recorded, with the density after decanting written once for each tank, and a manager's cancellation.
function ReceiptDetail({ biz, receiptId, onClose, onChanged }) {
  const [r, setR] = useState(null);
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [decants, setDecants] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `fuel/receipts/${receiptId}`, undefined, controller.signal).then(setR).catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, receiptId]);
  const saveDecants = async () => {
    const given = Object.entries(decants).filter(([, v]) => v.trim()).map(([tankId, density]) => ({ tankId, density: density.trim() }));
    if (!given.length) return;
    setBusy(true);
    try {
      setR(await businessWrite(biz.id, `fuel/receipts/${r.id}/decant`, { lines: given }));
      setDecants({});
      toast.success("Density after decanting saved.");
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const open = r && r.status === "accepted";
  const waiting = open ? r.lines.filter((l) => l.decant_density === null) : [];
  return (
    <Modal title={r ? `Tanker load ${r.invoice_no}` : "Tanker load"} icon="truck" width={860} onClose={onClose}
      description={r ? `${r.supplier_name} · lorry ${r.lorry_no} · decanted ${atWords(r.received_at, biz)}` : undefined}>
      <ErrorMessage message={error} />
      {!r ? (!error && <Loading />) : (
        <div className="stack">
          <dl className="fuel-facts">
            <dt>Load</dt><dd><Badge tone={RECEIPT_STATES[r.status]?.tone} label={RECEIPT_STATES[r.status]?.label || r.status} /></dd>
            <dt>Invoice</dt><dd>{r.invoice_no} of {dayWords(r.invoice_date)}</dd>
            <dt>Seals</dt><dd>{r.seals_ok === null ? "Not noted" : r.seals_ok ? "Intact and matching the invoice" : "Not as on the invoice"}</dd>
            {r.document_no && <><dt>Purchase</dt><dd className="mono">{r.document_no}{r.amount !== null ? ` · ${biz.exact(r.amount)}` : ""}</dd></>}
            {r.refuse_reason && <><dt>Refused</dt><dd>{r.refuse_reason}</dd></>}
            {r.density_note && <><dt>Accepted outside the tolerance</dt><dd>{r.density_approved_by_name}: {r.density_note}</dd></>}
            {r.cancel_reason && <><dt>Cancelled</dt><dd>{atWords(r.cancelled_at, biz)}{r.cancelled_by_name ? ` by ${r.cancelled_by_name}` : ""}: {r.cancel_reason}</dd></>}
            <dt>Recorded by</dt><dd>{r.created_by_name}</dd>
            {r.notes && <><dt>Notes</dt><dd>{r.notes}</dd></>}
          </dl>
          <div className="fuel-table-wrap">
            <table className="fuel-table" aria-label="Tanks of this load">
              <thead><tr><th>Tank</th><th className="r">Invoice</th><th className="r">Invoice density</th><th className="r">Lorry's density</th><th>Check</th><th className="r">Dips</th><th className="r">Received</th><th className="r">After decanting</th></tr></thead>
              <tbody>
                {r.lines.map((l) => (
                  <tr key={l.tank_id}>
                    <th scope="row">Tank {l.tank_no}<small className="muted">{l.product_name}</small></th>
                    <td className="r mono">{qty(l.invoice_litres, "")}{l.invoice_amount !== null ? <small className="muted">{biz.exact(l.invoice_amount)}</small> : null}</td>
                    <td className="r mono">{densityText(l.invoice_density)}</td>
                    <td className="r mono">{densityText(l.receipt_density)}</td>
                    <td><Badge tone={l.density_within ? "success" : "danger"} label={`${signed(l.density_difference)} · ${l.density_within ? "within" : "outside"} ±${Number(l.tolerance).toFixed(1)}`} /></td>
                    <td className="r mono">{l.dip_before === null ? "—" : `${qty(l.dip_before, "")} → ${qty(l.dip_after, "")}`}</td>
                    <td className="r mono">{l.received_litres === null ? "—" : qty(l.received_litres, "")}{l.short_litres !== null && Number(l.short_litres) !== 0 ? <small className="muted">{Number(l.short_litres) > 0 ? `${qty(l.short_litres, "")} short` : `${qty(-Number(l.short_litres), "")} over`}</small> : null}</td>
                    <td className="r mono">{l.decant_density !== null ? densityText(l.decant_density)
                      : open && biz.can("fuel.create") ? <input aria-label={`Tank ${l.tank_no}: density after decanting`} inputMode="decimal" className="mono fuel-small-input" value={decants[l.tank_id] || ""}
                        onChange={(e) => setDecants((d) => ({ ...d, [l.tank_id]: e.target.value }))} /> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="form-actions">
            {waiting.length > 0 && biz.can("fuel.create") && <button type="button" className="button button-secondary" disabled={busy || !Object.values(decants).some((v) => v.trim())} onClick={saveDecants}>Save the density after decanting</button>}
            {open && biz.can("fuel.approve") && <button type="button" className="button button-secondary" onClick={() => setCancelling(true)}><Icon name="ban" size={15} /> Cancel the load</button>}
            <button type="button" className="button" onClick={onClose}>Close</button>
          </div>
        </div>
      )}
      {cancelling && (
        <ReasonDialog title={`Cancel load ${r.invoice_no}`} label="Why it is cancelled" submitLabel="Cancel the load"
          description="For a load entered wrongly: its purchase is credited and its litres go back out of stock."
          onClose={() => setCancelling(false)} onSaved={(next) => { setCancelling(false); setR(next); onChanged(); toast.success(`Load ${r.invoice_no} cancelled.`); }}
          onSubmit={(reason) => businessWrite(biz.id, `fuel/receipts/${r.id}/cancel`, { requestKey: newKey(), reason })} />
      )}
    </Modal>
  );
}
