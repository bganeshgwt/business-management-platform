import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage } from "../../../../components/Feedback";
import useConfirm from "../../../../hooks/useConfirm";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { businessPath } from "../../../../services/businessNav";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "../../../../services/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, newKey, quantity, useOpenBusiness } from "../../core/pages/hooks";
import "../styles/business-retail.css";

// Expiring soon (pro pass C-14): every batch with stock that runs out of date
// within 7, 30 or 60 days — the expired ones first — with what it cost, and
// the two things a supermarket does about it: mark it down (an item % offer
// that ends on the batch's date; the shelf price never changes) or write it
// off (a stock correction with the reason, at the batch's cost).
const WINDOWS = [7, 30, 60];

function daysWord(days) {
  if (days < 0) return days === -1 ? "Expired yesterday" : `Expired ${-days} days ago`;
  if (days === 0) return "Expires today";
  if (days === 1) return "1 day left";
  return `${days} days left`;
}
const tone = (days) => (days < 0 ? "danger" : days <= 7 ? "warning" : "info");

export default function NearExpiryPage() {
  const biz = useOpenBusiness();
  const confirm = useConfirm();
  // Opens on the business's own "expiring soon" (Business settings › Rules).
  const [days, setDays] = useState(() => Number(biz.settings.near_expiry_days) || 30);
  const [location, setLocation] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [marking, setMarking] = useState(null);
  const reload = useCallback(() => setVersion((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "retail/near-expiry", { days, ...(location ? { location } : {}) }, controller.signal)
      .then((result) => { setData(result); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, days, location, version]);

  const canMark = biz.has("offers") && biz.can("offers.create");
  const canWriteOff = biz.can("inventory.edit");

  const writeOff = useCallback(async (lot) => {
    const expired = Number(lot.days_left) < 0;
    const ok = await confirm({
      title: `Write off ${quantity(lot.quantity, lot.unit)} of ${lot.label}?`,
      message: `Batch ${lot.lot_code || "(no batch)"} at ${lot.location_name} leaves stock at its cost of ${biz.exact(lot.cost_value)}. The stock movements keep the reason.`,
      confirmLabel: "Write off", cancelLabel: "Keep it",
    });
    if (!ok) return;
    try {
      await businessWrite(biz.id, `stock/${lot.id}/adjustments`, {
        quantity: `-${Number(lot.quantity)}`, requestKey: newKey(),
        reason: expired ? `Expired on ${dateShort(lot.expires_on, { year: true })}: written off` : `Near expiry (${dateShort(lot.expires_on, { year: true })}): written off`,
      });
      toast.success(`${lot.label} written off`);
      reload();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }, [biz, confirm, reload]);

  const columns = useMemo(() => [
    { key: "label", header: "Item", value: (l) => l.label, mobile: "title", pin: true,
      render: (l) => <span className="bz-two-line"><strong>{l.label}</strong><small className="muted mono">{l.code}</small></span> },
    { key: "expires_on", header: "Expiry", type: "date", value: (l) => l.expires_on, mobile: "subtitle",
      render: (l) => <span className="bz-inline">{dateShort(l.expires_on)} <Badge tone={tone(Number(l.days_left))} label={daysWord(Number(l.days_left))} /></span> },
    { key: "lot", header: "Batch", value: (l) => l.lot_code || "", className: "mono", mobile: "show" },
    { key: "location", header: "Location", value: (l) => l.location_name, defaultHidden: biz.locations.length < 2 },
    { key: "quantity", header: "On hand", type: "number", value: (l) => Number(l.quantity), render: (l) => quantity(l.quantity, l.unit), mobile: "show" },
    { key: "cost_value", header: "At cost", type: "money", exact: true, value: (l) => Number(l.cost_value), total: "sum", mobile: "show" },
    { key: "shelf_value", header: "At shelf price", type: "money", exact: true, value: (l) => Number(l.shelf_value), total: "sum", defaultHidden: true },
    { key: "markdown", header: "Markdown", value: (l) => (l.markdown ? `${Number(l.markdown.value)}% off` : ""),
      render: (l) => (l.markdown ? <Badge tone="info" label={`${Number(l.markdown.value)}% off${l.markdown.ends_on ? ` till ${dateShort(l.markdown.ends_on)}` : ""}`} /> : <span className="muted">—</span>) },
    (canMark || canWriteOff) && { key: "actions", header: "", label: "Actions", type: "actions", width: 200, render: (l) => (
      <span className="bz-inline">
        {canMark && Number(l.days_left) >= 0 && !l.markdown && <button type="button" className="chip-button" onClick={() => setMarking(l)}>Mark down</button>}
        {canWriteOff && <button type="button" className="chip-button rt-danger" onClick={() => writeOff(l)}>Write off</button>}
      </span>
    ) },
  ].filter(Boolean), [biz, canMark, canWriteOff, writeOff]);

  const totals = data?.totals;
  return (
    <div className="stack">
      <BusinessHeader icon="clock" title="Expiring soon"
        description="Batches with stock that run out of date soon, the expired ones first. Mark one down to sell it in time, or write it off."
        actions={<Link className="button button-secondary" to={businessPath(biz.id, "stock")}><Icon name="box" size={15} /> Stock on hand</Link>} />
      <ErrorMessage message={error} />
      <div className="stat-grid bz-stat-grid">
        <StatTile icon="alert" label="Expired, still on the shelf" value={totals ? String(totals.expired) : ""} loading={!totals} note={totals ? `${biz.amount(totals.expiredCost)} at cost` : undefined} />
        <StatTile icon="clock" label="Expire within 7 days" value={totals ? String(totals.within7) : ""} loading={!totals} />
        <StatTile icon="box" label={`Batches within ${days} days`} value={totals ? String(totals.batches) : ""} loading={!totals} />
        <StatTile icon="money" label="Their value at cost" money={totals ? Number(totals.costValue) : undefined} loading={!totals} />
      </div>
      <SectionCard flush icon="list" title={`Expiring within ${days} days`}>
        <DataGrid id="business-near-expiry" caption="Batches expiring soon" rows={data?.rows || []} loading={!data && !error} columns={columns} currency={biz.symbol}
          rowNoun={["batch", "batches"]} rowClassName={(l) => (Number(l.days_left) < 0 ? "dg-tone-danger" : Number(l.days_left) <= 7 ? "dg-tone-warning" : "")}
          toolbar={(
            <>
              <div className="segmented" role="group" aria-label="Expiring within">
                {[...new Set([...WINDOWS, Number(biz.settings.near_expiry_days) || 30])].sort((x, y) => x - y).map((n) => (
                  <button key={n} type="button" className={`segment ${days === n ? "is-active" : ""}`} aria-pressed={days === n} onClick={() => setDays(n)}>{n} days</button>
                ))}
              </div>
              {biz.locations.length > 1 && (
                <label className="field">
                  <span>Location</span>
                  <select value={location} onChange={(e) => setLocation(e.target.value)}>
                    <option value="">All locations</option>
                    {biz.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </label>
              )}
            </>
          )}
          exportName={biz.can("inventory.export") ? `${biz.business.code}-expiring` : undefined}
          empty={`Nothing expires within ${days} days`} emptyHint="Batch items get their expiry date when a purchase is received." emptyIcon="clock" />
      </SectionCard>
      {marking && <MarkdownDialog lot={marking} onClose={() => setMarking(null)} onSaved={() => { setMarking(null); reload(); }} />}
    </div>
  );
}

// A markdown for one item until its batch's date: an ordinary "% off an item"
// offer, so it shows on the bill and ends by itself.
function MarkdownDialog({ lot, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [form, setForm] = useState({ value: Number(lot.days_left) <= 3 ? "30" : "15", endsOn: String(lot.expires_on).slice(0, 10) });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const price = Number(lot.price);
  const after = price * (1 - Number(form.value || 0) / 100);
  return (
    <FormDialog title={`Mark down ${lot.label}`} icon="discounts" width={520} onClose={onClose} onSaved={onSaved} submitLabel="Start markdown"
      successMessage={`${lot.label}: ${form.value}% off till ${dateShort(form.endsOn)}`}
      description={`Every batch of this item sells at the lower price until the last day; the shelf price stays ${biz.exact(price)}. Batch ${lot.lot_code || "—"} expires ${dateShort(lot.expires_on, { year: true })}.`}
      onSubmit={() => businessWrite(biz.id, "offers", { name: `Near expiry: ${lot.label}`.slice(0, 120), kind: "item_percent", skuId: lot.sku_id, value: form.value, startsOn: today, endsOn: form.endsOn })}>
      <Field label="Discount %" hint={Number(form.value) > 0 ? `Sells at ${biz.exact(after)} instead of ${biz.exact(price)}` : undefined}>
        <input required type="number" min="1" max="90" step="1" value={form.value} onChange={set("value")} />
      </Field>
      <Field label="Last day" hint="The offer ends by itself after this day.">
        <input required type="date" min={today} value={form.endsOn} onChange={set("endsOn")} />
      </Field>
    </FormDialog>
  );
}
