import { useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SearchPicker from "../../../../components/SearchPicker";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import FormDialog from "./FormDialog";
import { ActiveBadge, BusinessHeader, Field } from "./ui";
import { useOpenBusiness, useServerList } from "./hooks";
import "../styles/kits-finance.css";

// Kits & bundles: a set of items (a service kit of oil and filters, a festive
// hamper) sold at one kit price. At the counter a kit sells as its parts:
// stock comes off each part, the price is split over the parts in proportion
// to their own prices (so GST and the HSN lines on the invoice are each
// part's), and the IMEI / serial of a serial-numbered part is asked for.

const parts = (kit) => kit.components.map((c) => `${Number(c.quantity) > 1 ? `${Number(c.quantity)} × ` : ""}${c.label}`).join(" + ");

export default function KitsPage() {
  const biz = useOpenBusiness();
  const { t } = biz;
  const list = useServerList("kits", { gridId: "business-kits" });
  const [editing, setEditing] = useState(null);
  const example = t.ex("kit");

  const columns = useMemo(() => [
    { key: "label", header: "Kit", value: (k) => k.label, mobile: "title", pin: true,
      render: (k) => <span className="bz-two-line"><strong>{k.label}</strong><small className="muted mono">{k.code}{k.barcode ? ` · ${k.barcode}` : ""}</small></span> },
    { key: "parts", header: "Parts", value: parts, mobile: "subtitle", minWidth: 260 },
    { key: "price", header: "Kit price", type: "money", exact: true, value: (k) => Number(k.price), mobile: "show" },
    { key: "parts_value", header: "Parts at their own prices", type: "money", exact: true, value: (k) => Number(k.parts_value) },
    { key: "saving", header: `${t("customer")} saves`, type: "money", exact: true, value: (k) => Math.max(0, Number(k.parts_value) - Number(k.price)) },
    { key: "available", header: "Can be made", type: "number", value: (k) => Number(k.available), mobile: "show" },
    { key: "active", header: "Status", type: "status", value: (k) => (k.active ? "active" : "inactive"), render: (k) => <ActiveBadge active={k.active} /> },
    biz.can("catalog.edit") && { key: "actions", header: "", label: "Actions", type: "actions", render: (k) => (
      <button type="button" className="chip-button" onClick={() => setEditing(k)}><Icon name="edit" size={14} /> Change</button>
    ) },
  ].filter(Boolean), [biz, t]);

  return (
    <div className="stack">
      <BusinessHeader icon="box" title="Kits & bundles"
        description={`Several items sold together at one price. At the ${t.lower("counter")} a kit takes stock from each part${biz.has("serials")
          ? ", splits its price over the parts for GST and asks the serial or IMEI number of a part that has one" : " and splits its price over the parts for GST"}.`}
        primary={biz.can("catalog.create") && <button type="button" className="button" onClick={() => setEditing({})}><Icon name="plus" size={16} /> New kit</button>} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="box" title="Kits">
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Kit name, code or barcode" }} caption="Kits and bundles" columns={columns}
          currency={biz.symbol} rowNoun={["kit", "kits"]} rowClassName={(k) => (k.active ? "" : "dg-tone-muted")}
          empty="No kits yet" emptyHint={`Make one from items you already sell${example ? `, e.g. ${example}` : ""}.`} emptyIcon="box" />
      </SectionCard>
      {editing && <KitDialog kit={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload(); }} />}
    </div>
  );
}

function KitDialog({ kit, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { t } = biz;
  const example = t.ex("kit");
  const [form, setForm] = useState(() => ({
    name: kit?.label || "", code: kit?.code || "", barcode: kit?.barcode || "", price: kit ? String(Number(kit.price)) : "",
    mrp: kit?.mrp ? String(Number(kit.mrp)) : "", active: kit ? kit.active : true,
  }));
  const [items, setItems] = useState(() => (kit?.components || []).map((c) => ({ skuId: c.skuId, label: c.label, price: Number(c.price), quantity: String(Number(c.quantity)), tracking: c.tracking, taxRate: c.taxRate, hsnCode: c.hsnCode })));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const value = items.reduce((s, c) => s + c.price * Number(c.quantity || 0), 0);
  const body = () => ({
    name: form.name, price: form.price, mrp: form.mrp || null, ...(kit ? { active: form.active } : { code: form.code, barcode: form.barcode || null }),
    components: items.map((c) => ({ skuId: c.skuId, quantity: c.quantity })),
  });
  return (
    <FormDialog title={kit ? `Change ${kit.label}` : "New kit"} icon="box" width={760} onClose={onClose} onSaved={onSaved}
      successMessage={kit ? "Kit saved" : "Kit added"}
      onSubmit={() => (kit ? businessWrite(biz.id, `kits/${kit.id}`, body(), "patch") : businessWrite(biz.id, "kits", body()))}
      description={`The kit's price is what the ${t.lower("customer")} pays for the whole set. Each part's share of it follows the parts' own prices.`}>
      <Field label="Kit name"><input required maxLength={150} value={form.name} onChange={set("name")} placeholder={example ? `e.g. ${example}` : undefined} /></Field>
      {!kit && <Field label="Kit code"><input required maxLength={60} value={form.code} onChange={set("code")} /></Field>}
      {!kit && <Field label="Barcode (optional)"><input maxLength={80} value={form.barcode} onChange={set("barcode")} /></Field>}
      <Field label={`Kit price (${biz.settings.tax_mode === "inclusive" ? "with GST" : "before GST"})`}><input required type="number" min="0" step="0.01" value={form.price} onChange={set("price")} /></Field>
      <Field label="MRP (optional)"><input type="number" min="0.01" step="0.01" value={form.mrp} onChange={set("mrp")} /></Field>
      {kit && <label className="checkbox bz-check"><input type="checkbox" checked={form.active} onChange={set("active")} /> Sold at the {t.lower("counter")}</label>}
      <div className="field-wide stack">
        <SearchPicker label="Add a part" placeholder="Item name, code or barcode" clearOnSelect minChars={2}
          search={(q, { signal }) => businessRead(biz.id, "catalog", { q, kind: "goods", active: "true", limit: 10 }, signal).then((page) => page.items.filter((s) => !s.is_kit))}
          getLabel={(s) => s.label} getDescription={(s) => `${s.code} · ${biz.exact(s.price)} · GST ${Number(s.tax_rate)}%${s.tracking === "serial" ? " · serial-numbered" : ""}`}
          isDisabled={(s) => items.some((c) => c.skuId === s.id)}
          onChange={(s) => s && setItems((all) => [...all, { skuId: s.id, label: s.label, price: Number(s.price), quantity: "1", tracking: s.tracking, taxRate: s.tax_rate, hsnCode: s.hsn_code }])} />
        {items.length === 0 ? <p className="muted small">Add the items in the kit.</p> : (
          <ul className="bz-kit-parts">
            {items.map((c) => (
              <li key={c.skuId}>
                <span className="bz-two-line"><strong>{c.label}</strong><small className="muted">{biz.exact(c.price)} · GST {Number(c.taxRate)}%{c.hsnCode ? ` · HSN ${c.hsnCode}` : ""}{c.tracking === "serial" ? ` · IMEI / serial asked at the ${t.lower("counter")}` : ""}</small></span>
                <input aria-label={`Quantity of ${c.label}`} type="number" min="0.001" step="any" value={c.quantity} disabled={c.tracking === "serial"}
                  onChange={(e) => setItems((all) => all.map((x) => (x.skuId === c.skuId ? { ...x, quantity: e.target.value } : x)))} />
                <button type="button" className="icon-button" aria-label={`Remove ${c.label}`} onClick={() => setItems((all) => all.filter((x) => x.skuId !== c.skuId))}><Icon name="x" size={14} /></button>
              </li>
            ))}
          </ul>
        )}
        {items.length > 0 && (
          <p className="small">Parts at their own prices: <strong>{biz.exact(value)}</strong>
            {Number(form.price) > 0 && value > Number(form.price) ? <> · the {t.lower("customer")} saves <strong>{biz.exact(value - Number(form.price))}</strong></> : null}</p>
        )}
      </div>
    </FormDialog>
  );
}
