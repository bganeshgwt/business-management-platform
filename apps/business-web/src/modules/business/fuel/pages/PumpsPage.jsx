import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SearchPicker from "../../../../components/SearchPicker";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { ActiveBadge, Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { newKey, useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { OutletPicker } from "./FuelParts";
import { FAMILIES, UNIT_STATES, VAT_NOTE, atWords, dayWords, dueWords, familyWord, firstOutlet, qty, reading, stampingTone } from "./fuel";
import "../styles/fuel.css";

// Pumps & nozzles: a fuel station's set-up. Its fuels, each a goods item of
// the catalogue on the GST nil slab (outside GST; the price includes state
// VAT); the prices in force at each outlet, set together with the time they
// take effect; the tanks with their capacity; the dispensing units with their
// Weights & Measures stamping and their nozzles, each drawing a tank's fuel
// (CNG from none) with its totaliser; a manager's meter change; the stamped
// measures for the nozzle test; the tolerances the stock register checks
// against; and where each outlet's PESO licence stands. Nothing here talks to
// a dispenser or a tank gauge.

export default function PumpsPage() {
  const biz = useOpenBusiness();
  const [outlet, setOutlet] = useState(() => firstOutlet(biz));
  const [data, setData] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([businessRead(biz.id, "fuel/setup", undefined, controller.signal),
      businessRead(biz.id, "fuel/prices", outlet ? { locationId: outlet } : undefined, controller.signal)])
      .then(([s, p]) => { setData(s); setHistory(p.history); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, outlet, version]);
  const done = (message) => { setDialog(null); if (message) toast.success(message); setVersion((n) => n + 1); };
  const here = (row) => !outlet || String(row.location_id) === String(outlet);
  const location = biz.locations.find((l) => String(l.id) === String(outlet)) || biz.locations[0];
  if (!data) return <div className="stack"><BusinessHeader icon="settings" title="Pumps & nozzles" /><ErrorMessage message={error} />{!error && <Loading />}</div>;
  const shown = { tanks: data.tanks.filter(here), dispensers: data.dispensers.filter(here), measures: data.measures.filter(here), prices: data.prices.filter(here),
    peso: data.peso ? data.peso.filter((p) => !outlet || String(p.locationId) === String(outlet)) : null };
  const canCatalog = biz.can("catalog.edit");
  const canSettings = biz.can("settings.edit");
  const products = data.products.filter((p) => p.active);
  const warn = data.settings.stampingWarnDays;

  return (
    <div className="stack">
      <BusinessHeader icon="settings" title="Pumps & nozzles"
        description="The station's fuels and their prices, the tanks, the dispensing units with their stamping and nozzles, the stamped measures and the tolerances. Readings are typed in: nothing here talks to a dispenser or a tank gauge." />
      <div className="fuel-toolbar"><OutletPicker biz={biz} value={outlet} onChange={setOutlet} /></div>
      <ErrorMessage message={error} />

      <SectionCard icon="tag" title="Prices" description="A litre (CNG a kg), including state VAT, from the time they take effect. A shift keeps the prices it opened at."
        actions={canCatalog && products.length > 0 && <button type="button" className="button button-sm" onClick={() => setDialog({ kind: "prices" })}><Icon name="edit" size={14} /> Set the prices</button>}>
        {shown.prices.length ? (
          <ul className="fuel-prices" aria-label="Prices in force">
            {shown.prices.map((p) => (
              <li key={`${p.location_id}-${p.product_id}`} className={p.price === null ? "is-missing" : ""}>
                <span>{p.name}</span>
                <strong className="mono">{p.price === null ? "No price" : biz.exact(p.price)}</strong>
                <small className="muted">{p.price === null ? "not set" : `since ${atWords(p.effective_from, biz)}`}</small>
                {p.next_price !== null && <small>{biz.exact(p.next_price)} from {atWords(p.next_from, biz)}</small>}
              </li>
            ))}
          </ul>
        ) : <p className="muted">Add the fuels first.</p>}
        {history.length > 0 && (
          <details className="fuel-details">
            <summary>Earlier prices</summary>
            <DataGrid variant="compact" id="fuel-price-history" caption="Earlier prices" rows={history} rowKey={(h) => h.id} currency={biz.symbol} rowNoun={["price", "prices"]}
              columns={[
                { key: "name", header: "Fuel", value: (h) => h.name, mobile: "title" },
                { key: "price", header: "Price", type: "money", exact: true, value: (h) => Number(h.price) },
                { key: "from", header: "From", type: "datetime", value: (h) => h.effective_from, render: (h) => atWords(h.effective_from, biz), mobile: "subtitle" },
                { key: "by", header: "Set by", value: (h) => h.created_by_name },
                { key: "note", header: "Note", value: (h) => h.note || "" },
              ]} />
          </details>
        )}
      </SectionCard>

      <SectionCard flush icon="fire" title="Fuels" description={VAT_NOTE}
        actions={canCatalog && <button type="button" className="button button-secondary button-sm" onClick={() => setDialog({ kind: "fuel" })}><Icon name="plus" size={14} /> Add a fuel</button>}>
        <DataGrid variant="compact" id="fuel-products" caption="Fuels" rows={data.products} rowKey={(p) => p.id} rowNoun={["fuel", "fuels"]}
          rowClassName={(p) => (p.active ? "" : "dg-tone-muted")}
          columns={[
            { key: "name", header: "Fuel", value: (p) => p.name, mobile: "title", pin: true,
              render: (p) => <span className="bz-two-line"><strong>{p.name}</strong><small className="muted"><span className="mono">{p.item_code}</span> · GST {Number(p.tax_rate)}%{p.hsn_code ? ` · HSN ${p.hsn_code}` : ""}</small></span> },
            { key: "family", header: "Kind", value: (p) => familyWord(p.family), mobile: "subtitle" },
            { key: "unit", header: "Sold by", value: (p) => (p.unit === "kg" ? "the kg" : "the litre") },
            { key: "active", header: "In use", value: (p) => (p.active ? "Yes" : "No"), render: (p) => <ActiveBadge active={p.active && p.item_active} /> },
            canCatalog && { key: "actions", header: "", label: "Actions", type: "actions", render: (p) => <button type="button" className="chip-button" onClick={() => setDialog({ kind: "fuel", product: p })}>Change</button> },
          ].filter(Boolean)}
          empty="No fuels yet" emptyHint="Add petrol, diesel, premium grades and CNG, each sold by the meters." emptyIcon="fire" />
      </SectionCard>

      <SectionCard flush icon="layers" title="Tanks" description="Each underground tank, the fuel it holds and its capacity."
        actions={canSettings && products.some((p) => p.family !== "cng") && <button type="button" className="button button-secondary button-sm" onClick={() => setDialog({ kind: "tank" })}><Icon name="plus" size={14} /> Add a tank</button>}>
        <DataGrid variant="compact" id="fuel-tanks" caption="Tanks" rows={shown.tanks} rowKey={(t) => t.id} rowNoun={["tank", "tanks"]}
          rowClassName={(t) => (t.active ? "" : "dg-tone-muted")}
          columns={[
            { key: "tank_no", header: "Tank", value: (t) => t.tank_no, mobile: "title", pin: true, render: (t) => <strong>Tank {t.tank_no}</strong> },
            { key: "product", header: "Fuel", value: (t) => t.product_name, mobile: "subtitle" },
            { key: "capacity", header: "Capacity", value: (t) => Number(t.capacity), className: "mono", render: (t) => qty(t.capacity, "") },
            { key: "dip", header: "Last dip", value: (t) => (t.last_dip ? Number(t.last_dip.stock) : ""), render: (t) => (t.last_dip ? `${qty(t.last_dip.stock, "")} on ${dayWords(t.last_dip.dip_on)}` : "—") },
            { key: "active", header: "In use", value: (t) => (t.active ? "Yes" : "No"), render: (t) => <ActiveBadge active={t.active} /> },
            canSettings && { key: "actions", header: "", label: "Actions", type: "actions", render: (t) => (
              <span className="fuel-inline">
                <button type="button" className="chip-button" onClick={() => setDialog({ kind: "tank", tank: t })}>Change</button>
                <button type="button" className="chip-button" onClick={() => setDialog({ kind: "chart", tank: t })}>Dip chart</button>
              </span>
            ) },
          ].filter(Boolean)}
          empty="No tanks at this outlet" emptyHint="Add each tank with the stock in it now, from its dip." emptyIcon="layers" />
      </SectionCard>

      <SectionCard icon="fire" title="Dispensing units and nozzles" description={`Each unit's Weights & Measures stamping, warned of ${warn} days before it falls due; a suspended unit's nozzles are not used.`}
        actions={canSettings && <button type="button" className="button button-secondary button-sm" onClick={() => setDialog({ kind: "unit" })}><Icon name="plus" size={14} /> Add a dispensing unit</button>}>
        {shown.dispensers.length ? shown.dispensers.map((d) => (
          <section key={d.id} className={`fuel-unit-card ${d.status !== "in_use" ? "is-off" : ""}`} aria-label={`Dispensing unit ${d.unit_no}`}>
            <header className="fuel-unit-card-head">
              <span className="bz-two-line">
                <strong>{d.unit_no}</strong>
                <small className="muted">{[d.make, d.serial_no ? `serial ${d.serial_no}` : null, d.stamped_on ? `stamped ${dayWords(d.stamped_on)}` : null].filter(Boolean).join(" · ") || "—"}</small>
              </span>
              <span className="fuel-actions">
                {d.status !== "in_use" && <Badge tone={UNIT_STATES[d.status].tone} label={`${UNIT_STATES[d.status].label}${d.status_note ? `: ${d.status_note}` : ""}`} />}
                {d.status !== "retired" && <Badge tone={stampingTone(d.days_to_due, warn)} label={`Stamping ${dueWords(d.days_to_due)} (${dayWords(d.stamping_due)})`} />}
                {canSettings && <button type="button" className="chip-button" onClick={() => setDialog({ kind: "unit", unit: d })}>Change</button>}
                {canSettings && d.status !== "retired" && <button type="button" className="chip-button" onClick={() => setDialog({ kind: "nozzle", unit: d })}><Icon name="plus" size={13} /> Add a nozzle</button>}
              </span>
            </header>
            <DataGrid variant="compact" id="fuel-nozzles" caption={`Nozzles of ${d.unit_no}`} rows={d.nozzles} rowKey={(n) => n.id} rowNoun={["nozzle", "nozzles"]}
              rowClassName={(n) => (n.active ? "" : "dg-tone-muted")}
              columns={[
                { key: "nozzle_no", header: "Nozzle", value: (n) => n.nozzle_no, mobile: "title", render: (n) => <strong>Nozzle {n.nozzle_no}</strong> },
                { key: "fuel", header: "Draws", value: (n) => `${n.product_name}${n.tank_no ? ` · tank ${n.tank_no}` : ""}`, mobile: "subtitle" },
                { key: "reading", header: "Totaliser", value: (n) => Number(n.reading), className: "mono", render: (n) => reading(n.reading) },
                { key: "shift", header: "Now", value: (n) => (n.open_shift_no ? `On ${n.open_shift_no}` : n.active ? "Free" : "Switched off"),
                  render: (n) => (n.open_shift_no ? `On ${n.open_shift_no} · ${n.open_attendant}` : <ActiveBadge active={n.active} />) },
                (canSettings || biz.can("fuel.approve")) && { key: "actions", header: "", label: "Actions", type: "actions", render: (n) => (
                  <span className="fuel-actions">
                    {canSettings && <button type="button" className="chip-button" onClick={() => setDialog({ kind: "nozzle", unit: d, nozzle: n })}>Change</button>}
                    {biz.can("fuel.approve") && !n.open_shift_no && <button type="button" className="chip-button" onClick={() => setDialog({ kind: "meter", nozzle: n })}>Meter change</button>}
                  </span>
                ) },
              ].filter(Boolean)}
              empty="No nozzles" emptyIcon="fire" />
          </section>
        )) : <p className="muted">No dispensing units at this outlet.</p>}
      </SectionCard>

      <SectionCard flush icon="scale" title="Measures" description="The stamped measures of the daily nozzle test (the 5-litre measure), each with its stamping."
        actions={canSettings && <button type="button" className="button button-secondary button-sm" onClick={() => setDialog({ kind: "measure" })}><Icon name="plus" size={14} /> Add a measure</button>}>
        <DataGrid variant="compact" id="fuel-measures" caption="Measures" rows={shown.measures} rowKey={(m) => m.id} rowNoun={["measure", "measures"]}
          rowClassName={(m) => (m.active ? "" : "dg-tone-muted")}
          columns={[
            { key: "name", header: "Measure", value: (m) => m.name, mobile: "title", render: (m) => <span className="bz-two-line"><strong>{m.name}</strong><small className="muted">{qty(m.litres, "")}{m.serial_no ? ` · serial ${m.serial_no}` : ""}</small></span> },
            { key: "due", header: "Stamping", value: (m) => m.stamping_due, mobile: "show",
              render: (m) => <Badge tone={m.active ? stampingTone(m.days_to_due, warn) : "neutral"} label={`${dueWords(m.days_to_due)} (${dayWords(m.stamping_due)})`} /> },
            { key: "stamped", header: "Stamped on", value: (m) => m.stamped_on || "", render: (m) => (m.stamped_on ? dayWords(m.stamped_on) : "—") },
            { key: "active", header: "In use", value: (m) => (m.active ? "Yes" : "No"), render: (m) => <ActiveBadge active={m.active} /> },
            canSettings && { key: "actions", header: "", label: "Actions", type: "actions", render: (m) => <button type="button" className="chip-button" onClick={() => setDialog({ kind: "measure", measure: m })}>Change</button> },
          ].filter(Boolean)}
          empty="No measures yet" emptyHint="Add the 5-litre measure with its stamping date." emptyIcon="scale" />
      </SectionCard>

      <Tolerances biz={biz} settings={data.settings} onSaved={(s) => setData((d) => ({ ...d, settings: s }))} />

      <SectionCard icon="shield" title="PESO licence" description="Each outlet's licence to store petroleum (Form XIV), kept with the business's licences.">
        {shown.peso === null ? <p className="muted">Keep each outlet's licence under Settings › Licences, once the licences are switched on (Settings › Business tools).</p>
          : shown.peso.map((p) => (
            <p key={p.locationId} className="fuel-peso">
              <strong>{p.locationName}</strong>{" "}
              {p.licence ? <Badge tone={p.licence.in_force ? "success" : "danger"} label={p.licence.in_force ? `${p.licence.licence_no} · in force${p.licence.valid_until ? ` until ${dayWords(p.licence.valid_until)}` : ""}` : `${p.licence.licence_no} · not in force`} />
                : <Badge tone="warning" label="No PESO licence kept" />}
              {" "}{biz.can("licences.view") && <Link to={biz.path("licences")}>Licences</Link>}
            </p>
          ))}
      </SectionCard>

      {dialog?.kind === "prices" && <PricesDialog biz={biz} location={location} products={products} current={shown.prices} onClose={() => setDialog(null)} onSaved={() => done("Prices set.")} />}
      {dialog?.kind === "fuel" && <FuelDialog biz={biz} product={dialog.product || null} onClose={() => setDialog(null)} onSaved={() => done(dialog.product ? "Fuel saved." : "Fuel added.")} />}
      {dialog?.kind === "chart" && <ChartDialog biz={biz} tank={dialog.tank} onClose={() => setDialog(null)} onSaved={(x) => { setDialog(null); toast.success(`Tank ${x.tank.tank_no}'s chart saved: ${x.rows.length} rows.`); }} />}
      {dialog?.kind === "tank" && <TankDialog biz={biz} location={location} products={products} tank={dialog.tank || null} onClose={() => setDialog(null)} onSaved={() => done(dialog.tank ? "Tank saved." : "Tank added.")} />}
      {dialog?.kind === "unit" && <UnitDialog biz={biz} location={location} unit={dialog.unit || null} tanks={shown.tanks.filter((t) => t.active)} products={products}
        onClose={() => setDialog(null)} onSaved={() => done(dialog.unit ? "Dispensing unit saved." : "Dispensing unit added.")} />}
      {dialog?.kind === "nozzle" && <NozzleDialog biz={biz} unit={dialog.unit} nozzle={dialog.nozzle || null} tanks={shown.tanks.filter((t) => t.active)} products={products}
        onClose={() => setDialog(null)} onSaved={() => done(dialog.nozzle ? "Nozzle saved." : "Nozzle added.")} />}
      {dialog?.kind === "meter" && <MeterDialog biz={biz} nozzle={dialog.nozzle} onClose={() => setDialog(null)} onSaved={() => done(`Nozzle ${dialog.nozzle.nozzle_no}'s meter change recorded.`)} />}
      {dialog?.kind === "measure" && <MeasureDialog biz={biz} location={location} measure={dialog.measure || null} onClose={() => setDialog(null)} onSaved={() => done(dialog.measure ? "Measure saved." : "Measure added.")} />}
    </div>
  );
}

// The outlet's prices, set together, from now or a time given.
// A tank's calibration (dip) chart: cm and litres a row, typed or pasted from
// the chart; it is put in place of the one the tank had. A dip read in cm on
// Tanks & dips then takes its litres from it.
function ChartDialog({ biz, tank, onClose, onSaved }) {
  const [text, setText] = useState("");
  const [rows, setRows] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `fuel/tanks/${tank.id}/chart`, undefined, controller.signal).then((x) => { setRows(x.rows); setText(x.rows.map((r) => `${r.cm}, ${r.litres}`).join("\n")); })
      .catch(() => setRows([]));
    return () => controller.abort();
  }, [biz.id, tank.id]);
  return (
    <FormDialog title={`Tank ${tank.tank_no}'s dip chart`} icon="layers" width={560} onClose={onClose} onSaved={onSaved} submitLabel="Save the chart"
      description={rows && rows.length ? `${rows.length} rows kept now. Saving puts the rows below in their place.` : "No chart kept yet: the litres of a dip are typed as read off the paper chart."}
      onSubmit={() => businessWrite(biz.id, `fuel/tanks/${tank.id}/chart`, { text }, "put")}>
      <Field label="Rows: dip in cm, litres (one a line)" wide hint="As on the calibration chart, e.g. 142.5, 8400. Pasted from a spreadsheet works too.">
        <textarea required rows={12} className="mono" value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
    </FormDialog>
  );
}

function PricesDialog({ biz, location, products, current, onClose, onSaved }) {
  const [key] = useState(newKey);
  const [prices, setPrices] = useState(() => Object.fromEntries(products.map((p) => [p.id, (() => { const c = current.find((x) => String(x.product_id) === String(p.id)); return c?.price ? String(Number(c.price).toFixed(2)) : ""; })()])));
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [note, setNote] = useState("");
  const submit = () => {
    const changed = products.filter((p) => prices[p.id].trim() && prices[p.id].trim() !== String(Number(current.find((x) => String(x.product_id) === String(p.id))?.price || 0).toFixed(2)));
    if (!changed.length) throw new Error("Change the price of one fuel or more");
    return businessWrite(biz.id, "fuel/prices", { requestKey: key, locationId: location.id, ...(effectiveFrom ? { effectiveFrom } : {}), ...(note.trim() ? { note: note.trim() } : {}),
      prices: changed.map((p) => ({ productId: p.id, price: prices[p.id].trim() })) });
  };
  return (
    <FormDialog title={`Set the prices at ${location.name}`} icon="tag" width={560} onClose={onClose} onSaved={onSaved} onSubmit={submit} submitLabel="Set the prices"
      description="The price of a litre (CNG a kg) including state VAT, as the oil company revises it. A price never takes effect back into a shift that has closed.">
      {products.map((p) => (
        <Field key={p.id} label={`${p.name} (${biz.symbol} a ${p.unit === "kg" ? "kg" : "litre"})`}>
          <input inputMode="decimal" className="mono" value={prices[p.id]} onChange={(e) => setPrices((all) => ({ ...all, [p.id]: e.target.value }))} />
        </Field>
      ))}
      <Field label="Takes effect from (optional)" hint="Left empty: now. Shifts open at the change close with their readings taken then.">
        <input type="datetime-local" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
      </Field>
      <Field label="Note (optional)" wide><input maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. the oil company's revision of the day" /></Field>
    </FormDialog>
  );
}

// A fuel added (a new goods item, or one in the catalogue) or changed (in use, its order on the list).
function FuelDialog({ biz, product, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({ useExisting: false, name: "", family: "petrol", code: "", hsnCode: "", sortOrder: product ? String(product.sort_order) : "0", active: product ? product.active : true }));
  const [existing, setExisting] = useState(null);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const submit = () => {
    if (product) return businessWrite(biz.id, `fuel/products/${product.id}`, { active: form.active, sortOrder: form.sortOrder || "0" }, "patch");
    if (form.useExisting && !existing) throw new Error("Choose the item");
    return businessWrite(biz.id, "fuel/products", { family: form.family, sortOrder: form.sortOrder || "0",
      ...(form.useExisting ? { skuId: existing.id } : { item: { name: form.name.trim(), ...(form.code.trim() ? { code: form.code.trim() } : {}), ...(form.hsnCode.trim() ? { hsnCode: form.hsnCode.trim() } : {}) } }) });
  };
  return (
    <FormDialog title={product ? `Change ${product.name}` : "Add a fuel"} icon="fire" width={600} onClose={onClose} onSaved={onSaved} onSubmit={submit} submitLabel={product ? "Save" : "Add the fuel"}
      description={product ? "A fuel still sold by a nozzle in use stays in use." : "A goods item counted in litres (CNG in kilos), kept in stock and on the GST nil slab, priced by the outlet's prices."}>
      {!product && (
        <>
          <Field label="Kind" wide><select value={form.family} onChange={set("family")}>{FAMILIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</select></Field>
          <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.useExisting} onChange={set("useExisting")} /> An item already in the catalogue</label>
          {form.useExisting ? (
            <div className="field-wide">
              <SearchPicker label="Item" placeholder="Name or code" value={existing} onChange={setExisting} minChars={1}
                search={(q, { signal }) => businessRead(biz.id, "catalog", { kind: "goods", active: "true", q, limit: 15 }, signal).then((page) => page.items)}
                getLabel={(s) => s.label} getDescription={(s) => `${s.code} · ${s.unit} · GST ${Number(s.tax_rate)}%`} />
            </div>
          ) : (
            <>
              <Field label="Name on the bill" wide><input required maxLength={150} value={form.name} onChange={set("name")} placeholder="e.g. Petrol, Diesel, Speed 97, CNG" /></Field>
              <Field label="Item code (optional)" hint="Left empty: FUEL-01, FUEL-02 …"><input maxLength={40} className="mono" value={form.code} onChange={set("code")} /></Field>
              <Field label="HSN (optional)"><input maxLength={8} inputMode="numeric" className="mono" value={form.hsnCode} onChange={set("hsnCode")} /></Field>
            </>
          )}
        </>
      )}
      <Field label="Order on the list"><input type="number" min="0" max="999" step="1" value={form.sortOrder} onChange={set("sortOrder")} /></Field>
      {product && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={set("active")} /> In use</label>}
    </FormDialog>
  );
}

// A tank added (with the stock in it now, from its dip) or changed.
function TankDialog({ biz, location, products, tank, onClose, onSaved }) {
  const tankFuels = products.filter((p) => p.family !== "cng");
  const [form, setForm] = useState(() => ({ productId: tank ? String(tank.product_id) : String(tankFuels[0]?.id || ""), tankNo: tank?.tank_no || "", capacity: tank ? String(Number(tank.capacity)) : "",
    stock: "", unitCost: "", sortOrder: tank ? String(tank.sort_order) : "0", active: tank ? tank.active : true }));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const submit = () => (tank
    ? businessWrite(biz.id, `fuel/tanks/${tank.id}`, { tankNo: form.tankNo.trim(), capacity: form.capacity.trim(), sortOrder: form.sortOrder || "0", active: form.active }, "patch")
    : businessWrite(biz.id, "fuel/tanks", { locationId: location.id, productId: form.productId, tankNo: form.tankNo.trim(), capacity: form.capacity.trim(), sortOrder: form.sortOrder || "0",
      ...(form.stock.trim() ? { stockNow: { litres: form.stock.trim(), ...(form.unitCost.trim() ? { unitCost: form.unitCost.trim() } : {}) } } : {}) }));
  return (
    <FormDialog title={tank ? `Change tank ${tank.tank_no}` : `Add a tank at ${location.name}`} icon="layers" width={600} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      submitLabel={tank ? "Save" : "Add the tank"} description={tank ? "A tank keeps the fuel it holds." : "The stock in it now comes into stock as an opening correction; loads after this are tanker receipts."}>
      {!tank && (
        <Field label="Fuel it holds"><select required value={form.productId} onChange={set("productId")}>{tankFuels.map((p) => <option key={p.id} value={String(p.id)}>{p.name}</option>)}</select></Field>
      )}
      <Field label="Tank number"><input required maxLength={20} value={form.tankNo} onChange={set("tankNo")} placeholder="T1" /></Field>
      <Field label="Capacity (litres)"><input required inputMode="decimal" className="mono" value={form.capacity} onChange={set("capacity")} /></Field>
      {!tank && (
        <>
          <Field label="Stock in it now (litres, optional)" hint="By this morning's dip."><input inputMode="decimal" className="mono" value={form.stock} onChange={set("stock")} /></Field>
          <Field label={`Cost of a litre (${biz.symbol}, optional)`} hint="For the stock's value."><input inputMode="decimal" className="mono" value={form.unitCost} onChange={set("unitCost")} /></Field>
        </>
      )}
      <Field label="Order on the list"><input type="number" min="0" max="999" step="1" value={form.sortOrder} onChange={set("sortOrder")} /></Field>
      {tank && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={set("active")} /> In use (a tank a nozzle draws from stays in use)</label>}
    </FormDialog>
  );
}

const blankNozzle = () => ({ key: newKey(), nozzleNo: "", source: "", reading: "" });
// A nozzle's source as a choice: "t<tank id>" (it draws from that tank) or "p<fuel id>" (CNG, from no tank).
const sourceBody = (source) => (source.startsWith("t") ? { tankId: source.slice(1) } : { productId: source.slice(1) });
function SourceOptions({ tanks, products }) {
  return (
    <>
      {tanks.map((t) => <option key={`t${t.id}`} value={`t${t.id}`}>Tank {t.tank_no} · {t.product_name}</option>)}
      {products.filter((p) => p.family === "cng").map((p) => <option key={`p${p.id}`} value={`p${p.id}`}>{p.name} (no tank)</option>)}
    </>
  );
}

// A dispensing unit added with its nozzles, or changed: its stamping, its state.
function UnitDialog({ biz, location, unit, tanks, products, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({ unitNo: unit?.unit_no || "", make: unit?.make || "", serialNo: unit?.serial_no || "", stampedOn: unit?.stamped_on || "",
    stampingDue: unit?.stamping_due || "", status: unit?.status || "in_use", statusNote: unit?.status_note || "", sortOrder: unit ? String(unit.sort_order) : "0" }));
  const [nozzles, setNozzles] = useState(() => [blankNozzle()]);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const setNozzle = (k, name) => (e) => setNozzles((all) => all.map((n) => (n.key === k ? { ...n, [name]: e.target.value } : n)));
  const fields = { unitNo: form.unitNo.trim(), make: form.make.trim() || null, serialNo: form.serialNo.trim() || null, stampedOn: form.stampedOn || null, stampingDue: form.stampingDue,
    sortOrder: form.sortOrder || "0" };
  const submit = () => (unit
    ? businessWrite(biz.id, `fuel/dispensers/${unit.id}`, { ...fields, status: form.status, ...(form.status !== "in_use" ? { statusNote: form.statusNote.trim() || null } : {}) }, "patch")
    : businessWrite(biz.id, "fuel/dispensers", { locationId: location.id, ...fields,
      nozzles: nozzles.filter((n) => n.nozzleNo.trim()).map((n) => ({ nozzleNo: n.nozzleNo.trim(), ...sourceBody(n.source), reading: n.reading.trim() || "0" })) }));
  return (
    <FormDialog title={unit ? `Change ${unit.unit_no}` : `Add a dispensing unit at ${location.name}`} icon="fire" width={760} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      submitLabel={unit ? "Save" : "Add the unit"} description="The Legal Metrology department stamps each unit; its due date is on the stamping certificate.">
      <Field label="Unit number"><input required maxLength={20} value={form.unitNo} onChange={set("unitNo")} placeholder="DU 1, MPD 2" /></Field>
      <Field label="Make (optional)"><input maxLength={80} value={form.make} onChange={set("make")} /></Field>
      <Field label="Serial number (optional)"><input maxLength={40} className="mono" value={form.serialNo} onChange={set("serialNo")} /></Field>
      <Field label="Stamped on (optional)"><input type="date" value={form.stampedOn} onChange={set("stampedOn")} /></Field>
      <Field label="Stamping falls due on"><input type="date" required value={form.stampingDue} onChange={set("stampingDue")} /></Field>
      <Field label="Order on the list"><input type="number" min="0" max="999" step="1" value={form.sortOrder} onChange={set("sortOrder")} /></Field>
      {unit && (
        <>
          <Field label="The unit is">
            <select value={form.status} onChange={set("status")}>{Object.entries(UNIT_STATES).map(([value, s]) => <option key={value} value={value}>{s.label}</option>)}</select>
          </Field>
          {form.status !== "in_use" && <Field label="Why" wide><input required maxLength={300} value={form.statusNote} onChange={set("statusNote")} placeholder="e.g. sealed for repair by the oil company" /></Field>}
        </>
      )}
      {!unit && (
        <fieldset className="field-wide fuel-fieldset">
          <legend>Nozzles</legend>
          {nozzles.map((n, index) => (
            <div key={n.key} className="fuel-row" role="group" aria-label={`Nozzle ${index + 1}`}>
              <Field label="Nozzle number"><input maxLength={10} value={n.nozzleNo} onChange={setNozzle(n.key, "nozzleNo")} placeholder={String(index + 1)} /></Field>
              <Field label="Draws from">
                <select required={Boolean(n.nozzleNo.trim())} value={n.source} onChange={setNozzle(n.key, "source")}>
                  <option value="">Choose the tank</option>
                  <SourceOptions tanks={tanks} products={products} />
                </select>
              </Field>
              <Field label="Totaliser now"><input inputMode="decimal" className="mono" value={n.reading} onChange={setNozzle(n.key, "reading")} placeholder="0.000" /></Field>
              {nozzles.length > 1 && <button type="button" className="link-button danger" onClick={() => setNozzles((all) => all.filter((x) => x.key !== n.key))}>Remove</button>}
            </div>
          ))}
          <button type="button" className="chip-button" onClick={() => setNozzles((all) => [...all, blankNozzle()])}><Icon name="plus" size={13} /> Another nozzle</button>
        </fieldset>
      )}
    </FormDialog>
  );
}

// A nozzle added to a unit (with its totaliser now), or renumbered and switched on or off.
function NozzleDialog({ biz, unit, nozzle, tanks, products, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({ nozzleNo: nozzle?.nozzle_no || "", source: "", reading: "", sortOrder: nozzle ? String(nozzle.sort_order) : "0", active: nozzle ? nozzle.active : true }));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const submit = () => (nozzle
    ? businessWrite(biz.id, `fuel/nozzles/${nozzle.id}`, { nozzleNo: form.nozzleNo.trim(), sortOrder: form.sortOrder || "0", active: form.active }, "patch")
    : businessWrite(biz.id, `fuel/dispensers/${unit.id}/nozzles`, { nozzleNo: form.nozzleNo.trim(), ...sourceBody(form.source), reading: form.reading.trim() || "0" }));
  return (
    <FormDialog title={nozzle ? `Change nozzle ${nozzle.nozzle_no}` : `Add a nozzle to ${unit.unit_no}`} icon="fire" width={560} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      submitLabel={nozzle ? "Save" : "Add the nozzle"} description={nozzle ? "Its totaliser moves only with a shift's close, or a meter change a manager records." : undefined}>
      <Field label="Nozzle number"><input required maxLength={10} value={form.nozzleNo} onChange={set("nozzleNo")} /></Field>
      {!nozzle && (
        <>
          <Field label="Draws from">
            <select required value={form.source} onChange={set("source")}>
              <option value="">Choose the tank</option>
              <SourceOptions tanks={tanks} products={products} />
            </select>
          </Field>
          <Field label="Totaliser now"><input inputMode="decimal" className="mono" value={form.reading} onChange={set("reading")} placeholder="0.000" /></Field>
        </>
      )}
      <Field label="Order on the list"><input type="number" min="0" max="999" step="1" value={form.sortOrder} onChange={set("sortOrder")} /></Field>
      {nozzle && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={set("active")} /> In use</label>}
    </FormDialog>
  );
}

// A manager's meter change: the totaliser replaced or reset, read from the new reading on.
function MeterDialog({ biz, nozzle, onClose, onSaved }) {
  const [readingNow, setReadingNow] = useState("");
  const [reason, setReason] = useState("");
  return (
    <FormDialog title={`Meter change on nozzle ${nozzle.nozzle_no}`} icon="settings" width={520} onClose={onClose} onSaved={onSaved} submitLabel="Record the change"
      description={`It reads ${reading(nozzle.reading)} from its last close. The next shift opens from the new reading; the activity log keeps both.`}
      onSubmit={() => businessWrite(biz.id, `fuel/nozzles/${nozzle.id}/meter`, { reading: readingNow.trim(), reason: reason.trim() })}>
      <Field label="New totaliser reading"><input required inputMode="decimal" className="mono" value={readingNow} onChange={(e) => setReadingNow(e.target.value)} /></Field>
      <Field label="Why the meter changed" wide><input required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. totaliser replaced by the dispenser company" /></Field>
    </FormDialog>
  );
}

// A stamped measure added or changed (its stamping dates).
function MeasureDialog({ biz, location, measure, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({ name: measure?.name || "5-litre measure", litres: measure ? String(Number(measure.litres)) : "5", serialNo: measure?.serial_no || "",
    stampedOn: measure?.stamped_on || "", stampingDue: measure?.stamping_due || "", active: measure ? measure.active : true }));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const fields = { name: form.name.trim(), litres: form.litres.trim(), serialNo: form.serialNo.trim() || null, stampedOn: form.stampedOn || null, stampingDue: form.stampingDue };
  const submit = () => (measure
    ? businessWrite(biz.id, `fuel/measures/${measure.id}`, { ...fields, active: form.active }, "patch")
    : businessWrite(biz.id, "fuel/measures", { locationId: location.id, ...fields }));
  return (
    <FormDialog title={measure ? `Change ${measure.name}` : `Add a measure at ${location.name}`} icon="scale" width={560} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      submitLabel={measure ? "Save" : "Add the measure"}>
      <Field label="Name"><input required maxLength={80} value={form.name} onChange={set("name")} /></Field>
      <Field label="What it holds (litres)"><input required inputMode="decimal" className="mono" value={form.litres} onChange={set("litres")} /></Field>
      <Field label="Serial number (optional)"><input maxLength={40} className="mono" value={form.serialNo} onChange={set("serialNo")} /></Field>
      <Field label="Stamped on (optional)"><input type="date" value={form.stampedOn} onChange={set("stampedOn")} /></Field>
      <Field label="Stamping falls due on"><input type="date" required value={form.stampingDue} onChange={set("stampingDue")} /></Field>
      {measure && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={set("active")} /> In use</label>}
    </FormDialog>
  );
}

// The tolerances the stock register checks against (the oil companies' Marketing Discipline Guidelines), the test measure and the bell's warning.
function Tolerances({ biz, settings, onSaved }) {
  const canEdit = biz.can("settings.edit");
  const [form, setForm] = useState(() => ({ ...Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, typeof v === "boolean" ? v : Array.isArray(v) ? v.join(", ") : String(v ?? "")])) }));
  const { options } = useOptions(canEdit ? ["catalog?kind=service&active=true"] : []);
  const services = options?.["catalog?kind=service&active=true"] || [];
  const [saving, setSaving] = useState(false);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const { updatedAt: _updated, ...body } = form;
      onSaved(await businessWrite(biz.id, "fuel/settings", { ...body, denominations: String(form.denominations).split(/[\s,]+/).filter(Boolean), interestSkuId: form.interestSkuId || null }, "put"));
      toast.success("Tolerances saved.");
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <SectionCard icon="sliders" title="Tolerances" description="The guidelines' figures until changed: a tanker's density within 3.0 kg/m³ of its invoice; a day's variation within 4% of the dip, and a loss within the evaporation and handling allowance on what was sold.">
      <form className="form-grid bz-form" onSubmit={save}>
        <fieldset className="bz-fieldset" disabled={!canEdit || saving}>
          <Field label="Density tolerance (kg/m³, either way)"><input inputMode="decimal" className="mono" value={form.densityTolerance} onChange={set("densityTolerance")} /></Field>
          <Field label="Operational variation (% of the dip)"><input inputMode="decimal" className="mono" value={form.variationPercent} onChange={set("variationPercent")} /></Field>
          <Field label="Petrol allowance up to 600 KL a year (% of sales)"><input inputMode="decimal" className="mono" value={form.petrolLossPercent} onChange={set("petrolLossPercent")} /></Field>
          <Field label="Petrol allowance beyond 600 KL a year (% of sales)"><input inputMode="decimal" className="mono" value={form.petrolLossAbovePercent} onChange={set("petrolLossAbovePercent")} /></Field>
          <Field label="Diesel allowance up to 600 KL a year (% of sales)"><input inputMode="decimal" className="mono" value={form.dieselLossPercent} onChange={set("dieselLossPercent")} /></Field>
          <Field label="Diesel allowance beyond 600 KL a year (% of sales)"><input inputMode="decimal" className="mono" value={form.dieselLossAbovePercent} onChange={set("dieselLossAbovePercent")} /></Field>
          <label className="checkbox bz-check field-wide"><input type="checkbox" checked={Boolean(form.above600Kl)} onChange={set("above600Kl")} /> The station sells more than 600 KL a year on average (the lower allowances apply)</label>
          <Field label="Test measure (litres)" hint="Filled in by the button on a shift's close."><input inputMode="decimal" className="mono" value={form.testLitres} onChange={set("testLitres")} /></Field>
          <Field label="Warn of a stamping this many days before it falls due"><input type="number" min="1" max="180" step="1" value={form.stampingWarnDays} onChange={set("stampingWarnDays")} /></Field>
          <Field label={`Notes and coins the cash is counted in (${biz.symbol})`} hint="Largest first, e.g. 500, 200, 100, 50, 20, 10, 5, 2, 1."><input className="mono" value={form.denominations} onChange={set("denominations")} /></Field>
          <Field label="Interest on overdue fleet credit is billed as" hint="A service item: its GST slab is the bill's.">
            <select value={form.interestSkuId} onChange={set("interestSkuId")}>
              <option value="">Not chosen yet</option>
              {services.map((x) => <option key={x.id} value={String(x.id)}>{x.label}</option>)}
            </select>
          </Field>
        </fieldset>
        {canEdit && <div className="form-actions"><button type="submit" className="button" disabled={saving}>{saving ? "Saving…" : "Save the tolerances"}</button></div>}
      </form>
    </SectionCard>
  );
}
