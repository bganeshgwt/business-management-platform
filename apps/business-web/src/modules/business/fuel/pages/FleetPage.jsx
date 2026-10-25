import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { ActiveBadge, Badge, BusinessHeader, Field, FormError } from "../../core/pages/ui";
import { businessToday, useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { FLEET_CARD_NOTE, atWords, monthWords, qty } from "./fuel";
import "../styles/fuel.css";

// Fleet statements: the station's credit customers with vehicles — transport
// companies, schools, contractors. Each is a customer of the business with
// their credit days and limit; each vehicle by registration with the fuel it
// takes on credit and the most it takes in one fill. The month's fills come
// from the shifts' credit slips; a customer's statement lists them vehicle by
// vehicle with the account's bills, payments and balance.

export default function FleetPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const today = businessToday(biz.business.timezone);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [fleet, setFleet] = useState(null);
  const [vehicles, setVehicles] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState(null);
  const [showOff, setShowOff] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([businessRead(biz.id, "fuel/fleet", { month }, controller.signal), businessRead(biz.id, "fuel/vehicles", { all: "true" }, controller.signal)])
      .then(([f, v]) => { setFleet(f); setVehicles(v); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, month, version]);
  const reload = (message) => { setDialog(null); if (message) toast.success(message); setVersion((n) => n + 1); };
  const canEdit = biz.can("fuel.edit") && biz.can("contacts.view");
  const shown = useMemo(() => (vehicles || []).filter((v) => showOff || v.active), [vehicles, showOff]);

  return (
    <div className="stack">
      <BusinessHeader icon="truck" title="Fleet statements"
        description={`Customers who fill their vehicles on credit, by the slip the driver signs. Their credit days and limit are kept with the customer. ${FLEET_CARD_NOTE}`}
        primary={canEdit && <button type="button" className="button" onClick={() => setDialog({ kind: "vehicle" })}><Icon name="plus" size={16} /> Add a vehicle</button>} />
      <div className="fuel-toolbar">
        <label className="field fuel-outlet"><span>Month</span><input type="month" value={month} max={today.slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label>
      </div>
      <ErrorMessage message={error} />
      <SectionCard flush icon="users" title={`Fleet customers · ${monthWords(month)}`}>
        <DataGrid variant="compact" id="fuel-fleet" caption="Fleet customers" rows={fleet?.items || []} loading={!fleet && !error} rowKey={(c) => c.id} currency={biz.symbol}
          rowNoun={["customer", "customers"]} onRowClick={(c) => navigate(biz.path(`fuel-fleet/${c.id}?month=${month}`))}
          rowClassName={(c) => (c.over_limit ? "dg-tone-danger" : !c.active ? "dg-tone-muted" : "")}
          exportName={biz.can("fuel.export") ? `${biz.business.code}-fleet-${month}` : undefined}
          columns={[
            { key: "name", header: "Customer", value: (c) => `${c.name} ${c.phone || ""}`, mobile: "title", pin: true,
              render: (c) => <span className="bz-two-line"><span>{c.name}</span>{c.phone && <small className="muted">{c.phone}</small>}</span> },
            { key: "vehicles", header: "Vehicles", type: "number", value: (c) => c.vehicles },
            { key: "fills", header: "Fills", type: "number", value: (c) => c.fills, total: "sum" },
            { key: "litres", header: "Quantity", value: (c) => (c.litres || []).map((l) => `${l.product} ${qty(l.litres, l.unit)}`).join(" · "), mobile: "subtitle" },
            { key: "amount", header: "Filled", type: "money", exact: true, value: (c) => Number(c.amount), total: "sum" },
            { key: "balance", header: "Owes now", type: "money", exact: true, value: (c) => Number(c.balance), total: "sum", mobile: "show" },
            { key: "limit", header: "Credit limit", type: "money", exact: true, value: (c) => (c.credit_limit === null ? null : Number(c.credit_limit)),
              render: (c) => (c.credit_limit === null ? "—" : <span className="bz-two-line"><span>{biz.exact(c.credit_limit)}</span>{c.over_limit && <Badge tone="danger" label="Over the limit" />}</span>) },
            { key: "days", header: "Credit days", value: (c) => (c.credit_days === null ? "" : Number(c.credit_days)), defaultHidden: true },
          ]}
          empty="No fleet customers yet" emptyHint="Add a customer's vehicles to fill them on credit." emptyIcon="truck" />
      </SectionCard>
      <SectionCard flush icon="truck" title="Vehicles" description="A vehicle keeps its customer and its registration; switch it off to stop filling it on credit.">
        <DataGrid variant="compact" id="fuel-vehicles" caption="Fleet vehicles" rows={shown} loading={!vehicles && !error} rowKey={(v) => v.id} rowNoun={["vehicle", "vehicles"]}
          rowClassName={(v) => (v.active ? "" : "dg-tone-muted")}
          toolbar={<label className="checkbox bz-check"><input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} /> Show vehicles switched off</label>}
          columns={[
            { key: "registration", header: "Vehicle", value: (v) => `${v.registration} ${v.description || ""}`, mobile: "title", pin: true,
              render: (v) => <span className="bz-two-line"><strong className="mono">{v.registration}</strong>{v.description && <small className="muted">{v.description}</small>}</span> },
            { key: "customer", header: "Customer", value: (v) => v.customer_name, mobile: "subtitle" },
            { key: "fuel", header: "Takes on credit", value: (v) => v.product_name || "Any fuel" },
            { key: "limit", header: "Most in a fill", value: (v) => (v.fill_limit === null ? "" : Number(v.fill_limit)), render: (v) => (v.fill_limit === null ? "No limit" : qty(v.fill_limit, "")) },
            { key: "last", header: "Last fill", type: "datetime", value: (v) => v.last_fill_at || "", render: (v) => (v.last_fill_at ? atWords(v.last_fill_at, biz) : "—") },
            { key: "active", header: "In use", value: (v) => (v.active ? "Yes" : "No"), render: (v) => <ActiveBadge active={v.active} /> },
            biz.can("fuel.edit") && { key: "actions", header: "", label: "Actions", type: "actions",
              render: (v) => <button type="button" className="chip-button" onClick={() => setDialog({ kind: "vehicle", vehicle: v })}>Change</button> },
          ].filter(Boolean)}
          empty="No vehicles yet" emptyHint="Each vehicle a customer fills on credit, by its registration." emptyIcon="truck" />
      </SectionCard>
      {dialog?.kind === "vehicle" && <VehicleDialog biz={biz} vehicle={dialog.vehicle || null} onClose={() => setDialog(null)}
        onSaved={(v) => reload(dialog.vehicle ? `${v.registration} saved.` : `${v.registration} added for ${v.customer_name}.`)} />}
    </div>
  );
}

// A fleet vehicle added (its customer and registration, which it keeps) or changed (its fuel, fill limit, in use).
function VehicleDialog({ biz, vehicle, onClose, onSaved }) {
  const { options, error } = useOptions(vehicle ? [] : ["contacts?kind=customer&active=true"]);
  const customers = options?.["contacts?kind=customer&active=true"] || [];
  const [fuels, setFuels] = useState([]);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "fuel/setup", undefined, controller.signal).then((s) => setFuels(s.products.filter((p) => p.active))).catch(() => setFuels([]));
    return () => controller.abort();
  }, [biz.id]);
  const [form, setForm] = useState(() => ({ contactId: "", registration: vehicle?.registration || "", description: vehicle?.description || "",
    productId: vehicle?.product_id ? String(vehicle.product_id) : "", fillLimit: vehicle?.fill_limit === null || vehicle?.fill_limit === undefined ? "" : String(Number(vehicle.fill_limit)),
    active: vehicle ? vehicle.active : true }));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const rules = { description: form.description.trim() || null, productId: form.productId || null, fillLimit: form.fillLimit.trim() || null };
  const submit = () => (vehicle
    ? businessWrite(biz.id, `fuel/vehicles/${vehicle.id}`, { ...rules, active: form.active }, "patch")
    : businessWrite(biz.id, "fuel/vehicles", { contactId: form.contactId, registration: form.registration.trim(), ...rules }));
  return (
    <FormDialog title={vehicle ? `Change ${vehicle.registration}` : "Add a vehicle"} icon="truck" width={600} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      submitLabel={vehicle ? "Save" : "Add the vehicle"} description={vehicle ? `${vehicle.customer_name}'s vehicle.` : "Its customer's credit days and limit are kept with the customer (Customers & fleets)."}>
      <FormError message={error} />
      {!vehicle && (
        <>
          <Field label="Customer" wide>
            <select required value={form.contactId} onChange={set("contactId")}>
              <option value="">Choose the customer</option>
              {customers.map((c) => <option key={c.id} value={String(c.id)}>{c.name}{c.phone ? ` · ${c.phone}` : ""}</option>)}
            </select>
          </Field>
          <Field label="Registration number"><input required maxLength={15} className="mono" value={form.registration} onChange={set("registration")} placeholder="TS09UB4455" /></Field>
        </>
      )}
      <Field label="Description (optional)"><input maxLength={150} value={form.description} onChange={set("description")} placeholder="e.g. Tata 1613, driver's name" /></Field>
      <Field label="Fuel it takes on credit">
        <select value={form.productId} onChange={set("productId")}>
          <option value="">Any fuel</option>
          {fuels.map((p) => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
        </select>
      </Field>
      <Field label="Most it takes in one fill (optional)" hint="A fill over it is allowed by a manager at the shift's close.">
        <input inputMode="decimal" className="mono" value={form.fillLimit} onChange={set("fillLimit")} />
      </Field>
      {vehicle && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={set("active")} /> In use (untick to stop filling it on credit)</label>}
    </FormDialog>
  );
}
