import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { monthStart } from "@bmp/shared/dates";
import { dateShort, dateTime } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { BusinessHeader, FormError } from "../../core/pages/ui";
import { businessToday, newKey, quantity, useOpenBusiness } from "../../core/pages/hooks";
import "../styles/agri.css";

// Subsidised fertiliser against the government's PoS device. A subsidised
// fertiliser is sold on the PoS device (after the farmer's thumb check) and
// on the bill; each bill line keeps the PoS receipt number. There is no link
// to the PoS or iFMS, so the shop reconciles here: for each day and product,
// the bags billed against the PoS receipts, and the stock the PoS device shows
// (typed in) against the shop's own stock at that moment.

const diffWords = (d) => { const n = Number(d); return n === 0 ? "Matches" : n > 0 ? `${n} more here` : `${-n} more on the PoS`; };

export default function SubsidyPage() {
  const biz = useOpenBusiness();
  const [params, setParams] = useSearchParams();
  const anchor = businessToday(biz.business.timezone);
  const locations = biz.locations.filter((l) => l.active);
  const [locationId, setLocationId] = useState(String(biz.currentLocationId || locations[0]?.id || ""));
  const [range, setRange] = useState(() => ({ from: monthStart(anchor), to: anchor }));
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [checking, setChecking] = useState(() => params.get("check") === "1" && biz.can("agri.create"));
  useEffect(() => {
    if (params.get("check")) setParams((p) => { const next = new URLSearchParams(p); next.delete("check"); return next; }, { replace: true });
  }, [params, setParams]);
  useEffect(() => {
    if (!locationId) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "agri/subsidy", { locationId, ...range }, controller.signal)
      .then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, locationId, range, version]);
  const t = data?.totals;
  const columns = useMemo(() => [
    { key: "day", header: "Day", type: "date", value: (r) => r.day, mobile: "subtitle", pin: true },
    { key: "label", header: "Fertiliser", value: (r) => r.label, mobile: "title" },
    { key: "bills", header: "Bills", type: "number", value: (r) => r.bills, total: "sum" },
    { key: "sold", header: "Billed", type: "number", value: (r) => Number(r.sold), render: (r) => quantity(r.sold, r.unit), total: "sum", mobile: "show" },
    { key: "receipts", header: "PoS receipts", type: "number", value: (r) => r.receipts, total: "sum" },
    { key: "returned", header: "Came back", type: "number", value: (r) => Number(r.returned), render: (r) => (Number(r.returned) ? quantity(r.returned, r.unit) : <span className="muted">—</span>) },
    { key: "pos_stock", header: "PoS stock", type: "number", value: (r) => (r.pos_stock === null ? null : Number(r.pos_stock)),
      render: (r) => (r.pos_stock === null ? <span className="muted">Not typed in</span> : quantity(r.pos_stock, r.unit)) },
    { key: "app_stock", header: "Shop stock then", type: "number", value: (r) => (r.app_stock === null ? null : Number(r.app_stock)),
      render: (r) => (r.app_stock === null ? <span className="muted">—</span> : quantity(r.app_stock, r.unit)) },
    { key: "difference", header: "Difference", type: "number", value: (r) => (r.difference === null ? null : Number(r.difference)),
      render: (r) => (r.difference === null ? <span className="muted">—</span> : <span className={Number(r.difference) === 0 ? "agri-match" : "agri-differ"}>{diffWords(r.difference)}</span>) },
    { key: "checked_at", header: "Typed in", type: "datetime", value: (r) => r.checked_at, defaultHidden: true },
  ], []);
  return (
    <div className="stack">
      <BusinessHeader icon="scale" title="Subsidy PoS reconciliation"
        description="Subsidised fertiliser is sold on the government's PoS device and on the bill, and each bill keeps the PoS receipt number. Here the bags billed are set against the receipts day by day, and the PoS device's stock against the shop's own."
        primary={biz.can("agri.create") && <button type="button" className="button" onClick={() => setChecking(true)} disabled={!locationId}><Icon name="clipboard" size={16} /> Type the PoS stock</button>} />
      <div className="stat-grid bz-stat-grid">
        <StatTile icon="box" tone="primary" label="Bags billed" value={t ? quantity(t.sold) : ""} loading={!t && !error} note={t ? `on ${t.bills} bill${t.bills === 1 ? "" : "s"}` : undefined} />
        <StatTile icon="receipt" label="PoS receipts" value={t ? String(t.receipts) : ""} loading={!t && !error} />
        <StatTile icon="undo" label="Came back" value={t ? quantity(t.returned) : ""} loading={!t && !error} />
        <StatTile icon="alert" tone={t?.differences ? "warning" : undefined} label="Stock not matching" value={t ? String(t.differences) : ""} loading={!t && !error} note="days and products where the PoS stock differs" />
      </div>
      <SectionCard flush icon="scale" title="Day by day">
        <DataGrid id="agri-subsidy" caption="Subsidised fertiliser by day" columns={columns} rows={data?.rows || []} rowKey={(r) => `${r.day}-${r.sku_id}`}
          loading={!data && !error} error={data ? "" : error} onRetry={() => setVersion((n) => n + 1)} rowNoun={["day", "days"]}
          rowClassName={(r) => (r.difference !== null && Number(r.difference) !== 0 ? "dg-tone-warning" : "")}
          exportName={biz.can("reports.export") ? `${biz.business.code}-pos-reconciliation-${range.from}-${range.to}` : undefined}
          toolbar={(
            <>
              {locations.length > 1 && (
                <label className="field">
                  <span>Location</span>
                  <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                    {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </label>
              )}
              <DateRangeFilter from={range.from} to={range.to} anchor={anchor} label="days" onChange={(next) => next.from && next.to && setRange(next)} />
            </>
          )}
          empty="Nothing subsidised billed or typed in" emptyHint="Mark a fertiliser as subsidised on its item; each bill of it then keeps the PoS receipt and shows here." emptyIcon="scale" />
      </SectionCard>
      {checking && <PosStockDialog locationId={locationId} locationName={locations.find((l) => String(l.id) === String(locationId))?.name} onClose={() => setChecking(false)}
        onSaved={(check) => {
          setChecking(false);
          const differ = check.lines.filter((l) => Number(l.difference) !== 0);
          if (differ.length) toast.warning(`PoS stock saved. ${differ.map((l) => `${l.label}: ${diffWords(l.difference)}`).join("; ")}.`);
          else toast.success("PoS stock saved. It matches the shop's stock.");
          setVersion((n) => n + 1);
        }} />}
    </div>
  );
}

// The PoS device's stock now, for each subsidised fertiliser at the location, against the shop's.
function PosStockDialog({ locationId, locationName, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [typed, setTyped] = useState({});
  const [notes, setNotes] = useState("");
  const [requestKey] = useState(newKey);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "agri/subsidy/products", { locationId }, controller.signal)
      .then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, locationId]);
  const items = data?.items || [];
  const submit = () => {
    const lines = items.filter((i) => typed[i.id] !== undefined && typed[i.id] !== "").map((i) => ({ skuId: i.id, posStock: typed[i.id] }));
    if (!lines.length) throw new Error("Type the PoS stock of at least one fertiliser.");
    return businessWrite(biz.id, "agri/subsidy/checks", { requestKey, locationId, lines, notes: notes.trim() || undefined });
  };
  return (
    <FormDialog title="Type the PoS stock" icon="clipboard" width={720} onClose={onClose} onSaved={onSaved} onSubmit={submit} disabled={!data}
      submitLabel="Save the PoS stock" description={`${locationName || "This location"}, ${dateShort(businessToday(biz.business.timezone), { year: true })}. Read each subsidised fertiliser's stock off the PoS device; it is kept with the shop's own stock at this moment.`}>
      <FormError message={error} />
      {!data && !error && <div className="field-wide"><Loading /></div>}
      {data && !items.length && <p className="field-wide muted">No subsidised fertiliser here. Mark a fertiliser as subsidised on its item (Products), then type its PoS stock.</p>}
      {items.length > 0 && (
        <table className="field-wide agri-pos-table">
          <thead><tr><th>Fertiliser</th><th className="r">Shop stock now</th><th className="r">PoS device shows</th><th>Last typed in today</th></tr></thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <th scope="row">{i.label}</th>
                <td className="r">{quantity(i.stock, i.unit)}</td>
                <td className="r"><input type="number" min="0" step={i.unit_decimals ? String(10 ** -i.unit_decimals) : "1"} inputMode="decimal" aria-label={`PoS stock of ${i.label}`}
                  value={typed[i.id] ?? ""} onChange={(e) => setTyped((all) => ({ ...all, [i.id]: e.target.value }))} /> <small className="muted">{i.unit}</small></td>
                <td>{i.today ? <small className="muted">{quantity(i.today.pos_stock, i.unit)} at {dateTime(i.today.checked_at)}</small> : <small className="muted">Not yet</small>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <label className="field field-wide"><span>Notes (optional)</span><input maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. read off the PoS at closing" /></label>
    </FormDialog>
  );
}
