import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import { printTaxInvoice } from "../../core/pages/invoice";
import { OccupantFields, VisaTypes } from "./LodgingDialogs";
import { ROOM_STATUS, STAGES, blankGuest, dateWords, guestBody, partyWords } from "./lodging";
import "../styles/lodging.css";

// One group booking: its rooms (each a stay of its own), the rooming list that
// names each reserved room's guest, the rooms checked in together (each with
// its occupants) and checked out together, and the group's folio with the
// charges routed to it from every room, billed to the organiser or company
// once every room has left. A room opens as its own stay.

const PAY_KINDS = ["cash", "upi", "card", "bank"];

export default function GroupPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const { groupId } = useParams();
  const [group, setGroup] = useState(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `lodging/groups/${groupId}`, undefined, controller.signal).then((g) => { setGroup(g); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, groupId, version]);
  const refresh = (message) => { setDialog(null); if (message) toast.success(message); setVersion((n) => n + 1); };
  if (!group) return <div className="stack"><BusinessHeader icon="users" title="Group booking" /><ErrorMessage message={error} />{!error && <Loading />}</div>;

  const can = (p) => biz.can(p);
  const money = group.money !== false;
  const reserved = group.stays.filter((s) => s.status === "reserved");
  const inHouse = group.stays.filter((s) => s.status === "in_house");
  const arriving = reserved.filter((s) => s.arriving_today);
  const billable = group.open_rooms === 0 && !group.document_id && Number(group.folio?.unbilled || 0) > 0;
  const printBill = () => businessRead(biz.id, `documents/${group.bill.id}`).then((doc) => printTaxInvoice(doc, biz)).catch((err) => toast.error(getErrorMessage(err)));
  return (
    <div className="stack">
      <BusinessHeader icon="users" title={`Group ${group.group_no}`}
        description={`${group.name} · billed to ${group.contact_name} · ${dateWords(group.arrival)} to ${dateWords(group.departure)}${biz.locations.length > 1 ? ` · ${group.location_name}` : ""}`}
        secondary={(
          <>
            <Link className="button button-secondary" to={biz.path("lodging-reservations")}><Icon name="arrow-left" size={15} /> Reservations</Link>
            {money && group.bill && <button type="button" className="button button-secondary" onClick={printBill}><Icon name="print" size={15} /> Bill</button>}
          </>
        )} />
      <ErrorMessage message={error} />
      <div className="stat-grid">
        <StatTile icon="home" label="Rooms" value={String(group.rooms)} note={`${group.open_rooms} reserved or in the house`} />
        {money && <StatTile icon="money" tone="primary" label="Group's folio" money={Number(group.folio.total)} note={`${biz.exact(group.folio.unbilled)} not billed yet`} />}
        {money && <StatTile icon="receipt" tone={group.bill && Number(group.bill.due) > 0 ? "warning" : "neutral"} label="Bill" value={group.bill ? group.bill.document_no : "Not billed"}
          note={group.bill ? `${biz.exact(group.bill.total)} · due ${biz.exact(Math.max(0, Number(group.bill.due)))}` : "once every room has left"} />}
      </div>
      {can("lodging.create") && (reserved.length > 0 || inHouse.length > 0 || billable) && (
        <SectionCard icon="check" title="Next step">
          <div className="form-actions bz-start">
            {reserved.length > 0 && <button type="button" className="button button-secondary" onClick={() => setDialog("rooming")}><Icon name="users" size={15} /> Rooming list</button>}
            {arriving.length > 0 && <button type="button" className="button" onClick={() => setDialog("check-in")}><Icon name="check" size={15} /> Check in together</button>}
            {inHouse.length > 0 && can("sales.create") && <button type="button" className="button" onClick={() => setDialog("check-out")}><Icon name="check" size={15} /> Check out together</button>}
            {billable && can("sales.create") && <button type="button" className="button" onClick={() => setDialog("bill")}><Icon name="receipt" size={15} /> Bill the group's folio</button>}
          </div>
        </SectionCard>
      )}
      <SectionCard flush icon="home" title="Rooms of the group">
        <DataGrid variant="compact" id="lodging-group-stays" caption="Rooms of the group" rows={group.stays} rowKey={(s) => s.id} rowNoun={["room", "rooms"]}
          onRowClick={(s) => navigate(biz.path(`lodging-stays/${s.id}`))} columns={[
            { key: "stay_no", header: "Stay", value: (s) => s.stay_no, className: "mono", mobile: "title", pin: true },
            { key: "guest", header: "Guest", value: (s) => s.guest_name, mobile: "show" },
            { key: "room", header: "Room", value: (s) => `${s.room_type} ${s.room_no || ""}`, mobile: "subtitle",
              render: (s) => <span className="bz-two-line"><span>{s.room_no ? `Room ${s.room_no}` : "No room yet"}</span><small className="muted">{s.room_type} · {partyWords(s.adults, s.children)}</small></span> },
            { key: "dates", header: "Dates", value: (s) => s.arrival, render: (s) => `${dateWords(s.arrival)} to ${dateWords(s.departure)}` },
            { key: "stage", header: "Stage", value: (s) => STAGES[s.stage]?.label || s.stage, render: (s) => <Badge tone={STAGES[s.stage]?.tone} label={STAGES[s.stage]?.label || s.stage} /> },
          ]} />
      </SectionCard>
      {money && (
        <SectionCard flush icon="receipt" title="The group's folio" description="The charges the group routes to it from every room, billed to the organiser or company with its own GST invoice once every room has left.">
          <DataGrid variant="compact" id="lodging-group-folio" caption="The group's folio" rows={group.charges} rowKey={(x) => x.id} currency={biz.symbol} rowNoun={["charge", "charges"]}
            empty="Nothing on the group's folio yet" emptyHint="Room nights are posted by the night audit." emptyIcon="receipt" columns={[
              { key: "label", header: "Charge", value: (x) => x.label, mobile: "title", pin: true },
              { key: "stay_no", header: "Stay", value: (x) => x.stay_no, className: "mono" },
              { key: "net", header: "Value", type: "money", exact: true, value: (x) => Number(x.net) },
              { key: "tax_rate", header: "GST", value: (x) => `${Number(x.tax_rate)}%`, align: "right" },
              { key: "total", header: "With GST", type: "money", exact: true, value: (x) => Number(x.net) + Number(x.tax), total: "sum" },
              { key: "billed", header: "Billed", value: (x) => (x.line_id ? "Billed" : "Not yet"), mobile: "show" },
            ]} />
        </SectionCard>
      )}
      {dialog === "rooming" && <RoomingDialog group={group} stays={reserved} onClose={() => setDialog(null)} onSaved={() => refresh("Rooming list saved.")} />}
      {dialog === "check-in" && <GroupCheckInDialog group={group} stays={arriving} onClose={() => setDialog(null)} onSaved={() => refresh("Checked in.")} />}
      {dialog === "check-out" && <GroupCheckOutDialog group={group} stays={inHouse} onClose={() => setDialog(null)} onSaved={() => refresh("Checked out.")} />}
      {dialog === "bill" && <GroupBillDialog group={group} onClose={() => setDialog(null)} onSaved={(g) => refresh(`The group's folio is billed (${g.document_no}).`)} />}
    </div>
  );
}

// The rooming list: each reserved room's guest, typed (a new guest is made from the name).
function RoomingDialog({ group, stays, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [names, setNames] = useState(() => Object.fromEntries(stays.map((s) => [s.id, { name: "", phone: "" }])));
  const change = (id, key) => (e) => setNames((all) => ({ ...all, [id]: { ...all[id], [key]: e.target.value } }));
  return (
    <FormDialog title={`Rooming list of ${group.group_no}`} icon="users" width={720} onClose={onClose} onSaved={onSaved} submitLabel="Save the rooming list"
      description="Name each room's guest; the rooms left empty keep the guest they have."
      onSubmit={() => {
        const given = stays.filter((s) => names[s.id].name.trim());
        if (!given.length) throw new Error("Name the guest of at least one room");
        return businessWrite(biz.id, `lodging/groups/${group.id}/rooming`, { stays: given.map((s) => ({ stayId: s.id, guest: { name: names[s.id].name.trim(), phone: names[s.id].phone.trim() || undefined } })) }, "patch");
      }}>
      {stays.map((s) => (
        <fieldset key={s.id} className="field-wide ldg-fieldset" aria-label={`Guest of ${s.stay_no}`}>
          <legend>{s.stay_no} · {s.room_no ? `room ${s.room_no}` : s.room_type} · now {s.guest_name}</legend>
          <Field label="Guest's name"><input maxLength={150} value={names[s.id].name} onChange={change(s.id, "name")} /></Field>
          <Field label="Phone (optional)"><input inputMode="tel" maxLength={30} value={names[s.id].phone} onChange={change(s.id, "phone")} /></Field>
        </fieldset>
      ))}
    </FormDialog>
  );
}

// The rooms arriving checked in together: each with its room (vacant and clean) and every occupant.
function GroupCheckInDialog({ group, stays, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [requestKey] = useState(newKey);
  const [rooms, setRooms] = useState(null);
  const [entries, setEntries] = useState(() => stays.map((s) => ({ stayId: s.id, on: true, roomId: s.room_id ? String(s.room_id) : "",
    guests: [...Array.from({ length: Number(s.adults) }, (_, i) => blankGuest(false, i === 0 ? { fullName: s.guest_name === group.contact_name ? "" : s.guest_name, phone: s.guest_phone || "" } : {})),
      ...Array.from({ length: Number(s.children) }, () => blankGuest(true))] })));
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "lodging/setup", undefined, controller.signal).then((s) => setRooms(s.rooms)).catch(() => setRooms([]));
    return () => controller.abort();
  }, [biz.id]);
  const edit = (index, next) => setEntries((all) => all.map((e, i) => (i === index ? { ...e, ...next } : e)));
  return (
    <FormDialog title={`Check in ${group.group_no}`} icon="check" width={860} onClose={onClose} onSaved={onSaved} submitLabel="Check in together"
      description="Every occupant of each room, as at a check-in: the police register and Form-III ask for each. Of an Aadhaar card, type only the last four digits."
      onSubmit={() => businessWrite(biz.id, `lodging/groups/${group.id}/check-in`, { requestKey,
        stays: entries.filter((e) => e.on).map((e) => ({ stayId: e.stayId, roomId: e.roomId || undefined, guests: e.guests.map(guestBody) })) })}>
      <VisaTypes />
      {stays.map((s, index) => {
        const entry = entries[index];
        const choices = (rooms || []).filter((r) => r.active && Number(r.room_type_id) === Number(s.room_type_id) && Number(r.location_id) === Number(s.location_id)
          && (r.status === "vacant_clean" || String(r.id) === entry.roomId));
        return (
          <fieldset key={s.id} className="field-wide ldg-fieldset" aria-label={`Check in ${s.stay_no}`}>
            <legend>{s.stay_no} · {s.room_type} · {partyWords(s.adults, s.children)}</legend>
            <label className="checkbox bz-check field-wide"><input type="checkbox" checked={entry.on} onChange={(e) => edit(index, { on: e.target.checked })} /> Check this room in now</label>
            {entry.on && (
              <>
                <Field label="Room"><select required value={entry.roomId} onChange={(e) => edit(index, { roomId: e.target.value })}>
                  <option value="">Choose the room…</option>
                  {choices.map((r) => <option key={r.id} value={r.id}>{r.room_no} · {ROOM_STATUS[r.status].label.toLowerCase()}</option>)}</select></Field>
                {entry.guests.map((g, i) => <OccupantFields key={i} index={i} guest={g} today={today} onChange={(next) => edit(index, { guests: entry.guests.map((x, j) => (j === i ? next : x)) })} />)}
              </>
            )}
          </fieldset>
        );
      })}
    </FormDialog>
  );
}

// The rooms in the house checked out together: each room's own bill (its own folio), and the group's folio billed once none is left.
function GroupCheckOutDialog({ group, stays, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const [chosen, setChosen] = useState(() => stays.map((s) => s.id));
  const toggle = (id) => setChosen((all) => (all.includes(id) ? all.filter((x) => x !== id) : [...all, id]));
  return (
    <FormDialog title={`Check out ${group.group_no}`} icon="check" width={620} onClose={onClose} onSaved={onSaved} submitLabel="Check out together"
      description="Each room's own charges are billed to its guest (a manager lets a bill stay on the guest's dues); the group's folio is billed to the organiser or company once every room has left."
      onSubmit={() => {
        if (!chosen.length) throw new Error("Choose the rooms leaving");
        return businessWrite(biz.id, `lodging/groups/${group.id}/check-out`, { requestKey, stays: chosen.map((stayId) => ({ stayId })) });
      }}>
      {stays.map((s) => (
        <label key={s.id} className="checkbox bz-check field-wide"><input type="checkbox" checked={chosen.includes(s.id)} onChange={() => toggle(s.id)} /> {s.stay_no} · room {s.room_no} · {s.guest_name}</label>
      ))}
    </FormDialog>
  );
}

// The group's folio billed to the organiser or company, with what is paid now.
function GroupBillDialog({ group, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ amount: "", method: "cash", reference: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const canPay = biz.can("sales.edit");
  return (
    <FormDialog title={`Bill ${group.group_no}'s folio`} icon="receipt" width={560} onClose={onClose} onSaved={onSaved} submitLabel="Post the bill"
      description={`${biz.exact(group.folio.unbilled)} with GST, billed to ${group.contact_name}, paid first by what is left of the rooms' advances and deposits; what is not paid stays on their dues.`}
      onSubmit={() => businessWrite(biz.id, `lodging/groups/${group.id}/bill`, { requestKey,
        ...(canPay && Number(form.amount) > 0 ? { payment: { amount: form.amount, ...methods.body(form.method, PAY_KINDS), reference: form.reference.trim() || undefined } } : {}) })}>
      {canPay && (
        <>
          <Field label="Paid now (optional)"><input type="number" min="0" step="0.01" value={form.amount} onChange={set("amount")} /></Field>
          <Field label="Paid by"><select value={methods.resolve(form.method, PAY_KINDS)} onChange={set("method")}>{methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
          <Field label="Reference (optional)" wide><input maxLength={100} value={form.reference} onChange={set("reference")} /></Field>
        </>
      )}
    </FormDialog>
  );
}
