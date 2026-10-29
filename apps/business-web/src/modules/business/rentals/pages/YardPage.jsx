import { useEffect, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness } from "../../core/pages/hooks";
import { PAPERS, addHours, atWords, nowInput } from "./rentals";
import "../styles/rentals.css";

// Yard & fleet: where each unit and each pool's pieces are kept, the
// vehicles' papers (each date, red once it has run out, amber within the
// shop's warning days) and the service schedules (due or not), maintenance
// booked ahead (it holds a unit as a booking does) and the moves between
// locations, each recorded with its date. The server checks every move and
// every maintenance booked against what is booked.

const STATE_TONE = { lapsed: "danger", urgent: "warning", soon: "info", ok: "success" };
const STATE_WORDS = (p) => (p.state === "lapsed" ? "run out" : p.daysLeft === 0 ? "runs out today" : `${p.daysLeft} ${p.daysLeft === 1 ? "day" : "days"} left`);

export default function YardPage() {
  const biz = useOpenBusiness();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState(null);
  const canMove = biz.can("rentals.edit");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "rentals/yard", undefined, controller.signal).then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);
  const reload = (message) => { setDialog(null); if (message) toast.success(message); setVersion((n) => n + 1); };
  const cancelDowntime = (d) => businessWrite(biz.id, `rentals/downtime/${d.id}/cancel`, {}).then(() => reload(`Maintenance of ${d.unit_label} cancelled.`))
    .catch((err) => toast.error(getErrorMessage(err)));
  if (!data) return <div className="stack"><BusinessHeader icon="truck" title="Yard & fleet" /><ErrorMessage message={error} />{!error && <Loading />}</div>;
  const many = data.locations.length > 1;
  return (
    <div className="stack">
      <BusinessHeader icon="truck" title="Yard & fleet"
        description="Where each unit and pool is kept, the vehicles' papers and services, maintenance booked ahead and the moves between locations." />
      <ErrorMessage message={error} />
      <SectionCard flush icon="key" title="Units" description={`Papers are flagged ${data.papersWarnDays} and ${data.papersUrgentDays} days before they run out; a vehicle with one run out ${data.papersLapsed === "refuse" ? "is not handed over" : "is handed over with a warning"}.`}>
        <DataGrid variant="compact" id="rental-yard-units" caption="Units in the yard" rows={data.units} rowKey={(u) => u.id} rowNoun={["unit", "units"]}
          rowClassName={(u) => (Object.values(u.papers).some((p) => p?.state === "lapsed") ? "dg-tone-danger" : u.service?.due ? "dg-tone-warning" : "")}
          columns={[
            { key: "label", header: "Unit", value: (u) => `${u.label} ${u.serial_no || ""}`, mobile: "title", pin: true,
              render: (u) => <span className="bz-two-line"><span>{u.label}</span><small className="muted">{[u.item_name, u.serial_no].filter(Boolean).join(" · ")}</small></span> },
            { key: "location", header: "Kept at", value: (u) => u.location_name, mobile: "subtitle", defaultHidden: !many },
            { key: "status", header: "State", type: "status", value: (u) => u.status, render: (u) => <Badge tone={u.status === "available" ? "success" : "warning"} label={u.status === "available" ? "In service" : "In maintenance"} /> },
            { key: "papers", header: "Papers", value: (u) => PAPERS.filter((p) => u.papers[p.column]).map((p) => p.label).join(", "),
              render: (u) => {
                const kept = PAPERS.filter((p) => u.papers[p.column]);
                return kept.length ? <span className="rnt-papers">{kept.map((p) => <Badge key={p.key} tone={STATE_TONE[u.papers[p.column].state]} label={`${p.label}: ${STATE_WORDS(u.papers[p.column])}`} />)}</span>
                  : <span className="muted">{u.vehicle ? "No dates kept" : "—"}</span>;
              } },
            { key: "service", header: "Service", value: (u) => (u.service ? (u.service.due ? "Due" : "Fine") : ""),
              render: (u) => (!u.service ? <span className="muted">No schedule</span> : (
                <span className="bz-two-line"><Badge tone={u.service.due ? "warning" : "success"} label={u.service.due ? "Due" : "Not due"} />
                  <small className="muted">{u.service.per === "days" ? `due on ${u.service.dueOn}` : `due at ${u.service.dueAt} ${u.service.per === "km" ? "km" : "h"}; reads ${u.service.reading ?? "—"}`}</small></span>)) },
            canMove && { key: "actions", header: "", label: "Actions", type: "actions", render: (u) => (
              <span className="rnt-actions">
                {many && <button type="button" className="chip-button" onClick={() => setDialog({ kind: "move", unit: u })}>Move</button>}
                <button type="button" className="chip-button" onClick={() => setDialog({ kind: "down", unit: u })}>Book maintenance</button>
                <button type="button" className="chip-button" onClick={() => setDialog({ kind: "service", unit: u })}>Service done</button>
              </span>
            ) },
          ].filter(Boolean)}
          empty="No units yet" emptyHint="Units are added on Rental items." emptyIcon="key" />
      </SectionCard>
      <SectionCard flush icon="calendar" title="Maintenance booked" description="Holds the unit as a booking does: it is not booked over that time.">
        <DataGrid variant="compact" id="rental-yard-downtime" caption="Maintenance booked" rows={data.downtime} rowKey={(d) => d.id} rowNoun={["maintenance", "maintenance"]}
          columns={[
            { key: "unit", header: "Unit", value: (d) => d.unit_label, mobile: "title", render: (d) => <span className="bz-two-line"><span>{d.unit_label}</span><small className="muted">{d.item_name}</small></span> },
            { key: "from", header: "From", type: "datetime", value: (d) => d.starts_at, render: (d) => atWords(d.starts_at, biz) },
            { key: "to", header: "Until", type: "datetime", value: (d) => d.ends_at, render: (d) => atWords(d.ends_at, biz) },
            { key: "reason", header: "For", value: (d) => d.reason, mobile: "subtitle" },
            { key: "by", header: "Booked by", value: (d) => d.by_name, defaultHidden: true },
            canMove && { key: "actions", header: "", label: "Actions", type: "actions", render: (d) => <button type="button" className="chip-button" onClick={() => cancelDowntime(d)}>Cancel</button> },
          ].filter(Boolean)}
          empty="No maintenance booked" emptyHint="Book it from a unit above." emptyIcon="calendar" />
      </SectionCard>
      {many && (
        <SectionCard flush icon="box" title="Pools by location">
          <DataGrid variant="compact" id="rental-yard-pools" caption="Pools by location" rows={data.pools} rowKey={(p) => p.id} rowNoun={["pool", "pools"]}
            columns={[
              { key: "name", header: "Item", value: (p) => p.name, mobile: "title", pin: true },
              ...data.locations.map((l) => ({ key: `at${l.id}`, header: l.name, type: "number", value: (p) => p.counts.find((c) => c.location_id === l.id)?.quantity || 0 })),
              { key: "total", header: "In all", type: "number", value: (p) => Number(p.pool_quantity) },
              canMove && { key: "actions", header: "", label: "Actions", type: "actions", render: (p) => <button type="button" className="chip-button" onClick={() => setDialog({ kind: "move", pool: p })}>Move pieces</button> },
            ].filter(Boolean)}
            empty="No pools" emptyIcon="box" />
        </SectionCard>
      )}
      {(many || data.transfers.length > 0) && (
        <SectionCard flush icon="refresh" title="Moves between locations">
          <DataGrid variant="compact" id="rental-yard-transfers" caption="Moves between locations" rows={data.transfers} rowKey={(t) => t.id} rowNoun={["move", "moves"]}
            columns={[
              { key: "at", header: "When", type: "datetime", value: (t) => t.created_at, render: (t) => atWords(t.created_at, biz), mobile: "subtitle" },
              { key: "what", header: "What", value: (t) => (t.unit_label ? `${t.unit_label} (${t.item_name})` : `${t.quantity} × ${t.item_name}`), mobile: "title" },
              { key: "from", header: "From", value: (t) => t.from_name },
              { key: "to", header: "To", value: (t) => t.to_name },
              { key: "note", header: "Note", value: (t) => t.note || "" },
              { key: "by", header: "By", value: (t) => t.by_name },
            ]}
            empty="Nothing moved yet" emptyIcon="transfers" />
        </SectionCard>
      )}
      {dialog?.kind === "move" && <MoveDialog data={data} unit={dialog.unit} pool={dialog.pool} onClose={() => setDialog(null)} onSaved={() => reload("Moved.")} />}
      {dialog?.kind === "down" && <DowntimeDialog unit={dialog.unit} onClose={() => setDialog(null)} onSaved={() => reload(`Maintenance of ${dialog.unit.label} booked.`)} />}
      {dialog?.kind === "service" && <ServiceDialog unit={dialog.unit} onClose={() => setDialog(null)} onSaved={() => reload(`${dialog.unit.label}'s service recorded.`)} />}
    </div>
  );
}

// A unit, or pieces of a pool, moved to another location now.
function MoveDialog({ data, unit, pool, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const from = unit ? data.locations.find((l) => l.id === unit.location_id) : null;
  const [form, setForm] = useState({ fromLocationId: String(pool ? data.locations[0].id : unit.location_id), toLocationId: String(data.locations.find((l) => l.id !== (unit?.location_id || data.locations[0].id))?.id || ""),
    quantity: "", note: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={unit ? `Move ${unit.label}` : `Move ${pool.name}`} icon="refresh" width={560} onClose={onClose} onSaved={onSaved} submitLabel="Move it"
      description={unit ? `Kept at ${from?.name}. A unit booked or out from now on moves once that booking is back.` : "No more than the location keeps beyond what its bookings hold at their busiest."}
      onSubmit={() => businessWrite(biz.id, "rentals/transfers", { requestKey, itemId: unit ? unit.item_id : pool.id, ...(unit ? { unitId: unit.id } : { quantity: form.quantity, fromLocationId: form.fromLocationId }),
        toLocationId: form.toLocationId, note: form.note.trim() || undefined })}>
      {pool && <Field label="From"><select value={form.fromLocationId} onChange={set("fromLocationId")}>{data.locations.map((l) => <option key={l.id} value={l.id}>{l.name} ({pool.counts.find((c) => c.location_id === l.id)?.quantity || 0})</option>)}</select></Field>}
      <Field label="To"><select required value={form.toLocationId} onChange={set("toLocationId")}>{data.locations.filter((l) => String(l.id) !== (pool ? form.fromLocationId : String(unit.location_id))).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
      {pool && <Field label="How many"><input type="number" required min="1" step="1" value={form.quantity} onChange={set("quantity")} /></Field>}
      <Field label="Note (optional)" wide><input maxLength={300} value={form.note} onChange={set("note")} /></Field>
    </FormDialog>
  );
}

// Maintenance booked ahead for a unit, over free time.
function DowntimeDialog({ unit, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState(() => { const start = `${businessToday(biz.business.timezone)}T${nowInput(biz).slice(11, 16)}`; return { startsAt: start, endsAt: addHours(start, 8), reason: "" }; });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`Book maintenance of ${unit.label}`} icon="calendar" width={560} onClose={onClose} onSaved={onSaved} submitLabel="Book it"
      description="The unit is held over that time as by a booking; a booking over it is refused, and it is refused over a booking."
      onSubmit={() => businessWrite(biz.id, `rentals/units/${unit.id}/downtime`, { requestKey, ...form, reason: form.reason.trim() })}>
      <Field label="From" hint="On the shop's clock."><input type="datetime-local" required value={form.startsAt} onChange={set("startsAt")} /></Field>
      <Field label="Until"><input type="datetime-local" required min={form.startsAt} value={form.endsAt} onChange={set("endsAt")} /></Field>
      <Field label="What it is for" wide><input required maxLength={300} value={form.reason} onChange={set("reason")} placeholder="e.g. Alternator overhaul" /></Field>
    </FormDialog>
  );
}

// A service done now, with the meter: the schedule counts again from it.
function ServiceDialog({ unit, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState({ meter: unit.meter_reading === null ? "" : String(Number(unit.meter_reading)), note: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`${unit.label}: service done`} icon="settings" width={520} onClose={onClose} onSaved={onSaved} submitLabel="Record it"
      onSubmit={() => businessWrite(biz.id, `rentals/units/${unit.id}/services`, { ...(unit.meter && form.meter !== "" ? { meter: form.meter } : {}), note: form.note.trim() || undefined })}>
      {unit.meter && <Field label={unit.meter === "km" ? "Odometer (km)" : "Hour meter"}><input type="number" min={unit.meter_reading || 0} step="0.1" value={form.meter} onChange={set("meter")} /></Field>}
      <Field label="What was done (optional)" wide><input maxLength={300} value={form.note} onChange={set("note")} placeholder="e.g. Oil and filter changed" /></Field>
    </FormDialog>
  );
}
