import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import ReasonDialog from "../../core/pages/ReasonDialog";
import { DocumentDetail } from "../../core/pages/DocumentsPage";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { newKey, useOpenBusiness } from "../../core/pages/hooks";
import { SettlementBadge } from "./FuelParts";
import { FLEET_CARD_NOTE, SHIFT_STATES, TAKING_KINDS, TEST_NOTE, VAT_NOTE, atWords, methodName, qty, reading, settlement } from "./fuel";
import { printShift } from "./fuelPrint";
import "../styles/fuel.css";

// A shift: the nozzles its attendant runs, each from its opening reading at
// the price in force when it opened. While open, the close: each nozzle's
// closing reading and the 5-litre test pumped back, the credit slips of fleet
// vehicles, the UPI, card and fleet-card takings and the cash counted; the
// server works out what the meters sold, to the paisa, and the attendant's
// short or excess before anything is saved. Once closed: the settlement and
// the fuel bills it posted; a manager reopens it, saying why, before the next
// shift starts on its nozzles.

export default function ShiftPage() {
  const biz = useOpenBusiness();
  const { shiftId } = useParams();
  const [shift, setShift] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `fuel/shifts/${shiftId}`, undefined, controller.signal)
      .then((s) => { setShift(s); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, shiftId, version]);
  const reload = (message) => { setDialog(null); if (message) toast.success(message); setVersion((n) => n + 1); };

  if (!shift) {
    return (
      <div className="stack">
        <BusinessHeader icon="timer" title="Shift" />
        <ErrorMessage message={error} />
        {!error && <Loading />}
        <Link to={biz.path("fuel-shifts")}>Back to Shift & readings</Link>
      </div>
    );
  }
  const closed = shift.status === "closed" && shift.close;
  const canReopen = closed && biz.can("fuel.approve") && shift.reopenable;
  return (
    <div className="stack">
      <BusinessHeader icon="timer" title={`Shift ${shift.shift_no}`}
        description={`${shift.attendant_name} · ${shift.location_name} · opened ${atWords(shift.opened_at, biz)}${closed ? ` · closed ${atWords(shift.close.closed_at, biz)}` : ""}`}
        primary={closed && shift.money && biz.can("fuel.print") && <button type="button" className="button button-secondary" onClick={() => printShift(biz, shift)}><Icon name="print" size={16} /> Print the settlement</button>}
        secondary={canReopen && <button type="button" className="button button-secondary" onClick={() => setDialog("reopen")}><Icon name="undo" size={16} /> Reopen the shift</button>} />
      <div className="fuel-toolbar">
        <Badge tone={SHIFT_STATES[shift.status]?.tone} label={SHIFT_STATES[shift.status]?.label || shift.status} />
        <Link className="small" to={biz.path("fuel-shifts")}>Back to Shift & readings</Link>
      </div>
      <ErrorMessage message={error} />
      {shift.status === "open"
        ? <>
          <ShiftNozzles biz={biz} shift={shift} onChanged={setShift} />
          {biz.can("fuel.create") && <CloseShift biz={biz} shift={shift} onClosed={(s) => { setShift(s); toast.success(`Shift ${s.shift_no} closed: ${settlement(s.close?.difference ?? 0, biz.exact).label.toLowerCase()}.`); }} />}
        </>
        : closed && <Settlement biz={biz} shift={shift} close={shift.close} />}
      {closed && !shift.reopenable && shift.next_shift && biz.can("fuel.approve") && (
        <p className="fuel-note">Shift {shift.next_shift.shift_no} has opened on nozzle {shift.next_shift.nozzle_no} since this one closed: it is no longer reopened.</p>
      )}
      {shift.history.length > 0 && <History biz={biz} shift={shift} />}
      {dialog === "reopen" && (
        <ReasonDialog title={`Reopen shift ${shift.shift_no}`} icon="undo" label="Why it is reopened" submitLabel="Reopen it"
          description="Its fuel bills are credited (the litres back in stock until it closes again), the walk-in bill's takings handed back, and its nozzles read again from the shift's opening. Close it again with the right readings."
          onClose={() => setDialog(null)} onSaved={() => reload(`Shift ${shift.shift_no} reopened.`)}
          onSubmit={(reason) => businessWrite(biz.id, `fuel/shifts/${shift.id}/reopen`, { requestKey: newKey(), reason })} />
      )}
    </div>
  );
}

// The nozzles an open shift runs, from their opening readings; one taken by mistake comes off, another goes on.
function ShiftNozzles({ biz, shift, onChanged }) {
  const [adding, setAdding] = useState(false);
  const remove = (n) => businessWrite(biz.id, `fuel/shifts/${shift.id}/nozzles/${n.nozzle_id}`, undefined, "delete")
    .then((s) => { onChanged(s); toast.success(`Nozzle ${n.nozzle_no} taken off the shift.`); }).catch((err) => toast.error(getErrorMessage(err)));
  const keeps = biz.can("fuel.create");
  return (
    <SectionCard flush icon="fire" title="Nozzles on this shift" description="Each opened from its totaliser as its last shift closed it, at the price in force then."
      actions={keeps && <button type="button" className="button button-secondary button-sm" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Add a nozzle</button>}>
      <DataGrid variant="compact" id="fuel-shift-nozzles" caption="Nozzles on this shift" rows={shift.nozzles} rowKey={(n) => n.nozzle_id} currency={biz.symbol} rowNoun={["nozzle", "nozzles"]}
        columns={[
          { key: "nozzle_no", header: "Nozzle", value: (n) => n.nozzle_no, mobile: "title", pin: true, render: (n) => <strong>Nozzle {n.nozzle_no}</strong> },
          { key: "product", header: "Fuel", value: (n) => n.product_name, mobile: "subtitle", render: (n) => `${n.product_name}${n.tank_no ? ` · tank ${n.tank_no}` : ""} · ${n.unit_no}` },
          { key: "opening", header: "Opening reading", value: (n) => Number(n.opening), className: "mono", render: (n) => reading(n.opening) },
          shift.money && { key: "price", header: "Price", type: "money", exact: true, value: (n) => (n.price === null ? null : Number(n.price)) },
          keeps && shift.nozzles.length > 1 && { key: "actions", header: "", label: "Actions", type: "actions",
            render: (n) => <button type="button" className="chip-button" onClick={() => remove(n)}>Take off</button> },
        ].filter(Boolean)} />
      {adding && <AddNozzleDialog biz={biz} shift={shift} onClose={() => setAdding(false)} onSaved={(s) => { setAdding(false); onChanged(s); }} />}
    </SectionCard>
  );
}

function AddNozzleDialog({ biz, shift, onClose, onSaved }) {
  const [free, setFree] = useState(null);
  const [nozzleId, setNozzleId] = useState("");
  const [opening, setOpening] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "fuel/shifts/day", { locationId: shift.location_id }, controller.signal)
      .then((b) => setFree(b.nozzles.filter((n) => !n.open_shift_id && n.unit_status === "in_use")))
      .catch(() => setFree([]));
    return () => controller.abort();
  }, [biz.id, shift.location_id]);
  const pick = (value) => {
    setNozzleId(value);
    const n = (free || []).find((x) => String(x.id) === value);
    setOpening(n ? Number(n.reading).toFixed(3) : "");
  };
  return (
    <FormDialog title={`Add a nozzle to ${shift.shift_no}`} icon="fire" width={520} onClose={onClose} onSaved={onSaved} submitLabel="Add it"
      description="It opens from its totaliser as its last shift closed it, at the price in force when this shift opened."
      onSubmit={() => businessWrite(biz.id, `fuel/shifts/${shift.id}/nozzles`, { nozzleId, opening })}>
      <Field label="Nozzle" wide>
        <select required value={nozzleId} onChange={(e) => pick(e.target.value)} disabled={!free}>
          <option value="">{free && !free.length ? "Every nozzle is on a shift" : "Choose the nozzle"}</option>
          {(free || []).map((n) => <option key={n.id} value={String(n.id)}>Nozzle {n.nozzle_no} · {n.product_name}{n.tank_no ? ` · tank ${n.tank_no}` : ""}</option>)}
        </select>
      </Field>
      {nozzleId && <Field label="Totaliser now"><input required inputMode="decimal" className="mono" value={opening} onChange={(e) => setOpening(e.target.value)} /></Field>}
    </FormDialog>
  );
}

const blankSlip = () => ({ key: newKey(), contactId: "", vehicleId: "", litres: "", slipNo: "" });
const blankTaking = () => ({ key: newKey(), methodId: "", amount: "", reference: "" });

// The close: readings, slips and takings typed in, the server's figures shown as they are typed, then saved once.
function CloseShift({ biz, shift, onClosed }) {
  const methods = usePaymentMethods();
  const takingMethods = methods.ready ? methods.options(TAKING_KINDS) : [];
  const [requestKey] = useState(newKey);
  const [vehicles, setVehicles] = useState([]);
  const [readings, setReadings] = useState(() => Object.fromEntries(shift.nozzles.map((n) => [n.nozzle_id, { closing: "", test: "" }])));
  const [slips, setSlips] = useState([]);
  const [takings, setTakings] = useState([]);
  const [cash, setCash] = useState("");
  const [closedAt, setClosedAt] = useState("");
  const [note, setNote] = useState("");
  const [approve, setApprove] = useState(false);
  const [figures, setFigures] = useState({ key: "", preview: null, error: "" });
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  const asked = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "fuel/vehicles", undefined, controller.signal).then(setVehicles).catch(() => setVehicles([]));
    return () => controller.abort();
  }, [biz.id]);
  const customers = useMemo(() => {
    const seen = new Map();
    for (const v of vehicles) if (!seen.has(String(v.contact_id))) seen.set(String(v.contact_id), { id: String(v.contact_id), name: v.customer_name });
    return [...seen.values()];
  }, [vehicles]);
  const unitOf = (productId) => shift.nozzles.find((n) => String(n.product_id) === String(productId))?.unit;
  const complete = shift.nozzles.every((n) => readings[n.nozzle_id]?.closing.trim() !== "");
  const body = useMemo(() => ({
    readings: shift.nozzles.map((n) => ({ nozzleId: n.nozzle_id, closing: readings[n.nozzle_id].closing.trim(), ...(readings[n.nozzle_id].test.trim() ? { test: readings[n.nozzle_id].test.trim() } : {}) })),
    slips: slips.filter((s) => s.vehicleId && s.litres.trim()).map((s) => ({ contactId: s.contactId, vehicleId: s.vehicleId, litres: s.litres.trim(), ...(s.slipNo.trim() ? { slipNo: s.slipNo.trim() } : {}) })),
    payments: takings.filter((t) => t.methodId && t.amount.trim()).map((t) => ({ methodId: t.methodId, amount: t.amount.trim(), ...(t.reference.trim() ? { reference: t.reference.trim() } : {}) })),
    cash: cash.trim() || "0",
    ...(closedAt ? { closedAt } : {}),
    ...(note.trim() ? { note: note.trim() } : {}),
  }), [shift.nozzles, readings, slips, takings, cash, closedAt, note]);
  // The server's figures, a moment after the typing stops; shown only for the close as it is typed now.
  const bodyKey = JSON.stringify(body);
  useEffect(() => {
    if (!complete) return undefined;
    const ask = ++asked.current;
    const timer = setTimeout(() => {
      businessWrite(biz.id, `fuel/shifts/${shift.id}/close/preview`, JSON.parse(bodyKey))
        .then((p) => { if (ask === asked.current) setFigures({ key: bodyKey, preview: p, error: "" }); })
        .catch((err) => { if (ask === asked.current) setFigures({ key: bodyKey, preview: null, error: getErrorMessage(err) }); });
    }, 350);
    return () => clearTimeout(timer);
  }, [biz.id, shift.id, bodyKey, complete]);
  const fresh = complete && figures.key === bodyKey;
  const preview = fresh ? figures.preview : null;
  const previewError = fresh ? figures.error : "";
  const setReading = (nozzleId, name, value) => setReadings((all) => ({ ...all, [nozzleId]: { ...all[nozzleId], [name]: value } }));
  const setSlip = (key, name, value) => setSlips((all) => all.map((s) => (s.key === key ? { ...s, [name]: value, ...(name === "contactId" ? { vehicleId: "" } : {}) } : s)));
  const setTaking = (key, name, value) => setTakings((all) => all.map((t) => (t.key === key ? { ...t, [name]: value } : t)));
  const nozzleFigures = (nozzleId) => preview?.nozzles.find((n) => String(n.nozzleId) === String(nozzleId));
  const canApprove = biz.can("fuel.approve");
  const blocked = !preview || previewError || (preview.approvalNeeded && !(approve && canApprove)) || preview.stock.length > 0;

  const close = async (event) => {
    event.preventDefault();
    setBusy(true);
    setSaveError("");
    try {
      onClosed(await businessWrite(biz.id, `fuel/shifts/${shift.id}/close`, { requestKey, ...body, ...(approve && canApprove ? { approve: true } : {}) }));
    } catch (err) {
      setSaveError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={close} aria-label={`Close shift ${shift.shift_no}`}>
      <SectionCard icon="clipboard" title="Closing readings" description={TEST_NOTE}>
        <div className="fuel-table-wrap">
          <table className="fuel-table" aria-label="Closing readings">
            <thead><tr><th>Nozzle</th><th className="r">Opening</th><th>Closing reading</th><th>Test pumped back</th><th className="r">Sold</th></tr></thead>
            <tbody>
              {shift.nozzles.map((n) => {
                const f = nozzleFigures(n.nozzle_id);
                return (
                  <tr key={n.nozzle_id}>
                    <th scope="row">Nozzle {n.nozzle_no}<small className="muted">{n.product_name}{n.tank_no ? ` · tank ${n.tank_no}` : ""}</small></th>
                    <td className="r mono">{reading(n.opening)}</td>
                    <td><input aria-label={`Nozzle ${n.nozzle_no}: closing reading`} inputMode="decimal" className="mono" required value={readings[n.nozzle_id].closing}
                      onChange={(e) => setReading(n.nozzle_id, "closing", e.target.value)} placeholder={Number(n.opening).toFixed(3)} /></td>
                    <td>
                      <span className="fuel-inline">
                        <input aria-label={`Nozzle ${n.nozzle_no}: test pumped back`} inputMode="decimal" className="mono" value={readings[n.nozzle_id].test}
                          onChange={(e) => setReading(n.nozzle_id, "test", e.target.value)} placeholder="0" />
                        <button type="button" className="chip-button" onClick={() => setReading(n.nozzle_id, "test", Number(shift.test_litres).toFixed(3))}>{Number(shift.test_litres)} {n.unit === "kg" ? "kg" : "L"} test</button>
                      </span>
                    </td>
                    <td className="r mono">{f ? qty(f.litres, n.unit) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard icon="truck" title="Credit slips" description="Each fill of a fleet customer's vehicle on credit, from the slip the driver signed. It goes on the customer's fuel bill of this shift."
        actions={<button type="button" className="button button-secondary button-sm" onClick={() => setSlips((all) => [...all, blankSlip()])} disabled={!vehicles.length}><Icon name="plus" size={14} /> Add a credit slip</button>}>
        {!vehicles.length && <p className="muted">No fleet vehicles yet{biz.can("fuel.edit") && biz.can("sales.view") ? ": add them under Customers & fleets › Fleet statements." : "."}</p>}
        {vehicles.length > 0 && !slips.length && <p className="muted">No credit slips on this shift.</p>}
        {slips.map((s, index) => (
          <fieldset key={s.key} className="fuel-row" aria-label={`Credit slip ${index + 1}`}>
            <Field label="Customer">
              <select required value={s.contactId} onChange={(e) => setSlip(s.key, "contactId", e.target.value)}>
                <option value="">Choose the customer</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Vehicle">
              <select required value={s.vehicleId} onChange={(e) => setSlip(s.key, "vehicleId", e.target.value)} disabled={!s.contactId}>
                <option value="">Choose the vehicle</option>
                {vehicles.filter((v) => String(v.contact_id) === s.contactId).map((v) => (
                  <option key={v.id} value={String(v.id)}>{v.registration}{v.product_name ? ` · ${v.product_name}` : ""}{v.fill_limit ? ` · up to ${Number(v.fill_limit)}` : ""}</option>
                ))}
              </select>
            </Field>
            <Field label="Quantity"><input required inputMode="decimal" className="mono" value={s.litres} onChange={(e) => setSlip(s.key, "litres", e.target.value)} /></Field>
            <Field label="Slip number (optional)"><input maxLength={30} value={s.slipNo} onChange={(e) => setSlip(s.key, "slipNo", e.target.value)} /></Field>
            <button type="button" className="link-button danger" onClick={() => setSlips((all) => all.filter((x) => x.key !== s.key))}>Remove</button>
          </fieldset>
        ))}
      </SectionCard>

      <SectionCard icon="wallet" title="Money handed in" description={`The UPI, card and fleet-card takings from the machines' settlement slips, and the cash counted. ${FLEET_CARD_NOTE}`}
        actions={<button type="button" className="button button-secondary button-sm" onClick={() => setTakings((all) => [...all, blankTaking()])} disabled={!takingMethods.length}><Icon name="plus" size={14} /> Add a taking</button>}>
        {takings.map((t, index) => (
          <fieldset key={t.key} className="fuel-row" aria-label={`Taking ${index + 1}`}>
            <Field label="How it was paid">
              <select required value={t.methodId} onChange={(e) => setTaking(t.key, "methodId", e.target.value)}>
                <option value="">Choose</option>
                {takingMethods.map((m) => <option key={m.key} value={String(m.id)}>{m.name}</option>)}
              </select>
            </Field>
            <Field label="Amount"><input required inputMode="decimal" className="mono" value={t.amount} onChange={(e) => setTaking(t.key, "amount", e.target.value)} /></Field>
            <Field label="Reference (optional)"><input maxLength={100} value={t.reference} onChange={(e) => setTaking(t.key, "reference", e.target.value)} placeholder="Batch or settlement number" /></Field>
            <button type="button" className="link-button danger" onClick={() => setTakings((all) => all.filter((x) => x.key !== t.key))}>Remove</button>
          </fieldset>
        ))}
        <div className="form-grid bz-form">
          <Field label={`Cash counted (${biz.symbol})`}><input inputMode="decimal" className="mono" value={cash} onChange={(e) => setCash(e.target.value)} placeholder="0.00" /></Field>
          <Field label="Readings taken at (optional)" hint="Left empty: now. When a price changed while the shift was open, close it with the readings taken at the change.">
            <input type="datetime-local" value={closedAt} onChange={(e) => setClosedAt(e.target.value)} />
          </Field>
          <Field label="Note (optional)" wide><input maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. why the attendant is short" /></Field>
        </div>
      </SectionCard>

      <SectionCard icon="receipt" title="The shift's money" description={VAT_NOTE}>
        {!complete ? <p className="muted">Type every nozzle's closing reading to see what the meters sold.</p>
          : previewError ? <p className="fuel-note fuel-warn" role="status">{previewError}</p>
            : !preview ? <Loading label="Working it out…" />
              : <CloseFigures biz={biz} preview={preview} unitOf={unitOf} />}
        {preview?.approvalNeeded && (
          <div className="fuel-note fuel-warn" role="status">
            <strong>A manager allows this credit:</strong>
            <ul>{preview.limits.map((l, i) => <li key={i}>{l.kind === "fill" ? `${l.registration} (${l.customer}) took ${qty(l.litres, "")}, over its fill limit of ${qty(l.limit, "")}`
              : `${l.customer} would owe ${biz.exact(l.after)}, over the credit limit of ${biz.exact(l.limit)}`}</li>)}</ul>
            {canApprove ? <label className="checkbox bz-check"><input type="checkbox" checked={approve} onChange={(e) => setApprove(e.target.checked)} /> I allow the credit over the limit</label>
              : <span>Ask a manager to close the shift.</span>}
          </div>
        )}
        {preview?.stock.length > 0 && (
          <p className="fuel-note fuel-warn" role="status">{preview.stock.map((s) => `The meters sold ${qty(s.sold, s.unit)} of ${s.name}, more than the ${qty(s.stock, s.unit)} in stock`).join("; ")}: record the tanker loads first (Tanker receipts).</p>
        )}
        <ErrorMessage message={saveError} />
        <div className="form-actions">
          <button type="submit" className="button" disabled={busy || blocked}>{busy ? "Closing…" : "Close the shift"}</button>
        </div>
      </SectionCard>
    </form>
  );
}

function CloseFigures({ biz, preview, unitOf }) {
  const s = settlement(preview.difference, biz.exact);
  return (
    <>
      <div className="fuel-table-wrap">
        <table className="fuel-table" aria-label="What the meters sold">
          <thead><tr><th>Fuel</th><th className="r">Price</th><th className="r">Sold</th><th className="r">On credit</th><th className="r">Walk-in</th><th className="r">Amount</th></tr></thead>
          <tbody>
            {preview.products.map((p) => (
              <tr key={p.productId}>
                <th scope="row">{p.name}</th><td className="r mono">{biz.exact(p.price)}</td><td className="r mono">{qty(p.litres, unitOf(p.productId))}</td>
                <td className="r mono">{qty(p.creditLitres, unitOf(p.productId))}</td><td className="r mono">{qty(p.walkInLitres, unitOf(p.productId))}</td><td className="r mono">{biz.exact(p.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="fuel-facts" aria-label="The shift's settlement">
        <dt>Expected</dt><dd className="mono">{biz.exact(preview.expected)}</dd>
        <dt>On credit slips</dt><dd className="mono">{biz.exact(preview.credit)}</dd>
        <dt>Walk-in sales</dt><dd className="mono">{biz.exact(preview.walkIn)}</dd>
        <dt>UPI, cards and fleet cards</dt><dd className="mono">{biz.exact(preview.other)}</dd>
        <dt>Cash counted</dt><dd className="mono">{biz.exact(preview.cash)}</dd>
        <dt>The attendant</dt><dd><Badge tone={s.tone} label={s.label} /></dd>
      </dl>
      {Number(preview.short) > 0 && <p className="fuel-note">The {biz.exact(preview.short)} short is left due on the walk-in fuel bill, against the attendant.</p>}
      {Number(preview.excess) > 0 && <p className="fuel-note">The {biz.exact(preview.excess)} in excess stays with the shift: the walk-in bill takes only what is due.</p>}
    </>
  );
}

// A closed shift's settlement and the bills it posted.
function Settlement({ biz, shift, close }) {
  const [billId, setBillId] = useState(null);
  const seesBills = biz.can("sales.view");
  if (!shift.money) {
    return (
      <SectionCard icon="clipboard" title="Readings">
        <ReadingsTable close={close} />
      </SectionCard>
    );
  }
  return (
    <>
      <div className="stat-grid">
        <StatTile icon="receipt" tone="primary" label="Expected" value={biz.exact(close.expected)} note={`${biz.exact(close.credit)} on credit slips`} />
        <StatTile icon="cash" tone="neutral" label="Walk-in sales" value={biz.exact(close.walk_in)} note={`${biz.exact(close.other)} by UPI and cards`} />
        <StatTile icon="wallet" tone="neutral" label="Cash counted" value={biz.exact(close.cash)} />
        <StatTile icon="alert" tone={Number(close.difference) < 0 ? "danger" : Number(close.difference) > 0 ? "warning" : "success"} label="The attendant"
          value={settlement(close.difference, biz.exact).label} note={close.approved_by_name ? `credit over a limit allowed by ${close.approved_by_name}` : undefined} />
      </div>
      <SectionCard icon="clipboard" title="Readings" description={`Closed ${atWords(close.closed_at, biz)}${close.closed_by_name ? ` by ${close.closed_by_name}` : ""}.`}>
        <ReadingsTable close={close} />
      </SectionCard>
      <SectionCard icon="tag" title="Sales at the price in force">
        <div className="fuel-table-wrap">
          <table className="fuel-table" aria-label="Sales at the price in force">
            <thead><tr><th>Fuel</th><th className="r">Price</th><th className="r">Sold</th><th className="r">On credit</th><th className="r">Walk-in</th><th className="r">Amount</th></tr></thead>
            <tbody>
              {close.products.map((p) => (
                <tr key={p.product_id}><th scope="row">{p.product_name}</th><td className="r mono">{biz.exact(p.price)}</td><td className="r mono">{qty(p.litres, p.unit)}</td>
                  <td className="r mono">{qty(p.credit_litres, p.unit)}</td><td className="r mono">{qty(p.walk_in_litres, p.unit)}</td><td className="r mono">{biz.exact(p.amount)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
      {close.slips.length > 0 && (
        <SectionCard flush icon="truck" title="Credit slips">
          <DataGrid variant="compact" id="fuel-shift-slips" caption="Credit slips" rows={close.slips} rowKey={(s) => s.id} currency={biz.symbol} rowNoun={["slip", "slips"]}
            columns={[
              { key: "customer", header: "Customer", value: (s) => s.customer_name, mobile: "title" },
              { key: "registration", header: "Vehicle", value: (s) => s.registration, className: "mono", mobile: "subtitle" },
              { key: "slip_no", header: "Slip", value: (s) => s.slip_no || "" },
              { key: "litres", header: "Quantity", value: (s) => Number(s.litres), render: (s) => `${qty(s.litres, s.unit)} ${s.product_name}` },
              { key: "amount", header: "Amount", type: "money", exact: true, value: (s) => Number(s.amount), total: "sum" },
              { key: "over", header: "", value: (s) => (s.over_limit ? "Over a limit" : ""), render: (s) => (s.over_limit ? <Badge tone="warning" label="Over a limit" /> : null) },
              { key: "document_no", header: "Bill", value: (s) => s.document_no, className: "mono" },
            ]} />
        </SectionCard>
      )}
      <SectionCard icon="wallet" title="Money handed in">
        <dl className="fuel-facts">
          {close.takings.map((t) => <FactRow key={t.seq} label={`${methodName(t)}${t.reference ? ` · ${t.reference}` : ""}`} value={biz.exact(t.amount)} />)}
          <FactRow label="Cash counted" value={biz.exact(close.cash)} />
          <FactRow label="Cash on the walk-in bill" value={biz.exact(close.cash_paid)} />
        </dl>
        {close.note && <p className="fuel-note">{close.note}</p>}
      </SectionCard>
      {close.bills.length > 0 && (
        <SectionCard flush icon="receipt" title="Fuel bills" description="Posted through the sales, exact to the paisa with no round-off; the walk-in bill carries any short as due.">
          <DataGrid variant="compact" id="fuel-shift-bills" caption="Fuel bills" rows={close.bills} rowKey={(d) => d.id} currency={biz.symbol} rowNoun={["bill", "bills"]}
            onRowClick={seesBills ? (d) => setBillId(d.id) : undefined}
            columns={[
              { key: "document_no", header: "Bill", value: (d) => d.document_no, className: "mono", mobile: "title" },
              { key: "contact", header: "To", value: (d) => d.contact_name || "Walk-in buyers", mobile: "subtitle" },
              { key: "total", header: "Total", type: "money", exact: true, value: (d) => Number(d.total) },
              { key: "paid", header: "Paid", type: "money", exact: true, value: (d) => Number(d.paid) },
              { key: "due", header: "Due", type: "money", exact: true, value: (d) => Number(d.due) },
            ]} />
        </SectionCard>
      )}
      {billId && <DocumentDetail documentId={billId} onClose={() => setBillId(null)} onChanged={() => {}} />}
    </>
  );
}

const FactRow = ({ label, value }) => <><dt>{label}</dt><dd className="mono">{value}</dd></>;

function ReadingsTable({ close }) {
  return (
    <div className="fuel-table-wrap">
      <table className="fuel-table" aria-label="Readings">
        <thead><tr><th>Nozzle</th><th className="r">Opening</th><th className="r">Closing</th><th className="r">Test pumped back</th><th className="r">Sold</th></tr></thead>
        <tbody>
          {close.readings.map((r) => (
            <tr key={r.nozzle_id}><th scope="row">Nozzle {r.nozzle_no}<small className="muted">{r.product_name}{r.tank_no ? ` · tank ${r.tank_no}` : ""}</small></th>
              <td className="r mono">{reading(r.opening)}</td><td className="r mono">{reading(r.closing)}</td><td className="r mono">{qty(r.test, r.unit)}</td><td className="r mono">{qty(r.litres, r.unit)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Closes reopened by a manager: when, by whom and why, with what they had said.
function History({ biz, shift }) {
  return (
    <SectionCard icon="history" title="Reopened" description="Each earlier close, credited when a manager reopened the shift.">
      <ul className="fuel-history">
        {shift.history.map((h) => (
          <li key={h.id}>
            <strong>Close {h.seq}</strong> · {atWords(h.closed_at, biz)}{h.closed_by_name ? ` by ${h.closed_by_name}` : ""}
            {shift.money && h.expected !== null && <> · expected {biz.exact(h.expected)} · <SettlementBadge biz={biz} difference={h.difference} /></>}
            <br /><span className="small">Reopened {atWords(h.reopened_at, biz)}{h.reopened_by_name ? ` by ${h.reopened_by_name}` : ""}: {h.reopen_reason}</span>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
