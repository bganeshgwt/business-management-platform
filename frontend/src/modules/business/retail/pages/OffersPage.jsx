import { useEffect, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import Icon from "../../../../components/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { monthStart } from "../../../../services/dates";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field, FormError } from "../../core/pages/ui";
import { businessToday, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { OFFER_KINDS, dateWords, offerHoursWords, offerSummary, offerWhen } from "./retail";
import "../styles/business-retail.css";

// Offers & discounts. The server applies them when a bill is made (Quick
// bill and Sales): each item gets its single best item offer, then the bill
// gets its single best bill offer. Changing an offer never changes a bill
// already made — each bill keeps what it was given.

const STATUS = { running: ["active", "Running now"], waiting: ["info", "Running, outside its hours"], scheduled: ["info", "Starts later"], ended: ["inactive", "Ended"], off: ["inactive", "Switched off"] };
const FILTERS = [["", "All"], ["running", "Running"], ["scheduled", "Starts later"], ["ended", "Ended"], ["off", "Off"]];
const WEEKDAYS = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [7, "Sun"]];
const PERCENT_KINDS = new Set(["item_percent", "category_percent", "bill_percent", "buy_x_get_y"]);

export default function OffersPage() {
  const biz = useOpenBusiness();
  const [status, setStatus] = useState("");
  const list = useServerList("offers", { gridId: "retail-offers", params: status ? { status } : {} });
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const anchor = businessToday(biz.business.timezone);
  const [range, setRange] = useState({ from: monthStart(anchor), to: anchor });
  const [given, setGiven] = useState(null);
  const [version, setVersion] = useState(0);
  const canSeeSales = biz.can("sales.view");

  useEffect(() => {
    if (!canSeeSales) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "offers/given", range, controller.signal).then(setGiven).catch(() => {});
    return () => controller.abort();
  }, [biz.id, range, version, canSeeSales]);

  async function toggle(offer) {
    setError("");
    try {
      await businessWrite(biz.id, `offers/${offer.id}`, { active: !offer.active }, "patch");
      setNotice(`${offer.name} ${offer.active ? "switched off" : "switched on"}.`);
      list.reload();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  // Offers are a short list: plain columns are fine here.
  const columns = [
    { key: "name", header: "Offer", value: (o) => o.name, mobile: "title", pin: true,
      render: (o) => <span className="bz-two-line"><strong>{o.name}</strong><small className="muted">{offerSummary(o, biz.amount)}</small></span> },
    { key: "kind", header: "Type", value: (o) => OFFER_KINDS[o.kind], filter: "select" },
    { key: "when", header: "When", value: (o) => `${o.starts_on}`, render: (o) => (
      <span className="bz-two-line"><span>{dateWords(o.starts_on)}{o.ends_on ? ` – ${dateWords(o.ends_on)}` : " onwards"}</span><small className="muted">{offerWhen(o)}</small></span>
    ), mobile: "show" },
    { key: "status", header: "Status", type: "status", value: (o) => o.status, render: (o) => <Badge tone={STATUS[o.status]?.[0]} label={o.status === "waiting" ? offerHoursWords(o) : STATUS[o.status]?.[1] || o.status} />, mobile: "subtitle" },
    { key: "bills", header: "Bills", type: "number", value: (o) => o.bills, total: "sum" },
    { key: "given", header: "Given away", type: "money", exact: true, value: (o) => Number(o.given), total: "sum", mobile: "show" },
    (biz.can("offers.edit")) && { key: "actions", header: "", label: "Actions", type: "actions", render: (o) => (
      <div className="row-actions">
        <button type="button" className="chip-button" onClick={() => setEditing(o)}>Edit</button>
        <button type="button" className="chip-button" onClick={() => toggle(o)}>{o.active ? "Switch off" : "Switch on"}</button>
      </div>
    ) },
  ].filter(Boolean);

  const running = (list.data?.items || []).filter((o) => o.status === "running").length;
  const givenTotal = (given?.rows || []).reduce((s, r) => s + Number(r.given), 0);

  return (
    <div className="stack">
      <BusinessHeader icon="gift" title="Offers & discounts"
        description="Set them once; the bill applies them by itself. Each item gets its best item offer, then the bill its best bill offer, then any points the customer redeems."
        actions={biz.can("offers.create") && <button type="button" className="button" onClick={() => setEditing({})}><Icon name="plus" size={16} /> New offer</button>} />
      <SuccessMessage message={notice} />
      <ErrorMessage message={error || list.error} />
      <div className="stat-grid">
        <StatTile icon="gift" tone="primary" label="Running now" value={list.data ? String(running) : "—"} note={status ? "in this view" : `of ${list.data?.total ?? "—"} offers`} />
        {canSeeSales && <StatTile icon="percent" tone="success" label="Given away" value={given ? biz.amount(givenTotal) : "—"} note="in the dates below" />}
        {canSeeSales && <StatTile icon="receipt" label="Bills with an offer" value={given ? `${given.totals.bills_with_offers} of ${given.totals.bills}` : "—"} note="in the dates below" />}
      </div>
      <SectionCard flush icon="list" title="Offers">
        <DataGrid {...list.gridProps} caption="Offers" columns={columns} currency={biz.symbol} rowNoun={["offer", "offers"]}
          toolbar={(
            <div className="segmented" role="group" aria-label="Which offers">
              {FILTERS.map(([key, label]) => <button key={key || "all"} type="button" className={`segment ${status === key ? "is-active" : ""}`} aria-pressed={status === key} onClick={() => setStatus(key)}>{label}</button>)}
            </div>
          )}
          rowClassName={(o) => (o.status === "off" || o.status === "ended" ? "dg-tone-muted" : "")}
          empty="No offers yet" emptyHint="Add one: 10% off a category, buy 2 get 1, ₹50 off bills over ₹1,000…" emptyIcon="gift"
          emptyAction={biz.can("offers.create") && <button type="button" className="button button-secondary" onClick={() => setEditing({})}>New offer</button>} />
      </SectionCard>
      {canSeeSales && (
        <SectionCard flush icon="chart" title="What offers gave away" description="By the day each bill was made. Points redeemed are shown as their own line.">
          {!given && <Loading />}
          {given && (
            <DataGrid id="retail-offers-given" caption="Given away by offer" rows={given.rows.map((r) => ({ ...r, id: r.key }))} currency={biz.symbol} rowNoun={["offer", "offers"]}
              toolbar={<DateRangeFilter from={range.from} to={range.to} anchor={anchor} label="offer dates" onChange={(next) => { if (next.from && next.to) setRange(next); }} />}
              exportName={biz.can("reports.export") ? `${biz.business.code}-offers-given` : undefined}
              columns={[
                { key: "label", header: "Offer", value: (r) => (r.source === "points" ? "Loyalty points redeemed" : r.label), mobile: "title" },
                { key: "bills", header: "Bills", type: "number", value: (r) => r.bills, total: "sum", mobile: "show" },
                { key: "given", header: "Given away", type: "money", exact: true, value: (r) => Number(r.given), total: "sum", mobile: "show" },
                { key: "sold_after", header: "Those lines sold for", type: "money", exact: true, value: (r) => Number(r.sold_after), total: "sum" },
              ]}
              empty="No offer was used in these dates" emptyIcon="gift" />
          )}
        </SectionCard>
      )}
      {editing && <OfferDialog offer={editing} onClose={() => setEditing(null)}
        onSaved={(o) => { setEditing(null); setNotice(`${o.name} saved.`); list.reload(); setVersion((n) => n + 1); }} />}
    </div>
  );
}

function OfferDialog({ offer, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(offer.id);
  const { options, error } = useOptions(["catalog?active=true", "categories?active=true"]);
  const items = options?.["catalog?active=true"] || [];
  const categories = options?.["categories?active=true"] || [];
  const today = businessToday(biz.business.timezone);
  const [form, setForm] = useState(() => ({
    name: offer.name || "", kind: offer.kind || "item_percent", skuId: offer.sku_id ? String(offer.sku_id) : "", categoryId: offer.category_id ? String(offer.category_id) : "",
    value: offer.value ? String(Number(offer.value)) : "", buyQuantity: offer.buy_quantity ? String(Number(offer.buy_quantity)) : "2", getQuantity: offer.get_quantity ? String(Number(offer.get_quantity)) : "1",
    minBillAmount: Number(offer.min_bill_amount) ? String(Number(offer.min_bill_amount)) : "", maxDiscount: offer.max_discount ? String(Number(offer.max_discount)) : "",
    startsOn: offer.starts_on || today, endsOn: offer.ends_on || "", days: offer.days_of_week || [], startsTime: offer.starts_time?.slice(0, 5) || "", endsTime: offer.ends_time?.slice(0, 5) || "",
    active: offer.active ?? true,
  }));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const kind = form.kind;
  const needsItem = ["item_percent", "item_amount", "buy_x_get_y"].includes(kind);
  const percent = PERCENT_KINDS.has(kind);
  const toggleDay = (day) => setForm((f) => ({ ...f, days: f.days.includes(day) ? f.days.filter((d) => d !== day) : [...f.days, day].sort() }));
  const priceTerms = biz.settings.tax_mode === "inclusive" ? "including GST" : "before GST";

  const submit = () => {
    const body = {
      name: form.name, kind, value: kind === "buy_x_get_y" ? form.value || "100" : form.value, startsOn: form.startsOn, endsOn: form.endsOn || null,
      minBillAmount: form.minBillAmount || 0, maxDiscount: form.maxDiscount || null, daysOfWeek: form.days.length ? form.days : null,
      startsTime: form.startsTime || null, endsTime: form.endsTime || null, active: form.active,
      ...(needsItem ? { skuId: form.skuId } : {}), ...(kind === "category_percent" ? { categoryId: form.categoryId } : {}),
      ...(kind === "buy_x_get_y" ? { buyQuantity: form.buyQuantity, getQuantity: form.getQuantity } : {}),
    };
    return editing ? businessWrite(biz.id, `offers/${offer.id}`, body, "patch") : businessWrite(biz.id, "offers", body);
  };

  return (
    <FormDialog title={editing ? `Edit ${offer.name}` : "New offer"} icon="gift" width={760} onClose={onClose} onSaved={onSaved} onSubmit={submit} disabled={!options}
      description={`Amounts are in the same terms as your prices (${priceTerms}). Bills already made keep what they were given.`}>
      <FormError message={error} />
      <div className="field-wide">
        <span className="small muted">Type of offer</span>
        <div className="rt-kinds" role="radiogroup" aria-label="Type of offer">
          {Object.entries(OFFER_KINDS).map(([key, label]) => (
            <button key={key} type="button" role="radio" aria-checked={kind === key} className={`rt-kind ${kind === key ? "is-active" : ""}`} onClick={() => setForm((f) => ({ ...f, kind: key }))}>
              <strong>{label}</strong>
              <small>{{ item_percent: "e.g. 10% off ghee", item_amount: "e.g. ₹5 off each soap", category_percent: "e.g. 15% off all stationery", bill_percent: "e.g. 5% off the whole bill", bill_amount: "e.g. ₹50 off over ₹1,000", buy_x_get_y: "e.g. buy 2 get 1 free" }[key]}</small>
            </button>
          ))}
        </div>
      </div>
      <Field label="Offer name" hint="Printed on the receipt next to what it saved." wide><input required maxLength={120} value={form.name} onChange={set("name")} placeholder="e.g. Diwali 10% off dry fruits" /></Field>
      {needsItem && (
        <Field label="Item" wide>
          <select required value={form.skuId} onChange={set("skuId")}>
            <option value="">Choose…</option>
            {items.map((s) => <option key={s.id} value={s.id}>{s.label} · {s.code}</option>)}
          </select>
        </Field>
      )}
      {kind === "category_percent" && (
        <Field label="Category" hint="Its sub-categories are included." wide>
          <select required value={form.categoryId} onChange={set("categoryId")}>
            <option value="">Choose…</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.path}</option>)}
          </select>
        </Field>
      )}
      {kind === "buy_x_get_y" && (
        <>
          <Field label="Customer buys"><input required type="number" min="0.001" step="any" value={form.buyQuantity} onChange={set("buyQuantity")} /></Field>
          <Field label="And gets"><input required type="number" min="0.001" step="any" value={form.getQuantity} onChange={set("getQuantity")} /></Field>
          <Field label="At % off" hint="100 = free; 50 = half price."><input type="number" min="0.01" max="100" step="0.01" value={form.value || "100"} onChange={set("value")} /></Field>
        </>
      )}
      {kind !== "buy_x_get_y" && (
        <Field label={percent ? "Discount %" : kind === "item_amount" ? "₹ off each unit" : "₹ off the bill"}>
          <input required type="number" min="0.01" max={percent ? "100" : undefined} step="0.01" value={form.value} onChange={set("value")} />
        </Field>
      )}
      <Field label="Only on bills of at least (optional)" hint="Counted before any discount."><input type="number" min="0" step="0.01" value={form.minBillAmount} onChange={set("minBillAmount")} /></Field>
      <Field label="Most per bill (optional)" hint="A cap on what one bill can get."><input type="number" min="0.01" step="0.01" value={form.maxDiscount} onChange={set("maxDiscount")} /></Field>
      <Field label="Starts on"><input required type="date" value={form.startsOn} onChange={set("startsOn")} /></Field>
      <Field label="Ends on (optional)"><input type="date" min={form.startsOn} value={form.endsOn} onChange={set("endsOn")} /></Field>
      <div className="field-wide">
        <span className="small muted">Days (none ticked = every day)</span>
        <div className="rt-days">
          {WEEKDAYS.map(([day, label]) => <label key={day}><input type="checkbox" checked={form.days.includes(day)} onChange={() => toggleDay(day)} /> {label}</label>)}
        </div>
      </div>
      <Field label="From time (optional)" hint="Happy hours, e.g. 16:00."><input type="time" value={form.startsTime} onChange={set("startsTime")} /></Field>
      <Field label="Until time (optional)" hint="Can run past midnight."><input type="time" value={form.endsTime} onChange={set("endsTime")} /></Field>
      <label className="checkbox bz-check"><input type="checkbox" checked={form.active} onChange={set("active")} /> Switched on</label>
    </FormDialog>
  );
}
