import { useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { escapeHtml, printDocument } from "../../../../services/print";
import { toast } from "../../../../services/toast";
import { confirmAction } from "../../../../services/confirm";
import FormDialog from "../../core/pages/FormDialog";
import { ActiveBadge, BusinessHeader, Field, FormError } from "../../core/pages/ui";
import { useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { Segmented } from "./shared";
import { DAYS } from "./tradeFormat";
import "../styles/field-sales.css";

// Field sales set-up: salespeople, delivery routes, the beats on each route
// (shops visited on one day by one salesperson, in their visit order) and
// which beat each customer is on. Orders and collections pick up the route and
// salesperson from it. With the salesperson app on, a beat's shops show the
// place each has saved (the office may clear one), and a salesperson's
// recorded places can be erased.

const TABS = [
  { value: "beats", label: "Beats" },
  { value: "customers", label: "Customers on beats" },
  { value: "routes", label: "Routes" },
  { value: "salespeople", label: "Salespeople" },
];

export default function RoutesPage() {
  const biz = useOpenBusiness();
  const [tab, setTab] = useState("beats");
  const [notice, setNotice] = useState("");
  const edit = biz.can("sales_orders.edit");
  return (
    <div className="stack">
      <BusinessHeader icon="map-pin" title="Routes & salespeople"
        description="Delivery routes, the beats on them (the shops a salesperson visits on a set day) and which beat each customer is on. Orders and collections take their route and salesperson from the customer's beat." />
      <SuccessMessage message={notice} />
      <Segmented label="Show" value={tab} options={TABS} onChange={(value) => { setTab(value); setNotice(""); }} />
      {tab === "beats" && <Beats edit={edit} onSaved={setNotice} />}
      {tab === "customers" && <CustomerBeats edit={edit} onSaved={setNotice} />}
      {tab === "routes" && <Routes edit={edit} onSaved={setNotice} />}
      {tab === "salespeople" && <Salespeople edit={edit} onSaved={setNotice} />}
    </div>
  );
}

// A salesperson's login, monthly target, what their orders
// were invoiced and what they collected this month; their beat sheet for today.
function Salespeople({ edit, onSaved }) {
  const biz = useOpenBusiness();
  const list = useServerList("salespeople", { gridId: "wholesale-salespeople" });
  const [editing, setEditing] = useState(null);
  const [logins, setLogins] = useState(null);
  useEffect(() => {
    if (!editing || logins || !edit) return;
    businessRead(biz.id, "salesperson-logins").then(setLogins).catch(() => setLogins([]));
  }, [biz.id, editing, logins, edit]);
  const sheet = async (s) => {
    try { printBeatSheet(await businessRead(biz.id, `salespeople/${s.id}/beat-sheet`), biz); } catch (err) { toast.error(getErrorMessage(err)); }
  };
  // The places a salesperson's phone recorded are their personal data: erased on the business's word.
  const erasePlaces = biz.has("salesperson_app") && biz.can("privacy.manage");
  const erase = async (s) => {
    const sure = await confirmAction({
      title: `Erase ${s.name}'s recorded places?`,
      message: <p>Every place their phone recorded (their day&apos;s start and end, each check-in) is blanked for good. Their days and visits stay, with their times, distances from the shops and outcomes.</p>,
      confirmLabel: "Erase their places",
      cancelLabel: "Keep them",
    });
    if (!sure) return;
    try {
      const done = await businessWrite(biz.id, `sales/salespeople/${s.id}/erase-places`, { reason: "Erased on the business's word, from Routes & salespeople" });
      onSaved(`${s.name}'s places erased: ${done.erased.wholesale_visits} check-ins and ${done.erased.wholesale_salesperson_days} days.`);
    } catch (err) { toast.error(getErrorMessage(err)); }
  };
  const columns = useMemo(() => [
    { key: "name", header: "Name", value: (s) => s.name, mobile: "title", pin: true },
    { key: "phone", header: "Phone", value: (s) => s.phone || "", mobile: "subtitle" },
    { key: "login", header: "Login", value: (s) => s.user_name || "", render: (s) => s.user_name || <span className="muted">Not linked</span>, defaultHidden: true },
    { key: "beats", header: "Beats", type: "number", value: (s) => s.beat_count },
    { key: "shops", header: "Shops", type: "number", value: (s) => s.customer_count },
    { key: "orders", header: "Orders this month", type: "number", value: (s) => s.orders_this_month },
    { key: "target", header: "Target", type: "money", value: (s) => (s.monthly_target === null ? null : Number(s.monthly_target)), defaultHidden: true },
    { key: "achieved", header: "Invoiced this month", type: "money", value: (s) => Number(s.invoiced_this_month), total: "sum", mobile: "show",
      render: (s) => (s.monthly_target ? <span className="bz-two-line">{biz.amount(s.invoiced_this_month)}<small className="muted">{Math.round((Number(s.invoiced_this_month) / Number(s.monthly_target)) * 100)}% of {biz.amount(s.monthly_target)}</small></span> : biz.amount(s.invoiced_this_month)) },
    { key: "collected", header: "Collected this month", type: "money", value: (s) => Number(s.collected_this_month), total: "sum", mobile: "show" },
    { key: "active", header: "Status", type: "status", value: (s) => (s.active ? "active" : "inactive"), render: (s) => <ActiveBadge active={s.active} /> },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (s) => (
      <div className="row-actions">
        <button type="button" className="chip-button" onClick={() => sheet(s)}><Icon name="print" size={13} /> Today's beat</button>
        {edit && <button type="button" className="chip-button" onClick={() => setEditing(s)}>Edit</button>}
        {erasePlaces && <button type="button" className="chip-button" onClick={() => erase(s)}>Erase places</button>}
      </div>
    ) },
  ], [edit, biz, erasePlaces]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="users" title="Salespeople" actions={edit && <button type="button" className="button button-sm" onClick={() => setEditing({})}><Icon name="plus" size={15} /> Add salesperson</button>}>
        <DataGrid {...list.gridProps} caption="Salespeople" columns={columns} currency={biz.symbol} rowNoun={["salesperson", "salespeople"]} rowClassName={(s) => (!s.active ? "dg-tone-muted" : "")}
          empty="No salespeople yet" emptyIcon="users" />
      </SectionCard>
      {editing && (
        <SimpleDialog title={editing.id ? `Edit ${editing.name}` : "Add a salesperson"} icon="user-plus"
          record={{ ...editing, userId: editing.user_id ? String(editing.user_id) : "", monthlyTarget: editing.monthly_target ? String(Number(editing.monthly_target)) : "" }}
          fields={[{ name: "name", label: "Name", required: true, max: 150 }, { name: "phone", label: "Phone", max: 30 },
            { name: "userId", label: "Their login (optional)", options: [{ value: "", label: logins ? "Not linked" : "Loading…" },
              ...(logins || []).map((u) => ({ value: String(u.id), label: `${u.name} · ${u.role_name}${u.linked_to && u.linked_to !== editing.name ? ` (linked to ${u.linked_to})` : ""}` }))] },
            { name: "monthlyTarget", label: "Monthly sales target ₹ (optional)", type: "number" }]}
          save={(form) => (editing.id ? businessWrite(biz.id, `salespeople/${editing.id}`, form, "patch") : businessWrite(biz.id, "salespeople", form))}
          onClose={() => setEditing(null)} onSaved={(s) => { setEditing(null); onSaved(`${s.name} saved.`); list.reload(); }} />
      )}
    </>
  );
}

// The shops on a salesperson's beats today: dues, how late, last order.
function printBeatSheet(data, biz) {
  const rows = data.shops.map((s, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(s.name)}${s.address ? `<br><small>${escapeHtml(s.address)}</small>` : ""}</td><td>${escapeHtml(s.phone || "")}</td>
    <td class="r">${s.balance !== undefined ? escapeHtml(biz.exact(s.balance)) : ""}</td><td class="r">${Number(s.overdue) > 0 ? `${escapeHtml(biz.exact(s.overdue))} (${s.most_days_overdue} d)` : ""}</td>
    <td>${s.last_order_at ? `${escapeHtml(dateShort(s.last_order_at))} · ${escapeHtml(biz.amount(s.last_order_total))}` : "—"}${s.open_orders ? ` · ${s.open_orders} open` : ""}</td><td></td><td></td></tr>`).join("");
  printDocument({
    title: `Beat sheet ${data.salesperson.name}`,
    styles: "body{font:12px system-ui;color:#111} h1{font-size:17px;margin:0} table{width:100%;border-collapse:collapse;margin-top:8px} td,th{border:1px solid #bbb;padding:5px;text-align:left;vertical-align:top} th{background:#f3f4f6} .r{text-align:right}",
    body: `<h1>${escapeHtml(biz.settings.display_name || biz.business.name)}</h1>
      <p><strong>Beat sheet</strong> · ${escapeHtml(data.salesperson.name)} · ${escapeHtml(DAYS[data.weekday - 1])} · ${data.shops.length} shops</p>
      <table><thead><tr><th>#</th><th>Shop</th><th>Phone</th><th class="r">Owes</th><th class="r">Overdue</th><th>Last order</th><th>Order taken</th><th>Collected</th></tr></thead><tbody>${rows || "<tr><td colspan=8>No shops on today's beats</td></tr>"}</tbody></table>`,
  });
}

function Routes({ edit, onSaved }) {
  const biz = useOpenBusiness();
  const list = useServerList("routes", { gridId: "wholesale-routes" });
  const [editing, setEditing] = useState(null);
  const columns = useMemo(() => [
    { key: "name", header: "Route", value: (r) => r.name, mobile: "title", pin: true },
    { key: "location", header: "Loads from", value: (r) => r.location_name || "", mobile: "subtitle" },
    { key: "beats", header: "Beats", type: "number", value: (r) => r.beat_count, mobile: "show" },
    { key: "customers", header: "Customers", type: "number", value: (r) => r.customer_count, mobile: "show" },
    { key: "active", header: "Status", type: "status", value: (r) => (r.active ? "active" : "inactive"), render: (r) => <ActiveBadge active={r.active} /> },
    edit && { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => <button type="button" className="chip-button" onClick={() => setEditing(r)}>Edit</button> },
  ].filter(Boolean), [edit]);
  return (
    <>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="map-pin" title="Routes" actions={edit && <button type="button" className="button button-sm" onClick={() => setEditing({})}><Icon name="plus" size={15} /> Add route</button>}>
        <DataGrid {...list.gridProps} caption="Routes" columns={columns} rowNoun={["route", "routes"]} rowClassName={(r) => (!r.active ? "dg-tone-muted" : "")} empty="No routes yet" emptyIcon="map-pin" />
      </SectionCard>
      {editing && (
        <SimpleDialog title={editing.id ? `Edit ${editing.name}` : "Add a route"} icon="map-pin" record={{ ...editing, locationId: editing.location_id ? String(editing.location_id) : "" }}
          fields={[{ name: "name", label: "Route name", required: true, max: 100 },
            { name: "locationId", label: "Van loads from", options: [{ value: "", label: "Any location" }, ...biz.locations.filter((l) => l.active).map((l) => ({ value: String(l.id), label: l.name }))] }]}
          save={(form) => (editing.id ? businessWrite(biz.id, `routes/${editing.id}`, form, "patch") : businessWrite(biz.id, "routes", form))}
          onClose={() => setEditing(null)} onSaved={(r) => { setEditing(null); onSaved(`${r.name} saved.`); list.reload(); }} />
      )}
    </>
  );
}

function Beats({ edit, onSaved }) {
  const biz = useOpenBusiness();
  const list = useServerList("beats", { gridId: "wholesale-beats" });
  const { options, error } = useOptions(["routes?active=true", "salespeople?active=true"]);
  const [editing, setEditing] = useState(null);
  const [ordering, setOrdering] = useState(null);
  const columns = useMemo(() => [
    { key: "name", header: "Beat", value: (b) => b.name, mobile: "title", pin: true },
    { key: "route", header: "Route", value: (b) => b.route_name, mobile: "subtitle", filter: "select" },
    { key: "day", header: "Visit day", value: (b) => (b.visit_day ? DAYS[b.visit_day - 1] : "Any day"), mobile: "show" },
    { key: "salesperson", header: "Salesperson", value: (b) => b.salesperson_name || "", mobile: "show" },
    { key: "customers", header: "Customers", type: "number", value: (b) => b.customer_count },
    { key: "active", header: "Status", type: "status", value: (b) => (b.active ? "active" : "inactive"), render: (b) => <ActiveBadge active={b.active} /> },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (b) => (
      <div className="row-actions">
        {b.customer_count > 0 && <button type="button" className="chip-button" onClick={() => setOrdering(b)}>{edit ? "Visit order" : "Shops"}</button>}
        {edit && <button type="button" className="chip-button" onClick={() => setEditing(b)}>Edit</button>}
      </div>
    ) },
  ], [edit]);
  const routes = options?.["routes?active=true"] || [];
  return (
    <>
      <ErrorMessage message={list.error || error} />
      <SectionCard flush icon="list" title="Beats" actions={edit && <button type="button" className="button button-sm" disabled={!routes.length} title={routes.length ? undefined : "Add a route first"} onClick={() => setEditing({})}><Icon name="plus" size={15} /> Add beat</button>}>
        <DataGrid {...list.gridProps} caption="Beats" columns={columns} rowNoun={["beat", "beats"]} rowClassName={(b) => (!b.active ? "dg-tone-muted" : "")}
          empty="No beats yet" emptyHint="Add a route, then the beats on it." emptyIcon="map-pin" />
      </SectionCard>
      {editing && (
        <SimpleDialog title={editing.id ? `Edit ${editing.name}` : "Add a beat"} icon="map-pin"
          record={{ ...editing, routeId: String(editing.route_id || routes[0]?.id || ""), visitDay: editing.visit_day ? String(editing.visit_day) : "", salespersonId: editing.salesperson_id ? String(editing.salesperson_id) : "" }}
          fields={[{ name: "name", label: "Beat name", required: true, max: 100 },
            { name: "routeId", label: "Route", required: true, options: routes.map((r) => ({ value: String(r.id), label: r.name })) },
            { name: "visitDay", label: "Visit day", options: [{ value: "", label: "Any day" }, ...DAYS.map((d, i) => ({ value: String(i + 1), label: d }))] },
            { name: "salespersonId", label: "Salesperson", options: [{ value: "", label: "None" }, ...(options?.["salespeople?active=true"] || []).map((s) => ({ value: String(s.id), label: s.name }))] }]}
          save={(form) => (editing.id ? businessWrite(biz.id, `beats/${editing.id}`, form, "patch") : businessWrite(biz.id, "beats", form))}
          onClose={() => setEditing(null)} onSaved={(b) => { setEditing(null); onSaved(`${b.name} saved.`); list.reload(); }} />
      )}
      {ordering && <VisitOrder beat={ordering} edit={edit} onClose={() => setOrdering(null)} onSaved={(message) => { setOrdering(null); onSaved(message); }} />}
    </>
  );
}

// A beat's shops in the order they are visited (the salesperson app and the
// printed beat sheet follow it), moved with the arrows; with the app on, the
// place each shop has saved, which the office may clear (it moved, or was
// saved in the wrong spot): the next check-in there may save it again.
function VisitOrder({ beat, edit, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [shops, setShops] = useState(null);
  const [error, setError] = useState("");
  const places = biz.has("salesperson_app");
  const canClear = biz.can("salesperson_app.edit");
  const load = () => businessRead(biz.id, `sales/beats/${beat.id}/shops`).then((r) => setShops(r.shops)).catch((err) => setError(getErrorMessage(err)));
  useEffect(() => {
    load();
  }, [beat.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const move = (index, by) => setShops((list) => {
    const next = [...list];
    const [shop] = next.splice(index, 1);
    next.splice(Math.max(0, Math.min(next.length, index + by)), 0, shop);
    return next;
  });
  const clear = async (shop) => {
    try {
      await businessWrite(biz.id, `sales/places/${shop.id}/clear`, {});
      toast.success(`${shop.name}'s place cleared`);
      load();
    } catch (err) { setError(getErrorMessage(err)); }
  };
  return (
    <FormDialog title={`${beat.name}: visit order`} icon="list" width={620} submitLabel="Save the order" hideSubmit={!edit}
      description="The salesperson visits the shops in this order; the app and the printed beat sheet list them so."
      onSubmit={() => businessWrite(biz.id, `sales/beats/${beat.id}/order`, { contactIds: shops.map((x) => x.id) }, "put")}
      onClose={onClose} onSaved={() => onSaved(`${beat.name}'s visit order saved.`)}>
      <ErrorMessage message={error} />
      {!shops ? <p className="muted field-wide">Reading the beat…</p> : (
        <ol className="bz-visit-order field-wide">
          {shops.map((shop, i) => (
            <li key={shop.id}>
              <span className="bz-visit-order-no">{i + 1}</span>
              <span className="bz-visit-order-name">
                <strong>{shop.name}</strong>
                <small className="muted">{[shop.address, places ? (shop.maps ? `place saved${shop.place_saved_by_name ? ` by ${shop.place_saved_by_name}` : ""}` : "no saved place") : null].filter(Boolean).join(" · ")}</small>
              </span>
              <span className="row-actions">
                {places && shop.maps && <a className="chip-button" href={shop.maps} target="_blank" rel="noopener noreferrer">Map</a>}
                {places && shop.maps && canClear && <button type="button" className="chip-button" onClick={() => clear(shop)}>Clear place</button>}
                {edit && <button type="button" className="chip-button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${shop.name} up`}><Icon name="arrow-up" size={13} /></button>}
                {edit && <button type="button" className="chip-button" onClick={() => move(i, 1)} disabled={i === shops.length - 1} aria-label={`Move ${shop.name} down`}><Icon name="arrow-down" size={13} /></button>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </FormDialog>
  );
}

function CustomerBeats({ edit, onSaved }) {
  const biz = useOpenBusiness();
  const list = useServerList("customer-beats", { gridId: "wholesale-customer-beats" });
  const { options } = useOptions(["beats?active=true"]);
  const [editing, setEditing] = useState(null);
  const columns = useMemo(() => [
    { key: "name", header: "Customer", value: (c) => c.name, mobile: "title", pin: true },
    { key: "phone", header: "Phone", value: (c) => c.phone || "" },
    { key: "route", header: "Route", value: (c) => c.route_name || "", mobile: "subtitle" },
    { key: "beat", header: "Beat", value: (c) => c.beat_name || "", render: (c) => c.beat_name || <span className="muted">Not on a beat</span>, mobile: "show" },
    { key: "day", header: "Visit day", value: (c) => (c.visit_day ? DAYS[c.visit_day - 1] : "") },
    { key: "salesperson", header: "Salesperson", value: (c) => c.salesperson_name || "", mobile: "show" },
    edit && { key: "actions", header: "", label: "Actions", type: "actions", render: (c) => <button type="button" className="chip-button" onClick={() => setEditing(c)}>{c.beat_id ? "Change beat" : "Put on a beat"}</button> },
  ].filter(Boolean), [edit]);
  const beats = options?.["beats?active=true"] || [];
  return (
    <>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="users" title="Customers on beats">
        <DataGrid {...list.gridProps} caption="Customers on beats" columns={columns} rowNoun={["customer", "customers"]}
          exportName={biz.can("sales_orders.export") ? `${biz.business.code}-customer-beats` : undefined}
          rowClassName={(c) => (!c.beat_id ? "dg-tone-muted" : "")} empty="No customers yet" emptyIcon="users" />
      </SectionCard>
      {editing && (
        <SimpleDialog title={`Beat for ${editing.name}`} icon="map-pin" record={{ beatId: editing.beat_id ? String(editing.beat_id) : "" }} submitLabel="Save beat"
          fields={[{ name: "beatId", label: "Beat", options: [{ value: "", label: "Not on a beat" }, ...beats.map((b) => ({ value: String(b.id), label: `${b.route_name} · ${b.name}${b.visit_day ? ` (${DAYS[b.visit_day - 1]})` : ""}` }))] }]}
          save={(form) => businessWrite(biz.id, `customer-beats/${editing.id}`, { beatId: form.beatId || null }, "put")}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onSaved(`${editing.name}'s beat saved.`); list.reload(); }} />
      )}
    </>
  );
}

// A short form: text fields and selects, plus "Active" when editing.
function SimpleDialog({ title, icon, record, fields, save, onClose, onSaved, submitLabel }) {
  const [form, setForm] = useState(() => Object.fromEntries([...fields.map((f) => [f.name, record[f.name] ?? ""]), ["active", record.active ?? true]]));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const editing = Boolean(record.id);
  return (
    <FormDialog title={title} icon={icon} width={520} submitLabel={submitLabel} onClose={onClose} onSaved={onSaved} onSubmit={() => save(form)}>
      <FormError message="" />
      {fields.map((f) => (
        <Field key={f.name} label={f.label} wide>
          {f.options ? (
            <select required={f.required} value={form[f.name]} onChange={set(f.name)}>
              {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : <input required={f.required} maxLength={f.max} type={f.type || "text"} min={f.type === "number" ? "0" : undefined} step={f.type === "number" ? "0.01" : undefined} value={form[f.name]} onChange={set(f.name)} />}
        </Field>
      ))}
      {editing && "active" in record && <label className="checkbox bz-check"><input type="checkbox" checked={form.active} onChange={set("active")} /> Active</label>}
    </FormDialog>
  );
}
