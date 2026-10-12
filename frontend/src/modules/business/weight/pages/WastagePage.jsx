import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field, FormError, PeriodFilter } from "../../core/pages/ui";
import { newKey, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { dateShort } from "../../../../services/format";
import { REASONS, kg, reasonWord, weightOf } from "./weight";

// Daily wastage: weight thrown away (trimming, spoiled, unsold, drip loss),
// taken out of stock at once and valued at the batch's cost.
export default function WastagePage() {
  const biz = useOpenBusiness();
  const [params, setParams] = useSearchParams();
  const [reason, setReason] = useState("");
  const [batch, setBatch] = useState(false);
  const list = useServerList("weight/wastage", { gridId: "weight-wastage", period: true, params: reason ? { reason } : {} });
  const [today, setToday] = useState(null);
  const [creating, setCreating] = useState(() => (params.get("new") ? { skuId: params.get("new") } : false));
  const [notice, setNotice] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "weight/wastage-today", {}, controller.signal).then(setToday).catch(() => {});
    return () => controller.abort();
  }, [biz.id, version]);
  const columns = useMemo(() => [
    { key: "created_at", header: "When", type: "datetime", value: (w) => w.created_at, mobile: "subtitle" },
    { key: "label", header: "Item", value: (w) => w.label, mobile: "title", pin: true },
    { key: "lot_code", header: "Batch", value: (w) => w.lot_code || "", defaultHidden: true },
    { key: "quantity", header: "Wasted", type: "number", value: (w) => Number(w.quantity), mobile: "show", render: (w) => weightOf(w.quantity, w.unit) },
    // The weight once (pro pass F-20); the kg column stays for the spreadsheet.
    { key: "kg", header: "kg", type: "number", value: (w) => (w.kg === null ? null : Number(w.kg)), total: "sum", defaultHidden: true },
    { key: "reason", header: "Reason", type: "status", value: (w) => w.reason, mobile: "show", filterOptions: REASONS,
      render: (w) => <Badge tone={w.reason === "spoiled" || w.reason === "damaged" ? "warning" : "neutral"} label={reasonWord(w.reason)} /> },
    { key: "note", header: "Note", value: (w) => w.note || "" },
    { key: "value", header: "Cost", type: "money", exact: true, value: (w) => Number(w.value), total: "sum", mobile: "show" },
    { key: "location_name", header: "Location", value: (w) => w.location_name, defaultHidden: biz.locations.length < 2 },
    { key: "created_by_name", header: "By", value: (w) => w.created_by_name, defaultHidden: true },
  ], [biz.locations.length]);
  return (
    <div className="stack">
      <BusinessHeader icon="trash" title="Wastage"
        description="Write off what could not be sold. It leaves stock at once at the batch's cost and shows in the wastage report."
        primary={biz.can("wastage.create") && <button type="button" className="button" onClick={() => setBatch(true)}><Icon name="list" size={16} /> End of day</button>}
        secondary={biz.can("wastage.create") && <button type="button" className="button button-secondary" onClick={() => setCreating({})}><Icon name="plus" size={16} /> One item</button>} />
      <SuccessMessage message={notice} />
      <div className="sw-tiles">
        <StatTile icon="trash" tone="warning" label="Wasted today" value={today ? kg(today.kg) : undefined} loading={!today} note={today ? `${today.entries} ${today.entries === 1 ? "entry" : "entries"}` : ""} />
        <StatTile icon="rupee" tone="danger" label="Cost today" money={today ? Number(today.value) : undefined} loading={!today} />
        <StatTile icon="calendar" label="This month" value={today ? kg(today.month_kg) : undefined} loading={!today} note={today ? `${biz.amount(today.month_value)} at cost` : ""} />
      </div>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="list" title="Wastage in this period">
        <DataGrid {...list.gridProps} caption="Wastage entries" columns={columns} currency={biz.symbol} rowNoun={["entry", "entries"]}
          exportName={biz.can("wastage.export") ? `${biz.business.code}-wastage` : undefined}
          toolbar={(
            <>
              <PeriodFilter list={list} />
              <label className="field"><span>Reason</span>
                <select value={reason} onChange={(e) => setReason(e.target.value)}>
                  <option value="">Any</option>
                  {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </label>
            </>
          )}
          empty="No wastage in these dates" emptyIcon="trash" />
      </SectionCard>
      {creating && (
        <WastageDialog start={creating} onClose={() => { setCreating(false); setParams({}, { replace: true }); }}
          onSaved={(w) => { setCreating(false); setParams({}, { replace: true }); setNotice(`${weightOf(w.quantity, w.unit)} of ${w.label} written off (${biz.exact(w.value)}).`); list.reload(); setVersion((n) => n + 1); }} />
      )}
      {batch && (
        <BatchDialog onClose={() => setBatch(false)}
          onSaved={(r) => { setBatch(false); setNotice(`${r.entries.length} write-offs saved: ${kg(r.kg)}, ${biz.exact(r.value)} at cost.`); list.reload(); setVersion((n) => n + 1); }} />
      )}
    </div>
  );
}

// Many items at once, the way a shop writes off in the evening: weight and
// reason per item, taken from the oldest batches first, saved in one go.
function BatchDialog({ onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options, error } = useOptions(["stock"]);
  const locations = biz.locations.filter((l) => l.active);
  const [locationId, setLocationId] = useState(String(locations[0]?.id || ""));
  const [requestKey] = useState(newKey);
  const [rows, setRows] = useState({});
  const lots = (options?.stock || []).filter((l) => Number(l.quantity) > 0 && l.tracking !== "serial" && String(l.location_id) === String(locationId));
  const items = [...lots.reduce((m, l) => {
    const item = m.get(String(l.sku_id)) || { id: String(l.sku_id), label: l.label, unit: l.unit, quantity: 0, cost: 0, expires: null };
    item.quantity += Number(l.quantity);
    item.cost += Number(l.quantity) * Number(l.unit_cost || 0);
    if (l.expires_on && (!item.expires || l.expires_on < item.expires)) item.expires = l.expires_on;
    return m.set(String(l.sku_id), item);
  }, new Map()).values()].sort((a, b) => a.label.localeCompare(b.label));
  const set = (id, name, value) => setRows((all) => ({ ...all, [id]: { reason: "unsold", ...all[id], [name]: value } }));
  const chosen = items.filter((i) => Number(rows[i.id]?.quantity) > 0);
  const value = chosen.reduce((s, i) => s + (Number(rows[i.id].quantity) * i.cost) / Math.max(i.quantity, 0.001), 0);
  const columns = [
    { key: "label", header: "Item", value: (i) => i.label, mobile: "title", render: (i) => <span>{i.label}<small className="muted" style={{ display: "block" }}>{weightOf(i.quantity, i.unit)} in stock{i.expires ? ` · use by ${dateShort(i.expires)}` : ""}</small></span> },
    { key: "quantity", header: "Wasted", type: "number", width: 130, value: (i) => Number(rows[i.id]?.quantity || 0),
      render: (i, ctx) => <input aria-label={ctx.label} type="number" min="0" max={i.quantity} step="0.001" inputMode="decimal" placeholder={i.unit} value={rows[i.id]?.quantity ?? ""} onChange={(e) => set(i.id, "quantity", e.target.value)} /> },
    { key: "reason", header: "Reason", width: 190, value: (i) => rows[i.id]?.reason || "unsold",
      render: (i, ctx) => (
        <select aria-label={ctx.label} value={rows[i.id]?.reason || "unsold"} onChange={(e) => set(i.id, "reason", e.target.value)}>
          {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      ) },
    { key: "note", header: "Note", value: (i) => rows[i.id]?.note || "",
      render: (i, ctx) => <input aria-label={ctx.label} maxLength={300} required={rows[i.id]?.reason === "other" && Number(rows[i.id]?.quantity) > 0} value={rows[i.id]?.note ?? ""} onChange={(e) => set(i.id, "note", e.target.value)} /> },
  ];
  return (
    <FormDialog title="End-of-day wastage" icon="trash" width={860} submitLabel={chosen.length ? `Write off ${chosen.length} item${chosen.length === 1 ? "" : "s"}` : "Write off"} onClose={onClose} onSaved={onSaved} disabled={!options}
      description="Type what is thrown away against each item; leave the rest empty. Oldest batches go first."
      onSubmit={() => businessWrite(biz.id, "weight/wastage/batch", { locationId, requestKey,
        entries: chosen.map((i) => ({ skuId: i.id, quantity: rows[i.id].quantity, reason: rows[i.id].reason || "unsold", note: rows[i.id].note || null })) })}>
      <FormError message={error} />
      {locations.length > 1 && (
        <Field label="Location"><select value={locationId} onChange={(e) => setLocationId(e.target.value)}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
      )}
      <div className="field-wide">
        <DataGrid variant="editor" caption="Wastage by item" columns={columns} rows={items} rowKey={(i) => i.id} currency={biz.symbol} rowNoun={["item", "items"]} />
      </div>
      <p className="sw-note field-wide">{chosen.length ? `About ${biz.exact(value)} at cost.` : "Nothing entered yet."}</p>
    </FormDialog>
  );
}

function WastageDialog({ start = {}, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options, error } = useOptions(["stock"]);
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ skuId: start.skuId ? String(start.skuId) : "", lotId: "", quantity: "", reason: "unsold", note: "" });
  const lots = (options?.stock || []).filter((l) => Number(l.quantity) > 0 && l.tracking !== "serial");
  const items = [...new Map(lots.map((l) => [String(l.sku_id), { id: String(l.sku_id), label: l.label, unit: l.unit }])).values()].sort((a, b) => a.label.localeCompare(b.label));
  const itemLots = lots.filter((l) => String(l.sku_id) === form.skuId).sort((a, b) => String(a.expires_on || "9999").localeCompare(String(b.expires_on || "9999")));
  const lotId = form.lotId || String(itemLots[0]?.id || "");
  const lot = itemLots.find((l) => String(l.id) === lotId);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const value = lot ? Number(lot.unit_cost) * Number(form.quantity || 0) : 0;
  return (
    <FormDialog title="Record wastage" icon="trash" width={600} submitLabel="Write off" onClose={onClose} onSaved={onSaved} disabled={!options}
      onSubmit={() => businessWrite(biz.id, "weight/wastage", { lotId, quantity: form.quantity, reason: form.reason, note: form.note || null, requestKey })}>
      <FormError message={error} />
      <Field label="Item">
        <select required value={form.skuId} onChange={(e) => {
          const first = lots.filter((l) => String(l.sku_id) === e.target.value).sort((a, b) => String(a.expires_on || "9999").localeCompare(String(b.expires_on || "9999")))[0];
          setForm((f) => ({ ...f, skuId: e.target.value, lotId: first ? String(first.id) : "" }));
        }}>
          <option value="">Choose…</option>
          {items.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
        </select>
      </Field>
      <Field label="Batch" hint="Oldest first">
        <select required value={lotId} onChange={set("lotId")}>
          {itemLots.map((l) => <option key={l.id} value={l.id}>{l.lot_code || "Loose stock"} · {weightOf(l.quantity, l.unit)}{l.expires_on ? ` · use by ${dateShort(l.expires_on)}` : ""}{l.expired ? " (expired)" : ""}</option>)}
        </select>
      </Field>
      <Field label={`Quantity wasted (${lot?.unit || "kg"})`} hint={lot ? `Up to ${weightOf(lot.quantity, lot.unit)}` : undefined}>
        <input required type="number" min="0.001" step="0.001" max={lot ? Number(lot.quantity) : undefined} value={form.quantity} onChange={set("quantity")} />
      </Field>
      <Field label="Reason">
        <select value={form.reason} onChange={set("reason")}>{REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select>
      </Field>
      <Field label="Note" wide hint={form.reason === "other" ? "Say what happened" : undefined}><input required={form.reason === "other"} maxLength={300} value={form.note} onChange={set("note")} /></Field>
      {lot && Number(form.quantity) > 0 && <p className="sw-note field-wide">Costs about {biz.exact(value)} at this batch&apos;s cost of {biz.exact(lot.unit_cost)} per {lot.unit}.</p>}
    </FormDialog>
  );
}
