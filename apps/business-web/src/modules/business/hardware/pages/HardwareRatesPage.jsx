import { useCallback, useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SearchPicker from "../../../../components/SearchPicker";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateLong, dateTime, relative } from "@bmp/shared/format";
import { escapeHtml, printDocument } from "../../../../services/print";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { BusinessHeader, FormError } from "../../core/pages/ui";
import { businessToday, useDirtyGuard, useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { whatsappLink } from "../../retail/pages/retail";
import "../styles/hardware.css";

// Today's rates: the items whose price moves every day (cement, steel,
// pipes, cable) on one board. Type today's rates and save them together:
// each goes through the item's own price change (MRP checked, kept in the
// activity log), and bills and new quotations use it at once. Share the list
// on WhatsApp or print it for the counter.

const cents = (value) => Math.round(Number(value) * 100);

export default function HardwareRatesPage() {
  const biz = useOpenBusiness();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const reload = useCallback(() => setVersion((n) => n + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "hardware/rates", undefined, controller.signal)
      .then((r) => { setData(r); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);
  const items = useMemo(() => data?.items || [], [data]);
  const typed = (r) => draft[r.id] !== undefined && draft[r.id] !== "";
  const rateOf = (r) => (typed(r) ? Number(draft[r.id]) : Number(r.price));
  const changed = items.filter((r) => typed(r) && cents(draft[r.id]) !== cents(r.price));
  useDirtyGuard(changed.length > 0);
  const canEdit = biz.can("catalog.edit");
  const inclusive = data?.taxMode === "inclusive";
  const today = businessToday(biz.business.timezone);

  const listText = (list) => [`*${biz.business.name}*`, `Today's rates, ${dateLong(today)}`, "",
    ...list.map((r) => `${r.label}: ${biz.exact(r.price)} per ${r.unit}`), "", inclusive ? "Rates include GST." : "GST is added to these rates."].join("\n");
  const share = (list = items) => window.open(whatsappLink("", listText(list)), "_blank", "noopener");
  const print = () => {
    const body = `<div class="rates"><h1>${escapeHtml(biz.business.name)}</h1><p>Today's rates · ${escapeHtml(dateLong(today))}</p>
      <table><tbody>${items.map((r) => `<tr><th>${escapeHtml(r.label)}</th><td>${escapeHtml(biz.exact(rateOf(r)))} per ${escapeHtml(r.unit)}</td></tr>`).join("")}</tbody></table>
      <p class="note">${inclusive ? "Rates include GST." : "GST is added to these rates."}</p></div>`;
    printDocument({ title: "Today's rates", body, styles: `@page { size: A5; } .rates { font: 16px/1.4 system-ui, sans-serif; color: #000; }
      .rates h1 { font-size: 22px; margin: 0; } .rates table { width: 100%; border-collapse: collapse; margin-top: 10px; }
      .rates th, .rates td { padding: 8px 4px; border-bottom: 1px solid #999; text-align: left; font-size: 18px; } .rates td { text-align: right; font-weight: 700; }
      .rates .note { font-size: 13px; margin-top: 10px; }` });
  };
  const save = async () => {
    setBusy(true);
    try {
      const saved = items.map((r) => (typed(r) ? { ...r, price: Number(draft[r.id]).toFixed(2) } : r));
      const result = await businessWrite(biz.id, "hardware/rates", { rates: changed.map((r) => ({ skuId: r.id, price: Number(draft[r.id]).toFixed(2), was: r.price })) }, "put");
      toast.success(`${result.changed.length} rate${result.changed.length === 1 ? "" : "s"} saved. Bills and new quotations use them now.`,
        { action: { label: "Share the list", onClick: () => share(saved) } });
      setDraft({});
      reload();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const takeOff = async (r) => {
    try {
      await businessWrite(biz.id, `hardware/rates/items/${r.id}`, undefined, "delete");
      toast.success(`${r.label} is off the board.`);
      setDraft((all) => { const next = { ...all }; delete next[r.id]; return next; });
      reload();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  const columns = [
    { key: "label", header: "Item", value: (r) => r.label, mobile: "title", minWidth: 200,
      render: (r) => <span className="bz-two-line"><span>{r.label}</span><small className="muted">{[r.category_name, r.code].filter(Boolean).join(" · ")}</small></span> },
    { key: "price", header: "Today's rate", type: "number", width: 190, value: (r) => rateOf(r), mobile: "show",
      render: (r, ctx) => (canEdit ? (
        <span className="hw-rate">
          <input aria-label={ctx.label} type="number" min="0.01" step="0.01" inputMode="decimal" value={draft[r.id] ?? String(Number(r.price))}
            className={typed(r) && cents(draft[r.id]) !== cents(r.price) ? "is-changed" : ""}
            onChange={(e) => setDraft((all) => ({ ...all, [r.id]: e.target.value }))} />
          <small className="muted">per {r.unit}</small>
        </span>
      ) : `${biz.exact(r.price)} per ${r.unit}`) },
    { key: "previous_price", header: "Before", type: "money", exact: true, value: (r) => (r.previous_price === null ? null : Number(r.previous_price)),
      render: (r) => (r.previous_price === null ? <span className="muted">—</span> : biz.exact(r.previous_price)) },
    { key: "change", header: "Last change", type: "number", value: (r) => (r.previous_price === null ? null : Number(r.price) - Number(r.previous_price)),
      render: (r) => {
        if (r.previous_price === null) return <span className="muted">—</span>;
        const diff = Number(r.price) - Number(r.previous_price);
        const pct = Number(r.previous_price) ? Math.abs((100 * diff) / Number(r.previous_price)).toFixed(1) : null;
        return <span className={diff > 0 ? "hw-up" : diff < 0 ? "hw-down" : "muted"}>{diff > 0 ? "▲ " : diff < 0 ? "▼ " : ""}{biz.exact(Math.abs(diff))}{pct ? ` (${pct}%)` : ""}</span>;
      } },
    { key: "price_changed_at", header: "Changed", type: "datetime", value: (r) => r.price_changed_at, mobile: "subtitle",
      render: (r) => (r.price_changed_at ? <span title={dateTime(r.price_changed_at)}>{relative(r.price_changed_at)}</span> : <span className="muted" title="Not changed since it was put on the board">Not yet</span>) },
    { key: "mrp", header: "MRP", type: "money", exact: true, value: (r) => (r.mrp === null ? null : Number(r.mrp)), defaultHidden: !items.some((r) => r.mrp !== null),
      render: (r) => (r.mrp === null ? <span className="muted">—</span> : biz.exact(r.mrp)) },
    canEdit && { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => <button type="button" className="chip-button" onClick={() => takeOff(r)}>Take off the board</button> },
  ].filter(Boolean);

  return (
    <div className="stack">
      <BusinessHeader icon="tag" title="Today's rates"
        description={`The items whose price changes every day, on one board${inclusive ? " (rates include GST)" : ""}. Type today's rates and save them together: bills and new quotations use them at once.`}
        primary={canEdit && <button type="button" className="button" onClick={save} disabled={!changed.length || busy}><Icon name="check" size={16} /> {busy ? "Saving…" : changed.length ? `Save ${changed.length} rate${changed.length === 1 ? "" : "s"}` : "Save rates"}</button>}
        secondary={<button type="button" className="button button-secondary" onClick={() => share()} disabled={!items.length}><Icon name="message" size={16} /> Share today's rates</button>}
        more={[{ label: "Print the rate list (A5)", icon: "print", onClick: print, disabled: !items.length }]} />
      <ErrorMessage message={error} />
      {changed.length > 0 && (
        <p className="small hw-unsaved"><strong>{changed.length} rate{changed.length === 1 ? "" : "s"} not saved yet.</strong> <button type="button" className="link-button" onClick={() => setDraft({})}>Undo the changes</button></p>
      )}
      <SectionCard flush icon="tag" title={`${items.length} item${items.length === 1 ? "" : "s"} on the board`}
        actions={canEdit && <button type="button" className="button button-sm" onClick={() => setAdding(true)}><Icon name="plus" size={15} /> Put items on the board</button>}>
        <DataGrid id="hardware-rates" variant="editor" caption="Today's rates" columns={columns} rows={items} rowKey={(r) => r.id} loading={!data && !error} currency={biz.symbol}
          rowNoun={["item", "items"]} pageSize={false}
          empty="Nothing on the board yet" emptyHint="Put the items whose price changes every day on the board: cement, steel, pipes, cable." emptyIcon="tag" />
      </SectionCard>
      {adding && <AddItems onBoard={new Set(items.map((r) => String(r.id)))} most={data?.most || 300} onClose={() => setAdding(false)}
        onSaved={(r) => { setAdding(false); toast.success(r.added ? `${r.added} item${r.added === 1 ? "" : "s"} put on the board.` : "Those items were on the board already."); reload(); }} />}
    </div>
  );
}

function AddItems({ onBoard, most, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options, error } = useOptions(["catalog?active=true"]);
  const [chosen, setChosen] = useState([]);
  const left = (options?.["catalog?active=true"] || []).filter((s) => !onBoard.has(String(s.id)) && !chosen.some((c) => c.id === s.id));
  const submit = () => {
    if (!chosen.length) throw new Error("Choose at least one item.");
    return businessWrite(biz.id, "hardware/rates/items", { skuIds: chosen.map((s) => s.id) });
  };
  return (
    <FormDialog title="Put items on the board" icon="plus" width={600} onClose={onClose} onSaved={onSaved} onSubmit={submit} disabled={!options}
      submitLabel={chosen.length ? `Put ${chosen.length} item${chosen.length === 1 ? "" : "s"} on the board` : "Put on the board"}
      description={`The items whose price changes often: cement, steel, pipes, cable. The board holds up to ${most}.`}>
      <FormError message={error} />
      <div className="field field-wide">
        <SearchPicker label="Item" options={left} onChange={(s) => s && setChosen((all) => (all.length < 100 ? [...all, s] : all))} clearOnSelect
          getKey={(s) => s.id} getLabel={(s) => s.label} getKeywords={(s) => `${s.code || ""} ${s.barcode || ""}`}
          getDescription={(s) => [s.code, `${biz.exact(s.price)} per ${s.unit}`].filter(Boolean).join(" · ")} placeholder="Type the item's name or code" />
      </div>
      {chosen.length > 0 && (
        <ul className="field-wide hw-chosen">
          {chosen.map((s) => (
            <li key={s.id}><span>{s.label}</span> <button type="button" className="link-button" onClick={() => setChosen((all) => all.filter((x) => x.id !== s.id))}>Remove</button></li>
          ))}
        </ul>
      )}
    </FormDialog>
  );
}
