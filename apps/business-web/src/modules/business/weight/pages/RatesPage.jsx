import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { businessPath } from "../../../../services/businessNav";
import { dateLong, dateTime, relative } from "@bmp/shared/format";
import { escapeHtml, printDocument } from "../../../../services/print";
import { toast } from "../../../../services/toast";
import { BusinessHeader, PeriodFilter } from "../../core/pages/ui";
import { businessToday, useDirtyGuard, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { Segmented } from "../../wholesale/pages/shared";
import { whatsappLink } from "../../retail/pages/retail";
import "../../salon/styles/salon.css";
import "../styles/weight.css";

// Today's rates: every item sold by weight on one screen,
// built for the phone. The rate the day opened with, today's rate, the change,
// the cost per kg of what is in stock and the margin. Change one, or all of a
// category by ₹ or %, save them together (each change is kept in the rate
// history), then share the list on WhatsApp or print it for the counter.
const TABS = [{ value: "today", label: "Today's rates" }, { value: "history", label: "Rate history" }];

export default function RatesPage() {
  const [tab, setTab] = useState("today");
  return (
    <div className="stack">
      {tab === "today" ? <Today tabs={<Segmented label="Show" value={tab} options={TABS} onChange={setTab} />} />
        : <History tabs={<Segmented label="Show" value={tab} options={TABS} onChange={setTab} />} />}
    </div>
  );
}

const pct = (from, to) => (Number(from) ? ((Number(to) - Number(from)) / Number(from)) * 100 : 0);

function Today({ tabs }) {
  const navigate = useNavigate();
  const biz = useOpenBusiness();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [draft, setDraft] = useState({});
  const [bulk, setBulk] = useState({ category: "", amount: "", mode: "rupees" });
  const [busy, setBusy] = useState(false);
  const reload = useCallback(() => setVersion((n) => n + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "weight/rates", {}, controller.signal)
      .then((r) => { setData(r); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);
  const rows = useMemo(() => data?.rows || [], [data]);
  const rateOf = (r) => (draft[r.id] !== undefined && draft[r.id] !== "" ? Number(draft[r.id]) : Number(r.price));
  const changed = rows.filter((r) => draft[r.id] !== undefined && draft[r.id] !== "" && Number(draft[r.id]) !== Number(r.price));
  useDirtyGuard(changed.length > 0);
  const categories = [...new Set(rows.map((r) => r.category).filter(Boolean))];
  const canEdit = biz.can("catalog.edit");
  const inclusive = data?.taxMode === "inclusive";

  const applyBulk = () => {
    const amount = Number(bulk.amount);
    if (!amount) return;
    setDraft((all) => {
      const next = { ...all };
      rows.filter((r) => !bulk.category || r.category === bulk.category).forEach((r) => {
        const base = rateOf(r);
        const value = bulk.mode === "percent" ? base * (1 + amount / 100) : base + amount;
        next[r.id] = String(Math.max(0, Math.round(value)));
      });
      return next;
    });
  };
  const save = async () => {
    setBusy(true);
    try {
      const result = await businessWrite(biz.id, "weight/rates", { rates: changed.map((r) => ({ skuId: r.id, price: Number(draft[r.id]).toFixed(2) })) }, "put");
      toast.success(`${result.changed.length} rate${result.changed.length === 1 ? "" : "s"} changed. Quick bill uses them now.`, {
        action: { label: "Share the list", onClick: () => share(rows.map((r) => ({ ...r, price: draft[r.id] ?? r.price }))) },
      });
      setDraft({});
      reload();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const listText = (list) => [
    `*${biz.business.name}* — today's rates (${dateLong(businessToday(biz.business.timezone))})`,
    ...list.filter((r) => Number(r.on_hand) > 0 || Number(r.price) > 0).map((r) => `${r.label}: ${biz.exact(r.price)}/${r.unit}`),
    "Order on WhatsApp for pickup.",
  ].join("\n");
  const share = (list = rows) => window.open(whatsappLink("", listText(list)), "_blank", "noopener");
  const print = () => {
    const body = `<div class="rates"><h1>${escapeHtml(biz.business.name)}</h1><p>Today's rates · ${escapeHtml(dateLong(businessToday(biz.business.timezone)))}</p>
      <table><tbody>${rows.map((r) => `<tr><th>${escapeHtml(r.label)}</th><td>${escapeHtml(biz.exact(rateOf(r)))} / ${escapeHtml(r.unit)}</td></tr>`).join("")}</tbody></table></div>`;
    printDocument({ title: "Today's rates", body, styles: `@page { size: A5; } .rates { font: 16px/1.4 system-ui, sans-serif; color: #000; }
      .rates h1 { font-size: 22px; margin: 0; } .rates table { width: 100%; border-collapse: collapse; margin-top: 10px; }
      .rates th, .rates td { padding: 8px 4px; border-bottom: 1px solid #999; text-align: left; font-size: 18px; } .rates td { text-align: right; font-weight: 700; }` });
  };
  const columns = [
    { key: "label", header: "Item", value: (r) => r.label, mobile: "title", minWidth: 180,
      render: (r) => <span>{r.label}<small className="muted" style={{ display: "block" }}>{r.category || "—"}{Number(r.on_hand) ? ` · ${Number(r.on_hand)} ${r.unit} in stock` : " · none in stock"}</small></span> },
    { key: "opening_price", header: "Opened at", type: "money", exact: true, value: (r) => Number(r.opening_price), render: (r) => `${biz.exact(r.opening_price)}` },
    { key: "price", header: "Rate / kg", type: "number", width: 140, value: (r) => rateOf(r), mobile: "show",
      render: (r, ctx) => (canEdit ? (
        <input aria-label={ctx.label} type="number" min="0" step="1" inputMode="decimal" value={draft[r.id] ?? String(Number(r.price))}
          className={draft[r.id] !== undefined && Number(draft[r.id]) !== Number(r.price) ? "is-changed" : ""}
          onChange={(e) => setDraft((all) => ({ ...all, [r.id]: e.target.value }))} />
      ) : biz.exact(r.price)) },
    { key: "change", header: "Change", type: "number", value: (r) => rateOf(r) - Number(r.opening_price),
      render: (r) => {
        const diff = rateOf(r) - Number(r.opening_price);
        if (!diff) return <span className="muted">—</span>;
        return <span className={diff > 0 ? "sw-yield-good" : "sw-yield-low"}>{diff > 0 ? "+" : "−"}{biz.exact(Math.abs(diff))} ({Math.abs(pct(r.opening_price, rateOf(r))).toFixed(1)}%)</span>;
      } },
    { key: "cost", header: "Cost / kg", type: "money", exact: true, value: (r) => (r.cost === null ? null : Number(r.cost)) },
    { key: "margin", header: "Margin", type: "percent", value: (r) => (r.cost === null || !rateOf(r) ? null : (100 * (rateOf(r) - Number(r.cost))) / rateOf(r)), mobile: "show" },
    data?.customerRates && { key: "customer_rates", header: "Customer rates", type: "number", value: (r) => r.customer_rates, render: (r) => (r.customer_rates ? `${r.customer_rates}` : "—") },
    { key: "changed_at", header: "Last changed", type: "datetime", value: (r) => r.changed_at, render: (r) => (r.changed_at ? relative(r.changed_at) : "—"), defaultHidden: true },
  ].filter(Boolean);
  return (
    <>
      <BusinessHeader icon="tag" title="Today's rates"
        description={`Set the day's rate for everything sold by weight in one go${inclusive ? " (rates include GST)" : ""}. Quick bill uses the new rate at once; every change is kept.`}
        primary={canEdit && <button type="button" className="button" onClick={save} disabled={!changed.length || busy}><Icon name="check" size={16} /> {busy ? "Saving…" : changed.length ? `Save ${changed.length} rate${changed.length === 1 ? "" : "s"}` : "Save rates"}</button>}
        secondary={<button type="button" className="button button-secondary" onClick={() => share()} disabled={!rows.length}><Icon name="message" size={16} /> Share on WhatsApp</button>}
        more={[
          { label: "Print the rate list (A5)", icon: "print", onClick: print },
          ...(biz.has("wholesale") && biz.can("wholesale.view") ? [{ label: "Customer rates (hotels)", icon: "users", onClick: () => navigate(businessPath(biz.id, "pricing")) }] : []),
        ]} />
      {tabs}
      <ErrorMessage message={error} />
      {canEdit && (
        <div className="sw-summary" role="group" aria-label="Change many rates">
          <span>Change</span>
          <select aria-label="Which items" value={bulk.category} onChange={(e) => setBulk((b) => ({ ...b, category: e.target.value }))}>
            <option value="">every item</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <span>by</span>
          <input aria-label="By how much" type="number" step="1" style={{ width: "6rem" }} placeholder="+10 or −5" value={bulk.amount} onChange={(e) => setBulk((b) => ({ ...b, amount: e.target.value }))} />
          <select aria-label="Rupees or percent" value={bulk.mode} onChange={(e) => setBulk((b) => ({ ...b, mode: e.target.value }))}>
            <option value="rupees">{biz.symbol} per kg</option><option value="percent">%</option>
          </select>
          <button type="button" className="button button-secondary button-sm" onClick={applyBulk} disabled={!Number(bulk.amount)}>Apply</button>
          {changed.length > 0 && <button type="button" className="link-button" onClick={() => setDraft({})}>Undo changes</button>}
        </div>
      )}
      {!data?.customerRates && biz.can("settings.edit") && (
        <p className="sw-note">A hotel or caterer on its own rate per kg? Switch on <strong>Wholesale price lists</strong> in <Link to={businessPath(biz.id, "settings")}>Settings › Business tools</Link>, then set Customer rates.</p>
      )}
      <SectionCard flush icon="tag" title={`${rows.length} items sold by weight`}>
        <DataGrid id="weight-rates" variant="editor" caption="Today's rates" columns={columns} rows={rows} rowKey={(r) => r.id} loading={!data && !error} currency={biz.symbol}
          rowNoun={["item", "items"]} pageSize={false}
          empty="No items sold by weight" emptyHint="Add items in kg or g under Products." emptyIcon="scale" />
      </SectionCard>
    </>
  );
}

function History({ tabs }) {
  const biz = useOpenBusiness();
  const list = useServerList("weight/rate-history", { gridId: "weight-rate-history", period: true });
  const columns = useMemo(() => [
    { key: "changed_at", header: "When", type: "datetime", value: (h) => h.changed_at, mobile: "subtitle", render: (h) => dateTime(h.changed_at) },
    { key: "label", header: "Item", value: (h) => h.label, mobile: "title", pin: true },
    { key: "old_price", header: "Was", type: "money", exact: true, value: (h) => Number(h.old_price) },
    { key: "new_price", header: "Now", type: "money", exact: true, value: (h) => Number(h.new_price), mobile: "show" },
    { key: "change", header: "Change", type: "money", exact: true, value: (h) => Number(h.new_price) - Number(h.old_price), mobile: "show" },
    { key: "changed_by_name", header: "By", value: (h) => h.changed_by_name },
  ], []);
  return (
    <>
      <BusinessHeader icon="history" title="Rate history" description="Every change of a rate per kg: when, from what, to what, and who." />
      {tabs}
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="history" title="Rate changes">
        <DataGrid {...list.gridProps} caption="Rate history" columns={columns} currency={biz.symbol} rowNoun={["change", "changes"]}
          exportName={biz.can("catalog.export") ? `${biz.business.code}-rate-history` : undefined}
          toolbar={<PeriodFilter list={list} />} empty="No rate changes in these dates" emptyIcon="history" />
      </SectionCard>
    </>
  );
}
