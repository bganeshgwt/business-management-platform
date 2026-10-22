import { useEffect, useState } from "react";
import PageHeader from "../../../../components/PageHeader";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import StatusBadge from "../../../../components/StatusBadge";
import { EmptyState, ErrorMessage, Loading } from "../../../../components/Feedback";
import { getErrorMessage } from "../../../../services/api";
import { moneyExact } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import useAuth from "../../../../hooks/useAuth";
import { createBrand, getBrandReport, listBrands, updateBrand } from "../services/brand.service";
import "../styles/brands.css";

// Brands: one kitchen selling under several names. Each brand has its own
// menu categories (Menu › Categories; a category with no brand is every
// brand's), the POS takes an order under a brand, and the brand prints on
// the KOT and the bill. The report shows each brand's sales by channel and
// what the aggregators keep.
const TZ = "Asia/Kolkata";
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const COLORS = ["#b45309", "#1f8a70", "#7c3aed", "#0369a1", "#be123c", "#4d7c0f"];

export default function BrandsPage() {
  const { hasPermission } = useAuth();
  const [tab, setTab] = useState("brands");
  return (
    <div className="stack">
      <PageHeader icon="store" title="Brands" description="One kitchen, several names: each brand has its own menu, its own listing on Swiggy and Zomato, and its own sales." />
      <div className="segmented" role="tablist" aria-label="Brands views">
        <button type="button" role="tab" aria-selected={tab === "brands"} className={`segment ${tab === "brands" ? "is-active" : ""}`} onClick={() => setTab("brands")}>Brands</button>
        {hasPermission("reports.view") && <button type="button" role="tab" aria-selected={tab === "report"} className={`segment ${tab === "report" ? "is-active" : ""}`} onClick={() => setTab("report")}>Sales by brand</button>}
      </div>
      {tab === "report" ? <BrandReport /> : <BrandList />}
    </div>
  );
}

function BrandList() {
  const { hasPermission } = useAuth();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    listBrands().then((data) => { if (live) { setRows(data); setError(""); } }).catch((err) => { if (live) setError(getErrorMessage(err)); });
    return () => { live = false; };
  }, [version]);
  const canManage = hasPermission("menu.manage");
  return (
    <>
      <ErrorMessage message={error} />
      {canManage && <div className="br-actions"><button type="button" className="button" onClick={() => setEditing({})}><Icon name="plus" size={16} /> Add a brand</button></div>}
      {!rows && !error ? <Loading /> : rows?.length === 0 ? (
        <EmptyState icon="store" title="No brands yet" description="Add each name the kitchen sells under (as listed on Swiggy and Zomato), then give each its menu categories." />
      ) : rows && (
        <DataGrid id="menu-brands" caption="Brands" rows={rows} rowKey={(b) => b.id} columns={[
          { key: "name", header: "Brand", value: (b) => b.name, mobile: "title", render: (b) => (
            <span className="br-name"><span className="br-dot" style={{ background: b.color || "var(--primary)" }} aria-hidden="true" />
              <span className="br-two"><strong>{b.name}</strong>{b.tagline && <small className="muted">{b.tagline}</small>}</span></span>) },
          { key: "menu", header: "Menu", value: (b) => b.productCount, mobile: "show", render: (b) => `${b.categoryCount} categor${b.categoryCount === 1 ? "y" : "ies"} · ${b.productCount} items` },
          { key: "status", header: "Status", value: (b) => b.status, render: (b) => <StatusBadge tone={b.status === "active" ? "success" : "neutral"} label={b.status === "active" ? "Selling" : "Paused"} /> },
          canManage && { key: "actions", header: "", label: "Actions", type: "actions", width: 120, render: (b) => <button type="button" className="button button-secondary button-sm" onClick={() => setEditing(b)}>Edit</button> },
        ].filter(Boolean)} />
      )}
      <p className="muted br-note">Give each category its brand in Menu › Categories; a category with no brand (drinks, desserts) is on every brand's menu. The POS asks which brand an order is for.</p>
      {editing && <BrandDialog brand={editing} onClose={() => setEditing(null)} onSaved={(message) => { setEditing(null); toast.success(message); setVersion((n) => n + 1); }} />}
    </>
  );
}

function BrandDialog({ brand, onClose, onSaved }) {
  const [form, setForm] = useState({ name: brand.name || "", tagline: brand.tagline || "", color: brand.color || COLORS[0], status: brand.status || "active", sortOrder: brand.sortOrder ?? 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  async function save(event) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const payload = { ...form, sortOrder: Number(form.sortOrder || 0) };
      const result = brand.id ? await updateBrand(brand.id, payload) : await createBrand(payload);
      onSaved(result.message);
    } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
  }
  return (
    <Modal title={brand.id ? `Edit ${brand.name}` : "Add a brand"} icon="store" width={520} onClose={onClose} dismissible={!busy}>
      <form className="stack" onSubmit={save}>
        <ErrorMessage message={error} />
        <label className="field"><span>Brand name</span><input required maxLength={80} value={form.name} onChange={set("name")} autoFocus placeholder="e.g. Wrap Republic" /></label>
        <label className="field"><span>Tagline (optional)</span><input maxLength={150} value={form.tagline} onChange={set("tagline")} placeholder="e.g. Kathi rolls and wraps" /></label>
        <div className="field"><span>Colour on the POS</span>
          <div className="br-colors" role="radiogroup" aria-label="Colour">
            {COLORS.map((c) => <button key={c} type="button" role="radio" aria-checked={form.color === c} aria-label={c} className={`br-swatch ${form.color === c ? "is-on" : ""}`} style={{ background: c }} onClick={() => setForm((f) => ({ ...f, color: c }))} />)}
          </div>
        </div>
        <label className="field"><span>Status</span><select value={form.status} onChange={set("status")}><option value="active">Selling</option><option value="inactive">Paused (no new orders)</option></select></label>
        <div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>Cancel</button><button type="submit" className="button" disabled={busy}>{busy ? "Saving…" : "Save"}</button></div>
      </form>
    </Modal>
  );
}

function BrandReport() {
  const [range, setRange] = useState(() => ({ from: `${today().slice(0, 8)}01`, to: today() }));
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    getBrandReport(range.from, range.to).then((d) => { if (live) { setData(d); setError(""); } }).catch((err) => { if (live) setError(getErrorMessage(err)); });
    return () => { live = false; };
  }, [range]);
  return (
    <div className="stack">
      <div className="br-range">
        <label className="field"><span>From</span><input type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))} /></label>
        <label className="field"><span>To</span><input type="date" value={range.to} min={range.from} onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))} /></label>
      </div>
      <ErrorMessage message={error} />
      {!data && !error ? <Loading /> : data && (
        <>
          <div className="br-tiles">
            <div className="br-tile"><span>Bills</span><strong>{data.totals.bills.toLocaleString("en-IN")}</strong></div>
            <div className="br-tile"><span>Sales</span><strong>{moneyExact(data.totals.sales)}</strong></div>
            <div className="br-tile"><span>Aggregator commission</span><strong>{moneyExact(data.totals.commission)}</strong></div>
            <div className="br-tile"><span>Net after commission</span><strong>{moneyExact(data.totals.net)}</strong></div>
          </div>
          {data.brands.length === 0 ? <EmptyState icon="chart" title="No sales in this period" /> : (
            <div className="br-cards">
              {data.brands.map((b) => (
                <section key={b.brandId || 0} className="br-card" aria-label={b.name}>
                  <header><span className="br-dot" style={{ background: b.color || "var(--muted)" }} aria-hidden="true" /><strong>{b.name}</strong>
                    <span className="muted">{b.bills} bills · avg {moneyExact(b.averageBill)}</span></header>
                  <div className="br-figures"><span>Sales <strong>{moneyExact(b.sales)}</strong></span><span>Commission <strong>{moneyExact(b.commission)}</strong></span><span>Net <strong>{moneyExact(b.net)}</strong></span></div>
                  <table className="br-table">
                    <thead><tr><th>Channel</th><th className="r">Bills</th><th className="r">Sales</th><th className="r">Commission</th><th className="r">Net</th></tr></thead>
                    <tbody>{b.channels.map((c) => <tr key={c.channel}><td>{c.channel}</td><td className="r">{c.bills}</td><td className="r">{moneyExact(c.sales)}</td><td className="r">{moneyExact(c.commission)}</td><td className="r">{moneyExact(c.net)}</td></tr>)}</tbody>
                  </table>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
