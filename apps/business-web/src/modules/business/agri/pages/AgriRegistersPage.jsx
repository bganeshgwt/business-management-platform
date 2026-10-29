import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import ContentTabs from "../../../../components/ContentTabs";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { monthStart } from "@bmp/shared/dates";
import { dateLong, dateShort } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, quantity, useOpenBusiness } from "../../core/pages/hooks";
import { kindWord, seedClassWord, tagWord } from "./agri";
import { printBoard, printRegister } from "./agriPrint";
import "../styles/agri.css";

// The farm-input shop's statutory outputs, each worked out from its bills,
// receipts and stock movements:
//   Stock & price board       the opening stock and price of every fertiliser
//                             and seed on a day (a day gone by at that day's
//                             prices), printed for display
//   Seed stock return         a month's opening stock, purchases, sales and
//                             closing stock of each seed, in quintals; due by the 5th
//   Insecticide sale register every pesticide sold, with the farmer, batch,
//                             manufacturer and expiry
//   Form XIV return           a month's opening stock, receipts, sales and
//                             closing stock of each insecticide; due by the 15th
//   Form XIII                 insecticides sold to dealers and bulk consumers
//   Sulphur buyers            every sale of sulphur with its buyer's name and address
// A monthly return is marked as sent here; the bell reminds until it is.

const TABS = [{ value: "board", label: "Stock & price board" }, { value: "seeds", label: "Seed stock return" }, { value: "insecticides", label: "Insecticide sale register" },
  { value: "form-xiv", label: "Form XIV return" }, { value: "form-xiii", label: "Form XIII" }, { value: "sulphur", label: "Sulphur buyers" }];
// The registers that may cover every location; the board and the returns are each one location's.
const ANY_LOCATION = ["insecticides", "form-xiii", "sulphur"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthWords = (month) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
// A seed's quantity in quintals when its weight is known, else in its own unit.
const inQuintals = (q, own, unit) => (q === null || q === undefined ? quantity(own, unit) : `${Number(q).toLocaleString("en-IN", { maximumFractionDigits: 4 })} q`);
const less = (r) => Number(r.quantity) - Number(r.returned || 0);

function useReport(biz, path, query, ready = true) {
  const [state, setState] = useState({ key: "", data: null, error: "" });
  const [version, setVersion] = useState(0);
  const key = JSON.stringify([path, query, version]);
  useEffect(() => {
    if (!ready) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, path, query, controller.signal)
      .then((data) => setState({ key, data, error: "" }))
      .catch((err) => { if (!controller.signal.aborted) setState({ key, data: null, error: getErrorMessage(err) }); });
    return () => controller.abort();
    // `key` stands for path, query and version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [biz.id, key, ready]);
  const current = state.key === key ? state : { data: null, error: "" };
  return { ...current, reload: () => setVersion((n) => n + 1) };
}

export default function AgriRegistersPage() {
  const biz = useOpenBusiness();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.value === params.get("tab")) ? params.get("tab") : "board";
  const locations = biz.locations.filter((l) => l.active);
  const [locationId, setLocationId] = useState(String(biz.currentLocationId || locations[0]?.id || ""));
  // The board and the returns are each one location's; the registers may cover every location.
  const placeId = locationId || String(locations[0]?.id || "");
  const showTab = (value) => setParams((p) => { const next = new URLSearchParams(p); next.set("tab", value); return next; }, { replace: true });
  const anywhere = ANY_LOCATION.includes(tab);
  const where = locations.length > 1 && (
    <label className="field">
      <span>Location</span>
      <select value={anywhere ? locationId : placeId} onChange={(e) => setLocationId(e.target.value)}>
        {anywhere && <option value="">Every location</option>}
        {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
    </label>
  );
  return (
    <div className="stack">
      <BusinessHeader icon="clipboard" title="Registers & board"
        description="The stock and price board to display, the monthly seed and insecticide returns, and the insecticide, Form XIII and sulphur registers, each worked out from the bills, receipts and stock movements: nothing is written twice." />
      <ContentTabs label="Register" value={tab} options={TABS} onChange={showTab}>
        {tab === "board" && <Board locationId={placeId} where={where} />}
        {tab === "seeds" && <SeedReturn locationId={placeId} where={where} />}
        {tab === "insecticides" && <InsecticideRegister locationId={locationId} where={where} />}
        {tab === "form-xiv" && <FormXiv locationId={placeId} where={where} />}
        {tab === "form-xiii" && <FormXiii locationId={locationId} where={where} />}
        {tab === "sulphur" && <SulphurBuyers locationId={locationId} where={where} />}
      </ContentTabs>
    </div>
  );
}

function Board({ locationId, where }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [on, setOn] = useState(today);
  const report = useReport(biz, "agri/board", { locationId, on }, Boolean(locationId));
  const board = report.data;
  const columns = useMemo(() => [
    { key: "label", header: "Item", value: (r) => r.label, mobile: "title", pin: true,
      render: (r) => <span className="bz-two-line"><span>{r.label}</span>{r.input_kind === "seed" && (r.seed_crop || r.seed_variety || r.seed_class)
        ? <small className="muted">{[r.seed_crop, r.seed_variety, seedClassWord(r.seed_class)].filter(Boolean).join(" · ")}</small> : r.subsidised ? <small className="muted">Subsidised</small> : null}</span> },
    { key: "kind", header: "Kind", value: (r) => kindWord(r.input_kind), filter: "select" },
    { key: "opening", header: "Opening stock", type: "number", value: (r) => Number(r.opening), render: (r) => quantity(r.opening, r.unit), mobile: "show" },
    { key: "closing", header: board?.closed ? "Closing stock" : "Stock now", type: "number", value: (r) => Number(r.closing), render: (r) => quantity(r.closing, r.unit) },
    { key: "price", header: board?.taxMode === "inclusive" ? "Price (incl. GST)" : "Price", type: "money", exact: true, value: (r) => Number(r.price),
      render: (r) => (r.price_changed ? <span className="bz-two-line"><span>{biz.exact(r.price)}</span><small className="muted">{biz.exact(r.opening_price)} at the day's start</small></span> : biz.exact(r.price)) },
    { key: "mrp", header: "MRP", type: "money", exact: true, value: (r) => (r.mrp === null ? null : Number(r.mrp)) },
  ], [biz, board?.closed, board?.taxMode]);
  async function print() {
    try {
      // The licences the location sells fertilisers and seeds under, for the board's header.
      const held = biz.has("licences") && biz.can("licences.view")
        ? (await businessRead(biz.id, "licences", { location: locationId, active: "true", limit: 100 })).items.filter((l) => ["valid", "no_expiry", "expiring"].includes(l.state)
          && (l.covers || []).some((c) => ["fertiliser", "seed"].includes(c))) : [];
      printBoard({ biz, board, licences: held, money: (value) => biz.exact(value) });
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }
  return (
    <SectionCard flush icon="clipboard" title={board ? `Stock and price board · ${dateLong(board.on)}` : "Stock and price board"}
      actions={<button type="button" className="button button-secondary" onClick={print} disabled={!board?.rows.length}><Icon name="print" size={15} /> Print the board</button>}>
      <DataGrid id="agri-board" caption="Stock and price board" columns={columns} rows={board?.rows || []} loading={!board && !report.error} error={board ? "" : report.error}
        onRetry={report.reload} currency={biz.symbol} rowNoun={["item", "items"]} pageSize={false}
        toolbar={(
          <>
            {where}
            <label className="field"><span>Day</span><input type="date" max={today} value={on} onChange={(e) => e.target.value && setOn(e.target.value)} /></label>
          </>
        )}
        exportName={biz.can("reports.export") ? `${biz.business.code}-stock-board-${on}` : undefined}
        empty="No fertilisers or seeds yet" emptyHint="Give each item its kind of farm input (Products): fertilisers and seeds show on the board." emptyIcon="clipboard" />
      {board?.closed && <p className="small muted agri-card-note">The prices are those of {dateLong(board.on)}, as they stood at its end.</p>}
    </SectionCard>
  );
}

// Whether a month's return is sent, due or still running; a button to mark it sent.
function FiledLine({ ret, form, what, dueWords, onMark }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  if (!ret) return null;
  const f = ret.filed;
  return (
    <p className="small bz-inline">
      {f ? <Badge tone="success" label={`Sent on ${dateShort(f.filed_on, { year: true })}${f.reference ? ` · ${f.reference}` : ""}`} />
        : <Badge tone={ret.closed ? (today <= ret.dueOn ? "warning" : "danger") : "info"} label={ret.closed ? `Due by ${dateShort(ret.dueOn, { year: true })}` : "Month still running"} />}
      <span>{what} for {monthWords(ret.month)} goes to the licensing authority {dueWords}.</span>
      {!f && ret.closed && biz.can("agri.edit") && <button type="button" className="button button-secondary button-sm" onClick={() => onMark(form)}><Icon name="check" size={14} /> Mark it sent</button>}
    </p>
  );
}

// A month's return marked as sent to the licensing authority, once.
function FiledDialog({ ret, form, name, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [values, setValues] = useState({ filedOn: today, reference: "", notes: "" });
  const set = (key) => (e) => setValues((v) => ({ ...v, [key]: e.target.value }));
  const after = `${ret.dueOn.slice(0, 7)}-01`;
  const submit = () => businessWrite(biz.id, "agri/returns-filed", { form, locationId: ret.location.id, month: ret.month, filedOn: values.filedOn,
    reference: values.reference.trim() || null, notes: values.notes.trim() || null });
  return (
    <FormDialog title={`${name} for ${monthWords(ret.month)}: sent`} icon="check" width={560} submitLabel="Mark it sent" onClose={onClose} onSaved={onSaved} onSubmit={submit}
      description={`${ret.location.name}. Marked once; the bell stops reminding.`}>
      <Field label="Sent on"><input type="date" required min={after} max={today} value={values.filedOn} onChange={set("filedOn")} /></Field>
      <Field label="Reference or acknowledgement (optional)"><input maxLength={80} className="mono" value={values.reference} onChange={set("reference")} /></Field>
      <Field label="Notes (optional)" wide><input maxLength={300} value={values.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

function SeedReturn({ locationId, where }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [marking, setMarking] = useState(false);
  const report = useReport(biz, "agri/seed-return", { locationId, month }, Boolean(locationId));
  const ret = report.data;
  const columns = useMemo(() => [
    { key: "crop", header: "Crop", value: (r) => r.crop || "", mobile: "subtitle" },
    { key: "variety", header: "Variety", value: (r) => r.variety || "" },
    { key: "seed_class", header: "Class", value: (r) => seedClassWord(r.seed_class) },
    { key: "label", header: "Item", value: (r) => r.label, mobile: "title" },
    { key: "opening", header: "Opening (1st)", type: "number", value: (r) => Number(r.opening_q ?? r.opening), render: (r) => inQuintals(r.opening_q, r.opening, r.unit) },
    { key: "purchased", header: "Purchased", type: "number", value: (r) => Number(r.purchased_q ?? r.purchased), render: (r) => inQuintals(r.purchased_q, r.purchased, r.unit) },
    { key: "sold", header: "Sold", type: "number", value: (r) => Number(r.sold_q ?? r.sold), render: (r) => inQuintals(r.sold_q, r.sold, r.unit), mobile: "show" },
    { key: "other", header: "Other changes", type: "number", value: (r) => Number(r.other_q ?? r.other), render: (r) => (Number(r.other) ? inQuintals(r.other_q, r.other, r.unit) : <span className="muted">—</span>) },
    { key: "closing", header: "Closing", type: "number", value: (r) => Number(r.closing_q ?? r.closing), render: (r) => inQuintals(r.closing_q, r.closing, r.unit), mobile: "show" },
  ], []);
  const unknown = (ret?.rows || []).filter((r) => r.kg_per_unit === null);
  const print = () => printRegister({ biz, title: "Monthly seed stock return (Form D)", period: `${monthWords(month)} · due by ${dateShort(ret.dueOn, { year: true })}`,
    location: ret.location, rows: ret.rows, note: "Quantities in quintals where the item's weight is known.", columns: [
      ["Crop / variety", (r) => [r.crop, r.variety].filter(Boolean).join(" / ") || r.label], ["Class of seed", (r) => seedClassWord(r.seed_class)], ["Item", (r) => r.label],
      ["Opening stock", (r) => inQuintals(r.opening_q, r.opening, r.unit)], ["Purchased", (r) => inQuintals(r.purchased_q, r.purchased, r.unit)],
      ["Sold", (r) => inQuintals(r.sold_q, r.sold, r.unit)], ["Other changes", (r) => (Number(r.other) ? inQuintals(r.other_q, r.other, r.unit) : "")],
      ["Closing stock", (r) => inQuintals(r.closing_q, r.closing, r.unit)]] });
  return (
    <>
      <FiledLine ret={ret} form="form_d" what="The seed stock return" dueWords="by the 5th of the next month" onMark={() => setMarking(true)} />
      {ret && <p className="small muted">Other changes are stock corrections, counts, stock kept apart and transfers.</p>}
      {unknown.length > 0 && <p className="small muted">{unknown.map((r) => r.label).join(", ")} {unknown.length === 1 ? "is" : "are"} shown in {unknown.length === 1 ? "its" : "their"} own unit: give the weight of one unit on the item to see quintals.</p>}
      <SectionCard flush icon="leaf" title={`Seed stock return · ${monthWords(month)}`}
        actions={<button type="button" className="button button-secondary" onClick={print} disabled={!ret?.rows.length}><Icon name="print" size={15} /> Print the return</button>}>
        <DataGrid id="agri-seed-return" caption="Seed stock return" columns={columns} rows={ret?.rows || []} loading={!ret && !report.error} error={ret ? "" : report.error}
          onRetry={report.reload} rowNoun={["seed", "seeds"]} pageSize={false}
          toolbar={(
            <>
              {where}
              <label className="field"><span>Month</span><input type="month" max={today.slice(0, 7)} value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label>
            </>
          )}
          exportName={biz.can("reports.export") ? `${biz.business.code}-seed-return-${month}` : undefined}
          empty="No seeds yet" emptyHint="Give each seed item its kind, class, crop and variety (Products)." emptyIcon="leaf" />
      </SectionCard>
      {marking && <FiledDialog ret={ret} form="form_d" name="The seed stock return" onClose={() => setMarking(false)}
        onSaved={() => { setMarking(false); report.reload(); toast.success("Marked as sent."); }} />}
    </>
  );
}

function InsecticideRegister({ locationId, where }) {
  const biz = useOpenBusiness();
  const anchor = businessToday(biz.business.timezone);
  const [range, setRange] = useState(() => ({ from: monthStart(anchor), to: anchor }));
  const report = useReport(biz, "agri/insecticide-register", { ...(locationId ? { locationId } : {}), ...range });
  const data = report.data;
  const many = biz.locations.length > 1;
  const columns = useMemo(() => [
    { key: "day", header: "Date", type: "date", value: (r) => r.day, mobile: "subtitle" },
    { key: "document_no", header: "Bill", value: (r) => r.document_no, className: "mono" },
    { key: "farmer", header: "Farmer", value: (r) => r.farmer || "Walk-in", mobile: "title",
      render: (r) => <span className="bz-two-line"><span>{r.farmer || <span className="muted">Walk-in</span>}</span><small className="muted">{[r.relative_name, r.village].filter(Boolean).join(" · ")}</small></span> },
    { key: "product", header: "Product", value: (r) => r.product, render: (r) => <span className="bz-two-line"><span>{r.product}</span>{r.molecules?.length > 0 && <small className="muted">{r.molecules.join(" + ")}</small>}</span> },
    { key: "batch", header: "Batch", value: (r) => r.batch || "", className: "mono" },
    { key: "manufacturer", header: "Manufacturer", value: (r) => r.manufacturer || "" },
    { key: "quantity", header: "Quantity", type: "number", value: (r) => Number(r.quantity), render: (r) => quantity(r.quantity, r.unit), mobile: "show" },
    { key: "returned", header: "Came back", type: "number", value: (r) => Number(r.returned), render: (r) => (Number(r.returned) ? quantity(r.returned, r.unit) : <span className="muted">—</span>) },
    { key: "expires_on", header: "Expiry", type: "date", value: (r) => r.expires_on },
    { key: "crop", header: "Crop", value: (r) => r.crop || "",
      render: (r) => <span className="bz-inline">{r.crop || ""}{r.off_label && <Badge tone="warning" label="Not on its label" />}</span> },
    { key: "restricted_by", header: "Restricted use", value: (r) => (r.restricted_by ? tagWord(r.restricted_by) : ""), defaultHidden: true },
    many && { key: "location", header: "Location", value: (r) => r.location_name, defaultHidden: Boolean(locationId) },
  ].filter(Boolean), [many, locationId]);
  const print = () => printRegister({ biz, title: "Insecticide sale register", period: `${dateShort(range.from, { year: true })} – ${dateShort(range.to, { year: true })}`,
    location: data.location, rows: data.rows, columns: [
      ["Date", (r) => dateShort(r.day, { year: true })], ["Bill", (r) => r.document_no], ["Farmer", (r) => [r.farmer || "Walk-in", r.relative_name, r.village].filter(Boolean).join(", ")],
      ["Product", (r) => r.product], ["Batch", (r) => r.batch], ["Manufacturer", (r) => r.manufacturer], ["Quantity", (r) => quantity(r.quantity, r.unit)],
      ["Came back", (r) => (Number(r.returned) ? quantity(r.returned, r.unit) : "")], ["Expiry", (r) => (r.expires_on ? dateShort(r.expires_on, { year: true }) : "")], ["Crop", (r) => r.crop]] });
  return (
    <SectionCard flush icon="list" title="Insecticide sale register"
      actions={<button type="button" className="button button-secondary" onClick={print} disabled={!data?.rows.length}><Icon name="print" size={15} /> Print the register</button>}>
      <DataGrid id="agri-insecticide-register" caption="Insecticide sale register" columns={columns} rows={data?.rows || []} rowKey={(r) => r.line_id}
        loading={!data && !report.error} error={data ? "" : report.error} onRetry={report.reload} rowNoun={["entry", "entries"]}
        toolbar={(
          <>
            {where}
            <DateRangeFilter from={range.from} to={range.to} anchor={anchor} label="dates" onChange={(next) => next.from && next.to && setRange(next)} />
          </>
        )}
        exportName={biz.can("reports.export") ? `${biz.business.code}-insecticide-register-${range.from}-${range.to}` : undefined}
        empty="No pesticide sold in these dates" emptyHint="Every bill line of a pesticide shows here, with its batch and expiry." emptyIcon="list" />
    </SectionCard>
  );
}

function FormXiv({ locationId, where }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [marking, setMarking] = useState(false);
  const report = useReport(biz, "agri/form-xiv", { locationId, month }, Boolean(locationId));
  const ret = report.data;
  const own = (key) => (r) => quantity(r[key], r.unit);
  const columns = useMemo(() => [
    { key: "label", header: "Insecticide", value: (r) => r.label, mobile: "title", pin: true,
      render: (r) => <span className="bz-two-line"><span>{r.label}</span>{(r.molecules.length > 0 || r.formulation) && <small className="muted">{[r.molecules.join(" + "), r.formulation].filter(Boolean).join(" · ")}</small>}</span> },
    { key: "opening", header: "Opening (1st)", type: "number", value: (r) => Number(r.opening), render: (r) => quantity(r.opening, r.unit) },
    { key: "purchased", header: "Received", type: "number", value: (r) => Number(r.purchased), render: (r) => quantity(r.purchased, r.unit) },
    { key: "sold", header: "Sold", type: "number", value: (r) => Number(r.sold), render: (r) => quantity(r.sold, r.unit), mobile: "show" },
    { key: "to_trade", header: "Of it, to dealers & bulk", type: "number", value: (r) => Number(r.to_trade), render: (r) => (Number(r.to_trade) ? quantity(r.to_trade, r.unit) : <span className="muted">—</span>) },
    { key: "other", header: "Other changes", type: "number", value: (r) => Number(r.other), render: (r) => (Number(r.other) ? quantity(r.other, r.unit) : <span className="muted">—</span>) },
    { key: "closing", header: "Closing", type: "number", value: (r) => Number(r.closing), render: (r) => quantity(r.closing, r.unit), mobile: "show" },
  ], []);
  const print = () => printRegister({ biz, title: "Monthly return of insecticides (Form XIV)", period: `${monthWords(month)} · due by ${dateShort(ret.dueOn, { year: true })}`,
    location: ret.location, rows: ret.rows, note: "Sales to dealers and bulk consumers are those in Form XIII.", columns: [
      ["Insecticide", (r) => r.label], ["Molecules / formulation", (r) => [r.molecules.join(" + "), r.formulation].filter(Boolean).join(" · ")],
      ["Opening stock", own("opening")], ["Received", own("purchased")], ["Sold", own("sold")], ["Of it, to dealers and bulk consumers", (r) => (Number(r.to_trade) ? own("to_trade")(r) : "")],
      ["Other changes", (r) => (Number(r.other) ? own("other")(r) : "")], ["Closing stock", own("closing")]] });
  return (
    <>
      <FiledLine ret={ret} form="form_xiv" what="The Form XIV return" dueWords="within 15 days of the month's end" onMark={() => setMarking(true)} />
      <SectionCard flush icon="clipboard" title={`Form XIV return · ${monthWords(month)}`}
        actions={<button type="button" className="button button-secondary" onClick={print} disabled={!ret?.rows.length}><Icon name="print" size={15} /> Print the return</button>}>
        <DataGrid id="agri-form-xiv" caption="Form XIV return" columns={columns} rows={ret?.rows || []} loading={!ret && !report.error} error={ret ? "" : report.error}
          onRetry={report.reload} rowNoun={["insecticide", "insecticides"]} pageSize={false}
          toolbar={(
            <>
              {where}
              <label className="field"><span>Month</span><input type="month" max={today.slice(0, 7)} value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label>
            </>
          )}
          exportName={biz.can("reports.export") ? `${biz.business.code}-form-xiv-${month}` : undefined}
          empty="No insecticides yet" emptyHint="Give each pesticide item its kind and molecules (Products): each shows here." emptyIcon="clipboard" />
      </SectionCard>
      {marking && <FiledDialog ret={ret} form="form_xiv" name="The Form XIV return" onClose={() => setMarking(false)}
        onSaved={() => { setMarking(false); report.reload(); toast.success("Marked as sent."); }} />}
    </>
  );
}

function FormXiii({ locationId, where }) {
  const biz = useOpenBusiness();
  const anchor = businessToday(biz.business.timezone);
  const [range, setRange] = useState(() => ({ from: monthStart(anchor), to: anchor }));
  const report = useReport(biz, "agri/form-xiii", { ...(locationId ? { locationId } : {}), ...range });
  const data = report.data;
  const columns = useMemo(() => [
    { key: "insecticide", header: "Insecticide", value: (r) => r.insecticide, mobile: "title", pin: true,
      render: (r) => <span className="bz-two-line"><span>{r.insecticide}</span>{r.molecules?.length > 0 && <small className="muted">{r.molecules.join(" + ")}</small>}</span> },
    { key: "day", header: "Date", type: "date", value: (r) => r.day, mobile: "subtitle" },
    { key: "document_no", header: "Bill", value: (r) => r.document_no, className: "mono" },
    { key: "buyer", header: "Buyer", value: (r) => r.buyer || "",
      render: (r) => <span className="bz-two-line"><span>{r.buyer}</span><small className="muted">{r.buyer_kind === "dealer" ? `Dealer · ${r.buyer_gstin}` : `${tagWord("bulk_consumer")}${r.reference ? ` · ${r.reference}` : ""}`}</small></span> },
    { key: "address", header: "Address", value: (r) => r.address || "" },
    { key: "batch", header: "Batch", value: (r) => r.batch || "", className: "mono" },
    { key: "manufacturer", header: "Manufacturer", value: (r) => r.manufacturer || "", defaultHidden: true },
    { key: "quantity", header: "Quantity", type: "number", value: (r) => less(r), render: (r) => quantity(less(r), r.unit), mobile: "show" },
  ], []);
  const print = () => printRegister({ biz, title: "Insecticides sold to dealers and bulk consumers (Form XIII)", period: `${dateShort(range.from, { year: true })} – ${dateShort(range.to, { year: true })}`,
    location: data.location, rows: data.rows, note: "Quantities net of goods that came back.", columns: [
      ["Insecticide", (r) => r.insecticide], ["Date", (r) => dateShort(r.day, { year: true })], ["Bill", (r) => r.document_no],
      ["Buyer", (r) => r.buyer], ["Dealer's GSTIN or bulk consumer", (r) => (r.buyer_kind === "dealer" ? r.buyer_gstin : [tagWord("bulk_consumer"), r.reference].filter(Boolean).join(" · "))],
      ["Address", (r) => r.address], ["Batch", (r) => r.batch], ["Quantity", (r) => quantity(less(r), r.unit)]] });
  return (
    <SectionCard flush icon="list" title="Form XIII: to dealers and bulk consumers"
      actions={<button type="button" className="button button-secondary" onClick={print} disabled={!data?.rows.length}><Icon name="print" size={15} /> Print the register</button>}>
      <DataGrid id="agri-form-xiii" caption="Form XIII" columns={columns} rows={data?.rows || []} rowKey={(r) => r.line_id}
        loading={!data && !report.error} error={data ? "" : report.error} onRetry={report.reload} rowNoun={["entry", "entries"]}
        toolbar={(
          <>
            {where}
            <DateRangeFilter from={range.from} to={range.to} anchor={anchor} label="dates" onChange={(next) => next.from && next.to && setRange(next)} />
          </>
        )}
        exportName={biz.can("reports.export") ? `${biz.business.code}-form-xiii-${range.from}-${range.to}` : undefined}
        empty="No insecticide sold to dealers or bulk consumers in these dates"
        emptyHint="A bill to a buyer with a GSTIN, or to a customer tagged a bulk consumer (on the Tagged buyers tab of Farmers & village dues), shows here." emptyIcon="list" />
    </SectionCard>
  );
}

function SulphurBuyers({ locationId, where }) {
  const biz = useOpenBusiness();
  const anchor = businessToday(biz.business.timezone);
  const [range, setRange] = useState(() => ({ from: monthStart(anchor), to: anchor }));
  const report = useReport(biz, "agri/sulphur-register", { ...(locationId ? { locationId } : {}), ...range });
  const data = report.data;
  const columns = useMemo(() => [
    { key: "day", header: "Date", type: "date", value: (r) => r.day, mobile: "subtitle" },
    { key: "document_no", header: "Bill", value: (r) => r.document_no, className: "mono" },
    { key: "buyer", header: "Buyer", value: (r) => r.buyer || "", mobile: "title" },
    { key: "address", header: "Address", value: (r) => r.address || "" },
    { key: "product", header: "Product", value: (r) => r.product },
    { key: "quantity", header: "Quantity", type: "number", value: (r) => less(r), render: (r) => quantity(less(r), r.unit), mobile: "show" },
  ], []);
  const print = () => printRegister({ biz, title: "Register of sulphur buyers", period: `${dateShort(range.from, { year: true })} – ${dateShort(range.to, { year: true })}`,
    location: data.location, rows: data.rows, note: "Quantities net of goods that came back.", columns: [
      ["Date", (r) => dateShort(r.day, { year: true })], ["Bill", (r) => r.document_no], ["Buyer", (r) => r.buyer], ["Address", (r) => r.address],
      ["Product", (r) => r.product], ["Quantity", (r) => quantity(less(r), r.unit)]] });
  return (
    <SectionCard flush icon="list" title="Sulphur buyers"
      actions={<button type="button" className="button button-secondary" onClick={print} disabled={!data?.rows.length}><Icon name="print" size={15} /> Print the register</button>}>
      <DataGrid id="agri-sulphur-register" caption="Sulphur buyers" columns={columns} rows={data?.rows || []} rowKey={(r) => r.line_id}
        loading={!data && !report.error} error={data ? "" : report.error} onRetry={report.reload} rowNoun={["entry", "entries"]}
        toolbar={(
          <>
            {where}
            <DateRangeFilter from={range.from} to={range.to} anchor={anchor} label="dates" onChange={(next) => next.from && next.to && setRange(next)} />
          </>
        )}
        exportName={biz.can("reports.export") ? `${biz.business.code}-sulphur-buyers-${range.from}-${range.to}` : undefined}
        empty="No sulphur sold in these dates" emptyHint="Every bill line of an item made of sulphur shows here, with its buyer's name and address." emptyIcon="list" />
    </SectionCard>
  );
}
