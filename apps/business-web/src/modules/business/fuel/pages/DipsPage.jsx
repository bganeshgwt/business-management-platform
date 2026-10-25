import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness } from "../../core/pages/hooks";
import { OutletPicker } from "./FuelParts";
import { atWords, dayWords, densityText, firstOutlet, qty, zonedInput } from "./fuel";
import "../styles/fuel.css";

// Tanks & dips: each tank of an outlet with the day's dip (the litres it
// holds by its dip chart, the dip and water dip read, the morning density of
// a sample at 15 °C and its temperature), the dip before it, and today its
// stock by the book: the last dip, the loads received since and the meters'
// sales since. One dip a tank a day, typed within the week; a manager
// corrects one, saying why. The dips start each day of the stock register.

export default function DipsPage() {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [outlet, setOutlet] = useState(() => firstOutlet(biz));
  const [date, setDate] = useState(today);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "fuel/dips", { ...(outlet ? { locationId: outlet } : {}), date }, controller.signal)
      .then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, outlet, date, version]);
  const reload = (message) => { setDialog(null); if (message) toast.success(message); setVersion((n) => n + 1); };
  const isToday = date === today;
  const tanks = (data?.tanks || []).filter((t) => t.active || t.dip);
  const missing = tanks.filter((t) => t.active && !t.dip).length;

  return (
    <div className="stack">
      <BusinessHeader icon="layers" title="Tanks & dips"
        description="Each tank's morning dip: the litres it holds by its dip chart, with the water dip and the morning density of a sample at 15 °C. The stock register runs from one morning's dip to the next."
        primary={<Link className="button button-secondary" to={biz.path("fuel-register")}><Icon name="clipboard" size={16} /> Stock register</Link>} />
      <div className="fuel-toolbar">
        <OutletPicker biz={biz} value={outlet} onChange={setOutlet} />
        <label className="field fuel-outlet"><span>Dips of</span><input type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} /></label>
      </div>
      <ErrorMessage message={error} />
      {!data ? (!error && <Loading />) : (
        <SectionCard flush icon="layers" title={isToday ? "Today's dips" : `Dips of ${dayWords(date)}`}
          description={missing ? `${missing} ${missing === 1 ? "tank is" : "tanks are"} still to be dipped` : tanks.length ? "Every tank is dipped" : undefined}>
          <DataGrid variant="compact" id="fuel-dips" caption="Tanks and their dips" rows={tanks} rowKey={(t) => t.id} rowNoun={["tank", "tanks"]}
            rowClassName={(t) => (!t.dip && t.active ? "dg-tone-warning" : "")}
            columns={[
              { key: "tank", header: "Tank", value: (t) => t.tank_no, mobile: "title", pin: true,
                render: (t) => <span className="bz-two-line"><strong>Tank {t.tank_no}</strong><small className="muted">{t.product_name} · holds {qty(t.capacity, t.unit)}</small></span> },
              { key: "dip", header: "Dip", value: (t) => (t.dip ? Number(t.dip.stock) : ""), mobile: "show",
                render: (t) => (t.dip ? (
                  <span className="bz-two-line">
                    <strong className="mono">{qty(t.dip.stock, t.unit)}</strong>
                    <small className="muted">{[t.dip.dip_cm !== null ? `${Number(t.dip.dip_cm)} cm` : null, t.dip.water_cm !== null ? `water ${Number(t.dip.water_cm)} cm` : null,
                      t.dip.density !== null ? densityText(t.dip.density) : null, t.dip.temperature !== null ? `${Number(t.dip.temperature)} °C` : null].filter(Boolean).join(" · ")}</small>
                  </span>
                ) : <Badge tone="warning" label="Not dipped" />) },
              { key: "taken", header: "Taken", value: (t) => t.dip?.taken_at || "",
                render: (t) => (t.dip ? <span className="bz-two-line"><span>{atWords(t.dip.taken_at, biz)}</span><small className="muted">{t.dip.created_by_name}{t.dip.corrected_at ? ` · corrected by ${t.dip.corrected_by_name}: ${t.dip.correction_reason}` : ""}</small></span> : "—") },
              { key: "previous", header: "Dip before", value: (t) => (t.previous ? Number(t.previous.stock) : ""),
                render: (t) => (t.previous ? <span className="bz-two-line"><span className="mono">{qty(t.previous.stock, t.unit)}</span><small className="muted">{dayWords(t.previous.dip_on)}</small></span> : "—") },
              isToday && { key: "book", header: "By the book now", value: (t) => (t.book ? Number(t.book.book) : ""),
                render: (t) => (t.book ? (
                  <span className="bz-two-line">
                    <strong className="mono">{qty(t.book.book, t.unit)}</strong>
                    <small className="muted">since the dip of {dayWords(t.book.from)}: +{qty(t.book.receipts, t.unit)} in, −{qty(t.book.sales, t.unit)} sold{t.book.openShifts ? ` · ${t.book.openShifts} open ${t.book.openShifts === 1 ? "shift" : "shifts"} not counted yet` : ""}</small>
                  </span>
                ) : <span className="muted">No dip yet</span>) },
              { key: "actions", header: "", label: "Actions", type: "actions", render: (t) => (
                <span className="fuel-actions">
                  {!t.dip && t.active && biz.can("fuel.create") && <button type="button" className="chip-button" onClick={() => setDialog({ kind: "take", tank: t })}>Take the dip</button>}
                  {t.dip && biz.can("fuel.approve") && <button type="button" className="chip-button" onClick={() => setDialog({ kind: "correct", tank: t })}>Correct</button>}
                </span>
              ) },
            ].filter(Boolean)}
            empty="No tanks at this outlet" emptyHint="Add the tanks under Settings › Pumps & nozzles." emptyIcon="layers" />
        </SectionCard>
      )}
      {dialog?.kind === "take" && <DipDialog biz={biz} tank={dialog.tank} date={date} today={today} onClose={() => setDialog(null)} onSaved={() => reload(`Tank ${dialog.tank.tank_no} dipped.`)} />}
      {dialog?.kind === "correct" && <CorrectDialog biz={biz} tank={dialog.tank} onClose={() => setDialog(null)} onSaved={() => reload(`Tank ${dialog.tank.tank_no}'s dip corrected.`)} />}
    </div>
  );
}

const textOf = (value) => (value === null || value === undefined ? "" : String(Number(value)));

function DipFields({ form, set, tank }) {
  return (
    <>
      <Field label={`Litres in the tank (by the dip chart)`} hint={`Tank ${tank.tank_no} holds at most ${qty(tank.capacity, tank.unit)}.`}>
        <input required inputMode="decimal" className="mono" value={form.stock} onChange={set("stock")} />
      </Field>
      <Field label="Dip read (cm, optional)"><input inputMode="decimal" className="mono" value={form.dipCm} onChange={set("dipCm")} /></Field>
      <Field label="Water dip (cm, optional)" hint="Water found with water-finding paste."><input inputMode="decimal" className="mono" value={form.waterCm} onChange={set("waterCm")} /></Field>
      <Field label="Density at 15 °C (kg/m³, optional)" hint="Of a sample drawn from a nozzle, by the hydrometer and the table."><input inputMode="decimal" className="mono" value={form.density} onChange={set("density")} /></Field>
      <Field label="Temperature (°C, optional)"><input inputMode="decimal" className="mono" value={form.temperature} onChange={set("temperature")} /></Field>
      <Field label="Note (optional)" wide><input maxLength={300} value={form.note} onChange={set("note")} /></Field>
    </>
  );
}

// A tank's dip of the day, typed from the dip rod and the dip chart.
function DipDialog({ biz, tank, date, today, onClose, onSaved }) {
  const [key] = useState(newKey);
  const [form, setForm] = useState({ stock: "", dipCm: "", waterCm: "", density: "", temperature: "", note: "", takenAt: date === today ? "" : `${date}T06:00` });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const submit = () => businessWrite(biz.id, "fuel/dips", { requestKey: key, tankId: tank.id, dipOn: date, stock: form.stock.trim(),
    ...Object.fromEntries(["dipCm", "waterCm", "density", "temperature", "note"].filter((k) => form[k].trim()).map((k) => [k, form[k].trim()])),
    ...(form.takenAt ? { takenAt: form.takenAt } : {}) });
  return (
    <FormDialog title={`Dip tank ${tank.tank_no}`} icon="layers" width={620} onClose={onClose} onSaved={onSaved} onSubmit={submit} submitLabel="Save the dip"
      description={`${tank.product_name} · the dip of ${dayWords(date)}. Dip before the first shift of the morning, with the nozzles idle.`}>
      <DipFields form={form} set={set} tank={tank} />
      <Field label={date === today ? "Taken at (optional)" : "Taken at"} hint={date === today ? "Left empty: now." : "A dip of an earlier day needs the time it was taken."}>
        <input type="datetime-local" required={date !== today} value={form.takenAt} onChange={set("takenAt")} />
      </Field>
    </FormDialog>
  );
}

// A manager's correction of a dip, saying why: the register reads it again.
function CorrectDialog({ biz, tank, onClose, onSaved }) {
  const dip = tank.dip;
  const [form, setForm] = useState({ stock: textOf(dip.stock), dipCm: textOf(dip.dip_cm), waterCm: textOf(dip.water_cm), density: textOf(dip.density),
    temperature: textOf(dip.temperature), note: dip.note || "", takenAt: zonedInput(dip.taken_at, biz), reason: "" });
  const [typedAt] = useState(() => zonedInput(dip.taken_at, biz));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const optional = (k) => (form[k].trim() ? form[k].trim() : null);
  const submit = () => businessWrite(biz.id, `fuel/dips/${dip.id}`, { stock: form.stock.trim(), dipCm: optional("dipCm"), waterCm: optional("waterCm"), density: optional("density"),
    temperature: optional("temperature"), note: optional("note"), ...(form.takenAt !== typedAt ? { takenAt: form.takenAt } : {}), reason: form.reason.trim() }, "patch");
  return (
    <FormDialog title={`Correct tank ${tank.tank_no}'s dip`} icon="edit" width={620} onClose={onClose} onSaved={onSaved} onSubmit={submit} submitLabel="Correct the dip"
      description={`The dip of ${dayWords(dip.dip_on)}, taken by ${dip.created_by_name}. The activity log keeps what it said before.`}>
      <DipFields form={form} set={set} tank={tank} />
      <Field label="Taken at"><input type="datetime-local" required value={form.takenAt} onChange={set("takenAt")} /></Field>
      <Field label="Why the dip is corrected" wide><input required maxLength={300} value={form.reason} onChange={set("reason")} placeholder="e.g. read off the wrong line of the dip chart" /></Field>
    </FormDialog>
  );
}
